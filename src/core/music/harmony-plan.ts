/**
 * 進行レシピの展開: 曲型の各区間へ、カタログ登録済みの4小節レシピ(defaultChoice +
 * variations)を区間単位で割り当て、曲全体のフラットな choice(小節ごとのスロット添字)を作る。
 *
 * - 8小節区間 × 4小節進行: 異なる2レシピの組(前半≠後半)。
 * - 4小節区間 × 4小節進行 / 8小節区間 × 8小節進行: レシピ1本。
 * - 候補は区間ごとに列挙して一様に引く(列挙→重複除去→抽選。レシピ数が少ない進行でも
 *   特定の形へ偏らない)。隣接区間と同じレシピ列は避け、冒頭4小節(頭)は先行区間で
 *   未使用のものを優先して「各区間の冒頭が同じ進行へ固定」されないようにする。
 * - 帰還(return)区間は主題の初出区間の頭だけを複製し、「冒頭語彙の回帰」と
 *   「区間丸ごとのコピー」を分ける。
 * - ループ曲型で進行が2周以上するときだけ、最終小節を属和音の選択肢へ寄せて頭へ
 *   引っ張る(forceTurnaround)。終止曲型(final)の終止は song-plan が調性から導出する。
 */

import { Xoshiro128 } from '../rng.js';
import { resolveForm, sectionStartBars } from './form.js';
import type { ProgressionDef } from './theory.js';
import type { SectionSpec, SongFormRef, SongFormSpec } from './types.js';

/** 曲型の参照(プリセットid か区間列)。 */
export type ChoiceForm = SongFormRef;

const formOf = (form: ChoiceForm): SongFormSpec => resolveForm(form);

const DOMINANT_TOKENS = ['V', 'V7m', 'I7'];

/** スロット内で最も強く頭へ引っ張る選択肢(単独の属和音 > 末尾が属和音)。無ければ -1。 */
function dominantOptionIndex(slot: ProgressionDef['slots'][number]): number {
  const strongest = slot.findIndex(
    (option) => option.length === 1 && DOMINANT_TOKENS.includes(option[0]!),
  );
  if (strongest >= 0) return strongest;
  return slot.findIndex((option) => DOMINANT_TOKENS.includes(option.at(-1)!));
}

/** 末尾小節(進行内の位置 slotIndex)を属和音へ寄せる。該当選択肢が無ければそのまま。 */
function withTurnaround(prog: ProgressionDef, choice: readonly number[]): number[] {
  const next = [...choice];
  const lastBar = next.length - 1;
  if (lastBar < 0) return next;
  const index = dominantOptionIndex(prog.slots[lastBar % prog.slots.length]!);
  if (index >= 0) next[lastBar] = index;
  return next;
}

function uniqueChoices(choices: readonly (readonly number[])[]): number[][] {
  return [...new Map(choices.map((choice) => [choice.join(','), [...choice]])).values()];
}

/** カタログ登録済みの進行レシピ(進行の長さぶん)。 */
export function phraseRecipesFor(prog: ProgressionDef): number[][] {
  return uniqueChoices([prog.defaultChoice, ...prog.variations]);
}

const totalBarsOf = (spec: SongFormSpec): number => spec.sections.reduce((sum, section) => sum + section.bars, 0);

/** ループで進行が2周以上するときだけ、最終小節のターンアラウンドを強制する(1周の4小節は素のまま)。 */
const needsTurnaround = (prog: ProgressionDef, spec: SongFormSpec): boolean => (
  spec.ending === 'loop' && totalBarsOf(spec) > prog.slots.length
);

/** 区間の choice(区間内の小節ぶん)。レシピを bars/進行長 回並べる。 */
function sectionDefaultChoice(prog: ProgressionDef, bars: number): number[] {
  const rounds = Math.max(1, Math.floor(bars / prog.slots.length));
  const choice: number[] = [];
  for (let round = 0; round < rounds; round++) {
    for (let bar = 0; bar < prog.slots.length; bar++) choice.push(prog.defaultChoice[bar] ?? 0);
  }
  return choice.slice(0, bars);
}

