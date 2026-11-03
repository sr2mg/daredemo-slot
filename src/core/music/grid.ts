/**
 * 拍格子(grid)の理論カタログ: 小節長を 4 拍(4分音符)に固定したまま、区間ごとに
 * 「拍数 × 拍内分割」を切り替える。
 *
 * 12/8(♩.=137)・6/4(♩=205.5)・4/4(♩=137)は小節長が同じで、8 分音符(12/8 と 6/4)か
 * 拍(12/8 と 4/4)を共有する。学マス「め」が A ループ → サビ → ブリッジでこの 3 つを
 * 行き来する(analysis/youtube-Itehv_5zdko)。エンジンの時間単位は 4 分音符拍で、
 * 小節 = 4 拍を全層(bar * 4)が前提にしているので、拍子でなく「4 拍をどう割るか」として扱う。
 *
 * - 4x2: 4 拍 × 2 分割 = 8 ステップ(現行の 8 分格子、4/4)。
 * - 4x3: 4 拍 × 3 分割 = 12 ステップ(12/8。拍は付点 4 分、ステップは 8 分)。
 * - 3x4: 3 拍 × 4 分割 = 12 ステップ(6/4 のヘミオラ。拍は 4/4 の 4/3 拍、ステップは同じ 8 分)。
 *
 * 全て導出で、列挙するのは拍数と分割だけ。ステップの拍位置は `step * 4 / steps`
 * (先に掛ける。3 分の値は有理数にならないので比較は近似で行う)。
 */

import type { GrooveFeel } from './groove.js';
import type { BarGrouping } from './types.js';

/** 小節の長さ(4 分音符拍)。metric-modulation.ts の CARRIER_BEATS と同じ定数。 */
export const BAR_BEATS = 4;

export interface GridDef {
  grouping: BarGrouping;
  /** 小節内の拍数(拍頭 = 伴奏・ベースの再打鍵位置)。 */
  pulses: number;
  /** 1 拍の分割数。 */
  subdivision: number;
  /** 小節内のステップ数(旋律の基本格子)。 */
  steps: number;
  /** 1 ステップの長さ(4 分音符拍)。 */
  stepBeats: number;
  /** 各拍頭のステップ番号。 */
  pulseSteps: readonly number[];
  /** 小節の中央の拍頭(4x2 の 3 拍目に当たる)。必須打点・倚音・終止目標の既定位置。 */
  anchorStep: number;
  /** 装飾音・ドラムの細かい格子(ステップの 2 分割)。 */
  sixteenthSteps: number;
}

export const DEFAULT_GROUPING: BarGrouping = '4x2';
export const BAR_GROUPINGS: readonly BarGrouping[] = ['4x2', '4x3', '3x4'];

export const BAR_GROUPING_LABELS: Record<BarGrouping, string> = {
  '4x2': '4/4',
  '4x3': '12/8',
  '3x4': '6/4',
};

export function isBarGrouping(value: unknown): value is BarGrouping {
  return typeof value === 'string' && (BAR_GROUPINGS as readonly string[]).includes(value);
}

function gridDef(grouping: BarGrouping): GridDef {
  const [pulses, subdivision] = grouping.split('x').map(Number) as [number, number];
  const steps = pulses * subdivision;
  const pulseSteps = Array.from({ length: pulses }, (_, pulse) => pulse * subdivision);
  return {
    grouping,
    pulses,
    subdivision,
    steps,
    stepBeats: BAR_BEATS / steps,
    pulseSteps,
    anchorStep: pulseSteps[Math.floor(pulses / 2)]!,
    sixteenthSteps: steps * 2,
  };
}

const GRIDS: Record<BarGrouping, GridDef> = {
  '4x2': gridDef('4x2'),
  '4x3': gridDef('4x3'),
  '3x4': gridDef('3x4'),
};

export function gridFor(grouping: BarGrouping = DEFAULT_GROUPING): GridDef {
  return GRIDS[grouping];
}

const EPSILON = 1e-6;

/** 3 分の拍位置を含む比較。`===` を使わない。 */
export function nearBeat(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON;
}

/** ステップ → 小節内の拍位置。先に掛けてから割る(1/3 の累積誤差を避ける)。 */
export function stepBeat(grid: GridDef, step: number): number {
  return (step * BAR_BEATS) / grid.steps;
}

/** 小節内の拍位置 → ステップ。格子上に無ければ null。 */
export function beatStep(grid: GridDef, beatInBar: number): number | null {
  const step = Math.round((beatInBar * grid.steps) / BAR_BEATS);
  return nearBeat(stepBeat(grid, step), beatInBar) ? step : null;
}

export function isPulseStep(grid: GridDef, step: number): boolean {
  return step % grid.subdivision === 0;
}

/** 拍頭以外のステップ(任意打点の候補)。 */
export function offPulseSteps(grid: GridDef): number[] {
  return Array.from({ length: grid.steps }, (_, step) => step).filter((step) => !isPulseStep(grid, step));
}

