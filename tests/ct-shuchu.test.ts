import { describe, expect, it } from 'vitest';
import { initialState, playGame } from '../src/core/game.js';
import type { Strategy } from '../src/core/game.js';
import { NavLayer } from '../src/core/nav.js';
import type { Rng, RngState } from '../src/core/rng.js';
import { playPerfect, simulate } from '../src/core/sim.js';
import type { EngineState, GameEvent, MachineDef } from '../src/core/types.js';
import { validateMachine } from '../src/core/validate.js';
import { atBeast } from '../src/machines/at-beast.js';
import { ctMachine } from '../src/machines/ct-machine.js';
import { shuchuMachine } from '../src/machines/shuchu.js';

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

const perfect: Strategy = (session) => playPerfect(session);

function eventWith(partial: Partial<GameEvent>): GameEvent {
  return {
    bet: 3,
    flags: [],
    queuedBonus: null,
    stops: [0, 0, 0],
    wins: [],
    payout: 0,
    replayWon: false,
    bonusStarted: null,
    bonusEnded: null,
    rtEntered: null,
    rtExited: null,
    ctEntered: null,
    ctExited: null,
    lidReleased: false,
    modeChanged: null,
    ...partial,
  };
}

describe('CT（チャレンジタイム）', () => {
  // ctMachine base の区間: replay 8978 / bell →18278 / cherry →19335 / melon →20435 /
  // cherry+bb →20501 / bb_red →20691 / rb →20971
  const BB_DRAW = 20501;

  it('BB 終了で CT 突入 → フラグ無しでもフリー役が取れる → 獲得上限で終了', () => {
    const rng = new SeqRng([BB_DRAW, ...Array(25).fill(0)]);
    let state: EngineState = initialState(ctMachine);

    // BB 成立・即入賞 → 25G 消化
    let result = playGame(ctMachine, state, perfect, rng);
    expect(result.event.bonusStarted).toBe('bb_red');
    state = result.state;
    let entered: GameEvent | null = null;
    for (let i = 0; i < 25; i++) {
      result = playGame(ctMachine, state, perfect, rng);
      state = result.state;
      if (result.event.ctEntered !== null) entered = result.event;
    }
    expect(entered).not.toBeNull();
    expect(entered!.bonusEnded).toBe('bb_red');
    expect(entered!.ctEntered).toBe('ct');
    expect(state.ct).toBe('ct');

    // CT 中: 抽選は全部ハズレ（fallback 65535）なのに完全打ちはスイカ 15 枚を取れる
    result = playGame(ctMachine, state, perfect, rng);
    expect(result.event.flags).toEqual([]);
    expect(result.event.wins).toContain('melon');
    expect(result.event.payout).toBe(15);
    state = result.state;
    expect(state.ctPayout).toBe(15);

    // 120 枚（8 ゲーム）で獲得上限終了
    let exited: GameEvent | null = null;
    for (let i = 0; i < 7 && exited === null; i++) {
      result = playGame(ctMachine, state, perfect, rng);
      state = result.state;
      if (result.event.ctExited !== null) exited = result.event;
    }
    expect(exited).not.toBeNull();
    expect(state.ct).toBeNull();
    expect(state.ctPayout).toBe(0);
  });

  it('リプレイ入賞でパンク終了する', () => {
    const rng = new SeqRng([BB_DRAW, ...Array(25).fill(0), 65535, 0]);
    let state: EngineState = initialState(ctMachine);
    let result = playGame(ctMachine, state, perfect, rng);
    state = result.state;
    for (let i = 0; i < 25; i++) {
      result = playGame(ctMachine, state, perfect, rng);
      state = result.state;
    }
    expect(state.ct).toBe('ct');

    // 1G 目: ハズレ（スイカ獲得）、2G 目: リプレイ成立 → パンク
    result = playGame(ctMachine, state, perfect, rng);
    state = result.state;
    result = playGame(ctMachine, state, perfect, rng);
    expect(result.event.wins).toContain('replay');
    expect(result.event.ctExited).toBe('ct');
    expect(result.state.ct).toBeNull();
  });

  it('適当打ちと完全打ちの機械割差が大きい（CT = 技術介入の教材）', () => {
    const naive = simulate(ctMachine, { games: 30_000, strategy: 'naive', seed: 9 });
    const perfectResult = simulate(ctMachine, { games: 30_000, strategy: 'perfect', seed: 9 });
    expect(perfectResult.payoutRate - naive.payoutRate).toBeGreaterThan(0.1);
  });
});

