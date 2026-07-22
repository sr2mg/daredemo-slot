import type {
  NoteEvent, OpllUserPatchId, Piece, VoiceOverride,
} from '../core/music/compose.js';
import { arrangementSectionFor, grooveBeat } from '../core/music/compose.js';
import { initRhythmMode } from './mml.js';
import { SeqBuilder } from './opll-core.js';
import type { SfxDef } from './opll-core.js';

type MelodicPart = 'lead' | 'bass' | 'counter' | 'ostinato' | 'backing' | 'doubling';

export interface VoiceAllocationStats {
  assigned: number;
  dropped: number;
  maxConcurrent: number;
  parts: Record<MelodicPart, { assigned: number; dropped: number }>;
}

/** 編曲済み BGM（レジスタ列 + ループ検算用のメタ） */
export interface ArrangedBgm extends SfxDef {
  bpm: number;
  /** ループ本体の4/4換算小節数（イントロを含めない） */
  bars: number;
  /** AudioBufferSourceNode に渡す、初回イントロ後のループ区間（秒）。 */
  loopStart: number;
  loopEnd: number;
  /** OPLLの旋律6chへ優先度順に収めた結果。 */
  voiceStats: VoiceAllocationStats;
}

export interface StyleVoices {
  lead: number;
  backing: number;
  bass: number;
  counter: number;
  ostinato: number;
  /** バッキングの刻み: offbeat = 裏打ち 8 分 / half = 2 分音符サステイン */
  backingPattern: 'offbeat' | 'half';
}

/** YM2413の音色0番へ書き込める、曲単位のユーザー音色。 */
export const OPLL_USER_PATCHES: readonly {
  id: OpllUserPatchId;
  label: string;
  regs: readonly [number, number, number, number, number, number, number, number];
}[] = [
  { id: 'brightLead', label: 'ブライト・リード', regs: [0x71, 0x61, 0x1e, 0x17, 0xd0, 0x78, 0x00, 0x17] },
  { id: 'metalBell', label: 'メタリック・ベル', regs: [0x21, 0x21, 0x1c, 0x07, 0xf0, 0xf0, 0x45, 0x76] },
  { id: 'punchBass', label: 'パンチ・ベース', regs: [0x31, 0x21, 0x16, 0x05, 0xf8, 0x81, 0x26, 0x17] },
];

/** スタイル → 内蔵音色の割り当て（0〜15。0はユーザー音色） */
const STYLE_VOICES: Record<string, StyleVoices> = {
  eurobeat: {
    lead: 4, backing: 8, bass: 8, counter: 3, ostinato: 4, backingPattern: 'offbeat',
  },
  rock: {
    lead: 4, backing: 15, bass: 8, counter: 3, ostinato: 4, backingPattern: 'half',
  },
  ska: {
    lead: 4, backing: 8, bass: 8, counter: 3, ostinato: 4, backingPattern: 'offbeat',
  },
};
const DEFAULT_VOICES: StyleVoices = STYLE_VOICES['eurobeat']!;

/** スタイルの既定音色（UI の「スタイル既定（○○）」表示用） */
export function defaultVoicesFor(styleId: string): StyleVoices {
  return STYLE_VOICES[styleId] ?? DEFAULT_VOICES;
}

/** 上書きから有効な音色（ユーザー音色0〜内蔵15）だけ拾う。 */
function pickVoices(override?: VoiceOverride): Partial<StyleVoices> {
  const out: Partial<StyleVoices> = {};
  for (const part of ['lead', 'backing', 'bass', 'counter', 'ostinato'] as const) {
    const voice = override?.[part];
    if (typeof voice === 'number' && Number.isInteger(voice) && voice >= 0 && voice <= 15) {
      out[part] = voice;
    }
  }
  return out;
}

const midiFreq = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
const volumeFor = (note: NoteEvent, fallback: number): number => note.velocity === undefined
  ? fallback
  : Math.max(0, Math.min(15, Math.round(12 - note.velocity * 11)));

const DRUM_BITS: Record<Piece['drums'][number]['inst'], number> = {
  kick: 0x10,
  snare: 0x08,
  tom: 0x04,
  cymbal: 0x02,
  hat: 0x01,
};

const PART_PRIORITY: Record<MelodicPart, number> = {
  lead: 100,
  bass: 90,
  counter: 75,
  ostinato: 65,
  backing: 50,
  doubling: 30,
};

