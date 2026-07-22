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
        const dominant = prog.slots[bar]!.findIndex(
          (option) => option.length === 1 && ['V', 'V7m', 'I7'].includes(option[0]!),
        );
        const fallback = prog.slots[bar]!.findIndex((option) => ['V', 'V7m', 'I7'].includes(option.at(-1)!));
        if (dominant >= 0 || fallback >= 0) index = dominant >= 0 ? dominant : fallback;
      }
      choice.push(index);
    }
  }
  return choice.slice(0, bars);
}

export interface ChoiceVariationOptions {
  /** 変化レシピを選ぶ確率。通常は4小節で25%、8小節以上で100%、専用ボタンは100%。 */
  chancePercent?: number;
  /** 現在表示中のレシピを抽選対象から外す。 */
  currentChoice?: readonly number[];
}

function uniqueChoices(choices: readonly (readonly number[])[]): number[][] {
  return [...new Map(choices.map((choice) => [choice.join(','), [...choice]])).values()];
}

function forceTurnaround(prog: ProgressionDef, choice: readonly number[]): number[] {
  const next = [...choice];
  const lastBar = next.length - 1;
  const slot = prog.slots[lastBar % prog.slots.length]!;
  const strongest = slot.findIndex(
    (option) => option.length === 1 && ['V', 'V7m', 'I7'].includes(option[0]!),
  );
  const fallback = slot.findIndex((option) => ['V', 'V7m', 'I7'].includes(option.at(-1)!));
  if (strongest >= 0 || fallback >= 0) next[lastBar] = strongest >= 0 ? strongest : fallback;
  return next;
}

function phraseRecipesFor(prog: ProgressionDef): number[][] {
  return uniqueChoices([prog.defaultChoice, ...prog.variations]);
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) => permutations([
    ...values.slice(0, index),
    ...values.slice(index + 1),
  ]).map((tail) => [value, ...tail]));
}

function sampledPermutations<T>(values: readonly T[], maximum = 120): T[][] {
  const all = permutations(values);
  if (all.length <= maximum) return all;
  return Array.from({ length: maximum }, (_, index) => (
    all[Math.floor(index * all.length / maximum)]!
  ));
}

/** 登録済み語彙を2フレーズ組み合わせ、8小節の開始側も固定しない。 */
function eightBarRecipesFor(prog: ProgressionDef): number[][] {
  const phrases = phraseRecipesFor(prog);
  if (prog.slots.length === 8) {
    return uniqueChoices(phrases.map((phrase) => forceTurnaround(prog, phrase)));
  }
  if (prog.slots.length !== 4) return [];
  return uniqueChoices(phrases.flatMap((first, firstIndex) => (
    phrases
      .filter((_, secondIndex) => secondIndex !== firstIndex)
      .map((second) => forceTurnaround(prog, [...first, ...second]))
  ))).filter((choice) => choice.slice(0, 4).join(',') !== choice.slice(4).join(','));
}

