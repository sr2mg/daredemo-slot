/**
 * 曲型生成器: 様式(StyleDef)と seed、目標の小節数から曲型(SongFormSpec)を導く。
 *
 * 手書きの曲型で得られた「近さ」の大半は骨格(区間の長さ・力の弧・拍の割り方の切替・テクスチャの
 * 置き場・進行と調の切替)から来ていた。ここではその骨格を列挙ではなく規則から組む:
 * - 旋回の文法: ポピュラー音楽の verse-chorus 形式(Covach)。1 旋回 = 提示 A → 展開 B → サビ S で、
 *   展開(プリコーラス)はサビへ直結する(Summach: プリコーラスの機能はサビへの牽引)。旋回は 3 回まで。
 * - 終端頂点(Osborn の terminally climactic form): 頂点は旋回の外、曲の終わりに 1 つだけ置く。
 *   旋回の後に C メロ(緩和) → 落ちサビ(サビ主題、全体最小。4 小節の助走が続くときはロングトーン)
 *   → 助走(パワーコード連打) → 大サビ(頂点) → 全音上のリフト(終幕) → アウトロ(終幕の着地)。
 *   予算が足りなければ最後の旋回のサビがそのまま頂点になる。4 小節単位の余りは助走を 8 小節に延ばして
 *   吸収する(そのとき落ちサビは旋律のある静かなサビ。旋律を休ませる区間は 12 小節まで)。
 * - 力の階段: 上昇する 4 機能(提示→展開→サビ→大サビ)を 2→3→4→5 へ写し、落ちサビだけが 1。
 *   力 5 は大サビとそのリフトの連なり 1 本。
 * - 主題は 4 種(A・B・C・S)。落ちサビと助走はサビ主題の再登場(旋律を持たないテクスチャ区間)なので
 *   新しい主題を使わず、リズム族(5 本)に 1 本の余りを残す。再登場の変形は役割が要求する認識可能性
 *   (サビ・帰還・終幕=literal、展開=transpose、2 回目の旋回の提示はトーナルアンサー=transpose)。
 *   転調する終幕は literal のまま(エンジンが調差ぶん持ち上げる。rev6)、アウトロも持ち上げた調に留まる。
 * - 拍の割り方は様式の曲型ファセット(StyleDef.form.groupings)の範囲で主題ごとに決める。対比相手は
 *   grid.ts の格子から「ステップ数を共有する(ヘミオラ)」>「拍数を共有する」の順に導き、切り替えるか
 *   自体は seed が決める(様式が許す = 強制ではない)。
 * - 進行は役割が求める和声的性質でカタログから絞る。性質は登録レシピ(定番+変化)の全部で成立するものだけ
 *   (区間の進行のレシピは harmony-plan が区間ごとに引くので、実現しても性質が残る)。助走の末尾は
 *   harmony-plan が主要ドミナントへ寄せるので、最終スロットに主要ドミナントの選択肢があれば足りる。
 * - 終わり方は様式の曲型ファセット(StyleDef.form.ending、省略 final)。2 区間以下はループ。
 *
 * 乱数は 1 本の Xoshiro128 を固定順で消費するので、同じ入力なら同じ出力。生成結果は validateForm を
 * 通してから返し、万一の不合格は seed 派生で再抽選する(構成上は 1 回目で通る。テストが固定)。
 * compose は読まない(生成結果は明示の区間列として保存される)ので、既存の曲型の出力は変わらない。
 */

import { Xoshiro128 } from '../rng.js';
import { formErrorMessage, validateForm } from './form.js';
import type { FormDefaults } from './form.js';
import { DEFAULT_GROUPING, gridFor } from './grid.js';
import { phraseRecipesFor } from './harmony-plan.js';
import {
  CHORDS, allowedGroupings, chordOriginsFor, closingEndingFor, harmonicFunctionForToken, progressionsForTonality,
} from './theory.js';
import type { ModalSource, ProgressionDef, StyleDef } from './theory.js';
import type {
  BarGrouping,
  MotifTransform,
  SectionBars,
  SectionEnergy,
  SectionRole,
  SectionSpec,
  SectionTexture,
  SongEnding,
  SongFormSpec,
  Tonality,
} from './types.js';

