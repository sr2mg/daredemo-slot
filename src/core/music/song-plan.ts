import type {
  CadenceType,
  ComposeBars,
  GrooveFeel,
  IntroRole,
  MelodyMode,
  MelodicLanguage,
  PhraseFunction,
  PhraseSection,
  Tonality,
} from './compose.js';
import { harmonicFunctionForToken } from './theory.js';
import type { HarmonicFunction, ProgressionDef, StyleDef } from './theory.js';

export type HarmonicGoal = 'establish' | 'continue' | 'depart' | 'resolve' | 'turnaround';
export type SectionRole = 'hook' | 'development' | 'relief' | 'return' | 'finale';
export type MotifTransform = 'original' | 'transpose' | 'invert' | 'contrast';
export type RhythmVariant = 0 | 1 | 2 | 3 | 4;
export type IntroLeadGesture =
  | 'motifFragment'
  | 'motifAnswer'
  | 'rest'
  | 'pickup'
  | 'fanfareCall'
  | 'fanfareAnswer'
  | 'heldCall'
  | 'scaleRun';
export type IntroBassGesture = 'pedal' | 'groove' | 'stopForLead' | 'hits' | 'pickup';
export type IntroDrumGesture = 'none' | 'groove' | 'accents' | 'fill' | 'countIn';

export interface IntroBarPlan {
  bar: 0 | 1;
  goal: 'identity' | 'transition';
  tokens: readonly string[];
  /** 合計が4拍未満なら、残りはAを迎える全パート共通のブレイク。 */
  durations: readonly number[];
  leadGesture: IntroLeadGesture;
  bassGesture: IntroBassGesture;
  drumGesture: IntroDrumGesture;
  energy: number;
}

/** 本編を生成する前に確定する、初回専用の2小節トランジション。 */
export interface SongIntroPlan {
  enabled: boolean;
  bars: 0 | 2;
  role: IntroRole | null;
  /** イントロが最終的に受け渡すA冒頭のコード。 */
  entryToken: string;
  entryFunction: HarmonicFunction;
  /** A直前に全声部を止める長さ。役割ごとに0〜1.5拍を使い分ける。 */
  breakBeats: number;
  barPlans: readonly IntroBarPlan[];
}

export interface SongSectionPlan {
  index: number;
  id: PhraseSection;
  startBar: number;
  bars: number;
  role: SectionRole;
  /** 1..5。編成密度ではなく、曲として目指す相対エネルギー。 */
  energy: number;
  /** 0..4。同じリズム型を全セクションへ貼らないためのモチーフ変奏族。 */
  rhythmVariant: RhythmVariant;
  /** 提示・変奏反復・展開・結論ごとのリズム族。区間内も同じ2小節を貼り続けない。 */
  phraseRhythmVariants: readonly [RhythmVariant, RhythmVariant, RhythmVariant, RhythmVariant];
  /** 各フレーズが参照する同区間／参照先区間のフレーズ番号。 */
  motifSourcePhrases: readonly [0 | 1 | 2 | 3, 0 | 1 | 2 | 3, 0 | 1 | 2 | 3, 0 | 1 | 2 | 3];
  /** 外部区間から借りるフレーズ。1要素=2小節だけに絞り、区間全体の複製を避ける。 */
  externalMotifPhrases: readonly (0 | 1 | 2 | 3)[];
  /** externalMotifPhrasesが参照する区間。nullなら全フレーズを区間内で展開する。 */
  motifSourceSection: PhraseSection | null;
  /** 参照モチーフをそのまま複製せず、区間の役割に応じて変形する。 */
  motifTransform: MotifTransform;
}

export interface HarmonyBarPlan {
  bar: number;
  section: PhraseSection;
  phraseFunction: PhraseFunction;
  harmonicGoal: HarmonicGoal;
  /** ユーザーが選んだ進行レシピを、フォーム上の役割と一緒に確定したもの。 */
  tokens: readonly string[];
  /** tokens と同じ順。コード変化位置はフレーズ目的とコード機能から決める。 */
  durations: readonly number[];
  entryFunction: HarmonicFunction;
  exitFunction: HarmonicFunction;
  cadence: CadenceType | null;
  energy: number;
}

export interface SongFormPlan {
  sections: readonly SongSectionPlan[];
  climaxBar: number;
  loopCadence: 'turnaround';
}

/** 各声部を生成する前に確定する、曲全体の単一の設計図。 */
export interface SongPlan {
  tonality: Tonality;
  melodicLanguage: MelodicLanguage;
  grooveFeel: GrooveFeel;
  styleId: string;
  progressionId: string;
  /** 進行カタログ自体の長さ。4小節進行を長尺化した際の反復診断に使う。 */
  progressionBars: number;
  soundChip: 'opll' | 'nes2a03';
  intro: SongIntroPlan;
  form: SongFormPlan;
  harmony: readonly HarmonyBarPlan[];
  /** スタイル固有の主旋律音数。編成が旋律の混み具合を判断するために共有する。 */
  melodyDensity: number;
  /** 1小節に複数コードを置く小節の比率。 */
  harmonicActivity: number;
}

