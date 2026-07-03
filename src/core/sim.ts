import { ControlContext } from './control.js';
import type { GameSession } from './game.js';
import { initialState, playGame } from './game.js';
import { NavLayer } from './nav.js';
import type { Rng } from './rng.js';
import { Xoshiro128 } from './rng.js';
import type { MachineDef, RoleId } from './types.js';

/**
 * 機械割の実測（docs/design/02-lottery.md「機械割の検証」）。
 * - naive（適当打ち）: 常に順押し・押下位置ランダム。ナビ無視
 * - navFollow（ナビ追従）: ナビ層の指示どおり第 1 停止を選ぶが目押しはしない。AT 機の実戦値
 * - perfect（完全打ち）: 成立役を知る前提で、第 1 停止の打ち分けと目押しを最適化
 * メイン乱数と押下用乱数は別系統（押下戦略が抽選系列を変えないため）。
 */

export type StrategyName = 'naive' | 'navFollow' | 'perfect';

export interface SimOptions {
  games: number;
  strategy: StrategyName;
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
  atGames: number;
}

/** 完全打ち: 打ち分けの正解に従い、各リールで全押下位置を試して優先ターゲットの達成度を最大化 */
export function playPerfect(session: GameSession): void {
  const machine = session.machine;
  const frames = machine.frames;
  const nReels = machine.strips.length;

  // 第 1 停止: 成立している打ち分け役の正解リールに従う（完全打ち = フラグを知っている）
  const navRole = session.active
    .map((id) => machine.roles.find((r) => r.id === id))
    .find((r) => r?.nav !== undefined);
  const order = [...Array(nReels).keys()];
  if (navRole?.nav) {
    const first = navRole.nav.correctFirst;
    order.splice(order.indexOf(first), 1);
    order.unshift(first);
  }

  for (const reel of order) {
    const ctx = session.ctx; // 第 1 停止後は打ち分け解決済みのコンテキスト
    let bestPush = 0;
    let bestScore = -1;
    for (let push = 0; push < frames; push++) {
      const slip = ctx.resolveStop(session.stopped, reel, push);
      const trial = [...session.stopped, { reel, pushPosition: push, stopPosition: (push + slip) % frames }];
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
    session.stopReel(reel, bestPush);
  }
}

export function simulate(machine: MachineDef, opts: SimOptions): SimResult {
  const mainRng = new Xoshiro128(opts.seed);
  const playRng = new Xoshiro128(opts.seed ^ 0x5f3759df);
  const ctxCache = new Map<string, ControlContext>();
  const navLayer = machine.nav ? new NavLayer(machine, opts.seed ^ 0x9e3779b9) : null;

  const nReels = machine.strips.length;
  const defaultOrder = [...Array(nReels).keys()];

  const randomStops = (session: GameSession, order: readonly number[]) => {
    for (const reel of order) session.stopReel(reel, playRng.nextInt(machine.frames));
  };

  let state = initialState(machine);
  let totalIn = 0;
  let totalOut = 0;
  let replayCount = 0;
  let atGames = 0;
  const bonusStarts: Record<RoleId, number> = {};

  for (let i = 0; i < opts.games; i++) {
    if (navLayer?.atActive) atGames++;
    const result = playGame(
      machine,
      state,
      (session) => {
        if (opts.strategy === 'perfect') {
          playPerfect(session);
          return;
        }
        let order = defaultOrder;
        if (opts.strategy === 'navFollow') {
          const nav = navLayer?.navFor(session.flags);
          if (nav) {
            order = [nav.correctFirst, ...defaultOrder.filter((r) => r !== nav.correctFirst)];
          }
        }
        randomStops(session, order);
      },
      mainRng,
      ctxCache,
    );
    state = result.state;
    const event = result.event;
    navLayer?.onEvent(event);
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
    atGames,
  };
}
