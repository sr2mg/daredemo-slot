import { bassDegreesFor } from './bassline.js';
import { resolveCompositionPolicy } from './composition-strategy.js';
import type {
  CompositionPolicy,
  CompositionPremise,
  CompositionStrategy,
  StrategySectionId,
} from './composition-strategy.js';
import {
  RHYTHM_FAMILY_COUNT, barInSection, closesWithCadence, phraseFunctionFor, sectionIndexAt, sectionProgressionId,
  sectionRng, sectionStartBars, sectionTonality, totalBars,
} from './form.js';
import { DEFAULT_GROUPING, gridFor, snapDurationsToPulses } from './grid.js';
import { hasGrooveDevice } from './groove.js';
import type { GrooveFeel } from './groove.js';
import { DEFAULT_MELODIC_LANGUAGE, idiomFor } from './melodic-idiom.js';
import type { MelodicIdiom } from './melodic-idiom.js';
import type { SoundBackendId } from './sound-capabilities.js';
import { sectionProgressionOf } from './harmony-plan.js';
import { CHORDS, PROGRESSIONS, harmonicFunctionForToken } from './theory.js';
import type { ProgressionDef, StyleDef } from './theory.js';
import type {
  BassLinePolicy,
  CadenceType,
  FormPresetId,
  HarmonicFunction,
  HarmonicGoal,
  HarmonyBarPlan,
  IntroBarPlan,
  IntroBassGesture,
  IntroDrumGesture,
  IntroLeadGesture,
  IntroRole,
  JapaneseScaleChoice,
  MelodicLanguage,
  MotifTransform,
  PhraseFunction,
  RhythmVariant,
  SectionBars,
  SectionSpec,
  SongFormPlan,
  SongFormSpec,
  SongIntroPlan,
  SongPlan,
  SongSectionPlan,
  Tonality,
} from './types.js';

export interface TonalOptions {
  tonality?: Tonality;
  melodicLanguage?: MelodicLanguage;
}

export function resolveTonality(options: TonalOptions): Tonality {
  return options.tonality ?? 'major';
}

export function resolveMelodicLanguage(options: TonalOptions): MelodicLanguage {
  return options.melodicLanguage ?? DEFAULT_MELODIC_LANGUAGE;
}

/**
 * プリセット曲型のエネルギー弧。16小節は対比の向き、40小節は4本の弧をシードで選ぶ
 * (明示の区間列は spec.energy をそのまま使う)。
 */
function presetEnergiesFor(
  count: number,
  seed: number,
  policy: CompositionPolicy,
): readonly number[] {
  if (count === 1) return [3];
  if (count === 2) {
    const contrast = (seed >>> 1) % 3;
    return contrast === 0 ? [2, 4] : contrast === 1 ? [4, 2] : [3, 3];
  }
  if (policy.surface.sectionEnergies?.length === count) return policy.surface.sectionEnergies;
  const arcs = [
    [4, 3, 2, 4, 5], // 谷を経てフィナーレへ上げる
    [3, 4, 2, 5, 4], // Dの回帰を頂点にする
    [4, 2, 3, 4, 5], // Bで引き、Cから段階的に戻す
    [3, 5, 2, 4, 5], // BとEに二つの山を作る
  ] as const;
  return arcs[(seed >>> 2) % arcs.length]!;
}

type SectionMotifPlan = Pick<
  SongSectionPlan,
  | 'rhythmVariant'
  | 'phraseRhythmVariants'
  | 'motifSourcePhrases'
  | 'externalMotifPhrases'
  | 'motifSourceSection'
  | 'motifTransform'
  | 'cadenceDegrees'
>;

/** 区間ごとの独立乱数の用途(salt)。区間添字と組で一意のストリームになる。 */
const RNG_SALT = {
  /** フレーズのリズム族と終止音度の物語。 */
  phrase: 0x5048_5253,
} as const;

/**
 * SRDCの反復設計: 変奏反復(restatement)は提示と同じリズム族を使い、フックを
 * リテラルに繰り返す（違いは終止音度だけ＝平行ピリオド）。展開と結論だけ型を替え、
 * 「同じ2小節を4回貼らない」多様性は展開(variant+2/3)と結論(variant+1)で担保する。
 */
function phrasePlanFor(base: RhythmVariant, seed: number, index: number): Pick<
  SongSectionPlan,
  'rhythmVariant' | 'phraseRhythmVariants' | 'motifSourcePhrases' | 'cadenceDegrees'
