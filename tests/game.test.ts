import { describe, expect, it } from 'vitest';
import { initialState, playGame, resolveTable } from '../src/core/game.js';
import type { ChooseStops } from '../src/core/game.js';
import type { Rng, RngState } from '../src/core/rng.js';
import { choosePerfect, simulate } from '../src/core/sim.js';
import type { EngineState, GameEvent, MachineDef } from '../src/core/types.js';
import { sampleAType } from '../src/machines/sample-a.js';

/** draw16 が指定系列を返すスタブ（使い切ったら fallback = ハズレ域） */
class SeqRng implements Rng {
  private i = 0;
  constructor(
    private readonly values: readonly number[],
    private readonly fallback = 65535,
  ) {}
  draw16(): number {
    return this.values[this.i++] ?? this.fallback;
  }
  nextUint32(): number {
    return this.draw16() << 16;
  }
  nextInt(): number {
    return 0;
  }
  getState(): RngState {
    return { s0: 0, s1: 0, s2: 0, s3: 0 };
  }
}

const perfect: ChooseStops = (_active, ctx) => choosePerfect(sampleAType, ctx);
/** seven（L0 / C4 / R3）に絶対届かない押下位置で止める下手打ち */
const missSeven: ChooseStops = () => ({ order: [0, 1, 2], pushes: [10, 10, 10] });

const BB_DRAW = 17308; // base テーブルの bb_red 単独当選域

function run(
  machine: MachineDef,
  state: EngineState,
  rng: Rng,
  choose: ChooseStops,
): { state: EngineState; event: GameEvent } {
  return playGame(machine, state, choose, rng);
}

describe('ボーナスのライフサイクルと RT', () => {
  it('BB 当選 → 即入賞 → 20G 消化で終了 → RT 突入 → 50G で転落', () => {
    const rng = new SeqRng([BB_DRAW, ...Array(20).fill(0)]);
    let state = initialState();

    // ゲーム 1: BB 成立・完全打ちで同ゲーム入賞
    let result = run(sampleAType, state, rng, perfect);
    expect(result.event.queuedBonus).toBe('bb_red');
    expect(result.event.bonusStarted).toBe('bb_red');
    expect(result.state.base.type).toBe('bonus');
    expect(result.state.queue).toHaveLength(0);
    state = result.state;

    // BB 中 20 ゲーム（bell 高確率テーブル）
    let ended: GameEvent | null = null;
    for (let i = 0; i < 20; i++) {
      result = run(sampleAType, state, rng, perfect);
      state = result.state;
      if (result.event.bonusEnded !== null) ended = result.event;
    }
    expect(ended).not.toBeNull();
    expect(ended!.bonusEnded).toBe('bb_red');
    expect(ended!.rtEntered).toBe('rt_high');
    expect(state.rt).toBe('rt_high');
    // BB 中は毎ゲーム bell（8 枚）入賞していた
    expect(state.base.type).toBe('normal');

    // RT 中はリプレイ重みが差し替わっている
    const rtTable = resolveTable(sampleAType, state);
    expect(rtTable.find((e) => e.roles.length === 1 && e.roles[0] === 'replay')?.weight).toBe(29127);

    // RT 50 ゲーム消化で転落
    let exited: GameEvent | null = null;
    for (let i = 0; i < 50; i++) {
      result = run(sampleAType, state, rng, perfect);
      state = result.state;
      if (result.event.rtExited !== null) exited = result.event;
    }
    expect(exited).not.toBeNull();
    expect(exited!.rtExited).toBe('rt_high');
    expect(state.rt).toBeNull();
  });

  it('取りこぼしたボーナスは入賞まで持ち越される（内部中）', () => {
    const rng = new SeqRng([BB_DRAW]);
    let state = initialState();

    // 下手打ちで取りこぼし → キューに残る
    let result = run(sampleAType, state, rng, missSeven);
    expect(result.event.queuedBonus).toBe('bb_red');
    expect(result.event.bonusStarted).toBeNull();
    expect(result.state.queue).toEqual(['bb_red']);
    state = result.state;

    // 内部中はボーナス系エントリがテーブルから消える（queueLimit: 1 で満杯）
    const innerTable = resolveTable(sampleAType, state);
    expect(innerTable.some((e) => e.roles.includes('bb_red') || e.roles.includes('rb'))).toBe(false);
    // 重複エントリ（cherry+bb_red）は小役のみ残る
    expect(innerTable.filter((e) => e.roles.length === 1 && e.roles[0] === 'cherry')).toHaveLength(2);

    // 次ゲーム完全打ちで放出
    result = run(sampleAType, state, rng, perfect);
    expect(result.event.bonusStarted).toBe('bb_red');
    expect(result.state.queue).toHaveLength(0);
  });
});

