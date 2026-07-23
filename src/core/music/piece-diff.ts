/**
 * 曲の「聴こえる層」のダイジェストと差分検出。
 *
 * compose() は決定論的なので、各パートのイベント列をセクション単位でハッシュ化すると、
 * 一致 = 音は変わっていない、を聴かずに保証できる。用途は2つ:
 * - 回帰検出: スナップショットテスト（tests/music-snapshot.test.ts）
 * - 差分の定位: ブラインド比較UIの「差分区間だけ再生」
 *
 * songPlan や phrasePlan 等の内部設計はダイジェストに含めない。イベント列に現れない
 * 変更は聴こえない変更であり、ここで検出すべきではないため。
 */
import type { ChordEvent, DrumEvent, NoteEvent, PhraseSection, Piece } from './compose.js';

export type PieceSectionId = 'intro' | PhraseSection;

export type PiecePartId = 'melody' | 'counter' | 'ostinato' | 'bass' | 'drums' | 'chords';

export const PIECE_PART_IDS: readonly PiecePartId[] = [
  'melody', 'counter', 'ostinato', 'bass', 'drums', 'chords',
];

export const PIECE_PART_LABELS: Record<PiecePartId, string> = {
  melody: '主旋律',
  counter: '副旋律',
  ostinato: '分散和音',
  bass: 'ベース',
  drums: 'ドラム',
  chords: '伴奏和音',
};

export const PIECE_SECTION_LABELS: Record<'intro', string> = { intro: 'イントロ' };

export function pieceSectionLabel(section: PieceSectionId): string {
  return section === 'intro' ? PIECE_SECTION_LABELS.intro : section;
}

export interface PieceSectionRange {
  section: PieceSectionId;
  startBeat: number;
  endBeat: number;
}

/** イントロ + phrasePlan のセクション境界を、絶対拍のレンジへ変換する。 */
export function pieceSectionRanges(piece: Piece): PieceSectionRange[] {
  const ranges: PieceSectionRange[] = [];
  if (piece.loopStartBeat > 0) {
    ranges.push({ section: 'intro', startBeat: 0, endBeat: piece.loopStartBeat });
  }
  for (const bar of piece.phrasePlan.bars) {
    const startBeat = piece.loopStartBeat + bar.bar * 4;
    const last = ranges[ranges.length - 1];
    if (last && last.section === bar.section) {
      last.endBeat = startBeat + 4;
    } else {
      ranges.push({ section: bar.section, startBeat, endBeat: startBeat + 4 });
    }
  }
  return ranges;
}

/** 浮動小数の表現ゆれ（結合順の変更など聴こえない差）でハッシュが揺れないよう丸める。 */
const num = (value: number): string => String(Math.round(value * 1e6) / 1e6);

/** FNV-1a 32bit。依存なしで決定論的な短いダイジェストを作る。 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const noteToken = (note: NoteEvent, startBeat: number): string => [
  num(note.beat - startBeat), num(note.dur), note.midi,
  note.velocity === undefined ? '' : num(note.velocity),
  note.articulation ?? '', note.ornament ?? '', note.role ?? '',
].join(':');

const chordToken = (chord: ChordEvent, startBeat: number): string => [
  num(chord.beat - startBeat), num(chord.dur), chord.token, chord.midis.join('.'),
].join(':');

const drumToken = (drum: DrumEvent, startBeat: number): string =>
  `${num(drum.beat - startBeat)}:${drum.inst}`;

function hashRange<T extends { beat: number }>(
  events: readonly T[],
  range: PieceSectionRange,
  token: (event: T, startBeat: number) => string,
): string {
  const inRange = events.filter((event) => event.beat >= range.startBeat && event.beat < range.endBeat);
  return fnv1a(inRange.map((event) => token(event, range.startBeat)).join('|'));
}

export interface PieceSectionDigest extends PieceSectionRange {
  parts: Record<PiecePartId, string>;
}

export interface PieceDigest {
  bpm: number;
  beats: number;
  loopStartBeat: number;
  sections: PieceSectionDigest[];
}

/** 聴こえる層（全パートのイベント列）のセクション別ダイジェスト。 */
export function digestPiece(piece: Piece): PieceDigest {
  return {
    bpm: piece.bpm,
    beats: piece.beats,
    loopStartBeat: piece.loopStartBeat,
    sections: pieceSectionRanges(piece).map((range) => ({
      ...range,
      parts: {
        melody: hashRange(piece.melody, range, noteToken),
        counter: hashRange(piece.counterMelody, range, noteToken),
        ostinato: hashRange(piece.ostinato, range, noteToken),
        bass: hashRange(piece.bass, range, noteToken),
        drums: hashRange(piece.drums, range, drumToken),
        chords: hashRange(piece.chords, range, chordToken),
      },
    })),
  };
}

export interface PieceSectionDiff extends PieceSectionRange {
  differingParts: PiecePartId[];
}

/**
 * 複数曲（ブラインド比較の各候補など）をセクション単位で比べ、
 * どの区間のどのパートが1つでも異なるかを返す。全区間 differingParts が
 * 空なら、候補は音イベントとして完全に同一。
 */
export function diffPieceSections(pieces: readonly Piece[]): PieceSectionDiff[] {
  if (pieces.length === 0) return [];
  const digests = pieces.map(digestPiece);
  const first = digests[0]!;
  const sameLayout = digests.every((digest) => (
    digest.beats === first.beats
    && digest.loopStartBeat === first.loopStartBeat
    && digest.sections.length === first.sections.length
    && digest.sections.every((section, index) => section.section === first.sections[index]!.section)
  ));
  if (!sameLayout) {
    // 形式が違う曲同士は区間対応が取れないため、全区間・全パートを差分として返す。
    return first.sections.map((section) => ({
      section: section.section,
      startBeat: section.startBeat,
      endBeat: section.endBeat,
      differingParts: [...PIECE_PART_IDS],
    }));
  }
  return first.sections.map((section, index) => ({
    section: section.section,
    startBeat: section.startBeat,
    endBeat: section.endBeat,
    differingParts: PIECE_PART_IDS.filter((part) => (
      digests.some((digest) => digest.sections[index]!.parts[part] !== section.parts[part])
    )),
  }));
}