/** ステップが属する拍(0..pulses-1)。 */
export function pulseOfStep(grid: GridDef, step: number): number {
  return Math.floor(step / grid.subdivision);
}

export function lastPulseStep(grid: GridDef): number {
  return grid.pulseSteps[grid.pulses - 1]!;
}

/** 拍頭の拍位置(伴奏・ベースの再打鍵、診断の「拍頭」)。 */
export function pulseBeats(grid: GridDef): number[] {
  return grid.pulseSteps.map((step) => stepBeat(grid, step));
}

/** 強拍の拍位置(小節頭とアンカー)。4x2 では [0, 2]。 */
export function strongBeatOffsets(grid: GridDef): number[] {
  return [0, stepBeat(grid, grid.anchorStep)];
}

/**
 * 様式の 8 分格子の発音重み(onsetWeights、8 要素)を格子へ写す。
 * - 拍頭は対応する 4/4 の拍頭の重みを取る(3x4 の第 3 拍は 4/4 の 3 拍目の重み)。
 * - それ以外は小節内の位置比で引く(12 ステップの 5 番目は 8 分の 3 番目)。
 * 4x2 では恒等。
 */
export function onsetWeightsFor(grid: GridDef, weights8: readonly number[]): number[] {
  return Array.from({ length: grid.steps }, (_, step) => {
    if (isPulseStep(grid, step)) {
      const beat = Math.floor((pulseOfStep(grid, step) * BAR_BEATS) / grid.pulses);
      return weights8[beat * 2]!;
    }
    return weights8[Math.floor((step * 8) / grid.steps)]!;
  });
}

/**
 * 1 小節の音数範囲(density、8 分格子の値)を格子へ写す。ステップ数に比例させる
 * (12 ステップで 8 分格子と同じ音数だと薄くなる)。下限は必須打点の 2、上限はステップ数。
 */
export function densityFor(grid: GridDef, density8: readonly [number, number]): [number, number] {
  const scale = grid.steps / 8;
  const min = Math.max(2, Math.min(grid.steps, Math.round(density8[0] * scale)));
  const max = Math.max(min, Math.min(grid.steps, Math.round(density8[1] * scale)));
  return [min, max];
}

/**
 * 16 分格子のドラム譜(1 小節 16 ステップ、または 32 の 2 小節フレーズ)を格子の細かい格子
 * (sixteenthSteps/小節)へ導く。小節比の写像だと 3 拍の格子でバックビートが拍頭から外れるので
 * **拍単位**で導く。
 * - 4x3: 各拍の 4 つの 16 分を 6 分割へ。拍頭→0、裏が 1 打→4(2/3)、裏が 2 打以上→2 と 4
 *   (groove.ts の tripletHatOffsets と同じ要約)。強度は統合の最大。
 * - 3x4: 拍 p は 4/4 の拍 floor(p*4/3)(=0,1,2)の 4 つの 16 分を 1:1 で 8 分割の偶数位置へ取り、
 *   4/4 の 4 拍目(2 つ目のスネアとフィル帯)は落とす。
 * 4x2 では恒等(同じ配列を返す)。
 */
export function drumPatternFor(grid: GridDef, pattern16: readonly number[]): readonly number[] {
  if (grid.grouping === '4x2') return pattern16;
  const bars = Math.max(1, Math.floor(pattern16.length / 16));
  const perPulse = grid.sixteenthSteps / grid.pulses;
  const result: number[] = Array.from({ length: bars * grid.sixteenthSteps }, () => 0);
  for (let bar = 0; bar < bars; bar++) {
    for (let pulse = 0; pulse < grid.pulses; pulse++) {
      const sourceBeat = Math.floor((pulse * BAR_BEATS) / grid.pulses);
      const source = pattern16.slice(bar * 16 + sourceBeat * 4, bar * 16 + sourceBeat * 4 + 4);
      const base = bar * grid.sixteenthSteps + pulse * perPulse;
      const put = (offset: number, level: number): void => {
        result[base + offset] = Math.max(result[base + offset]!, level);
      };
      if (grid.subdivision === 3) {
        if (source[0]) put(0, source[0]);
        const offbeats = source.slice(1).filter(Boolean);
        const strongest = Math.max(0, ...offbeats);
        if (offbeats.length === 1) put(4, strongest);
        else if (offbeats.length >= 2) {
          put(2, strongest);
          put(4, strongest);
        }
      } else {
        source.forEach((level, index) => {
          if (level) put(index * (perPulse / 4), level);
        });
      }
    }
  }
  return result;
}

/**
 * 格子と併用できるグルーヴ。4x3 / 3x4 は 3 連の格子そのものなので、裏拍の変位(swing)も
 * 三連オーバーレイも意味を持たない(4x3 は「bounce + 三連オーバーレイを焼き込んだもの」)。
 * 4x2 ではそのまま。
 */
export function effectiveGroove(feel: GrooveFeel, grouping: BarGrouping): GrooveFeel {
  return grouping === '4x2' ? feel : 'straight';
}
