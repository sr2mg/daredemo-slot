import { describe, expect, it } from 'vitest';
import { GameSession, initialState } from '../src/core/game.js';
import { Xoshiro128 } from '../src/core/rng.js';
import { playPerfect } from '../src/core/sim.js';
import type { EngineState } from '../src/core/types.js';
import { machines } from '../src/machines/index.js';

/**
 * 即入賞（教材モードの「⚡ 揃える」ボタン）の縫い目テスト。
 * UI の手順は「強制フラグ + 完全打ち。貯留に入っただけなら蓋を強制開放して
 * 純ハズレの 2 ゲーム目で揃える」— この組で全プリセット機種の全ボーナスが
 * 開始できることを保証する。これが通っていれば、ボタンの動作確認に
 * ブラウザでリールを回す必要はない。
 */

/** App.tsx の instantWin と同じ手順（最大 2 ゲーム） */
function instantWin(machine: (typeof machines)[number], bonusId: string, seed: number) {
  const rng = new Xoshiro128(seed);
  let state: EngineState = initialState(machine, 1);
  if (state.queue.includes(bonusId) && state.lid) state = { ...state, lid: false, lidReleaseIn: null };
  const playOnce = (engine: EngineState, forceFlags: string[]) => {
    const session = new GameSession(machine, engine, rng, undefined, forceFlags);
    playPerfect(session);
    return session.finish(rng);
  };
  let result = playOnce(state, state.queue.includes(bonusId) ? [] : [bonusId]);
  if (result.event.bonusStarted !== bonusId && result.state.queue.includes(bonusId)) {
    const opened = { ...result.state, lid: false, lidReleaseIn: null };
    result = playOnce(opened, []);
  }
  return result;
}

describe('強制フラグ + 完全打ち（+ 蓋の強制開放）で即入賞できる', () => {
  for (const machine of machines) {
    for (const bonus of machine.bonuses) {
      it(`${machine.name} / ${bonus.id}`, () => {
        const { event } = instantWin(machine, bonus.id, 42);
        expect(event.bonusStarted).toBe(bonus.id);
      });
    }
  }

  it('シードによらず揃う（押下位置探索が運任せでない）', () => {
    const machine = machines[0]!;
    const bonusId = machine.bonuses[0]!.id;
    for (const seed of [1, 7, 12345, 0xdeadbeef]) {
      expect(instantWin(machine, bonusId, seed).event.bonusStarted, `seed=${seed}`).toBe(bonusId);
    }
  });
});
