/**
 * 曲型生成器: 様式(StyleDef)と seed、目標の小節数から曲型(SongFormSpec)を導く。
 *
 * 手書きの曲型で得られた「近さ」の大半は骨格(区間の長さ・力の弧・拍の割り方の切替・テクスチャの
 * 置き場・進行と調の切替)から来ていた。ここではその骨格を列挙ではなく規則から組む:
 * - 区間機能の文法: 提示(hook)→展開(development)→緩和(relief)→帰還(return)→終幕(finale)。
 *   歌ものは verse→chorus の「旋回」の繰り返しで、最後の旋回だけが頂点を持つ(Caplin の形式機能論を
 *   区間の役割へ写し、ポピュラー音楽の verse-chorus 形式の旋回を単位にする)。
 * - 単一頂点: 力 5 は頂点の連なり(サビの帰還と、その転調したリフト)1 本だけ。頂点の直前に全体最小の
 *   谷(ロングトーン)と助走(パワーコード連打)を置き、終幕は頂点から下降して閉じる。
 * - 主題は機能ごと(提示 A・展開 B・緩和 C・サビ S・助走 P)の 5 種 = リズム族の本数。再登場の変形は
 *   役割が要求する認識可能性から(hook/return/finale=literal、development=transpose、relief=invert)、
 *   調が変わる区間は transpose(転調 ⇔ 移調)。
 * - 拍の割り方は様式の拍節ファセットが許す範囲で主題ごとに決める(主題の元区間と同じ割り方であることが
 *   validateForm の受理条件)。対比相手は grid.ts の格子から「ステップ数を共有する(ヘミオラ)」>
 *   「拍数を共有する」の順に導く。
 * - 進行は役割が求める和声的性質(離れて始まる・借用を含む・ドミナントで終わる)でカタログから絞る。
 *
 * 乱数は 1 本の Xoshiro128 を固定順で消費するので、同じ入力なら同じ出力。生成結果は validateForm を
 * 通してから返し、万一の不合格は seed 派生で再抽選する(構成上は 1 回目で通る。テストが固定)。
 * compose は読まない(生成結果は明示の区間列として保存される)ので、既存の曲型の出力は変わらない。
 */

import { Xoshiro128 } from '../rng.js';
import { formErrorMessage, validateForm } from './form.js';
import type { FormDefaults } from './form.js';
import { DEFAULT_GROUPING, gridFor } from './grid.js';
import {
  CHORDS, allowedGroupings, chordOriginsFor, harmonicFunctionForToken, progressionsForTonality,
} from './theory.js';
import type { ProgressionDef, StyleDef } from './theory.js';
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
  /** 目標の本編小節数。区間の長さ(4/8)の和がこれへ最も近い組み合わせを取る(±4 以内)。 */
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

/** 主題は機能ごとに 1 つ。5 種はリズム族の本数(RHYTHM_FAMILY_COUNT)と同じで、族の共有を起こさない。 */
type ThemeKey = 'A' | 'B' | 'C' | 'S' | 'P';

/** 区間の力(1..5)。役割の基底と位置からの上書きで決める。 */
const ENERGY = {
  /** 提示・帰還の verse。 */
  verse: 3,
  /** 展開・助走: 頂点へ向かう緊張。 */
  rise: 4,
  /** 緩和。 */
  relief: 2,
  /** 頂点直前の谷(全体最小)。 */
  trough: 1,
  /** 頂点の連なり。 */
  peak: 5,
  /** 終幕の着地。 */
  coda: 2,
} as const satisfies Record<string, SectionEnergy>;

/** 文法上の 1 区間(主題 id・小節数・調の確定前)。 */
interface Slot {
  theme: ThemeKey;
  role: SectionRole;
  energy: SectionEnergy;
  texture: SectionTexture;
  bars: SectionBars;
  /** 終幕のサビ(リフト): 全音上へ転調する。 */
  lift: boolean;
  /** 2 区間ループの展開区間: 提示区間の結論フレーズを引用してループ頭を予告する(loop16 と同じ)。 */
  quoteHook: boolean;
}

