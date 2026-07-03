/**
 * コアエンジンの型定義。
 * 機種定義 JSON スキーマ（docs/design/05-config-schema.md）のエンジン内表現と、
 * エンジン状態・GameEvent（docs/design/01-machine-model.md）。
 * 未実装: JAC（BB 内サブ役物）、集中、ナビ層、設定差。コードに TODO を残す。
 */

export type SymbolId = string;
export type RoleId = string;

export type PullIn = 'guaranteed' | { missable: { targetRate: number } };

/** 打ち分け指定（docs/design/01 軸 2）。MVP は第 1 停止リールのみで正解判定する 3 択 */
export interface RoleNav {
  /** 所属 navGroup（machine.navGroups への参照） */
  group: string;
  /** 正解の第 1 停止リール番号。完全な押し順 6 択は将来拡張 */
  correctFirst: number;
  /** 不正解時: 取りこぼし or 参照役の入賞 */
  onMiss: { type: 'lose' } | { type: 'reduced'; roleRef: RoleId };
}

export interface RoleDef {
  id: RoleId;
  /** bonus はエンジン内では役として統一的に扱う（図柄組み合わせで入賞判定するため） */
  kind: 'replay' | 'small' | 'bonus';
  /** 払い出し枚数。replay / bonus は 0 */
  payout: number;
  /** リールごとの要求図柄。'any' は任意 */
  pattern: readonly (SymbolId | 'any')[];
  pullIn: PullIn;
  /**
   * 打ち分け指定。同一 pattern を持つ複数の役（例: 押し順ベル 3 択）はフラグ細分化であり、
   * 入賞判定・蹴飛ばしは図柄組み合わせ（pattern）単位で行われる
   */
  nav?: RoleNav;
}

// ===== 軸 5: ナビ（サブ基板。メインには一切干渉しない） =====

export type AtTrigger =
  | { on: 'roleHit'; of: RoleId; prob: number }
  | { on: 'pureMiss'; prob: number }
  | { on: 'gamesCeiling'; n: number };

export interface NavAtDef {
  triggers: readonly AtTrigger[];
  management:
    | { type: 'games'; games: number }
    | { type: 'set'; gamesPerSet: number; continueProb: number };
  addOn?: readonly { on: 'roleHit'; of: RoleId; addGames: number }[];
  /** ナビを出す navGroup */
  navTargets: readonly string[];
}

/** 抽選テーブルの 1 エントリ。フラグ = 役 ID の集合（docs/design/02-lottery.md） */
export interface WeightedEntry {
  roles: readonly RoleId[];
  /** 65536 分率。テーブル内の合計 ≤ 65536、残余はハズレ */
  weight: number;
}

// ===== 軸 1: 役物 =====

export interface BonusEnd {
  games?: number;
  wins?: number;
  maxPayout?: number;
  // TODO: jacCount（JAC 実装時）
}

export interface BonusDef {
  /** roles[] の kind: 'bonus' な役と同じ id */
  id: RoleId;
  kind: 'bb' | 'rb' | 'sb';
  /** sb は無視される（1 ゲームで終了） */
  end: BonusEnd;
  /** 作動中テーブル（machine.tables のキー） */
  tableRef: string;
  // TODO: jac?: { triggerRole, tableRef, end }（docs/design/01 軸 1）
}

// ===== 軸 3: RT =====

export type RtTrigger =
  | { on: 'bonusEnd'; of?: RoleId }
  | { on: 'roleHit'; of: RoleId }
  | { on: 'games'; n: number }
  | { on: 'bonusFlag'; of?: RoleId };

export interface RtStateDef {
  id: string;
  /** 基底テーブルの単独役エントリの重み差し替え（docs/design/02 オーバーレイ） */
  replayWeights: Record<RoleId, number>;
  entry: readonly RtTrigger[];
  exit: readonly RtTrigger[];
}

// ===== 軸 4: 持ち越し・放出 =====

export type LidRelease =
  | { type: 'gameCountTable'; table: readonly { games: number; weight: number }[] }
  | {
      type: 'lottery';
      weight: number; // 65536 分率で解除抽選
      /** 'pureMiss' = 純ハズレ（抽選結果が空集合）のゲームのみ抽選（サラ金型 KC）。既定 'any' */
      on?: 'any' | 'pureMiss';
    }
  | { type: 'roleHit'; of: RoleId };

/** モード = 解除テーブルの選択状態（吉宗型の通常/天国）。出玉に直結するのでメイン管理 */
export interface ModeDef {
  id: string;
  release: LidRelease;
  /** ボーナス終了時のモード移行（重み付き）。省略時は現状維持 */
  onBonusEnd?: readonly { to: string; weight: number }[];
}