interface Candidate {
  part: MelodicPart;
  beat: number;
  dur: number;
  midi: number;
  voice: number;
  volume: number;
  vibrato: boolean;
  shake: boolean;
  priority: number;
}

interface AssignedCandidate extends Candidate {
  ch: number;
  endBeat: number;
}

const emptyPartStats = (): VoiceAllocationStats['parts'] => ({
  lead: { assigned: 0, dropped: 0 },
  bass: { assigned: 0, dropped: 0 },
  counter: { assigned: 0, dropped: 0 },
  ostinato: { assigned: 0, dropped: 0 },
  backing: { assigned: 0, dropped: 0 },
  doubling: { assigned: 0, dropped: 0 },
});

/**
 * リズムモード時の旋律6chを、音楽上の重要度で動的に割り当てる。
 * 6音を超えた瞬間は低優先度声部を切り、主旋律とベースを常に残す。
 */
function allocateSixChannels(candidates: readonly Candidate[]): {
  notes: AssignedCandidate[];
  stats: VoiceAllocationStats;
} {
  const sorted = [...candidates].sort((a, b) => a.beat - b.beat || b.priority - a.priority);
  const active: AssignedCandidate[] = [];
  const notes: AssignedCandidate[] = [];
  const freeChannels = [0, 1, 2, 3, 4, 5];
  const parts = emptyPartStats();
  let dropped = 0;

  for (const candidate of sorted) {
    for (let index = active.length - 1; index >= 0; index--) {
      if (active[index]!.endBeat <= candidate.beat + 0.0001) {
        freeChannels.push(active[index]!.ch);
        active.splice(index, 1);
      }
    }
    freeChannels.sort((a, b) => a - b);
    let ch = freeChannels.shift();
    if (ch === undefined) {
      const steal = [...active]
        .filter((note) => note.priority < candidate.priority)
        .sort((a, b) => a.priority - b.priority || b.endBeat - a.endBeat)[0];
      if (steal) {
        steal.endBeat = candidate.beat;
        ch = steal.ch;
        active.splice(active.indexOf(steal), 1);
      }
    }
    if (ch === undefined) {
      dropped++;
      parts[candidate.part].dropped++;
      continue;
    }
    const assigned: AssignedCandidate = {
      ...candidate,
      ch,
      endBeat: candidate.beat + candidate.dur,
    };
    notes.push(assigned);
    active.push(assigned);
    parts[candidate.part].assigned++;
  }

  const boundaries = notes.flatMap((note) => [
    { beat: note.beat, delta: 1 },
    { beat: note.endBeat, delta: -1 },
  ]).sort((a, b) => a.beat - b.beat || a.delta - b.delta);
  let concurrent = 0;
  let maxConcurrent = 0;
  for (const boundary of boundaries) {
    concurrent += boundary.delta;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
  }
  return { notes, stats: { assigned: notes.length, dropped, maxConcurrent, parts } };
}

function noteCandidate(
  part: MelodicPart,
  note: NoteEvent,
  voice: number,
  fallbackVolume: number,
): Candidate {
  return {
    part,
    beat: note.beat,
    dur: note.dur,
    midi: note.midi,
    voice,
    volume: volumeFor(note, fallbackVolume),
    vibrato: part === 'lead' && note.articulation !== 'staccato' && note.dur >= 1,
    shake: part === 'lead' && note.ornament === 'shake',
    priority: PART_PRIORITY[part],
  };
}

