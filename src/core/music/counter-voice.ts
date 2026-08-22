/**
 * 副旋律: 主旋律と同時に予約した空間への反行応答と、保続ガイドライン
 * （counterRole=guideline のとき、進行から導出した最短連結ストランドのロングトーン化）。
 */

import { grooveBeat } from './groove.js';
import { nearestWithPc, stepOnScale } from './pitch.js';
import { COUNTER_HI, COUNTER_LO, MELODY_LO } from './theory.js';
import { featuredGuideStrand } from './voice-leading.js';
import type { ComposeContext } from './compose-context.js';
import type { NoteEvent } from './types.js';

export function generateCounterMelody(ctx: ComposeContext, melody: readonly NoteEvent[]): NoteEvent[] {
  const {
    opts, style, grooveFeel, arrangementPlan, phrasePlan, chords, chordAt, scaleAt, melodyPcsForChord,
  } = ctx;
  // --- 副旋律（主旋律と同時に予約した空間へ、反行を優先して返答） ---
  const counterMelody: NoteEvent[] = [];
  let previousCounter: number | null = null;
  for (const barPlan of phrasePlan.bars) {
    if (barPlan.counterSteps.length === 0) continue;
    const barStart = barPlan.bar * 4;
    const barNotes = melody.filter((note) => note.beat >= barStart && note.beat < barStart + 4);
    let phraseAnchor: number | null = null;
    let pendingResolution: number | null = null;
    for (let index = 0; index < barPlan.counterSteps.length; index++) {
      const step = barPlan.counterSteps[index]!;
      const logicalBeat = barStart + step * 0.5;
      const beat = grooveBeat(logicalBeat, grooveFeel);
      const chord = chordAt(logicalBeat);
      const leadBefore = [...barNotes].reverse().find((note) => note.beat < beat);
      const leadBeforeBefore = leadBefore
        ? [...barNotes].reverse().find((note) => note.beat < leadBefore.beat)
        : undefined;
      const leadAfter = barNotes.find((note) => note.beat > beat);
      const leadMotion = (leadBefore?.midi ?? 74) - (leadBeforeBefore?.midi ?? leadBefore?.midi ?? 74);
      const contraryTarget = previousCounter === null
        ? (leadBefore?.midi ?? 74) - 7
        : previousCounter + (leadMotion > 0 ? -2 : leadMotion < 0 ? 2 : 0);
      const phraseDirection = ((barPlan.bar + opts.seed) & 1) === 0 ? 1 : -1;
      const shapedTarget = index === 0 || previousCounter === null
        ? contraryTarget
        : previousCounter + (index === barPlan.counterSteps.length - 1 ? -phraseDirection * 2 : phraseDirection * 3);
      let midi = nearestWithPc(shapedTarget, melodyPcsForChord(chord), COUNTER_LO, COUNTER_HI);
      if (barPlan.counterSteps.length >= 3 && index === 0) phraseAnchor = midi;
      if (barPlan.counterSteps.length >= 3 && index === 1 && phraseAnchor !== null) {
        // 三音句の中央だけに、必ず次のコードトーンへ解決する経過音または刺繍音を許す。
        // コードトーンだけのアルペジオへ戻らず、線として聞こえる最小限の非和声音にする。
        const directions: readonly (1 | -1)[] = [phraseDirection, phraseDirection === 1 ? -1 : 1];
        for (const direction of directions) {
          const middle = stepOnScale(phraseAnchor, direction, scaleAt(chord));
          if (middle < COUNTER_LO || middle > COUNTER_HI) continue;
          const middlePc = middle % 12;
          if (chord.pcs.includes(middlePc)) continue;
          const forward = stepOnScale(middle, direction, scaleAt(chord));
          midi = middle;
          pendingResolution = forward >= COUNTER_LO
            && forward <= COUNTER_HI
            && chord.pcs.includes(forward % 12)
            ? forward
            : phraseAnchor;
          break;
        }
      } else if (barPlan.counterSteps.length >= 3 && index === 2 && pendingResolution !== null) {
        midi = nearestWithPc(pendingResolution, melodyPcsForChord(chord), COUNTER_LO, COUNTER_HI);
      }
      const nextCounterBeat = barPlan.counterSteps[index + 1] !== undefined
        ? grooveBeat(barStart + barPlan.counterSteps[index + 1]! * 0.5, grooveFeel)
        : barStart + 4;
      const boundary = Math.min(leadAfter?.beat ?? barStart + 4, nextCounterBeat);
      const shortCounterPhrase = barPlan.counterSteps.length >= 3;
      const counterDurs = style.counterMaxDur ?? { counterline: 0.85, response: 0.4 };
      const maxDur = arrangementPlan.counterRole === 'counterline'
        ? shortCounterPhrase ? 0.38 : counterDurs.counterline
        : counterDurs.response;
      const dur = Math.min(maxDur, boundary - beat - 0.05);
      if (dur >= 0.15) {
        counterMelody.push({
          beat,
          dur,
          midi,
          velocity: Math.max(0.4, barPlan.dynamic - 0.12),
          articulation: shortCounterPhrase
            ? 'staccato'
            : arrangementPlan.counterRole === 'counterline' ? 'tenuto' : 'staccato',
          role: 'structural',
        });
        previousCounter = midi;
      }
    }
  }

  // --- 保続ガイドライン（進行から導出した最短連結ストランドのロングトーン化） ---
  // 実音ラインは手書きせず、コード列の声部連結から毎回導出する。発音区間は
  // 他の対旋律装置と同じく編成計画の counterDensity に従い、常設レイヤーにしない。
  if (arrangementPlan.counterRole === 'guideline') {
    const strand = featuredGuideStrand(
      chords.map((chord) => chord.pcs),
      chords.map((chord) => chord.pcs[0]!),
    );
    let previousGuide: number | null = null;
    if (strand) {
      chords.forEach((chord, index) => {
        const bar = Math.min(opts.bars - 1, Math.floor(chord.beat / 4));
        const sectionIndex = opts.bars === 40 ? Math.floor(bar / 8) : opts.bars === 16 && bar >= 8 ? 1 : 0;
        const sectionPlan = arrangementPlan.sections[sectionIndex] ?? arrangementPlan.sectionA;
        if (sectionPlan.counterDensity === 0) {
          previousGuide = null;
          return;
        }
        // 主旋律域(C5以上)との完全ユニゾンを避け、対旋律域の中でも主旋律の下に敷く。
        const midi = nearestWithPc(previousGuide ?? 67, [strand.pcs[index]!], COUNTER_LO, MELODY_LO - 1);
        counterMelody.push({
          beat: chord.beat,
          dur: Math.max(0.5, chord.dur - 0.05),
          midi,
          velocity: Math.max(0.35, phrasePlan.bars[bar]!.dynamic - 0.16),
          articulation: 'tenuto',
          role: 'structural',
        });
        previousGuide = midi;
      });
    }
  }
  return counterMelody;
}
