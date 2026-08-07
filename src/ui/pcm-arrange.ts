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

export type PcmPart = 'lead' | 'counter' | 'ostinato' | 'backing' | 'bass' | 'drums';
export interface PcmPresetRef {
  bank: number;
  program: number;
}
/** パート別の音色上書き。未指定パートはスタイル既定のGMプログラム。 */
export type PcmVoiceOverride = Partial<Record<PcmPart, PcmPresetRef>>;

export const PCM_PART_LABELS: Record<PcmPart, string> = {
  lead: '主旋律',
  counter: '副旋律',
  ostinato: '分散和音',
  backing: '伴奏',
  bass: 'ベース',
  drums: 'ドラム',
};

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

export function arrangeSf2Notes(piece: Piece, overrides: PcmVoiceOverride = {}): Sf2Note[] {
  const programs = STYLE_PROGRAMS[piece.styleId] ?? DEFAULT_PROGRAMS;
  const refFor = (part: Exclude<PcmPart, 'drums'>): PcmPresetRef =>
    overrides[part] ?? { bank: 0, program: programs[part] };
  const drumRef = overrides.drums ?? { bank: 128, program: 0 };
  const spb = 60 / piece.bpm;
  const notes: Sf2Note[] = [];
  const pushPart = (
    events: readonly { beat: number; dur: number; midi: number; velocity?: number }[],
    ref: PcmPresetRef,
    gain: number,
  ): void => {
    for (const event of events) {
      notes.push({
        program: ref.program,
        bank: ref.bank,
        midi: event.midi,
        velocity: velocityOf(event.velocity),
        startSec: event.beat * spb,
        durSec: Math.max(0.03, event.dur * spb),
        gain,
      });
    }
  };
  pushPart(piece.melody, refFor('lead'), 1.0);
  pushPart(piece.counterMelody, refFor('counter'), 0.65);
  pushPart(piece.ostinato, refFor('ostinato'), 0.6);
  pushPart(piece.bass, refFor('bass'), 0.9);
  // バッキング: ボイシング全声部を持続和音で。PCMでは出し引きより響きの厚みを優先する。
  const backing = refFor('backing');
  for (const chord of piece.chords) {
    for (const midi of chord.midis) {
      notes.push({
        program: backing.program,
        bank: backing.bank,
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
      program: drumRef.program,
      bank: drumRef.bank,
      midi: mapped.key,
      velocity: mapped.velocity,
      startSec: drum.beat * spb,
      durSec: 0.2,
      gain: 0.9,
    });
  }
  return notes;
}

/**
 * Schroeder型のモノラルリバーブ。素のGMサンプルを無響で鳴らすと必ず安っぽくなる
 * (SC-88系の「らしさ」の相当部分は内蔵リバーブ)ため、控えめなホール残響を常時掛ける。
 * コム4本+オールパス2本の古典構成。オフラインなので素直な実装でよい。
 */
function applyReverb(wave: Float32Array, sampleRate: number, wet = 0.24): void {
  const combDelaysMs = [29.7, 37.1, 41.1, 43.7];
  const combFeedback = 0.76;
  const allpassDelaysMs = [5.0, 1.7];
  const allpassGain = 0.7;
  const combBuffers = combDelaysMs.map((ms) => new Float32Array(Math.round(ms * sampleRate / 1000)));
  const combIndices = combDelaysMs.map(() => 0);
  const allpassBuffers = allpassDelaysMs.map((ms) => new Float32Array(Math.round(ms * sampleRate / 1000)));
  const allpassIndices = allpassDelaysMs.map(() => 0);
  for (let i = 0; i < wave.length; i++) {
    const dry = wave[i]!;
    let combSum = 0;
    for (let c = 0; c < combBuffers.length; c++) {
      const buffer = combBuffers[c]!;
      const index = combIndices[c]!;
      const delayed = buffer[index]!;
      buffer[index] = dry + delayed * combFeedback;
      combIndices[c] = (index + 1) % buffer.length;
      combSum += delayed;
    }
    let wetSample = combSum / combBuffers.length;
    for (let a = 0; a < allpassBuffers.length; a++) {
      const buffer = allpassBuffers[a]!;
      const index = allpassIndices[a]!;
      const delayed = buffer[index]!;
      const input = wetSample;
      wetSample = -input * allpassGain + delayed;
      buffer[index] = input + delayed * allpassGain;
      allpassIndices[a] = (index + 1) % buffer.length;
    }
    wave[i] = Math.tanh(dry + wetSample * wet);
  }
}

/** PieceをSoundFontで合成し、既存プレイヤーのPCM BGM形式で返す。 */
export function renderSf2Bgm(
  piece: Piece,
  font: Sf2Font,
  overrides: PcmVoiceOverride = {},
): PcmBgmDef {
  const spb = 60 / piece.bpm;
  const loopEnd = piece.beats * spb;
  const wave = renderSf2(font, arrangeSf2Notes(piece, overrides), SF2_SAMPLE_RATE, loopEnd + 1.2);
  applyReverb(wave, SF2_SAMPLE_RATE);
  return {
    kind: 'pcm',
    wave,
    sampleRate: SF2_SAMPLE_RATE,
    loopStart: piece.loopStartBeat * spb,
    loopEnd,
  };
}