export interface LidDef {
  /** bonusFlag = ストックが空→非空になったとき / bonusEnd = ボーナス終了時に掛け直し（キュー非空時） */
  engageOn: readonly ('bonusFlag' | 'bonusEnd')[];
  /** modes を使わない場合の解除条件 */
  release?: LidRelease;
  /** モード付き解除（release と排他） */
  modes?: { initial: string; states: readonly ModeDef[] };
}

export interface CarryoverDef {
  /** 1 = 単純持ち越し（通常機）、>1 = ストック機 */
  queueLimit: number;
  lid: LidDef | null;
}

// ===== 機種定義 =====

export interface MachineDef {
  name: string;
  /** 1 ゲームの投入枚数 */
  bet: number;
  /** リール 1 本のコマ数 */
  frames: number;
  /** [リール][コマ] の図柄。全リール同じコマ数 */
  strips: readonly (readonly SymbolId[])[];
  /**
   * 有効ライン。各ラインはリールごとの行番号（0=上段, 1=中段, 2=下段）。
   * 停止位置 s のリールは行 r に strip[(s + r) % frames] を表示する。
   */
  lines: readonly (readonly number[])[];
  roles: readonly RoleDef[];
  bonuses: readonly BonusDef[];
  rtStates: readonly RtStateDef[];
  carryover: CarryoverDef;
  /** 引き込み優先モード（docs/design/03-reel-control.md 優先度 4） */
  priority: 'role-first' | 'bonus-first';
  /**
   * 抽選テーブル。base = 設定 1 の基底。設定 2〜6 は settingOverrides の差分
   * （roles 集合が一致するエントリの重みを上書き。無ければ追加）で表現する。
   * 役物中テーブル（tables）は設定共通(MVP)
   */
  lottery: {
    /** 設定の本数（1〜6）。省略時 1 = 設定なし */
    settings?: number;
    base: readonly WeightedEntry[];
    /** 設定番号（"2"〜"6"）→ 上書きエントリ */
    settingOverrides?: Record<string, readonly WeightedEntry[]>;
  };
  /** 役物の tableRef から参照される丸ごとテーブル */
  tables: Record<string, readonly WeightedEntry[]>;
  /** 打ち分けグループの定義（任意） */
  navGroups?: readonly { id: string }[];
  /** ナビ層（サブ基板）の定義（任意）。AT の状態管理はコアの外（NavLayer）が行う */
  nav?: { at: NavAtDef };
}

// ===== エンジン状態と GameEvent =====

/** 停止済みリールの順序付き操作履歴（docs/design/03-reel-control.md） */
export interface StopEvent {
  reel: number;
  pushPosition: number;
  stopPosition: number;
}

/** 当該ゲームで入賞制御に乗る役集合（成立フラグ + キュー先頭ボーナス） */
export type FlagSet = ReadonlySet<RoleId>;

export interface BonusRun {
  bonusId: RoleId;
  gamesPlayed: number;
  totalPayout: number;
  wins: number;
}

export interface EngineState {
  /** 設定値（1〜settings）。ホール側の操作なので遊技中は変わらない */
  setting: number;
  base: { type: 'normal' } | { type: 'bonus'; run: BonusRun };
  /** 現在の RT 状態 id（null = 非 RT） */
  rt: string | null;
  /** 現在の RT での消化ゲーム数（games 契機の exit 用） */
  rtGames: number;
  /** 持ち越しボーナスの FIFO キュー（先頭のみ入賞制御に乗る） */
  queue: RoleId[];
  /** 蓋（on の間はキュー先頭も蹴飛ばし対象） */
  lid: boolean;
  /** gameCountTable 解除の残ゲーム数 */
  lidReleaseIn: number | null;
  /** 現在のモード（lid.modes 使用時のみ非 null） */
  mode: string | null;
  /** 前ゲームがリプレイ入賞（次ゲームは投入 0） */
  pendingRebet: boolean;
}

/** コアが 1 ゲームごとに発行する読み取り専用イベント（docs/design/00-overview.md） */
export interface GameEvent {
  /** 実際に投入された枚数（再遊技は 0） */
  bet: number;
  /** 当該ゲームの抽選結果（役 ID の集合） */
  flags: readonly RoleId[];
  /** このゲームでキューに積まれたボーナス */
  queuedBonus: RoleId | null;
  stops: readonly number[];
  wins: readonly RoleId[];
  payout: number;
  replayWon: boolean;
  bonusStarted: RoleId | null;
  bonusEnded: RoleId | null;
  rtEntered: string | null;
  rtExited: string | null;
  lidReleased: boolean;
  /** モードが移行した場合の新モード id */
  modeChanged: string | null;
}
