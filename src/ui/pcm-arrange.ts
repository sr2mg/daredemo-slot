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
import {
  ambienceFor,
  panGains,
  pingPongDelay,
  ROLE_PROFILES,
  stereoChorus,
  stereoReverb,
  withEchoTracks,
} from './sound-design.js';

export const SF2_SAMPLE_RATE = 44100;

export type PcmPart = 'lead' | 'duet' | 'counter' | 'ostinato' | 'backing' | 'bass' | 'drums';
export interface PcmPresetRef {
  bank: number;
  program: number;
}
/** パート別の音色上書き。未指定パートはスタイル既定のGMプログラム。 */
export type PcmVoiceOverride = Partial<Record<PcmPart, PcmPresetRef>>;

export const PCM_PART_LABELS: Record<PcmPart, string> = {
  lead: '主旋律',
  duet: 'ハモリ',
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

/** パート別のノート列。音響プロファイル(パン・センド・エコー)をロール単位で適用するための形。 */
export function arrangeSf2Parts(
  piece: Piece,
  overrides: PcmVoiceOverride = {},
): Record<PcmPart, Sf2Note[]> {
  const programs = STYLE_PROGRAMS[piece.styleId] ?? DEFAULT_PROGRAMS;
  const refFor = (part: Exclude<PcmPart, 'drums' | 'duet'>): PcmPresetRef =>
    overrides[part] ?? { bank: 0, program: programs[part] };
  const drumRef = overrides.drums ?? { bank: 128, program: 0 };
  const spb = 60 / piece.bpm;
  const partFor = (
    events: readonly { beat: number; dur: number; midi: number; velocity?: number; glideFrom?: number }[],
    ref: PcmPresetRef,
    gain: number,
  ): Sf2Note[] => events.map((event) => ({
    program: ref.program,
    bank: ref.bank,
    midi: event.midi,
    velocity: velocityOf(event.velocity),
    startSec: event.beat * spb,
    durSec: Math.max(0.03, event.dur * spb),
    gain,
    ...(event.glideFrom !== undefined ? { glideFromMidi: event.glideFrom } : {}),
  }));
  // バッキング: ボイシング全声部を持続和音で。PCMでは出し引きより響きの厚みを優先する。
  const backing = refFor('backing');
  const backingNotes: Sf2Note[] = piece.chords.flatMap((chord) => chord.midis.map((midi) => ({
    program: backing.program,
    bank: backing.bank,
    midi,
    velocity: 68,
    startSec: chord.beat * spb,
    durSec: Math.max(0.05, chord.dur * spb * 0.97),
    gain: 0.5,
  })));
  const drumNotes: Sf2Note[] = [];
  for (const drum of piece.drums) {
    const mapped = DRUM_KEYS[drum.inst];
    if (!mapped) continue;
    drumNotes.push({
      program: drumRef.program,
      bank: drumRef.bank,
      midi: mapped.key,
      velocity: mapped.velocity,
      startSec: drum.beat * spb,
      durSec: 0.2,
      gain: 0.9,
    });
  }
  return {
    lead: partFor(piece.melody, refFor('lead'), 1.0),
    // ハモリ既定はリードと同じ音色(実測の「連れ」は同種の音)。上書きで別楽器にもできる。
    duet: partFor(piece.duet ?? [], overrides.duet ?? refFor('lead'), 0.55),
    counter: partFor(piece.counterMelody, refFor('counter'), 0.65),
    ostinato: partFor(piece.ostinato, refFor('ostinato'), 0.6),
    backing: backingNotes,
    bass: partFor(piece.bass, refFor('bass'), 0.9),
    drums: drumNotes,
  };
}

export function arrangeSf2Notes(piece: Piece, overrides: PcmVoiceOverride = {}): Sf2Note[] {
  return Object.values(arrangeSf2Parts(piece, overrides)).flat();
}

/**
 * PieceをSoundFontで合成し、既存プレイヤーのPCM BGM形式(ステレオ)で返す。
 *
 * ミキサーはSC-88+VS世代のバス構造を写す: パート別にドライ合成し、ロール別
 * プロファイル(sound-design.ts)でパン/リバーブ/コーラス/ディレイの各バスへ送る。
 * エコートラック(MIDI段)とフィードバックディレイ(オーディオ段)の二重時間軸。
 */
export function renderSf2Bgm(
  piece: Piece,
  font: Sf2Font,
  overrides: PcmVoiceOverride = {},
): PcmBgmDef {
  const spb = 60 / piece.bpm;
  const loopEnd = piece.beats * spb;
  const totalSec = loopEnd + 1.6;
  const length = Math.ceil(totalSec * SF2_SAMPLE_RATE);
  const dryLeft = new Float32Array(length);
  const dryRight = new Float32Array(length);
  const reverbBus = new Float32Array(length);
  const chorusBus = new Float32Array(length);
  const delayBus = new Float32Array(length);

  const ambience = ambienceFor(piece.styleId);
  const parts = arrangeSf2Parts(piece, overrides);
  for (const [part, baseNotes] of Object.entries(parts) as [PcmPart, Sf2Note[]][]) {
    const profile = ROLE_PROFILES[part]!;
    const notes = profile.echo ? withEchoTracks(baseNotes, profile.echo, spb) : baseNotes;
    if (notes.length === 0) continue;
    const wave = renderSf2(font, notes, SF2_SAMPLE_RATE, totalSec);
    const [gainLeft, gainRight] = panGains(profile.pan);
    const reverbSend = profile.reverbSend * ambience.reverbSendScale;
    for (let i = 0; i < length; i++) {
      const sample = wave[i]!;
      dryLeft[i] = dryLeft[i]! + sample * gainLeft;
      dryRight[i] = dryRight[i]! + sample * gainRight;
      if (reverbSend > 0) reverbBus[i] = reverbBus[i]! + sample * reverbSend;
      if (profile.chorusSend > 0) chorusBus[i] = chorusBus[i]! + sample * profile.chorusSend;
      if (profile.delaySend > 0) delayBus[i] = delayBus[i]! + sample * profile.delaySend;
    }
  }

  const reverb = stereoReverb(reverbBus, SF2_SAMPLE_RATE, ambience.reverbFeedback);
  const chorus = stereoChorus(chorusBus, SF2_SAMPLE_RATE);
  // ディレイは付点8分をテンポ同期で。フィードバック量が残響の伸びを決める(harakami則)。
  const delay = pingPongDelay(delayBus, SF2_SAMPLE_RATE, 0.75 * spb, ambience.delayFeedback);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    left[i] = Math.tanh(dryLeft[i]! + reverb.left[i]! + chorus.left[i]! + delay.left[i]!);
    right[i] = Math.tanh(dryRight[i]! + reverb.right[i]! + chorus.right[i]! + delay.right[i]!);
  }
  return {
    kind: 'pcm',
    wave: left,
    waveRight: right,
    sampleRate: SF2_SAMPLE_RATE,
    loopStart: piece.loopStartBeat * spb,
    loopEnd,
  };
}
