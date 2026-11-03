import type {
  DrumEvent, NoteEvent, OpllUserPatchId, Piece, VoiceOverride,
} from '../core/music/types.js';
import { offbeatBackingRiff } from './backing-riff.js';
import { midiFreq } from './pitch.js';
import { arrangementSectionFor } from '../core/music/arrangement.js';
import {
  freqToFnum, initRhythmMode, RHYTHM_DEFAULT_LEVELS, RHYTHM_LEVEL_SLOT, rhythmLevelRegs, SeqBuilder,
} from './opll-core.js';
import type { SfxDef } from './opll-core.js';

import { glideDurationSec } from '../core/music/glide.js';
import type { StageRole } from './stage.js';
import { timbreFor } from './style-timbre.js';
import type { StyleVoices } from './style-timbre.js';
import { noteStageEchoFor } from './time-layer.js';

/**
 * OPLLの旋律パート語彙 = ミックスの役割語彙(stage.ts)からドラム(リズムモード担当)を
 * 除き、エコー装置の再発音枠(doubling)と、リズムモードBDの下へ重ねるサブキック(subKick)を
 * 足したもの。役割追加時は型エラーで網羅を強制。
 */
type MelodicPart = Exclude<StageRole, 'drums'> | 'doubling' | 'subKick';

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

/** スタイル別の音色定義は style-timbre.ts(1様式1レコード)が持つ。 */
export type { StyleVoices } from './style-timbre.js';

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

/** スタイルの既定音色（UI の「スタイル既定（○○）」表示用） */
export function defaultVoicesFor(styleId: string): StyleVoices {
  return timbreFor(styleId).opll;
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

const volumeFor = (note: NoteEvent, fallback: number): number => note.velocity === undefined
  ? fallback
  : Math.max(0, Math.min(15, Math.round(12 - note.velocity * 11)));

/**
 * ドラムのベロシティ(0..1)をリズム音量の減衰段数(3dB/段)へ写す。
 * ゴースト(DRUM_GHOST ≈ 0.30 = -10dB)は 3 段、拍節アクセント(-1.7〜-5dB)は 1〜2 段。
 */
const velocitySteps = (velocity: number | undefined): number => velocity === undefined
  ? 0
  : Math.max(0, Math.min(15, Math.round((-20 * Math.log10(Math.max(1e-3, velocity))) / 3)));

/** 次の打点との間に残す隙間(拍)。同一chでキーオフ→キーオンの順序を確実にする。 */
const LEGATO_GAP_BEATS = 0.05;

/**
 * キックの音高帯 = サブ帯 1 オクターブ [E1, E2)(MIDI 28〜39、41〜78Hz)。下限 E1 はベースの
 * 最低弦と同じで、ベース帯(E2〜)のちょうど 1 オクターブ下。根音をこの帯へ畳むとキックは
 * 常にベースの下か同度になり、別の音程として聞こえない。
 * 胴の長さと音高包絡は拍でなく物理時間: 膜の張力が緩むピッチ落ちは数倍の高さから
 * 40ms 前後で基音へ、胴の減衰は 200ms 弱。
 */
const KICK_LOWEST_MIDI = 28;
const SUB_KICK_BODY_SEC = 0.18;
const SUB_KICK_SWEEP_RATIO = 4;
const SUB_KICK_SWEEP_SEC = 0.04;

/**
 * ベースを次の低音打点の直前まで伸ばす(OPLL 向けのゲート)。短い刻み(kickSync の 0.18〜0.4 拍)
 * をそのまま鳴らすと低域が「点」になるので、譜面の音価を下限に次の打点まで持続させる。
 * 作曲(Piece)は変えず OPLL 編曲の中だけで行う。最後の音はループ末尾まで。
 */
/**
 * 拍 beat でキックが取るべき音高(MIDI)。その瞬間に鳴っているベース音、無ければ直前のベース音、
 * それも無ければコードのベース音(分数コードなら bassPc、通常はルート)の音名をサブ帯へ畳む。
 */
export function kickMidiAt(piece: Piece, beat: number): number {
  const sounding = piece.bass.filter((note) => note.beat <= beat + 1e-9);
  const current = sounding.find((note) => beat < note.beat + note.dur - 1e-9)
    ?? sounding.sort((a, b) => b.beat - a.beat)[0];
  let pc: number;
  if (current) {
    pc = current.midi % 12;
  } else {
    const chord = piece.chords.find((c) => c.beat <= beat && beat < c.beat + c.dur) ?? piece.chords[0];
    pc = chord ? chord.bassPc ?? chord.rootPc : piece.keyRoot;
  }
  return KICK_LOWEST_MIDI + (((pc - KICK_LOWEST_MIDI) % 12) + 12) % 12;
}

export function legatoBass(bass: readonly NoteEvent[], endBeat: number): NoteEvent[] {
  const sorted = [...bass].sort((a, b) => a.beat - b.beat);
  return sorted.map((note, index) => {
    const legato = (sorted[index + 1]?.beat ?? endBeat) - note.beat - LEGATO_GAP_BEATS;
    return legato > note.dur ? { ...note, dur: legato } : note;
  });
}

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
  // サブキックは低域の土台なのでベースの次。副旋律以下を押しのけ、主旋律とベースは奪わない。
  subKick: 80,
  counter: 75,
  ostinato: 65,
  backing: 50,
  // ハモリは「声部が空いているときだけ鳴る」低優先度枠(実機ドライバの様式)。
  duet: 45,
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
  /** ポルタメント: このMIDIノートの音高から滑って入る。 */
  glideFrom?: number;
  /** ピッチスイープ: fromFreq でキーオンし sec 秒で目標音高へ等比で落とす(サブキック)。 */
  sweep?: { fromFreq: number; sec: number };
}