> {
  const rng = sectionRng(seed, index, RNG_SALT.phrase);
  const variant = (offset: number): RhythmVariant => ((base + offset) % RHYTHM_FAMILY_COUNT) as RhythmVariant;
  const departureVariant = variant(2 + rng.nextInt(2));
  const secondCadence = rng.nextInt(2) === 0 ? 4 : 1;
  return {
    rhythmVariant: base,
    phraseRhythmVariants: [base, base, departureVariant, variant(1)],
    // 結論は必ず提示フレーズ(フック)を引用して閉じる。
    motifSourcePhrases: [0, 0, 2, 0],
    // 3̂ →(5̂|2̂)→ 2̂ → 1̂ の終止音度物語。
    cadenceDegrees: [2, secondCadence, 1, 0],
  };
}

/**
 * 主題の初出区間(帰還の元)。無ければ -1。
 * 直前の同主題区間ではなく初出を元にするのは、変形(移調・反転)を重ねた区間を経由すると
 * リテラル帰還が「変形済みの主題」を返してしまい、フックが原形で戻らないため。
 */
function themeOriginIndex(sections: readonly SectionSpec[], index: number): number {
  const origin = sections.findIndex((candidate) => candidate.theme === sections[index]!.theme);
  return origin >= 0 && origin < index ? origin : -1;
}

/**
 * 主題計画を区間の宣言(theme / transform / quote)から導く。
 * - 初出: 主題の出現順でリズム族を取り、自分の主題を提示する。
 * - 再登場: 主題の初出区間を元に transform で区間全体を作り直す(フレーズ0の借用)。
 *   literal は元区間のフレーズ0のリズム族も継ぎ、フックをリズムごと鳴らす。
 * - 部分引用(quote): 主題は自分のまま、指定フレーズだけ元区間から借りる。
 * 上位戦略(arc40 限定)の不在・帰還・継続イベントは、この導出結果へ上書きする。
 */
function motifPlansFor(
  sections: readonly SectionSpec[],
  seed: number,
  policy: CompositionPolicy,
): SectionMotifPlan[] {
  const themeOrder: string[] = [];
  const occurrences = new Map<string, number>();
  const plans: SectionMotifPlan[] = [];
  const inheritRhythm = (
    plan: SectionMotifPlan,
    source: SectionMotifPlan,
    phrases: readonly (0 | 1 | 2 | 3)[],
  ): SectionMotifPlan => {
    const variants = [...plan.phraseRhythmVariants] as [RhythmVariant, RhythmVariant, RhythmVariant, RhythmVariant];
    for (const phrase of phrases) {
      variants[phrase] = source.phraseRhythmVariants[source.motifSourcePhrases[phrase]]!;
    }
    return { ...plan, phraseRhythmVariants: variants };
  };
  sections.forEach((spec, index) => {
    if (!themeOrder.includes(spec.theme)) themeOrder.push(spec.theme);
    const themeIndex = themeOrder.indexOf(spec.theme);
    const occurrence = occurrences.get(spec.theme) ?? 0;
    occurrences.set(spec.theme, occurrence + 1);
    const base = ((themeIndex + occurrence) % RHYTHM_FAMILY_COUNT) as RhythmVariant;
    let plan: SectionMotifPlan = {
      ...phrasePlanFor(base, seed, index),
      externalMotifPhrases: [],
      motifSourceSection: null,
      motifTransform: 'original',
    };
    const absent = policy.motif.absenceSections.includes(spec.id as StrategySectionId);
    const sourceIndex = themeOriginIndex(sections, index);
    if (!absent && sourceIndex >= 0) {
      const transform: MotifTransform = spec.transform ?? 'literal';
      if (transform === 'literal' || transform === 'transpose' || transform === 'invert') {
        plan = {
          ...plan,
          externalMotifPhrases: [0],
          motifSourceSection: sections[sourceIndex]!.id,
          motifTransform: transform,
        };
        if (transform === 'literal') plan = inheritRhythm(plan, plans[sourceIndex]!, [0]);
      } else {
        plan = { ...plan, motifTransform: 'contrast' };
      }
    } else if (!absent && spec.quote) {
      const quoteIndex = sections.findIndex((candidate) => candidate.id === spec.quote!.from);
      if (quoteIndex >= 0 && quoteIndex < index) {
        const transform: MotifTransform = spec.quote.transform ?? 'literal';
        plan = {
          ...plan,
          externalMotifPhrases: [...spec.quote.phrases],
          motifSourceSection: spec.quote.from,
          motifTransform: transform,
        };
        if (transform === 'literal') plan = inheritRhythm(plan, plans[quoteIndex]!, spec.quote.phrases);
      }
    } else if (absent) {
      plan = { ...plan, motifTransform: 'contrast' };
    }
    // ポリシーの意味イベントを区間IDへ解決する。下流は戦略名を知らない。
    for (const event of [policy.motif.returnEvent, policy.motif.continuationEvent]) {
      if (!event || event.to !== spec.id) continue;
      const eventSourceIndex = sections.findIndex((candidate) => candidate.id === event.from);
      if (eventSourceIndex < 0 || eventSourceIndex >= index) continue;
      plan = {
        ...plan,
        externalMotifPhrases: [...event.phrases],
        motifSourceSection: event.from,
        motifTransform: event.transform,
        // 変奏反復まで借りる帰還は、提示と変奏反復をそれぞれ元のフレーズから継ぐ。
        motifSourcePhrases: event.phrases.includes(1) ? [0, 1, 2, 0] : plan.motifSourcePhrases,
      };
      if (event === policy.motif.returnEvent) plan = inheritRhythm(plan, plans[eventSourceIndex]!, event.phrases);
    }
    plans.push(plan);
  });
  return plans;
}