export interface FormGeneratorInput {
  style: StyleDef;
  seed: number;
  /** 目標の本編小節数。4 小節単位へ丸め、区間の長さ(4/8)の和をこれへ合わせる(足りない半単位は助走を延ばす)。 */
  targetBars: number;
  /** 曲既定(validateForm の FormDefaults と同じ)と、転調の基準になる曲のキー。 */
  defaults: FormDefaults & { keyRoot: number };
}

/** 生成器の乱数ストリームの用途(salt)。form.ts の sectionRng と同じ流儀で seed と混ぜる。 */
const RNG_SALT = 0x464f_524d;

/** 再抽選の上限。seed 派生は黄金比定数の倍数で散らす(sectionRng と同じ定数)。 */
const MAX_ATTEMPTS = 8;

/** 1 単位 = 8 小節(SRDC を 2 小節×4 で置く既定の区間長)。4 小節区間は半単位。 */
const UNIT_BARS: SectionBars = 8;
const HALF_UNIT_BARS: SectionBars = 4;

/** 主題は機能ごとに 1 つ(提示 A・展開 B・C メロ C・サビ S)。落ちサビと助走は S の再登場。 */
type ThemeKey = 'A' | 'B' | 'C' | 'S';

/**
 * 区間の力(1..5)。上昇する 4 機能(提示→展開→サビ→大サビ)を 2..5 の階段へ写す(各旋回でサビが
 * 局所最大、大サビだけが全体最大)。全体最小 1 は大サビ直前の落ちサビだけ。C メロと終幕の着地は提示と同じ段。
 */
const ENERGY = {
  verse: 2,
  development: 3,
  chorus: 4,
  peak: 5,
  relief: 2,
  trough: 1,
  /** 助走: 谷から頂点へ向かう緊張(頂点の 1 段下)。 */
  approach: 4,
  coda: 2,
} as const satisfies Record<string, SectionEnergy>;

/** 文法上の 1 区間(小節数・調の確定前)。 */
interface Slot {
  id: string;
  theme: ThemeKey;
  role: SectionRole;
  energy: SectionEnergy;
  texture: SectionTexture;
  bars: SectionBars;
  /** 再登場の変形(初出では無視)。省略 = literal。 */
  transform?: MotifTransform;
  /** 終幕のサビ(リフト): 全音上へ転調する。以降の区間も転調した調に留まる。 */
  lift: boolean;
  /** 2 区間ループの展開区間: 提示区間の結論フレーズを引用してループ頭を予告する(loop16 と同じ)。 */
  quoteHook: boolean;
  /** 進行の役割(曲既定と違う進行を引く区間)。 */
  progression: 'development' | 'relief' | 'approach' | null;
}

const slot = (
  id: string,
  theme: ThemeKey,
  role: SectionRole,
  energy: SectionEnergy,
  rest: Partial<Pick<Slot, 'texture' | 'bars' | 'transform' | 'lift' | 'quoteHook' | 'progression'>> = {},
): Slot => ({
  id, theme, role, energy, texture: 'normal', bars: UNIT_BARS, lift: false, quoteHook: false, progression: null, ...rest,
});

/** 1 旋回(提示→展開→サビ)の予算。 */
const ROTATION_UNITS = 3;
/** 旋回は 3 回まで(それ以上は同じ周回の繰り返しになる)。 */
const MAX_ROTATIONS = 3;

/**
 * 旋回の列と終端頂点の装置を単位予算へ配る。核(提示 A・展開 B・サビ S)の 3 単位に、形式機能上の
 * 優先度で拡張を足す:
 *   終幕の着地 → 落ちサビ+独立した大サビ(谷→頂点の弧) → リフト → 助走 → 提示の反復 →
 *   旋回の追加 → C メロ → 残りは各旋回の提示・サビの反復。
 * 落ちサビはサビ主題の再登場なので、先行する通常のサビ(旋回のサビ)と、その後の大サビを前提にする。
 */
