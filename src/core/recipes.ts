import { solveTargetRate } from './solve.js';
import type { EstimateOptions } from './spec.js';
import type { MachineDef } from './types.js';

/**
 * かんたんウィザードのレシピ: 「タイプ・甘さ・波」の 3 択から機種を組み立てる。
 * - タイプ = プリセットを雛形に採用
 * - 波 = BB の大きさ（消化ゲーム数）と頻度を逆方向にスケールして、
 *   出玉総量をだいたい保ったまま分散だけを変える（AT 機は継続率も動かす）
 * - 甘さ = 逆算ソルバー（solve.ts）で共通ベル相当の重みを二分探索し、
 *   理論機械割（設定 1・適当打ち）を目標値に合わせる
 */

export type SweetnessId = 'karai' | 'futsu' | 'amai';
export type WaveId = 'mild' | 'nami' | 'ichigeki';

export const SWEETNESS: Record<SweetnessId, { label: string; description: string; target: number }> = {
  karai: { label: '辛め', description: '適当打ちで約 65%。じわじわ飲まれる', target: 0.65 },
  futsu: { label: '標準', description: '適当打ちで約 72%。プリセット相当', target: 0.72 },
  amai: { label: '甘め', description: '適当打ちで約 80%。長く遊べる', target: 0.8 },
};

export const WAVE: Record<
  WaveId,
  { label: string; description: string; gamesScale: number; weightScale: number; continueProb: number }
> = {
  mild: {
    label: 'マイルド',
    description: '小さいボーナスが頻繁に当たる',
    gamesScale: 0.7,
    weightScale: 1.4,
    continueProb: 0.6,
  },
  nami: {
    label: '波あり',
    description: 'プリセット相当のバランス',
    gamesScale: 1.0,
    weightScale: 1.0,
    continueProb: 0.7,
  },
  ichigeki: {
    label: '一撃タイプ',
    description: '大きいボーナスがまれに当たる（ハマリも深い）',
    gamesScale: 1.5,
    weightScale: 0.67,
    continueProb: 0.8,
  },
};

export interface RecipeOptions {
  name: string;
  sweetness: SweetnessId;
  wave: WaveId;
  /** 適合リトライ用: 目標機械割への加算（例: 上限超え時に -0.04） */
  targetAdjust?: number;
  estimate?: EstimateOptions;
}

export interface RecipeResult {
  machine: MachineDef;
  /** 到達した理論機械割（設定 1・適当打ち） */
  achieved: number;
  target: number;
  clamped: boolean;
}

/** 波の適用: BB 系ボーナスの消化ゲーム数と当選重みを逆方向にスケール */
function applyWave(machine: MachineDef, wave: WaveId): MachineDef {
  const w = WAVE[wave];
  if (wave === 'nami') return machine;
  const bbIds = new Set(machine.bonuses.filter((b) => b.kind === 'bb').map((b) => b.id));

  const scaleEntry = <T extends { roles: readonly string[]; weight: number }>(entry: T): T =>
    entry.roles.some((id) => bbIds.has(id))
      ? { ...entry, weight: Math.max(20, Math.round(entry.weight * w.weightScale)) }
      : entry;

  const { settingOverrides, ...lotteryRest } = machine.lottery;
  const scaled: MachineDef = {
    ...machine,
    bonuses: machine.bonuses.map((b) =>
      b.kind === 'bb' && b.end.games !== undefined
        ? { ...b, end: { ...b.end, games: Math.max(10, Math.round(b.end.games * w.gamesScale)) } }
        : b,
    ),
    lottery: {
      ...lotteryRest,
      base: machine.lottery.base.map(scaleEntry),
      ...(settingOverrides
        ? {
            settingOverrides: Object.fromEntries(
              Object.entries(settingOverrides).map(([s, list]) => [s, list.map(scaleEntry)]),
            ),
          }
        : {}),
    },
  };
  // AT 機はセット継続率も波に合わせる
  if (machine.nav && machine.nav.at.management.type === 'set') {
    return {
      ...scaled,
      nav: {
        ...machine.nav,
        at: { ...machine.nav.at, management: { ...machine.nav.at.management, continueProb: w.continueProb } },
      },
    };
  }
  return scaled;
}

/** 集中構成（RT でボーナス役の確率を変える 2〜3号機表現）かどうか */
export function isConcentrationStyle(machine: MachineDef): boolean {
  const bonusIds = new Set(machine.bonuses.map((b) => b.id));
  return machine.rtStates.some((rt) => Object.keys(rt.replayWeights).some((id) => bonusIds.has(id)));
}

export function buildFromRecipe(archetype: MachineDef, opts: RecipeOptions): RecipeResult {
  const waved = applyWave(structuredClone(archetype) as MachineDef, opts.wave);
  const named: MachineDef = { ...waved, name: opts.name };
  const target = SWEETNESS[opts.sweetness].target + (opts.targetAdjust ?? 0);
  const solveOpts = opts.estimate !== undefined ? { target, estimate: opts.estimate } : { target };
  const solved = solveTargetRate(named, solveOpts);
  return { machine: solved.machine, achieved: solved.achieved, target, clamped: solved.clamped };
}
