/**
 * 作曲ワークスペースの表示モデル(純関数)。Piece と曲型から、タイムラインが描く
 * 区間ブロック・パート別レーン・チャンネル表示・ミュートの実効値を導く。
 * React もオーディオも持たないので、ここはユニットテストで保証する。
 */

import type { ChannelNote } from '../../audio/opll-arrange.js';
import { STAGE_ROLES } from '../../audio/stage.js';
import type { StageRole } from '../../audio/stage.js';
import { INTRO_ROLE_LABELS } from '../../core/music/types.js';
import type { Piece, SongFormSpec } from '../../core/music/types.js';
import { SECTION_ROLE_LABELS } from '../../core/music/form.js';

/** 1 小節の拍数(曲型の規約: 小節長は 4 拍固定)。 */
export const BAR_BEATS = 4;

export const ROLE_LABELS: Record<StageRole, string> = {
  lead: '主旋律',
  duet: 'ハモリ',
  counter: '副旋律',
  ostinato: '分散和音',
  backing: '伴奏',
  bass: 'ベース',
  drums: 'ドラム',
};

/** レーンの色。役割に紐づけ、譜面表示とチャンネル表示で同じ色を使う。 */
export const ROLE_COLORS: Record<StageRole, string> = {
  lead: '#ffd54f',
  duet: '#ffab91',
  counter: '#4fc3f7',
  ostinato: '#ce93d8',
  backing: '#81c784',
  bass: '#7986cb',
  drums: '#b0bec5',
};

export interface SectionBlock {
  /** 区間 id。イントロは 'intro'(曲型の区間 id とは衝突しない: validateForm が禁止)。 */
  id: string;
  isIntro: boolean;
  startBeat: number;
  endBeat: number;
  bars: number;
  /** 役割の表示名(イントロはイントロの役割)。 */
  roleLabel: string;
  /** 1..5。イントロは null。 */
  energy: number | null;
  keyRoot: number;
  theme: string | null;
}

/** イントロ + 曲型の区間を、絶対拍のブロックへ。 */
export function sectionBlocks(piece: Piece): SectionBlock[] {
  const blocks: SectionBlock[] = [];
  if (piece.loopStartBeat > 0) {
    blocks.push({
      id: 'intro',
      isIntro: true,
      startBeat: 0,
      endBeat: piece.loopStartBeat,
      bars: piece.loopStartBeat / BAR_BEATS,
      roleLabel: piece.introRole ? INTRO_ROLE_LABELS[piece.introRole] : 'イントロ',
      energy: null,
      keyRoot: piece.keyRoot,
      theme: null,
    });
  }
  for (const section of piece.songPlan.form.sections) {
    const startBeat = piece.loopStartBeat + section.startBar * BAR_BEATS;
    blocks.push({
      id: section.id,
      isIntro: false,
      startBeat,
      endBeat: startBeat + section.bars * BAR_BEATS,
      bars: section.bars,
      roleLabel: SECTION_ROLE_LABELS[section.role],
      energy: section.energy,
      keyRoot: section.keyRoot,
      theme: section.theme,
    });
  }
  return blocks;
}

/** その拍を含むブロック。曲の外なら null。 */
export function blockAtBeat(blocks: readonly SectionBlock[], beat: number): SectionBlock | null {
  return blocks.find((block) => beat >= block.startBeat && beat < block.endBeat) ?? null;
}

/**
 * 区間の主題の初出区間。区間単位の作り直しはここを引き直す: 再登場区間は初出の主題を
 * 借りて作られるので、初出を変えれば帰還もまとめて変わり、フックの一致が保たれる。
 */
export function themeOriginId(form: SongFormSpec, sectionId: string): string {
  const section = form.sections.find((candidate) => candidate.id === sectionId);
  if (!section) return sectionId;
  return form.sections.find((candidate) => candidate.theme === section.theme)?.id ?? sectionId;
}

/** 同じ主題を持つ区間の id(初出を含む、曲順)。作り直しの影響範囲の表示用。 */
export function themeMemberIds(form: SongFormSpec, sectionId: string): string[] {
  const section = form.sections.find((candidate) => candidate.id === sectionId);
  if (!section) return [];
  return form.sections.filter((candidate) => candidate.theme === section.theme).map((candidate) => candidate.id);
}

export interface LaneNote {
  beat: number;
  dur: number;
  /** 縦位置。音高レーンは MIDI、ドラムは楽器の行番号。 */
  row: number;
  /** 省略=レーンの色。チャンネル表示は役割の色を音ごとに持つ。 */
  color?: string;
  /** 声部不足で落ちた音(チャンネル表示)。 */
  dropped?: boolean;
}

export interface Lane {
  id: string;
  label: string;
  /** ミュート/ソロの対象になる役割。チャンネル表示のレーンは null(役割が混在する)。 */
  role: StageRole | null;
  color: string;
  kind: 'pitch' | 'drums';
  notes: LaneNote[];
  /** 表示する縦の範囲(row の最小・最大)。 */
  lo: number;
  hi: number;
}

const DRUM_ROWS: Record<Piece['drums'][number]['inst'], number> = {
  kick: 0, snare: 1, tom: 2, hat: 3, cymbal: 4,
};
/** ドラムの 1 打を見せる幅(拍)。 */
const DRUM_HIT_BEATS = 0.2;

function rangeOf(notes: readonly LaneNote[]): { lo: number; hi: number } {
  if (notes.length === 0) return { lo: 60, hi: 72 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const note of notes) {
    lo = Math.min(lo, note.row);
    hi = Math.max(hi, note.row);
  }
  // 1 音だけのレーンでも帯が潰れないよう、最低 1 オクターブぶんの幅を取る。
  const pad = Math.max(0, 12 - (hi - lo)) / 2;
  return { lo: Math.floor(lo - pad), hi: Math.ceil(hi + pad) };
}

