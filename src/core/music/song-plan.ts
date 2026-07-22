import type {
  CadenceType,
  ComposeBars,
  GrooveFeel,
  MelodyMode,
  MelodicLanguage,
  PhraseFunction,
  PhraseSection,
  Tonality,
} from './compose.js';
import { harmonicFunctionForToken } from './theory.js';
import type { HarmonicFunction, ProgressionDef, StyleDef } from './theory.js';

export type HarmonicGoal = 'establish' | 'continue' | 'depart' | 'resolve' | 'turnaround';
export type SectionRole = 'hook' | 'development' | 'relief' | 'return';

export interface SongSectionPlan {
  index: number;
  id: PhraseSection;
  startBar: number;
  bars: number;
  role: SectionRole;
  /** 1..5。編成密度ではなく、曲として目指す相対エネルギー。 */
  energy: number;
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
  soundChip: 'opll' | 'nes2a03';
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
  return (['hook', 'development', 'relief', 'return', 'hook'] as const)[index]!;
}

function sectionEnergyFor(index: number, count: number, seed: number): number {
  if (count === 1) return 3;
  if (count === 2) {
    const contrast = (seed >>> 1) % 3;
    return contrast === 0 ? [2, 4][index]! : contrast === 1 ? [4, 2][index]! : [3, 3][index]!;
  }
  return [4, 3, 2, 5, 4][index]!;
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
}

export function createSongPlan(options: CreateSongPlanOptions): SongPlan {
  const { bars, seed, progression, style } = options;
  const count = sectionCountFor(bars);
  const sectionBars = bars / count;
  const sections: SongSectionPlan[] = Array.from({ length: count }, (_, index) => ({
    index,
    id: (['A', 'B', 'C', 'D', 'E'] as const)[index]!,
    startBar: index * sectionBars,
    bars: sectionBars,
    role: sectionRoleFor(index, count),
    energy: sectionEnergyFor(index, count, seed),
  }));
  const lateClimax = (seed & 1) === 1;
  const climaxBar = bars === 40
    ? (lateClimax ? 26 : 24)
    : bars === 16
      ? (lateClimax ? 14 : 12)
      : bars === 8
        ? (lateClimax ? 6 : 4)
        : 2;

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

  return {
    tonality: options.tonality,
    melodicLanguage: options.melodicLanguage,
    grooveFeel: options.grooveFeel,
    styleId: style.id,
    progressionId: progression.id,
    soundChip: options.soundChip,
    form: { sections, climaxBar, loopCadence: 'turnaround' },
    harmony,
    melodyDensity: (style.melody.density[0] + style.melody.density[1]) / 2,
    harmonicActivity: harmony.filter((bar) => bar.tokens.length > 1).length / bars,
  };
}