const slot = (
  theme: ThemeKey,
  role: SectionRole,
  energy: SectionEnergy,
  rest: Partial<Pick<Slot, 'texture' | 'bars' | 'lift' | 'quoteHook'>> = {},
): Slot => ({
  theme, role, energy, texture: 'normal', bars: UNIT_BARS, lift: false, quoteHook: false, ...rest,
});

/** 1 旋回(verse→chorus)の予算。提示・展開・緩和・サビの 4 単位。 */
const ROTATION_UNITS = 4;
/** 旋回は 3 回まで(それ以上は同じ周回の繰り返しになる)。 */
const MAX_EXTRA_ROTATIONS = 2;

/**
 * 旋回の列と頂点・終幕を単位予算へ配る。
 * 核(提示 A・展開 B・サビ S)の 3 単位に、形式機能上の優先度で拡張を足す:
 *   終幕の着地 → 緩和(谷) → 頂点のリフト → {助走, 提示の反復}(順は seed) → 旋回の追加 →
 *   最後の旋回の第 2 の緩和 → 残りは各旋回の提示・サビの反復。
 * 「谷のロングトーン」は助走がある(谷→助走→頂点の連なりが成立する)ときだけ置く。
 */
interface Budget {
  coda: boolean;
  trough: boolean;
  lift: boolean;
  approach: boolean;
  secondRelief: boolean;
  /** 旋回の数(最後の旋回を含む)。 */
  rotations: number;
  /** 各旋回の提示を 2 回鳴らすか(平行ピリオド)。 */
  verseRepeat: boolean[];
  /** 非最終旋回のサビを 2 回鳴らすか。 */
  chorusRepeat: boolean[];
}

