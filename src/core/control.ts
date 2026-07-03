import { winsAt } from './judge.js';
import type { FlagSet, MachineDef, RoleId, StopEvent } from './types.js';

/**
 * リール制御（docs/design/03-reel-control.md）。
 *
 * コントロール方式: 押下位置から滑り 0..4 の 5 候補を評価して 1 つ選ぶ。
 * - 蹴飛ばし（非成立役の入賞回避）と成立リプレイの入賞保証は「実行可能性
 *   (feasible)」として先読み再帰で判定する
 * - 引き込みは成立役を優先順に「保証引き込み > 引き込み可能 > 不可」で採点する
 * - 判定は (成立役集合, 各リール停止位置) のみに依存する部分問題なので、
 *   ControlContext がフラグ集合単位でメモ化する（設計上の必須要件）
 *
 * ControlContext は 1 ゲーム（同一フラグ集合）の間使い回す。配列メーカーの
 * 総当たり検証では同一フラグのケース間でもキャッシュが共有される。
 */

const SLIP_MAX = 4;

const UNKNOWN = 0;
const YES = 1;
const NO = 2;

export class ControlError extends Error {}

export class ControlContext {
  readonly machine: MachineDef;
  readonly active: FlagSet;
  /** 引き込み対象の優先順（成立役のみ） */
  readonly targets: readonly RoleId[];

  private readonly nReels: number;
  private readonly base: number; // frames + 1（未停止 = -1 を 0 に写像）
  private readonly stateCount: number;
  private readonly activeReplays: ReadonlySet<RoleId>;
  private readonly feasibleMemo: Int8Array;
  private readonly guaranteedMemo = new Map<RoleId, Int8Array>();
  private readonly possibleMemo = new Map<RoleId, Int8Array>();

  constructor(machine: MachineDef, active: FlagSet) {
    this.machine = machine;
    this.active = active;
    this.nReels = machine.strips.length;
    this.base = machine.frames + 1;
    this.stateCount = this.base ** this.nReels;
    this.feasibleMemo = new Int8Array(this.stateCount);

    const activeRoles = machine.roles.filter((r) => active.has(r.id));
    this.activeReplays = new Set(activeRoles.filter((r) => r.kind === 'replay').map((r) => r.id));

    const replays = activeRoles.filter((r) => r.kind === 'replay');
    const smalls = activeRoles
      .filter((r) => r.kind === 'small')
      .sort((a, b) => b.payout - a.payout);
    const bonuses = activeRoles.filter((r) => r.kind === 'bonus');
    const rest = machine.priority === 'bonus-first' ? [...bonuses, ...smalls] : [...smalls, ...bonuses];
    this.targets = [...replays, ...rest].map((r) => r.id);
  }

  /** 滑りコマ数 0..4 を返す。合法候補ゼロは未検証データの混入（例外） */
  resolveStop(history: readonly StopEvent[], reel: number, pushPosition: number): number {
    const stops = this.stopsFrom(history);
    if (stops[reel] !== -1) throw new ControlError(`reel ${reel} is already stopped`);

    let candidates: number[] = [];
    for (let slip = 0; slip <= SLIP_MAX; slip++) {
      const child = stops.slice();
      child[reel] = (pushPosition + slip) % this.machine.frames;
      if (this.feasible(child)) candidates.push(slip);
    }
    if (candidates.length === 0) {
      throw new ControlError(
        `no legal stop for reel ${reel} at push ${pushPosition} (unvalidated strips?)`,
      );
    }

    for (const target of this.targets) {
      let best = 0;
      const levels = candidates.map((slip) => {
        const child = stops.slice();
        child[reel] = (pushPosition + slip) % this.machine.frames;
        const level = this.guaranteedWin(target, child) ? 2 : this.possibleWin(target, child) ? 1 : 0;
        if (level > best) best = level;
        return level;
      });
      if (best > 0) candidates = candidates.filter((_, i) => levels[i] === best);
    }

    // デフォルト滑り: 最小滑り（出目テーブルはステップ 3 以降の拡張）
    return candidates[0]!;
  }

  /** この履歴から target を（どの押下でも）保証して入賞させられるか（戦略・検証用の公開 API） */
  winGuaranteed(target: RoleId, history: readonly StopEvent[]): boolean {
    return this.guaranteedWin(target, this.stopsFrom(history));
  }

