import { describe, expect, it } from 'vitest';
import { validateForm } from '../src/core/music/form.js';
import {
  BAR_GROUPINGS,
  beatStep,
  densityFor,
  drumPatternFor,
  effectiveGroove,
  gridFor,
  nearBeat,
  offPulseSteps,
  onsetWeightsFor,
  pulseBeats,
  stepBeat,
  strongBeatOffsets,
} from '../src/core/music/grid.js';
import { canonicalForm } from '../src/core/music/options.js';
import { STYLES } from '../src/core/music/theory.js';
import type { SectionSpec, SongFormSpec } from '../src/core/music/types.js';

/**
 * 拍格子(grid.ts)の規約を固定する:
 * - 格子は「拍数×拍内分割」から導出され、小節長は常に 4 拍
 * - 4x2 は現行の 8 分格子と恒等(写像関数が入力をそのまま返す)
 * - 3 拍・3 連の格子でも拍頭は保存される(ドラム譜の導出は拍単位)
 * - 格子は曲型の区間属性で、保存の正準化と検証(主題・引用の元と同じ割り方)を通る
 */

describe('拍格子の導出', () => {
  it('4x2 は 8 ステップ・拍頭 [0,2,4,6]・アンカー 4、小節長は常に 4 拍', () => {
    const grid = gridFor('4x2');
    expect(grid.steps).toBe(8);
    expect(grid.stepBeats).toBe(0.5);
    expect([...grid.pulseSteps]).toEqual([0, 2, 4, 6]);
    expect(grid.anchorStep).toBe(4);
    expect(grid.sixteenthSteps).toBe(16);
    for (const grouping of BAR_GROUPINGS) {
      const def = gridFor(grouping);
      expect(def.steps * def.stepBeats, grouping).toBeCloseTo(4, 9);
      expect(stepBeat(def, def.steps), grouping).toBe(4);
    }
  });

  it('4x3 は 12/8(拍頭 [0,3,6,9]、アンカーは 3 拍目)、3x4 は 6/4(拍頭 [0,4,8]、アンカーは 2 拍目)', () => {
    const twelveEight = gridFor('4x3');
    expect([...twelveEight.pulseSteps]).toEqual([0, 3, 6, 9]);
    expect(twelveEight.anchorStep).toBe(6);
    expect(pulseBeats(twelveEight)).toEqual([0, 1, 2, 3]);
    expect(strongBeatOffsets(twelveEight)).toEqual([0, 2]);

    const sixFour = gridFor('3x4');
    expect([...sixFour.pulseSteps]).toEqual([0, 4, 8]);
    expect(sixFour.anchorStep).toBe(4);
    const beats = pulseBeats(sixFour);
    expect(beats[0]).toBe(0);
    expect(nearBeat(beats[1]!, 4 / 3)).toBe(true);
    expect(nearBeat(beats[2]!, 8 / 3)).toBe(true);
    expect(nearBeat(strongBeatOffsets(sixFour)[1]!, 4 / 3)).toBe(true);
    expect(offPulseSteps(sixFour)).toEqual([1, 2, 3, 5, 6, 7, 9, 10, 11]);
  });

  it('ステップ⇄拍位置は 3 分の値でも往復する(先に掛けてから割る)', () => {
    for (const grouping of BAR_GROUPINGS) {
      const grid = gridFor(grouping);
      for (let step = 0; step < grid.steps; step++) {
        expect(beatStep(grid, stepBeat(grid, step)), `${grouping}/${step}`).toBe(step);
      }
      expect(beatStep(grid, 0.1)).toBeNull();
    }
    // 累積で足した 1/3 でも格子上と判定される。
    const grid = gridFor('4x3');
    let beat = 0;
    for (let step = 0; step < 12; step++) {
      expect(beatStep(grid, beat)).toBe(step);
      beat += 1 / 3;
    }
  });
});