export interface TonalOptions {
  tonality?: Tonality;
  melodicLanguage?: MelodicLanguage;
  /** v1保存曲との互換入力。新規UIでは使わない。 */
  melodyMode?: MelodyMode;
}

export function resolveTonality(options: TonalOptions): Tonality {
  return options.tonality ?? (options.melodyMode === 'minor' ? 'minor' : 'major');
}

export function resolveMelodicLanguage(options: TonalOptions): MelodicLanguage {
  return options.melodicLanguage ?? (options.melodyMode === 'japanese' ? 'japanese' : 'standard');
}

/** Pieceの旧フィールドを埋めるための互換表現。minor+japanese は和風を優先する。 */
export function legacyMelodyMode(tonality: Tonality, language: MelodicLanguage): MelodyMode {
  return language === 'japanese' ? 'japanese' : tonality;
}

/** 4小節では1小節ずつ、8小節以上では2小節ずつSRDCへ割り当てる。 */
export function phraseFunctionFor(bar: number, bars: ComposeBars): PhraseFunction {
  const functions: readonly PhraseFunction[] = ['statement', 'restatement', 'departure', 'conclusion'];
  if (bars === 4) return functions[bar]!;
  const barInSection = bars >= 16 ? bar % 8 : bar;
  return functions[Math.min(3, Math.floor(barInSection / 2))]!;
}

function sectionCountFor(bars: ComposeBars): number {
  return bars === 40 ? 5 : bars === 16 ? 2 : 1;
}

function sectionRoleFor(index: number, count: number): SectionRole {
  if (count === 1) return 'hook';
  if (count === 2) return index === 0 ? 'hook' : 'development';
  return (['hook', 'development', 'relief', 'return', 'finale'] as const)[index]!;
}

function sectionEnergiesFor(count: number, seed: number): readonly number[] {
  if (count === 1) return [3];
  if (count === 2) {
    const contrast = (seed >>> 1) % 3;
    return contrast === 0 ? [2, 4] : contrast === 1 ? [4, 2] : [3, 3];
  }
  const arcs = [
    [4, 3, 2, 4, 5], // 谷を経てフィナーレへ上げる
    [3, 4, 2, 5, 4], // Dの回帰を頂点にする
    [4, 2, 3, 4, 5], // Bで引き、Cから段階的に戻す
    [3, 5, 2, 4, 5], // BとEに二つの山を作る
  ] as const;
  return arcs[(seed >>> 2) % arcs.length]!;
}

function sectionMotifPlanFor(index: number, count: number, seed: number): Pick<
  SongSectionPlan,
  | 'rhythmVariant'
  | 'phraseRhythmVariants'
  | 'motifSourcePhrases'
  | 'externalMotifPhrases'
  | 'motifSourceSection'
  | 'motifTransform'
> {
  const phrasePlan = (base: RhythmVariant, salt: number): Pick<
    SongSectionPlan,
    'rhythmVariant' | 'phraseRhythmVariants' | 'motifSourcePhrases'
  > => {
    const variant = (offset: number): RhythmVariant => ((base + offset) % 5) as RhythmVariant;
    return {
      rhythmVariant: base,
      phraseRhythmVariants: [
        base,
        ((seed >>> salt) & 1) === 0 ? base : variant(1),
        variant(2 + ((seed >>> (salt + 1)) & 1)),
        ((seed >>> (salt + 2)) & 1) === 0 ? base : variant(1),
      ],
      motifSourcePhrases: [0, 0, 2, ((seed >>> (salt + 3)) & 1) === 0 ? 0 : 1],
    };
  };
  if (count === 1) return {
    ...phrasePlan(0, 3), externalMotifPhrases: [], motifSourceSection: null, motifTransform: 'original',
  };
  if (count === 2) return index === 0
    ? {
      ...phrasePlan(0, 3), externalMotifPhrases: [], motifSourceSection: null, motifTransform: 'original',
    }
    : {
      ...phrasePlan(1, 7), externalMotifPhrases: [], motifSourceSection: null, motifTransform: 'contrast',
    };
  const bVariant = (1 + ((seed >>> 3) % 2)) as 1 | 2;
  const dVariant = ((seed >>> 4) & 1) === 0 ? 0 : 1;
  const eVariant = (3 + ((seed >>> 5) & 1)) as 3 | 4;
  const plans = [
    {
      ...phrasePlan(0, 3), externalMotifPhrases: [], motifSourceSection: null, motifTransform: 'original',
    },
    {
      ...phrasePlan(bVariant, 7), externalMotifPhrases: [0], motifSourceSection: 'A',
      motifTransform: ((seed >>> 6) & 1) === 0 ? 'transpose' : 'invert',
    },
    {
      ...phrasePlan(3, 11), externalMotifPhrases: [], motifSourceSection: null, motifTransform: 'contrast',
    },
    {
      ...phrasePlan(dVariant, 15), externalMotifPhrases: [0], motifSourceSection: 'A',
      motifTransform: ((seed >>> 7) & 1) === 0 ? 'transpose' : 'invert',
    },
    {
      ...phrasePlan(eVariant, 19),
      externalMotifPhrases: [0],
      motifSourceSection: ((seed >>> 8) & 1) === 0 ? 'B' : 'D',
      motifTransform: ((seed >>> 9) & 1) === 0 ? 'invert' : 'transpose',
    },
  ] satisfies Array<Pick<
    SongSectionPlan,
    | 'rhythmVariant'
    | 'phraseRhythmVariants'
    | 'motifSourcePhrases'
    | 'externalMotifPhrases'
    | 'motifSourceSection'
    | 'motifTransform'
  >>;
  return plans[index]!;
}