/** 譜面表示: 役割ごとのレーン。音の無い役割(ハモリ無しの曲など)はレーンを出さない。 */
export function scoreLanes(piece: Piece): Lane[] {
  const pitch = (events: readonly { beat: number; dur: number; midi: number }[]): LaneNote[] =>
    events.map((event) => ({ beat: event.beat, dur: event.dur, row: event.midi }));
  const byRole: Record<StageRole, LaneNote[]> = {
    lead: pitch(piece.melody),
    duet: pitch(piece.duet),
    counter: pitch(piece.counterMelody),
    ostinato: pitch(piece.ostinato),
    backing: piece.chords.flatMap((chord) => chord.midis.map((midi) => ({ beat: chord.beat, dur: chord.dur, row: midi }))),
    bass: pitch(piece.bass),
    drums: piece.drums.map((drum) => ({ beat: drum.beat, dur: DRUM_HIT_BEATS, row: DRUM_ROWS[drum.inst] })),
  };
  return STAGE_ROLES
    .filter((role) => byRole[role].length > 0)
    .map((role) => ({
      id: role,
      label: ROLE_LABELS[role],
      role,
      color: ROLE_COLORS[role],
      kind: role === 'drums' ? 'drums' as const : 'pitch' as const,
      notes: byRole[role],
      ...(role === 'drums' ? { lo: 0, hi: 4 } : rangeOf(byRole[role])),
    }));
}

/**
 * OPLL のチャンネル表示: 旋律 6ch それぞれに、割り当てられた音を役割の色で並べる。
 * 最後のレーンは声部不足で落ちた音(無ければレーンごと出さない)。
 */
export function opllChannelLanes(channelNotes: readonly ChannelNote[]): Lane[] {
  const laneOf = (id: string, label: string, notes: readonly ChannelNote[], dropped: boolean): Lane => {
    const laneNotes: LaneNote[] = notes.map((note) => ({
      beat: note.beat,
      dur: Math.max(0, note.endBeat - note.beat),
      row: note.midi,
      color: ROLE_COLORS[note.role],
      ...(dropped ? { dropped: true } : {}),
    }));
    return { id, label, role: null, color: '#888', kind: 'pitch', notes: laneNotes, ...rangeOf(laneNotes) };
  };
  const lanes = [0, 1, 2, 3, 4, 5].map((ch) => laneOf(
    `ch${ch}`, `ch${ch + 1}`, channelNotes.filter((note) => note.ch === ch), false,
  ));
  const dropped = channelNotes.filter((note) => note.ch === null);
  return dropped.length > 0 ? [...lanes, laneOf('dropped', `落ちた音 ${dropped.length}`, dropped, true)] : lanes;
}

/**
 * 2A03 のチャンネル表示。配線は固定(nes-apu.ts): パルス1=主旋律、パルス2=副旋律と、
 * 副旋律に重ならない区間の伴奏、三角波=ベース、ノイズ=ドラム。伴奏は和音の区間で示す
 * (実際の刻みはリフ型で、ここでは「どの区間で伴奏がパルス2を使えるか」を見せる)。
 */
export function nesChannelLanes(piece: Piece): Lane[] {
  const colored = (
    events: readonly { beat: number; dur: number; midi: number }[], role: StageRole,
  ): LaneNote[] => events.map((event) => ({ beat: event.beat, dur: event.dur, row: event.midi, color: ROLE_COLORS[role] }));
  const overlapsCounter = (beat: number, dur: number): boolean =>
    piece.counterMelody.some((note) => note.beat < beat + dur && beat < note.beat + note.dur);
  const backing: LaneNote[] = piece.chords
    .filter((chord) => !overlapsCounter(chord.beat, chord.dur))
    .map((chord) => ({
      beat: chord.beat, dur: chord.dur, row: chord.midis[1] ?? chord.midis[0]!, color: ROLE_COLORS.backing,
    }));
  const lane = (id: string, label: string, notes: LaneNote[]): Lane => ({
    id, label, role: null, color: '#888', kind: 'pitch', notes, ...rangeOf(notes),
  });
  return [
    lane('pulse1', 'パルス1', colored(piece.melody, 'lead')),
    lane('pulse2', 'パルス2', [...colored(piece.counterMelody, 'counter'), ...backing]),
    lane('triangle', '三角波', colored(piece.bass, 'bass')),
    {
      id: 'noise', label: 'ノイズ', role: null, color: ROLE_COLORS.drums, kind: 'drums', lo: 0, hi: 4,
      notes: piece.drums.map((drum) => ({ beat: drum.beat, dur: DRUM_HIT_BEATS, row: DRUM_ROWS[drum.inst] })),
    },
  ];
}

/** ミュートとソロから、実際に鳴らさない役割を導く。ソロ中はソロ以外すべてを落とす。 */
export function effectiveMuted(muted: readonly StageRole[], solo: StageRole | null): StageRole[] {
  return solo === null ? STAGE_ROLES.filter((role) => muted.includes(role)) : STAGE_ROLES.filter((role) => role !== solo);
}

/** 拍 → 「小節.拍」表示(1 始まり)。イントロも通し番号で数える。 */
export function formatBarBeat(beat: number): string {
  const safe = Math.max(0, beat);
  return `${Math.floor(safe / BAR_BEATS) + 1}.${Math.floor(safe % BAR_BEATS) + 1}`;
}

export function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60)}:${String(Math.floor(safe % 60)).padStart(2, '0')}`;
}
