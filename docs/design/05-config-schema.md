# 05. 機種定義スキーマと WebUI

## 機種定義 JSON

機種は単一 JSON で完結する。「WebUI で設定 → 保存 → 遊べる」の実体は、この JSON の編集・保存・ロードである。スキーマは 5 軸モデル（[01](01-machine-model.md)）に 1:1 対応する。以下のサンプルは参照整合の取れた完全な例（ART 機プリセット相当）。

```jsonc
{
  "meta": { "name": "花火娘", "author": "...", "schemaVersion": 1 },

  // 図柄（オリジナルアセット前提。表示はプレゼン層が id から解決）
  "symbols": ["seven_red", "bar", "bell", "replay", "cherry", "blank"],

  // リール（手組み or 配列メーカー生成。04 参照）
  "reels": {
    "frames": 20,
    "strips": [ ["seven_red","bell","blank","..."], ["..."], ["..."] ],
    "layoutConstraints": { "seed": 42 }   // 配列メーカーへの入力（任意）
  },

  "lines": { "preset": "cross5" },   // or 明示座標リスト
  "bet": { "coins": 3, "replayRebet": true },

  // ===== 軸 2: 打ち分けグループと役 =====
  // navGroup.type: "order"（押し順） | "position"（狙い位置）
  "navGroups": [
    { "id": "bell6",     "type": "order" },
    { "id": "rt_replay", "type": "order" }
  ],

  // role.kind: "replay" | "small" | ボーナス役は bonuses 側で定義
  // pullIn: "guaranteed" | { "missable": { "targetRate": 0.5 } }
  // nav.onMiss.type: "lose"（取りこぼし） | "reduced"（参照役の入賞）
  //   ※ kind: "replay" の役の onMiss は "reduced"（参照先もリプレイ）のみ許可（03 優先度 2）
  "roles": [
    { "id": "replay_keep", "kind": "replay", "pattern": ["replay","replay","replay"],
      "pullIn": "guaranteed",
      "nav": { "group": "rt_replay", "correct": { "order": "LCR" },
               "onMiss": { "type": "reduced", "roleRef": "replay_fall" } } },
    { "id": "replay_fall", "kind": "replay", "pattern": ["replay","replay","blank"],
      "pullIn": "guaranteed" },

    { "id": "bell_LCR", "kind": "small", "payout": 8, "pattern": ["bell","bell","bell"],
      "pullIn": "guaranteed",
      "nav": { "group": "bell6", "correct": { "order": "LCR" },
               "onMiss": { "type": "reduced", "roleRef": "bell_weak" } } },
    // ... bell_LRC / bell_CLR / bell_CRL / bell_RLC / bell_RCL（6 択分）
    { "id": "bell_weak", "kind": "small", "payout": 1, "pattern": ["bell","bell","blank"],
      "pullIn": "guaranteed" },

    { "id": "cherry", "kind": "small", "payout": 2, "pattern": ["cherry","any","any"],
      "pullIn": { "missable": { "targetRate": 0.5 } } },

    // 狙い位置型打ち分けの例（技術介入プリセットで使用）: correct が position 型
    { "id": "jac_in", "kind": "small", "payout": 0, "pattern": ["replay","replay","bell"],
      "pullIn": { "missable": { "targetRate": 0.6 } },
      "nav": { "group": null,
               "correct": { "position": { "reel": 2, "range": [10, 14] } },
               "onMiss": { "type": "lose" } } }
  ],

  // ===== 軸 1: 役物 =====
  // kind: "bb" | "rb" | "sb"
  "bonuses": [
    { "id": "bb_red", "kind": "bb", "pattern": ["seven_red","seven_red","seven_red"],
      "end": { "games": 30, "jacCount": 3 },       // games / jacCount / maxPayout の組み合わせ
      "tableRef": "in_bb",
      "jac": { "triggerRole": "jac_in", "tableRef": "in_jac",
               "end": { "games": 12, "wins": 8 } } },
    { "id": "rb", "kind": "rb", "pattern": ["bar","bar","bar"],
      "end": { "games": 12, "wins": 8 }, "tableRef": "in_rb" }
    // SB の例: { "id": "sb", "kind": "sb", "pattern": [...], "tableRef": "in_sb" }（1 ゲームで終了）
  ],

  // ===== 軸 1: 集中（C タイプ）。不要なら省略 =====
  "concentration": null,
  // 例: { "id": "focus",
  //       "entry": [ { "on": "roleHit", "of": "focus_in", "prob": 1.0 } ],
  //       "punk": { "role": "punk_replay" },     // この役の入賞で解除
  //       "tableRef": "in_focus" }

  // ===== 軸 3: RT =====
  // entry/exit の on: "bonusEnd" | "roleHit" | "games" | "bonusFlag"
  // replayWeights: 基底テーブルのリプレイ系エントリの重み差し替え（02 のオーバーレイ）
  "rtStates": [
    { "id": "rt_high",
      "replayWeights": { "replay_keep": 26000, "replay_fall": 3000 },
      "entry": [ { "on": "bonusEnd", "of": "bb_red" } ],
      "exit":  [ { "on": "roleHit", "of": "replay_fall" }, { "on": "games", "n": 100 } ] }
  ],

  // ===== 軸 4: 持ち越し・放出（常設。通常機は queueLimit: 1・lid なし） =====
  // lid.engageOn: "bonusFlag" | "bonusEnd" / lid.release.type: "gameCountTable" | "lottery" | "roleHit"
  "carryover": {
    "queueLimit": 1,
    "lid": null
    // ストック機の例:
    // "queueLimit": 50,
    // "lid": { "engageOn": ["bonusFlag", "bonusEnd"],
    //          "release": { "type": "gameCountTable",
    //                       "table": [ { "games": 0, "weight": 300 },
    //                                  { "games": 128, "weight": 3000 } ] } }
  },

  // ===== 抽選（02。フラグ = 役 ID の集合） =====
  "lottery": {
    "settings": 6,
    "base": [   // 基底テーブル = 設定 1。設定・RT・内部中はオーバーレイで解決（02）
      { "roles": ["replay_keep"],     "weight": 8978 },
      { "roles": ["bell_LCR"],        "weight": 1092 },
      // ... bell 残り 5 択
      { "roles": ["cherry"],          "weight": 1057 },
      { "roles": ["cherry","bb_red"], "weight": 66 },
      { "roles": ["bb_red"],          "weight": 200 },
      { "roles": ["rb"],              "weight": 273 }
    ],
    "settingOverrides": {   // 設定 2〜6 は差分（roles 集合一致で重み上書き）
      "2": [ { "roles": ["bb_red"], "weight": 216 } ],
      // ...
      "6": [ { "roles": ["bb_red"], "weight": 300 } ]
    },
    "tables": {   // 役物・集中の tableRef から参照される丸ごとテーブル（設定別）
      "in_bb":  { "1": [ { "roles": ["bell_LCR"], "weight": 30000 }, { "roles": ["jac_in"], "weight": 20000 } ] },
      "in_jac": { "1": [ { "roles": ["bell_LCR"], "weight": 60000 } ] },
      "in_rb":  { "1": [ { "roles": ["bell_LCR"], "weight": 60000 } ] }
    }
  },

  // ===== リール制御オプション（03） =====
  "control": {
    "priority": "role-first",          // or bonus-first / payout-first / count-first
    "defaultSlip": "minimum",
    "patternTable": []                  // 任意: リーチ目等の出目デザイン
  },

  // ===== 軸 5: ナビ（サブ） =====
  // triggers.on: "roleHit" | "gamesCeiling" | "duringBonus"
  // management.type: "games" | "set" | "stock" | "payoutDiff"
  "nav": {
    "enabled": true,
    "at": {
      "triggers": [ { "on": "roleHit", "of": "cherry", "prob": 0.25 },
                    { "on": "duringBonus", "of": "bb_red", "prob": 0.5 },
                    { "on": "gamesCeiling", "n": 999 } ],
      "management": { "type": "set", "gamesPerSet": 50, "continueProb": 0.80 },
      "addOn": [ { "on": "roleHit", "of": "cherry", "addGames": 20 } ],
      "navTargets": ["bell6", "rt_replay"]
    }
  }
}
```

