import { initialState, resolveTable } from './game.js';
import type { LidRelease, MachineDef, RoleDef, RoleId, WeightedEntry } from './types.js';

/**
 * 機種定義からの理論スペック近似計算（エディタのライブフィードバック用）。
 *
 * simulate（実測）と違い抽選テーブルとボーナス仕様から代数的に即時計算するため、
 * スライダー操作のたびに呼べる。以下を単純化した近似であり、確定値は実測が正:
 * - ボーナスの取りこぼし待ち・蓋・キュー詰まりはスループット係数として近似
 *   （opts.measuredPullIn に checkLayout の実測引き込み率を渡すと精度が上がる）
 * - RT はボーナス終了契機 + ゲーム数転落のもののみ近似計上
 * - 完全打ちは「目押し可能役は全て取得・打ち分けは常に正解」と仮定
 */

export type SpecStrategyName = 'naive' | 'perfect';

export interface RoleProbRow {
  roles: readonly RoleId[];
  weight: number;
  /** 当選確率（0〜1） */
  p: number;
  /** 「1/N」の N（p=0 なら Infinity） */
  oneIn: number;
}

export interface BonusSpecRow {
  id: RoleId;
  kind: 'bb' | 'rb' | 'sb';
  /** フラグ確率（重複当選含む） */
  p: number;
  oneIn: number;
  /** 期待消化ゲーム数 */
  expectedGames: number;
  /** 期待獲得枚数（払い出し合計。投入は引かない）: 適当打ち */
  expectedMedalsNaive: number;
  /** 同: 完全打ち */
  expectedMedalsPerfect: number;
}

export interface SpecEstimate {
  setting: number;
  /** 理論機械割（out/in）: 適当打ち */
  naive: number;
  /** 理論機械割: 完全打ち */
  perfect: number;
  /** ハズレ確率 */
  missP: number;
  bonuses: readonly BonusSpecRow[];
  /** 通常時テーブル（設定オーバーレイ適用後） */
  table: readonly RoleProbRow[];
}

export interface SensitivityRow {
  /** 人間向けラベル（例: 「ベル の重み +500」） */
  label: string;
  /** 機械割の変化（ポイント。+0.023 = +2.3pt）: 適当打ち */
  dNaive: number;
  /** 同: 完全打ち */
  dPerfect: number;
}

const DENOM = 65536;

/** 設定オーバーレイ適用後の通常時テーブル */
export function mergedBaseTable(machine: MachineDef, setting: number): readonly WeightedEntry[] {
  return resolveTable(machine, initialState(machine, setting));
}

export function toProbRows(table: readonly WeightedEntry[]): RoleProbRow[] {
  return table.map((e) => {
    const p = e.weight / DENOM;
    return { roles: e.roles, weight: e.weight, p, oneIn: p > 0 ? 1 / p : Infinity };
  });
}

function rolesById(machine: MachineDef): Map<RoleId, RoleDef> {
  return new Map(machine.roles.map((r) => [r.id, r]));
}

export interface EstimateOptions {
  /** checkLayout の実測引き込み率（役 ID → 単独成立時の適当打ち入賞率）。宣言値より正確 */
  measuredPullIn?: Record<RoleId, number>;
}

/** 単独成立時の入賞率（適当打ち）。実測値があればそちらを使う */
function naiveHitRate(role: RoleDef, opts: EstimateOptions): number {
  const measured = opts.measuredPullIn?.[role.id];
  if (measured !== undefined && measured > 0) return measured;
  return role.pullIn === 'guaranteed' ? 1 : role.pullIn.missable.targetRate;
}

/**
 * 役 1 回成立あたりの期待払い出し。
 * 打ち分け役（押し順ベル等）は適当打ちで 1/リール数 の正解率、
 * 不正解時は onMiss の減額役（またはゼロ）とする。
 */
function rolePayoutEv(machine: MachineDef, role: RoleDef, strategy: SpecStrategyName, opts: EstimateOptions): number {
  const byId = rolesById(machine);
  if (role.nav) {
    if (strategy === 'perfect') return role.payout;
    const nReels = machine.strips.length;
    const correct = role.payout / nReels;
    const missRole = role.nav.onMiss.type === 'reduced' ? byId.get(role.nav.onMiss.roleRef) : undefined;
    const missPayout = missRole ? missRole.payout * naiveHitRate(missRole, opts) : 0;
    return correct + (missPayout * (nReels - 1)) / nReels;
  }
  const hit = strategy === 'perfect' ? 1 : naiveHitRate(role, opts);
  return role.payout * hit;
}

