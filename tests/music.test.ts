import { describe, expect, it } from 'vitest';
import {
  compose,
  checkPieceStructure,
  defaultChoiceFor,
  diagnosePiece,
  grooveBeat,
  hasVariedChoiceFor,
  japanesePlanFor,
  suggestCompositionRepair,
  validatePiece,
  variedChoiceFor,
} from '../src/core/music/compose.js';
import type { ComposeOptions } from '../src/core/music/compose.js';
import { CHORDS, PROGRESSIONS, STYLES, YO_SCALE, chordName } from '../src/core/music/theory.js';

const base: ComposeOptions = {
  progressionId: 'royal-pop',
  styleId: 'eurobeat',
  keyRoot: 0,
  bpm: 170,
  bars: 4,
  seed: 42,
};

function allChoicesFor(prog: (typeof PROGRESSIONS)[number], bars: 4 | 8): number[][] {
  let choices: number[][] = [[]];
  for (let bar = 0; bar < bars; bar++) {
    const optionCount = prog.slots[bar % prog.slots.length]!.length;
    choices = choices.flatMap((prefix) =>
      Array.from({ length: optionCount }, (_, option) => [...prefix, option]),
    );
  }
  return choices;
}

describe('理論データ', () => {
  it('進行カタログのトークンはすべてコード定義を持つ', () => {
    for (const prog of PROGRESSIONS) {
      for (const slot of prog.slots) {
        for (const opt of slot) {
          for (const token of opt) {
            expect(CHORDS[token], `${prog.id}: ${token}`).toBeDefined();
          }
        }
      }
    }
  });

  it('各進行は3〜5個の有効で重複しない変化レシピを持つ', () => {
    for (const prog of PROGRESSIONS) {
      expect(prog.variations.length, prog.id).toBeGreaterThanOrEqual(3);
      expect(prog.variations.length, prog.id).toBeLessThanOrEqual(5);
      expect(new Set(prog.variations.map((variation) => variation.join(','))).size, prog.id).toBe(
        prog.variations.length,
      );
      for (const variation of prog.variations) {
        expect(variation, prog.id).toHaveLength(prog.slots.length);
        expect(variation, prog.id).not.toEqual(prog.defaultChoice);
        if (prog.slots.length === 8) {
          expect(variation.slice(0, 4), `${prog.id}: 8小節の前半`).toEqual(prog.defaultChoice.slice(0, 4));
        }
        variation.forEach((choice, bar) => {
          expect(choice, `${prog.id}/${variation.join(',')}/${bar + 1}小節`).toBeLessThan(prog.slots[bar]!.length);
        });
      }
    }
  });

  it('各スタイルは骨格を保った16ステップのB用ドラムパターンを持つ', () => {
    for (const style of STYLES) {
      expect(style.sectionB.kick, `${style.id}/kick`).toHaveLength(16);
      expect(style.sectionB.snare, `${style.id}/snare`).toHaveLength(16);
      expect(style.sectionB.hat, `${style.id}/hat`).toHaveLength(16);
      expect(style.sectionB.snare, `${style.id}/backbeat`).toEqual(style.snare);
      expect(
        style.sectionB.kick.some((on, step) => on !== style.kick[step])
          || style.sectionB.hat.some((on, step) => on !== style.hat[step]),
        style.id,
      ).toBe(true);
      expect(style.melody.onsetWeights).toHaveLength(8);
      expect(style.melody.density[0]).toBeLessThanOrEqual(style.melody.density[1]);
    }
  });

  it('コード名はキーの平行移動（IV は C で F、G で C）', () => {
    expect(chordName('IV', 0)).toBe('F');
    expect(chordName('IV', 7)).toBe('C');
    expect(chordName('IVM7', 0)).toBe('FM7');
    expect(chordName('v7', 0)).toBe('Gm7');
  });
});

