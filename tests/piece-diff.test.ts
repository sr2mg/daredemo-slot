import { describe, expect, it } from 'vitest';
import { compose, variedChoiceFor } from '../src/core/music/compose.js';
import type { ComposeOptions } from '../src/core/music/compose.js';
import { diffPieceSections, pieceSectionRanges } from '../src/core/music/piece-diff.js';
import { PROGRESSIONS } from '../src/core/music/theory.js';

const prog = PROGRESSIONS.find((candidate) => candidate.id === 'minor-pedal')!;
const base: ComposeOptions = {
  progressionId: prog.id,
  styleId: 'eurobeat',
  keyRoot: 0,
  bpm: 150,
  bars: 40,
  tonality: 'minor',
  seed: 42,
  choice: variedChoiceFor(prog, 40, 42),
};

describe('曲のセクション差分', () => {
  it('40小節フォームはイントロとA〜Eのレンジへ分割される', () => {
    const ranges = pieceSectionRanges(compose(base));
    expect(ranges.map((range) => range.section)).toEqual(['intro', 'A', 'B', 'C', 'D', 'E']);
    for (let index = 1; index < ranges.length; index++) {
      expect(ranges[index]!.startBeat).toBe(ranges[index - 1]!.endBeat);
    }
  });

  it('同一オプションの2曲はどの区間にも差分を報告しない', () => {
    const diffs = diffPieceSections([compose(base), compose(base)]);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.every((diff) => diff.differingParts.length === 0)).toBe(true);
  });

  it('戦略が違う候補は、差分のある区間とパートを特定する', () => {
    const diffs = diffPieceSections([
      compose({ ...base, compositionStrategy: 'current' }),
      compose({ ...base, compositionStrategy: 'memoryArc' }),
      compose({ ...base, compositionStrategy: 'premiseArc' }),
    ]);
    const differing = diffs.filter((diff) => diff.differingParts.length > 0);
    expect(differing.length).toBeGreaterThan(0);
    // 3戦略は旋律を確実に変える（blind-study.test.ts の既存不変条件と整合）。
    expect(differing.some((diff) => diff.differingParts.includes('melody'))).toBe(true);
  });
});