describe('集中（3号機風・SB 集中）', () => {
  // shuchu base の区間: replay 8978 / bell →15530 / cherry →16587 / melon →17387 /
  // sb_kin →18887 / bb_red →19087。集中中は sb_kin が 36000 → [17387, 53387)
  const MELON = 16587;
  const CHERRY = 15530;
  const SB_IN_SHUCHU = 20000;

  it('スイカで突入 → SB が跳ね上がる → SB を挟んでも継続 → チェリーでパンク', () => {
    const rng = new SeqRng([MELON, SB_IN_SHUCHU, 0, CHERRY]);
    let state: EngineState = initialState(shuchuMachine);

    // ゲーム 1: スイカ入賞 → 集中突入
    let result = playGame(shuchuMachine, state, perfect, rng);
    expect(result.event.wins).toContain('melon');
    expect(result.event.rtEntered).toBe('shuchu');
    state = result.state;

    // ゲーム 2: 集中テーブルでは 20000 は SB 域（通常テーブルなら bb_red 域ですらない）
    result = playGame(shuchuMachine, state, perfect, rng);
    expect(result.event.bonusStarted).toBe('sb_kin');
    expect(result.event.payout).toBe(15);
    // SB は普通役物なので集中（RT）を壊さない
    expect(result.state.rt).toBe('shuchu');
    state = result.state;

    // ゲーム 3: SB 作動ゲーム消化（集中は継続）
    result = playGame(shuchuMachine, state, perfect, rng);
    expect(result.event.bonusEnded).toBe('sb_kin');
    expect(result.state.rt).toBe('shuchu');
    state = result.state;

    // ゲーム 4: チェリー入賞 → パンク
    result = playGame(shuchuMachine, state, perfect, rng);
    expect(result.event.wins).toContain('cherry');
    expect(result.event.rtExited).toBe('shuchu');
    expect(result.state.rt).toBeNull();
  });

  it('validateMachine は集中を「時代警告」として知らせる（エラーではない）', () => {
    const result = validateMachine(shuchuMachine);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes('集中') && w.includes('2〜3号機'))).toBe(true);
  });
});

describe('AT モード（サブ基板の高確/低確）', () => {
  /** 移行確率 1.0・トリガー確率 1.0 の決定論的なモード機 */
  const modeMachine: MachineDef = {
    ...atBeast,
    nav: {
      at: {
        triggers: [{ on: 'gamesCeiling', n: 10_000 }],
        management: { type: 'games', games: 2 },
        navTargets: ['bell3'],
      },
      modes: {
        initial: 'low',
        states: [
          {
            id: 'low',
            triggers: [{ on: 'gamesCeiling', n: 10_000 }],
            transitions: [{ on: 'roleHit', of: 'melon', to: 'high', prob: 1 }],
          },
          {
            id: 'high',
            triggers: [
              { on: 'roleHit', of: 'cherry', prob: 1 },
              { on: 'gamesCeiling', n: 10_000 },
            ],
            transitions: [{ on: 'atEnd', to: 'low', prob: 1 }],
          },
        ],
      },
    },
  };

  it('低確では当選せず、高確移行後に同じ役で当選し、AT 終了で低確に戻る', () => {
    const nav = new NavLayer(modeMachine, 1);
    expect(nav.atMode).toBe('low');

    // 低確: チェリーでは AT に入らない（low の triggers に無い）
    nav.onEvent(eventWith({ flags: ['cherry'] }));
    expect(nav.atActive).toBe(false);

    // スイカで高確へ移行
    nav.onEvent(eventWith({ flags: ['melon'] }));
    expect(nav.atMode).toBe('high');

    // 高確: チェリーで AT 当選（prob 1）
    nav.onEvent(eventWith({ flags: ['cherry'] }));
    expect(nav.atActive).toBe(true);

    // 2G 消化で AT 終了 → atEnd 移行で低確へ
    nav.onEvent(eventWith({ flags: ['replay'] }));
    nav.onEvent(eventWith({ flags: ['replay'] }));
    expect(nav.atActive).toBe(false);
    expect(nav.atMode).toBe('low');
  });

  it('モードはシリアライズ・復元される', () => {
    const nav = new NavLayer(modeMachine, 1);
    nav.onEvent(eventWith({ flags: ['melon'] }));
    expect(nav.atMode).toBe('high');
    const restored = new NavLayer(modeMachine, nav.getState());
    expect(restored.atMode).toBe('high');
  });

  it('プリセット AT 機はモード付きで検証を通り、ナビ追従が機能する', () => {
    expect(validateMachine(atBeast).errors).toEqual([]);
    const naive = simulate(atBeast, { games: 10_000, strategy: 'naive', seed: 11 });
    const follow = simulate(atBeast, { games: 10_000, strategy: 'navFollow', seed: 11 });
    expect(follow.atGames).toBeGreaterThan(0);
    expect(follow.payoutRate).toBeGreaterThan(naive.payoutRate);
  });
});