  /** この履歴から押下位置しだいで target を入賞させられるか（戦略・検証用の公開 API） */
  winPossible(target: RoleId, history: readonly StopEvent[]): boolean {
    return this.possibleWin(target, this.stopsFrom(history));
  }

  private stopsFrom(history: readonly StopEvent[]): number[] {
    const stops: number[] = new Array(this.nReels).fill(-1);
    for (const event of history) stops[event.reel] = event.stopPosition;
    return stops;
  }

  private key(stops: readonly number[]): number {
    let key = 0;
    for (let r = 0; r < this.nReels; r++) key = key * this.base + (stops[r]! + 1);
    return key;
  }

  /** 全停止形として合法か: 非成立役が入賞せず、成立リプレイがあれば必ず入賞している */
  private okFinal(stops: readonly number[]): boolean {
    const wins = winsAt(this.machine, stops);
    for (const win of wins) if (!this.active.has(win)) return false;
    if (this.activeReplays.size > 0 && !wins.some((w) => this.activeReplays.has(w))) return false;
    return true;
  }

  /**
   * この停止形から、残りリールをどの順・どの押下位置で押されても
   * 合法な全停止形に到達できるか（蹴飛ばし可能性 + リプレイ保証の先読み）
   */
  private feasible(stops: readonly number[]): boolean {
    const key = this.key(stops);
    const memo = this.feasibleMemo[key]!;
    if (memo !== UNKNOWN) return memo === YES;

    let result: boolean;
    if (!stops.includes(-1)) {
      result = this.okFinal(stops);
    } else {
      result = this.forAllPushesExistsSlip(stops, (child) => this.feasible(child));
    }
    this.feasibleMemo[key] = result ? YES : NO;
    return result;
  }

  /** どの順・どの押下位置でも target を入賞させ続けられるか（保証引き込み） */
  private guaranteedWin(target: RoleId, stops: readonly number[]): boolean {
    let memo = this.guaranteedMemo.get(target);
    if (!memo) {
      memo = new Int8Array(this.stateCount);
      this.guaranteedMemo.set(target, memo);
    }
    const key = this.key(stops);
    if (memo[key] !== UNKNOWN) return memo[key] === YES;

    let result: boolean;
    if (!stops.includes(-1)) {
      result = this.okFinal(stops) && winsAt(this.machine, stops).includes(target);
    } else {
      result = this.forAllPushesExistsSlip(stops, (child) => this.guaranteedWin(target, child));
    }
    memo[key] = result ? YES : NO;
    return result;
  }

  /** 押下位置が協力的なら target を入賞させられるか（引き込み可能性） */
  private possibleWin(target: RoleId, stops: readonly number[]): boolean {
    let memo = this.possibleMemo.get(target);
    if (!memo) {
      memo = new Int8Array(this.stateCount);
      this.possibleMemo.set(target, memo);
    }
    const key = this.key(stops);
    if (memo[key] !== UNKNOWN) return memo[key] === YES;

    let result = false;
    if (!stops.includes(-1)) {
      result = this.okFinal(stops) && winsAt(this.machine, stops).includes(target);
    } else {
      outer: for (let reel = 0; reel < this.nReels; reel++) {
        if (stops[reel] !== -1) continue;
        for (let push = 0; push < this.machine.frames; push++) {
          for (let slip = 0; slip <= SLIP_MAX; slip++) {
            const child = stops.slice();
            child[reel] = (push + slip) % this.machine.frames;
            if (this.feasible(child) && this.possibleWin(target, child)) {
              result = true;
              break outer;
            }
          }
        }
      }
    }
    memo[key] = result ? YES : NO;
    return result;
  }

  /** ∀(未停止リール, 押下位置) ∃滑り: predicate(child) */
  private forAllPushesExistsSlip(
    stops: readonly number[],
    predicate: (child: readonly number[]) => boolean,
  ): boolean {
    for (let reel = 0; reel < this.nReels; reel++) {
      if (stops[reel] !== -1) continue;
      for (let push = 0; push < this.machine.frames; push++) {
        let exists = false;
        for (let slip = 0; slip <= SLIP_MAX; slip++) {
          const child = stops.slice();
          child[reel] = (push + slip) % this.machine.frames;
          if (predicate(child)) {
            exists = true;
            break;
          }
        }
        if (!exists) return false;
      }
    }
    return true;
  }
}
