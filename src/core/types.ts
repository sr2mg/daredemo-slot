/**
 * コアエンジンの型定義（実装ステップ 1〜2 の範囲）。
 * 機種定義 JSON スキーマ（docs/design/05-config-schema.md）のうち、
 * 抽選・リール制御に必要な部分のエンジン内表現。
 * 役物・RT・持ち越し等の状態機械はステップ 3 で拡張する。
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

export interface MachineDef {
  name: string;
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
  /** 引き込み優先モード（docs/design/03-reel-control.md 優先度 4） */
  priority: 'role-first' | 'bonus-first';
  /** 基底抽選テーブル（MVP: 通常時・単一設定のみ。設定別・状態別はステップ 3 で拡張） */
  baseTable: readonly WeightedEntry[];
}

/** 停止済みリールの順序付き操作履歴（docs/design/03-reel-control.md） */
export interface StopEvent {
  reel: number;
  pushPosition: number;
  stopPosition: number;
}

/** 当該ゲームで入賞制御に乗る役集合（成立フラグ + キュー先頭ボーナス） */
export type FlagSet = ReadonlySet<RoleId>;