/**
 * 進行を曲型いっぱいに展開したときの定番スロット選択。
 * ループ曲型では最終小節のドミナントを優先し、ループ頭へ引っ張る。
 */
export function defaultChoiceFor(prog: ProgressionDef, form: ChoiceForm): number[] {
  const spec = formOf(form);
  const choice = spec.sections.flatMap((section) => sectionDefaultChoice(prog, section.bars));
  return needsTurnaround(prog, spec) ? withTurnaround(prog, choice) : choice;
}

export interface ChoiceVariationOptions {
  /** 変化レシピを選ぶ確率。通常は4小節で25%、8小節以上で100%、専用ボタンは100%。 */
  chancePercent?: number;
  /** 現在表示中のレシピを抽選対象から外す。 */
  currentChoice?: readonly number[];
}

/** 2コード小節(半小節変化)を含まないレシピ。和声リズムを平坦に保つ曲の候補。 */
function hasSplitBar(prog: ProgressionDef, recipe: readonly number[]): boolean {
  return recipe.some((selected, bar) => prog.slots[bar % prog.slots.length]![selected]!.length > 1);
}

/**
 * 区間1つぶんの候補レシピ列(進行長の倍数)。
 * - 1周(4小節×4小節進行、8小節×8小節進行): 登録済みの変化レシピ(定番は「変化なし」の側)。
 * - 2周(8小節×4小節進行): 定番＋変化レシピから前後半が異なる組。
 * 最終区間でターンアラウンドを強制する場合は、強制後に重複除去と前後半の比較を行う。
 * noSplit は半小節変化を含むレシピを除く(候補が2本未満なら無視)。
 */
function buildSectionCandidates(
  prog: ProgressionDef,
  bars: number,
  turnaround: boolean,
  noSplit: boolean,
): number[][] {
  const rounds = Math.floor(bars / prog.slots.length);
  const finish = (choice: number[]): number[] => (turnaround ? withTurnaround(prog, choice) : choice);
  // 4小節×4小節進行(1周の最小形)だけは定番を「変化なし」の側に置き、変化レシピだけを候補にする。
  const allRecipes = rounds <= 1 && bars === 4 ? uniqueChoices(prog.variations) : phraseRecipesFor(prog);
  // 平坦な和声リズムの側は、4小節進行を2周する区間で、組にしても偏らない4本以上があるときだけ作る
  // (8小節進行はレシピが少なく、絞ると区間が同じ列へ収束する)。
  const plain = allRecipes.filter((recipe) => !hasSplitBar(prog, recipe));
  const recipes = noSplit && rounds > 1 && plain.length >= 4 ? plain : allRecipes;
  if (rounds <= 1) return uniqueChoices(recipes.map((recipe) => finish(recipe.slice(0, bars))));
  const slots = prog.slots.length;
  return uniqueChoices(recipes.flatMap((first) => (
    recipes.map((second) => finish([...first, ...second]))
  ))).filter((choice) => choice.slice(0, slots).join(',') !== choice.slice(slots).join(','));
}

const candidateCache = new WeakMap<ProgressionDef, Map<string, number[][]>>();

function sectionCandidates(prog: ProgressionDef, bars: number, turnaround: boolean, noSplit = false): number[][] {
  let byKey = candidateCache.get(prog);
  if (!byKey) {
    byKey = new Map();
    candidateCache.set(prog, byKey);
  }
  const key = `${bars}:${turnaround ? 't' : '-'}:${noSplit ? 'p' : '-'}`;
  let cached = byKey.get(key);
  if (!cached) {
    cached = buildSectionCandidates(prog, bars, turnaround, noSplit);
    byKey.set(key, cached);
  }
  return cached;
}

/** 主題の初出区間(帰還の元)。無ければ -1。 */
function themeOriginIndex(sections: readonly SectionSpec[], index: number): number {
  const origin = sections.findIndex((candidate) => candidate.theme === sections[index]!.theme);
  return origin >= 0 && origin < index ? origin : -1;
}