describe('compose', () => {
  it('同一シード + 同一設定で決定論的', () => {
    expect(compose(base)).toEqual(compose(base));
  });

  it('調性と旋律語法は独立し、旋律語法を変えても同じ短調和声を保つ', () => {
    const common = {
      ...base,
      progressionId: 'minor-drive',
      bars: 8 as const,
      tonality: 'minor' as const,
    };
    const standard = compose({ ...common, melodicLanguage: 'standard' });
    const japanese = compose({
      ...common, melodicLanguage: 'japanese', japaneseScale: 'ritsu',
    });
    expect(standard.tonality).toBe('minor');
    expect(japanese.tonality).toBe('minor');
    expect(japanese.melodicLanguage).toBe('japanese');
    expect(japanese.japanesePlan).not.toBeNull();
    expect(japanese.chords.map((chord) => [chord.token, chord.beat, chord.dur]))
      .toEqual(standard.chords.map((chord) => [chord.token, chord.beat, chord.dur]));
    expect(japanese.melody.map((note) => note.midi)).not.toEqual(standard.melody.map((note) => note.midi));
  });

  it('SongPlanがフォーム・和声機能・コード変化位置を各声部より先に確定する', () => {
    const prog = PROGRESSIONS.find((candidate) => candidate.id === 'minor-drive')!;
    const choice = defaultChoiceFor(prog, 16);
    choice[5] = 2; // 展開小節でVI→VIIを選び、SongPlanに変化位置を決めさせる。
    const piece = compose({
      ...base,
      progressionId: prog.id,
      bars: 16,
      tonality: 'minor',
      choice,
      seed: 13,
    });
    expect(piece.songPlan.form.sections).toHaveLength(2);
    expect(piece.songPlan.form.climaxBar).toBe(piece.phrasePlan.climaxBar);
    expect(piece.songPlan.harmony).toHaveLength(piece.bars);
    for (const planned of piece.songPlan.harmony) {
      const start = piece.loopStartBeat + planned.bar * 4;
      const actual = piece.chords.filter((chord) => chord.beat >= start && chord.beat < start + 4);
      expect(actual.map((chord) => chord.token)).toEqual(planned.tokens);
      expect(actual.map((chord) => chord.dur)).toEqual(planned.durations);
      expect(piece.phrasePlan.bars[planned.bar]!.phraseFunction).toBe(planned.phraseFunction);
    }
    const asymmetric = piece.songPlan.harmony.filter((bar) => bar.durations.join(',') !== '2,2' && bar.tokens.length === 2);
    expect(asymmetric.length).toBeGreaterThan(0);
    expect(asymmetric.every((bar) => ['depart', 'resolve', 'turnaround'].includes(bar.harmonicGoal))).toBe(true);
  });

  it('シードが違えばメロディが変わる', () => {
    const a = compose(base);
    const b = compose({ ...base, seed: 43 });
    expect(a.melody).not.toEqual(b.melody);
  });

  it('同じシードでもスタイルごとに主旋律の拍節と音価が変わる', () => {
    const pieces = STYLES.map((style) => compose({ ...base, styleId: style.id, bars: 8, seed: 42 }));
    const rhythmKeys = pieces.map((piece) => piece.melody.map((note) => note.beat).join(','));
    expect(new Set(rhythmKeys).size).toBe(STYLES.length);
    const averageDur = (styleId: string) => {
      const piece = pieces.find((candidate) => candidate.styleId === styleId)!;
      return piece.melody.reduce((sum, note) => sum + note.dur, 0) / piece.melody.length;
    };
    expect(averageDur('rock')).toBeGreaterThan(averageDur('ska'));
  });

  it('コードボイシングは交差せず、中央声部を7半音以内で接続する', () => {
    for (const prog of PROGRESSIONS) {
      if (prog.slots.length > 8) continue;
      const piece = compose({
        ...base, progressionId: prog.id, bars: 8, seed: 42,
        ...(prog.tonality === 'minor' ? { melodyMode: 'minor' as const } : {}),
      });
      for (let index = 0; index < piece.chords.length; index++) {
        const chord = piece.chords[index]!;
        expect(chord.midis, chord.name).toEqual([...chord.midis].sort((a, b) => a - b));
        expect(new Set(chord.midis).size, chord.name).toBe(chord.midis.length);
        const previous = piece.chords[index === 0 ? piece.chords.length - 1 : index - 1]!;
        for (const voice of [1, 2]) {
          if (chord.midis[voice] === undefined || previous.midis[voice] === undefined) continue;
          expect(Math.abs(chord.midis[voice]! - previous.midis[voice]!), `${prog.id}/${chord.name}/voice${voice}`)
            .toBeLessThanOrEqual(7);
        }
      }
    }
  });

  it('PhrasePlanの応答は終止目標へ到達し、副旋律の場所を主旋律と共有する', () => {
    const piece = compose({ ...base, progressionId: 'tanaka-manabe', styleId: 'ska', bars: 16, seed: 42 });
    for (const plan of piece.phrasePlan.bars) {
      if (plan.targetStep !== null && plan.targetPc !== null) {
        const beat = piece.loopStartBeat + plan.bar * 4 + plan.targetStep * 0.5;
        const target = piece.melody.find((note) => note.beat === beat);
        expect(target, `${plan.bar + 1}小節`).toBeDefined();
        expect(target!.midi % 12, `${plan.bar + 1}小節`).toBe(plan.targetPc);
      }
      for (const step of plan.counterSteps) {
        const beat = piece.loopStartBeat + plan.bar * 4 + step * 0.5;
        expect(piece.counterMelody.some((note) => note.beat === beat), `${plan.bar + 1}小節/${step}`).toBe(true);
        expect(piece.melody.some((note) => note.beat < beat + 0.01 && beat < note.beat + note.dur)).toBe(false);
      }
    }
  });

  it('構造チェックは8観点を状態表示し、生成上のエラーを残さない', () => {
    const piece = compose({ ...base, progressionId: 'jttou', styleId: 'ska', bars: 16, seed: 42 });
    const report = checkPieceStructure(piece);
    expect(Object.keys(report.categoryStatus).sort()).toEqual(
      ['counterpoint', 'form', 'harmony', 'loop', 'melody', 'rhythm', 'texture', 'voiceLeading'].sort(),
    );
    expect(report.status).not.toBe('error');
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(report.categoryStatus.voiceLeading).toBe('pass');
  });

  it('診断は反復する特徴音と定型装飾を、単独の非和声音エラーにしない', () => {
    const reports = Array.from({ length: 32 }, (_, seed) => diagnosePiece(compose({
      ...base, progressionId: 'tanaka-manabe', bars: 16, seed,
      melodicLanguage: 'japanese', japaneseScale: 'ritsu', grooveFeel: 'bounce',
    })));
    const motifObservations = reports.flatMap((report) =>
      report.observations
        .filter((observation) => observation.kind === 'motif')
        .map((observation) => ({ observation, report })),
    );
    expect(motifObservations.length).toBeGreaterThan(0);
    for (const { observation, report } of motifObservations) {
      expect(observation.relatedBeats.length).toBeGreaterThan(0);
      expect(report.issues.some((issue) => (
        issue.code === 'melody-unresolved-nonchord'
        && Math.abs(issue.beat - observation.beat) < 0.001
      ))).toBe(false);
    }
  });

  it('診断の局所修正は特徴音を残す解決を優先し、再診断・保存・Undo相当の再生成を通る', () => {
    const options = {
      ...base,
      progressionId: 'tanaka-manabe',
      bars: 16 as const,
      seed: 1,
      melodyMode: 'japanese' as const,
      japaneseScale: 'ritsu' as const,
      grooveFeel: 'bounce' as const,
    };
    const original = compose(options);
    const originalReport = diagnosePiece(original);
    const issue = originalReport.issues.find((candidate) => candidate.code === 'melody-unresolved-nonchord')!;
    const repair = suggestCompositionRepair(original, issue);
    expect(repair).not.toBeNull();
    expect(repair!.strategy).toBe('resolve-next');
    expect(repair!.edit.beat).not.toBe(issue.beat);

    const repairedOptions = { ...options, melodyEdits: [repair!.edit] };
    const repaired = compose(repairedOptions);
    const repairedReport = diagnosePiece(repaired);
    expect(repairedReport.issues.some((candidate) => (
      candidate.code === issue.code && Math.abs(candidate.beat - issue.beat) < 0.001
    ))).toBe(false);
    expect(repairedReport.overall).toBeGreaterThanOrEqual(originalReport.overall);
    expect(repaired.melody.filter((note, index) => note.midi !== original.melody[index]!.midi)).toHaveLength(1);
    expect(compose(JSON.parse(JSON.stringify(repairedOptions)))).toEqual(repaired);
    expect(compose(options)).toEqual(original);
  });

  it('クライマックス候補はフォーム内でシードにより前後する', () => {
    expect(compose({ ...base, bars: 8, seed: 42 }).phrasePlan.climaxBar).toBe(4);
    expect(compose({ ...base, bars: 8, seed: 43 }).phrasePlan.climaxBar).toBe(6);
    expect(compose({ ...base, bars: 16, seed: 42 }).phrasePlan.climaxBar).toBe(12);
    expect(compose({ ...base, bars: 16, seed: 43 }).phrasePlan.climaxBar).toBe(14);
  });

  it('全進行 × 全スタイル × 全調性対応の旋律語法 × 全グルーヴ × 4/8/16小節で生成検証を通る', () => {
    for (const prog of PROGRESSIONS) {
      for (const style of STYLES) {
        for (const melodicLanguage of ['standard', 'japanese'] as const) {
          for (const grooveFeel of ['straight', 'tripletOverlay', 'bounce'] as const) {
            for (const bars of [4, 8, 16] as const) {
              if (prog.slots.length > bars) continue;
              for (const [seedIndex, seed] of [1, 42, 12345].entries()) {
                const japaneseScale = (['ritsu', 'minyo', 'miyakobushi'] as const)[seedIndex]!;
                const piece = compose({
                  ...base, progressionId: prog.id, styleId: style.id, tonality: prog.tonality,
                  melodicLanguage, grooveFeel, bars, seed,
                  ...(melodicLanguage === 'japanese' ? { japaneseScale } : {}),
                });
                expect(
                  validatePiece(piece),
                  `${prog.id}/${style.id}/${prog.tonality}+${melodicLanguage}/${grooveFeel}/${bars}小節/seed=${seed}`,
                ).toEqual([]);
              }
            }
          }
        }
      }
    }
  });

  it('定番の田中・真部進行はキー C で F G Am C', () => {
    const piece = compose({ ...base, progressionId: 'tanaka-manabe' });
    expect(piece.barChordNames).toEqual(['F', 'G', 'Am', 'C']);
  });

  it('4小節進行の BB(8小節) 展開は A+A\'（最終小節だけ V でループを引っ張る）', () => {
    const prog = PROGRESSIONS.find((p) => p.id === 'tanaka-manabe')!;
    const choice = defaultChoiceFor(prog, 8);
    expect(choice.slice(0, 4)).toEqual(choice.slice(4).map((v, i) => (i === 3 ? choice[3]! : v)));
    const piece = compose({ ...base, progressionId: 'tanaka-manabe', bars: 8 });
    expect(piece.barChordNames.slice(0, 3)).toEqual(piece.barChordNames.slice(4, 7));
    expect(piece.barChordNames[7]).toBe('G'); // V
  });

  it('控えめなコード変化は決定論的に登録済みレシピから抽選する', () => {
    const prog = PROGRESSIONS.find((p) => p.id === 'tanaka-manabe')!;
    const standard = defaultChoiceFor(prog, 4);
    const results = Array.from({ length: 200 }, (_, seed) => variedChoiceFor(prog, 4, seed));
    const recipeKeys = new Set(prog.variations.map((variation) => variation.join(',')));

    expect(variedChoiceFor(prog, 4, 42)).toEqual(variedChoiceFor(prog, 4, 42));
    expect(results.some((choice) => choice.every((value, bar) => value === standard[bar]))).toBe(true);
    expect(results.some((choice) => choice.some((value, bar) => value !== standard[bar]))).toBe(true);
    for (const choice of results) {
      expect(choice.join(',') === standard.join(',') || recipeKeys.has(choice.join(','))).toBe(true);
    }
  });

  it('コード変化ボタンは現在と異なるレシピを必ず抽選する', () => {
    const prog = PROGRESSIONS.find((p) => p.id === 'tanaka-manabe')!;
    const current = prog.variations[0]!;
    const results = new Set<string>();
    expect(hasVariedChoiceFor(prog, 4, current)).toBe(true);
    for (let seed = 0; seed < 200; seed++) {
      const choice = variedChoiceFor(prog, 4, seed, { chancePercent: 100, currentChoice: current });
      expect(choice).not.toEqual(current);
      expect(prog.variations).toContainEqual(choice);
      results.add(choice.join(','));
    }
    expect(results.size).toBeGreaterThan(1);
  });

  it('全スロット選択肢の組み合わせで強拍コードトーン検証を通る', () => {
    for (const prog of PROGRESSIONS) {
      for (const bars of [4, 8] as const) {
        if (prog.slots.length > bars) continue;
        for (const choice of allChoicesFor(prog, bars)) {
          for (const seed of [1, 42]) {
            const piece = compose({
              ...base, progressionId: prog.id, bars, choice, seed,
              ...(prog.tonality === 'minor' ? { melodyMode: 'minor' as const } : {}),
            });
            expect(validatePiece(piece), `${prog.id}/${bars}小節/${choice.join(',')}/seed=${seed}`).toEqual([]);
          }
        }
      }
    }
  });

  it('8小節のコード変化は前半を固定し、後半を登録済みレシピにする', () => {
    const prog = PROGRESSIONS.find((p) => p.id === 'tanaka-manabe')!;
    const standard = defaultChoiceFor(prog, 8);
    const recipeKeys = new Set(prog.variations.map((variation) => variation.join(',')));
    for (let seed = 0; seed < 200; seed++) {
      const choice = variedChoiceFor(prog, 8, seed);
      expect(choice.slice(0, 4)).toEqual(standard.slice(0, 4));
      expect(choice.join(',') === standard.join(',') || recipeKeys.has(choice.slice(4).join(','))).toBe(true);
    }
  });

  it('16小節のコード変化はAを固定し、Bを確認済みレシピで展開する', () => {
    for (const prog of PROGRESSIONS) {
      const sectionA = defaultChoiceFor(prog, 8);
      const choice = variedChoiceFor(prog, 16, 42);
      expect(choice).toHaveLength(16);
      expect(choice.slice(0, 8), prog.id).toEqual(sectionA);
      expect(choice.slice(8), prog.id).not.toEqual(sectionA);
      const lastSlot = prog.slots[15 % prog.slots.length]!;
      const strongest = lastSlot.some((option) => ['V', 'I7'].includes(option[option.length - 1]!));
      const lastTokens = lastSlot[choice[15]!]!;
      if (strongest) expect(['V', 'I7'], `${prog.id}/ターンアラウンド`).toContain(lastTokens.at(-1));
      const piece = compose({
        ...base, progressionId: prog.id, bars: 16, choice,
        ...(prog.tonality === 'minor' ? { melodyMode: 'minor' as const } : {}),
      });
      expect(validatePiece(piece), prog.id).toEqual([]);
    }
  });

  it('40小節の半小節コード変化は任意の道具で、選んだ場合はBとEで回帰する', () => {
    const prog = PROGRESSIONS.find((candidate) => candidate.id === 'minor-pedal')!;
    const choices = Array.from({ length: 128 }, (_, seed) => variedChoiceFor(prog, 40, seed));
    const splitBars = (choice: readonly number[], start: number, end: number) => (
      Array.from({ length: end - start }, (_, offset) => offset)
        .filter((offset) => prog.slots[(start + offset) % prog.slots.length]![choice[start + offset]!]!.length > 1)
    );
    expect(choices.some((choice) => splitBars(choice, 0, 40).length === 0)).toBe(true);
    expect(choices.some((choice) => splitBars(choice, 0, 40).length > 0)).toBe(true);
    const withSplit = choices.find((choice) => splitBars(choice, 8, 15).length > 0)!;
    expect(splitBars(withSplit, 32, 39)).toEqual(splitBars(withSplit, 8, 15));
  });

  it('16小節フォームだけに2小節のフック＋応答イントロを置き、Aの頭をループ開始点にする', () => {
    const evenSeed = compose({ ...base, bars: 16, seed: 42 });
    const oddSeed = compose({ ...base, bars: 16, seed: 43 });
    const withoutIntro = compose({ ...base, bars: 16, seed: 43, intro: false });
    const short = compose({ ...base, bars: 8, seed: 43 });

    expect(evenSeed.introBars).toBe(2);
    expect(evenSeed.loopStartBeat).toBe(8);
    expect(evenSeed.beats).toBe(8 + 16 * 4);
    expect(evenSeed.introChordNames).toHaveLength(2);
    expect(evenSeed.introRole).not.toBeNull();
    expect(oddSeed.introBars).toBe(2);
    expect(withoutIntro.introBars).toBe(0);
    expect(withoutIntro.introRole).toBeNull();
    expect(withoutIntro.loopStartBeat).toBe(0);
    expect(withoutIntro.beats).toBe(16 * 4);
    expect(withoutIntro.introChordNames).toEqual([]);
    expect(short.introBars).toBe(0);
    expect(short.loopStartBeat).toBe(0);
    expect(short.beats).toBe(8 * 4);
    expect(evenSeed.chords.find((chord) => chord.beat === evenSeed.loopStartBeat)?.name).toBe(evenSeed.barChordNames[0]);

    const variants = STYLES.flatMap((style) =>
      Array.from({ length: 12 }, (_, seed) => compose({ ...base, bars: 16, styleId: style.id, seed: seed + 40 })),
    );
    const leadRhythms = new Set<string>();
    const introRoles = new Set<string>();
    for (const piece of variants) {
      const firstBarLead = piece.melody.filter((note) => note.beat < 4);
      const secondBarLead = piece.melody.filter((note) => note.beat >= 4 && note.beat < 8);
      const firstBarBass = piece.bass.filter((note) => note.beat < 4);
      const secondBarBass = piece.bass.filter((note) => note.beat >= 4 && note.beat < 8);
      expect(firstBarLead.length).toBeGreaterThanOrEqual(4);
      expect(firstBarLead.length).toBeLessThanOrEqual(7);
      expect(secondBarLead.length).toBeGreaterThan(firstBarLead.length);
      expect(secondBarLead.length).toBeLessThanOrEqual(11);
      expect(firstBarBass.length).toBeGreaterThanOrEqual(4);
      expect(secondBarBass.length).toBeGreaterThan(firstBarBass.length);
      const introDrums = piece.drums.filter((drum) => drum.beat < piece.loopStartBeat);
      if (piece.introRole === 'groove') expect(introDrums.length).toBeGreaterThan(0);
      else expect(introDrums).toEqual([]);
      if (introDrums.length > 0) expect(Math.max(...introDrums.map((drum) => drum.beat))).toBeLessThanOrEqual(6);
      expect(piece.chords.find((chord) => chord.beat === 4)?.dur).toBe(2.5);
      expect(Math.max(...secondBarLead.map((note) => note.beat + note.dur))).toBeLessThanOrEqual(6.5);
      expect(Math.max(...secondBarBass.map((note) => note.beat + note.dur))).toBeLessThanOrEqual(6.5);
      expect(validatePiece(piece)).toEqual([]);
      if (piece.introRole === 'motif') {
        expect(firstBarLead.map((note) => note.beat)).toEqual(
          piece.melody
            .filter((note) => note.beat >= piece.loopStartBeat && note.beat < piece.loopStartBeat + 4)
            .map((note) => note.beat - piece.loopStartBeat),
        );
      }
      leadRhythms.add(piece.melody.filter((note) => note.beat < 8).map((note) => note.beat).join(','));
      if (piece.introRole) introRoles.add(piece.introRole);
    }
    expect(leadRhythms.size).toBeGreaterThanOrEqual(4);
    expect([...introRoles].sort()).toEqual(['fanfare', 'groove', 'motif', 'runup']);
    expect(compose({ ...base, bars: 16, seed: 42 }).melody.filter((note) => note.beat < 8)).toEqual(
      evenSeed.melody.filter((note) => note.beat < 8),
    );
  });

  it('16小節ではBのリズム型をAから変える', () => {
    const piece = compose({
      ...base,
      progressionId: 'tanaka-manabe',
      bars: 16,
      choice: variedChoiceFor(PROGRESSIONS.find((p) => p.id === 'tanaka-manabe')!, 16, 42),
    });
    const rhythmAt = (bar: number) =>
      piece.melody
        .filter((note) => note.beat >= piece.loopStartBeat + bar * 4 && note.beat < piece.loopStartBeat + (bar + 1) * 4)
        .map((note) => note.beat - piece.loopStartBeat - bar * 4);
    expect(rhythmAt(8)).not.toEqual(rhythmAt(0));
  });

  it('16小節ではSongPlanの低密度区間と高密度区間で仕掛けを交替し、同時に足さない', () => {
    const piece = compose({ ...base, progressionId: 'tanaka-manabe', bars: 16, seed: 42 });
    expect(piece.arrangementPlan.textureStrategy).toBe('arpDrive');
    expect(piece.arrangementPlan.sectionA.echo).toBe(true);
    expect(piece.arrangementPlan.sectionB.ostinatoDensity).toBeGreaterThan(0);
    expect(piece.ostinato.some((note) => note.beat >= piece.loopStartBeat + 8 * 4)).toBe(true);
    expect(piece.arrangementPlan.sections.every((section) => (
      Number(section.echo) + Number(section.counterDensity > 0) + Number(section.ostinatoDensity > 0)
    ) <= 1)).toBe(true);
  });

  it('メロディは提示→変奏反復→展開→結論を持ち、反復では輪郭を保つ', () => {
    const piece = compose({ ...base, progressionId: 'tanaka-manabe', bars: 8, seed: 42 });
    const rhythmAt = (bar: number) =>
      piece.melody
        .filter((note) => note.beat >= bar * 4 && note.beat < (bar + 1) * 4)
        .map((note) => note.beat - bar * 4);
    const contourAt = (bar: number) => {
      const notes =
      piece.melody
        .filter((note) => note.beat >= bar * 4 && note.beat < (bar + 1) * 4)
        .map((note) => note.midi);
      return notes.slice(1).map((midi, index) => Math.sign(midi - notes[index]!));
    };

    expect(rhythmAt(0)).not.toEqual(rhythmAt(1));
    expect(rhythmAt(0)).toEqual(rhythmAt(2));
    expect(rhythmAt(1)).toEqual(rhythmAt(3));
    expect(piece.phrasePlan.bars.map((plan) => plan.phraseFunction)).toEqual([
      'statement', 'statement', 'restatement', 'restatement',
      'departure', 'departure', 'conclusion', 'conclusion',
    ]);
    expect(piece.phrasePlan.bars.map((plan) => plan.motifSourceBar)).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
    expect(contourAt(2)).toEqual(contourAt(0));
    expect(contourAt(4)).not.toEqual(contourAt(0));
    expect(contourAt(6)).toEqual(contourAt(0));
  });

  it('和風様式は3種の五音音組織と核音を持ち、キーと一緒に移調する', () => {
    const specs = {
      ritsu: [0, 2, 5, 7, 9],
      minyo: [0, 3, 5, 7, 10],
      miyakobushi: [0, 1, 5, 7, 8],
    } as const;
    for (const [id, intervals] of Object.entries(specs)) {
      const plan = japanesePlanFor(2, id as keyof typeof specs);
      expect(plan.id).toBe(id);
      expect(plan.intervals).toEqual(intervals);
      expect(plan.scalePcs).toEqual(intervals.map((interval) => (interval + 2) % 12));
      expect(plan.nuclearPcs).toEqual([2, 7, 9]);
    }
    expect(japanesePlanFor(0, 'auto', 0).id).toBe('ritsu');
    expect(japanesePlanFor(0, 'auto', 2).id).toBe('minyo');
    expect(japanesePlanFor(0, 'auto', 4).id).toBe('miyakobushi');
  });

  it('和風様式は核音・応答の間・疎な装飾・開放5度を一つのフレーズ設計にする', () => {
    const major = compose({ ...base, progressionId: 'tanaka-manabe', bars: 8, seed: 42 });
    const japanese = compose({
      ...base,
      progressionId: 'tanaka-manabe',
      bars: 8,
      seed: 42,
      melodyMode: 'japanese',
      japaneseScale: 'ritsu',
    });
    const japaneseSkeleton = japanese.melody.filter((note) => note.role !== 'ornament');
    const ornaments = japanese.melody.filter((note) => note.role === 'ornament');
    expect(japaneseSkeleton.map((note) => note.beat)).not.toEqual(major.melody.map((note) => note.beat));
    expect(japanese.melody.map((note) => note.midi)).not.toEqual(major.melody.map((note) => note.midi));
    expect(ornaments.length).toBeGreaterThan(0);
    expect(ornaments.every((note) => note.articulation === 'ornament')).toBe(true);
    const ornamentBars = japanese.phrasePlan.bars.filter((plan) => plan.ornamentType !== null);
    expect(ornamentBars).toHaveLength(2);
    expect(ornamentBars.map((plan) => Math.floor(plan.bar / 4))).toEqual([0, 1]);
    expect(ornamentBars.every((plan) => plan.bar % 2 === 1)).toBe(true);
    expect(japanese.phrasePlan.bars.filter((plan) => plan.maSteps.length > 0)).toHaveLength(4);
    for (const plan of japanese.phrasePlan.bars) {
      expect(plan.maSteps.every((step) => !plan.rhythm[step])).toBe(true);
    }
    const scalePcs = YO_SCALE.map((interval) => interval % 12);
    for (const note of japanese.melody) {
      const chord = [...japanese.chords].reverse().find((event) => event.beat <= note.beat)!;
      expect(
        scalePcs.includes(note.midi % 12 as (typeof scalePcs)[number]) || chord.pcs.includes(note.midi % 12),
        `beat=${note.beat}/midi=${note.midi}`,
      ).toBe(true);
    }
    for (const plan of japanese.phrasePlan.bars) {
      if (plan.targetStep === null || plan.targetPc === null) continue;
      const targetBeat = plan.bar * 4 + plan.targetStep * 0.5;
      const chord = [...japanese.chords].reverse().find((event) => event.beat <= targetBeat)!;
      const availableNuclearTones = chord.pcs.filter((pc) => japanese.japanesePlan!.nuclearPcs.includes(pc));
      if (availableNuclearTones.length > 0) expect(availableNuclearTones).toContain(plan.targetPc);
    }
    for (const chord of japanese.chords) {
      const voicingPcs = new Set(chord.midis.map((midi) => midi % 12));
      expect(voicingPcs.size).toBeLessThanOrEqual(2);
      expect([...voicingPcs].every((pc) => pc === chord.pcs[0] || pc === chord.pcs[2])).toBe(true);
    }
    expect(validatePiece(japanese)).toEqual([]);
  });

  it('装飾は4小節に一度だけ抽選し、前打音・回し・揺りの3種を使い分ける', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 24; seed++) {
      const piece = compose({
        ...base, progressionId: 'tanaka-manabe', bars: 8, seed,
        melodyMode: 'japanese', japaneseScale: 'ritsu',
      });
      const decorated = piece.phrasePlan.bars.filter((plan) => plan.ornamentType !== null);
      expect(decorated).toHaveLength(2);
      for (const plan of decorated) {
        seen.add(plan.ornamentType!);
        const expectedSteps = plan.ornamentType === 'turn' ? 2 : plan.ornamentType === 'grace' ? 1 : 0;
        expect(plan.ornamentSteps).toHaveLength(expectedSteps);
        if (plan.ornamentType === 'shake') {
          const targetBeat = plan.bar * 4 + plan.targetStep! * 0.5;
          expect(piece.melody.find((note) => note.beat === targetBeat)?.ornament).toBe('shake');
        }
      }
    }
    expect([...seen].sort()).toEqual(['grace', 'shake', 'turn']);
  });

  it('ゲームグルーヴは和風様式から独立し、三連レイヤーと跳ねる8分を別処理する', () => {
    const straight = compose({ ...base, progressionId: 'tanaka-manabe', bars: 8, grooveFeel: 'straight' });
    const triplet = compose({ ...base, progressionId: 'tanaka-manabe', bars: 8, grooveFeel: 'tripletOverlay' });
    const bounce = compose({ ...base, progressionId: 'tanaka-manabe', bars: 8, grooveFeel: 'bounce' });

    expect(triplet.melody).toEqual(straight.melody);
    expect(triplet.bass).toEqual(straight.bass);
    expect(triplet.drums.filter((event) => event.inst !== 'hat')).toEqual(
      straight.drums.filter((event) => event.inst !== 'hat'),
    );
    const tripletHats = triplet.drums.filter((event) => event.inst === 'hat');
    expect(tripletHats.some((event) => Math.abs(event.beat % 1 - 2 / 3) < 0.001)).toBe(true);
    expect(tripletHats.length).toBeLessThanOrEqual(
      straight.drums.filter((event) => event.inst === 'hat').length,
    );
    const hitsPerQuarter = new Map<number, number>();
    for (const event of tripletHats) {
      const quarter = Math.floor(event.beat + 0.001);
      hitsPerQuarter.set(quarter, (hitsPerQuarter.get(quarter) ?? 0) + 1);
    }
    expect(Math.max(...hitsPerQuarter.values())).toBeLessThanOrEqual(2);

    // 元譜に細かい裏打ちがある区間だけは1/3も残すが、常時3発にはしない。
    const detailedTriplet = compose({
      ...base, progressionId: 'tanaka-manabe', styleId: 'ska', bars: 16, seed: 42,
      grooveFeel: 'tripletOverlay', intro: false,
    });
    const detailedHats = detailedTriplet.drums.filter((event) => event.inst === 'hat');
    expect(detailedHats.some((event) => Math.abs(event.beat % 1 - 1 / 3) < 0.001)).toBe(true);
    const detailedHitsPerQuarter = new Map<number, number>();
    for (const event of detailedHats) {
      const quarter = Math.floor(event.beat + 0.001);
      detailedHitsPerQuarter.set(quarter, (detailedHitsPerQuarter.get(quarter) ?? 0) + 1);
    }
    expect(Math.max(...detailedHitsPerQuarter.values())).toBeLessThanOrEqual(2);

    expect(grooveBeat(0.25, 'bounce')).toBe(0.25);
    expect(grooveBeat(0.5, 'bounce')).toBeCloseTo(2 / 3, 9);
    expect(grooveBeat(1.5, 'bounce')).toBeCloseTo(1 + 2 / 3, 9);
    expect(bounce.melody.map((note) => note.midi)).toEqual(straight.melody.map((note) => note.midi));
    expect(bounce.melody.map((note) => note.beat)).not.toEqual(straight.melody.map((note) => note.beat));
    expect(bounce.melody.some((note) => Math.abs(note.beat % 1 - 2 / 3) < 0.001)).toBe(true);

    const japaneseTriplet = compose({
      ...base, progressionId: 'tanaka-manabe', bars: 8,
      melodyMode: 'japanese', japaneseScale: 'miyakobushi', grooveFeel: 'tripletOverlay',
    });
    expect(japaneseTriplet.drums).toEqual(triplet.drums);
    expect(validatePiece(triplet)).toEqual([]);
    expect(validatePiece(bounce)).toEqual([]);
    expect(validatePiece(japaneseTriplet)).toEqual([]);
  });

  it('16小節の編成設計は積み上げ・対比・段丘と、選択的な編成戦略を持つ', () => {
    const pieces = [42, 44, 46].map((seed) => compose({
      ...base, progressionId: 'tanaka-manabe', bars: 16, seed,
    }));
    expect(pieces.map((piece) => piece.arrangementPlan.arc)).toEqual(['build', 'contrast', 'terrace']);
    expect(pieces.map((piece) => piece.arrangementPlan.textureStrategy))
      .toEqual(['arpDrive', 'bassDrive', 'hybrid']);
    for (const piece of pieces) {
      const [a, b] = piece.songPlan.form.sections.map((section) => section.energy);
      if (piece.arrangementPlan.arc === 'build') expect(b).toBeGreaterThan(a!);
      if (piece.arrangementPlan.arc === 'contrast') expect(b).toBeLessThan(a!);
      if (piece.arrangementPlan.arc === 'terrace') expect(b).toBe(a);
    }
    expect(pieces.every((piece) => piece.arrangementPlan.sections.every((section) => (
      Number(section.echo) + Number(section.counterDensity > 0) + Number(section.ostinatoDensity > 0)
    ) <= 1))).toBe(true);
  });

  it('編成戦略はスタイルと音源制限を参照し、2A03では使えない独立分散和音を計画しない', () => {
    const common = {
      ...base,
      progressionId: 'minor-pedal',
      bars: 40 as const,
      tonality: 'minor' as const,
      seed: 2,
    };
    const opll = compose({ ...common, soundChip: 'opll' });
    const nes = compose({ ...common, soundChip: 'nes2a03' });
    expect(opll.arrangementPlan.textureStrategy).toBe('arpDrive');
    expect(opll.ostinato.length).toBeGreaterThan(0);
    expect(['classic', 'bassDrive']).toContain(nes.arrangementPlan.textureStrategy);
    expect(nes.arrangementPlan.sections.every((section) => section.ostinatoDensity === 0)).toBe(true);
    expect(nes.ostinato).toEqual([]);
    expect(checkPieceStructure(nes).status).not.toBe('error');

    const ska = compose({ ...common, styleId: 'ska', soundChip: 'opll' });
    expect(['counterDrive', 'hybrid']).toContain(ska.arrangementPlan.textureStrategy);
  });

  it('音符へ強弱・奏法、コードへ和声機能を持たせる', () => {
    const piece = compose({ ...base, progressionId: 'royal-pop', bars: 16, seed: 42 });
    expect(piece.melody.every((note) => note.velocity !== undefined && note.articulation !== undefined)).toBe(true);
    expect(piece.bass.every((note) => note.velocity !== undefined && note.articulation !== undefined)).toBe(true);
    expect(piece.melody.some((note) => note.articulation === 'accent')).toBe(true);
    expect(piece.melody.some((note) => note.articulation === 'tenuto')).toBe(true);
    expect(new Set(piece.chords.map((chord) => chord.function)).size).toBeGreaterThan(1);
    expect(diagnosePiece(piece).scores.harmony).toBeGreaterThanOrEqual(90);
  });

  it('副旋律は全スタイルで主旋律の休符だけに短く応答する', () => {
    for (const style of STYLES) {
      const piece = compose({ ...base, styleId: style.id, bars: 8, seed: 42 });
      expect(piece.counterMelody.length, style.id).toBeGreaterThan(0);
      for (const response of piece.counterMelody) {
        expect(Math.floor(response.beat / 4) % 2, `${style.id}/beat=${response.beat}`).toBe(1);
        const overlapsLead = piece.melody.some(
          (lead) => lead.beat < response.beat + response.dur && response.beat < lead.beat + lead.dur,
        );
        expect(overlapsLead, `${style.id}/beat=${response.beat}`).toBe(false);
      }
      expect(validatePiece(piece), style.id).toEqual([]);
    }
  });

  it('ベースは小節の偶奇でなく、PhrasePlanの終止機能とスタイルで次コードへ接続する', () => {
    for (const style of STYLES) {
      const piece = compose({ ...base, styleId: style.id, bars: 8, seed: 42 });
      for (const plan of piece.phrasePlan.bars) {
        if (!plan.cadence) continue;
        const bar = plan.bar;
        const inBar = piece.bass.filter((note) => note.beat >= bar * 4 && note.beat < (bar + 1) * 4);
        const last = inBar[inBar.length - 1]!;
        const endChord = [...piece.chords].reverse().find((chord) => chord.beat < (bar + 1) * 4)!;
        const endRootPc = (CHORDS[endChord.token]!.root + piece.keyRoot) % 12;
        if (plan.cadence === 'open') {
          expect(last.midi % 12, `${style.id}/${bar + 1}小節/open`).toBe((endRootPc + 7) % 12);
        } else if (plan.cadence === 'closed') {
          expect(last.midi % 12, `${style.id}/${bar + 1}小節/closed`).toBe(endRootPc);
        } else if (style.bassCadence === 'chromatic') {
          const nextBeat = bar + 1 < piece.bars ? (bar + 1) * 4 : 0;
          const nextChord = piece.chords.find((chord) => chord.beat === nextBeat)!;
          const nextRootPc = (CHORDS[nextChord.token]!.root + piece.keyRoot) % 12;
          expect([1, 11], `${style.id}/${bar + 1}小節/chromatic`).toContain((last.midi - nextRootPc + 12) % 12);
        } else if (style.bassCadence === 'chordTone') {
          expect(endChord.pcs, `${style.id}/${bar + 1}小節/chordTone`).toContain(last.midi % 12);
        } else {
          expect(last.beat % 4, `${style.id}/${bar + 1}小節/pickup`).toBe(3.5);
        }
      }
    }
  });

  it('16小節では8小節目の末尾にA→Bのドラムフィルを置く', () => {
    const piece = compose({ ...base, progressionId: 'tanaka-manabe', bars: 16, seed: 42 });
    const fillStart = piece.loopStartBeat + 7 * 4 + 3;
    const fill = piece.drums
      .filter((event) => event.beat >= fillStart && event.beat < fillStart + 1 && event.inst !== 'hat')
      .map((event) => `${event.inst}:${event.beat - piece.loopStartBeat}`);
    expect(fill).toEqual(['kick:31', 'snare:31', 'tom:31.5', 'cymbal:31.75']);
  });

  it('フィル後はスタイル別のBグルーヴへ変わり、最終拍を空けてAへ戻す', () => {
    for (const style of STYLES) {
      const piece = compose({ ...base, progressionId: 'tanaka-manabe', styleId: style.id, bars: 16 });
      const patternAt = (bar: number) =>
        piece.drums
          .filter((event) => event.beat >= piece.loopStartBeat + bar * 4 && event.beat < piece.loopStartBeat + (bar + 1) * 4)
          .map((event) => `${event.inst}:${event.beat - piece.loopStartBeat - bar * 4}`);
      expect(patternAt(8), style.id).not.toEqual(patternAt(0));
      expect(patternAt(8), `${style.id}/2拍目`).toContain('snare:1');
      expect(patternAt(8), `${style.id}/4拍目`).toContain('snare:3');
      const finalBeat = piece.loopStartBeat + 15 * 4 + 3;
      expect(piece.drums.filter((event) => event.beat >= finalBeat), `${style.id}/最終拍`).toEqual([]);
    }
  });

  it('JTTOU 進行はキー外の音（E7 の G# 等）を正しくコードトーンとして扱う', () => {
    const piece = compose({ ...base, progressionId: 'jttou' });
    expect(piece.barChordNames).toEqual(['FM7', 'E7', 'Am7', 'Gm7(3拍) C7(1拍)']);
    const e7 = piece.chords.find((c) => c.token === 'III7')!;
    expect(e7.pcs).toContain(8); // G#
    expect(validatePiece(piece)).toEqual([]);
  });

  it('ComposeOptions は JSON 往復で同じ曲を再現する（BGM ライブラリの保存形式）', () => {
    const opts = { ...base, progressionId: 'tanaka-manabe', bars: 8 as const, choice: defaultChoiceFor(PROGRESSIONS.find((p) => p.id === 'tanaka-manabe')!, 8) };
    const roundTripped = JSON.parse(JSON.stringify(opts)) as typeof opts;
    expect(compose(roundTripped)).toEqual(compose(opts));
  });

  it('尺より長い進行はエラー（カノン風 8 小節を RB に使えない）', () => {
    expect(() => compose({ ...base, progressionId: 'canon', bars: 4 })).toThrow();
  });

  it('クライマックス（最高音）は BB で 7 小節目に置かれる', () => {
    const piece = compose({ ...base, progressionId: 'tanaka-manabe', bars: 8, seed: 7 });
    const highest = Math.max(...piece.melody.map((n) => n.midi));
    const at = piece.melody.find((n) => n.midi === highest)!;
    expect(Math.floor(at.beat / 4)).toBe(6);
  });

  it('16小節のクライマックス（最高音）はB終盤の15小節目に置かれる', () => {
    const prog = PROGRESSIONS.find((p) => p.id === 'tanaka-manabe')!;
    const piece = compose({
      ...base,
      progressionId: prog.id,
      bars: 16,
      seed: 7,
      choice: variedChoiceFor(prog, 16, 7),
    });
    const highest = Math.max(...piece.melody.map((n) => n.midi));
    const at = piece.melody.find((n) => n.midi === highest)!;
    expect(Math.floor((at.beat - piece.loopStartBeat) / 4)).toBe(14);
  });

  it('OPLL BIGは2小節イントロ＋40小節のA–Eフォームで、短調フックを回帰させる', () => {
    const prog = PROGRESSIONS.find((candidate) => candidate.id === 'minor-pedal')!;
    const choice = variedChoiceFor(prog, 40, 42);
    const piece = compose({
      ...base,
      progressionId: prog.id,
      bpm: 150,
      bars: 40,
      seed: 42,
      melodyMode: 'minor',
      choice,
    });
    expect(choice).toHaveLength(40);
    expect(piece.introBars).toBe(2);
    expect(piece.beats).toBe(42 * 4);
    expect(piece.beats * 60 / piece.bpm).toBeCloseTo(67.2, 6);
    expect(piece.arrangementPlan.arc).toBe('hookFirst');
    expect(piece.arrangementPlan.textureStrategy).toBe('arpDrive');
    expect(piece.arrangementPlan.sections).toHaveLength(5);
    expect(piece.phrasePlan.bars.filter((plan) => plan.bar % 8 === 0).map((plan) => plan.section))
      .toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(piece.phrasePlan.bars[8]!.motifSourceBar).toBe(0);
    expect(piece.phrasePlan.bars[16]!.motifSourceBar).toBe(16);
    expect(piece.phrasePlan.bars[24]!.motifSourceBar).toBe(0);
    expect(piece.phrasePlan.bars[32]!.motifSourceBar).toBe(0);
    const notesInSection = (startBar: number) => piece.ostinato.filter((note) => (
      note.beat >= piece.loopStartBeat + startBar * 4
      && note.beat < piece.loopStartBeat + (startBar + 8) * 4
    ));
    expect([0, 1, 2, 3, 4].filter((section) => notesInSection(section * 8).length > 0))
      .toEqual([1, 3]);
    expect(piece.arrangementPlan.sections.every((section) => (
      Number(section.echo) + Number(section.counterDensity > 0) + Number(section.ostinatoDensity > 0)
    ) <= 1)).toBe(true);
    expect([...new Set(piece.drums.map((drum) => drum.inst))].sort())
      .toEqual(['cymbal', 'hat', 'kick', 'snare', 'tom']);
    expect(piece.barChordNames[0]).toBe('Cm');
    expect(validatePiece(piece)).toEqual([]);
  });

  it('OPLL BIGの奏法は曲単位で選び、全セクションへの貼り付けを避ける', () => {
    const pieces = [0, 2, 4, 6].map((seed) => compose({
      ...base,
      progressionId: 'minor-pedal',
      bars: 40,
      seed,
      melodyMode: 'minor',
    }));
    expect(new Set(pieces.map((piece) => piece.arrangementPlan.textureStrategy)))
      .toEqual(new Set(['counterDrive', 'arpDrive', 'bassDrive', 'hybrid']));
    for (const piece of pieces) {
      for (const device of [
        (section: typeof piece.arrangementPlan.sections[number]) => section.echo,
        (section: typeof piece.arrangementPlan.sections[number]) => section.counterDensity > 0,
        (section: typeof piece.arrangementPlan.sections[number]) => section.ostinatoDensity > 0,
      ]) {
        expect(piece.arrangementPlan.sections.filter(device).length).toBeLessThan(piece.arrangementPlan.sections.length);
      }
      expect(diagnosePiece(piece).scores.texture).toBe(100);
    }
    expect(pieces.find((piece) => piece.arrangementPlan.textureStrategy === 'bassDrive')!
      .arrangementPlan.bassRole).toBe('pedal');
  });

  it('密な副旋律はコードトーンだけでなく、順次解決する経過音・刺繍音を使う', () => {
    const piece = compose({
      ...base,
      progressionId: 'minor-pedal',
      bars: 40,
      seed: 0,
      melodyMode: 'minor',
    });
    const chordAt = (beat: number) => piece.chords.reduce(
      (current, chord) => chord.beat <= beat ? chord : current,
      piece.chords[0]!,
    );
    const nonChordCounter = piece.counterMelody.filter((note) => !chordAt(note.beat).pcs.includes(note.midi % 12));
    expect(nonChordCounter.length).toBeGreaterThan(0);
    const report = diagnosePiece(piece);
    expect(report.issues.filter((issue) => issue.category === 'counterpoint')).toEqual([]);
    expect(report.observations.some((observation) => observation.description.startsWith('副旋律の'))).toBe(true);
  });

  it('3+1の和声リズムは一部の展開・結論だけで使い、BとEで同じ位置へ回帰する', () => {
    const prog = PROGRESSIONS.find((candidate) => candidate.id === 'minor-pedal')!;
    const seed = 13;
    const piece = compose({
      ...base,
      progressionId: prog.id,
      bars: 40,
      seed,
      melodyMode: 'minor',
      choice: variedChoiceFor(prog, 40, seed),
    });
    const splitAt = (startBar: number) => Array.from({ length: 7 }, (_, relativeBar) => relativeBar)
      .filter((relativeBar) => {
        const start = piece.loopStartBeat + (startBar + relativeBar) * 4;
        const durations = piece.chords
          .filter((chord) => chord.beat >= start && chord.beat < start + 4)
          .map((chord) => chord.dur);
        return durations.join(',') === '1,3' || durations.join(',') === '3,1';
      });
    expect(splitAt(8).length).toBeGreaterThan(0);
    expect(splitAt(32)).toEqual(splitAt(8));
  });

  it('16分分散和音は8小節を同じ密度で埋めず、展開部だけ加速する', () => {
    const piece = compose({
      ...base,
      progressionId: 'minor-pedal',
      bars: 40,
      seed: 42,
      melodyMode: 'minor',
    });
    const notesInBar = (bar: number) => piece.ostinato.filter((note) => (
      note.beat >= piece.loopStartBeat + bar * 4
      && note.beat < piece.loopStartBeat + (bar + 1) * 4
    )).length;
    expect(notesInBar(8)).toBeGreaterThan(0);
    expect(notesInBar(12)).toBeGreaterThan(notesInBar(8));
    expect(notesInBar(12)).toBe(16);
  });

  it('最終小節の後半は音を減らしてループの頭に渡す', () => {
    const piece = compose(base);
    const lastBarLateNotes = piece.melody.filter((n) => n.beat >= (piece.bars - 1) * 4 + 2.5);
    expect(lastBarLateNotes).toEqual([]);
  });
});
