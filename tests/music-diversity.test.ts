import { describe, expect, it } from 'vitest';
import {
  compose,
  diagnosePiece,
  melodicPhraseFingerprint,
  melodicSectionSimilarities,
  summarizeDistribution,
  variedChoiceFor,
} from '../src/core/music/compose.js';
import type { ComposeOptions, Piece } from '../src/core/music/compose.js';
import { PROGRESSIONS } from '../src/core/music/theory.js';

const fortyBarBase: ComposeOptions = {
  progressionId: 'jttou',
  styleId: 'rock',
  keyRoot: 5,
  bpm: 170,
  bars: 40,
  intro: false,
  tonality: 'major',
  melodicLanguage: 'standard',
  grooveFeel: 'straight',
  seed: 0,
};

function fullMelodyFingerprint(piece: Piece): string {
  return Array.from({ length: piece.bars / 2 }, (_, phrase) => (
    melodicPhraseFingerprint(piece, phrase * 2)
  )).join('||');
}

function sectionNotes(piece: Piece, section: number): string {
  const start = piece.loopStartBeat + section * 8 * 4;
  const notes = piece.melody.filter((note) => (
    note.role !== 'ornament' && note.beat >= start && note.beat < start + 8
  ));
  return notes.map((note) => `${note.beat - start}:${note.midi}`).join(',');
}

describe('作曲結果の収束防止', () => {
  it('8小節コード展開も登録済みの一形だけへ集中しない', () => {
    for (const prog of PROGRESSIONS) {
      const signatures = Array.from({ length: 1024 }, (_, seed) => (
        variedChoiceFor(prog, 8, seed).join(',')
      ));
      const summary = summarizeDistribution(signatures);
      const minimum = prog.slots.length === 8 ? 3 : 10;
      const maximumShare = prog.slots.length === 8 ? 0.4 : 0.13;
      expect(summary.unique, prog.id).toBeGreaterThanOrEqual(minimum);
      expect(summary.maxShare, prog.id).toBeLessThan(maximumShare);
    }
  });

  it('40小節コード展開は少数の巡回形へ集中しない', () => {
    for (const prog of PROGRESSIONS) {
      const signatures = Array.from({ length: 4096 }, (_, seed) => (
        variedChoiceFor(prog, 40, seed).join(',')
      ));
      const summary = summarizeDistribution(signatures);
      expect(summary.unique, prog.id).toBeGreaterThanOrEqual(80);
      expect(summary.maxShare, prog.id).toBeLessThan(0.03);
    }
  });

  it('16小節コード展開はAごとに決まったB一つへ収束しない', () => {
    for (const prog of PROGRESSIONS) {
      const signatures = Array.from({ length: 2048 }, (_, seed) => (
        variedChoiceFor(prog, 16, seed).join(',')
      ));
      const summary = summarizeDistribution(signatures);
      const minimum = prog.slots.length === 8 ? 10 : 120;
      const maximumShare = prog.slots.length === 8 ? 0.15 : 0.04;
      expect(summary.unique, prog.id).toBeGreaterThanOrEqual(minimum);
      expect(summary.maxShare, prog.id).toBeLessThan(maximumShare);
    }
  });

  it('JTTouロック40小節は、曲間と曲内の両方で旋律語彙が分散する', () => {
    const pieces = Array.from({ length: 256 }, (_, seed) => compose({ ...fortyBarBase, seed }));
    const openings = summarizeDistribution(pieces.map((piece) => melodicPhraseFingerprint(piece, 0)));
    const fullPieces = summarizeDistribution(pieces.map(fullMelodyFingerprint));
    expect(openings.unique).toBeGreaterThanOrEqual(160);
    expect(openings.maxShare).toBeLessThan(0.04);
    expect(fullPieces.unique).toBeGreaterThanOrEqual(250);
    expect(fullPieces.maxCount).toBeLessThanOrEqual(2);

    const converged = pieces.filter((piece) => melodicSectionSimilarities(piece).some((comparison) => (
      comparison.similarPhrases >= 3 || comparison.average >= 0.88
    )));
    expect(converged.length).toBeLessThanOrEqual(8);

    const exactAD = pieces.filter((piece) => sectionNotes(piece, 0) === sectionNotes(piece, 3));
    expect(exactAD.length).toBe(0);
    expect(pieces.filter((piece) => {
      const starts = [0, 1, 2, 3, 4].map((section) => {
        const beat = piece.loopStartBeat + section * 8 * 4;
        return piece.melody.find((note) => note.role !== 'ornament' && note.beat >= beat)?.midi;
      });
      return new Set(starts).size < 2;
    }).length).toBeLessThanOrEqual(4);
  });

  it('代表的な長調・短調・8小節進行でも曲全体の粗い指紋が集中しない', () => {
    const configurations: readonly Pick<
      ComposeOptions,
      'progressionId' | 'styleId' | 'keyRoot' | 'tonality'
    >[] = [
      { progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, tonality: 'major' },
      { progressionId: 'minor-pedal', styleId: 'rock', keyRoot: 5, tonality: 'minor' },
      { progressionId: 'canon', styleId: 'ska', keyRoot: 7, tonality: 'major' },
    ];
    for (const configuration of configurations) {
      const pieces = Array.from({ length: 96 }, (_, seed) => compose({
        ...fortyBarBase,
        ...configuration,
        seed,
      }));
      const summary = summarizeDistribution(pieces.map(fullMelodyFingerprint));
      expect(summary.unique, configuration.progressionId).toBeGreaterThanOrEqual(92);
      expect(summary.maxCount, configuration.progressionId).toBeLessThanOrEqual(2);
      expect(pieces.filter((piece) => melodicSectionSimilarities(piece).some((comparison) => (
        comparison.similarPhrases >= 3 || comparison.average >= 0.88
      ))).length, configuration.progressionId).toBeLessThanOrEqual(9);
    }
  });

  it('外部モチーフは各区間の冒頭2小節だけ借り、残り6小節は区間内で展開する', () => {
    const piece = compose({ ...fortyBarBase, seed: 42 });
    for (const section of piece.songPlan.form.sections.filter((candidate) => candidate.motifSourceSection !== null)) {
      expect(section.externalMotifPhrases).toEqual([0]);
      const plans = piece.phrasePlan.bars.slice(section.startBar, section.startBar + section.bars);
      expect(plans.slice(0, 2).some((plan) => (
        plan.motifSourceBar < section.startBar || plan.motifSourceBar >= section.startBar + section.bars
      ))).toBe(true);
      expect(plans.slice(2).every((plan) => (
        plan.motifSourceBar >= section.startBar && plan.motifSourceBar < section.startBar + section.bars
      ))).toBe(true);
    }
  });

  it('診断は完全コピーでなくても、複数フレーズのリズムと輪郭が似すぎた区間を検出する', () => {
    const piece = compose({ ...fortyBarBase, seed: 42 });
    const sourceStart = piece.loopStartBeat;
    const targetStart = piece.loopStartBeat + 3 * 8 * 4;
    const copied = piece.melody
      .filter((note) => note.beat >= sourceStart && note.beat < sourceStart + 8 * 4)
      .map((note) => ({ ...note, beat: targetStart + note.beat - sourceStart }));
    piece.melody = [
      ...piece.melody.filter((note) => note.beat < targetStart || note.beat >= targetStart + 8 * 4),
      ...copied,
    ].sort((first, second) => first.beat - second.beat);
    expect(diagnosePiece(piece).issues.some((issue) => issue.reason.includes('リズムと輪郭'))).toBe(true);
  });
});