/** 現在とは異なる、カタログ登録済みの変化レシピがあるか。 */
export function hasVariedChoiceFor(
  prog: ProgressionDef,
  form: ChoiceForm,
  currentChoice: readonly number[] = defaultChoiceFor(prog, form),
): boolean {
  const spec = formOf(form);
  const starts = sectionStartBars(spec);
  const turnaround = needsTurnaround(prog, spec);
  return spec.sections.some((section, index) => {
    const isLast = index === spec.sections.length - 1;
    const candidates = sectionCandidates(prog, section.bars, turnaround && isLast);
    const current = currentChoice.slice(starts[index], starts[index]! + section.bars).join(',');
    return candidates.some((candidate) => candidate.join(',') !== current);
  });
}

/**
 * 登録済みの進行変化レシピから、メロディとは別系列の乱数で区間ごとに選ぶ。
 * 隣接区間と同一のレシピ列は避け、冒頭4小節は先行区間で未使用のものを優先し、
 * 帰還区間は主題の初出区間の頭だけを継ぐ。
 */
export function variedChoiceFor(
  prog: ProgressionDef,
  form: ChoiceForm,
  seed: number,
  options: ChoiceVariationOptions = {},
): number[] {
  const spec = formOf(form);
  const current = [...(options.currentChoice ?? defaultChoiceFor(prog, spec))];
  if (!hasVariedChoiceFor(prog, spec, current)) return current;

  const rng = new Xoshiro128((seed ^ 0x4348_4f52) >>> 0);
  const totalBars = totalBarsOf(spec);
  const defaultChance = totalBars >= 8 ? 100 : 25;
  const chance = Math.max(0, Math.min(100, options.chancePercent ?? defaultChance));
  if (rng.nextInt(100) >= chance) return current;

  const slots = prog.slots.length;
  const turnaround = needsTurnaround(prog, spec);
  const headOf = (choice: readonly number[]): string => choice.slice(0, slots).join(',');
  const build = (): number[] => {
    // 曲単位で「半小節変化を使わない」側も半分の確率で引き、和声リズムが常に細かくならないようにする。
    const noSplit = spec.sections.length > 1 && rng.nextInt(2) === 0;
    const sectionChoices: number[][] = [];
    const usedHeads = new Set<string>();
    const usedChoices = new Set<string>();
    spec.sections.forEach((section, index) => {
      const isLast = index === spec.sections.length - 1;
      const candidates = sectionCandidates(prog, section.bars, turnaround && isLast, noSplit);
      const previous = sectionChoices[index - 1]?.join(',') ?? null;
      const originIndex = section.role === 'return' ? themeOriginIndex(spec.sections, index) : -1;
      const rounds = Math.floor(section.bars / slots);
      let pool: number[][];
      if (originIndex >= 0 && rounds > 1) {
        // 帰還: 初出区間の頭を継ぎ、後半は初出区間と異なる候補から引く。
        const origin = sectionChoices[originIndex]!;
        const sameHead = candidates.filter((candidate) => headOf(candidate) === headOf(origin));
        pool = sameHead.filter((candidate) => candidate.join(',') !== origin.join(',') && candidate.join(',') !== previous);
        if (pool.length === 0) pool = sameHead.length > 0 ? sameHead : candidates;
      } else {
        // 優先順: 未使用の列で頭も未使用 > 未使用の列 > 直前と異なる > 何でも。
        const notPrevious = candidates.filter((candidate) => candidate.join(',') !== previous);
        const unused = notPrevious.filter((candidate) => !usedChoices.has(candidate.join(',')));
        const freshHead = unused.filter((candidate) => !usedHeads.has(headOf(candidate)));
        pool = freshHead.length > 0
          ? freshHead
          : unused.length > 0 ? unused : notPrevious.length > 0 ? notPrevious : candidates;
      }
      const chosen = [...pool[rng.nextInt(pool.length)]!];
      usedHeads.add(headOf(chosen));
      usedChoices.add(chosen.join(','));
      sectionChoices.push(chosen);
    });
    return sectionChoices.flat();
  };
  const currentKey = current.slice(0, totalBars).join(',');
  for (let attempt = 0; attempt < 8; attempt++) {
    const choice = build();
    if (choice.join(',') !== currentKey) return choice;
  }
  return current;
}
