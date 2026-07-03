import { ControlContext } from './control.js';
import { winsAt } from './judge.js';
import { drawLottery } from './lottery.js';
import type { Rng } from './rng.js';
import type {
  BonusDef,
  EngineState,
  GameEvent,
  LidRelease,
  MachineDef,
  RoleId,
  RtTrigger,
  StopEvent,
  WeightedEntry,
} from './types.js';

/**
 * 1 ゲームの状態機械（docs/design/01-machine-model.md ゲームフロー）。
 *
 * - GameSession: レバー ON（抽選）→ 1 リールずつ停止 → finish（払い出し・遷移）の
 *   インタラクティブ API。UI のオーケストレータはこれを使う
 * - playGame: 停止戦略を渡して 1 ゲームを一括実行する純関数ラッパー
 *   （シミュレーション・テスト用）
 *
 * ナビ層・プレゼン層への GameEvent 配布は呼び出し側の責務。
 */

export type ChooseStops = (
  active: readonly RoleId[],
  ctx: ControlContext,
) => { order: readonly number[]; pushes: readonly number[] };

export function initialState(machine?: MachineDef): EngineState {
  return {
    base: { type: 'normal' },
    rt: null,
    rtGames: 0,
    queue: [],
    lid: false,
    lidReleaseIn: null,
    mode: machine?.carryover.lid?.modes?.initial ?? null,
    pendingRebet: false,
  };
}

/**
 * テーブル解決規則（docs/design/02-lottery.md「基底 + オーバーレイ」）:
 * 1. 役物作動中: tableRef のテーブルを丸ごと使用
 * 2. それ以外: 基底 + RT 修飾（単独役エントリの重み差し替え）+ 内部中修飾
 *    （キュー満杯ならボーナス役をエントリから除去。小役同居は小役のみ残す）
 * TODO: 集中・JAC のテーブル
 */
export function resolveTable(machine: MachineDef, state: EngineState): readonly WeightedEntry[] {
  if (state.base.type === 'bonus') {
    const def = bonusDefOf(machine, state.base.run.bonusId);
    const table = machine.tables[def.tableRef];
    if (!table) throw new Error(`missing table: ${def.tableRef}`);
    return table;
  }

  let table: readonly WeightedEntry[] = machine.lottery.base;

  if (state.rt !== null) {
    const rtDef = machine.rtStates.find((r) => r.id === state.rt);
    if (!rtDef) throw new Error(`missing rt state: ${state.rt}`);
    table = table.map((entry) => {
      const only = entry.roles.length === 1 ? entry.roles[0]! : null;
      const weight = only !== null ? rtDef.replayWeights[only] : undefined;
      return weight !== undefined ? { roles: entry.roles, weight } : entry;
    });
  }

  if (state.queue.length >= machine.carryover.queueLimit) {
    const bonusIds = new Set(machine.bonuses.map((b) => b.id));
    table = table.flatMap((entry) => {
      if (!entry.roles.some((r) => bonusIds.has(r))) return [entry];
      const rest = entry.roles.filter((r) => !bonusIds.has(r));
      return rest.length > 0 ? [{ roles: rest, weight: entry.weight }] : [];
    });
  }

  return table;
}

/** 現在のモードに応じた蓋の解除条件（docs/design/01 軸 4） */
export function currentRelease(machine: MachineDef, state: EngineState): LidRelease | null {
  const lid = machine.carryover.lid;
  if (!lid) return null;
  if (lid.modes) {
    const found = lid.modes.states.find((m) => m.id === state.mode);
    const mode = found ?? lid.modes.states.find((m) => m.id === lid.modes!.initial);
    if (!mode) throw new Error(`missing mode state: ${state.mode ?? lid.modes.initial}`);
    return mode.release;
  }
  if (!lid.release) throw new Error('lid requires either release or modes');
  return lid.release;
}

