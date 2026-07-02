import type { MachineDef, RoleId } from './types.js';

/** 停止位置 stop のリール reel が行 row に表示する図柄 */
export function symbolAt(machine: MachineDef, reel: number, stop: number, row: number): string {
  const strip = machine.strips[reel]!;
  return strip[(stop + row) % machine.frames]!;
}

/**
 * 全リール停止後の入賞役を返す（docs/design/03-reel-control.md 有効ライン）。
 * stops はリール順の停止位置（上段基準）。
 */
export function winsAt(machine: MachineDef, stops: readonly number[]): RoleId[] {
  const result: RoleId[] = [];
  for (const role of machine.roles) {
    let won = false;
    for (const line of machine.lines) {
      let match = true;
      for (let reel = 0; reel < stops.length; reel++) {
        const want = role.pattern[reel]!;
        if (want !== 'any' && symbolAt(machine, reel, stops[reel]!, line[reel]!) !== want) {
          match = false;
          break;
        }
      }
      if (match) {
        won = true;
        break;
      }
    }
    if (won) result.push(role.id);
  }
  return result;
}