interface AssignedCandidate extends Candidate {
  ch: number;
  endBeat: number;
}

const emptyPartStats = (): VoiceAllocationStats['parts'] => ({
  lead: { assigned: 0, dropped: 0 },
  bass: { assigned: 0, dropped: 0 },
  subKick: { assigned: 0, dropped: 0 },
  counter: { assigned: 0, dropped: 0 },
  ostinato: { assigned: 0, dropped: 0 },
  backing: { assigned: 0, dropped: 0 },
  duet: { assigned: 0, dropped: 0 },
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
    ...(part === 'lead' && note.glideFrom !== undefined ? { glideFrom: note.glideFrom } : {}),
  };
}

/** Piece をOPLLの「旋律6音 + リズム5音」へ編曲する。 */
export function arrangePiece(
  piece: Piece,
  styleId: string,
  override?: VoiceOverride,
  userPatchId: OpllUserPatchId = 'brightLead',
): ArrangedBgm {
  const voices = { ...timbreFor(styleId).opll, ...pickVoices(override) };
  const spb = 60 / piece.bpm;
  const duration = piece.beats * spb;
  const loopStart = piece.loopStartBeat * spb;
  const b = new SeqBuilder();
  const selectedPatch = OPLL_USER_PATCHES.find((patch) => patch.id === userPatchId) ?? OPLL_USER_PATCHES[0]!;
  selectedPatch.regs.forEach((value, reg) => b.raw(reg, value, 0));

  // 受け渡し: ユーザー上書きが無ければ、セクションのleadColorでパレットから音色を選ぶ。
  const leadPalette = override?.lead !== undefined || !voices.leadPalette || voices.leadPalette.length === 0
    ? [voices.lead]
    : voices.leadPalette;
  const leadVoiceAt = (beat: number): number =>
    leadPalette[(arrangementSectionFor(piece, beat).leadColor ?? 0) % leadPalette.length]!;

  const candidates: Candidate[] = [];
  for (const note of piece.melody) {
    const strong = note.beat % 4 === 0 || note.beat % 4 === 2;
    candidates.push(noteCandidate('lead', note, leadVoiceAt(note.beat), strong ? 2 : 4));
    const section = arrangementSectionFor(piece, note.beat);
    if (note.beat >= piece.loopStartBeat && section.echo && note.role !== 'ornament') {
      // 遅延則は二重時間軸のMIDI段(time-layer.ts)と同じ関数を参照する。タップ数と
      // 減衰だけは声部予算の都合でOPLL固有(1タップの音量+3ダブリング)。
      const delay = noteStageEchoFor(piece.grooveFeel).delayBeats;
      let beat = note.beat + delay;
      if (beat >= piece.beats) beat = piece.loopStartBeat + beat - piece.beats;
      const dur = Math.min(note.dur, piece.beats - beat);
      if (dur >= 0.08) {
        candidates.push({
          ...noteCandidate('doubling', { ...note, beat, dur }, leadVoiceAt(note.beat), 8),
          volume: Math.max(7, volumeFor(note, 4) + 3),
        });
      }
    }
  }
  const bassNotes = voices.bassGate === 'legato' ? legatoBass(piece.bass, piece.beats) : piece.bass;
  for (const note of bassNotes) candidates.push(noteCandidate('bass', note, voices.bass, 2));
  for (const note of piece.counterMelody) candidates.push(noteCandidate('counter', note, voices.counter, 5));
  for (const note of piece.ostinato ?? []) candidates.push(noteCandidate('ostinato', note, voices.ostinato, 7));
  // ハモリはその区間のリードと同じ音色。優先度45なので混雑時は自然に消える。
  // バランスはここが単独所有: リード比+2段(velocityは主旋律の継承で、調整には使わない)。
  for (const note of piece.duet) {
    const candidate = noteCandidate('duet', note, leadVoiceAt(note.beat), 7);
    candidate.volume = Math.min(15, candidate.volume + 2);
    candidates.push(candidate);
  }

  // サブキック: リズムモードBD(アタック)の下に旋律chのピッチスイープ(胴)を重ねる。
  if (voices.rhythm?.subKickVoice !== undefined) {
    const subKickVoice = voices.rhythm.subKickVoice;
    const kicks = piece.drums.filter((drum) => drum.inst === 'kick').sort((a, b) => a.beat - b.beat);
    kicks.forEach((kick, index) => {
      const next = kicks[index + 1]?.beat ?? piece.beats;
      const dur = Math.min(SUB_KICK_BODY_SEC / spb, next - kick.beat - LEGATO_GAP_BEATS);
      if (dur < 0.05) return;
      const midi = kickMidiAt(piece, kick.beat);
      candidates.push({
        part: 'subKick',
        beat: kick.beat,
        dur,
        midi,
        voice: subKickVoice,
        volume: Math.min(15, 1 + velocitySteps(kick.velocity)),
        vibrato: false,
        shake: false,
        priority: PART_PRIORITY.subKick,
        sweep: { fromFreq: midiFreq(midi) * SUB_KICK_SWEEP_RATIO, sec: SUB_KICK_SWEEP_SEC },
      });
    });
  }

  // コードの中央声部を単音リフとして刻む。独立声部が多い瞬間だけアロケータが先に落とす。
  for (const chord of piece.chords) {
    // 単音バッキングは和音の同一性を先に確立する。テンション声部(colorPcs)を
    // 単独で持続させると第3音不在のままM7/9thだけが鳴り和声が読めなくなるため、
    // 基幹はコードトーンから取り、カラートーンは後拍・裏拍の彩りに限定する。
    const chordToneMidis = chord.midis.filter((midi) => chord.pcs.includes(midi % 12));
    const colorVoice = chord.midis.find((midi) => (chord.colorPcs ?? []).includes(midi % 12));
    const lowerVoice = chordToneMidis[1] ?? chordToneMidis[0] ?? chord.midis[1] ?? chord.midis[0]!;
    const upperVoice = colorVoice ?? chordToneMidis[2] ?? lowerVoice;
    const thin = chord.beat < piece.loopStartBeat
      || arrangementSectionFor(piece, chord.beat).backingDensity === 'sparse';
    if (voices.backingPattern === 'offbeat') {
      for (const step of offbeatBackingRiff(piece, chord, 'chordStart')) {
        candidates.push({
          part: 'backing',
          beat: step.beat,
          dur: 0.2,
          midi: step.slot === 'lower' ? lowerVoice : upperVoice,
          voice: voices.backing,
          volume: step.thin ? 9 : 7,
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
          // パッドは頭でコードトーンを確立し、後半だけカラートーンへ差し替える
          // （掛留の作法。カラー無しの曲では従来と同一の音）。
          midi: beat > 0 && colorVoice !== undefined ? colorVoice : lowerVoice,
          dur: Math.min(2, chord.dur - beat) * 0.75,
          voice: voices.backing,
          volume: thin ? 9 : 7,
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
    // ポルタメント近似: 前音の音高でキーオンし、共有規則(glide.ts)の時間で
    // 10ms刻みのピッチイベントで目標へ等比スライドする。
    if (note.sweep) {
      b.keyOn(note.ch, note.voice, note.volume, note.sweep.fromFreq, start);
      b.sweep(note.ch, note.sweep.fromFreq, freq, start, start + note.sweep.sec, 0.005);
    } else if (note.glideFrom !== undefined && !note.shake) {
      const startFreq = midiFreq(note.glideFrom);
      const glideSec = glideDurationSec(end - start);
      const glideEnd = start + glideSec;
      b.keyOn(note.ch, note.voice, note.volume, startFreq, start);
      for (let at = start + 0.01; at < glideEnd; at += 0.01) {
        const progress = Math.min(1, (at - start) / glideSec);
        b.pitch(note.ch, startFreq * (freq / startFreq) ** progress, at);
      }
      b.pitch(note.ch, freq, glideEnd);
    } else {
      b.keyOn(note.ch, note.voice, note.volume, freq, start);
    }
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
  const mix = voices.rhythm;
  const levelRegs = rhythmLevelRegs(mix?.levels ?? RHYTHM_DEFAULT_LEVELS);
  if (mix) {
    for (const [reg, val] of Object.entries(levelRegs)) b.raw(Number(reg), val, 0);
  }
  const hits = new Map<number, { bits: number; levels: Partial<Record<DrumEvent['inst'], number>>; kickMidi?: number }>();
  for (const drum of piece.drums) {
    const at = drum.beat * spb;
    const hit = hits.get(at) ?? { bits: 0, levels: {} };
    hit.bits |= DRUM_BITS[drum.inst];
    if (mix) {
      const level = Math.min(15, mix.levels[drum.inst] + velocitySteps(drum.velocity));
      hit.levels[drum.inst] = Math.min(level, hit.levels[drum.inst] ?? 15);
      if (drum.inst === 'kick') hit.kickMidi = kickMidiAt(piece, drum.beat);
    }
    hits.set(at, hit);
  }
  // BD の調律: リズムモード BD の基音は ch6 の fnum/blk で決まる(キーオンビットは立てない)。
  // 打点ごとにベースの根音へ合わせ、変わったときだけキーオン直前に書く。
  let kickRegs: { lo: number; hi: number } | undefined;
  for (const [at, hit] of [...hits].sort((a, b) => a[0] - b[0])) {
    if (hit.kickMidi !== undefined) {
      const { fnum, blk } = freqToFnum(midiFreq(hit.kickMidi));
      const next = { lo: fnum & 0xff, hi: (blk << 1) | ((fnum >> 8) & 1) };
      if (kickRegs?.lo !== next.lo) b.raw(0x16, next.lo, at);
      if (kickRegs?.hi !== next.hi) b.raw(0x26, next.hi, at);
      kickRegs = next;
    }
    // 打点ごとの音量(ゴースト・拍節アクセント): 変わるニブルだけキーオン直前に書く
    // (3 本のレジスタを 2 音ずつ共有するので、相方のニブルは現在値を保つ)。
    for (const [inst, level] of Object.entries(hit.levels) as [DrumEvent['inst'], number][]) {
      const slot = RHYTHM_LEVEL_SLOT[inst];
      const current = levelRegs[slot.reg]!;
      const next = slot.high ? (current & 0x0f) | (level << 4) : (current & 0xf0) | level;
      if (next !== current) {
        levelRegs[slot.reg] = next;
        b.raw(slot.reg, next, at);
      }
    }
    b.raw(0x0e, 0x20, at);
    b.raw(0x0e, 0x20 | hit.bits, at + 0.004);
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