/**
 * 終止の種類。答句(区間内の奇数小節)だけが終止を持つ。曲の最終小節はループなら
 * ターンアラウンド、終止曲型なら完全終止。区間の最終小節は半終止/開放終止、
 * 結論フレーズは機能に応じて閉じる。
 */
function cadenceFor(
  offsetInSection: number,
  isLastBar: boolean,
  isSectionLastBar: boolean,
  ending: SongFormSpec['ending'],
  phraseFunction: PhraseFunction,
  exitFunction: HarmonicFunction,
): CadenceType | null {
  if (offsetInSection % 2 === 0) return null;
  if (isLastBar) return ending === 'loop' ? 'turnaround' : 'closed';
  if (isSectionLastBar) return exitFunction === 'dominant' ? 'half' : 'open';
  if (phraseFunction !== 'conclusion') return 'open';
  return exitFunction === 'tonic' ? 'closed' : exitFunction === 'dominant' ? 'half' : 'open';
}

function harmonicGoalFor(
  isLastBar: boolean,
  ending: SongFormSpec['ending'],
  phraseFunction: PhraseFunction,
): HarmonicGoal {
  if (isLastBar) return ending === 'loop' ? 'turnaround' : 'resolve';
  if (phraseFunction === 'statement') return 'establish';
  if (phraseFunction === 'restatement') return 'continue';
  if (phraseFunction === 'departure') return 'depart';
  return 'resolve';
}

/**
 * 2コード小節の変化位置を機能で決める。
 * 終止は後半ドミナントを最後の1拍へ集め、展開は新機能へ早めに入る。
 */
function durationsFor(
  tokens: readonly string[],
  goal: HarmonicGoal,
  policy: CompositionPolicy,
): number[] {
  if (tokens.length !== 2) return tokens.map(() => 4 / tokens.length);
  const first = harmonicFunctionForToken(tokens[0]!);
  const second = harmonicFunctionForToken(tokens[1]!);
  if (policy.harmony.delayResolution && goal === 'resolve' && second === 'tonic' && first !== 'tonic') {
    return [3, 1];
  }
  if ((goal === 'turnaround' || goal === 'resolve') && second === 'dominant') return [3, 1];
  if (goal === 'depart' && second !== first) return [1, 3];
  if (goal === 'resolve' && second === 'tonic' && first !== 'tonic') return [1, 3];
  return [2, 2];
}

/**
 * 終止曲型の最終小節: 進行のスロットに頼らず、調性から V→I(短調は V7→i)を導く。
 * スロット末尾にトニックの選択肢を持たない進行が半数あるため探索はしない
 * (イントロの接近和音 approachTokenFor と同じ導出法)。
 */
export function finalCadenceTokens(tonality: Tonality): string[] {
  return tonality === 'minor' ? ['V7m', 'i'] : ['V', 'I'];
}

type ProgressionSlot = ProgressionDef['slots'][number];

