import { ControlContext } from './control.js';
import type { ChooseStops } from './game.js';
import { initialState, playGame } from './game.js';
import { Xoshiro128 } from './rng.js';
import type { MachineDef, RoleId, StopEvent } from './types.js';

/**
 * 機械割の実測（docs/design/02-lottery.md「機械割の検証」）。
 * - naive（適当打ち）: 押下位置をランダムに選ぶ
 * - perfect（完全打ち）: 成立役を知る前提で、優先ターゲットの保証/可能を最大化する押下を選ぶ
 * メイン乱数と押下用乱数は別系統（押下戦略が抽選系列を変えないため）。
 */

export type Strategy = 'naive' | 'perfect';

export interface SimOptions {
  games: number;
  strategy: Strategy;
  seed: number;
}

export interface SimResult {
  games: number;
  totalIn: number;
  totalOut: number;
  /** totalOut / totalIn（リプレイは投入 0 として反映） */
  payoutRate: number;
  bonusStarts: Record<RoleId, number>;
  replayCount: number;
}

/** 完全打ち: 各リールで全押下位置を試し、優先ターゲットの達成度が最大の押下を選ぶ */
export function choosePerfect(machine: MachineDef, ctx: ControlContext): {
  order: readonly number[];
  pushes: readonly number[];
} {
  const frames = machine.frames;
  const nReels = machine.strips.length;
  const history: StopEvent[] = [];
  const pushes: number[] = new Array(nReels).fill(0);

  for (let reel = 0; reel < nReels; reel++) {
    let bestPush = 0;
    let bestScore = -1;
    for (let push = 0; push < frames; push++) {
      const slip = ctx.resolveStop(history, reel, push);
      const trial = [...history, { reel, pushPosition: push, stopPosition: (push + slip) % frames }];
      let score = 0;
      for (let i = 0; i < ctx.targets.length; i++) {
        const target = ctx.targets[i]!;
        const rank = ctx.targets.length - i;
        if (ctx.winGuaranteed(target, trial)) {
          score = rank * 2 + 1;
          break;
        }
        if (ctx.winPossible(target, trial)) {
          score = rank * 2;
          break;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestPush = push;
      }
    }
    const slip = ctx.resolveStop(history, reel, bestPush);
    history.push({ reel, pushPosition: bestPush, stopPosition: (bestPush + slip) % frames });
    pushes[reel] = bestPush;
  }

  return { order: [...Array(nReels).keys()], pushes };
}

export function simulate(machine: MachineDef, opts: SimOptions): SimResult {
  const mainRng = new Xoshiro128(opts.seed);
  const playRng = new Xoshiro128(opts.seed ^ 0x5f3759df);
  const ctxCache = new Map<string, ControlContext>();

  const nReels = machine.strips.length;
  const order = [...Array(nReels).keys()];
  const chooseStops: ChooseStops =
    opts.strategy === 'naive'
      ? () => ({ order, pushes: order.map(() => playRng.nextInt(machine.frames)) })
      : (_active, ctx) => choosePerfect(machine, ctx);

  let state = initialState(machine);
  let totalIn = 0;
  let totalOut = 0;
  let replayCount = 0;
  const bonusStarts: Record<RoleId, number> = {};

  for (let i = 0; i < opts.games; i++) {
    const result = playGame(machine, state, chooseStops, mainRng, ctxCache);
    state = result.state;
    const event = result.event;
    totalIn += event.bet;
    totalOut += event.payout;
    if (event.replayWon) replayCount++;
    if (event.bonusStarted !== null) {
      bonusStarts[event.bonusStarted] = (bonusStarts[event.bonusStarted] ?? 0) + 1;
    }
  }

  return {
    games: opts.games,
    totalIn,
    totalOut,
    payoutRate: totalIn > 0 ? totalOut / totalIn : 0,
    bonusStarts,
    replayCount,
  };
}
