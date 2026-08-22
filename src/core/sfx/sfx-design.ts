/**
 * レシピベースの効果音デザイナー（データ層 + 生成器）。
 * 効果音は作曲と理論体系が違う:
 * - ジングル系   = 終止形（V→I の解決）と分散和音上行
 * - 操作音系     = 音程の意味論（上行 = 肯定 / 下行 = 否定、4度・5度 = 確認、
 *                  協和音程のハモリ = 柔らかい応答）
 * - 煽り系       = わざと解決させない（半音上昇・トレモロ）
 * - 警告・告知系 = トライトーン・ピッチベンド、耳が最も敏感な 2〜4kHz 帯
 * - 物理音の借用 = サイレン（緊急）、コイン連打（報酬密度）、低域下行（停止の重さ）
 *
 * レシピ = その理論のテンプレート。パラメータ（基準音・速さ・音色）だけを動かす。
 * 生成は純関数なので、SfxDesign を保存すれば同じ音が完全に再現できる。
 * ゲームの既定効果音（ベット・レバー・停止…）もすべてこのレシピのプリセット
 * （sfx-library.ts の PRESET_SFX）で定義され、OPLL でレンダリングされる。
 *
 * 一貫性の規則（プリセットの調統一）:
 * - 操作・停止・報酬系の音程は C メジャーのコードトーン/スケール音から取る
 *   （BGM のどこに重なっても濁らないため。プリセット BGM もキー C）
 * - 例外は意図的に「外す」記号: 警告（トライトーン）、サイレン（物理音の借用）
 * - 高頻度で鳴る音（停止・ベット）ほど短く・軽く・音程感を薄くする
 */

export interface SfxDesign {
  recipeId: string;
  /** 基準音（MIDI）。レシピはこの音を主音として展開する */
  rootMidi: number;
  /** 速さ倍率（1 = 標準。大きいほど速い = 短い） */
  speed: number;
  /** OPLL 内蔵音色 1〜15（opll-core.ts の OPLL_VOICES） */
  voice: number;
  /**
   * 出力レベル 0..1（省略時 1）。レンダリングは全効果音をピーク正規化するため、
   * 「この音だけ控えめに」はゲイン調整ではなくこの係数で行う
   */
  level?: number;
}

export interface ToneEvent {
  kind: 'tone';
  /** 秒（標準速度時） */
  t: number;
  dur: number;
  /** 小数も可（デチューン用） */
  midi: number;
  /** 指定するとピッチベンド（midi → midiTo へ滑らかに移動） */
  midiTo?: number;
  gain: number;
}

export interface NoiseEvent {
  kind: 'noise';
  t: number;
  dur: number;
  /** 明るさの目安 Hz（OPLL 変換時はハイハット/スネアの選択に使う） */
  freq: number;
  gain: number;
}

export type SfxEvent = ToneEvent | NoiseEvent;

export interface SfxRecipe {
  id: string;
  name: string;
  /** 背景理論の一行説明（UI に表示） */
  theory: string;
  /** 推奨基準音（MIDI）と推奨音色 */
  defaultRoot: number;
  defaultVoice: number;
  build(root: number): SfxEvent[];
}

const tone = (t: number, dur: number, midi: number, gain = 0.5, midiTo?: number): ToneEvent => ({
  kind: 'tone',
  t,
  dur,
  midi,
  gain,
  ...(midiTo !== undefined ? { midiTo } : {}),
});

/** 操作ビープ 1 打（長 6 度下のハモリ = 短くても柔らかい協和。大花火風の 2 音） */
const beepAt = (t: number, root: number): SfxEvent[] => [
  tone(t, 0.06, root, 0.5),
  tone(t, 0.06, root - 9, 0.4),
];