/** レバー ON から全リール停止・清算までの 1 ゲームセッション */
export class GameSession {
  /** 実際に投入された枚数（再遊技は 0） */
  readonly bet: number;
  /** 当該ゲームの抽選結果（役 ID の集合） */
  readonly flags: readonly RoleId[];
  /** 入賞制御に乗る役集合（成立フラグ + キュー先頭ボーナス） */
  readonly active: readonly RoleId[];
  readonly ctx: ControlContext;

  private readonly machine: MachineDef;
  private readonly s: EngineState;
  private readonly history: StopEvent[] = [];
  private readonly queuedBonus: RoleId | null;
  private lidReleased: boolean;
  private rtEntered: string | null;
  private finished = false;

  constructor(
    machine: MachineDef,
    state: EngineState,
    rng: Rng,
    ctxCache?: Map<string, ControlContext>,
    /** デバッグ・検証用: 内部抽選を上書きする（[] = 強制純ハズレ）。指定時は抽選乱数を消費しない */
    forceFlags?: readonly RoleId[],
  ) {
    this.machine = machine;
    const s = structuredClone(state) as EngineState;
    this.s = s;
    const bonusIds = new Set(machine.bonuses.map((b) => b.id));
    const lidDef = machine.carryover.lid;
    const release = currentRelease(machine, s);

    // --- ベット ---
    this.bet = s.pendingRebet ? 0 : machine.bet;
    s.pendingRebet = false;

    // --- 蓋の解除判定 1: ゲーム数カウントダウン（レバー ON 時。解除ゲームは同ゲームから入賞可能） ---
    this.lidReleased = false;
    if (s.lid && release?.type === 'gameCountTable') {
      s.lidReleaseIn = (s.lidReleaseIn ?? 0) - 1;
      if (s.lidReleaseIn <= 0) {
        s.lid = false;
        s.lidReleaseIn = null;
        this.lidReleased = true;
      }
    }

    // --- 内部抽選 ---
    this.flags = forceFlags ?? drawLottery(resolveTable(machine, s), rng);

    // --- 蓋の解除判定 2: 解除抽選（純ハズレ契機に対応するため抽選結果の後に評価） ---
    if (s.lid && release?.type === 'lottery') {
      const applicable = (release.on ?? 'any') === 'any' || this.flags.length === 0;
      if (applicable && rng.draw16() < release.weight) {
        s.lid = false;
        this.lidReleased = true;
      }
    }
    // roleHit 解除は入賞判定後（finish）に処理

    // --- ボーナス当選をキューへ（docs/design/02 規則 3） ---
    this.queuedBonus = null;
    this.rtEntered = null;
    const drawnBonus = this.flags.find((id) => bonusIds.has(id)) ?? null;
    if (drawnBonus !== null && s.base.type === 'normal' && s.queue.length < machine.carryover.queueLimit) {
      const wasEmpty = s.queue.length === 0;
      s.queue.push(drawnBonus);
      this.queuedBonus = drawnBonus;
      // bonusFlag 契機 = ストックが空→非空になったときのみ。放出中（蓋 off）の上乗せでは掛け直さない
      if (lidDef && lidDef.engageOn.includes('bonusFlag') && wasEmpty && !s.lid && release) {
        engageLid(s, release, rng);
      }
      this.rtEntered = applyRtEntry(machine, s, { queuedBonus: drawnBonus, bonusEnded: null, wins: [] });
    }

    // --- 入賞制御に乗る役集合 = 当該ゲームの小役・リプレイ + キュー先頭（蓋 off 時） ---
    const active = new Set(this.flags.filter((id) => !bonusIds.has(id)));
    if (s.base.type === 'normal' && !s.lid && s.queue.length > 0) active.add(s.queue[0]!);
    this.active = [...active];

    const activeKey = this.active.slice().sort().join(',');
    let ctx = ctxCache?.get(activeKey);
    if (!ctx) {
      ctx = new ControlContext(machine, active);
      ctxCache?.set(activeKey, ctx);
    }
    this.ctx = ctx;
  }

  get stopped(): readonly StopEvent[] {
    return this.history;
  }

  get isComplete(): boolean {
    return this.history.length === this.machine.strips.length;
  }

