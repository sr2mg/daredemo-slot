/**
 * 初回だけ鳴る2小節イントロの実音化。
 * SongIntroPlan（song-plan.ts が本編より先に確定）を、A冒頭のモチーフ・
 * 入口ボイシングへの逆算接続として全声部（和声・旋律・ベース・ドラム）に展開する。
 */

import {
  CHORDS, MELODY_HI, MELODY_LO, chordName, drumPatternStep, harmonicFunctionForToken,
  chordScalePcs,
} from './theory.js';
import type { StyleDef } from './theory.js';
import { grooveBeat, grooveFor, tripletHatOffsets } from './groove.js';
import type { GrooveFeel } from './groove.js';
import { bridgeWithPc, nearestWithPc, stepOnScale } from './pitch.js';
import { voiceChord } from './voicing.js';
import type {
  ChordEvent,
  DrumEvent,
  MelodicLanguage,
  NoteArticulation,
  NoteEvent,
  SongIntroPlan,
  SongPlan,
} from './types.js';


export interface RealizedIntro {
  chords: ChordEvent[];
  melody: NoteEvent[];
  bass: NoteEvent[];
  drums: DrumEvent[];
  chordNames: string[];
}

/** SongPlanの導入意図を、本編Aへの声部接続を見ながら実イベントへする。 */
export function realizeIntro(
  plan: SongPlan['intro'],
  bodyChords: readonly ChordEvent[],
  bodyMelody: readonly NoteEvent[],
  style: StyleDef,
  keyRoot: number,
  scalePcs: readonly number[],
  melodicLanguage: MelodicLanguage,
  grooveFeel: GrooveFeel,
): RealizedIntro {
  if (!plan.enabled || plan.bars === 0) {
    return { chords: [], melody: [], bass: [], drums: [], chordNames: [] };
  }
  const firstBodyChord = bodyChords[0]!;
  const bodyMotif = bodyMelody.filter((note) => note.beat < 4 && note.role !== 'ornament');
  const firstLead = bodyMotif[0] ?? bodyMelody[0]!;
  const endBeat = 8 - plan.breakBeats;
  const chords: ChordEvent[] = [];
  const chordNames = plan.barPlans.map((barPlan) => (
    barPlan.tokens.map((token) => chordName(token, keyRoot)).join(' ')
  ));

  for (const barPlan of plan.barPlans) {
    let offset = 0;
    barPlan.tokens.forEach((token, index) => {
      const def = CHORDS[token]!;
      const pcs = def.tones.map((tone) => (tone + keyRoot) % 12);
      const dur = barPlan.durations[index]!;
      chords.push({
        beat: barPlan.bar * 4 + offset,
        dur,
        token,
        name: chordName(token, keyRoot),
        function: harmonicFunctionForToken(token),
        pcs,
        midis: [],
      });
      offset += dur;
    });
  }
  // A冒頭から逆向きに最短距離ボイシングを選び、イントロ末尾を実際の入口へ接続する。
  let nextVoicing: number[] | null = firstBodyChord.midis;
  for (let index = chords.length - 1; index >= 0; index--) {
    const chord = chords[index]!;
    chord.midis = voiceChord(chord.pcs, nextVoicing, melodicLanguage === 'japanese');
    nextVoicing = chord.midis;
  }
  const chordAt = (beat: number): ChordEvent => {
    let current = chords[0]!;
    for (const chord of chords) {
      if (chord.beat <= beat) current = chord;
      else break;
    }
    return current;
  };
  const melodicPcs = (chord: ChordEvent): readonly number[] => {
    const modal = chord.pcs.filter((pc) => scalePcs.includes(pc));
    return melodicLanguage === 'japanese' && modal.length > 0 ? modal : chord.pcs;
  };
  // 本編と同じコードスケール法則をイントロの弱拍にも適用する（V7mの導音等）。
  const introChordScaleCache = new Map<string, readonly number[]>();
  const scaleAt = (chord: ChordEvent): readonly number[] => {
    // 本編と同じ規則: 五音系語法は旋律語彙が固定で、コードスケールの上書きを受けない。
    if (melodicLanguage !== 'standard') return scalePcs;
    let cached = introChordScaleCache.get(chord.token);
    if (!cached) {
      cached = chordScalePcs(scalePcs, chord.pcs, (CHORDS[chord.token]!.root + keyRoot) % 12);
      introChordScaleCache.set(chord.token, cached);
    }
    return cached;
  };

  const melody: NoteEvent[] = [];
  const pushLead = (
    logicalBeat: number,
    dur: number,
    targetMidi: number,
    velocity: number,
    articulation: NoteArticulation = 'normal',
    exact = false,
  ) => {
    const beat = grooveBeat(logicalBeat, grooveFeel);
    const available = endBeat - beat;
    if (available < 0.08) return;
    const inBar = ((logicalBeat % 4) + 4) % 4;
    const chord = chordAt(logicalBeat);
    const strong = Math.abs(inBar) < 0.001 || Math.abs(inBar - 2) < 0.001;
    const midi = exact
      ? targetMidi
      : strong
        ? nearestWithPc(targetMidi, melodicPcs(chord))
        : nearestWithPc(targetMidi, scaleAt(chord));
    melody.push({
      beat,
      dur: Math.min(dur, available),
      midi,
      velocity,
      articulation: strong ? 'accent' : articulation,
      role: 'structural',
    });
  };

  for (const barPlan of plan.barPlans) {
    const barStart = barPlan.bar * 4;
    if (barPlan.leadGesture === 'motifFragment') {
      // Aの冒頭から特徴的な3〜4音を実音のまま抜き出し、未完のまま提示する
      // (フックの予告なので再スナップしない)。末尾が倚音(強拍の非和声音)で終わる
      // 場合は、解決音なしの宙吊りを置かないようその手前で切る。
      const quoted = bodyMotif.slice(0, Math.min(4, bodyMotif.length));
      while (quoted.length > 1) {
        const last = quoted[quoted.length - 1]!;
        const inBar = ((last.beat % 4) + 4) % 4;
        const strongBeat = Math.abs(inBar) < 0.001 || Math.abs(inBar - 2) < 0.001;
        if (!strongBeat || chordAt(last.beat).pcs.includes(((last.midi % 12) + 12) % 12)) break;
        quoted.pop();
      }
      for (const source of quoted) {
        pushLead(source.beat, Math.min(0.65, source.dur * 0.8), source.midi, 0.58, 'normal', true);
      }
    } else if (barPlan.leadGesture === 'motifAnswer') {
      const sources = bodyMotif.slice(0, 3);
      const onsets = [barStart, barStart + 1.5, Math.max(barStart + 2, endBeat - 0.5)];
      let previous = nearestWithPc(sources[0]?.midi ?? firstLead.midi, melodicPcs(chordAt(barStart)));
      onsets.forEach((onset, index) => {
        if (index > 0 && index < onsets.length - 1) {
          const before = sources[index - 1];
          const source = sources[index];
          const interval = before && source ? source.midi - before.midi : 2;
          previous = nearestWithPc(previous + interval, scalePcs);
        }
        if (index === onsets.length - 1) previous = stepOnScale(firstLead.midi, -1, scalePcs);
        const next = onsets[index + 1] ?? endBeat;
        pushLead(onset, Math.min(0.6, (next - onset) * 0.65), previous, 0.64);
      });
    } else if (barPlan.leadGesture === 'pickup') {
      const onsets = [barStart + 2, barStart + 2.5, barStart + 3, barStart + 3.5];
      const pitches = Array<number>(onsets.length);
      pitches[pitches.length - 1] = stepOnScale(firstLead.midi, -1, scalePcs);
      for (let index = pitches.length - 2; index >= 0; index--) {
        pitches[index] = stepOnScale(pitches[index + 1]!, -1, scalePcs);
      }
      onsets.forEach((onset, index) => pushLead(onset, 0.32, pitches[index]!, 0.66, 'staccato'));
    } else if (barPlan.leadGesture === 'fanfareCall' || barPlan.leadGesture === 'fanfareAnswer') {
      const onsets = barPlan.leadGesture === 'fanfareCall'
        ? [barStart, barStart + 1, barStart + 2, barStart + 3]
        : [barStart, barStart + 1, barStart + 2];
      onsets.forEach((onset, index) => {
        const chord = chordAt(onset);
        const target = firstLead.midi - 5 + index * 3 + (barPlan.bar === 1 ? 2 : 0);
        pushLead(onset, index === onsets.length - 1 ? 0.72 : 0.48, nearestWithPc(target, melodicPcs(chord)), 0.78);
      });
    } else if (barPlan.leadGesture === 'heldCall') {
      pushLead(barStart, 1.4, nearestWithPc(firstLead.midi - 5, melodicPcs(chordAt(barStart))), 0.6, 'tenuto');
      pushLead(barStart + 2, 0.9, nearestWithPc(firstLead.midi - 2, melodicPcs(chordAt(barStart + 2))), 0.64, 'tenuto');
    } else if (barPlan.leadGesture === 'scaleRun') {
      const onsets = [barStart + 2.5, barStart + 2.75, barStart + 3, barStart + 3.25, barStart + 3.5, barStart + 3.75];
      const pitches = Array<number>(onsets.length);
      pitches[pitches.length - 1] = stepOnScale(firstLead.midi, -1, scalePcs);
      for (let index = pitches.length - 2; index >= 0; index--) {
        pitches[index] = stepOnScale(pitches[index + 1]!, -1, scalePcs);
      }
      onsets.forEach((onset, index) => pushLead(onset, 0.16, pitches[index]!, 0.68, 'staccato'));
    }
  }

  const bass: NoteEvent[] = [];
  const pushBass = (logicalBeat: number, dur: number, upper = false) => {
    if (logicalBeat >= endBeat) return;
    const chord = chordAt(logicalBeat);
    const def = CHORDS[chord.token]!;
    const rootPc = (def.root + keyRoot) % 12;
    const alternatePc = style.bass === 'rootFifth'
      ? chord.pcs[Math.min(2, chord.pcs.length - 1)]!
      : rootPc;
    const pc = upper ? alternatePc : rootPc;
    let midi = nearestWithPc(43, [pc], 36, 64);
    if (upper && style.bass === 'octave8' && midi + 12 <= 64) midi += 12;
    const beat = grooveBeat(logicalBeat, grooveFeel);
    bass.push({
      beat,
      dur: Math.min(dur, endBeat - beat),
      midi,
      velocity: 0.62,
      articulation: 'staccato',
      role: 'structural',
    });
  };
  for (const barPlan of plan.barPlans) {
    const start = barPlan.bar * 4;
    if (barPlan.bassGesture === 'pedal') {
      pushBass(start, 0.65);
      pushBass(start + 2, 0.55, true);
    } else if (barPlan.bassGesture === 'groove') {
      [0, 0.5, 1.5, 2, 2.5, 3.5].forEach((offset, index) => pushBass(start + offset, 0.28, index % 2 === 1));
    } else if (barPlan.bassGesture === 'stopForLead') {
      [0, 0.5, 1.5].forEach((offset, index) => pushBass(start + offset, 0.3, index % 2 === 1));
    } else if (barPlan.bassGesture === 'hits') {
      pushBass(start, 0.5);
      pushBass(start + 2, 0.5, true);
    } else if (barPlan.bassGesture === 'pickup') {
      pushBass(start, 0.45);
      pushBass(Math.min(start + 2, endBeat - 0.75), 0.35, true);
    }
  }

  const drums: DrumEvent[] = [];
  for (const barPlan of plan.barPlans) {
    const start = barPlan.bar * 4;
    const addDrum = (beat: number, inst: DrumEvent['inst'], level = 1) => {
      if (beat >= endBeat || level <= 0) return;
      drums.push(level < 1 ? { beat, inst, velocity: level } : { beat, inst });
    };
    const hatOverlay = grooveFor(grooveFeel).subdivisionOverlay;
    if (barPlan.drumGesture === 'groove') {
      for (let step = 0; step < 16; step++) {
        const beat = grooveBeat(start + step * 0.25, grooveFeel);
        addDrum(beat, 'kick', drumPatternStep(style.kick, barPlan.bar, step));
        addDrum(beat, 'snare', drumPatternStep(style.snare, barPlan.bar, step));
        if (hatOverlay === 'none') addDrum(beat, 'hat', drumPatternStep(style.hat, barPlan.bar, step));
      }
      if (hatOverlay === 'triplet') {
        const hatWindowStart = (barPlan.bar * 16) % style.hat.length;
        const hatWindow = style.hat.slice(hatWindowStart, hatWindowStart + 16);
        for (let quarter = 0; quarter < 4; quarter++) {
          for (const offset of tripletHatOffsets(hatWindow, quarter)) addDrum(start + quarter + offset, 'hat');
        }
      }
    } else if (barPlan.drumGesture === 'accents') {
      addDrum(start, 'kick');
      addDrum(start, 'cymbal');
      addDrum(start + 2, 'snare');
    } else if (barPlan.drumGesture === 'fill') {
      addDrum(start, 'kick');
      addDrum(start + 2, 'snare');
      addDrum(start + 2.5, 'tom');
      addDrum(start + 3, 'tom');
      addDrum(start + 3.5, 'tom');
    } else if (barPlan.drumGesture === 'countIn') {
      [1, 2, 3, 3.5].forEach((offset) => addDrum(start + offset, 'hat'));
      addDrum(start + 2, 'kick');
      addDrum(start + 3.5, 'snare');
    }
  }
  return { chords, melody, bass, drums, chordNames };
}