### enum 一覧（フォーム設計の基礎）

| フィールド | 許容値 |
|---|---|
| `roles[].kind` | `replay` / `small` |
| `roles[].pullIn` | `guaranteed` / `{ missable: { targetRate } }` |
| `nav.correct` | 設計上は `{ order }` / `{ position: { reel, range } }` のユニオン。**MVP 実装は `correctFirst`（第 1 停止リール番号・3 択）のみ** |
| `nav.onMiss.type` | `lose` / `reduced`（replay 役は `reduced` のみ） |
| `bonuses[].kind` | `bb` / `rb` / `sb` |
| `bonuses[].end` | `games` / `jacCount` / `wins` / `maxPayout` の組み合わせ |
| `rtStates[].entry/exit[].on` | `bonusEnd` / `roleHit` / `games` / `bonusFlag` |
| `carryover.lid.engageOn[]` | `bonusFlag`（空→非空遷移時） / `bonusEnd`（掛け直し） |
| `carryover.lid.release.type` | `gameCountTable` / `lottery`（`on: any / pureMiss`） / `roleHit` |
| `carryover.lid.modes` | `{ initial, states: [{ id, release, onBonusEnd }] }`（`release` と排他。モード = 解除テーブルの選択状態） |
| `nav.at.triggers[].on` | `roleHit` / `gamesCeiling` / `duringBonus` |
| `nav.at.management.type` | `games` / `set` / `stock` / `payoutDiff` |
| `control.priority` | `role-first` / `bonus-first` / `payout-first` / `count-first` |