/** Piece をOPLLの「旋律6音 + リズム5音」へ編曲する。 */
export function arrangePiece(
  piece: Piece,
  styleId: string,
  override?: VoiceOverride,
  userPatchId: OpllUserPatchId = 'brightLead',
): ArrangedBgm {
  const voices = { ...(STYLE_VOICES[styleId] ?? DEFAULT_VOICES), ...pickVoices(override) };
  const spb = 60 / piece.bpm;
  const duration = piece.beats * spb;
  const loopStart = piece.loopStartBeat * spb;
  const b = new SeqBuilder();
  const selectedPatch = OPLL_USER_PATCHES.find((patch) => patch.id === userPatchId) ?? OPLL_USER_PATCHES[0]!;
  selectedPatch.regs.forEach((value, reg) => b.raw(reg, value, 0));

  const candidates: Candidate[] = [];
  for (const note of piece.melody) {
    const strong = note.beat % 4 === 0 || note.beat % 4 === 2;
    candidates.push(noteCandidate('lead', note, voices.lead, strong ? 2 : 4));
    const section = arrangementSectionFor(piece, note.beat);
    if (note.beat >= piece.loopStartBeat && section.echo && note.role !== 'ornament') {
      const delay = piece.grooveFeel === 'bounce' ? 2 / 3 : 1 / 2;
      let beat = note.beat + delay;
      if (beat >= piece.beats) beat = piece.loopStartBeat + beat - piece.beats;
      const dur = Math.min(note.dur, piece.beats - beat);
      if (dur >= 0.08) {
        candidates.push({
          ...noteCandidate('doubling', { ...note, beat, dur }, voices.lead, 8),
          volume: Math.max(7, volumeFor(note, 4) + 3),
        });
      }
    }
  }
  for (const note of piece.bass) candidates.push(noteCandidate('bass', note, voices.bass, 2));
  for (const note of piece.counterMelody) candidates.push(noteCandidate('counter', note, voices.counter, 5));
  for (const note of piece.ostinato ?? []) candidates.push(noteCandidate('ostinato', note, voices.ostinato, 7));

  // コードの中央声部を単音リフとして刻む。独立声部が多い瞬間だけアロケータが先に落とす。
  for (const chord of piece.chords) {
    const lowerVoice = chord.midis[1] ?? chord.midis[0]!;
    const upperVoice = chord.midis[2] ?? lowerVoice;
    const section = arrangementSectionFor(piece, chord.beat);
    const thin = chord.beat < piece.loopStartBeat || section.backingDensity === 'sparse';
    const volume = thin ? 9 : 7;
    if (voices.backingPattern === 'offbeat') {
      for (let beat = 0; beat < chord.dur; beat++) {
        if (thin && beat % 2 === 0) continue;
        candidates.push({
          part: 'backing',
          beat: grooveBeat(chord.beat + beat + 0.5, piece.grooveFeel),
          dur: 0.2,
          midi: beat % 2 === 0 ? lowerVoice : upperVoice,
          voice: voices.backing,
          volume,
          vibrato: false,
          shake: false,
          priority: PART_PRIORITY.backing,
        });
      }
    } else {
      for (let beat = 0; beat < chord.dur; beat += 2) {
        if (thin && beat > 0) continue;
        candidates.push({
          part: 'backing',
          beat: chord.beat + beat,
          dur: Math.min(2, chord.dur - beat) * 0.75,
          midi: lowerVoice,
          voice: voices.backing,
          volume,
          vibrato: false,
          shake: false,
          priority: PART_PRIORITY.backing,
        });
      }
    }
  }

  const allocation = allocateSixChannels(candidates);
  allocation.notes.sort((a, b) => a.beat - b.beat || b.priority - a.priority);
  for (const note of allocation.notes) {
    if (note.endBeat - note.beat < 0.02) continue;
    const start = note.beat * spb;
    const end = note.endBeat * spb;
    const freq = midiFreq(note.midi);
    b.keyOn(note.ch, note.voice, note.volume, freq, start);
    if (note.shake || note.vibrato) {
      const from = note.shake ? start : start + (end - start) * 0.3;
      const depth = note.shake ? 32 : 10;
      const hz = note.shake ? 8.5 : 5.5;
      for (let at = from; at < end; at += note.shake ? 0.018 : 0.025) {
        const cents = depth * Math.sin(2 * Math.PI * hz * (at - from));
        b.pitch(note.ch, freq * 2 ** (cents / 1200), at);
      }
    }
    b.keyOff(note.ch, end);
  }

  // リズムモードではch6〜8が、バスドラム／スネア／タム／シンバル／ハイハットになる。
  initRhythmMode(b);
  const hits = new Map<number, number>();
  for (const drum of piece.drums) {
    const at = drum.beat * spb;
    hits.set(at, (hits.get(at) ?? 0) | DRUM_BITS[drum.inst]);
  }
  for (const [at, bits] of hits) {
    b.raw(0x0e, 0x20, at);
    b.raw(0x0e, 0x20 | bits, at + 0.004);
  }

  return {
    bpm: piece.bpm,
    bars: piece.bars,
    loopStart,
    loopEnd: duration,
    duration,
    events: b.events,
    voiceStats: allocation.stats,
  };
}
