// 筐体演出の純関数部分: リールランプの点灯パターン・状態ランプ・払い出しの刻み。
// App.tsx はここで決めた「何をいつ光らせるか」をそのまま描画・スケジュールするだけで、
// 抽選・制御・精算の結果（GameEvent / EngineState）には一切書き戻さない。
import { winningLines } from '../core/judge.js';
import { COINS_PER_SFX, COIN_STEP_SEC } from '../core/sfx/sfx-design.js';
import type { MachineDef } from '../core/types.js';
import { LAMPS_ALL_ON } from './reel-gl.js';
import type { LampLevels } from './reel-gl.js';

/** 入賞ライン以外の段の光量。消しきらずに「紙の裏が暗くなった」程度に落とす */
export const DIM_LEVEL = 0.22;
/** 確定フラッシュで点灯側の光量（通常の 1 より明るく、紙が白く飛ぶ手前） */
export const FLASH_LEVEL = 1.6;
/** 確定フラッシュの点滅周期（ms）と回数（点灯→消灯で 1 回）。合計 ≒ ファンファーレの長さ */
export const FLASH_PERIOD_MS = 120;
export const FLASH_CYCLES = 5;

/**
 * 全リール停止後に点灯させる段。リールごとに「入賞ラインが通る行（0=下段, 1=中段, 2=上段）」の集合。
 * 入賞が無ければ null（= 全段点灯のまま。実機もハズレでは消灯しない）
 */
export function litRows(machine: MachineDef, stops: readonly number[]): ReadonlySet<number>[] | null {
  const lines = winningLines(machine, stops);
  if (lines.length === 0) return null;
  return machine.strips.map((_, reel) => new Set(lines.map((i) => machine.lines[i]![reel]!)));
}

/** 点灯行の集合 → ReelColumn の lamps（[上, 中, 下]）。null は全段点灯 */
export function lampsForRows(rows: ReadonlySet<number> | null): LampLevels {
  if (rows === null) return LAMPS_ALL_ON;
  const level = (row: number) => (rows.has(row) ? 1 : DIM_LEVEL);
  return [level(2), level(1), level(0)];
}

/** 確定フラッシュ中の lamps。on の半周期は全段を明るく、off の半周期は全段消灯 */
export function flashLamps(on: boolean): LampLevels {
  const level = on ? FLASH_LEVEL : 0;
  return [level, level, level];
}

export type CabinetPhase = 'ready' | 'waiting' | 'spinning';

export interface StatusLampInput {
  phase: CabinetPhase;
  /** MAX BET 済み（演出上。投入自体はレバー ON 時） */
  betDone: boolean;
  /** 再遊技（自動ベット）待ち */
  pendingRebet: boolean;
  /** 機種の 1 ゲーム投入枚数 */
  bet: number;
}

export interface StatusLamps {
  /** 投入可（メダルを入れてください）。未ベットの待機中に点滅 */
  insert: boolean;
  /** 点灯する BET ランプの数（0〜3） */
  betCount: number;
  /** 再遊技ランプ */
  replay: boolean;
  /** スタートランプ（レバー有効）。ベット済みで待機中に点滅 */
  start: boolean;
  /** ウエイトランプ */
  wait: boolean;
}

/**
 * 筐体の状態ランプ。実機の「投入 → ベット点灯 → スタート点滅 → 回転中は消灯」の遷移を
 * UI の phase とベット状態から決める。再遊技は投入なしで BET が全点灯しスタートが点滅する
 */
export function statusLamps(input: StatusLampInput): StatusLamps {
  const { phase, betDone, pendingRebet, bet } = input;
  const ready = phase === 'ready';
  const betLit = pendingRebet || betDone || !ready;
  return {
    insert: ready && !betDone && !pendingRebet,
    betCount: betLit ? Math.min(3, Math.max(0, bet)) : 0,
    replay: pendingRebet,
    start: ready && (betDone || pendingRebet),
    wait: phase === 'waiting',
  };
}

export const COIN_TICK_MS = Math.round(COIN_STEP_SEC * 1000);

export interface PayoutSchedule {
  /** i 枚目（0 始まり）がクレジットに加算される時刻（ms、精算からの相対） */
  coinAtMs: readonly number[];
  /** 払い出し音を鳴らし直す時刻（ms）。1 回の音が COINS_PER_SFX 枚ぶんなので、その単位で区切る */
  sfxAtMs: readonly number[];
  /** 最後の 1 枚が入る時刻（ms） */
  endMs: number;
}

/**
 * 払い出しを 1 枚ずつ刻む予定表。1 枚目は精算と同時（最初の払い出し音の頭）、以降はコイン音の
 * 1 打間隔で進む。音は 8 枚ごとに頭出しし、最後の端数も 1 回ぶん鳴らす（実機のホッパー音も
 * 枚数ちょうどで切れない）。payout 0 なら何も起きない
 */
export function payoutSchedule(payout: number): PayoutSchedule {
  const n = Math.max(0, Math.floor(payout));
  const coinAtMs = Array.from({ length: n }, (_, i) => i * COIN_TICK_MS);
  const sfxAtMs = Array.from({ length: Math.ceil(n / COINS_PER_SFX) }, (_, k) => k * COINS_PER_SFX * COIN_TICK_MS);
  return { coinAtMs, sfxAtMs, endMs: n === 0 ? 0 : (n - 1) * COIN_TICK_MS };
}