正式な JSON Schema ファイル（`schema/machine.schema.json`）を実装時に併置し、この表と同期させる。

## クレジットとベット

- プレイマネーのみ。**クレジットは無制限**（実機の 50 枚上限・精算は再現しない。差枚グラフで増減を可視化する）
- ベットは `bet.coins` 固定（MVP）。リプレイ入賞時は自動再ベット

## バリデーション（保存時に実行）

WebUI の保存ボタンは単なる書き出しではなく、**検証パイプライン**を通す。**このパイプラインを通過した機種定義だけがプレイヤー画面にロードできる**（[03](03-reel-control.md) 縮退規則）。

1. **スキーマ検証**: 型・enum・参照整合（`tableRef`・`roleRef`・`nav.group`・`navTargets`・抽選エントリの役 ID がすべて定義済みか）
2. **意味検証（警告）**: ナビ有効なのに navGroup が無い / 集中があるのに突入契機が無い / **JAC ハズシ構成なのに BB が枚数管理のみ**（ハズシが無意味になる: [01](01-machine-model.md) 軸 1）/ replay 役の `onMiss` が `lose`（これはエラー）など
3. **配列検証**: 総当たりオラクル（[03](03-reel-control.md)/[04](04-reel-layout.md)）— 蹴飛ばし可能性・リプレイ完全引き込み・PB=1 保証・引き込み率実測
4. **スペック実測**: モンテカルロで設定別のボーナス確率・機械割（完全打ち / 適当打ち）を算出し、**仕様表として表示**

4 の出力（自作機種のスペック表が自動生成される）がこのプロダクトの中核体験。

## スキーマバージョン

- `meta.schemaVersion` が実装と不一致の JSON は**読み込み拒否 + エラー表示**（MVP。マイグレーションは将来）
- セーブデータ側にも `saveVersion` を持たせ、同じ規則を適用する

## WebUI 構成

- **機種エディタ**: 5 軸に対応したフォーム + プリセット選択（[01](01-machine-model.md) のプリセット表）。プリセットは初期値を埋めるだけで、以後は全項目編集可。**MVP 実装は機種定義 JSON の直接編集**（プリセットを開く → JSON を編集 → 保存で検証パイプライン → localStorage にカスタム機種として永続化 → 即プレイ）。フォーム化は将来
- **プレイヤー画面**: リール描画（回転は一定速・押下時刻→コマ番号の量子化は [03](03-reel-control.md) に従う）、レバー/ストップ操作（キーボード対応）、クレジット表示、ナビ表示、データカウンタ（ゲーム数・ボーナス履歴・差枚グラフ）、機種ごとの遊び方ガイド、教材モード（成立フラグ・内部状態の可視化、次ゲームの抽選を上書きする強制フラグ）
- **配列ビューア**: 縦帯表示 + 役ごとの引き込み率注記（[04](04-reel-layout.md)）
- 保存先: MVP はブラウザ localStorage + JSON エクスポート/インポート。共有機能（URL 化等）は将来

## セーブデータ

遊技状態は機種定義とは別オブジェクト:

- クレジット（差枚）、エンジン状態（基本状態・修飾状態・キュー・蓋）、**RNG 状態（メイン・ナビの 2 系統とも）**、ナビ層状態（AT 状態・残ゲーム数等）、`saveVersion`
- RNG 状態を含むため、リロードしても同一の未来が再現される
