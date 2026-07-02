import type { Rng } from './rng.js';
import type { RoleId, WeightedEntry } from './types.js';

/**
 * レバー ON 時の内部抽選（docs/design/02-lottery.md）。
 * 16bit 乱数を 1 回引き、テーブルのエントリを重み順に走査する。
 * 残余はハズレ（空集合）。
 */
export function drawLottery(table: readonly WeightedEntry[], rng: Rng): readonly RoleId[] {
  const value = rng.draw16();
  let cursor = 0;
  for (const entry of table) {
    cursor += entry.weight;
    if (value < cursor) return entry.roles;
  }
  return [];
}

/** テーブルの重み合計（バリデーション用。65536 以下であること） */
export function totalWeight(table: readonly WeightedEntry[]): number {
  return table.reduce((sum, entry) => sum + entry.weight, 0);
}
