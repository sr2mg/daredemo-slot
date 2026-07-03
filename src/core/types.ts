/**
 * コアエンジンの型定義。
 * 機種定義 JSON スキーマ（docs/design/05-config-schema.md）のエンジン内表現と、
 * エンジン状態・GameEvent（docs/design/01-machine-model.md）。
 * 未実装: JAC（BB 内サブ役物）、集中、ナビ層、設定差。コードに TODO を残す。
 */

export type SymbolId = string;
export type RoleId = string;

export type PullIn = 'guaranteed' | { missable: { targetRate: number } };

export interface RoleDef {
  id: RoleId;
  /** bonus はエンジン内では役として統一的に扱う（図柄組み合わせで入賞判定するため） */
  kind: 'replay' | 'small' | 'bonus';
  /** 払い出し枚数。replay / bonus は 0 */
  payout: number;
  /** リールごとの要求図柄。'any' は任意 */
  pattern: readonly (SymbolId | 'any')[];
  pullIn: PullIn;
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
  | { type: 'lottery'; weight: number } // 毎ゲーム 65536 分率で解除抽選
  | { type: 'roleHit'; of: RoleId };

export interface LidDef {
  engageOn: readonly ('bonusFlag' | 'bonusEnd')[];
  release: LidRelease;
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
  /** 基底抽選テーブル（MVP: 単一設定。設定差は将来拡張） */
  lottery: { base: readonly WeightedEntry[] };
  /** 役物の tableRef から参照される丸ごとテーブル */
  tables: Record<string, readonly WeightedEntry[]>;
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
}
