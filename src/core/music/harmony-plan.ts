import { Xoshiro128 } from '../rng.js';
import type { ComposeBars } from './compose.js';
import type { ProgressionDef } from './theory.js';

/**
 * 進行を尺いっぱいに展開したときの定番スロット選択。
 * 2周以上する場合は最終小節のドミナントを優先し、ループ頭へ引っ張る。
 */
export function defaultChoiceFor(prog: ProgressionDef, bars: number): number[] {
  const progBars = prog.slots.length;
  const rounds = Math.max(1, Math.floor(bars / progBars));
  const choice: number[] = [];
  for (let round = 0; round < rounds; round++) {
    for (let bar = 0; bar < progBars; bar++) {
      let index = prog.defaultChoice[bar] ?? 0;
      if (rounds > 1 && round === rounds - 1 && bar === progBars - 1) {
        const dominant = prog.slots[bar]!.findIndex((option) => option.length === 1 && option[0] === 'V');
        if (dominant >= 0) index = dominant;
      }
      choice.push(index);
    }
  }
  return choice.slice(0, bars);
}

export interface ChoiceVariationOptions {
  /** 変化レシピを選ぶ確率。通常の自動変化は25、専用ボタンは100。 */
  chancePercent?: number;
  /** 現在表示中のレシピを抽選対象から外す。 */
  currentChoice?: readonly number[];
}

function expandedVariationsFor(prog: ProgressionDef, bars: ComposeBars): number[][] {
  if (bars === 40) {
    const sectionA = defaultChoiceFor(prog, 8);
    const recipeSection = (variation: readonly number[]): number[] => prog.slots.length === 8
      ? [...variation]
      : [...prog.defaultChoice, ...variation];
    const withTurnaround = (choice: number[]): number[] => {
      const next = [...choice];
      const lastBar = next.length - 1;
      const slot = prog.slots[lastBar % prog.slots.length]!;
      const strongest = slot.findIndex((option) => option.length === 1 && ['V', 'V7m'].includes(option[0]!));
      const fallback = slot.findIndex((option) => ['V', 'V7m', 'I7'].includes(option.at(-1)!));
      if (strongest >= 0 || fallback >= 0) next[lastBar] = strongest >= 0 ? strongest : fallback;
      return next;
    };
    return prog.variations.map((_, offset) => {
      const sectionB = recipeSection(prog.variations[offset % prog.variations.length]!);
      // Bの変化をEで回帰させ、対照部Cは基本形へ戻す。
      const sectionC = sectionA;
      const sectionE = sectionB;
      return withTurnaround([...sectionA, ...sectionB, ...sectionC, ...sectionA, ...sectionE]);
    });
  }
  if (bars === 16) {
    const sectionA = defaultChoiceFor(prog, 8);
    const withTurnaround = (choice: number[]): number[] => {
      const next = [...choice];
      const lastBar = next.length - 1;
      const slot = prog.slots[lastBar % prog.slots.length]!;
      const index = slot.findIndex((option) => option.length === 1 && option[0] === 'V');
      const fallback = slot.findIndex((option) => option[option.length - 1] === 'V');
      const secondary = slot.findIndex((option) => option[option.length - 1] === 'I7');
      const selected = index >= 0 ? index : fallback >= 0 ? fallback : secondary;
      if (selected >= 0) next[lastBar] = selected;
      return next;
    };
    const unique = (choices: number[][]): number[][] => [
      ...new Map(choices.map((choice) => [choice.join(','), choice])).values(),
    ];
    if (prog.slots.length === 8) {
      return unique(prog.variations.map((variation) => withTurnaround([...sectionA, ...variation])));
    }
    if (prog.slots.length === 4) {
      return unique(prog.variations.flatMap((first, firstIndex) =>
        prog.variations
          .filter((_, secondIndex) => secondIndex !== firstIndex)
          .map((second) => withTurnaround([...sectionA, ...first, ...second])),
      ));
    }
    return [];
  }
  if (prog.slots.length === bars) return prog.variations.map((variation) => [...variation]);
  if (prog.slots.length === 4 && bars === 8) {
    return prog.variations.map((variation) => [...prog.defaultChoice, ...variation]);
  }
  return [];
}

function choicesEqual(a: readonly number[], b: readonly number[], bars: number): boolean {
  return a.length >= bars
    && b.length >= bars
    && Array.from({ length: bars }, (_, bar) => a[bar] === b[bar]).every(Boolean);
}

/** 現在とは異なる、カタログ登録済みの変化レシピがあるか。 */
export function hasVariedChoiceFor(
  prog: ProgressionDef,
  bars: ComposeBars,
  currentChoice: readonly number[] = defaultChoiceFor(prog, bars),
): boolean {
  return expandedVariationsFor(prog, bars).some((variation) => !choicesEqual(variation, currentChoice, bars));
}

/** 登録済みの進行変化レシピから、メロディとは別系列の乱数で一つ選ぶ。 */
export function variedChoiceFor(
  prog: ProgressionDef,
  bars: ComposeBars,
  seed: number,
  options: ChoiceVariationOptions = {},
): number[] {
  const current = [...(options.currentChoice ?? defaultChoiceFor(prog, bars))];
  const candidates = expandedVariationsFor(prog, bars).filter(
    (variation) => !choicesEqual(variation, current, bars),
  );
  if (candidates.length === 0) return current;

  const rng = new Xoshiro128((seed ^ 0x4348_4f52) >>> 0);
  const chance = Math.max(0, Math.min(100, options.chancePercent ?? (bars >= 16 ? 100 : 25)));
  if (rng.nextInt(100) >= chance) return current;
  return [...candidates[rng.nextInt(candidates.length)]!];
}