describe('ストック機の蓋（性質 (c): 蓋 on 中にボーナスが入賞しない）', () => {
  const stockMachine: MachineDef = {
    ...sampleAType,
    carryover: {
      queueLimit: 5,
      lid: {
        engageOn: ['bonusFlag'],
        release: { type: 'gameCountTable', table: [{ games: 3, weight: 100 }] },
      },
    },
  };

  it('蓋 on の間は完全打ちでも入賞せず、解除ゲームから入賞できる。ストックも積める', () => {
    const rng = new SeqRng([BB_DRAW, BB_DRAW]);
    let state = initialState();

    // ゲーム 1: BB 成立 → 蓋 on（解除まで 3G）。完全打ちでも入賞しない
    let result = run(stockMachine, state, rng, perfect);
    expect(result.event.queuedBonus).toBe('bb_red');
    expect(result.state.lid).toBe(true);
    expect(result.event.bonusStarted).toBeNull();
    expect(result.event.wins).not.toContain('bb_red');
    state = result.state;

    // ゲーム 2: 内部中でも 2 個目の BB がストックされる（queueLimit 5）
    result = run(stockMachine, state, rng, perfect);
    expect(result.event.queuedBonus).toBe('bb_red');
    expect(result.state.queue).toHaveLength(2);
    expect(result.event.wins).not.toContain('bb_red');
    state = result.state;

    // ゲーム 3: まだ蓋 on
    result = run(stockMachine, state, rng, perfect);
    expect(result.state.lid).toBe(true);
    expect(result.event.wins).not.toContain('bb_red');
    state = result.state;

    // ゲーム 4: 蓋解除 → 同ゲームから放出可能
    result = run(stockMachine, state, rng, perfect);
    expect(result.event.lidReleased).toBe(true);
    expect(result.event.bonusStarted).toBe('bb_red');
    expect(result.state.queue).toHaveLength(1); // 2 個目はストックされたまま
  });
});

describe('リプレイの再遊技', () => {
  it('リプレイ入賞の次ゲームは投入 0', () => {
    const rng = new SeqRng([0, 65535]); // ゲーム1: replay 当選, ゲーム2: ハズレ
    let state = initialState();
    let result = run(sampleAType, state, rng, perfect);
    expect(result.event.replayWon).toBe(true);
    expect(result.event.bet).toBe(3);
    result = run(sampleAType, result.state, rng, perfect);
    expect(result.event.bet).toBe(0);
  });
});

describe('機械割の実測（スモーク）', () => {
  it('適当打ちの機械割が妥当な範囲に収まり、ボーナスが発生する', () => {
    const naive = simulate(sampleAType, { games: 20_000, strategy: 'naive', seed: 1 });
    expect(naive.payoutRate).toBeGreaterThan(0.3);
    expect(naive.payoutRate).toBeLessThan(1.2);
    expect(naive.bonusStarts['bb_red'] ?? 0).toBeGreaterThan(10);
    expect(naive.bonusStarts['rb'] ?? 0).toBeGreaterThan(10);
  });

  it('完全打ちは適当打ちより機械割が高い（技術介入度の指標）', () => {
    const naive = simulate(sampleAType, { games: 5_000, strategy: 'naive', seed: 7 });
    const perfectResult = simulate(sampleAType, { games: 5_000, strategy: 'perfect', seed: 7 });
    expect(perfectResult.payoutRate).toBeGreaterThan(naive.payoutRate);
  });
});
