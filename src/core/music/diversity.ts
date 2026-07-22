import type { NoteEvent, Piece } from './compose.js';

export interface DistributionSummary {
  samples: number;
  unique: number;
  maxCount: number;
  maxShare: number;
  collisionShare: number;
}

export interface MelodicSectionSimilarity {
  firstSection: number;
  secondSection: number;
  phraseScores: readonly number[];
  average: number;
  similarPhrases: number;
}

interface MelodicWindowProfile {
  count: number;
  rhythm: number[];
  contour: number[];
}

const roundGrid = (value: number): number => Math.round(value * 4) / 4;

function notesInBodyWindow(piece: Piece, startBar: number, bars: number): NoteEvent[] {
  const start = piece.loopStartBeat + startBar * 4;
  const end = start + bars * 4;
  return piece.melody.filter((note) => (
    note.role !== 'ornament' && note.beat >= start && note.beat < end
  ));
}

function intervalBucket(interval: number): number {
  if (interval === 0) return 0;
  const direction = interval < 0 ? -1 : 1;
  const distance = Math.abs(interval);
  return direction * (distance <= 2 ? 1 : distance <= 5 ? 2 : 3);
}

function melodicWindowProfile(piece: Piece, startBar: number, bars: number): MelodicWindowProfile {
  const notes = notesInBodyWindow(piece, startBar, bars);
  const start = piece.loopStartBeat + startBar * 4;
  const onsets = notes.map((note) => roundGrid(note.beat - start));
  return {
    count: notes.length,
    rhythm: onsets.slice(1).map((onset, index) => roundGrid(onset - onsets[index]!)),
    contour: notes.slice(1).map((note, index) => intervalBucket(note.midi - notes[index]!.midi)),
  };
}

function lcsShare(first: readonly number[], second: readonly number[]): number {
  if (first.length === 0 && second.length === 0) return 1;
  if (first.length === 0 || second.length === 0) return 0;
  const row = Array(second.length + 1).fill(0) as number[];
  for (const value of first) {
    let diagonal = 0;
    for (let column = 1; column <= second.length; column++) {
      const previous = row[column]!;
      row[column] = value === second[column - 1]
        ? diagonal + 1
        : Math.max(row[column]!, row[column - 1]!);
      diagonal = previous;
    }
  }
  return row[second.length]! / Math.max(first.length, second.length);
}

function profileSimilarity(first: MelodicWindowProfile, second: MelodicWindowProfile): number {
  const countScore = Math.min(first.count, second.count) / Math.max(1, first.count, second.count);
  return lcsShare(first.rhythm, second.rhythm) * 0.4
    + lcsShare(first.contour, second.contour) * 0.45
    + countScore * 0.15;
}

/** 2小節単位の粗いリズム・輪郭。完全一致より強い「同じ話し方」の回帰テストに使う。 */
export function melodicPhraseFingerprint(piece: Piece, startBar: number): string {
  const profile = melodicWindowProfile(piece, startBar, 2);
  return `${profile.count}|${profile.rhythm.join(',')}|${profile.contour.join(',')}`;
}

/** 8小節区間同士を、4つの対応フレーズのリズム・輪郭で比較する。 */
export function melodicSectionSimilarities(piece: Piece): MelodicSectionSimilarity[] {
  if (piece.bars < 16) return [];
  const sectionBars = 8;
  const sectionCount = Math.floor(piece.bars / sectionBars);
  const profiles = Array.from({ length: sectionCount }, (_, sectionIndex) => (
    Array.from({ length: 4 }, (_, phraseIndex) => (
      melodicWindowProfile(piece, sectionIndex * sectionBars + phraseIndex * 2, 2)
    ))
  ));
  const result: MelodicSectionSimilarity[] = [];
  for (let firstSection = 0; firstSection < sectionCount; firstSection++) {
    for (let secondSection = firstSection + 1; secondSection < sectionCount; secondSection++) {
      const phraseScores = profiles[firstSection]!.map((profile, phraseIndex) => (
        profileSimilarity(profile, profiles[secondSection]![phraseIndex]!)
      ));
      result.push({
        firstSection,
        secondSection,
        phraseScores,
        average: phraseScores.reduce((sum, score) => sum + score, 0) / phraseScores.length,
        similarPhrases: phraseScores.filter((score) => score >= 0.84).length,
      });
    }
  }
  return result;
}

export function summarizeDistribution(signatures: readonly string[]): DistributionSummary {
  const counts = new Map<string, number>();
  for (const signature of signatures) counts.set(signature, (counts.get(signature) ?? 0) + 1);
  const maxCount = Math.max(0, ...counts.values());
  return {
    samples: signatures.length,
    unique: counts.size,
    maxCount,
    maxShare: signatures.length === 0 ? 0 : maxCount / signatures.length,
    collisionShare: signatures.length === 0 ? 0 : 1 - counts.size / signatures.length,
  };
}
