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
import {
  CHORDS,
  PROGRESSIONS,
  STYLES,
  YO_SCALE,
  chordName,
  progressionsForTonality,
} from '../src/core/music/theory.js';

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

  it('非和声音は宙吊りのまま残らない（生成側で順次か和声音の受けとして解決する）', () => {
    // かつては診断側の免責（反復特徴音・定型装飾）で警告を抑えていたが、
    // 現在は生成側が同音連打・跳躍受けを解決するため、警告そのものがゼロになる。
    const reports = Array.from({ length: 32 }, (_, seed) => diagnosePiece(compose({
      ...base, progressionId: 'tanaka-manabe', bars: 16, seed,
      melodicLanguage: 'japanese', japaneseScale: 'ritsu', grooveFeel: 'bounce',
    })));
    for (const report of reports) {
      expect(report.issues.filter((issue) => issue.code === 'melody-unresolved-nonchord')).toEqual([]);
      // 免責経路自体は残す（ユーザーの局所修正が特徴音を作る場合のため）。出た場合は根拠つき。
      for (const observation of report.observations.filter((candidate) => candidate.kind === 'motif')) {
        expect(observation.relatedBeats.length).toBeGreaterThan(0);
      }
    }
  });

  it('診断の局所修正は、ユーザー編集が生んだ宙吊り非和声音を最小の編集で解決する', () => {
    const commonOptions = {
      ...base,
      progressionId: 'tanaka-manabe',
      bars: 16 as const,
      melodyMode: 'japanese' as const,
      japaneseScale: 'ritsu' as const,
      grooveFeel: 'bounce' as const,
    };
    // 生成は宙吊りを残さなくなったため、弱拍の音を次の音と同音へずらすユーザー編集で欠陥を合成し、
    // 修正提案 → melodyEdits 適用 → 再診断 → JSON往復、の修正ワークフローを検証する。
    const fixture = (() => {
      let attempts = 0;
      for (let seed = 0; seed < 32; seed++) {
        const options = { ...commonOptions, seed };
        const clean = compose(options);
        const body = clean.melody.filter((note) => note.role !== 'ornament' && note.beat >= clean.loopStartBeat);
        for (let position = 1; position < body.length - 1 && attempts < 200; position++) {
          const note = body[position]!;
          const after = body[position + 1]!;
          if (note.midi === after.midi) continue;
          attempts++;
          const defectEdit = { beat: note.beat, fromMidi: note.midi, toMidi: after.midi };
          const defectOptions = { ...options, melodyEdits: [defectEdit] };
          const defect = compose(defectOptions);
          const defectReport = diagnosePiece(defect);
          const issue = defectReport.issues.find((candidate) => (
            candidate.code === 'melody-unresolved-nonchord' && Math.abs(candidate.beat - note.beat) < 0.001
          ));
          if (!issue) continue;
          const repair = suggestCompositionRepair(defect, issue);
          if (repair?.strategy !== 'resolve-next') continue;
          return { defectOptions, defect, defectReport, issue, repair };
        }
      }
      return null;
    })();
    expect(fixture).not.toBeNull();
    const { defectOptions, defect, defectReport, issue, repair } = fixture!;
    expect(repair.edit.beat).not.toBe(issue.beat);

    const repairedOptions = { ...defectOptions, melodyEdits: [...defectOptions.melodyEdits, repair.edit] };
    const repaired = compose(repairedOptions);
    const repairedReport = diagnosePiece(repaired);
    expect(repairedReport.issues.some((candidate) => (
      candidate.code === issue.code && Math.abs(candidate.beat - issue.beat) < 0.001
    ))).toBe(false);
    expect(repairedReport.overall).toBeGreaterThanOrEqual(defectReport.overall);
    expect(repaired.melody.filter((note, index) => note.midi !== defect.melody[index]!.midi)).toHaveLength(1);
    expect(compose(JSON.parse(JSON.stringify(repairedOptions)))).toEqual(repaired);
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

  it('長調由来の全進行は短調でも同じ進行IDのまま選べる', () => {
    const minorIds = progressionsForTonality('minor').map((progression) => progression.id);
    expect(minorIds).toEqual(expect.arrayContaining([
      'royal-pop', 'fanfare', 'tanaka-manabe', 'komuro', 'canon', 'jttou',
    ]));

    const expectedChords: Record<string, string[]> = {
      'royal-pop': ['Am', 'F', 'Dm', 'E7'],
      fanfare: ['Am', 'Dm', 'E7', 'Am'],
      'tanaka-manabe': ['F', 'G', 'Am', 'C'],
      komuro: ['Am', 'F', 'G', 'C'],
      jttou: ['FM7', 'E7', 'Am7', 'Gm7(3拍) C7(1拍)'],
    };
    for (const [progressionId, chords] of Object.entries(expectedChords)) {
      const piece = compose({
        ...base,
        progressionId,
        tonality: 'minor',
        keyRoot: 9,
      });
      expect(piece.barChordNames, progressionId).toEqual(chords);
      expect(piece.tonality).toBe('minor');
      expect(validatePiece(piece), progressionId).toEqual([]);
    }

    const minorCanon = progressionsForTonality('minor').find((progression) => progression.id === 'canon')!;
    const canon = compose({
      ...base,
      progressionId: 'canon',
      tonality: 'minor',
      keyRoot: 9,
      bars: 8,
      choice: defaultChoiceFor(minorCanon, 8),
    });
    expect(canon.barChordNames).toEqual(['Am', 'Em', 'F', 'C', 'Dm', 'Am', 'Dm', 'E7']);
    expect(validatePiece(canon)).toEqual([]);
  });

  it('短調リアライゼーションは4/8/16小節へ展開しても生成検証を通る', () => {
    for (const progressionId of ['royal-pop', 'fanfare', 'tanaka-manabe', 'komuro', 'canon', 'jttou']) {
      for (const bars of [4, 8, 16] as const) {
        if (progressionId === 'canon' && bars === 4) continue;
        for (const seed of [1, 42]) {
          const piece = compose({
            ...base,
            progressionId,
            tonality: 'minor',
            keyRoot: 9,
            bars,
            seed,
          });
          expect(validatePiece(piece), `${progressionId}/${bars}小節/seed=${seed}`).toEqual([]);
        }
      }
    }
  });

  it('短調ペダルはベースだけを保ち、既定和声をiだけへ固定しない', () => {
    const prog = PROGRESSIONS.find((candidate) => candidate.id === 'minor-pedal')!;
    expect(defaultChoiceFor(prog, 4)).toEqual([0, 0, 1, 2]);
    const piece = compose({
      ...base, progressionId: prog.id, tonality: 'minor', bars: 4,
    });
    expect(piece.songPlan.harmony.map((bar) => bar.tokens.join(',')))
      .toEqual(['i', 'i', 'VI', 'V7m']);
    expect(validatePiece(piece)).toEqual([]);
  });

  it('短調フォームの終端選択はVだけでなくV7mもドミナントとして扱う', () => {
    const prog = PROGRESSIONS.find((candidate) => candidate.id === 'minor-drive')!;
    for (const bars of [8, 16, 40] as const) {
      const choice = defaultChoiceFor(prog, bars);
      const lastBar = bars - 1;
      expect(prog.slots[lastBar % prog.slots.length]![choice[lastBar]!]!.at(-1), `${bars}小節`).toBe('V7m');
    }
    const varied = variedChoiceFor(prog, 16, 13, { chancePercent: 100 });
    expect(prog.slots[3]![varied[15]!]!.at(-1)).toBe('V7m');
  });

  it('4小節進行の BB(8小節) 展開は A+A\'（最終小節だけ V でループを引っ張る）', () => {
    const prog = PROGRESSIONS.find((p) => p.id === 'tanaka-manabe')!;
    const choice = defaultChoiceFor(prog, 8);
    expect(choice.slice(0, 4)).toEqual(choice.slice(4).map((v, i) => (i === 3 ? choice[3]! : v)));
    const piece = compose({ ...base, progressionId: 'tanaka-manabe', bars: 8, choice });
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
  }, 15_000);

  it('8小節のコード変化は登録済みレシピ2つを組み、開始側も固定しない', () => {
    const prog = PROGRESSIONS.find((p) => p.id === 'tanaka-manabe')!;
    const firstPhrases = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const choice = variedChoiceFor(prog, 8, seed);
      expect(choice.slice(0, 4)).not.toEqual(choice.slice(4));
      firstPhrases.add(choice.slice(0, 4).join(','));
      expect(choice).toHaveLength(8);
      choice.forEach((selected, bar) => expect(selected).toBeLessThan(prog.slots[bar % 4]!.length));
    }
    expect(firstPhrases.size).toBeGreaterThan(1);
  });

  it('16小節のコード変化はA・Bを異なる確認済みレシピで展開する', () => {
    for (const prog of PROGRESSIONS) {
      const sectionAKeys = new Set<string>();
      for (const seed of Array.from({ length: 32 }, (_, index) => index)) {
        const choice = variedChoiceFor(prog, 16, seed);
        expect(choice).toHaveLength(16);
        expect(choice.slice(0, 8), `${prog.id}/seed=${seed}`).not.toEqual(choice.slice(8));
        sectionAKeys.add(choice.slice(0, 8).join(','));
        const lastSlot = prog.slots[15 % prog.slots.length]!;
        const strongest = lastSlot.some((option) => ['V', 'V7m', 'I7'].includes(option.at(-1)!));
        const lastTokens = lastSlot[choice[15]!]!;
        if (strongest) expect(['V', 'V7m', 'I7'], `${prog.id}/ターンアラウンド`).toContain(lastTokens.at(-1));
        const piece = compose({
          ...base, progressionId: prog.id, bars: 16, choice, seed,
          ...(prog.tonality === 'minor' ? { melodyMode: 'minor' as const } : {}),
        });
        expect(validatePiece(piece), `${prog.id}/seed=${seed}`).toEqual([]);
      }
      expect(sectionAKeys.size, `${prog.id}/A`).toBeGreaterThan(1);
    }
  });

  it('選択を省略した4・8・16小節生成も、尺に応じた変化と山を自動設計する', () => {
    const overfixedReasons = ['完全コピー', '固定されている', '低エネルギー', '実音が生成されていない'];
    for (const prog of PROGRESSIONS) {
      for (const bars of [4, 8, 16] as const) {
        if (prog.slots.length > bars) continue;
        for (const seed of [0, 13, 42, 77]) {
          const piece = compose({
            ...base, progressionId: prog.id, tonality: prog.tonality, bars, seed,
          });
          expect(validatePiece(piece), `${prog.id}/${bars}小節/seed=${seed}`).toEqual([]);
          expect(piece.songPlan.form.sections.every((section) => (
            new Set(section.phraseRhythmVariants).size > 1
          ))).toBe(true);
          if (bars === 8 && prog.slots.length === 4) {
            expect(piece.songPlan.harmony.slice(0, 4).map((bar) => bar.tokens), `${prog.id}/8小節`)
              .not.toEqual(piece.songPlan.harmony.slice(4).map((bar) => bar.tokens));
          }
          if (bars === 16) {
            expect(piece.songPlan.harmony.slice(0, 8).map((bar) => bar.tokens), `${prog.id}/16小節`)
              .not.toEqual(piece.songPlan.harmony.slice(8).map((bar) => bar.tokens));
            const climaxSection = piece.songPlan.form.sections.find((section) => (
              piece.phrasePlan.climaxBar >= section.startBar
              && piece.phrasePlan.climaxBar < section.startBar + section.bars
            ))!;
            expect(climaxSection.energy).toBe(Math.max(...piece.songPlan.form.sections.map((section) => section.energy)));
          }
          const overfixed = diagnosePiece(piece).issues.filter((issue) => (
            overfixedReasons.some((reason) => issue.reason.includes(reason))
          ));
          expect(overfixed, `${prog.id}/${bars}小節/seed=${seed}`).toEqual([]);
        }
      }
    }
    expect(compose({ ...base, bars: 4, seed: 42 }).phrasePlan.climaxBar).toBe(2);
    expect(compose({ ...base, bars: 4, seed: 43 }).phrasePlan.climaxBar).toBe(3);
  });

  it('4・8小節の編成は互換候補から主役を選び、計画した声部を実際に鳴らす', () => {
    for (const bars of [4, 8] as const) {
      const pieces = Array.from({ length: 32 }, (_, seed) => compose({ ...base, bars, seed }));
      expect(new Set(pieces.map((piece) => piece.arrangementPlan.textureStrategy)).size).toBeGreaterThan(1);
      expect(new Set(pieces.map((piece) => {
        const section = piece.arrangementPlan.sectionA;
        return [
          piece.arrangementPlan.textureStrategy,
          section.backingDensity,
          section.drum,
          section.echo,
          section.counterDensity,
          section.ostinatoDensity,
        ].join(':');
      })).size).toBeGreaterThan(3);
      pieces.forEach((piece, seed) => {
        const section = piece.arrangementPlan.sectionA;
        if (section.counterDensity > 0) expect(piece.counterMelody.length, `counter/${bars}/${seed}`).toBeGreaterThan(0);
        if (section.ostinatoDensity > 0) expect(piece.ostinato.length, `arp/${bars}/${seed}`).toBeGreaterThan(0);
      });
    }

    const nesPieces = Array.from({ length: 16 }, (_, seed) => compose({
      ...base, bars: 8, seed, soundChip: 'nes2a03',
    }));
    expect(nesPieces.every((piece) => piece.arrangementPlan.textureStrategy !== 'arpDrive')).toBe(true);
    expect(nesPieces.every((piece) => piece.ostinato.length === 0)).toBe(true);

    const bResponse = compose({ ...base, bars: 16, seed: 20 });
    expect(bResponse.arrangementPlan.sectionB.counterDensity).toBeGreaterThan(0);
    expect(bResponse.counterMelody.some((note) => note.beat >= bResponse.loopStartBeat + 8 * 4)).toBe(true);
  });

  it('40小節のコード変化は各セクションを別レシピで構成し、半小節変化は任意にする', () => {
    for (const prog of PROGRESSIONS) {
      const choices = Array.from({ length: 32 }, (_, seed) => variedChoiceFor(prog, 40, seed));
      for (const choice of choices) {
        expect(choice).toHaveLength(40);
        const sectionSignatures = Array.from(
          { length: 5 }, (_, section) => choice.slice(section * 8, section * 8 + 8).join(','),
        );
        expect(new Set(sectionSignatures).size, prog.id).toBeGreaterThanOrEqual(4);
        if (prog.slots.length === 4) {
          const openings = Array.from(
            { length: 5 }, (_, section) => choice.slice(section * 8, section * 8 + 4).join(','),
          );
          expect(new Set(openings).size, `${prog.id}/各区間の冒頭`).toBeGreaterThanOrEqual(3);
        }
      }
    }
    const pedal = PROGRESSIONS.find((candidate) => candidate.id === 'minor-pedal')!;
    const splitCounts = Array.from({ length: 128 }, (_, seed) => variedChoiceFor(pedal, 40, seed))
      .map((choice) => choice.filter((selected, bar) => (
        pedal.slots[bar % pedal.slots.length]![selected]!.length > 1
      )).length);
    expect(splitCounts.some((count) => count === 0)).toBe(true);
    expect(splitCounts.some((count) => count > 0)).toBe(true);
  });

  it('全進行の40小節自動展開が過剰固定の診断を出さず、構造検証を通る', () => {
    for (const prog of PROGRESSIONS) {
      for (const seed of [0, 13, 42, 77]) {
        const piece = compose({
          ...base,
          progressionId: prog.id,
          bars: 40,
          seed,
          choice: variedChoiceFor(prog, 40, seed),
          ...(prog.tonality === 'minor' ? { tonality: 'minor' as const } : {}),
        });
        expect(validatePiece(piece), `${prog.id}/seed=${seed}`).toEqual([]);
        const overfixed = diagnosePiece(piece).issues.filter((issue) => (
          issue.reason.includes('完全コピー') || issue.reason.includes('固定されている')
        ));
        expect(overfixed, `${prog.id}/seed=${seed}`).toEqual([]);
      }
    }
  });

  it('2小節イントロをSongPlanで設計し、役割別の編成と和声からAへ接続する', () => {
    const evenSeed = compose({ ...base, bars: 16, seed: 42 });
    const oddSeed = compose({ ...base, bars: 16, seed: 43 });
    const withoutIntro = compose({ ...base, bars: 16, seed: 43, intro: false });
    const short = compose({ ...base, bars: 8, seed: 43 });

    expect(evenSeed.introBars).toBe(2);
    expect(evenSeed.loopStartBeat).toBe(8);
    expect(evenSeed.beats).toBe(8 + 16 * 4);
    expect(evenSeed.introChordNames).toHaveLength(2);
    expect(evenSeed.introRole).not.toBeNull();
    expect(evenSeed.songPlan.intro.enabled).toBe(true);
    expect(evenSeed.songPlan.intro.role).toBe(evenSeed.introRole);
    expect(oddSeed.introBars).toBe(2);
    expect(withoutIntro.introBars).toBe(0);
    expect(withoutIntro.introRole).toBeNull();
    expect(withoutIntro.songPlan.intro.enabled).toBe(false);
    expect(withoutIntro.songPlan.intro.barPlans).toEqual([]);
    expect(withoutIntro.loopStartBeat).toBe(0);
    expect(withoutIntro.beats).toBe(16 * 4);
    expect(withoutIntro.introChordNames).toEqual([]);
    expect(short.introBars).toBe(0);
    expect(short.loopStartBeat).toBe(0);
    expect(short.beats).toBe(8 * 4);
    expect(evenSeed.chords.find((chord) => chord.beat === evenSeed.loopStartBeat)?.name).toBe(evenSeed.barChordNames[0]);

    const variants = STYLES.flatMap((style) =>
      Array.from({ length: 16 }, (_, seed) => compose({ ...base, bars: 16, styleId: style.id, seed: seed + 40 })),
    );
    const introRoles = new Set<string>();
    const breakLengths = new Set<number>();
    for (const piece of variants) {
      const plan = piece.songPlan.intro;
      const firstBarLead = piece.melody.filter((note) => note.beat < 4);
      const secondBarLead = piece.melody.filter((note) => note.beat >= 4 && note.beat < 8);
      const firstBarBass = piece.bass.filter((note) => note.beat < 4);
      const secondBarBass = piece.bass.filter((note) => note.beat >= 4 && note.beat < 8);
      const introDrums = piece.drums.filter((drum) => drum.beat < piece.loopStartBeat);
      const introChords = piece.chords.filter((chord) => chord.beat < piece.loopStartBeat);
      const firstBodyChord = piece.chords.find((chord) => chord.beat === piece.loopStartBeat)!;
      expect(plan.barPlans).toHaveLength(2);
      expect(plan.entryToken).toBe(firstBodyChord.token);
      expect(introChords.every((chord) => chord.token === firstBodyChord.token)).toBe(false);
      for (const barPlan of plan.barPlans) {
        const actual = introChords.filter((chord) => chord.beat >= barPlan.bar * 4 && chord.beat < (barPlan.bar + 1) * 4);
        expect(actual.map((chord) => chord.token)).toEqual(barPlan.tokens);
        expect(actual.map((chord) => chord.dur)).toEqual(barPlan.durations);
      }
      const breakStart = piece.loopStartBeat - plan.breakBeats;
      expect(Math.max(...introChords.map((chord) => chord.beat + chord.dur))).toBeLessThanOrEqual(breakStart);
      expect([...firstBarLead, ...secondBarLead].every((note) => note.beat + note.dur <= breakStart + 0.001)).toBe(true);
      expect([...firstBarBass, ...secondBarBass].every((note) => note.beat + note.dur <= breakStart + 0.001)).toBe(true);
      expect(introDrums.every((drum) => drum.beat < breakStart)).toBe(true);

      if (piece.introRole === 'motif') {
        const bodyFragment = piece.melody
          .filter((note) => note.beat >= piece.loopStartBeat && note.beat < piece.loopStartBeat + 4 && note.role !== 'ornament')
          .slice(0, firstBarLead.length);
        expect(firstBarLead.map((note) => note.midi)).toEqual(bodyFragment.map((note) => note.midi));
        expect(introDrums).toEqual([]);
      } else if (piece.introRole === 'groove') {
        expect(firstBarLead).toEqual([]);
        expect(firstBarBass.length).toBeGreaterThan(secondBarBass.length);
        expect(secondBarLead.length).toBeGreaterThan(0);
        expect(introDrums.length).toBeGreaterThan(0);
      } else if (piece.introRole === 'fanfare') {
        expect(firstBarLead.length).toBeGreaterThan(secondBarLead.length);
        expect(introDrums.some((drum) => drum.inst === 'cymbal')).toBe(true);
      } else if (piece.introRole === 'runup') {
        expect(firstBarLead).toHaveLength(2);
        expect(secondBarLead.length).toBeGreaterThan(firstBarLead.length);
        expect(introDrums.length).toBeGreaterThan(0);
      }
      expect(validatePiece(piece)).toEqual([]);
      if (piece.introRole) introRoles.add(piece.introRole);
      breakLengths.add(plan.breakBeats);
    }
    expect([...introRoles].sort()).toEqual(['fanfare', 'groove', 'motif', 'runup']);
    expect([...breakLengths].sort()).toEqual([0, 0.5, 1]);
    const japaneseIntro = compose({
      ...base, bars: 16, seed: 43, melodicLanguage: 'japanese', japaneseScale: 'ritsu',
    });
    expect(japaneseIntro.introRole).toBe('motif');
    expect(japaneseIntro.songPlan.intro.breakBeats).toBe(1.5);
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

  it('8小節メロディはSRDCを保ちつつ、同じ2小節リズムを4回貼らない', () => {
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
    expect(piece.phrasePlan.bars.map((plan) => plan.phraseFunction)).toEqual([
      'statement', 'statement', 'restatement', 'restatement',
      'departure', 'departure', 'conclusion', 'conclusion',
    ]);
    expect(new Set(piece.songPlan.form.sections[0]!.phraseRhythmVariants).size).toBeGreaterThan(1);
    expect(new Set(Array.from({ length: 4 }, (_, phrase) => (
      `${rhythmAt(phrase * 2).join(',')}/${rhythmAt(phrase * 2 + 1).join(',')}`
    ))).size).toBeGreaterThan(2);
    expect(piece.phrasePlan.bars.slice(4, 6).map((plan) => plan.motifSourceBar)).toEqual([4, 5]);
    expect(contourAt(4)).not.toEqual(contourAt(0));
    expect(piece.phrasePlan.bars[6]!.motifSourceBar).toBeLessThan(4);
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

  it('OPLL BIGは2小節イントロ＋40小節のA–Eフォームで、主題を変形しながら回帰させる', () => {
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
    expect(piece.songPlan.form.sections.map((section) => section.motifSourceSection))
      .toEqual([null, 'A', null, 'A', 'B']);
    expect(new Set(piece.songPlan.form.sections.map((section) => section.rhythmVariant)).size)
      .toBeGreaterThanOrEqual(3);
    expect(piece.phrasePlan.bars[16]!.motifSourceBar).toBe(16);
    expect(piece.phrasePlan.bars[24]!.motifSourceBar).toBe(0);
    expect(piece.phrasePlan.bars[32]!.motifSourceBar).toBe(8);
    const notesInSection = (startBar: number) => piece.ostinato.filter((note) => (
      note.beat >= piece.loopStartBeat + startBar * 4
      && note.beat < piece.loopStartBeat + (startBar + 8) * 4
    ));
    const ostinatoSections = [0, 1, 2, 3, 4].filter((section) => notesInSection(section * 8).length > 0);
    expect(ostinatoSections.length).toBeGreaterThanOrEqual(1);
    expect(ostinatoSections.length).toBeLessThanOrEqual(2);
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

  it('40小節の起伏・山・フィル・仕掛け位置は単一の固定表へ収束しない', () => {
    const prog = PROGRESSIONS.find((candidate) => candidate.id === 'minor-pedal')!;
    const seeds = [0, 4, 8, 12, 1025];
    const pieces = seeds.map((seed) => compose({
      ...base, progressionId: prog.id, bars: 40, seed, melodyMode: 'minor',
      choice: variedChoiceFor(prog, 40, seed),
    }));
    expect(new Set(pieces.map((piece) => (
      piece.songPlan.form.sections.map((section) => section.energy).join(',')
    ))).size).toBeGreaterThanOrEqual(4);
    const climaxSections = new Set(pieces.map((piece) => Math.floor(piece.phrasePlan.climaxBar / 8)));
    expect(climaxSections.size).toBeGreaterThanOrEqual(3);
    expect(new Set(pieces.map((piece) => (
      piece.arrangementPlan.sections.map((section) => section.exitFill).join(',')
    ))).size).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.arrangementPlan.sections.slice(0, -1).every((section) => section.exitFill === 'full'))
        .toBe(false);
      const overfixed = diagnosePiece(piece).issues.filter((issue) => (
        issue.reason.includes('完全コピー') || issue.reason.includes('固定されている')
      ));
      expect(overfixed, `seed=${piece.songPlan.form.climaxBar}`).toEqual([]);
    }
  });

  it('密な副旋律はコードトーンだけでなく、順次解決する経過音・刺繍音を使う', () => {
    // 特定シードに固定せず、性質（非和声音を使いつつ対位の警告ゼロ）を満たす曲が存在することを確認する。
    const fixture = Array.from({ length: 24 }, (_, seed) => compose({
      ...base,
      progressionId: 'minor-pedal',
      bars: 40,
      seed,
      melodyMode: 'minor',
    })).map((piece) => {
      const chordAt = (beat: number) => piece.chords.reduce(
        (current, chord) => chord.beat <= beat ? chord : current,
        piece.chords[0]!,
      );
      const nonChordCounter = piece.counterMelody.filter((note) => !chordAt(note.beat).pcs.includes(note.midi % 12));
      return { piece, nonChordCounter, report: diagnosePiece(piece) };
    }).find(({ nonChordCounter, report }) => (
      nonChordCounter.length > 0
      && report.issues.filter((issue) => issue.category === 'counterpoint').length === 0
      && report.observations.some((observation) => observation.description.startsWith('副旋律の'))
    ));
    expect(fixture).toBeDefined();
  });

  it('3+1の和声リズムは任意に使い、再登場してもBとEを完全コピーしない', () => {
    const prog = PROGRESSIONS.find((candidate) => candidate.id === 'minor-pedal')!;
    const patterns = Array.from({ length: 128 }, (_, seed) => {
      const piece = compose({
        ...base, progressionId: prog.id, bars: 40, seed, melodyMode: 'minor',
        choice: variedChoiceFor(prog, 40, seed),
      });
      const splitAt = (startBar: number) => piece.songPlan.harmony
        .slice(startBar, startBar + 8)
        .flatMap((bar, relativeBar) => bar.tokens.length > 1
          ? [`${relativeBar}:${bar.durations.join('+')}`]
          : []);
      return { all: splitAt(0).length + splitAt(8).length + splitAt(16).length + splitAt(24).length + splitAt(32).length,
        b: splitAt(8).join(','), e: splitAt(32).join(',') };
    });
    expect(patterns.some((pattern) => pattern.all === 0)).toBe(true);
    expect(patterns.some((pattern) => pattern.all > 0)).toBe(true);
    expect(patterns.some((pattern) => pattern.all > 0 && pattern.b !== pattern.e)).toBe(true);
  });

  it('16分分散和音は8小節を同じ密度で埋めず、区間ごとに選んだ役割だけで加速する', () => {
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
    const denseSection = piece.arrangementPlan.sections.findIndex((section) => section.ostinatoDensity === 2);
    expect(denseSection).toBeGreaterThanOrEqual(0);
    const startBar = denseSection * 8;
    const counts = Array.from({ length: 8 }, (_, offset) => notesInBar(startBar + offset));
    expect(Math.max(...counts)).toBe(16);
    expect(Math.min(...counts)).toBeLessThan(16);
    const peak = piece.arrangementPlan.sections[denseSection]!.ostinatoPeak;
    const peakCounts = piece.phrasePlan.bars
      .slice(startBar, startBar + 8)
      .filter((bar) => bar.phraseFunction === peak)
      .map((bar) => notesInBar(bar.bar));
    expect(Math.max(...peakCounts)).toBe(16);
  });

  it('最終小節の後半は音を減らしてループの頭に渡す', () => {
    const piece = compose(base);
    const lastBarLateNotes = piece.melody.filter((n) => n.beat >= (piece.bars - 1) * 4 + 2.5);
    expect(lastBarLateNotes).toEqual([]);
  });
});
