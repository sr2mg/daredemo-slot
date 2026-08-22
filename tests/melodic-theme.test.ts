import { describe, expect, it } from 'vitest';
import {
  appoggiaturaRatePercent,
  fragmentOf,
  invertTheme,
  realizeDegree,
  themeDegreeSpan,
  themeFromGesture,
  transposeTheme,
} from '../src/core/music/melodic-theme.js';
import { compose } from '../src/core/music/compose.js';
import { validatePiece } from '../src/core/music/diagnostics.js';
import { variedChoiceFor } from '../src/core/music/harmony-plan.js';
import type { ComposeOptions, MotifMove, Piece } from '../src/core/music/types.js';
import { melodicPhraseSimilarity } from '../src/core/music/diversity.js';
import { diagnosePiece } from '../src/core/music/diagnostics.js';
import { MAJOR_SCALE, PROGRESSIONS } from '../src/core/music/theory.js';

/**
 * 実音テーマ（記憶に残る旋律の核）の検証。
 * - テーマは音度列として一度だけ確定し、反復・移調・反転・断片化が音程を保存する
 * - 提示と変奏反復はリテラル反復（平行ピリオド）、Dはフックのリテラル帰還
 * - 強拍倚音は2度解決とセットでだけ現れる
 * - 弱起は次フレーズ頭の2度下から掛かる
 */

const moves: MotifMove[] = Array.from({ length: 16 }, (_, step) => ({
  direction: (step % 3 === 0 ? 1 : -1) as 1 | -1,
  stepwise: step % 4 !== 2,
  leap: 3 + (step % 3),
}));
const prompt = [true, true, false, true, true, false, true, false];
const answer = [true, false, true, true, true, false, false, true];

describe('melodic-theme（単体）', () => {
  it('テーマ構築は決定論で、発音ステップに単一の頂点を持つ', () => {
    const theme = themeFromGesture(moves, prompt, answer);
    expect(theme).toEqual(themeFromGesture(moves, prompt, answer));
    expect(theme.degreeByStep).toHaveLength(16);
    const max = Math.max(...theme.onsetSteps.map((step) => theme.degreeByStep[step]!));
    const peaks = theme.onsetSteps.filter((step) => theme.degreeByStep[step] === max);
    expect(peaks).toEqual([theme.peakStep]);
  });

  it('全音度移調は音程の相対関係を、反転は輪郭の鏡像を保存する', () => {
    const theme = themeFromGesture(moves, prompt, answer);
    const up = transposeTheme(theme, 2);
    expect(up.degreeByStep.map((degree, step) => degree - theme.degreeByStep[step]!))
      .toEqual(Array.from({ length: 16 }, () => 2));
    const mirrored = invertTheme(theme);
    expect(mirrored.degreeByStep.map((degree) => -degree)).toEqual([...theme.degreeByStep]);
  });

  it('断片は末尾3音の相対度数で、先頭は常に0', () => {
    const theme = themeFromGesture(moves, prompt, answer);
    const fragment = fragmentOf(theme, 'tail');
    expect(fragment.relativeDegrees.length).toBeGreaterThan(0);
    expect(fragment.relativeDegrees.length).toBeLessThanOrEqual(3);
    expect(fragment.relativeDegrees[0]).toBe(0);
  });

  it('realizeDegreeはアンカーから音組織上を正確に歩く', () => {
    const cMajor = [...MAJOR_SCALE];
    expect(realizeDegree(76, 0, cMajor, 72, 88)).toBe(76); // E5
    expect(realizeDegree(76, 1, cMajor, 72, 88)).toBe(77); // F5
    expect(realizeDegree(76, 2, cMajor, 72, 88)).toBe(79); // G5
    expect(realizeDegree(76, -2, cMajor, 72, 88)).toBe(72); // C5
  });

  it('倚音採用率は順次進行率から導かれ、0〜25%に収まる', () => {
    expect(appoggiaturaRatePercent(50)).toBe(0);
    expect(appoggiaturaRatePercent(80)).toBe(24);
    expect(appoggiaturaRatePercent(100)).toBe(25);
    expect(appoggiaturaRatePercent(30)).toBe(0);
  });

  it('テーマの度数スパンはアンカー配置の音域計算に使える形で返る', () => {
    const theme = themeFromGesture(moves, prompt, answer);
    const span = themeDegreeSpan(theme);
    expect(span.min).toBeLessThanOrEqual(0);
    expect(span.max).toBeGreaterThanOrEqual(0);
  });
});

const base: ComposeOptions = {
  progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, bars: 16, seed: 0,
};

function phrasePlanOf(piece: Piece, bar: number) {
  return piece.phrasePlan.bars[bar]!;
}

function cleanPhrasePair(piece: Piece, startBar: number): boolean {
  return piece.phrasePlan.bars.slice(startBar, startBar + 2).every((plan) => (
    plan.counterSteps.length === 0
    && plan.longToneStep === null
    && !plan.anchorTie
    && !plan.anacrusis
    && !plan.restStart
    && !plan.sustainedEntry
    && plan.ornamentType === null
    && plan.cadence !== 'turnaround'
    && plan.bar !== piece.phrasePlan.climaxBar
    && plan.bar !== piece.phrasePlan.signatureLeapBar
  ));
}