function clampedChoiceIndex(slot: ProgressionSlot, requested: number | undefined): number {
  return Math.max(0, Math.min(slot.length - 1, requested ?? 0));
}

/** 同じ進行スロット内で、トニックを避け未解決の引力が強い候補を選ぶ。 */
function absenceChoiceIndex(
  slot: ProgressionSlot,
  baseIndex: number,
  seed: number,
  bar: number,
): number {
  if (slot.length <= 1) return baseIndex;
  const score = (option: readonly string[]): number => {
    const functions = option.map(harmonicFunctionForToken);
    const body = functions.reduce((total, harmonicFunction) => total + (
      harmonicFunction === 'tonic' ? -4
        : harmonicFunction === 'dominant' ? 3
          : harmonicFunction === 'predominant' ? 2 : 1
    ), 0);
    return body + (functions.at(-1) === 'dominant' ? 2 : 0);
  };
  const scores = slot.map(score);
  const best = Math.max(...scores);
  const candidates = scores
    .map((candidateScore, index) => ({ candidateScore, index }))
    .filter(({ candidateScore }) => candidateScore === best)
    .map(({ index }) => index);
  const alternatives = candidates.filter((index) => index !== baseIndex);
  const pool = alternatives.length > 0 ? alternatives : candidates;
  return pool[((seed ^ (bar * 0x45d9_f3b)) >>> 0) % pool.length]!;
}

export interface CreateSongPlanOptions {
  /** 解決済みの曲型(プリセットは展開済み)。 */
  form: SongFormSpec;
  /** プリセット参照なら id。エネルギー弧のシード揺らぎと上位戦略(arc40 限定)が読む。 */
  presetId: FormPresetId | null;
  seed: number;
  /** 曲既定の調(区間指定が無い区間で使う)。0..11 に正規化済み。 */
  keyRoot: number;
  tonality: Tonality;
  melodicLanguage: MelodicLanguage;
  /** 語法の宣言(区間ごとの音組織・核音計画を調へ写す)。 */
  idiom: MelodicIdiom;
  japaneseScale?: JapaneseScaleChoice | undefined;
  grooveFeel: GrooveFeel;
  soundChip: SoundBackendId;
  /** 曲既定の進行(調性へ実現済み)。区間の progressionId が無い区間で使う。 */
  progression: ProgressionDef;
  style: StyleDef;
  choice: readonly number[];
  /** 初回専用の2小節イントロを使うか(曲型の既定とユーザー指定を compose が解決済み)。 */
  intro: boolean;
  compositionStrategy?: CompositionStrategy;
  /**
   * ベースライン生成器(bassline.ts)のポリシー。'on' は harmony の各小節へ
   * bassDegrees(分数コード)を書く。composeがスタイル既定とオプションを解決して渡す。
   */
  bassLine?: BassLinePolicy;
}

function uniqueIntroRoles(roles: readonly IntroRole[]): IntroRole[] {
  return [...new Set(roles)];
}

/** 曲調・拍節・旋律密度・Aの和声機能から候補を絞り、シードは同格候補の選択だけに使う。 */
function introRoleFor(
  options: CreateSongPlanOptions,
  entryFunction: HarmonicFunction,
  harmonicActivity: number,
): IntroRole {
  if (options.progression.id === 'fanfare') {
    return ((options.seed >>> 2) & 1) === 0 ? 'fanfare' : 'motif';
  }
  const density = (options.style.melody.density[0] + options.style.melody.density[1]) / 2;
  const candidates: IntroRole[] = [];
  const styleIntroRoles = options.style.texture.introRoles ?? [];
  if (hasGrooveDevice(options.grooveFeel) || styleIntroRoles.includes('groove')) candidates.push('groove');
  if (styleIntroRoles.includes('fanfare')) candidates.push('fanfare');
  if (styleIntroRoles.includes('runup') || entryFunction === 'dominant') candidates.push('runup');
  if (idiomFor(options.melodicLanguage).introPrefersMotif || harmonicActivity > 0 || density <= 5.5) {
    candidates.push('motif');
  }
  const compatible = uniqueIntroRoles([...candidates, 'motif']);
  return compatible[((options.seed ^ 0x494e_5452) >>> 0) % compatible.length]!;
}

