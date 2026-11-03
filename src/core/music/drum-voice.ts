/**
 * ドラム: スタイル譜（16分グリッド強度、ゴースト込み）を区間計画
 * （sectionB/breakdown/フィル/シンバル）へ解決して敷く。
 * オープンハット・拍節アクセントの導出は後段の drum-articulation.ts。
 */

import { barInSection, closesWithCadence, sectionIndexAt } from './form.js';
import { drumPatternFor, effectiveGroove } from './grid.js';
import type { GridDef } from './grid.js';
import { grooveBeat, grooveFor, tripletHatOffsets } from './groove.js';
import type { ComposeContext } from './compose-context.js';
import type { DrumEvent } from './types.js';

export function generateDrums(ctx: ComposeContext): DrumEvent[] {
  const { form, bars, style, grooveFeel, arrangementPlan, phrasePlan, gridAt } = ctx;
  // --- ドラム（小節の細かい格子=4x2 では 16 分を小節数ぶん敷く） ---
  const drums: DrumEvent[] = [];
  // 打楽器のない編成(弾き語り)では、フィル・シンバル・ブレイクダウンも含めて何も敷かない。
  if (style.percussion.kind === 'none') return drums;
  const kit = style.percussion;
  // スタイル譜(16 分)を小節の格子へ導いたもの(4x2 は恒等)。格子ごとに一度だけ導く。
  const derivedCache = new Map<string, readonly number[]>();
  const derived = (grid: GridDef, pattern: readonly number[]): readonly number[] => {
    const key = `${grid.grouping}:${pattern.join('')}`;
    let cached = derivedCache.get(key);
    if (!cached) {
      cached = drumPatternFor(grid, pattern);
      derivedCache.set(key, cached);
    }
    return cached;
  };
  const patternAt = (grid: GridDef, pattern: readonly number[], bar: number, step: number): number => {
    const table = derived(grid, pattern);
    return table[(bar * grid.sixteenthSteps + step) % table.length] ?? 0;
  };
  // スタイル譜の強度(0..1)を発音へ写す。中間値はゴースト=ベロシティとして持たせる
  // (強度1は従来と同じ形のイベントになり、既存スタイルの音は1ビットも変わらない)。
  const pushDrum = (beat: number, inst: DrumEvent['inst'], level: number): void => {
    if (level <= 0) return;
    drums.push(level < 1 ? { beat, inst, velocity: level } : { beat, inst });
  };
  for (let bar = 0; bar < bars; bar++) {
    const barPlan = phrasePlan.bars[bar]!;
    const sectionIndex = sectionIndexAt(form, bar);
    const offsetInSection = barInSection(form, bar);
    const sectionPlan = arrangementPlan.sections[sectionIndex] ?? arrangementPlan.sections[0]!;
    const pattern = sectionPlan.drum === 'sectionB' ? kit.sectionB : kit;
    if (offsetInSection === 0 && sectionPlan.entrance === 'cymbal') {
      drums.push({ beat: bar * 4, inst: 'cymbal' });
    }
    const sectionTransition = form.sections.length > 1
      && offsetInSection === form.sections[sectionIndex]!.bars - 1
      && bar !== bars - 1;
    const hasFill = sectionTransition && sectionPlan.exitFill !== 'none';
    // 小節の格子: 細かい格子の総数と 1 拍ぶん。フィル帯は最終拍、ブレイクダウンは拍頭の偶奇で
    // キック/スネアを交替し拍の中点にハット(4x2 では従来の 16 分位置と同じ)。
    const grid = gridAt(bar);
    const feel = effectiveGroove(grooveFeel, grid.grouping);
    const hatOverlay = grooveFor(feel).subdivisionOverlay;
    const fine = grid.sixteenthSteps;
    const perPulse = fine / grid.pulses;
    const fillStart = fine - perPulse;
    const anchorFine = grid.anchorStep * 2;
    const quarterPulse = Math.round(perPulse / 4);
    for (let s = 0; s < fine; s++) {
      const beat = grooveBeat(bar * 4 + (s * 4) / fine, feel);
      if (hasFill && s >= fillStart) {
        if (sectionPlan.exitFill === 'full') {
          if (s === fillStart && patternAt(grid, kit.kick, bar, s)) drums.push({ beat, inst: 'kick' });
          if (s === fillStart) drums.push({ beat, inst: 'snare' });
          if (s === fillStart + perPulse / 2) drums.push({ beat, inst: 'tom' });
          if (s === fine - 1) drums.push({ beat, inst: 'cymbal' });
          if (hatOverlay === 'none' && s === fillStart + quarterPulse) drums.push({ beat, inst: 'hat' });
        } else {
          if (s === fillStart && patternAt(grid, kit.kick, bar, s)) drums.push({ beat, inst: 'kick' });
          if (s === fillStart + perPulse / 2) drums.push({ beat, inst: 'snare' });
          if (hatOverlay === 'none' && (s === fillStart + quarterPulse || s === fine - 1)) drums.push({ beat, inst: 'hat' });
        }
        continue;
      }
      // 最終小節の最後の 1 拍を空け、B の勢いを整理してループ先の A を迎える。
      if (barPlan.cadence === 'turnaround' && s >= fillStart) continue;
      // 終止曲型の最終小節: 終止和音(アンカー)で打ち切り、シンバルで閉じる。
      if (closesWithCadence(form.ending) && bar === bars - 1) {
        if (s === 0) drums.push({ beat, inst: 'kick' }, { beat, inst: 'cymbal' });
        if (s === anchorFine) drums.push({ beat, inst: 'kick' }, { beat, inst: 'cymbal' });
        continue;
      }
      if (sectionPlan.drum === 'breakdown') {
        const onPulse = s % perPulse === 0;
        const pulse = s / perPulse;
        if (onPulse && pulse % 2 === 0) drums.push({ beat, inst: 'kick' });
        if (onPulse && pulse % 2 === 1) drums.push({ beat, inst: 'snare' });
        if (hatOverlay === 'none' && s % perPulse === perPulse / 2) drums.push({ beat, inst: 'hat' });
        continue;
      }
      pushDrum(beat, 'kick', patternAt(grid, pattern.kick, bar, s));
      pushDrum(beat, 'snare', patternAt(grid, pattern.snare, bar, s));
      if (hatOverlay === 'none') pushDrum(beat, 'hat', patternAt(grid, pattern.hat, bar, s));
    }
    if (hatOverlay === 'triplet') {
      // 三連を常時ロールとして足さず、元のスタイル譜(この小節の16ステップ窓)を三連位置へ写す。
      // A→Bフィルとループ直前は最終拍のハットを休ませ、スネアと余白を立てる。
      const quarters = closesWithCadence(form.ending) && bar === bars - 1
        ? 0
        : barPlan.cadence === 'turnaround' || hasFill
          ? 3
          : 4;
      const hatWindowStart = (bar * 16) % pattern.hat.length;
      const hatWindow = pattern.hat.slice(hatWindowStart, hatWindowStart + 16);
      for (let quarter = 0; quarter < quarters; quarter++) {
        const offsets = sectionPlan.drum === 'breakdown'
          ? [2 / 3]
          : tripletHatOffsets(hatWindow, quarter);
        for (const offset of offsets) drums.push({ beat: bar * 4 + quarter + offset, inst: 'hat' });
      }
    }
  }
  return drums;
}
