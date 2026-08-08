import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import type { Piece } from '../src/core/music/compose.js';
import { diagnosePiece } from '../src/core/music/diagnostics.js';

/**
 * 半小節タイ(anchorTie: 3拍目リアタックの条件付き緩和=食い)の検証。
 * - 発火すること(封じられていた装置なので、まず存在を保証する)
 * - タイ小節では3拍目に打鍵がなく、直前の発音がアンカーを跨いで保続すること
 * - 干渉ガード(終止・装飾・副旋律・ロングトーン)が守られること
 * - 診断エラーゼロ(先取音の和声整合はdiagnostics側の新チェックが担う)
 */

const pieceFor = (seed: number): Piece => compose({
  progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, bars: 16, seed,
});

const piecesWithTie = (): { piece: Piece; seeds: number[] } => {
  const seeds: number[] = [];
  let sample: Piece | null = null;
  for (let seed = 1; seed <= 40; seed++) {
    const piece = pieceFor(seed);
    if (piece.phrasePlan.bars.some((bar) => bar.anchorTie)) {
      seeds.push(seed);
      sample ??= piece;
    }
  }
  return { piece: sample!, seeds };
};

describe('半小節タイ(食い)', () => {
  const { piece, seeds } = piecesWithTie();

  it('シード帯で観測できる頻度で発火し、全小節では発火しない', () => {
    expect(seeds.length).toBeGreaterThan(0);
    const tieBars = piece.phrasePlan.bars.filter((bar) => bar.anchorTie);
    expect(tieBars.length).toBeLessThan(piece.bars / 2); // 常時ではなく変化球として
  });

  it('タイ小節は3拍目に打鍵がなく、直前の発音がアンカーを跨いで保続する', () => {
    const bodyStart = piece.loopStartBeat;
    for (const barPlan of piece.phrasePlan.bars.filter((bar) => bar.anchorTie)) {
      const anchorBeat = bodyStart + barPlan.bar * 4 + 2;
      const onsetAtAnchor = piece.melody.find((note) => (
        note.role !== 'ornament' && Math.abs(note.beat - anchorBeat) < 0.001
      ));
      expect(onsetAtAnchor).toBeUndefined();
      const tieNote = piece.melody.find((note) => (
        note.role !== 'ornament'
        && note.beat < anchorBeat
        && note.beat + note.dur >= anchorBeat + 0.25
      ));
      expect(tieNote).toBeDefined();
      expect(tieNote!.articulation).toBe('tenuto');
    }
  });

  it('強い終止・装飾・副旋律・ロングトーンの小節では発火しない(最弱のopenのみ共存)', () => {
    for (const seed of seeds) {
      for (const barPlan of pieceFor(seed).phrasePlan.bars.filter((bar) => bar.anchorTie)) {
        expect([null, 'open']).toContain(barPlan.cadence);
        expect(barPlan.ornamentType).toBeNull();
        expect(barPlan.counterSteps).toEqual([]);
        expect(barPlan.longToneStep).toBeNull();
        // 到達音はアンカー後にあり、終止機構(open)の目標到達はタイと共存する。
        expect(barPlan.targetStep).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it('タイ間隔は2小節以上あく', () => {
    for (const seed of seeds) {
      const tieBars = pieceFor(seed).phrasePlan.bars
        .filter((bar) => bar.anchorTie)
        .map((bar) => bar.bar);
      for (let index = 1; index < tieBars.length; index++) {
        expect(tieBars[index]! - tieBars[index - 1]!).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('タイ入りの曲も診断エラーゼロ(先取音の和声整合を含む)', () => {
    for (const seed of seeds.slice(0, 8)) {
      const report = diagnosePiece(pieceFor(seed));
      const errors = report.issues.filter((issue) => issue.severity === 'error');
      expect(errors).toEqual([]);
    }
  });
});