interface TableEv {
  /** 1 ゲームあたり期待払い出し（ボーナス役の直接払い出しを除く） */
  out: number;
  /** リプレイ入賞確率（次ゲーム投入 0） */
  pReplay: number;
  /** 何かしら入賞する確率（RB の wins 終了条件用） */
  pWin: number;
}

function tableEv(
  machine: MachineDef,
  table: readonly WeightedEntry[],
  strategy: SpecStrategyName,
  opts: EstimateOptions,
): TableEv {
  const byId = rolesById(machine);
  const bonusIds = new Set(machine.bonuses.map((b) => b.id));
  let out = 0;
  let pReplay = 0;
  let pWin = 0;
  for (const entry of table) {
    const p = entry.weight / DENOM;
    let entryWinP = 0;
    for (const id of entry.roles) {
      const role = byId.get(id);
      if (!role || bonusIds.has(id)) continue; // ボーナス役の直接払い出しは別計上
      out += p * rolePayoutEv(machine, role, strategy, opts);
      const hit = strategy === 'perfect' ? 1 : naiveHitRate(role, opts);
      entryWinP = Math.max(entryWinP, hit);
      if (role.kind === 'replay') pReplay += p * hit;
    }
    pWin += p * entryWinP;
  }
  return { out, pReplay, pWin };
}

/** ボーナス 1 回あたりの期待消化ゲーム数と 1 ゲームあたり払い出し */
function bonusRunEv(
  machine: MachineDef,
  bonusId: RoleId,
  strategy: SpecStrategyName,
  opts: EstimateOptions,
): { games: number; outPerGame: number; pReplay: number } {
  const def = machine.bonuses.find((b) => b.id === bonusId)!;
  const table = machine.tables[def.tableRef] ?? [];
  const ev = tableEv(machine, table, strategy, opts);
  if (def.kind === 'sb') return { games: 1, outPerGame: ev.out, pReplay: ev.pReplay };
  const candidates: number[] = [];
  if (def.end.games !== undefined) candidates.push(def.end.games);
  if (def.end.wins !== undefined && ev.pWin > 0) candidates.push(def.end.wins / ev.pWin);
  if (def.end.maxPayout !== undefined && ev.out > 0) candidates.push(def.end.maxPayout / ev.out);
  const games = candidates.length > 0 ? Math.min(...candidates) : 1;
  return { games, outPerGame: ev.out, pReplay: ev.pReplay };
}

/** 蓋が 1 回掛かったときの期待ブロックゲーム数（解除条件の期待値） */
function expectedLidGames(machine: MachineDef, release: LidRelease, missP: number): number {
  switch (release.type) {
    case 'gameCountTable': {
      const total = release.table.reduce((s, r) => s + r.weight, 0);
      if (total <= 0) return 0;
      return release.table.reduce((s, r) => s + (r.games * r.weight) / total, 0);
    }
    case 'lottery': {
      const applicable = (release.on ?? 'any') === 'pureMiss' ? missP : 1;
      const p = (release.weight / DENOM) * applicable;
      return p > 0 ? 1 / p : 0;
    }
    case 'roleHit':
      return 0; // 役の出現率に依存。まれな構成なので 0 近似
  }
}

/** モード付き蓋の定常分布込みの期待ブロックゲーム数 */
function meanLidGames(machine: MachineDef, missP: number): number {
  const lid = machine.carryover.lid;
  if (!lid) return 0;
  if (lid.release) return expectedLidGames(machine, lid.release, missP);
  if (!lid.modes) return 0;
  const states = lid.modes.states;
  // onBonusEnd の遷移行列を反復して定常分布を出す（状態数は少ないので素朴でよい）
  let dist = new Map<string, number>(states.map((s) => [s.id, s.id === lid.modes!.initial ? 1 : 0]));
  for (let iter = 0; iter < 100; iter++) {
    const next = new Map<string, number>(states.map((s) => [s.id, 0]));
    for (const state of states) {
      const mass = dist.get(state.id) ?? 0;
      const rows = state.onBonusEnd ?? [];
      const total = rows.reduce((s, r) => s + r.weight, 0);
      if (total <= 0) {
        next.set(state.id, (next.get(state.id) ?? 0) + mass);
        continue;
      }
      for (const row of rows) next.set(row.to, (next.get(row.to) ?? 0) + (mass * row.weight) / total);
    }
    dist = next;
  }
  return states.reduce(
    (sum, s) => sum + (dist.get(s.id) ?? 0) * expectedLidGames(machine, s.release, missP),
    0,
  );
}