interface Budget {
  coda: boolean;
  /** 落ちサビ(全体最小)と、その後の独立した大サビ。 */
  trough: boolean;
  lift: boolean;
  approach: boolean;
  relief: boolean;
  /** 大サビを旋回の外に独立して置くか(落ちサビか C メロがあるとき)。無ければ最後の旋回のサビが頂点。 */
  separatePeak: boolean;
  rotations: number;
  /** 各旋回の提示を 2 回鳴らすか(平行ピリオド)。 */
  verseRepeat: boolean[];
  /** 頂点でない旋回のサビを 2 回鳴らすか。 */
  chorusRepeat: boolean[];
  /** 配り切れなかった単位(半単位は助走を延ばして吸収する)。 */
  remaining: number;
}

function allocateBudget(units: number, approachUnits: number, rng: Xoshiro128): Budget {
  const budget: Budget = {
    coda: false, trough: false, lift: false, approach: false, relief: false, separatePeak: false,
    rotations: 1, verseRepeat: [false], chorusRepeat: [false], remaining: 0,
  };
  let remaining = units - ROTATION_UNITS;
  const take = (cost: number): boolean => {
    if (remaining + 1e-9 < cost) return false;
    remaining -= cost;
    return true;
  };
  budget.coda = take(1);
  // 落ちサビ(1)+ 大サビ(1)。
  budget.trough = take(2);
  budget.separatePeak = budget.trough;
  budget.lift = take(1);
  budget.approach = budget.trough && take(approachUnits);
  budget.verseRepeat[0] = take(1);
  while (budget.rotations < MAX_ROTATIONS && take(ROTATION_UNITS)) {
    budget.rotations += 1;
    budget.verseRepeat.push(false);
    budget.chorusRepeat.push(false);
  }
  // C メロ: 大サビが独立していれば 1 単位、無ければ大サビ(1)も一緒に取る。
  if (budget.separatePeak) budget.relief = take(1);
  else if (take(2)) {
    budget.relief = true;
    budget.separatePeak = true;
  }
  // 残りは反復で埋める。提示の反復と(頂点でない旋回の)サビの反復を seed の順で。
  const fillers: (() => void)[] = [];
  for (let rotation = 0; rotation < budget.rotations; rotation++) {
    if (!budget.verseRepeat[rotation]) fillers.push(() => { budget.verseRepeat[rotation] = true; });
  }
  const repeatableChoruses = budget.separatePeak ? budget.rotations : budget.rotations - 1;
  for (let rotation = 0; rotation < repeatableChoruses; rotation++) {
    fillers.push(() => { budget.chorusRepeat[rotation] = true; });
  }
  for (let index = fillers.length - 1; index > 0; index--) {
    const swap = rng.nextInt(index + 1);
    [fillers[index], fillers[swap]] = [fillers[swap]!, fillers[index]!];
  }
  for (const filler of fillers) {
    if (!take(1)) break;
    filler();
  }
  budget.remaining = remaining;
  return budget;
}

