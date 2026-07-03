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

function measure(
  machine: MachineDef,
  games: number,
  trials: number,
  strategy: 'naive' | 'perfect',
  setting: number,
  seedBase: number,
): StrategyStats {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let t = 0; t < trials; t++) {
    const result = simulate(machine, { games, strategy, seed: (seedBase + t * 7919) >>> 0, setting });
    const rate = result.payoutRate;
    if (rate < min) min = rate;
    if (rate > max) max = rate;
    sum += rate;
  }
  return { mean: sum / trials, min, max, trials };
}

export function checkCompliance(machine: MachineDef, opts: ComplianceOptions = {}): ComplianceResult {
  const ruleset = RULESETS[opts.ruleset ?? 'yon'];
  const setting = opts.setting ?? 1;
  const mode = opts.mode ?? 'quick';
  const seed = opts.seed ?? 1;

  const spans: ComplianceSpanResult[] = ruleset.spans.map((rule, i) => {
    const trials = opts.trialsOverride?.[rule.games] ?? TRIALS[mode][rule.games] ?? 3;
    const naive = measure(machine, rule.games, trials, 'naive', setting, seed + i * 104729);
    const perfect = measure(machine, rule.games, trials, 'perfect', setting, seed + i * 104729 + 31337);
    const maxOk = rule.max === undefined || perfect.max < rule.max;
    const minOk = rule.min === undefined || naive.min >= rule.min;
    return { games: rule.games, min: rule.min, max: rule.max, naive, perfect, pass: maxOk && minOk };
  });

  return { ruleset: ruleset.id, setting, spans, pass: spans.every((s) => s.pass) };
}
