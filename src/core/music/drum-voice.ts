/**
 * ドラム: スタイル譜（16分グリッド強度、ゴースト込み）を区間計画
 * （sectionB/breakdown/フィル/シンバル）へ解決して敷く。
 * オープンハット・拍節アクセントの導出は後段の drum-articulation.ts。
 */

import { grooveBeat, grooveFor, tripletHatOffsets } from './groove.js';
import { drumPatternStep } from './theory.js';
import type { ComposeContext } from './compose-context.js';
import type { DrumEvent } from './types.js';

export function generateDrums(ctx: ComposeContext): DrumEvent[] {
  const { opts, style, grooveFeel, arrangementPlan, phrasePlan } = ctx;
  // --- ドラム（16 分グリッドを小節数ぶん敷く） ---
  const drums: DrumEvent[] = [];
  const hatOverlay = grooveFor(grooveFeel).subdivisionOverlay;
  // スタイル譜の強度(0..1)を発音へ写す。中間値はゴースト=ベロシティとして持たせる
  // (強度1は従来と同じ形のイベントになり、既存スタイルの音は1ビットも変わらない)。
  const pushDrum = (beat: number, inst: DrumEvent['inst'], level: number): void => {
    if (level <= 0) return;
    drums.push(level < 1 ? { beat, inst, velocity: level } : { beat, inst });
  };
  for (let bar = 0; bar < opts.bars; bar++) {
    const barPlan = phrasePlan.bars[bar]!;
    const sectionIndex = opts.bars === 40 ? Math.floor(bar / 8) : opts.bars === 16 && bar >= 8 ? 1 : 0;
    const sectionPlan = arrangementPlan.sections[sectionIndex] ?? arrangementPlan.sectionA;
    const pattern = sectionPlan.drum === 'sectionB' ? style.sectionB : style;
    if (bar % 8 === 0 && sectionPlan.entrance === 'cymbal') {
      drums.push({ beat: bar * 4, inst: 'cymbal' });
    }
    const sectionTransition = opts.bars >= 16 && bar % 8 === 7 && bar !== opts.bars - 1;
    const hasFill = sectionTransition && sectionPlan.exitFill !== 'none';
    for (let s = 0; s < 16; s++) {
      const beat = grooveBeat(bar * 4 + s * 0.25, grooveFeel);
      if (hasFill && s >= 12) {
        if (sectionPlan.exitFill === 'full') {
          if (s === 12 && drumPatternStep(style.kick, bar, s)) drums.push({ beat, inst: 'kick' });
          if (s === 12) drums.push({ beat, inst: 'snare' });
          if (s === 14) drums.push({ beat, inst: 'tom' });
          if (s === 15) drums.push({ beat, inst: 'cymbal' });
          if (hatOverlay === 'none' && s === 13) drums.push({ beat, inst: 'hat' });
        } else {
          if (s === 12 && drumPatternStep(style.kick, bar, s)) drums.push({ beat, inst: 'kick' });
          if (s === 14) drums.push({ beat, inst: 'snare' });
          if (hatOverlay === 'none' && (s === 13 || s === 15)) drums.push({ beat, inst: 'hat' });
        }
        continue;
      }
      // 最終小節の最後の 1 拍を空け、B の勢いを整理してループ先の A を迎える。
      if (barPlan.cadence === 'turnaround' && s >= 12) continue;
      if (sectionPlan.drum === 'breakdown') {
        if (s === 0 || s === 8) drums.push({ beat, inst: 'kick' });
        if (s === 4 || s === 12) drums.push({ beat, inst: 'snare' });
        if (hatOverlay === 'none' && (s === 2 || s === 6 || s === 10 || s === 14)) {
          drums.push({ beat, inst: 'hat' });
        }
        continue;
      }
      pushDrum(beat, 'kick', drumPatternStep(pattern.kick, bar, s));
      pushDrum(beat, 'snare', drumPatternStep(pattern.snare, bar, s));
      if (hatOverlay === 'none') pushDrum(beat, 'hat', drumPatternStep(pattern.hat, bar, s));
    }
    if (hatOverlay === 'triplet') {
      // 三連を常時ロールとして足さず、元のスタイル譜(この小節の16ステップ窓)を三連位置へ写す。
      // A→Bフィルとループ直前は最終拍のハットを休ませ、スネアと余白を立てる。
      const quarters = barPlan.cadence === 'turnaround'
        || hasFill
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