/** 文法から区間の列(Slot)を作る。 */
function grammar(units: number, approachBarsDefault: SectionBars, singleBars: SectionBars, rng: Xoshiro128): Slot[] {
  if (units < 1.5) return [slot('A', 'A', 'hook', ENERGY.verse, { bars: singleBars })];
  if (units < 2.5) {
    return [
      slot('A', 'A', 'hook', ENERGY.verse),
      slot('B', 'B', 'development', ENERGY.development, { quoteHook: true, progression: 'development' }),
    ];
  }
  const budget = allocateBudget(units, approachBarsDefault / UNIT_BARS, rng);
  // 4 小節の助走で半単位が余るときは助走を 8 小節に延ばし、目標の小節数へ合わせる。
  const approachBars: SectionBars = budget.approach && approachBarsDefault === HALF_UNIT_BARS && budget.remaining >= 0.5 - 1e-9
    ? UNIT_BARS
    : approachBarsDefault;
  const prime = (base: string, occurrence: number): string => base + "'".repeat(occurrence);
  const count: Record<ThemeKey, number> = { A: 0, B: 0, C: 0, S: 0 };
  const next = (theme: ThemeKey): string => prime(theme, count[theme]++);
  const slots: Slot[] = [];
  for (let rotation = 0; rotation < budget.rotations; rotation++) {
    const last = rotation === budget.rotations - 1;
    // 提示: 最初の旋回は看板、以降はサビから戻る帰還。2 回目の旋回はトーナルアンサー(transpose)、
    // 3 回目は literal の帰還。
    const verseRole: SectionRole = rotation === 0 ? 'hook' : 'return';
    const verseTransform: MotifTransform = rotation % 2 === 1 ? 'transpose' : 'literal';
    slots.push(slot(next('A'), 'A', verseRole, ENERGY.verse, { transform: verseTransform }));
    if (budget.verseRepeat[rotation]) slots.push(slot(next('A'), 'A', verseRole, ENERGY.verse, { transform: 'literal' }));
    slots.push(slot(next('B'), 'B', 'development', ENERGY.development, { transform: 'transpose', progression: 'development' }));
    const peakHere = last && !budget.separatePeak;
    const chorusRole: SectionRole = count.S === 0 ? 'hook' : 'return';
    slots.push(slot(next('S'), 'S', chorusRole, peakHere ? ENERGY.peak : ENERGY.chorus, { transform: 'literal' }));
    if (!peakHere && budget.chorusRepeat[rotation]) {
      slots.push(slot(next('S'), 'S', 'return', ENERGY.chorus, { transform: 'literal' }));
    }
  }
  if (budget.separatePeak) {
    if (budget.relief) slots.push(slot(next('C'), 'C', 'relief', ENERGY.relief, { progression: 'relief' }));
    if (budget.trough) {
      // 落ちサビ: サビ主題を全体最小の力で。4 小節の助走が続くときはロングトーン(旋律は保続)、
      // それ以外は旋律のある静かなサビ(旋律を休ませる区間は落ちサビ 8 + 助走 4 の 12 小節まで)。
      const sustain = budget.approach && approachBars === HALF_UNIT_BARS;
      slots.push(slot('s', 'S', 'relief', ENERGY.trough, { texture: sustain ? 'sustain' : 'normal', transform: 'literal' }));
    }
    if (budget.approach) {
      slots.push(slot('P', 'S', 'development', ENERGY.approach, { texture: 'pulse', bars: approachBars, progression: 'approach' }));
    }
    slots.push(slot(next('S'), 'S', 'return', ENERGY.peak, { transform: 'literal' }));
  }
  if (budget.lift) slots.push(slot(next('S'), 'S', 'finale', ENERGY.peak, { lift: true, transform: 'literal' }));
  if (budget.coda) slots.push(slot(next('A'), 'A', 'finale', ENERGY.coda, { transform: 'literal' }));
  return slots;
}

/**
 * 主題ごとの拍の割り方。主格子 m を様式の許容集合から seed で選び、切り替えるかも seed で決める
 * (様式が許す割り方は選択肢で、強制ではない)。切り替えるとき、展開 B は m の対比相手(ステップ数を
 * 共有する格子 = 同じ 8 分の流れを組み替えるヘミオラを優先、無ければ拍数を共有する格子)、C メロは
 * 残った相手(拍を共有する側)。A・S(落ちサビ・助走を含む)は m。
 */
function groupingPlan(style: StyleDef, rng: Xoshiro128): Record<ThemeKey, BarGrouping> {
  const allowed = allowedGroupings(style.form);
  const main = allowed[rng.nextInt(allowed.length)]!;
  const contrast = allowed.length > 1 && rng.nextInt(2) === 0;
  if (!contrast) return { A: main, S: main, B: main, C: main };
  const mainGrid = gridFor(main);
  const sharesSteps = allowed.find((candidate) => candidate !== main && gridFor(candidate).steps === mainGrid.steps);
  const sharesPulses = allowed.find((candidate) => candidate !== main && gridFor(candidate).pulses === mainGrid.pulses);
  const development = sharesSteps ?? sharesPulses ?? main;
  const relief = [sharesPulses, sharesSteps].find((candidate) => candidate !== undefined && candidate !== development) ?? main;
  return { A: main, S: main, B: development, C: relief };
}