  /** リールを 1 本停止する。リール制御が滑りを決め、停止イベントを返す */
  stopReel(reel: number, pushPosition: number): StopEvent {
    if (this.finished) throw new Error('session already finished');
    if (this.history.some((e) => e.reel === reel)) throw new Error(`reel ${reel} already stopped`);
    const slip = this.ctx.resolveStop(this.history, reel, pushPosition);
    const event: StopEvent = {
      reel,
      pushPosition,
      stopPosition: (pushPosition + slip) % this.machine.frames,
    };
    this.history.push(event);
    return event;
  }

  /** 全リール停止後の清算と状態遷移。GameEvent を発行する（モード移行・蓋掛け直しの抽選に rng を使う） */
  finish(rng: Rng): { state: EngineState; event: GameEvent } {
    if (this.finished) throw new Error('session already finished');
    if (!this.isComplete) throw new Error('not all reels are stopped');
    this.finished = true;

    const machine = this.machine;
    const s = this.s;
    const bonusIds = new Set(machine.bonuses.map((b) => b.id));
    const lidDef = machine.carryover.lid;

    const stops: number[] = new Array(machine.strips.length).fill(0);
    for (const event of this.history) stops[event.reel] = event.stopPosition;

    // --- 入賞判定・払い出し ---
    const wins = winsAt(machine, stops);
    const rolesById = new Map(machine.roles.map((r) => [r.id, r]));
    let payout = 0;
    let replayWon = false;
    for (const win of wins) {
      const role = rolesById.get(win)!;
      payout += role.payout;
      if (role.kind === 'replay') replayWon = true;
    }
    s.pendingRebet = replayWon;

    // --- 蓋の roleHit 解除 ---
    const releaseAtWin = currentRelease(machine, s);
    if (s.lid && releaseAtWin?.type === 'roleHit' && wins.includes(releaseAtWin.of)) {
      s.lid = false;
      this.lidReleased = true;
    }

    // --- 役物の開始・進行・終了 ---
    let bonusStarted: RoleId | null = null;
    let bonusEnded: RoleId | null = null;
    let modeChanged: string | null = null;
    const wonBonus = wins.find((id) => bonusIds.has(id)) ?? null;
    if (wonBonus !== null) {
      // キュー先頭の入賞 = 放出。RT はボーナス作動でリセット
      s.queue.shift();
      s.base = { type: 'bonus', run: { bonusId: wonBonus, gamesPlayed: 0, totalPayout: 0, wins: 0 } };
      s.rt = null;
      s.rtGames = 0;
      bonusStarted = wonBonus;
    } else if (s.base.type === 'bonus') {
      const run = s.base.run;
      run.gamesPlayed += 1;
      run.totalPayout += payout;
      if (wins.length > 0) run.wins += 1;
      const def = bonusDefOf(machine, run.bonusId);
      if (bonusRunEnded(def, run)) {
        s.base = { type: 'normal' };
        bonusEnded = run.bonusId;

        // --- モード移行（ボーナス終了時。新モードの解除テーブルで掛け直すため先に評価） ---
        if (lidDef?.modes) {
          const current = lidDef.modes.states.find((m) => m.id === s.mode);
          if (current?.onBonusEnd && current.onBonusEnd.length > 0) {
            const next = drawWeighted(current.onBonusEnd, rng).to;
            if (next !== s.mode) {
              s.mode = next;
              modeChanged = next;
            }
          }
        }

        // --- 蓋の掛け直し（bonusEnd 契機・キュー非空時） ---
        if (lidDef && lidDef.engageOn.includes('bonusEnd') && s.queue.length > 0) {
          const release = currentRelease(machine, s);
          if (release) engageLid(s, release, rng);
        }
      }
    }

    // --- RT 遷移（exit → entry の順で評価） ---
    let rtExited: string | null = null;
    if (s.rt !== null) {
      s.rtGames += 1;
      const rtDef = machine.rtStates.find((r) => r.id === s.rt)!;
      if (rtDef.exit.some((t) => matchTrigger(t, { queuedBonus: this.queuedBonus, bonusEnded, wins }, s.rtGames))) {
        rtExited = s.rt;
        s.rt = null;
        s.rtGames = 0;
      }
    }
    this.rtEntered =
      applyRtEntry(machine, s, { queuedBonus: this.queuedBonus, bonusEnded, wins }) ?? this.rtEntered;

    return {
      state: s,
      event: {
        bet: this.bet,
        flags: this.flags,
        queuedBonus: this.queuedBonus,
        stops,
        wins,
        payout,
        replayWon,
        bonusStarted,
        bonusEnded,
        rtEntered: this.rtEntered,
        rtExited,
        lidReleased: this.lidReleased,
        modeChanged,
      },
    };
  }
}

