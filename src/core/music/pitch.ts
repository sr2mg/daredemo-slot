/**
 * 音高ユーティリティ（音域内でのピッチクラス吸着・橋渡し・音組織上の歩み）。
 * 旋律・ベース・イントロ・フレーズ計画が共有する。
 */

import { MELODY_HI, MELODY_LO } from './theory.js';



/** target に最も近い、pcs に含まれる MIDI ノート（音域内） */
export function nearestWithPc(target: number, pcs: readonly number[], lo = MELODY_LO, hi = MELODY_HI): number {
  const t = Math.max(lo, Math.min(hi, target));
  let best = -1;
  let bestDist = Infinity;
  for (let m = lo; m <= hi; m++) {
    if (!pcs.includes(m % 12)) continue;
    const d = Math.abs(m - t);
    if (d < bestDist) {
      bestDist = d;
      best = m;
    }
  }
  return best; // pcs が空でない限り必ず見つかる
}

/** 音組織の隣接音級間の最大半音数(巡回)。「順次」の上限を音組織自身から導くために使う。 */
export function maxAdjacentScaleInterval(pcs: readonly number[]): number {
  const sorted = [...new Set(pcs.map((pc) => ((pc % 12) + 12) % 12))].sort((a, b) => a - b);
  let max = 0;
  for (let index = 0; index < sorted.length; index++) {
    const gap = index + 1 < sorted.length
      ? sorted[index + 1]! - sorted[index]!
      : sorted[0]! + 12 - sorted[index]!;
    max = Math.max(max, gap);
  }
  return max;
}

/** 前後2音の双方へ近い候補を選び、大きな跳躍を片側へ押し付けない。 */
export function bridgeWithPc(
  from: number,
  to: number,
  pcs: readonly number[],
  lo = MELODY_LO,
  hi = MELODY_HI,
): number {
  let best = nearestWithPc((from + to) / 2, pcs, lo, hi);
  let bestScore = Infinity;
  for (let midi = lo; midi <= hi; midi++) {
    if (!pcs.includes(midi % 12)) continue;
    const left = Math.abs(midi - from);
    const right = Math.abs(to - midi);
    const score = Math.max(left, right) * 3 + left + right;
    if (score < bestScore) {
      best = midi;
      bestScore = score;
    }
  }
  return best;
}

/** from から dir 方向に 1 歩、pcs 上を進む（順次進行） */
export function stepOnScale(from: number, dir: 1 | -1, pcs: readonly number[]): number {
  let m = from + dir;
  while (m >= MELODY_LO && m <= MELODY_HI) {
    if (pcs.includes(((m % 12) + 12) % 12)) return m;
    m += dir;
  }
  // 音域端で進行方向に音階音がなければ反転する。単純な数値 clamp で音階外へ落とさない。
  m = from - dir;
  while (m >= MELODY_LO && m <= MELODY_HI) {
    if (pcs.includes(((m % 12) + 12) % 12)) return m;
    m -= dir;
  }
  return nearestWithPc(from, pcs);
}

