/**
 * 和風3様式（律・民謡・都節）の音組織と核音配置。
 */

import { YO_SCALE } from './theory.js';
import type { JapanesePlan, JapaneseScale, JapaneseScaleChoice } from './types.js';


const JAPANESE_INTERVALS: Record<JapaneseScale, readonly number[]> = {
  // 4度枠 C-D-F / G-A-C に相当する、これまでの陽旋法寄り五音。
  ritsu: YO_SCALE,
  // 国立劇場の民謡音階例 C-Eb-F / G-Bb-C。
  minyo: [0, 3, 5, 7, 10],
  // 半音を含む都節系 C-Db-F / G-Ab-C。
  miyakobushi: [0, 1, 5, 7, 8],
};

/** 五音を固定トニックとしてではなく、4度離れた核音を持つ旋律計画へ展開する。 */
export function japanesePlanFor(
  keyRoot: number,
  choice: JapaneseScaleChoice = 'auto',
  seed = 0,
): JapanesePlan {
  const ids: readonly JapaneseScale[] = ['ritsu', 'minyo', 'miyakobushi'];
  const id = choice === 'auto' ? ids[(seed >>> 1) % ids.length]! : choice;
  const intervals = [...JAPANESE_INTERVALS[id]];
  return {
    id,
    intervals,
    scalePcs: intervals.map((interval) => (keyRoot + interval) % 12),
    // 二つの4度枠の端点。フレーズの柱として扱い、中間音は方向づけに使う。
    nuclearPcs: [keyRoot, (keyRoot + 5) % 12, (keyRoot + 7) % 12],
  };
}