/** レシピ(スロット添字列)が鳴らす和音トークン(小節ごと)。 */
function recipeBars(progression: ProgressionDef, recipe: readonly number[]): string[][] {
  return recipe.map((selected, bar) => {
    const options = progression.slots[bar % progression.slots.length]!;
    return [...(options[selected] ?? options[0]!)];
  });
}

/** 登録レシピ(定番+変化)の全部で成立する性質か。区間の進行はこのレシピから引かれる(harmony-plan)。 */
function everyRecipe(progression: ProgressionDef, property: (bars: string[][]) => boolean): boolean {
  return phraseRecipesFor(progression).every((recipe) => property(recipeBars(progression, recipe)));
}

/** 主音以外から始まる(出発の性質): 展開区間。 */
function startsAwayFromTonic(progression: ProgressionDef): boolean {
  return everyRecipe(progression, (bars) => {
    const first = bars[0]?.[0];
    return first !== undefined && CHORDS[first] !== undefined && CHORDS[first].root !== 0;
  });
}

/**
 * 同主調側の借用(旋法混合)。長調では主音を共有し長音階より低い音度を持つ旋法(ドリアン・フリジアン・
 * ミクソリディアン・エオリアン)の和音 = 陰影。副属和音(明るい緊張)は含めない。短調ではダイアトニックでなく、
 * 和声的短音階由来(主要ドミナント V7m とその族)でもないもの。
 */
const FLAT_SIDE_MODES: readonly ModalSource[] = ['dorian', 'phrygian', 'mixolydian', 'aeolian'];

function isMixtureChord(token: string, tonality: Tonality): boolean {
  const origins = chordOriginsFor(token, tonality);
  if (!origins || origins.diatonic) return false;
  if (tonality === 'major') return origins.modes.some((mode) => FLAT_SIDE_MODES.includes(mode));
  return !origins.modes.includes('harmonicMinor');
}

/** 借用和音を含む(陰影の性質): C メロ。 */
function hasMixture(progression: ProgressionDef, tonality: Tonality): boolean {
  return everyRecipe(progression, (bars) => bars.some((tokens) => tokens.some((token) => isMixtureChord(token, tonality))));
}

/** 主要ドミナント(主音へ解決する属機能。副属和音は除く)。 */
function isPrimaryDominant(token: string, tonality: Tonality): boolean {
  const origins = chordOriginsFor(token, tonality);
  return harmonicFunctionForToken(token) === 'dominant' && origins !== null && origins.secondaryDominantOf === null;
}

/**
 * 最終スロットに主要ドミナントの選択肢がある(牽引の性質): 助走。助走(pulse)区間の末尾は harmony-plan が
 * その選択肢へ寄せるので、レシピの違いに依らず頂点へ引っ張る。
 */
function canEndOnPrimaryDominant(progression: ProgressionDef, tonality: Tonality): boolean {
  const lastSlot = progression.slots.at(-1)!;
  return lastSlot.some((option) => isPrimaryDominant(option.at(-1)!, tonality));
}

/**
 * 役割ごとの進行を選ぶ。曲既定と違い、区間に収まり、性質を満たす候補から seed で 1 つ。
 * 候補が無ければ undefined(= 曲既定を使う)。
 */
function pickProgression(
  candidates: readonly ProgressionDef[],
  bars: SectionBars,
  property: (progression: ProgressionDef) => boolean,
  rng: Xoshiro128,
): string | undefined {
  const pool = candidates.filter((progression) => progression.slots.length <= bars && property(progression));
  if (pool.length === 0) return undefined;
  return pool[rng.nextInt(pool.length)]!.id;
}

/**
 * 終幕のサビの転調幅(半音)。上へ持ち上げる最小の転調のうち、元の調と共有する音が多い方
 * (半音上は 7 音中 2 音、全音上は 5 音)。ポピュラー音楽の「最後のサビの転調」。
 */
const LIFT_SEMITONES = 2;

/** 終わり方。2 区間以下は BGM のループ尺なのでループ。それ以上は様式の曲型ファセットの終わり方で閉じる。 */
function endingFor(style: StyleDef, sectionCount: number): SongEnding {
  return sectionCount <= 2 ? 'loop' : closingEndingFor(style.form);
}

