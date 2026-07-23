import { describe, expect, it } from 'vitest';
import { compose, validatePiece, variedChoiceFor } from '../src/core/music/compose.js';
import type { Piece } from '../src/core/music/compose.js';
import { PROGRESSIONS } from '../src/core/music/theory.js';

/**
 * 表現デバイス（EXP-002 で見つけた表現レンジの穴を塞ぐ実装）の発火をシンボリックに検証する。
 * 聴かずに「装置が計画位置で確かに動く」ことだけを保証し、良し悪しの評価はブラインド比較へ委ねる。
 */

const prog = PROGRESSIONS.find((candidate) => candidate.id === 'minor-pedal')!;

const pieceCache = new Map<number, Piece>();
function pieceFor(seed: number): Piece {
  const cached = pieceCache.get(seed);
  if (cached) return cached;
  const piece = compose({
    progressionId: prog.id,
    styleId: 'eurobeat',
    keyRoot: 0,
    bpm: 150,
    bars: 40,
    tonality: 'minor',
    seed,
    choice: variedChoiceFor(prog, 40, seed),
  });
  pieceCache.set(seed, piece);
  return piece;
}

function findPiece(predicate: (piece: Piece) => boolean, maxSeeds = 64): Piece | null {
  for (let seed = 0; seed < maxSeeds; seed++) {
    const piece = pieceFor(seed);
    if (predicate(piece)) return piece;
  }
  return null;
}

const structuralMelody = (piece: Piece) =>
  piece.melody.filter((note) => note.role !== 'ornament' && note.beat >= piece.loopStartBeat);

describe('表現デバイスの発火（聴かない層の検証）', () => {
  it('ロングトーンは計画位置で小節線をまたぎ、2拍以上保続する', () => {
    const piece = findPiece((candidate) => candidate.phrasePlan.bars.some((bar) => (
      bar.longToneStep !== null
      && candidate.melody.some((note) => (
        note.role !== 'ornament'
        && Math.abs(note.beat - (candidate.loopStartBeat + bar.bar * 4 + bar.longToneStep! * 0.5)) < 0.001
        && note.dur >= 2
      ))
    )));
    expect(piece).not.toBeNull();
    const barPlan = piece!.phrasePlan.bars.find((bar) => bar.longToneStep !== null)!;
    const barEnd = piece!.loopStartBeat + (barPlan.bar + 1) * 4;
    const note = piece!.melody.find((candidate) => (
      candidate.role !== 'ornament'
      && Math.abs(candidate.beat - (piece!.loopStartBeat + barPlan.bar * 4 + barPlan.longToneStep! * 0.5)) < 0.001
    ))!;
    // 小節線をまたいで保続し、次小節は sustainedEntry として頭打ちを省く
    expect(note.beat).toBeLessThan(barEnd);
    expect(note.beat + note.dur).toBeGreaterThan(barEnd);
    expect(piece!.phrasePlan.bars[barPlan.bar + 1]!.sustainedEntry).toBe(true);
    expect(validatePiece(piece!)).toEqual([]);
  });

  it('署名跳躍は計画小節内で9半音を超え、直後に反行順次で受け止められる', () => {
    const leapPosition = (candidate: Piece): number => {
      if (candidate.phrasePlan.signatureLeapBar === null) return -1;
      const body = structuralMelody(candidate);
      const barStart = candidate.loopStartBeat + candidate.phrasePlan.signatureLeapBar * 4;
      return body.findIndex((note, position) => (
        position > 0
        && position + 1 < body.length
        && note.beat >= barStart && note.beat < barStart + 4
        && Math.abs(note.midi - body[position - 1]!.midi) > 9
      ));
    };
    const piece = findPiece((candidate) => leapPosition(candidate) >= 0);
    expect(piece).not.toBeNull();
    const body = structuralMelody(piece!);
    const position = leapPosition(piece!);
    const leap = body[position]!.midi - body[position - 1]!.midi;
    const landing = body[position + 1]!.midi - body[position]!.midi;
    expect(Math.abs(leap)).toBeGreaterThan(9);
    expect(Math.abs(landing)).toBeLessThanOrEqual(2);
    expect(Math.sign(landing)).toBe(-Math.sign(leap));
    expect(validatePiece(piece!)).toEqual([]);
  });

  it('休符始まりの小節は1拍目に主旋律を置かず、検証も通る', () => {
    const piece = findPiece((candidate) => candidate.phrasePlan.bars.some((bar) => bar.restStart));
    expect(piece).not.toBeNull();
    const barPlan = piece!.phrasePlan.bars.find((bar) => bar.restStart)!;
    const barStart = piece!.loopStartBeat + barPlan.bar * 4;
    expect(structuralMelody(piece!).some((note) => Math.abs(note.beat - barStart) < 0.001)).toBe(false);
    expect(validatePiece(piece!)).toEqual([]);
  });

  it('ループ頭を休符で始める曲も存在する（弱起の呼吸）', () => {
    const piece = findPiece((candidate) => candidate.phrasePlan.bars[0]!.restStart);
    expect(piece).not.toBeNull();
    expect(structuralMelody(piece!).some((note) => (
      Math.abs(note.beat - piece!.loopStartBeat) < 0.001
    ))).toBe(false);
  });

  it('40小節は必ずどこかの区間でテッシトゥーラを変位させる', () => {
    for (let seed = 0; seed < 8; seed++) {
      const piece = pieceFor(seed);
      expect(piece.phrasePlan.bars.some((bar) => bar.registerOffset !== 0), `seed=${seed}`).toBe(true);
      // Aセクションは主題の基準レジスタに固定
      expect(piece.phrasePlan.bars[0]!.registerOffset).toBe(0);
    }
  });

  it('標準語法でも控えめな装飾（前打音・回し）が発火する', () => {
    const piece = findPiece((candidate) => candidate.melody.some((note) => note.role === 'ornament'));
    expect(piece).not.toBeNull();
    expect(piece!.melody.some((note) => note.ornament === 'shake')).toBe(false);
  });

  it('ブレイクダウン区間はダイナミクスの床が下がり、静かな旋律が生まれる', () => {
    const piece = compose({
      progressionId: prog.id,
      styleId: 'eurobeat',
      keyRoot: 0,
      bpm: 150,
      bars: 40,
      tonality: 'minor',
      seed: 42,
      choice: variedChoiceFor(prog, 40, 42),
      compositionStrategy: 'premiseArc',
    });
    // premiseArc は C 区間（bar16-23）がブレイクダウン
    const valleyBars = piece.phrasePlan.bars.slice(16, 24);
    expect(valleyBars.some((bar) => bar.dynamic < 0.58)).toBe(true);
    expect(structuralMelody(piece).some((note) => (note.velocity ?? 1) < 0.58)).toBe(true);
  });
});