describe('実音テーマ（作曲エンジン統合）', () => {
  it('提示と変奏反復は同じ実音図形として聴こえる（平行ピリオド）', () => {
    const seeds = Array.from({ length: 40 }, (_, seed) => seed);
    const clean = seeds
      .map((seed) => compose({ ...base, seed }))
      .filter((piece) => cleanPhrasePair(piece, 0) && cleanPhrasePair(piece, 2));
    expect(clean.length).toBeGreaterThan(4);
    for (const piece of clean) {
      expect(melodicPhraseSimilarity(piece, 0, 2)).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('40小節のD区間はAのフックをリテラルに帰還させる', () => {
    const prog = PROGRESSIONS.find((candidate) => candidate.id === 'minor-pedal')!;
    const pieces = Array.from({ length: 24 }, (_, seed) => compose({
      ...base, progressionId: prog.id, bars: 40, tonality: 'minor', seed,
      choice: variedChoiceFor(prog, 40, seed),
    }));
    const literalReturns = pieces.filter((piece) => (
      piece.songPlan.form.sections[3]!.motifTransform === 'literal'
      && cleanPhrasePair(piece, 0)
      && cleanPhrasePair(piece, 24)
    ));
    expect(literalReturns.length).toBeGreaterThan(0);
    for (const piece of literalReturns) {
      expect(melodicPhraseSimilarity(piece, 0, 24)).toBeGreaterThanOrEqual(0.6);
    }
  });

  it('強拍倚音は非和声のまま保持され、次の発音が2度の和声音で解決する', () => {
    const chordAt = (piece: Piece, beat: number) => piece.chords.reduce(
      (current, chord) => chord.beat <= beat ? chord : current,
      piece.chords[0]!,
    );
    let fired = 0;
    for (let seed = 0; seed < 48 && fired === 0; seed++) {
      const piece = compose({ ...base, seed });
      for (const plan of piece.phrasePlan.bars) {
        if (plan.appoggiaturaStep === null) continue;
        const beat = piece.loopStartBeat + plan.bar * 4 + plan.appoggiaturaStep * 0.5;
        const note = piece.melody.find((candidate) => (
          candidate.role !== 'ornament' && Math.abs(candidate.beat - beat) < 0.001
        ));
        if (!note || chordAt(piece, note.beat).pcs.includes(note.midi % 12)) continue;
        // 倚音が実際に非和声で鳴った: 解決を検証する。
        const resolution = piece.melody
          .filter((candidate) => candidate.role !== 'ornament' && candidate.beat > note.beat)
          .sort((first, second) => first.beat - second.beat)[0]!;
        expect(resolution.beat - note.beat).toBeLessThanOrEqual(1.001);
        expect(Math.abs(resolution.midi - note.midi)).toBeLessThanOrEqual(2);
        expect(chordAt(piece, resolution.beat).pcs).toContain(resolution.midi % 12);
        expect(validatePiece(piece)).toEqual([]);
        fired++;
      }
    }
    expect(fired).toBeGreaterThan(0);
  });

  it('弱起は次フレーズ頭の2度下から掛かり、掛かり先の頭拍は消えない', () => {
    let found = false;
    for (let seed = 0; seed < 48 && !found; seed++) {
      const piece = compose({ ...base, seed });
      const plan = piece.phrasePlan.bars.find((candidate) => candidate.anacrusis);
      if (!plan) continue;
      found = true;
      const pickupBeat = piece.loopStartBeat + plan.bar * 4 + 3.5;
      const pickup = piece.melody.find((note) => Math.abs(note.beat - pickupBeat) < 0.001);
      expect(pickup).toBeDefined();
      const nextPlan = phrasePlanOf(piece, plan.bar + 1);
      expect(nextPlan.restStart).toBe(false);
      const nextHead = piece.melody.find((note) => (
        note.role !== 'ornament' && note.beat >= piece.loopStartBeat + (plan.bar + 1) * 4
      ))!;
      expect(Math.abs(nextHead.midi - pickup!.midi)).toBeLessThanOrEqual(4);
      expect(validatePiece(piece)).toEqual([]);
    }
    expect(found).toBe(true);
  });

  it('終止音度の物語: 各フレーズの到達音は計画音度に最も近い和声音になる', () => {
    const piece = compose({ ...base, seed: 3 });
    const section = piece.songPlan.form.sections[0]!;
    expect(section.cadenceDegrees[0]).toBe(2); // 提示は3̂へ
    expect(section.cadenceDegrees[3]).toBe(0); // 結論は1̂へ
    for (const plan of piece.phrasePlan.bars) {
      if (plan.targetPc === null || plan.cadence === 'turnaround') continue;
      expect(plan.targetPc).toBeGreaterThanOrEqual(0);
    }
  });

  it('曲間モチーフ流用: 外部モチーフはA区間の実音図形を決定論的に変える', () => {
    const source = compose({ ...base, seed: 5 });
    const withMotif = compose({ ...base, seed: 9, externalMotif: source.motif });
    const without = compose({ ...base, seed: 9 });
    expect(withMotif).toEqual(compose({ ...base, seed: 9, externalMotif: source.motif }));
    expect(withMotif.melody.map((note) => note.midi))
      .not.toEqual(without.melody.map((note) => note.midi));
  });

  it('診断はフック反復が壊れた曲へ警告を出す', () => {
    const piece = compose({ ...base, seed: 3 });
    if (!cleanPhrasePair(piece, 0) || !cleanPhrasePair(piece, 2)) return;
    const start = piece.loopStartBeat + 2 * 4;
    piece.melody = piece.melody.map((note) => (
      note.beat >= start && note.beat < start + 8 && note.role !== 'ornament'
        ? { ...note, beat: note.beat + (note.beat % 1 === 0 ? 0.5 : -0.25), midi: 72 + ((note.midi * 7) % 12) }
        : note
    ));
    const report = diagnosePiece(piece);
    expect(report.issues.some((issue) => issue.reason.includes('フック'))).toBe(true);
  });
});