function buildForm(input: FormGeneratorInput, seed: number): SongFormSpec {
  const { style, targetBars, defaults } = input;
  const rng = new Xoshiro128((seed ^ RNG_SALT) >>> 0);
  const tonality = defaults.tonality;
  const candidates = progressionsForTonality(tonality).filter((progression) => progression.id !== defaults.progressionId);
  const defaultProgression = progressionsForTonality(tonality).find((progression) => progression.id === defaults.progressionId);
  const defaultFitsHalfUnit = (defaultProgression?.slots.length ?? HALF_UNIT_BARS) <= HALF_UNIT_BARS;
  // 助走は 4 小節。ただし曲既定の進行が 4 小節に収まらないときは 8 小節(進行が区間より長いと不正)。
  const approachBars: SectionBars = defaultFitsHalfUnit ? HALF_UNIT_BARS : UNIT_BARS;
  // 目標を 4 小節単位へ丸め、8 小節単位(半単位あり)の予算にする。
  const units = Math.max(1, Math.round(targetBars / HALF_UNIT_BARS)) / 2;
  const singleBars: SectionBars = units <= 0.5 && defaultFitsHalfUnit ? HALF_UNIT_BARS : UNIT_BARS;

  const groupings = groupingPlan(style, rng);
  const slots = grammar(units, approachBars, singleBars, rng);
  const approachSlot = slots.find((item) => item.progression === 'approach');
  const progressionByRole: Record<NonNullable<Slot['progression']>, string | undefined> = {
    development: pickProgression(candidates, UNIT_BARS, startsAwayFromTonic, rng),
    relief: pickProgression(candidates, UNIT_BARS, (progression) => hasMixture(progression, tonality), rng),
    approach: approachSlot
      ? pickProgression(candidates, approachSlot.bars, (progression) => canEndOnPrimaryDominant(progression, tonality), rng)
      : undefined,
  };

  const occurrences = new Map<ThemeKey, number>();
  let keyRoot = defaults.keyRoot;
  const sections: SectionSpec[] = slots.map((item) => {
    const occurrence = occurrences.get(item.theme) ?? 0;
    occurrences.set(item.theme, occurrence + 1);
    // リフト以降は転調した調に留まる(大サビで上がった調をアウトロが下げると失速する)。
    if (item.lift) keyRoot = (keyRoot + LIFT_SEMITONES) % 12;
    const transform = occurrence > 0 && item.texture === 'normal' ? item.transform : undefined;
    const progressionId = item.progression ? progressionByRole[item.progression] : undefined;
    // 部分引用は引用元(A)と同じ割り方であること(validateForm)。
    const grouping = item.quoteHook ? groupings.A : groupings[item.theme];
    return {
      id: item.id,
      role: item.role,
      bars: item.bars,
      energy: item.energy,
      theme: item.theme,
      ...(transform !== undefined && transform !== 'literal' ? { transform } : {}),
      ...(item.quoteHook ? { quote: { from: 'A', phrases: [3] as const, transform: 'literal' as const } } : {}),
      ...(progressionId !== undefined ? { progressionId } : {}),
      ...(keyRoot !== defaults.keyRoot ? { keyRoot } : {}),
      ...(grouping !== DEFAULT_GROUPING ? { grouping } : {}),
      ...(item.texture !== 'normal' ? { texture: item.texture } : {}),
    };
  });
  return { sections, ending: endingFor(style, sections.length) };
}

/**
 * 曲型を生成する。validateForm を通った区間列だけを返す(同じ入力なら同じ出力)。
 * 不合格なら seed を派生して再抽選し、上限まで通らなければ最後の不合格理由で throw する。
 */
export function generateForm(input: FormGeneratorInput): SongFormSpec {
  let lastError: string | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const seed = (input.seed ^ Math.imul(attempt, 0x9e37_79b9)) >>> 0;
    const form = buildForm(input, seed);
    lastError = formErrorMessage(validateForm(form, input.defaults));
    if (lastError === null) return form;
  }
  throw new Error(`曲型を生成できない: ${lastError ?? '不明'}`);
}
