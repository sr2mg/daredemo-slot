/**
 * PieceをPCM(SoundFont)向けのGMノート列へ編曲し、オフライン合成する。
 *
 * OPLLの6声制約と違いPCMは同時発音に余裕があるため、声部スチールは行わず、
 * バッキングは分解済みボイシング(chord.midis)を持続和音としてそのまま鳴らす。
 * 00年代GM/GS音源のMMO BGM(SC-88系)の編成をスタイル別プログラムマップで再現する。
 */

import type { Piece } from '../core/music/compose.js';
import type { PcmBgmDef } from './bgm-audio.js';
import { renderSf2 } from './sf2.js';
import type { Sf2Font, Sf2Note } from './sf2.js';

export const SF2_SAMPLE_RATE = 44100;

interface GmProgramMap {
  lead: number;
  counter: number;
  ostinato: number;
  backing: number;
  bass: number;
}

/** スタイル別GMプログラム(0基点)。kmmoのリードはGM内で二胡に最も近いFiddle。 */
const STYLE_PROGRAMS: Record<string, GmProgramMap> = {
  kmmo: { lead: 110, counter: 73, ostinato: 46, backing: 48, bass: 33 },
  eurobeat: { lead: 81, counter: 80, ostinato: 4, backing: 50, bass: 38 },
  rock: { lead: 30, counter: 29, ostinato: 27, backing: 17, bass: 33 },
  ska: { lead: 56, counter: 66, ostinato: 26, backing: 16, bass: 33 },
};
const DEFAULT_PROGRAMS: GmProgramMap = { lead: 0, counter: 73, ostinato: 46, backing: 48, bass: 33 };

/** GMパーカッション(bank128)のキー。 */
const DRUM_KEYS: Record<string, { key: number; velocity: number }> = {
  kick: { key: 36, velocity: 105 },
  snare: { key: 38, velocity: 100 },
  hat: { key: 42, velocity: 78 },
  tom: { key: 47, velocity: 96 },
  cymbal: { key: 49, velocity: 100 },
};

const velocityOf = (value: number | undefined): number =>
  Math.max(1, Math.min(127, Math.round(30 + (value ?? 0.75) * 97)));

export function arrangeSf2Notes(piece: Piece): Sf2Note[] {
  const programs = STYLE_PROGRAMS[piece.styleId] ?? DEFAULT_PROGRAMS;
  const spb = 60 / piece.bpm;
  const notes: Sf2Note[] = [];
  const pushPart = (
    events: readonly { beat: number; dur: number; midi: number; velocity?: number }[],
    program: number,
    gain: number,
  ): void => {
    for (const event of events) {
      notes.push({
        program,
        bank: 0,
        midi: event.midi,
        velocity: velocityOf(event.velocity),
        startSec: event.beat * spb,
        durSec: Math.max(0.03, event.dur * spb),
        gain,
      });
    }
  };
  pushPart(piece.melody, programs.lead, 1.0);
  pushPart(piece.counterMelody, programs.counter, 0.65);
  pushPart(piece.ostinato, programs.ostinato, 0.6);
  pushPart(piece.bass, programs.bass, 0.9);
  // バッキング: ボイシング全声部を持続和音で。PCMでは出し引きより響きの厚みを優先する。
  for (const chord of piece.chords) {
    for (const midi of chord.midis) {
      notes.push({
        program: programs.backing,
        bank: 0,
        midi,
        velocity: 68,
        startSec: chord.beat * spb,
        durSec: Math.max(0.05, chord.dur * spb * 0.97),
        gain: 0.5,
      });
    }
  }
  for (const drum of piece.drums) {
    const mapped = DRUM_KEYS[drum.inst];
    if (!mapped) continue;
    notes.push({
      program: 0,
      bank: 128,
      midi: mapped.key,
      velocity: mapped.velocity,
      startSec: drum.beat * spb,
      durSec: 0.2,
      gain: 0.9,
    });
  }
  return notes;
}

/** PieceをSoundFontで合成し、既存プレイヤーのPCM BGM形式で返す。 */
export function renderSf2Bgm(piece: Piece, font: Sf2Font): PcmBgmDef {
  const spb = 60 / piece.bpm;
  const loopEnd = piece.beats * spb;
  const wave = renderSf2(font, arrangeSf2Notes(piece), SF2_SAMPLE_RATE, loopEnd + 1.2);
  return {
    kind: 'pcm',
    wave,
    sampleRate: SF2_SAMPLE_RATE,
    loopStart: piece.loopStartBeat * spb,
    loopEnd,
  };
}