/**
 * ボーナス消化スループット係数 f（0〜1）。
 * 適当打ちはボーナス図柄を狙えず平均 W ゲーム外し続けるため、
 * 内部中ブロック（queueLimit=1）や蓋の掛け直しで実効ボーナス頻度が落ちる。その近似。
 */
function bonusThroughput(
  machine: MachineDef,
  lambda: ReadonlyMap<RoleId, number>,
  missP: number,
  strategy: SpecStrategyName,
  opts: EstimateOptions,
): number {
  const byId = rolesById(machine);
  let lambdaTotal = 0;
  let waitSum = 0;
  for (const [id, p] of lambda) {
    const role = byId.get(id);
    if (!role) continue;
    const hit = strategy === 'perfect' ? 1 : naiveHitRate(role, opts);
    const wait = hit > 0 ? 1 / hit - 1 : 0;
    lambdaTotal += p;
    waitSum += p * wait;
  }
  if (lambdaTotal <= 0) return 1;
  const meanWait = waitSum / lambdaTotal;
  if (machine.carryover.queueLimit <= 1) {
    // 内部中は新規ボーナスが引けない → 実効頻度 λ/(1+λW)
    return 1 / (1 + lambdaTotal * meanWait);
  }
  // ストック機: 1 個消化するごとに（bonusEnd 契機なら）蓋 + 取りこぼし待ちがかかる
  const lid = machine.carryover.lid;
  const lidPerCycle = lid?.engageOn.includes('bonusEnd') ? meanLidGames(machine, missP) : 0;
  const cycle = meanWait + lidPerCycle;
  if (cycle <= 0) return 1;
  return Math.min(1, 1 / cycle / lambdaTotal);
}

/** 機種定義から理論スペックを近似計算する（即時） */
export function estimateSpec(machine: MachineDef, setting = 1, opts: EstimateOptions = {}): SpecEstimate {
  const table = mergedBaseTable(machine, setting);
  const rows = toProbRows(table);
  const byId = rolesById(machine);
  const bonusIds = new Set(machine.bonuses.map((b) => b.id));
  const bet = machine.bet;

  // ボーナスのフラグ確率 λ（重複当選エントリ含む）
  const lambda = new Map<RoleId, number>();
  for (const row of rows) {
    for (const id of row.roles) {
      if (bonusIds.has(id)) lambda.set(id, (lambda.get(id) ?? 0) + row.p);
    }
  }

  const totalWeightAll = table.reduce((sum, e) => sum + e.weight, 0);
  const missPAll = Math.max(0, (DENOM - totalWeightAll) / DENOM);

  const compute = (strategy: SpecStrategyName): { rate: number; bonuses: BonusSpecRow[] } => {
    const normal = tableEv(machine, table, strategy, opts);
    // 消化スループット補正を掛けた実効ボーナス頻度
    const throughput = bonusThroughput(machine, lambda, missPAll, strategy, opts);
    const lambdaEff = new Map([...lambda].map(([id, p]) => [id, p * throughput]));

    // RT 近似: bonusEnd 契機 + games 契機の exit を持つ RT のみ計上
    // （非ボーナスゲームのうち rt にいる割合 rho を求め、リプレイ確率と小役期待値を混合）
    let rtGamesPerNormalGame = 0;
    let rtOut = normal.out;
    let rtReplay = normal.pReplay;
    for (const rt of machine.rtStates) {
      const entryBonusEnd = rt.entry.find((t) => t.on === 'bonusEnd');
      const exitGames = rt.exit.find((t) => t.on === 'games');
      if (!entryBonusEnd || !exitGames || exitGames.on !== 'games') continue;
      const sources = entryBonusEnd.of !== undefined ? [entryBonusEnd.of] : [...lambdaEff.keys()];
      const enterP = sources.reduce((sum, id) => sum + (lambdaEff.get(id) ?? 0), 0);
      const n = exitGames.n;
      rtGamesPerNormalGame += enterP * n;
      const rtTable = table.map((e) => {
        const only = e.roles.length === 1 ? e.roles[0]! : null;
        const w = only !== null ? rt.replayWeights[only] : undefined;
        return w !== undefined ? { roles: e.roles, weight: w } : e;
      });
      const ev = tableEv(machine, rtTable, strategy, opts);
      rtOut = ev.out;
      rtReplay = ev.pReplay;
    }
    const rho = Math.min(0.9, rtGamesPerNormalGame / (1 + rtGamesPerNormalGame));
    const nonBonusOut = (1 - rho) * normal.out + rho * rtOut;
    const nonBonusReplay = (1 - rho) * normal.pReplay + rho * rtReplay;

    // 1 非ボーナスゲームあたり: ボーナスゲーム数 B・払い出し・投入
    let bonusGames = 0;
    let bonusOut = 0;
    let bonusIn = 0;
    const bonusRows: BonusSpecRow[] = [];
    for (const def of machine.bonuses) {
      const pFlag = lambda.get(def.id) ?? 0;
      const p = lambdaEff.get(def.id) ?? 0;
      const run = bonusRunEv(machine, def.id, strategy, opts);
      const direct = byId.get(def.id)?.payout ?? 0; // SB の揃った瞬間の直接払い出し等
      bonusGames += p * run.games;
      bonusOut += p * (run.games * run.outPerGame + direct);
      bonusIn += p * run.games * bet * (1 - run.pReplay);
      bonusRows.push({
        id: def.id,
        kind: def.kind,
        p: pFlag,
        oneIn: pFlag > 0 ? 1 / pFlag : Infinity,
        expectedGames: run.games,
        expectedMedalsNaive: 0, // 後で両戦略まとめて詰める
        expectedMedalsPerfect: 0,
      });
    }

    const totalOut = nonBonusOut + bonusOut;
    const totalIn = bet * (1 - nonBonusReplay) + bonusIn;
    return { rate: totalIn > 0 ? totalOut / totalIn : 0, bonuses: bonusRows };
  };

  const naive = compute('naive');
  const perfect = compute('perfect');

  const bonuses: BonusSpecRow[] = naive.bonuses.map((row) => {
    const n = bonusRunEv(machine, row.id, 'naive', opts);
    const p = bonusRunEv(machine, row.id, 'perfect', opts);
    const direct = byId.get(row.id)?.payout ?? 0;
    return {
      ...row,
      expectedMedalsNaive: n.games * n.outPerGame + direct,
      expectedMedalsPerfect: p.games * p.outPerGame + direct,
    };
  });

  return {
    setting,
    naive: naive.rate,
    perfect: perfect.rate,
    missP: missPAll,
    bonuses,
    table: rows,
  };
}