function buildExpandedVariationsFor(prog: ProgressionDef, bars: ComposeBars): number[][] {
  if (bars === 40) {
    const phraseRecipes = phraseRecipesFor(prog);
    if (prog.slots.length === 8) {
      // A〜Eへ同じ巡回順を当てるだけにせず、登録済み8小節レシピの順列を使う。
      // 候補が4個の場合だけEで語彙を再登場させ、最低4種類の区間を保つ。
      return uniqueChoices(sampledPermutations(phraseRecipes).map((order) => forceTurnaround(
        prog,
        Array.from({ length: 5 }, (_, sectionIndex) => order[sectionIndex % order.length]!).flat(),
      )));
    }
    if (prog.slots.length === 4 && phraseRecipes.length >= 5) {
      const noSplitRecipes = phraseRecipes.filter((recipe) => recipe.every((choice, bar) => (
        prog.slots[bar]![choice]!.length === 1
      )));
      const pools = noSplitRecipes.length >= 4
        ? [phraseRecipes, noSplitRecipes]
        : [phraseRecipes];
      return uniqueChoices(pools.flatMap((recipePool) => sampledPermutations(recipePool).map((order) => {
        const pick = (index: number): number[] => [...order[index % order.length]!];
        // Aの冒頭語彙だけDで回帰させる。B/C/Eは別の組み合わせにし、
        // 「回帰」と「8小節丸ごとのコピー」を分離する。
        const sections = [
          [...pick(0), ...pick(1)],
          [...pick(2), ...pick(3)],
          [...pick(4), ...pick(0)],
          [...pick(0), ...pick(2)],
          [...pick(3), ...pick(4)],
        ];
        return forceTurnaround(prog, sections.flat());
      })));
    }
    return [];
  }
  if (bars === 16) {
    const sections = eightBarRecipesFor(prog);
    if (sections.length < 2) return [];
    return uniqueChoices(sections.flatMap((first, firstIndex) => sections
      .filter((_, secondIndex) => secondIndex !== firstIndex)
      .map((second) => forceTurnaround(prog, [...first, ...second]))));
  }
  if (bars === 8) return eightBarRecipesFor(prog);
  if (prog.slots.length === bars) return prog.variations.map((variation) => [...variation]);
  return [];
}

const expandedVariationCache = new WeakMap<ProgressionDef, Map<ComposeBars, number[][]>>();
const expandedVariationIndexCache = new WeakMap<ProgressionDef, Map<ComposeBars, Map<string, number>>>();

function expandedVariationsFor(prog: ProgressionDef, bars: ComposeBars): number[][] {
  let byBars = expandedVariationCache.get(prog);
  if (!byBars) {
    byBars = new Map();
    expandedVariationCache.set(prog, byBars);
  }
  const cached = byBars.get(bars);
  if (cached) return cached;
  const built = buildExpandedVariationsFor(prog, bars);
  byBars.set(bars, built);
  return built;
}

function expandedVariationIndexFor(prog: ProgressionDef, bars: ComposeBars): Map<string, number> {
  let byBars = expandedVariationIndexCache.get(prog);
  if (!byBars) {
    byBars = new Map();
    expandedVariationIndexCache.set(prog, byBars);
  }
  const cached = byBars.get(bars);
  if (cached) return cached;
  const built = new Map(expandedVariationsFor(prog, bars).map((choice, index) => [choice.join(','), index]));
  byBars.set(bars, built);
  return built;
}

/** 現在とは異なる、カタログ登録済みの変化レシピがあるか。 */
export function hasVariedChoiceFor(
  prog: ProgressionDef,
  bars: ComposeBars,
  currentChoice: readonly number[] = defaultChoiceFor(prog, bars),
): boolean {
  const variations = expandedVariationsFor(prog, bars);
  if (variations.length === 0) return false;
  const currentIndex = expandedVariationIndexFor(prog, bars).get(currentChoice.slice(0, bars).join(','));
  return currentIndex === undefined || variations.length > 1;
}

/** 登録済みの進行変化レシピから、メロディとは別系列の乱数で一つ選ぶ。 */
export function variedChoiceFor(
  prog: ProgressionDef,
  bars: ComposeBars,
  seed: number,
  options: ChoiceVariationOptions = {},
): number[] {
  const current = [...(options.currentChoice ?? defaultChoiceFor(prog, bars))];
  const variations = expandedVariationsFor(prog, bars);
  const currentIndex = expandedVariationIndexFor(prog, bars).get(current.slice(0, bars).join(','));
  const candidateCount = variations.length - (currentIndex === undefined ? 0 : 1);
  if (candidateCount === 0) return current;

  const rng = new Xoshiro128((seed ^ 0x4348_4f52) >>> 0);
  const defaultChance = bars >= 8 ? 100 : 25;
  const chance = Math.max(0, Math.min(100, options.chancePercent ?? defaultChance));
  if (rng.nextInt(100) >= chance) return current;
  let selected = rng.nextInt(candidateCount);
  if (currentIndex !== undefined && selected >= currentIndex) selected++;
  return [...variations[selected]!];
}