/** イントロがA冒頭のコードへ受け渡すための接近和音。exportはテストの等価性固定用。 */
export function approachTokenFor(entryToken: string, tonality: Tonality): string {
  const entryFunction = harmonicFunctionForToken(entryToken);
  if (entryFunction === 'tonic') return tonality === 'minor' ? 'V7m' : 'V';
  if (entryFunction === 'dominant') return tonality === 'minor' ? 'iv' : 'IV';
  if (entryFunction === 'predominant') {
    // 接近はトークン名でなく度数メタデータで決める（IVadd9 等の新語彙にもそのまま効く）。
    // IV系(root=5)はそのセカンダリードミナントI7(V/IV)、ii系(root=2)は五度上のvi/VIから入る。
    const entryRoot = CHORDS[entryToken]?.root;
    if (tonality === 'major' && entryRoot === 5) return 'I7';
    if (tonality === 'major' && entryRoot === 2) return 'vi';
    if (tonality === 'minor' && entryRoot === 2) return 'VI';
    return tonality === 'minor' ? 'i' : 'I';
  }
  return tonality === 'minor' ? 'V7m' : 'V';
}

function introBreakFor(role: IntroRole, language: MelodicLanguage): number {
  if (role === 'motif') return idiomFor(language).motifIntroBreakBeats;
  if (role === 'fanfare') return 1;
  return 0;
}

function introPlanFor(
  options: CreateSongPlanOptions,
  harmony: readonly HarmonyBarPlan[],
  harmonicActivity: number,
): SongIntroPlan {
  const entryBar = harmony[0]!;
  const entryToken = entryBar.tokens[0]!;
  const entryFunction = harmonicFunctionForToken(entryToken);
  if (!options.intro) {
    return { enabled: false, bars: 0, role: null, entryToken, entryFunction, breakBeats: 0, barPlans: [] };
  }

  // イントロは先頭区間の調で作る(本編冒頭の和音へ接続するため)。
  const tonality = entryBar.tonality;
  const role = introRoleFor(options, entryFunction, harmonicActivity);
  const breakBeats = introBreakFor(role, options.melodicLanguage);
  const tonic = tonality === 'minor' ? 'i' : 'I';
  const predominant = tonality === 'minor' ? 'iv' : 'IV';
  const approach = approachTokenFor(entryToken, tonality);
  const secondBarDuration = 4 - breakBeats;
  const firstTokens = role === 'motif'
    ? [entryToken]
    : role === 'fanfare' ? [tonic, predominant] : [tonic];
  const firstDurations = firstTokens.length === 2 ? [2, 2] : [4];
  const useTwoStepFanfare = role === 'fanfare' && approach !== predominant;
  const secondTokens = useTwoStepFanfare ? [predominant, approach] : [approach];
  const secondDurations = useTwoStepFanfare
    ? [1, secondBarDuration - 1]
    : [secondBarDuration];

  const gestures: Record<IntroRole, readonly [
    Pick<IntroBarPlan, 'leadGesture' | 'bassGesture' | 'drumGesture' | 'energy'>,
    Pick<IntroBarPlan, 'leadGesture' | 'bassGesture' | 'drumGesture' | 'energy'>,
  ]> = {
    motif: [
      { leadGesture: 'motifFragment', bassGesture: 'pedal', drumGesture: 'none', energy: 2 },
      { leadGesture: 'motifAnswer', bassGesture: 'pickup', drumGesture: 'none', energy: 3 },
    ],
    groove: [
      { leadGesture: 'rest', bassGesture: 'groove', drumGesture: 'groove', energy: 2 },
      { leadGesture: 'pickup', bassGesture: 'stopForLead', drumGesture: 'fill', energy: 4 },
    ],
    fanfare: [
      { leadGesture: 'fanfareCall', bassGesture: 'hits', drumGesture: 'accents', energy: 4 },
      { leadGesture: 'fanfareAnswer', bassGesture: 'hits', drumGesture: 'fill', energy: 5 },
    ],
    runup: [
      { leadGesture: 'heldCall', bassGesture: 'pedal', drumGesture: 'none', energy: 2 },
      { leadGesture: 'scaleRun', bassGesture: 'pickup', drumGesture: 'countIn', energy: 5 },
    ],
  };
  return {
    enabled: true,
    bars: 2,
    role,
    entryToken,
    entryFunction,
    breakBeats,
    barPlans: [
      {
        bar: 0, goal: 'identity', tokens: firstTokens, durations: firstDurations,
        ...gestures[role][0],
      },
      {
        bar: 1, goal: 'transition', tokens: secondTokens, durations: secondDurations,
        ...gestures[role][1],
      },
    ],
  };
}

