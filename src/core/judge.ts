import type { MachineDef, RoleDef, RoleId } from './types.js';

/**
 * 図柄組み合わせのキー。同一 pattern を共有する複数フラグ（押し順ベル 3 択等）の
 * 入賞判定・蹴飛ばしは、役 ID ではなくこのキー単位で行う（フラグ細分化の帰結）。
 */
export function patternKey(role: RoleDef): string {
  return role.pattern.join('|');
}

/** 停止位置 stop のリール reel が行 row に表示する図柄 */
export function symbolAt(machine: MachineDef, reel: number, stop: number, row: number): string {
  const strip = machine.strips[reel]!;
  return strip[(stop + row) % machine.frames]!;
}

/**
 * 全リール停止後の入賞役を返す（docs/design/03-reel-control.md 有効ライン）。
 * stops はリール順の停止位置（基準段 = 画面の下段。行番号は下から上へ 0,1,2）。
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
