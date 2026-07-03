import { simulate } from './sim.js';
import type { MachineDef } from './types.js';

/**
 * 型式試験（試射試験）風の適合チェック。
 * 保通協の出玉率基準を近似的に検査する教材機能（実際の試験手続きの再現ではない）:
 *
 * - 4号機基準: 400G < 300% / 6000G < 150% / 17500G 60%〜120%
 * - 5号機基準: 400G < 220% / 6000G < 150% / 17500G 55%〜120%
 *   （5号機で追加された「獲得最大優先で揃えるシミュレーション試験」は完全打ちに相当）
 *
 * 実装上の単純化（ドキュメント化された近似）:
 * - 「任意の区間」ではなく、初期状態からの独立試行ウィンドウで測る
 * - 上限判定は完全打ち試行の最大値、下限判定は適当打ち試行の最小値で行う
 *   （試験の1回試射に対し、こちらは複数試行の最悪値 = 保守的な判定）
 */

export type RulesetId = 'yon' | 'go';

export interface SpanRule {
  games: number;
  min: number | undefined;
  max: number | undefined;
}

export interface Ruleset {
  id: RulesetId;
  label: string;
  spans: readonly SpanRule[];
}

export const RULESETS: Record<RulesetId, Ruleset> = {
  yon: {
    id: 'yon',
    label: '4号機基準',
    spans: [
      { games: 400, min: undefined, max: 3.0 },
      { games: 6000, min: undefined, max: 1.5 },
      { games: 17500, min: 0.6, max: 1.2 },
    ],
  },
  go: {
    id: 'go',
    label: '5号機基準',
    spans: [
      { games: 400, min: undefined, max: 2.2 },
      { games: 6000, min: undefined, max: 1.5 },
      { games: 17500, min: 0.55, max: 1.2 },
    ],
  },
};

const TRIALS: Record<'quick' | 'standard', Record<number, number>> = {
  quick: { 400: 30, 6000: 8, 17500: 3 },
  standard: { 400: 100, 6000: 20, 17500: 6 },
};

export interface StrategyStats {
  mean: number;
  min: number;
  max: number;
  trials: number;
}

export interface ComplianceSpanResult {
  games: number;
  min: number | undefined;
  max: number | undefined;
  naive: StrategyStats;
  perfect: StrategyStats;
  pass: boolean;
}

export interface ComplianceResult {
  ruleset: RulesetId;
  setting: number;
  spans: ComplianceSpanResult[];
  pass: boolean;
}

export interface ComplianceOptions {
  ruleset?: RulesetId;
  setting?: number;
  mode?: 'quick' | 'standard';
  seed?: number;
  /** テスト用: 区間ゲーム数 → 試行回数の上書き */
  trialsOverride?: Record<number, number>;
}

/** 1 試行ぶんのシミュレーションタスク（試行同士は独立 = 並列実行できる） */
export interface ComplianceTask {
  spanIndex: number;
  strategy: 'naive' | 'perfect';
  games: number;
  seed: number;
  setting: number;
}

/** 試行計画。tasks を（順不同で）実行し assembleCompliance に渡すと判定になる */
export interface CompliancePlan {
  rulesetId: RulesetId;
  setting: number;
  tasks: ComplianceTask[];
}

/**
 * 試行計画を立てる。シードはタスクごとに決定論的に割り当てるので、
 * 逐次実行でも Worker 並列でも結果は完全に一致する。
 */
export function planCompliance(opts: ComplianceOptions = {}): CompliancePlan {
  const ruleset = RULESETS[opts.ruleset ?? 'yon'];
  const setting = opts.setting ?? 1;
  const mode = opts.mode ?? 'quick';
  const seed = opts.seed ?? 1;

  const tasks: ComplianceTask[] = [];
  ruleset.spans.forEach((rule, i) => {
    const trials = opts.trialsOverride?.[rule.games] ?? TRIALS[mode][rule.games] ?? 3;
    for (const strategy of ['naive', 'perfect'] as const) {
      const seedBase = seed + i * 104729 + (strategy === 'perfect' ? 31337 : 0);
      for (let t = 0; t < trials; t++) {
        tasks.push({ spanIndex: i, strategy, games: rule.games, seed: (seedBase + t * 7919) >>> 0, setting });
      }
    }
  });
  return { rulesetId: ruleset.id, setting, tasks };
}

/** 実行済みタスクの出玉率（plan.tasks と同じ並び）から判定を組み立てる */
export function assembleCompliance(plan: CompliancePlan, rates: readonly number[]): ComplianceResult {
  const ruleset = RULESETS[plan.rulesetId];
  if (rates.length !== plan.tasks.length) {
    throw new Error(`rates length mismatch: ${rates.length} != ${plan.tasks.length}`);
  }

  const stats = (spanIndex: number, strategy: 'naive' | 'perfect'): StrategyStats => {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let trials = 0;
    plan.tasks.forEach((task, i) => {
      if (task.spanIndex !== spanIndex || task.strategy !== strategy) return;
      const rate = rates[i]!;
      if (rate < min) min = rate;
      if (rate > max) max = rate;
      sum += rate;
      trials++;
    });
    return { mean: trials > 0 ? sum / trials : 0, min, max, trials };
  };

  const spans: ComplianceSpanResult[] = ruleset.spans.map((rule, i) => {
    const naive = stats(i, 'naive');
    const perfect = stats(i, 'perfect');
    const maxOk = rule.max === undefined || perfect.max < rule.max;
    const minOk = rule.min === undefined || naive.min >= rule.min;
    return { games: rule.games, min: rule.min, max: rule.max, naive, perfect, pass: maxOk && minOk };
  });

  return { ruleset: ruleset.id, setting: plan.setting, spans, pass: spans.every((s) => s.pass) };
}

/** タスクを 1 個実行する（Worker 側でも UI 側でも同じ入口を使う） */
export function runComplianceTask(machine: MachineDef, task: ComplianceTask): number {
  return simulate(machine, {
    games: task.games,
    strategy: task.strategy,
    seed: task.seed,
    setting: task.setting,
  }).payoutRate;
}

export function checkCompliance(machine: MachineDef, opts: ComplianceOptions = {}): ComplianceResult {
  const plan = planCompliance(opts);
  const rates = plan.tasks.map((task) => runComplianceTask(machine, task));
  return assembleCompliance(plan, rates);
}