export function playGame(
  machine: MachineDef,
  state: EngineState,
  chooseStops: ChooseStops,
  rng: Rng,
  /** 同一フラグ集合の ControlContext を跨ゲームで再利用するキャッシュ（シミュレーション高速化） */
  ctxCache?: Map<string, ControlContext>,
): { state: EngineState; event: GameEvent } {
  const session = new GameSession(machine, state, rng, ctxCache);
  const { order, pushes } = chooseStops(session.active, session.ctx);
  for (const reel of order) session.stopReel(reel, pushes[reel]!);
  return session.finish(rng);
}

function bonusDefOf(machine: MachineDef, id: RoleId): BonusDef {
  const def = machine.bonuses.find((b) => b.id === id);
  if (!def) throw new Error(`missing bonus def: ${id}`);
  return def;
}

function bonusRunEnded(def: BonusDef, run: { gamesPlayed: number; totalPayout: number; wins: number }): boolean {
  if (def.kind === 'sb') return true; // SB は 1 ゲームで終了
  const end = def.end;
  if (end.games !== undefined && run.gamesPlayed >= end.games) return true;
  if (end.wins !== undefined && run.wins >= end.wins) return true;
  if (end.maxPayout !== undefined && run.totalPayout >= end.maxPayout) return true;
  return false;
}

interface TriggerContext {
  queuedBonus: RoleId | null;
  bonusEnded: RoleId | null;
  wins: readonly RoleId[];
}

function matchTrigger(trigger: RtTrigger, ctx: TriggerContext, rtGames: number): boolean {
  switch (trigger.on) {
    case 'bonusEnd':
      return ctx.bonusEnded !== null && (trigger.of === undefined || trigger.of === ctx.bonusEnded);
    case 'roleHit':
      return ctx.wins.includes(trigger.of);
    case 'games':
      return rtGames >= trigger.n;
    case 'bonusFlag':
      return ctx.queuedBonus !== null && (trigger.of === undefined || trigger.of === ctx.queuedBonus);
  }
}

/** entry 条件に合う最初の RT 状態へ入る（役物作動中は入らない） */
function applyRtEntry(machine: MachineDef, s: EngineState, ctx: TriggerContext): string | null {
  if (s.base.type === 'bonus') return null;
  for (const rtDef of machine.rtStates) {
    if (rtDef.id === s.rt) continue;
    if (rtDef.entry.some((t) => matchTrigger(t, ctx, 0))) {
      s.rt = rtDef.id;
      s.rtGames = 0;
      return rtDef.id;
    }
  }
  return null;
}

function drawWeighted<T extends { weight: number }>(rows: readonly T[], rng: Rng): T {
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  let value = rng.nextInt(total);
  for (const row of rows) {
    value -= row.weight;
    if (value < 0) return row;
  }
  return rows[rows.length - 1]!;
}

/** 蓋を掛ける。gameCountTable は解除ゲーム数をその場で抽選（0 以下 = 即放出可能なので掛けない） */
function engageLid(s: EngineState, release: LidRelease, rng: Rng): void {
  if (release.type === 'gameCountTable') {
    const games = drawWeighted(release.table, rng).games;
    if (games <= 0) return;
    s.lid = true;
    s.lidReleaseIn = games;
  } else {
    s.lid = true;
    s.lidReleaseIn = null;
  }
}