/** クライマックス小節: 先頭以外(2区間以下なら全区間)の最大エネルギー区間の中盤。 */
function climaxBarFor(sections: readonly SongSectionPlan[], seed: number): number {
  const lateClimax = (seed & 1) === 1;
  // 旋律を持たない区間(ロングトーン・パワーコード)は頂点を置けない。
  const melodic = (sections.length > 2 ? sections.slice(1) : sections).filter((section) => section.texture === 'normal');
  const candidates = melodic.length > 0 ? melodic : sections.length > 2 ? sections.slice(1) : sections;
  const peakEnergy = Math.max(...candidates.map((section) => section.energy));
  const peaks = candidates.filter((section) => section.energy === peakEnergy);
  const peak = peaks[(seed >>> 10) % peaks.length]!;
  const offset = peak.bars === 4 ? (lateClimax ? 3 : 2) : lateClimax ? 6 : 4;
  return peak.startBar + offset;
}

/**
 * 区間の進行: 区間指定(progressionId)を区間の調性へ実現する。無ければ曲既定。
 * 解決は harmony-plan の sectionProgressionOf(レシピ・UI と同じ)で、ここでは不正を throw にする。
 */
function sectionProgressionFor(
  spec: SectionSpec,
  tonality: Tonality,
  options: CreateSongPlanOptions,
): ProgressionDef {
  const progressionId = sectionProgressionId(spec, { progressionId: options.progression.id });
  const base = progressionId === options.progression.id
    ? options.progression
    : PROGRESSIONS.find((candidate) => candidate.id === progressionId);
  if (!base) throw new Error(`[${spec.id}] 未知の進行: ${progressionId}`);
  const realized = sectionProgressionOf(options.progression, { ...spec, tonality });
  if (!realized) {
    throw new Error(`[${spec.id}] ${tonality === 'minor' ? '短調' : '長調'}では進行「${base.name}」を使用できません`);
  }
  if (realized.slots.length > spec.bars) {
    throw new Error(`[${spec.id}] 進行(${realized.slots.length}小節)が区間(${spec.bars}小節)より長い`);
  }
  return realized;
}