function cadenceFor(
  bar: number,
  bars: ComposeBars,
  phraseFunction: PhraseFunction,
  exitFunction: HarmonicFunction,
): CadenceType | null {
  const barInSection = bars >= 16 ? bar % 8 : bar;
  if (barInSection % 2 === 0) return null;
  if (bar === bars - 1) return 'turnaround';
  if (barInSection === 7) return exitFunction === 'dominant' ? 'half' : 'open';
  if (phraseFunction !== 'conclusion') return 'open';
  return exitFunction === 'tonic' ? 'closed' : exitFunction === 'dominant' ? 'half' : 'open';
}

function harmonicGoalFor(
  bar: number,
  bars: ComposeBars,
  phraseFunction: PhraseFunction,
): HarmonicGoal {
  if (bar === bars - 1) return 'turnaround';
  if (phraseFunction === 'statement') return 'establish';
  if (phraseFunction === 'restatement') return 'continue';
  if (phraseFunction === 'departure') return 'depart';
  return 'resolve';
}

/**
 * 2コード小節の変化位置を機能で決める。
 * 終止は後半ドミナントを最後の1拍へ集め、展開は新機能へ早めに入る。
 */
function durationsFor(tokens: readonly string[], goal: HarmonicGoal): number[] {
  if (tokens.length !== 2) return tokens.map(() => 4 / tokens.length);
  const first = harmonicFunctionForToken(tokens[0]!);
  const second = harmonicFunctionForToken(tokens[1]!);
  if ((goal === 'turnaround' || goal === 'resolve') && second === 'dominant') return [3, 1];
  if (goal === 'depart' && second !== first) return [1, 3];
  if (goal === 'resolve' && second === 'tonic' && first !== 'tonic') return [1, 3];
  return [2, 2];
}

export interface CreateSongPlanOptions {
  bars: ComposeBars;
  seed: number;
  tonality: Tonality;
  melodicLanguage: MelodicLanguage;
  grooveFeel: GrooveFeel;
  soundChip: 'opll' | 'nes2a03';
  progression: ProgressionDef;
  style: StyleDef;
  choice: readonly number[];
  /** 16/40小節フォームで初回専用イントロを使うか。省略時は有効。 */
  intro?: boolean;
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
  if (options.grooveFeel !== 'straight' || options.style.id === 'ska') candidates.push('groove');
  if (options.style.id === 'rock') candidates.push('fanfare');
  if (options.style.id === 'eurobeat' || entryFunction === 'dominant') candidates.push('runup');
  if (options.melodicLanguage === 'japanese' || harmonicActivity > 0 || density <= 5.5) candidates.push('motif');
  const compatible = uniqueIntroRoles([...candidates, 'motif']);
  return compatible[((options.seed ^ 0x494e_5452) >>> 0) % compatible.length]!;
}

function approachTokenFor(entryToken: string, tonality: Tonality): string {
  const entryFunction = harmonicFunctionForToken(entryToken);
  if (entryFunction === 'tonic') return tonality === 'minor' ? 'V7m' : 'V';
  if (entryFunction === 'dominant') return tonality === 'minor' ? 'iv' : 'IV';
  if (entryFunction === 'predominant') {
    if (tonality === 'major' && ['IV', 'IVM7'].includes(entryToken)) return 'I7';
    if (tonality === 'major' && ['ii', 'ii7'].includes(entryToken)) return 'vi';
    if (tonality === 'minor' && entryToken === 'iiDim') return 'VI';
    return tonality === 'minor' ? 'i' : 'I';
  }
  return tonality === 'minor' ? 'V7m' : 'V';
}

