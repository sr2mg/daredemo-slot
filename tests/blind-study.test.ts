import { describe, expect, it } from 'vitest';
import { createBlindStudyTrial, summarizeBlindStudyVotes } from '../src/core/music/blind-study.js';
import { compose, validatePiece, variedChoiceFor } from '../src/core/music/compose.js';
import type { ComposeOptions } from '../src/core/music/compose.js';
import { PROGRESSIONS, STYLES } from '../src/core/music/theory.js';

const prog = PROGRESSIONS.find((candidate) => candidate.id === 'minor-pedal')!;
const base: ComposeOptions = {
  progressionId: prog.id,
  styleId: 'eurobeat',
  keyRoot: 0,
  bpm: 150,
  bars: 40,
  tonality: 'minor',
  seed: 42,
  choice: variedChoiceFor(prog, 40, 42),
};

describe('作曲戦略ブラインド比較', () => {
  it('同じ素材の3戦略を匿名候補X/Y/Zへ一度ずつ割り当てる', () => {
    const trial = createBlindStudyTrial('trial-1', base, 1234);
    expect(trial.candidates.map((candidate) => candidate.id)).toEqual(['X', 'Y', 'Z']);
    expect(new Set(trial.candidates.map((candidate) => candidate.strategy)))
      .toEqual(new Set(['current', 'memoryArc', 'premiseArc']));
    for (const candidate of trial.candidates) {
      expect(candidate.options.seed).toBe(base.seed);
      expect(candidate.options.choice).toEqual(base.choice);
      expect(candidate.options.compositionStrategy).toBe(candidate.strategy);
    }
  });

  it('同じ順番シードなら匿名化順も決定論的で、別シードでは複数の順番を取る', () => {
    const order = (seed: number) => createBlindStudyTrial('trial', base, seed)
      .candidates.map((candidate) => candidate.strategy).join(',');
    expect(order(99)).toBe(order(99));
    expect(new Set(Array.from({ length: 12 }, (_, seed) => order(seed))).size).toBeGreaterThan(1);
  });

  it('条件2はB・CでAを伏せ、Dの2フレーズでAを帰還させる', () => {
    const piece = compose({ ...base, compositionStrategy: 'memoryArc' });
    const sections = piece.songPlan.form.sections;
    expect(sections.map((section) => section.motifSourceSection))
      .toEqual([null, null, null, 'A', 'D']);
    expect(sections[3]!.externalMotifPhrases).toEqual([0, 1]);
    expect(piece.phrasePlan.bars.slice(24, 28).every((bar) => bar.motifSourceBar < 8)).toBe(true);
    expect(validatePiece(piece)).toEqual([]);
  });

  it('条件3は同じ記憶アークへ命題を通し、Cの不在とDの推進を編成にも反映する', () => {
    const piece = compose({ ...base, compositionStrategy: 'premiseArc' });
    const memory = compose({ ...base, compositionStrategy: 'memoryArc' });
    const policy = piece.songPlan.compositionPolicy;
    expect(piece.songPlan.premise).toBe('forwardLonging');
    expect(policy.active).toBe(true);
    expect(policy.motif.absenceSections).toEqual(['B', 'C']);
    expect(policy.motif.returnEvent).toMatchObject({ from: 'A', to: 'D', phrases: [0, 1] });
    expect(policy.harmony).toMatchObject({
      absenceSection: 'C',
      returnEvent: { from: 'A', to: 'D' },
      avoidTonicDuringAbsence: true,
      delayResolution: true,
    });
    const energyBySection = Object.fromEntries(
      piece.songPlan.form.sections.map((section) => [section.id, section.energy]),
    );
    expect(energyBySection.D).toBeGreaterThan(Math.max(
      energyBySection.A!, energyBySection.B!, energyBySection.C!, energyBySection.E!,
    ));
    expect(energyBySection.C).toBe(Math.min(...Object.values(energyBySection)));
    expect(piece.arrangementPlan.sections[2]!.drum).toBe('breakdown');
    expect(piece.arrangementPlan.sections[2]!.exitFill).toBe('full');
    expect(piece.arrangementPlan.sections[3]!.drum).toBe('sectionB');
    expect(piece.arrangementPlan.sections[3]!.entrance).toBe('cymbal');
    expect(piece.songPlan.harmony.slice(16, 24).every((bar) => bar.strategyRole === 'absence')).toBe(true);
    expect(piece.songPlan.harmony.slice(24, 32).every((bar) => bar.strategyRole === 'return')).toBe(true);
    expect(piece.songPlan.harmony.slice(24, 32).map((bar) => bar.tokens))
      .toEqual(piece.songPlan.harmony.slice(0, 8).map((bar) => bar.tokens));
    expect(piece.songPlan.harmony.slice(16, 24).map((bar) => bar.tokens))
      .not.toEqual(memory.songPlan.harmony.slice(16, 24).map((bar) => bar.tokens));
    expect(validatePiece(piece)).toEqual([]);
  });

  it('3条件は同じ進行語彙を保ち、条件3だけ意味に沿って和声実体も変える', () => {
    const current = compose({ ...base, compositionStrategy: 'current' });
    const memory = compose({ ...base, compositionStrategy: 'memoryArc' });
    const premise = compose({ ...base, compositionStrategy: 'premiseArc' });
    expect(memory.barChordNames).toEqual(current.barChordNames);
    expect(premise.barChordNames).not.toEqual(memory.barChordNames);
    expect(memory.melody).not.toEqual(current.melody);
    expect(premise.melody).not.toEqual(memory.melody);
    expect(premise.drums).not.toEqual(memory.drums);
  });

  it('40小節以外では上位戦略を半端に発火させない', () => {
    const short = { ...base, bars: 16 as const, choice: base.choice!.slice(0, 16) };
    const current = compose({ ...short, compositionStrategy: 'current' });
    const premise = compose({ ...short, compositionStrategy: 'premiseArc' });
    expect(premise.songPlan.compositionPolicy.active).toBe(false);
    expect(premise.barChordNames).toEqual(current.barChordNames);
    expect(premise.melody).toEqual(current.melody);
    expect(premise.drums).toEqual(current.drums);
    expect(premise.arrangementPlan).toEqual(current.arrangementPlan);
  });

  it('中心命題の意味的不変条件は複数進行・スタイル・音源・シードで保たれる', () => {
    const cases = [
      { progressionId: 'minor-pedal', tonality: 'minor' as const, keyRoot: 0 },
      { progressionId: 'jttou', tonality: 'major' as const, keyRoot: 0 },
      { progressionId: 'canon', tonality: 'major' as const, keyRoot: 7 },
    ];
    for (const configuration of cases) {
      const progression = PROGRESSIONS.find((candidate) => candidate.id === configuration.progressionId)!;
      for (const style of STYLES.slice(0, 2)) {
        for (const soundChip of ['opll', 'nes2a03'] as const) {
          for (const seed of [1, 42]) {
            const piece = compose({
              progressionId: progression.id,
              styleId: style.id,
              keyRoot: configuration.keyRoot,
              bpm: 150,
              bars: 40,
              tonality: configuration.tonality,
              soundChip,
              seed,
              choice: variedChoiceFor(progression, 40, seed),
              compositionStrategy: 'premiseArc',
            });
            const sections = Object.fromEntries(piece.songPlan.form.sections.map((section) => [section.id, section]));
            expect(sections.D!.energy, `${progression.id}/${style.id}/${soundChip}/${seed}`)
              .toBeGreaterThan(Math.max(sections.A!.energy, sections.B!.energy, sections.C!.energy, sections.E!.energy));
            expect(sections.C!.energy).toBe(Math.min(...piece.songPlan.form.sections.map((section) => section.energy)));
            expect(sections.B!.motifSourceSection).toBeNull();
            expect(sections.C!.motifSourceSection).toBeNull();
            expect(sections.D!.motifSourceSection).toBe('A');
            expect(piece.songPlan.harmony.slice(24, 32).map((bar) => bar.tokens))
              .toEqual(piece.songPlan.harmony.slice(0, 8).map((bar) => bar.tokens));
            expect(validatePiece(piece), `${progression.id}/${style.id}/${soundChip}/${seed}`).toEqual([]);
          }
        }
      }
    }
  });

  it('通常条件はstrategy省略時の既存生成と同じ', () => {
    expect(compose({ ...base, compositionStrategy: 'current' })).toEqual(compose(base));
  });

  it('投票集計は戦略ごとに数える', () => {
    expect(summarizeBlindStudyVotes([
      { trialId: 'a', selected: 'memoryArc', createdAt: 1 },
      { trialId: 'b', selected: 'premiseArc', createdAt: 2 },
      { trialId: 'c', selected: 'memoryArc', createdAt: 3 },
    ])).toEqual({ current: 0, memoryArc: 2, premiseArc: 1 });
  });
});