describe('様式パラメータの格子への写像', () => {
  const weights8 = [100, 72, 38, 76, 100, 68, 42, 78] as const;

  it('4x2 では発音重み・密度・ドラム譜が恒等', () => {
    const grid = gridFor('4x2');
    expect(onsetWeightsFor(grid, weights8)).toEqual([...weights8]);
    expect(densityFor(grid, [5, 6])).toEqual([5, 6]);
    for (const style of STYLES) {
      if (style.percussion.kind !== 'kit') continue;
      expect(drumPatternFor(grid, style.percussion.kick)).toBe(style.percussion.kick);
    }
  });

  it('拍頭は対応する 4/4 の拍頭の重みを取り、他は位置比で引く', () => {
    const twelveEight = onsetWeightsFor(gridFor('4x3'), weights8);
    expect(twelveEight).toHaveLength(12);
    expect([0, 3, 6, 9].map((step) => twelveEight[step])).toEqual([100, 38, 100, 42]);
    expect(twelveEight[1]).toBe(weights8[0]);
    expect(twelveEight[2]).toBe(weights8[1]);
    const sixFour = onsetWeightsFor(gridFor('3x4'), weights8);
    // 第 3 拍(8/3 拍)は 4/4 の 3 拍目の重み(位置比なら 3 拍目の裏の重みになってしまう)。
    expect([0, 4, 8].map((step) => sixFour[step])).toEqual([100, 38, 100]);
  });

  it('密度はステップ数に比例し、下限 2・上限ステップ数に収まる', () => {
    expect(densityFor(gridFor('4x3'), [5, 6])).toEqual([8, 9]);
    expect(densityFor(gridFor('3x4'), [3, 4])).toEqual([5, 6]);
    expect(densityFor(gridFor('4x3'), [1, 1])).toEqual([2, 2]);
    expect(densityFor(gridFor('4x3'), [8, 8])).toEqual([12, 12]);
  });

  it('ドラム譜の導出は拍単位: 4x3 は三連へ要約、3x4 は 4/4 の 4 拍目を落とす', () => {
    const kick = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0];
    const snare = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
    const hat = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1, 1];

    const twelveEight = gridFor('4x3');
    // 拍 1 の裏 1 打(16 分の 3 つ目)と拍 2 の裏 1 打はそれぞれの拍の 2/3(6 分割の 4 つ目)へ。
    expect(drumPatternFor(twelveEight, kick)).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(drumPatternFor(twelveEight, snare)).toEqual([
      0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0,
    ]);
    // 裏 1 打は 2/3、裏 2 打以上は 1/3 と 2/3。
    expect(drumPatternFor(twelveEight, hat)).toEqual([
      1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0,
    ]);

    const sixFour = gridFor('3x4');
    expect(drumPatternFor(sixFour, kick)).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0,
    ]);
    // スネアは 4/4 の 2 拍目(第 2 拍の頭)だけ残り、4 拍目のスネアは落ちる。
    expect(drumPatternFor(sixFour, snare)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    // 2 小節譜は小節ごとに導く。
    expect(drumPatternFor(sixFour, [...kick, ...snare])).toHaveLength(48);
    expect(drumPatternFor(twelveEight, [...kick, ...snare]).slice(24)).toEqual(drumPatternFor(twelveEight, snare));
  });

  it('ゴーストの強度は統合の最大を取る', () => {
    const ghost = 0.4;
    const pattern = [1, ghost, 0, ghost, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const derived = drumPatternFor(gridFor('4x3'), pattern);
    expect(derived.slice(0, 6)).toEqual([1, 0, ghost, 0, ghost, 0]);
  });

  it('3 連・3 拍の格子ではスウィングと三連オーバーレイを無効化する', () => {
    expect(effectiveGroove('bounce', '4x2')).toBe('bounce');
    expect(effectiveGroove('tripletOverlay', '4x2')).toBe('tripletOverlay');
    expect(effectiveGroove('bounce', '4x3')).toBe('straight');
    expect(effectiveGroove('shuffle16', '3x4')).toBe('straight');
    expect(effectiveGroove('tripletOverlay', '4x3')).toBe('straight');
  });
});

describe('曲型の区間属性としての格子', () => {
  const defaults = { tonality: 'major', progressionId: 'royal-pop' } as const;
  const spec = (sections: SectionSpec[]): SongFormSpec => ({ sections, ending: 'loop' });

  it('保存の正準化は既定(4x2)を省き、他の割り方を残す', () => {
    const form = spec([
      { id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A', grouping: '4x2' },
      { id: 'B', role: 'development', bars: 8, energy: 4, theme: 'B', grouping: '4x3' },
    ]);
    const canonical = canonicalForm(form, { progressionId: 'royal-pop', keyRoot: 0, tonality: 'major' }) as SongFormSpec;
    expect('grouping' in canonical.sections[0]!).toBe(false);
    expect(canonical.sections[1]!.grouping).toBe('4x3');
  });

  it('検証: 値域、主題・引用の元区間との割り方の一致', () => {
    const bad = spec([
      { id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A', grouping: '5x2' as never },
    ]);
    expect(validateForm(bad, defaults).map((issue) => issue.message)).toEqual(['拍の割り方が不正: 5x2']);

    const mismatch = spec([
      { id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A', grouping: '4x3' },
      { id: 'B', role: 'development', bars: 8, energy: 4, theme: 'B', quote: { from: 'A', phrases: [3] } },
      { id: "A'", role: 'return', bars: 8, energy: 5, theme: 'A' },
    ]);
    expect(validateForm(mismatch, defaults).map((issue) => [issue.section, issue.message])).toEqual([
      ['B', '引用元「A」(12/8)と拍の割り方が違う'],
      ["A'", '主題「A」の元区間「A」(12/8)と拍の割り方が違う'],
    ]);

    const ok = spec([
      { id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A', grouping: '4x3' },
      { id: 'B', role: 'development', bars: 8, energy: 4, theme: 'B', grouping: '3x4' },
      { id: "A'", role: 'return', bars: 8, energy: 5, theme: 'A', grouping: '4x3' },
    ]);
    expect(validateForm(ok, defaults)).toEqual([]);
  });
});