function introBreakFor(role: IntroRole, language: MelodicLanguage): number {
  if (role === 'motif') return language === 'japanese' ? 1.5 : 0.5;
  if (role === 'fanfare') return 1;
  return 0;
}

function introPlanFor(
  options: CreateSongPlanOptions,
  harmony: readonly HarmonyBarPlan[],
  harmonicActivity: number,
): SongIntroPlan {
  const entryToken = harmony[0]!.tokens[0]!;
  const entryFunction = harmonicFunctionForToken(entryToken);
  const enabled = (options.bars === 16 || options.bars === 40) && options.intro !== false;
  if (!enabled) {
    return { enabled: false, bars: 0, role: null, entryToken, entryFunction, breakBeats: 0, barPlans: [] };
  }

  const role = introRoleFor(options, entryFunction, harmonicActivity);
  const breakBeats = introBreakFor(role, options.melodicLanguage);
  const tonic = options.tonality === 'minor' ? 'i' : 'I';
  const predominant = options.tonality === 'minor' ? 'iv' : 'IV';
  const approach = approachTokenFor(entryToken, options.tonality);
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

export function createSongPlan(options: CreateSongPlanOptions): SongPlan {
  const { bars, seed, progression, style } = options;
  const count = sectionCountFor(bars);
  const sectionBars = bars / count;
  const sectionEnergies = sectionEnergiesFor(count, seed);
  const sections: SongSectionPlan[] = Array.from({ length: count }, (_, index) => ({
    index,
    id: (['A', 'B', 'C', 'D', 'E'] as const)[index]!,
    startBar: index * sectionBars,
    bars: sectionBars,
    role: sectionRoleFor(index, count),
    energy: sectionEnergies[index]!,
    ...sectionMotifPlanFor(index, count, seed),
  }));
  const lateClimax = (seed & 1) === 1;
  const climaxBar = bars === 40
    ? (() => {
      const candidates = sections.slice(1);
      const peakEnergy = Math.max(...candidates.map((section) => section.energy));
      const peaks = candidates.filter((section) => section.energy === peakEnergy);
      const peak = peaks[(seed >>> 10) % peaks.length]!;
      return peak.startBar + (lateClimax ? 6 : 4);
    })()
    : bars === 16
      ? (() => {
        const peakEnergy = Math.max(...sections.map((section) => section.energy));
        const peaks = sections.filter((section) => section.energy === peakEnergy);
        const peak = peaks[(seed >>> 10) % peaks.length]!;
        return peak.startBar + (lateClimax ? 6 : 4);
      })()
      : bars === 8
        ? (lateClimax ? 6 : 4)
        : lateClimax ? 3 : 2;

  const harmony: HarmonyBarPlan[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const sectionIndex = Math.min(count - 1, Math.floor(bar / sectionBars));
    const section = sections[sectionIndex]!;
    const slot = progression.slots[bar % progression.slots.length]!;
    const selected = Math.max(0, Math.min(slot.length - 1, options.choice[bar] ?? 0));
    const tokens = [...slot[selected]!];
    const phraseFunction = phraseFunctionFor(bar, bars);
    const harmonicGoal = harmonicGoalFor(bar, bars, phraseFunction);
    const entryFunction = harmonicFunctionForToken(tokens[0]!);
    const exitFunction = harmonicFunctionForToken(tokens.at(-1)!);
    const barInSection = bars >= 16 ? bar % 8 : bar;
    const localEnergy = [0, 1, 1, 0][Math.floor((barInSection % 8) / 2)]!;
    harmony.push({
      bar,
      section: section.id,
      phraseFunction,
      harmonicGoal,
      tokens,
      durations: durationsFor(tokens, harmonicGoal),
      entryFunction,
      exitFunction,
      cadence: cadenceFor(bar, bars, phraseFunction, exitFunction),
      energy: bar === climaxBar ? 5 : Math.max(1, Math.min(4, section.energy + localEnergy - 1)),
    });
  }

  const harmonicActivity = harmony.filter((bar) => bar.tokens.length > 1).length / bars;
  return {
    tonality: options.tonality,
    melodicLanguage: options.melodicLanguage,
    grooveFeel: options.grooveFeel,
    styleId: style.id,
    progressionId: progression.id,
    progressionBars: progression.slots.length,
    soundChip: options.soundChip,
    intro: introPlanFor(options, harmony, harmonicActivity),
    form: { sections, climaxBar, loopCadence: 'turnaround' },
    harmony,
    melodyDensity: (style.melody.density[0] + style.melody.density[1]) / 2,
    harmonicActivity,
  };
}
