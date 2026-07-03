import { estimateSpec, mergedBaseTable } from './spec.js';
import type { EstimateOptions } from './spec.js';
import type { MachineDef, WeightedEntry } from './types.js';

/**
 * 逆算ソルバー: 「目標機械割 → 重み」。
 * 通常時テーブルのいちばん素直なつまみ（押し順なしの PB=1 小役 = 共通ベル相当）を
 * 二分探索して、理論機械割（適当打ち）を目標値に合わせる。
 * 理論値は重みについて単調増加なので二分探索で確実に収束する。
 * 設定オーバーレイに同じ役の上書きがある場合は比率を保ってスケールし、設定差の形を崩さない。
 */

export interface SolveOptions {
  /** 目標の理論機械割（適当打ち）。例: 0.72 */
  target: number;
  /** 対象の設定（既定 1） */
  setting?: number;
  estimate?: EstimateOptions;
}

export interface SolveResult {
  machine: MachineDef;
  /** 実際に到達した理論機械割 */
  achieved: number;
  target: number;
  /** 調整したエントリのラベル（例: "bell"） */
  knob: string;
  /** 重みが可動域の端に張り付いた（目標に届かなかった） */
  clamped: boolean;
}

/** 調整に使うエントリ: 単独役・小役・PB=1・押し順なしのうち重みが最大のもの */
export function findTuningKnob(machine: MachineDef): number {
  const byId = new Map(machine.roles.map((r) => [r.id, r]));
  let best = -1;
  let bestWeight = -1;
  machine.lottery.base.forEach((entry, i) => {
    if (entry.roles.length !== 1) return;
    const role = byId.get(entry.roles[0]!);
    if (!role || role.kind !== 'small' || role.pullIn !== 'guaranteed' || role.nav) return;
    if (entry.weight > bestWeight) {
      bestWeight = entry.weight;
      best = i;
    }
  });
  if (best >= 0) return best;
  // フォールバック: 単独小役エントリの最大
  machine.lottery.base.forEach((entry, i) => {
    if (entry.roles.length !== 1) return;
    const role = byId.get(entry.roles[0]!);
    if (!role || role.kind !== 'small') return;
    if (entry.weight > bestWeight) {
      bestWeight = entry.weight;
      best = i;
    }
  });
  return best;
}

/** knob エントリの重みを newWeight にした機種（設定オーバーレイも比率スケール） */
function withKnobWeight(machine: MachineDef, knobIndex: number, newWeight: number): MachineDef {
  const entry = machine.lottery.base[knobIndex]!;
  const key = [...entry.roles].sort().join(',');
  const ratio = entry.weight > 0 ? newWeight / entry.weight : 1;
  const overrides = machine.lottery.settingOverrides
    ? Object.fromEntries(
        Object.entries(machine.lottery.settingOverrides).map(([s, list]) => [
          s,
          list.map((e) =>
            [...e.roles].sort().join(',') === key
              ? { roles: e.roles, weight: Math.max(1, Math.round(e.weight * ratio)) }
              : e,
          ),
        ]),
      )
    : undefined;
  const { settingOverrides: _o, ...lotteryRest } = machine.lottery;
  return {
    ...machine,
    lottery: {
      ...lotteryRest,
      base: machine.lottery.base.map((e, i) => (i === knobIndex ? { roles: e.roles, weight: newWeight } : e)),
      ...(overrides ? { settingOverrides: overrides } : {}),
    },
  };
}

/** 全設定の合成テーブルで重み合計が 65536 を超えない knob の上限を求める */
function knobUpperBound(machine: MachineDef, knobIndex: number): number {
  const entry = machine.lottery.base[knobIndex]!;
  const key = [...entry.roles].sort().join(',');
  const settings = machine.lottery.settings ?? 1;
  let bound = Infinity;
  for (let s = 1; s <= settings; s++) {
    const table = mergedBaseTable(machine, s);
    const total = table.reduce((sum: number, e: WeightedEntry) => sum + e.weight, 0);
    const current = table.find((e) => [...e.roles].sort().join(',') === key)?.weight ?? entry.weight;
    // この設定での knob の実重み + 空き（オーバーレイは比率スケールなので base 換算に戻す）
    const slack = 65536 - total;
    const ratioToBase = current > 0 ? entry.weight / current : 1;
    bound = Math.min(bound, entry.weight + Math.floor(slack * ratioToBase));
  }
  return Math.max(200, bound);
}

export function solveTargetRate(machine: MachineDef, opts: SolveOptions): SolveResult {
  const setting = opts.setting ?? 1;
  const estimateOpts = opts.estimate ?? {};
  const knobIndex = findTuningKnob(machine);
  if (knobIndex < 0) {
    const est = estimateSpec(machine, setting, estimateOpts);
    return { machine, achieved: est.naive, target: opts.target, knob: '（調整可能な小役なし）', clamped: true };
  }
  const knob = machine.lottery.base[knobIndex]!.roles.join('+');

  const rateAt = (w: number): number =>
    estimateSpec(withKnobWeight(machine, knobIndex, Math.round(w)), setting, estimateOpts).naive;

  let lo = 200;
  let hi = knobUpperBound(machine, knobIndex);
  let clamped = false;
  if (rateAt(hi) < opts.target) {
    lo = hi;
    clamped = true;
  } else if (rateAt(lo) > opts.target) {
    hi = lo;
    clamped = true;
  } else {
    for (let i = 0; i < 40 && hi - lo > 1; i++) {
      const mid = (lo + hi) / 2;
      if (rateAt(mid) < opts.target) lo = mid;
      else hi = mid;
    }
  }
  const weight = Math.round(hi);
  const solved = withKnobWeight(machine, knobIndex, weight);
  const achieved = estimateSpec(solved, setting, estimateOpts).naive;
  return { machine: solved, achieved, target: opts.target, knob, clamped };
}
