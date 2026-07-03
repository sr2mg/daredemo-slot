import { describe, expect, it } from 'vitest';
import { ControlContext } from '../src/core/control.js';
import { winsAt } from '../src/core/judge.js';
import type { RoleId, StopEvent } from '../src/core/types.js';
import { sampleAType } from '../src/machines/sample-a.js';

/**
 * docs/design/03-reel-control.md「テストと検証」の性質テスト:
 * (a) 非成立役が入賞するケースが存在しない（蹴飛ばし）
 * (b) 成立リプレイの取りこぼしが存在しない
 * (d) PB=1 役（bell）の取りこぼしが存在しない
 * を押下位置・押し順の総当たりで検証する。
 * ((c) 蓋はステップ 3 の状態機械実装時に追加)
 */

const machine = sampleAType;
const N = machine.frames;

const ORDERS: readonly (readonly number[])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

function play(ctx: ControlContext, order: readonly number[], pushes: readonly number[]): number[] {
  const history: StopEvent[] = [];
  for (const reel of order) {
    const push = pushes[reel]!;
    const slip = ctx.resolveStop(history, reel, push);
    history.push({ reel, pushPosition: push, stopPosition: (push + slip) % N });
  }
  const stops = [0, 0, 0];
  for (const event of history) stops[event.reel] = event.stopPosition;
  return stops;
}

interface Expectation {
  active: RoleId[];
  /** これらの役は全押下位置・全押し順で必ず入賞していなければならない */
  mustWin: RoleId[];
}

const CASES: Expectation[] = [
  { active: [], mustWin: [] },
  { active: ['replay'], mustWin: ['replay'] }, // (b)
  { active: ['bell'], mustWin: ['bell'] }, // (d) PB=1
  { active: ['cherry'], mustWin: [] },
  { active: ['melon'], mustWin: [] },
  { active: ['bb_red'], mustWin: [] },
  { active: ['rb'], mustWin: [] },
  { active: ['cherry', 'bb_red'], mustWin: [] },
];

function assertGame(ctx: ControlContext, expectation: Expectation, order: readonly number[], pushes: readonly number[]): void {
  const stops = play(ctx, order, pushes);
  const wins = winsAt(machine, stops);
  const activeSet = new Set(expectation.active);
  for (const win of wins) {
    if (!activeSet.has(win)) {
      throw new Error(
        `illegal win ${win} (active=[${expectation.active}] order=[${order}] pushes=[${pushes}] stops=[${stops}])`,
      );
    }
  }
  for (const must of expectation.mustWin) {
    if (!wins.includes(must)) {
      throw new Error(
        `missed ${must} (active=[${expectation.active}] order=[${order}] pushes=[${pushes}] stops=[${stops}])`,
      );
    }
  }
}

describe.each(CASES)('フラグ状態 [$active]', (expectation) => {
  it('順押し全押下位置の総当たりで蹴飛ばし・引き込みが破綻しない', () => {
    const ctx = new ControlContext(machine, new Set(expectation.active));
    const order = ORDERS[0]!;
    for (let p0 = 0; p0 < N; p0++) {
      for (let p1 = 0; p1 < N; p1++) {
        for (let p2 = 0; p2 < N; p2++) {
          assertGame(ctx, expectation, order, [p0, p1, p2]);
        }
      }
    }
  });

  it('全 6 押し順 × 押下位置ストライドで破綻しない', () => {
    const ctx = new ControlContext(machine, new Set(expectation.active));
    const positions = [0, 3, 6, 9, 12, 15, 18];
    for (const order of ORDERS) {
      for (const p0 of positions) {
        for (const p1 of positions) {
          for (const p2 of positions) {
            assertGame(ctx, expectation, order, [p0, p1, p2]);
          }
        }
      }
    }
  });
});

describe('制御の決定論性', () => {
  it('同一入力に対して常に同じ滑りを返す', () => {
    const ctx1 = new ControlContext(machine, new Set(['bell']));
    const ctx2 = new ControlContext(machine, new Set(['bell']));
    for (let push = 0; push < N; push++) {
      expect(ctx1.resolveStop([], 0, push)).toBe(ctx2.resolveStop([], 0, push));
    }
  });
});
