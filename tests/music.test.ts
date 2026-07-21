import { describe, expect, it } from 'vitest';
import {
  compose,
  defaultChoiceFor,
  hasVariedChoiceFor,
  validatePiece,
  variedChoiceFor,
} from '../src/core/music/compose.js';
import type { ComposeOptions } from '../src/core/music/compose.js';
import { CHORDS, PROGRESSIONS, STYLES, chordName } from '../src/core/music/theory.js';

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

  it('全進行 × 全スタイル × RB/BB で強拍コードトーン検証を通る', () => {
    for (const prog of PROGRESSIONS) {
      for (const style of STYLES) {
        for (const bars of [4, 8] as const) {
          if (prog.slots.length > bars) continue;
          for (const seed of [1, 42, 12345]) {
            const piece = compose({ ...base, progressionId: prog.id, styleId: style.id, bars, seed });
            expect(validatePiece(piece), `${prog.id}/${style.id}/${bars}小節/seed=${seed}`).toEqual([]);
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

  it('最終小節の後半は音を減らしてループの頭に渡す', () => {
    const piece = compose(base);
    const lastBarLateNotes = piece.melody.filter((n) => n.beat >= (piece.bars - 1) * 4 + 2.5);
    expect(lastBarLateNotes).toEqual([]);
  });
});
