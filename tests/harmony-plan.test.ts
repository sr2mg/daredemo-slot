import { describe, expect, it } from 'vitest';
import {
  defaultChoiceFor, hasVariedChoiceFor, phraseRecipesFor, sectionProgressionOf, slotAtBar, variedChoiceFor,
} from '../src/core/music/harmony-plan.js';
import { sectionStartBars } from '../src/core/music/form.js';
import { PROGRESSIONS, harmonicFunctionForToken, progressionForTonality } from '../src/core/music/theory.js';
import type { SongFormSpec } from '../src/core/music/types.js';

/**
 * 進行レシピの展開(harmony-plan.ts)は、区間が自分の進行(SectionSpec.progressionId / tonality)を持つとき
 * その進行のレシピから引く。choice(小節ごとのスロット添字)は進行ごとの語彙なので、曲既定の進行の添字を
 * 他の進行へ流用しない。助走(pulse)区間の末尾は主要ドミナントへ寄せる。
 */

const royalPop = progressionForTonality(PROGRESSIONS.find((p) => p.id === 'royal-pop')!, 'major')!;
const tanakaManabe = progressionForTonality(PROGRESSIONS.find((p) => p.id === 'tanaka-manabe')!, 'major')!;
const driftingOrbit = progressionForTonality(PROGRESSIONS.find((p) => p.id === 'drifting-orbit')!, 'major')!;
const minorDrive = progressionForTonality(PROGRESSIONS.find((p) => p.id === 'minor-drive')!, 'minor')!;

const form: SongFormSpec = {
  sections: [
    { id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A' },
    { id: 'B', role: 'development', bars: 8, energy: 4, theme: 'B', progressionId: 'tanaka-manabe' },
    { id: 'M', role: 'relief', bars: 8, energy: 2, theme: 'M', progressionId: 'minor-drive', tonality: 'minor' },
    { id: 'S', role: 'hook', bars: 8, energy: 5, theme: 'S' },
    { id: 'P', role: 'development', bars: 4, energy: 4, theme: 'S', texture: 'pulse', progressionId: 'drifting-orbit' },
  ],
  ending: 'final',
};
const starts = sectionStartBars(form);

const recipeSet = (prog: typeof royalPop): Set<string> => new Set(phraseRecipesFor(prog).map((recipe) => recipe.join(',')));

describe('区間ごとの進行のレシピ', () => {
  it('区間の進行は区間指定を区間の調性へ実現し、無ければ曲既定', () => {
    expect(sectionProgressionOf(royalPop, form.sections[0]!)).toBe(royalPop);
    expect(sectionProgressionOf(royalPop, form.sections[1]!)).toBe(tanakaManabe);
    expect(sectionProgressionOf(royalPop, form.sections[2]!)).toBe(minorDrive);
    expect(sectionProgressionOf(royalPop, { ...form.sections[0]!, progressionId: 'no-such' })).toBeNull();
    // 小節 → スロットは区間の進行のもの。
    expect(slotAtBar(royalPop, form, starts[1]!)).toBe(tanakaManabe.slots[0]);
    expect(slotAtBar(royalPop, form, starts[4]! + 3)).toBe(driftingOrbit.slots[3]);
    expect(slotAtBar(royalPop, form, 0)).toBe(royalPop.slots[0]);
  });

  it('定番の choice は各区間の進行の defaultChoice で、助走の末尾は主要ドミナント', () => {
    const choice = defaultChoiceFor(royalPop, form);
    expect(choice).toHaveLength(36);
    expect(choice.slice(starts[1]!, starts[1]! + 4)).toEqual(tanakaManabe.defaultChoice);
    expect(choice.slice(starts[2]!, starts[2]! + minorDrive.slots.length)).toEqual(minorDrive.defaultChoice);
    const approachEnd = starts[4]! + 3;
    const token = driftingOrbit.slots[3]![choice[approachEnd]!]!.at(-1)!;
    expect(harmonicFunctionForToken(token)).toBe('dominant');
  });

  it('変化レシピも各区間の進行の登録レシピから引き、添字はその進行のスロット数に収まる', () => {
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
      const choice = variedChoiceFor(royalPop, form, seed);
      expect(choice, `seed=${seed}`).toHaveLength(36);
      form.sections.forEach((section, index) => {
        const prog = sectionProgressionOf(royalPop, section)!;
        const chunk = choice.slice(starts[index]!, starts[index]! + section.bars);
        chunk.forEach((selected, offset) => {
          expect(selected, `seed=${seed} ${section.id}+${offset}`).toBeLessThan(prog.slots[offset % prog.slots.length]!.length);
        });
        if (section.texture === 'pulse') {
          const token = prog.slots[(section.bars - 1) % prog.slots.length]![chunk.at(-1)!]!.at(-1)!;
          expect(harmonicFunctionForToken(token), `seed=${seed}`).toBe('dominant');
        } else if (prog.slots.length === 4 && section.bars === 8) {
          const recipes = recipeSet(prog);
          expect(recipes.has(chunk.slice(0, 4).join(',')), `seed=${seed} ${section.id} 前半`).toBe(true);
          expect(recipes.has(chunk.slice(4).join(',')), `seed=${seed} ${section.id} 後半`).toBe(true);
        }
      });
    }
    expect(hasVariedChoiceFor(royalPop, form)).toBe(true);
  });
});