function allocateBudget(units: number, approachUnits: number, rng: Xoshiro128): Budget {
  const budget: Budget = {
    coda: false, trough: false, lift: false, approach: false, secondRelief: false,
    rotations: 1, verseRepeat: [false], chorusRepeat: [false],
  };
  let remaining = units - 3;
  const take = (cost: number): boolean => {
    if (remaining + 1e-9 < cost) return false;
    remaining -= cost;
    return true;
  };
  budget.coda = take(1);
  budget.trough = take(1);
  budget.lift = take(1);
  // 助走と提示の反復は同じ優先度クラス: どちらを先に満たすかは seed。
  const approachFirst = rng.nextInt(2) === 0;
  if (approachFirst) {
    budget.approach = take(approachUnits);
    budget.verseRepeat[0] = take(1);
  } else {
    budget.verseRepeat[0] = take(1);
    budget.approach = take(approachUnits);
  }
  while (budget.rotations < 1 + MAX_EXTRA_ROTATIONS && take(ROTATION_UNITS)) {
    budget.rotations += 1;
    budget.verseRepeat.push(false);
    budget.chorusRepeat.push(false);
  }
  if (budget.trough) budget.secondRelief = take(1);
  // 残りは反復で埋める。提示の反復(前から)とサビの反復(非最終旋回)を seed の順で交互に。
  const fillers: (() => void)[] = [];
  for (let rotation = 0; rotation < budget.rotations; rotation++) {
    if (!budget.verseRepeat[rotation]) fillers.push(() => { budget.verseRepeat[rotation] = true; });
  }
  for (let rotation = 0; rotation < budget.rotations - 1; rotation++) {
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
  return budget;
}

/** 文法から区間の列(Slot)を作る。 */
function grammar(units: number, approachBars: SectionBars, rng: Xoshiro128): Slot[] {
  if (units < 1.5) return [slot('A', 'hook', ENERGY.verse)];
  if (units < 2.5) {
    return [slot('A', 'hook', ENERGY.verse), slot('B', 'development', ENERGY.rise, { quoteHook: true })];
  }
  const budget = allocateBudget(units, approachBars / UNIT_BARS, rng);
  const slots: Slot[] = [];
  let chorusSeen = false;
  for (let rotation = 0; rotation < budget.rotations; rotation++) {
    const last = rotation === budget.rotations - 1;
    // 提示: 最初の旋回は看板、以降はサビから戻る帰還。
    const verseRole: SectionRole = rotation === 0 ? 'hook' : 'return';
    slots.push(slot('A', verseRole, ENERGY.verse));
    if (budget.verseRepeat[rotation]) slots.push(slot('A', verseRole, ENERGY.verse));
    slots.push(slot('B', 'development', ENERGY.rise));
    if (!last) {
      slots.push(slot('C', 'relief', ENERGY.relief));
      slots.push(slot('S', chorusSeen ? 'return' : 'hook', ENERGY.rise));
      if (budget.chorusRepeat[rotation]) slots.push(slot('S', chorusSeen ? 'return' : 'hook', ENERGY.rise));
      chorusSeen = true;
      continue;
    }
    if (budget.secondRelief) slots.push(slot('C', 'relief', ENERGY.relief));
    if (budget.trough) {
      slots.push(slot('C', 'relief', ENERGY.trough, { texture: budget.approach ? 'sustain' : 'normal' }));
    }
    if (budget.approach) slots.push(slot('P', 'development', ENERGY.rise, { texture: 'pulse', bars: approachBars }));
    slots.push(slot('S', chorusSeen ? 'return' : 'hook', ENERGY.peak));
    if (budget.lift) slots.push(slot('S', 'finale', ENERGY.peak, { lift: true }));
  }
  if (budget.coda) slots.push(slot('A', 'finale', ENERGY.coda));
  return slots;
}

/**
 * 主題ごとの拍の割り方。主格子 m を様式の許容集合から seed で選び、
 * 展開 B は m の対比相手(ステップ数を共有する格子 = 同じ 8 分の流れを組み替えるヘミオラを優先、
 * 無ければ拍数を共有する格子)、緩和 C は残った相手(拍を共有する側)、A・S・P は m。
 */
function groupingPlan(style: StyleDef, rng: Xoshiro128): Record<ThemeKey, BarGrouping> {
  const allowed = allowedGroupings(style.meter);
  const main = allowed[rng.nextInt(allowed.length)]!;
  const mainGrid = gridFor(main);
  const sharesSteps = allowed.find((candidate) => candidate !== main && gridFor(candidate).steps === mainGrid.steps);
  const sharesPulses = allowed.find((candidate) => candidate !== main && gridFor(candidate).pulses === mainGrid.pulses);
  const development = sharesSteps ?? sharesPulses ?? main;
  const relief = [sharesPulses, sharesSteps].find((candidate) => candidate !== undefined && candidate !== development) ?? main;
  return { A: main, S: main, P: main, B: development, C: relief };
}

/** 進行の既定選択で鳴る和音トークン列(小節順)。 */
function defaultTokens(progression: ProgressionDef): string[] {
  return progression.slots.flatMap((options, index) => [...(options[progression.defaultChoice[index] ?? 0] ?? options[0]!)]);
}

/** 主音以外から始まる進行(出発の性質): 展開区間。 */
function startsAwayFromTonic(progression: ProgressionDef): boolean {
  const first = defaultTokens(progression)[0];
  return first !== undefined && CHORDS[first]?.root !== 0;
}

/**
 * 借用和音を含む進行(陰影の性質): 緩和区間。ダイアトニックでない和音のうち、短調の和声的短音階に
 * 属するもの(主要ドミナント V7m とその族)は借用ではないので除く。
 */
function hasBorrowedChord(progression: ProgressionDef, tonality: Tonality): boolean {
  return defaultTokens(progression).some((token) => {
    const origins = chordOriginsFor(token, tonality);
    if (!origins || origins.diatonic) return false;
    return !(tonality === 'minor' && origins.modes.includes('harmonicMinor'));
  });
}

/** ドミナントで終わる進行(牽引の性質): 頂点への助走。 */
function endsOnDominant(progression: ProgressionDef): boolean {
  const last = defaultTokens(progression).at(-1);
  return last !== undefined && harmonicFunctionForToken(last) === 'dominant';
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

/** 再登場の変形: 役割が要求する認識可能性。調が変わる区間は呼び出し側が transpose へ上書きする。 */
function transformForRole(role: SectionRole): MotifTransform {
  if (role === 'development') return 'transpose';
  if (role === 'relief') return 'invert';
  return 'literal';
}

/**
 * 終幕のサビの転調幅(半音)。全音上は半音上より元の調と共有する音が多く(7 音中 5 音)、
 * フックの輪郭が literal に近いまま持ち上がる(ポピュラー音楽の「最後のサビの転調」)。
 */
const LIFT_SEMITONES = 2;

/**
 * 終わり方。2 区間以下は BGM のループ尺なのでループ。それ以上は終止で閉じ、拍を刻む打楽器が無い編成
 * (percussion none)だけ自然な減速(ritardando)で閉じる。
 */
function endingFor(style: StyleDef, sectionCount: number): SongEnding {
  if (sectionCount <= 2) return 'loop';
  return style.percussion.kind === 'none' ? 'ritardando' : 'final';
}

function buildForm(input: FormGeneratorInput, seed: number): SongFormSpec {
  const { style, targetBars, defaults } = input;
  const rng = new Xoshiro128((seed ^ RNG_SALT) >>> 0);
  const tonality = defaults.tonality;
  const candidates = progressionsForTonality(tonality).filter((progression) => progression.id !== defaults.progressionId);
  const defaultProgression = progressionsForTonality(tonality).find((progression) => progression.id === defaults.progressionId);
  // 助走は 4 小節。ただし曲既定の進行が 4 小節に収まらないときは 8 小節(進行が区間より長いと不正)。
  const approachBars: SectionBars = (defaultProgression?.slots.length ?? HALF_UNIT_BARS) <= HALF_UNIT_BARS
    ? HALF_UNIT_BARS
    : UNIT_BARS;
  // 目標を 4 小節単位へ丸め、8 小節単位(半単位あり)の予算にする。
  const units = Math.max(HALF_UNIT_BARS, Math.round(targetBars / HALF_UNIT_BARS) * HALF_UNIT_BARS) / UNIT_BARS;

  const groupings = groupingPlan(style, rng);
  const slots = grammar(units, approachBars, rng);
  const progressionByRole: Record<'development' | 'relief' | 'approach', string | undefined> = {
    development: pickProgression(candidates, UNIT_BARS, startsAwayFromTonic, rng),
    relief: pickProgression(candidates, UNIT_BARS, (progression) => hasBorrowedChord(progression, tonality), rng),
    approach: pickProgression(candidates, approachBars, endsOnDominant, rng),
  };

  const occurrences = new Map<ThemeKey, number>();
  const keyOfLastOccurrence = new Map<ThemeKey, number>();
  const sections: SectionSpec[] = slots.map((item) => {
    const occurrence = occurrences.get(item.theme) ?? 0;
    occurrences.set(item.theme, occurrence + 1);
    const id = item.theme + "'".repeat(occurrence);
    const keyRoot = item.lift ? (defaults.keyRoot + LIFT_SEMITONES) % 12 : defaults.keyRoot;
    const previousKey = keyOfLastOccurrence.get(item.theme);
    keyOfLastOccurrence.set(item.theme, keyRoot);
    const transform: MotifTransform | undefined = occurrence === 0
      ? undefined
      : previousKey !== keyRoot ? 'transpose' : transformForRole(item.role);
    const progressionId = item.texture === 'pulse'
      ? progressionByRole.approach
      : item.role === 'development' ? progressionByRole.development
        : item.role === 'relief' ? progressionByRole.relief
          : undefined;
    // 部分引用は引用元(A)と同じ割り方であること(validateForm)。
    const grouping = item.quoteHook ? groupings.A : groupings[item.theme];
    return {
      id,
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