export function createSongPlan(options: CreateSongPlanOptions): SongPlan {
  const { form, presetId, seed, progression, style, idiom } = options;
  const bars = totalBars(form);
  const compositionStrategy = options.compositionStrategy ?? 'current';
  const compositionPolicy = resolveCompositionPolicy(compositionStrategy, presetId === 'arc40', seed);
  const count = form.sections.length;
  const starts = sectionStartBars(form);
  // プリセットのエネルギー弧はシードで揺らす(16小節の対比の向き、40小節の4本の弧)。
  // 明示の区間列は宣言どおり。
  const presetEnergies = presetId === 'loop16' || presetId === 'arc40'
    ? presetEnergiesFor(count, seed, compositionPolicy)
    : null;
  const motifPlans = motifPlansFor(form.sections, seed, compositionPolicy);
  const sectionProgressions: ProgressionDef[] = [];
  const sections: SongSectionPlan[] = form.sections.map((spec, index) => {
    const keyRoot = (((spec.keyRoot ?? options.keyRoot) % 12) + 12) % 12;
    const tonality = sectionTonality(spec, { tonality: options.tonality });
    const sectionProgression = sectionProgressionFor(spec, tonality, options);
    sectionProgressions.push(sectionProgression);
    const japanesePlan = idiom.culturalPlan(keyRoot, options.japaneseScale, seed);
    const scalePcs = japanesePlan?.scalePcs
      ?? idiom.scaleIntervals(tonality).map((interval) => (interval + keyRoot) % 12);
    return {
      index,
      id: spec.id,
      startBar: starts[index]!,
      bars: spec.bars,
      role: spec.role,
      energy: presetEnergies?.[index] ?? spec.energy,
      theme: spec.theme,
      keyRoot,
      tonality,
      scalePcs,
      japanesePlan,
      progressionId: sectionProgression.id,
      progressionBars: sectionProgression.slots.length,
      grouping: spec.grouping ?? DEFAULT_GROUPING,
      texture: spec.texture ?? 'normal',
      accompaniment: spec.accompaniment ?? 'auto',
      ...motifPlans[index]!,
    };
  });
  const climaxBar = climaxBarFor(sections, seed);

  const slotAt = (bar: number): ProgressionSlot => {
    const sectionProgression = sectionProgressions[sectionIndexAt(form, bar)]!;
    const offset = barInSection(form, bar);
    return sectionProgression.slots[offset % sectionProgression.slots.length]!;
  };
  const baseChoices = Array.from({ length: bars }, (_, bar) => (
    clampedChoiceIndex(slotAt(bar), options.choice[bar])
  ));
  const sectionById = new Map(sections.map((section) => [section.id as StrategySectionId, section]));
  const harmony: HarmonyBarPlan[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const sectionIndex = sectionIndexAt(form, bar);
    const section = sections[sectionIndex]!;
    const offset = bar - section.startBar;
    const slot = slotAt(bar);
    let selected = baseChoices[bar]!;
    let strategyRole: HarmonyBarPlan['strategyRole'] = 'base';
    if (
      compositionPolicy.harmony.avoidTonicDuringAbsence
      && section.id === compositionPolicy.harmony.absenceSection
    ) {
      selected = absenceChoiceIndex(slot, selected, seed, bar);
      strategyRole = 'absence';
    }
    const harmonicReturn = compositionPolicy.harmony.returnEvent;
    if (harmonicReturn && section.id === harmonicReturn.to) {
      const sourceSection = sectionById.get(harmonicReturn.from);
      if (sourceSection) {
        const sourceBar = sourceSection.startBar + (offset % sourceSection.bars);
        selected = clampedChoiceIndex(slot, baseChoices[sourceBar]);
        strategyRole = 'return';
      }
    }
    const isLastBar = bar === bars - 1;
    const finalCadence = isLastBar && closesWithCadence(form.ending);
    const tokens = finalCadence ? finalCadenceTokens(section.tonality) : [...slot[selected]!];
    const phraseFunction = phraseFunctionFor(offset, section.bars as SectionBars);
    const harmonicGoal = harmonicGoalFor(isLastBar, form.ending, phraseFunction);
    const entryFunction = harmonicFunctionForToken(tokens[0]!);
    const exitFunction = harmonicFunctionForToken(tokens.at(-1)!);
    const localEnergy = [0, 1, 1, 0][Math.floor((offset % 8) / 2)]!;
    harmony.push({
      bar,
      section: section.id,
      keyRoot: section.keyRoot,
      tonality: section.tonality,
      phraseFunction,
      harmonicGoal,
      tokens,
      // 終止曲型の V→I は半小節ずつ(属和音を1拍に押し込まず、終止として聴かせる)。
      // 長さ列は区間の格子の拍頭へ吸着する(3x4 では [2,2]→[8/3,4/3] など。4x2/4x3 では恒等)。
      durations: snapDurationsToPulses(
        gridFor(section.grouping),
        finalCadence ? [2, 2] : durationsFor(tokens, harmonicGoal, compositionPolicy),
      ),
      strategyRole,
      entryFunction,
      exitFunction,
      cadence: cadenceFor(
        offset, isLastBar, offset === section.bars - 1, form.ending, phraseFunction, exitFunction,
      ),
      energy: bar === climaxBar ? 5 : Math.max(1, Math.min(4, section.energy + localEnergy - 1)),
    });
  }

  if (options.bassLine === 'on') {
    // ベースライン生成器はコード列確定後に一括で走らせる(先読みが要る大域最適化のため)。
    // 乱数は消費しないので、他声部の生成順・シード消費には影響しない。
    bassDegreesFor(harmony, { loop: form.ending === 'loop' }).forEach((bassDegrees, bar) => {
      if (bassDegrees) harmony[bar] = { ...harmony[bar]!, bassDegrees };
    });
  }

  const harmonicActivity = harmony.filter((bar) => bar.tokens.length > 1).length / bars;
  const formPlan: SongFormPlan = { spec: form, presetId, sections, climaxBar, ending: form.ending };
  return {
    compositionStrategy,
    compositionPolicy,
    premise: compositionPolicy.premise,
    tonality: options.tonality,
    melodicLanguage: options.melodicLanguage,
    grooveFeel: options.grooveFeel,
    styleId: style.id,
    progressionId: progression.id,
    soundChip: options.soundChip,
    intro: introPlanFor(options, harmony, harmonicActivity),
    form: formPlan,
    harmony,
    melodyDensity: (style.melody.density[0] + style.melody.density[1]) / 2,
    harmonicActivity,
  };
}
