import { describe, expect, it } from 'vitest';
import {
  compose,
  defaultChoiceFor,
  diagnosePiece,
  hasVariedChoiceFor,
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
      const piece = compose({ ...base, progressionId: prog.id, bars: 8, seed: 42 });
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

  it('作曲診断は7観点を個別採点し、生成上のエラーを残さない', () => {
    const piece = compose({ ...base, progressionId: 'jttou', styleId: 'ska', bars: 16, seed: 42 });
    const report = diagnosePiece(piece);
    expect(Object.keys(report.scores).sort()).toEqual(
      ['counterpoint', 'form', 'harmony', 'loop', 'melody', 'rhythm', 'voiceLeading'].sort(),
    );
    expect(report.overall).toBeGreaterThanOrEqual(70);
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(report.scores.voiceLeading).toBe(100);
  });

  it('クライマックス候補はフォーム内でシードにより前後する', () => {
    expect(compose({ ...base, bars: 8, seed: 42 }).phrasePlan.climaxBar).toBe(4);
    expect(compose({ ...base, bars: 8, seed: 43 }).phrasePlan.climaxBar).toBe(6);
    expect(compose({ ...base, bars: 16, seed: 42 }).phrasePlan.climaxBar).toBe(12);
    expect(compose({ ...base, bars: 16, seed: 43 }).phrasePlan.climaxBar).toBe(14);
  });

  it('全進行 × 全スタイル × 全旋律様式 × 4/8/16小節で生成検証を通る', () => {
    for (const prog of PROGRESSIONS) {
      for (const style of STYLES) {
        for (const melodyMode of ['major', 'japanese'] as const) {
          for (const bars of [4, 8, 16] as const) {
            if (prog.slots.length > bars) continue;
            for (const seed of [1, 42, 12345]) {
              const piece = compose({
                ...base, progressionId: prog.id, styleId: style.id, melodyMode, bars, seed,
              });
              expect(
                validatePiece(piece),
                `${prog.id}/${style.id}/${melodyMode}/${bars}小節/seed=${seed}`,
              ).toEqual([]);
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
            const piece = compose({ ...base, progressionId: prog.id, bars, choice, seed });
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
      const piece = compose({ ...base, progressionId: prog.id, bars: 16, choice });
      expect(validatePiece(piece), prog.id).toEqual([]);
    }
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

  it('16小節ではAの副旋律を一度に絞り、Bで返答を増やす', () => {
    const piece = compose({ ...base, progressionId: 'tanaka-manabe', bars: 16, seed: 42 });
    const boundary = piece.loopStartBeat + 8 * 4;
    const inA = piece.counterMelody.filter((note) => note.beat < boundary);
    const inB = piece.counterMelody.filter((note) => note.beat >= boundary);
    expect(inA.length).toBeGreaterThan(0);
    expect(inB.length).toBeGreaterThan(inA.length);
  });

  it('メロディは2小節の提示＋応答を保ち、A1の音程型を後半で移調反復する', () => {
    const piece = compose({ ...base, progressionId: 'tanaka-manabe', bars: 8, seed: 42 });
    const rhythmAt = (bar: number) =>
      piece.melody
        .filter((note) => note.beat >= bar * 4 && note.beat < (bar + 1) * 4)
        .map((note) => note.beat - bar * 4);
    const intervalPatternAt = (bar: number) => {
      const notes =
      piece.melody
        .filter((note) => note.beat >= bar * 4 && note.beat < (bar + 1) * 4)
        .map((note) => note.midi);
      return notes.slice(1).map((midi, index) => (midi - notes[index]! + 120) % 12);
    };

    expect(rhythmAt(0)).not.toEqual(rhythmAt(1));
    expect(rhythmAt(0)).toEqual(rhythmAt(2));
    expect(rhythmAt(1)).toEqual(rhythmAt(3));
    expect(intervalPatternAt(0)).toEqual(intervalPatternAt(4));
  });

  it('和風様式は骨格リズムを保ち、五音旋律・前打音・開放5度を連動させる', () => {
    const major = compose({ ...base, progressionId: 'tanaka-manabe', bars: 8, seed: 42 });
    const japanese = compose({
      ...base,
      progressionId: 'tanaka-manabe',
      bars: 8,
      seed: 42,
      melodyMode: 'japanese',
    });
    const japaneseSkeleton = japanese.melody.filter((note) => note.role !== 'ornament');
    const ornaments = japanese.melody.filter((note) => note.role === 'ornament');
    expect(japaneseSkeleton.map((note) => note.beat)).toEqual(major.melody.map((note) => note.beat));
    expect(japanese.melody.map((note) => note.midi)).not.toEqual(major.melody.map((note) => note.midi));
    expect(ornaments.length).toBeGreaterThan(0);
    expect(ornaments.every((note) => note.articulation === 'ornament')).toBe(true);
    const scalePcs = YO_SCALE.map((interval) => interval % 12);
    for (const note of japanese.melody) {
      const chord = [...japanese.chords].reverse().find((event) => event.beat <= note.beat)!;
      expect(
        scalePcs.includes(note.midi % 12 as (typeof scalePcs)[number]) || chord.pcs.includes(note.midi % 12),
        `beat=${note.beat}/midi=${note.midi}`,
      ).toBe(true);
    }
    for (const chord of japanese.chords) {
      const voicingPcs = new Set(chord.midis.map((midi) => midi % 12));
      expect(voicingPcs.size).toBeLessThanOrEqual(2);
      expect([...voicingPcs].every((pc) => pc === chord.pcs[0] || pc === chord.pcs[2])).toBe(true);
    }
    expect(validatePiece(japanese)).toEqual([]);
  });

  it('16小節の編成設計は積み上げ・対比・段丘を持ち、対比と段丘では独立対旋律を使う', () => {
    const pieces = [42, 44, 46].map((seed) => compose({
      ...base, progressionId: 'tanaka-manabe', bars: 16, seed,
    }));
    expect(pieces.map((piece) => piece.arrangementPlan.arc)).toEqual(['build', 'contrast', 'terrace']);
    expect(pieces[0]!.arrangementPlan.counterRole).toBe('response');
    expect(pieces[1]!.arrangementPlan.counterRole).toBe('counterline');
    expect(pieces[2]!.arrangementPlan.counterRole).toBe('counterline');
    expect(pieces[1]!.arrangementPlan.sectionB.backingDensity).toBe('sparse');
    expect(pieces[2]!.arrangementPlan.sectionB.backingDensity).toBe('full');
    expect(pieces[1]!.counterMelody.some((note) => note.dur > 0.75)).toBe(true);
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
    const fillSnares = piece.drums
      .filter((event) => event.inst === 'snare' && event.beat >= fillStart && event.beat < fillStart + 1)
      .map((event) => event.beat - piece.loopStartBeat);
    expect(fillSnares).toEqual([31, 31.5, 31.75]);
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
    expect(piece.barChordNames).toEqual(['FM7', 'E7', 'Am7', 'Gm7 C7']);
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

  it('最終小節の後半は音を減らしてループの頭に渡す', () => {
    const piece = compose(base);
    const lastBarLateNotes = piece.melody.filter((n) => n.beat >= (piece.bars - 1) * 4 + 2.5);
    expect(lastBarLateNotes).toEqual([]);
  });
});