export const SFX_RECIPES: SfxRecipe[] = [
  {
    id: 'kakutei',
    name: '確定・当選',
    theory: 'V→I の完全終止 + 分散和音上行。最後の音を最高音にして長く伸ばす',
    defaultRoot: 72, // C5
    defaultVoice: 7, // トランペット
    build: (root) => [
      tone(0, 0.07, root - 5), // ソ（ドミナント）
      tone(0.08, 0.07, root), // ド
      tone(0.16, 0.07, root + 4), // ミ
      tone(0.24, 0.07, root + 7), // ソ
      tone(0.32, 0.5, root + 12, 0.55), // 高いドー（トニックで着地）
    ],
  },
  {
    id: 'aori',
    name: '煽り・期待',
    theory: '半音上昇のトレモロ。トニックに解決させないことで緊張を維持する',
    defaultRoot: 76, // E5
    defaultVoice: 10, // シンセ
    build: (root) => {
      const events: SfxEvent[] = [];
      for (let g = 0; g < 3; g++) {
        for (let i = 0; i < 4; i++) {
          events.push(tone(g * 0.24 + i * 0.05, 0.04, root + g, 0.4));
        }
      }
      return events;
    },
  },
  {
    id: 'confirm',
    name: '操作確認（2音上行）',
    theory: '完全4度の2音上行 = 世界共通の「肯定」',
    defaultRoot: 81, // A5
    defaultVoice: 4, // フルート
    build: (root) => [tone(0, 0.06, root, 0.4), tone(0.12, 0.1, root + 5, 0.4)],
  },
  {
    id: 'cancel',
    name: 'キャンセル・ハズレ',
    theory: '2音下行 + 音量減衰 = 「否定」。上行の裏返し',
    defaultRoot: 76, // E5
    defaultVoice: 4, // フルート
    build: (root) => [tone(0, 0.08, root, 0.45), tone(0.09, 0.18, root - 4, 0.3)],
  },
  {
    id: 'keikoku',
    name: '警告・激熱',
    theory: 'トライトーン（増4度）へのベンド + 2〜4kHz 帯。不安定音程 = 異常の記号',
    defaultRoot: 84, // C6（貫通力のある高域）
    defaultVoice: 10, // シンセ
    build: (root) => [
      tone(0, 0.22, root, 0.45, root + 6), // 増4度へずり上げ（警告の音程）
      { kind: 'noise', t: 0, dur: 0.06, freq: 6000, gain: 0.15 },
      tone(0.25, 0.4, root + 6, 0.5, root + 12), // さらにオクターブへ（激熱のリフト）
    ],
  },
  {
    id: 'beep2',
    name: '操作ビープ（ハモリ）',
    theory: '長6度の2音同時 = 短くても柔らかい協和。操作の即時フィードバック用',
    defaultRoot: 76, // E5（ベット既定。レバーは A5）
    defaultVoice: 10, // シンセ
    build: (root) => beepAt(0, root),
  },
  {
    id: 'beepChain',
    name: '連結ビープ（ベット→レバー）',
    theory: 'ビープ 2 打を完全4度上行で連結 = 「肯定→肯定」のリズム',
    defaultRoot: 76, // E5 → A5
    defaultVoice: 10, // シンセ
    build: (root) => [...beepAt(0, root), ...beepAt(0.09, root + 5)],
  },
  {
    id: 'thud',
    name: '停止音（タンッ）',
    theory: 'バスドラの打撃 + 中域の短いクリック = 物理的な「止まった」感。1 ゲームに 3 連打されるので音程感を薄く・短く・軽く',
    defaultRoot: 60, // C4（クリック成分。コードトーンで BGM と濁らない）
    defaultVoice: 13, // シンセベース
    build: (root) => [
      { kind: 'noise', t: 0, dur: 0.05, freq: 100, gain: 0.5 }, // バスドラ
      tone(0, 0.04, root, 0.35), // コッ（短い中域クリック。ベンドなし）
    ],
  },
  {
    id: 'coins',
    name: 'コイン払い出し',
    theory: '高域 2 音の速い交互連打 = 報酬密度のリズム化（コインの物理音の借用）',
    defaultRoot: 96, // C7
    defaultVoice: 12, // ビブラフォン
    build: (root) => {
      const events: SfxEvent[] = [];
      for (let i = 0; i < 8; i++) {
        events.push(tone(i * 0.062, 0.05, i % 2 === 0 ? root : root - 5, 0.45));
      }
      return events;
    },
  },
  {
    id: 'siren',
    name: 'サイレン',
    theory: '上下ベンドの反復 = 現実の緊急音の借用。放出・重大事の記号',
    defaultRoot: 74, // D5
    defaultVoice: 9, // ホルン
    build: (root) => [
      tone(0, 0.3, root, 0.5, root + 8),
      tone(0.3, 0.3, root + 8, 0.5, root),
      tone(0.6, 0.3, root, 0.5, root + 8),
      tone(0.9, 0.35, root + 8, 0.5, root),
    ],
  },
  {
    id: 'coinIn',
    name: 'コイン投入（3連上行）',
    theory: 'トニック分散和音（ド・ミ・ソ）の3連ビープ = MAX BET 3 枚の可聴化 + 上行の肯定。全部コードトーンなので BGM と濁らない',
    defaultRoot: 72, // C5
    defaultVoice: 10, // シンセ
    build: (root) => [
      tone(0, 0.045, root, 0.42),
      tone(0.06, 0.045, root + 4, 0.46),
      tone(0.12, 0.06, root + 7, 0.5),
    ],
  },
  {
    id: 'leverStart',
    name: 'レバーオン（始動ベンド）',
    theory: 'ソ→ド（完全4度上行）のベンドと着地 = 「到着・始動」の記号を 100ms 級に圧縮。毎ゲーム鳴るので短く控えめに',
    defaultRoot: 79, // G5 → C6
    defaultVoice: 10, // シンセ
    build: (root) => [
      tone(0, 0.04, root, 0.5, root + 5),
      tone(0.04, 0.05, root + 5, 0.4), // 着地のド（変換時にレガート結合される）
    ],
  },
  {
    id: 'startArp',
    name: 'リール始動（テレレレ）',
    theory:
      '主和音の速い分散上行（テロレロン）= 4号機始動音の定番様式。実機も YM2413（OPLL）の FM 音色による数十ms間隔のノート列だった。末尾だけ長くして着地感を出す。全部コードトーンで BGM と濁らない',
    defaultRoot: 72, // C5 → C6
    defaultVoice: 12, // ビブラフォン（明るく減衰が速い）
    build: (root) => [
      tone(0, 0.038, root, 0.42), // テ
      tone(0.04, 0.038, root + 4, 0.45), // レ
      tone(0.08, 0.038, root + 7, 0.48), // レ
      tone(0.12, 0.09, root + 12, 0.5), // レン（末尾は長め = 着地）
    ],
  },
  {
    id: 'startChain',
    name: 'ベット→レバー連結',
    theory: 'コイン投入 3 連（ド・ミ・ソ）から始動ベンド（ソ→ド）へ。分散和音上行の連結 = 「投入 → 始動」',
    defaultRoot: 72, // C5
    defaultVoice: 10, // シンセ
    build: (root) => [
      tone(0, 0.045, root, 0.42),
      tone(0.06, 0.045, root + 4, 0.46),
      tone(0.12, 0.06, root + 7, 0.5),
      tone(0.21, 0.05, root + 7, 0.5, root + 12),
      tone(0.26, 0.07, root + 12, 0.48),
    ],
  },
  {
    id: 'kyuin',
    name: 'キュイン（確定告知）',
    theory: '2オクターブの指数スイープ + 微上昇ホールド。デチューン 2 声で太らせる',
    defaultRoot: 67, // G4 ≒ 392Hz
    defaultVoice: 15, // エレキギター
    build: (root) => [
      tone(0, 0.35, root, 0.5, root + 24),
      tone(0, 0.35, root + 0.15, 0.4, root + 24.15), // デチューン重ね（当時流の太さ）
      tone(0.35, 0.55, root + 24, 0.5, root + 25),
      tone(0.35, 0.55, root + 24.15, 0.4, root + 25.15),
    ],
  },
];

/** design から再生イベント列を生成（速度倍率で時間軸を縮尺） */
export function buildSfxEvents(design: SfxDesign): SfxEvent[] {
  const recipe = SFX_RECIPES.find((r) => r.id === design.recipeId);
  if (!recipe) throw new Error(`未知のレシピ: ${design.recipeId}`);
  const scale = 1 / Math.max(0.25, design.speed);
  return recipe.build(design.rootMidi).map((e) => ({ ...e, t: e.t * scale, dur: e.dur * scale }));
}

/** 効果音の全長（秒） */
export function sfxDuration(events: SfxEvent[]): number {
  return events.reduce((max, e) => Math.max(max, e.t + e.dur), 0);
}