/**
 * 感度分析: 「どのつまみをどっちに回すと機械割がどう動くか」。
 * 通常時テーブルの各エントリ +500、各ボーナスの消化ゲーム数 +5 を試し、
 * 機械割の変化量（ポイント）が大きい順に返す。理論値ベースなので即時。
 */
export function analyzeSensitivity(machine: MachineDef, setting = 1, opts: EstimateOptions = {}): SensitivityRow[] {
  const baseline = estimateSpec(machine, setting, opts);
  const rows: SensitivityRow[] = [];

  const table = mergedBaseTable(machine, setting);
  const { settingOverrides: _overrides, ...lotteryRest } = machine.lottery;
  table.forEach((entry, index) => {
    const patched: MachineDef = {
      ...machine,
      lottery: {
        ...lotteryRest,
        base: table.map((e, i) => (i === index ? { roles: e.roles, weight: e.weight + 500 } : e)),
      },
    };
    const est = estimateSpec(patched, 1, opts);
    rows.push({
      label: `${entry.roles.join('+')} の重み +500`,
      dNaive: est.naive - baseline.naive,
      dPerfect: est.perfect - baseline.perfect,
    });
  });

  for (const def of machine.bonuses) {
    if (def.kind === 'sb' || def.end.games === undefined) continue;
    const patched: MachineDef = {
      ...machine,
      bonuses: machine.bonuses.map((b) =>
        b.id === def.id ? { ...b, end: { ...b.end, games: (b.end.games ?? 0) + 5 } } : b,
      ),
    };
    const est = estimateSpec(patched, setting, opts);
    rows.push({
      label: `${def.id} の消化ゲーム数 +5`,
      dNaive: est.naive - baseline.naive,
      dPerfect: est.perfect - baseline.perfect,
    });
  }

  return rows.sort((a, b) => Math.abs(b.dNaive) - Math.abs(a.dNaive));
}

/** 「1/N」表記（p=0 は —） */
export function formatOneIn(p: number): string {
  if (p <= 0) return '—';
  const n = 1 / p;
  return n >= 100 ? `1/${n.toFixed(0)}` : `1/${n.toFixed(1)}`;
}

/** 「12.3%」表記 */
export function formatPct(v: number, digits = 1): string {
  return `${(v * 100).toFixed(digits)}%`;
}
