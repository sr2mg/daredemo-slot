/**
 * 決定論的な作曲エンジン（サウンドテスト用）。
 * 決定順序は「テンポ・キー → スタイル → フォーム → コード進行 → モチーフ → メロディ」の
 * トップダウン（docs 未整備。UI の SoundTestPanel が唯一の呼び出し元）。
 * 同一シード + 同一オプションなら常に同じ Piece を返す（Xoshiro128 再利用）。
 *
 * メロディの制約:
 * - 強拍（1・3 拍目）はその時点のコードトーンに限定
 * - 弱拍は 2 小節単位の動き方を反復し、スケール音の順次進行 or コードトーンへの跳躍
 * - クライマックス（最高音）はフォーム後半の2候補からシードで選び、頭に1箇所
 * - 最終小節の後半は音を減らしてループの頭に「渡す」
 */

import { Xoshiro128 } from '../rng.js';
import type { Rng } from '../rng.js';
import {
  CHORDS, MAJOR_SCALE, NATURAL_MINOR_SCALE, PROGRESSIONS, STYLES, YO_SCALE, chordName,
  harmonicFunctionForToken, progressionForTonality,
} from './theory.js';
import type { HarmonicFunction, StyleDef } from './theory.js';
import { arrangementPlanFor } from './arrangement.js';
import type { CompositionStrategy } from './composition-strategy.js';
import { defaultChoiceFor, variedChoiceFor as chooseVariedHarmony } from './harmony-plan.js';
import { grooveBeat } from './timing.js';
import {
  createSongPlan,
  legacyMelodyMode,
  resolveMelodicLanguage,
  resolveTonality,
} from './song-plan.js';
import type { MotifTransform, SongPlan } from './song-plan.js';

export { arrangementPlanFor, arrangementSectionFor } from './arrangement.js';
export { defaultChoiceFor, hasVariedChoiceFor, variedChoiceFor } from './harmony-plan.js';
export type { ChoiceVariationOptions } from './harmony-plan.js';
export {
  COMPOSITION_STRATEGIES,
  compositionStrategyInfo,
  resolveCompositionPolicy,
} from './composition-strategy.js';
export type {
  CompositionPolicy,
  CompositionPremise,
  CompositionStrategy,
  CompositionStrategyInfo,
  StrategySectionId,
} from './composition-strategy.js';
export { grooveBeat } from './timing.js';
export {
  createSongPlan,
  legacyMelodyMode,
  phraseFunctionFor,
  resolveMelodicLanguage,
  resolveTonality,
} from './song-plan.js';
export type {
  HarmonicGoal,
  HarmonyBarPlan,
  IntroBarPlan,
  IntroBassGesture,
  IntroDrumGesture,
  IntroLeadGesture,
  MotifTransform,
  RhythmVariant,
  SectionRole,
  SongIntroPlan,
  SongFormPlan,
  SongPlan,
  SongSectionPlan,
} from './song-plan.js';
export { checkPieceStructure, diagnosePiece, suggestCompositionRepair, validatePiece } from './diagnostics.js';
export {
  melodicPhraseFingerprint,
  melodicSectionSimilarities,
  summarizeDistribution,
} from './diversity.js';
export type { DistributionSummary, MelodicSectionSimilarity } from './diversity.js';
export type {
  CompositionIssue,
  CompositionObservation,
  CompositionRepair,
  CompositionReport,
  DiagnosticCategory,
  StructuralIssue,
  StructuralReport,
  Violation,
} from './diagnostics.js';

export type ComposeBars = 4 | 8 | 16 | 40;
export type Tonality = 'major' | 'minor';
export type MelodicLanguage = 'standard' | 'japanese';
/** @deprecated v1保存曲の互換入力。新規コードはtonalityとmelodicLanguageを使う。 */
export type MelodyMode = 'major' | 'minor' | 'japanese';
export type JapaneseScale = 'ritsu' | 'minyo' | 'miyakobushi';
export type JapaneseScaleChoice = 'auto' | JapaneseScale;
export type OrnamentType = 'grace' | 'turn' | 'shake';
export type GrooveFeel = 'straight' | 'tripletOverlay' | 'bounce';
export type PhraseFunction = 'statement' | 'restatement' | 'departure' | 'conclusion';
export type IntroRole = 'motif' | 'groove' | 'fanfare' | 'runup';
export type CadenceType = 'open' | 'half' | 'closed' | 'turnaround';
export type ArrangementArc = 'build' | 'contrast' | 'terrace' | 'compact' | 'hookFirst';
export type CounterRole = 'response' | 'counterline';
export type TextureStrategy = 'classic' | 'arpDrive' | 'counterDrive' | 'bassDrive' | 'hybrid';
export type BassRole = 'rootMotion' | 'pedal';
export type PhraseSection = 'A' | 'B' | 'C' | 'D' | 'E';
export type NoteArticulation = 'normal' | 'staccato' | 'tenuto' | 'accent' | 'ornament';
export type { HarmonicFunction } from './theory.js';

export const INTRO_ROLE_LABELS: Record<IntroRole, string> = {
  motif: '主題予告型',
  groove: 'グルーヴ提示型',
  fanfare: 'ファンファーレ型',
  runup: '駆け上がり型',
};

export const ARRANGEMENT_ARC_LABELS: Record<ArrangementArc, string> = {
  build: '積み上げ型',
  contrast: '対比型',
  terrace: '段丘型',
  compact: 'コンパクト型',
  hookFirst: 'フック先行BIG型',
};

export const COUNTER_ROLE_LABELS: Record<CounterRole, string> = {
  response: '短い応答',
  counterline: '独立対旋律',
};

export const TEXTURE_STRATEGY_LABELS: Record<TextureStrategy, string> = {
  classic: '標準編成',
  arpDrive: '分散和音主導',
  counterDrive: '対旋律主導',
  bassDrive: '低音主導',
  hybrid: '交替型',
};

export const JAPANESE_SCALE_LABELS: Record<JapaneseScaleChoice, string> = {
  auto: '自動',
  ritsu: '律・陽旋法系',
  minyo: '民謡音階系',
  miyakobushi: '都節系',
};

export const ORNAMENT_LABELS: Record<OrnamentType, string> = {
  grace: '前打音',
  turn: '回し',
  shake: '揺り',
};

export const GROOVE_FEEL_LABELS: Record<GrooveFeel, string> = {
  straight: 'ストレート',
  tripletOverlay: '三連オーバーレイ',
  bounce: '跳ねる8分',
};

export const PHRASE_FUNCTION_LABELS: Record<PhraseFunction, string> = {
  statement: '提示',
  restatement: '変奏反復',
  departure: '展開',
  conclusion: '結論',
};

/** 決定論生成した主旋律へ後から再適用する、保存可能な局所編集。 */
export interface MelodyEdit {
  beat: number;
  fromMidi: number;
  toMidi: number;
}

export interface JapanesePlan {
  id: JapaneseScale;
  /** キー主音からの五音。西洋的な固定トニックではなく、核音配置を作る材料として使う。 */
  intervals: number[];
  /** 絶対ピッチクラス。 */
  scalePcs: number[];
  /** 4度枠を作る核音。終止とフレーズ開始で優先する。 */
  nuclearPcs: number[];
}

export interface ComposeOptions {
  progressionId: string;
  styleId: string;
  /** キー主音のピッチクラス（0 = C） */
  keyRoot: number;
  bpm: number;
  /** 4 = RB / 8 = BB / 16 = ゲーム BGM / 40 = BIG本編（通常は2小節導入込みで42小節）。 */
  bars: ComposeBars;
  /** 16/40小節曲の先頭へ、初回だけ鳴る2小節イントロを付ける。省略時は有効。 */
  intro?: boolean;
  /** 和声と進行カタログの調性。省略時はmajor。 */
  tonality?: Tonality;
  /** 調性とは独立した旋律語法。japaneseは五音・核音・間・装飾を連動させる。 */
  melodicLanguage?: MelodicLanguage;
  /** @deprecated v1保存曲との互換入力。 */
  melodyMode?: MelodyMode;
  /** 和風モードの音組織。省略時はシードから3様式を選ぶ。 */
  japaneseScale?: JapaneseScaleChoice;
  /** 和風様式とは独立したゲーム向けのリズム層。 */
  grooveFeel?: GrooveFeel;
  /** 診断の局所修正。シード生成後に一致する音だけへ再適用する。 */
  melodyEdits?: readonly MelodyEdit[];
  seed: number;
  /** 全小節ぶんのスロット選択。省略時は8小節以上で区間変化、4小節で定番形を選ぶ。 */
  choice?: readonly number[];
  /** ブラインド比較用の上位戦略。省略時は既存と同じ current。 */
  compositionStrategy?: CompositionStrategy;
  /**
   * OPLL 音色の上書き（0=ユーザー音色、1〜15=内蔵音色）。省略時はスタイル既定。
   * compose() 自体は使わない編曲層のパラメータだが、曲の保存単位・BGM キャッシュの
   * キーが ComposeOptions の JSON なので、ここに持たせて「同じ曲 = 同じ音色」を保証する
   */
  voices?: VoiceOverride;
  /** OPLLの音色0番へ書き込む1曲1個のユーザー音色。 */
  opllUserPatch?: OpllUserPatchId;
  /** 省略時は従来どおり OPLL。保存済み v1 曲との後方互換を保つ。 */
  soundChip?: 'opll' | 'nes2a03';
  /** ファミコン 2A03 モード固有の音色パラメータ。 */
  nes?: NesVoiceOptions;
}

export interface NesVoiceOptions {
  /** パルス 1（主旋律）のデューティ。0=12.5%, 1=25%, 2=50%, 3=25%反転。 */
  pulse1Duty?: 0 | 1 | 2 | 3;
  /** パルス 2（伴奏）のデューティ。 */
  pulse2Duty?: 0 | 1 | 2 | 3;
}

/** パート別の OPLL 音色上書き。未指定のパートはスタイル既定（opll-arrange.ts） */
export interface VoiceOverride {
  lead?: number;
  backing?: number;
  bass?: number;
  counter?: number;
  ostinato?: number;
}

export type OpllUserPatchId = 'brightLead' | 'metalBell' | 'punchBass';

export interface NoteEvent {
  beat: number;
  dur: number;
  midi: number;
  /** 0..1。編曲層がチップ固有の音量段階へ変換する。 */
  velocity?: number;
  articulation?: NoteArticulation;
  ornament?: OrnamentType;
  /** 装飾音はPhrasePlanの骨格リズム検証から除外する。 */
  role?: 'structural' | 'ornament';
}

export interface ChordEvent {
  beat: number;
  dur: number;
  token: string;
  name: string;
  function: HarmonicFunction;
  /** 絶対ピッチクラス集合（検証用） */
  pcs: number[];
  /** 直前のコードから最短距離で接続した、低音から高音順の伴奏ボイシング。 */
  midis: number[];
}

export interface DrumEvent {
  beat: number;
  inst: 'kick' | 'snare' | 'hat' | 'tom' | 'cymbal';
}

export interface PhraseBarPlan {
  bar: number;
  section: PhraseSection;
  role: 'statement' | 'answer' | 'continuation' | 'cadence';
  /** 8分グリッド上の主旋律発音位置。 */
  rhythm: boolean[];
  /** 主旋律と同時に確保した、副旋律専用の8分グリッド位置。 */
  counterSteps: number[];
  /** 16分グリッド上の短い装飾音位置。 */
  ornamentSteps: number[];
  /** 装飾を入れる小節だけ種類を持つ。 */
  ornamentType: OrnamentType | null;
  /** 意図して空けた8分グリッド位置。 */
  maSteps: number[];
  /** 8小節を提示→変奏反復→展開→結論として捉えたフレーズ機能。 */
  phraseFunction: PhraseFunction;
  /** この小節が輪郭を受け継ぐ元小節。提示小節は自分自身。 */
  motifSourceBar: number;
  cadence: CadenceType | null;
  /** フレーズが到達する音のピッチクラス。 */
  targetPc: number | null;
  targetStep: number | null;
  /** 0..5。音域・編成の起伏に使う。 */
  energy: number;
  /** 0..1。小節内の基準ダイナミクス。 */
  dynamic: number;
  /** 主旋律の1拍目を意図して空ける小節（呼吸・弱起）。伴奏とベースは拍頭を保つ。 */
  restStart: boolean;
  /** 前小節のロングトーンが1拍目を覆うため、主旋律の頭打ちを省いた小節。 */
  sustainedEntry: boolean;
  /** このstepの音を次小節の最初の発音まで保続する（2拍以上のロングトーン）。 */
  longToneStep: number | null;
  /** セクション別テッシトゥーラ変位（半音）。旋律の目標高さへ加算する。 */
  registerOffset: number;
}

export interface PhrasePlan {
  climaxBar: number;
  /** 一度だけ許す9半音超の署名跳躍を置く小節（頭拍）。null なら無し。 */
  signatureLeapBar: number | null;
  bars: PhraseBarPlan[];
}

export interface ArrangementSectionPlan {
  backingDensity: 'sparse' | 'full';
  echo: boolean;
  drum: 'base' | 'sectionB' | 'breakdown';
  /** セクション頭の合図。エネルギー上昇時も毎回同じシンバルにはしない。 */
  entrance: 'none' | 'cymbal';
  /** 次区間へのフィル。境界ごとに同じフィルを貼らない。 */
  exitFill: 'none' | 'light' | 'full';
  counterDensity: 0 | 1 | 2;
  /** 独立した分散和音の密度。0=休止、1=8分、2=16分主体。 */
  ostinatoDensity: 0 | 1 | 2;
  /** 16分へ加速するフレーズ位置。区間ごとに同じ場所へ固定しない。 */
  ostinatoPeak: PhraseFunction | null;
}

export interface ArrangementPlan {
  arc: ArrangementArc;
  counterRole: CounterRole;
  /** 曲全体で何を推進力にするか。各奏法を常時重ねず、区間ごとに出し引きする。 */
  textureStrategy: TextureStrategy;
  /** ペダル低音も常設せず、低音主導の戦略でだけ選べる道具として扱う。 */
  bassRole: BassRole;
  sectionA: ArrangementSectionPlan;
  sectionB: ArrangementSectionPlan;
  /** 4/8小節=1区間、16小節=2区間、40小節=5区間。 */
  sections: readonly ArrangementSectionPlan[];
}

export interface Piece {
  bpm: number;
  styleId: string;
  tonality: Tonality;
  melodicLanguage: MelodicLanguage;
  /** @deprecated 表示・保存互換用。 */
  melodyMode: MelodyMode;
  japanesePlan: JapanesePlan | null;
  grooveFeel: GrooveFeel;
  /** ループ本体の小節数。introBars は含めない。 */
  bars: number;
  /** 初回だけ鳴るイントロの小節数。16/40小節フォーム以外は0。 */
  introBars: number;
  /** イントロが担う役割。イントロなしの場合は null。 */
  introRole: IntroRole | null;
  /** イントロ後、ループ本体が始まる拍位置。 */
  loopStartBeat: number;
  /** イントロを含む総拍数。 */
  beats: number;
  keyRoot: number;
  chords: ChordEvent[];
  melody: NoteEvent[];
  /** PhrasePlanで主旋律と同時に場所を確保した短い副旋律。 */
  counterMelody: NoteEvent[];
  /** リフと別に推進力を担当する分散和音。チップ別編曲で優先度を付けて配線する。 */
  ostinato: NoteEvent[];
  bass: NoteEvent[];
  drums: DrumEvent[];
  /** 全声部が共有する、フレーズ・終止・起伏の設計図。 */
  phrasePlan: PhrasePlan;
  /** 和声・フォーム・エネルギーを、各声部より前に確定した曲全体の設計図。 */
  songPlan: SongPlan;
  /** 各セクションの密度・ダブリング・対旋律の役割を決める編成設計。 */
  arrangementPlan: ArrangementPlan;
  /** 表示用: イントロの小節ごとのコード名。 */
  introChordNames: string[];
  /** 表示用: 小節ごとのコード名（半小節は空白区切り） */
  barChordNames: string[];
}

/** メロディ音域: C5..E6 */
const MELODY_LO = 72;
const MELODY_HI = 88;
const COUNTER_LO = 60;
const COUNTER_HI = 76;

/** target に最も近い、pcs に含まれる MIDI ノート（音域内） */
function nearestWithPc(target: number, pcs: readonly number[], lo = MELODY_LO, hi = MELODY_HI): number {
  const t = Math.max(lo, Math.min(hi, target));
  let best = -1;
  let bestDist = Infinity;
  for (let m = lo; m <= hi; m++) {
    if (!pcs.includes(m % 12)) continue;
    const d = Math.abs(m - t);
    if (d < bestDist) {
      bestDist = d;
      best = m;
    }
  }
  return best; // pcs が空でない限り必ず見つかる
}

/** 前後2音の双方へ近い候補を選び、大きな跳躍を片側へ押し付けない。 */
function bridgeWithPc(
  from: number,
  to: number,
  pcs: readonly number[],
  lo = MELODY_LO,
  hi = MELODY_HI,
): number {
  let best = nearestWithPc((from + to) / 2, pcs, lo, hi);
  let bestScore = Infinity;
  for (let midi = lo; midi <= hi; midi++) {
    if (!pcs.includes(midi % 12)) continue;
    const left = Math.abs(midi - from);
    const right = Math.abs(to - midi);
    const score = Math.max(left, right) * 3 + left + right;
    if (score < bestScore) {
      best = midi;
      bestScore = score;
    }
  }
  return best;
}

/** from から dir 方向に 1 歩、pcs 上を進む（順次進行） */
function stepOnScale(from: number, dir: 1 | -1, pcs: readonly number[]): number {
  let m = from + dir;
  while (m >= MELODY_LO && m <= MELODY_HI) {
    if (pcs.includes(((m % 12) + 12) % 12)) return m;
    m += dir;
  }
  // 音域端で進行方向に音階音がなければ反転する。単純な数値 clamp で音階外へ落とさない。
  m = from - dir;
  while (m >= MELODY_LO && m <= MELODY_HI) {
    if (pcs.includes(((m % 12) + 12) % 12)) return m;
    m -= dir;
  }
  return nearestWithPc(from, pcs);
}

/** スタイル固有の拍節アクセントから、8分グリッドのモチーフを作る。 */
function makeMotifRhythm(style: StyleDef, rng: Rng, contrastFrom?: readonly boolean[]): boolean[] {
  const optional = [1, 2, 3, 5, 6, 7];
  const scored = optional.map((step) => {
    const roll = rng.nextInt(100);
    return { step, score: style.melody.onsetWeights[step]! - roll, on: roll < style.melody.onsetWeights[step]! };
  });
  const rhythm = Array.from({ length: 8 }, (_, step) => step === 0 || step === 4);
  for (const candidate of scored) rhythm[candidate.step] = candidate.on;

  const [minNotes, maxNotes] = style.melody.density;
  while (rhythm.filter(Boolean).length > maxNotes) {
    const removable = scored.filter(({ step }) => rhythm[step]).sort((a, b) => a.score - b.score)[0]!;
    rhythm[removable.step] = false;
  }
  while (rhythm.filter(Boolean).length < minNotes) {
    const addable = scored.filter(({ step }) => !rhythm[step]).sort((a, b) => b.score - a.score)[0]!;
    rhythm[addable.step] = true;
  }

  // 対照形が偶然同じなら、密度を保ったまま弱拍を1組だけ交換する。
  if (contrastFrom && rhythm.every((on, step) => on === contrastFrom[step])) {
    const remove = optional.find((step) => rhythm[step]);
    const add = optional.find((step) => !rhythm[step]);
    if (remove !== undefined && add !== undefined) {
      rhythm[remove] = false;
      rhythm[add] = true;
    }
  }
  return rhythm;
}

/** 既出の同役割リズムすべてと異なる、同密度の変奏を作る。 */
function makeDistinctMotifRhythm(
  style: StyleDef,
  rng: Rng,
  previous: readonly (readonly boolean[])[],
): boolean[] {
  const rhythm = makeMotifRhythm(style, rng, previous.at(-1));
  const equalsAny = (candidate: readonly boolean[]): boolean => previous.some(
    (known) => candidate.every((on, step) => on === known[step]),
  );
  if (!equalsAny(rhythm)) return rhythm;
  const optional = [1, 2, 3, 5, 6, 7];
  for (const remove of optional.filter((step) => rhythm[step])) {
    for (const add of optional.filter((step) => !rhythm[step])) {
      const candidate = [...rhythm];
      candidate[remove] = false;
      candidate[add] = true;
      if (!equalsAny(candidate)) return candidate;
    }
  }
  return rhythm;
}

interface PhraseMove {
  direction: 1 | -1;
  stepwise: boolean;
  leap: number;
}

/**
 * 2 小節（8 分グリッド 16 ステップ）ぶんの旋律ジェスチャー。
 * 実音ではなく「上行/下行・順次/跳躍」を保存し、コードが変わっても同じ動き方を再利用する。
 */
function makePhraseGesture(rng: Rng, style: StyleDef): PhraseMove[] {
  const primary: 1 | -1 = rng.nextInt(2) === 0 ? 1 : -1;
  const contour = [1, 1, -1, 1, 1, -1, -1, -1, 1, -1, 1, 1, -1, -1, 1, -1] as const;
  return contour.map((direction) => ({
    direction: (direction * primary) as 1 | -1,
    stepwise: rng.nextInt(100) < style.melody.stepwisePercent,
    leap: 3 + rng.nextInt(3),
  }));
}

function midiCandidatesForPc(pc: number, lo: number, hi: number): number[] {
  const result: number[] = [];
  for (let midi = lo; midi <= hi; midi++) if (midi % 12 === pc) result.push(midi);
  return result;
}

/**
 * 各コードを低音から高音へ並べ、直前の同じ声部から最短距離になる転回形を選ぶ。
 * OPLLの単音バッキングが参照する中央2声を特に滑らかにする。
 */
function voiceChord(
  pcs: readonly number[],
  previous: readonly number[] | null,
  openFifths = false,
): number[] {
  // 和風モードでは三度・七度を伴奏から抜き、根音－五度－根音の開いた配置にする。
  // 和声機能そのものは ChordEvent.pcs に残すので、進行の意味までは失わない。
  const voicingPcs = openFifths && pcs.length >= 3 ? [pcs[0]!, pcs[2]!, pcs[0]!] : [...pcs];
  const choices = voicingPcs.map((pc) => midiCandidatesForPc(pc, 55, 79));
  const candidates: number[][] = [];
  const visit = (index: number, picked: number[]) => {
    if (index === choices.length) {
      const sorted = [...picked].sort((a, b) => a - b);
      if (new Set(sorted).size === sorted.length && sorted.at(-1)! - sorted[0]! <= 14) candidates.push(sorted);
      return;
    }
    for (const midi of choices[index]!) visit(index + 1, [...picked, midi]);
  };
  visit(0, []);

  const reference = previous ?? (voicingPcs.length === 4 ? [57, 60, 64, 67] : [57, 62, 66]);
  const voiceAt = (notes: readonly number[], index: number): number =>
    notes[Math.min(index, notes.length - 1)]!;
  const score = (notes: readonly number[]): number => {
    let total = Math.abs(notes.reduce((sum, midi) => sum + midi, 0) / notes.length - 64) * 0.2;
    for (let index = 0; index < notes.length; index++) {
      const movement = Math.abs(notes[index]! - voiceAt(reference, index));
      total += movement + Math.max(0, movement - 5) * 3;
    }
    // 実際に鳴らす中央声部を優先して連結する。
    for (const index of [1, 2]) {
      if (notes[index] !== undefined) total += Math.abs(notes[index]! - voiceAt(reference, index)) * 1.5;
    }
    return total;
  };
  return candidates.sort((a, b) => score(a) - score(b))[0]
    ?? voicingPcs.map((pc) => 60 + pc).sort((a, b) => a - b);
}

const JAPANESE_INTERVALS: Record<JapaneseScale, readonly number[]> = {
  // 4度枠 C-D-F / G-A-C に相当する、これまでの陽旋法寄り五音。
  ritsu: YO_SCALE,
  // 国立劇場の民謡音階例 C-Eb-F / G-Bb-C。
  minyo: [0, 3, 5, 7, 10],
  // 半音を含む都節系 C-Db-F / G-Ab-C。
  miyakobushi: [0, 1, 5, 7, 8],
};

/** 五音を固定トニックとしてではなく、4度離れた核音を持つ旋律計画へ展開する。 */
export function japanesePlanFor(
  keyRoot: number,
  choice: JapaneseScaleChoice = 'auto',
  seed = 0,
): JapanesePlan {
  const ids: readonly JapaneseScale[] = ['ritsu', 'minyo', 'miyakobushi'];
  const id = choice === 'auto' ? ids[(seed >>> 1) % ids.length]! : choice;
  const intervals = [...JAPANESE_INTERVALS[id]];
  return {
    id,
    intervals,
    scalePcs: intervals.map((interval) => (keyRoot + interval) % 12),
    // 二つの4度枠の端点。フレーズの柱として扱い、中間音は方向づけに使う。
    nuclearPcs: [keyRoot, (keyRoot + 5) % 12, (keyRoot + 7) % 12],
  };
}
/**
 * 元の16分ハット譜を三連グリッドへ要約する。
 * 1拍を常に3発で埋めず、表拍は表、単独の裏拍は三連の後ろ、
 * 裏が2発以上ある細かい譜だけを三連の中・後ろへ写す。
 */
function tripletHatOffsets(pattern: readonly number[], quarter: number): number[] {
  const start = quarter * 4;
  const offsets: number[] = [];
  if (pattern[start]) offsets.push(0);
  const offbeatCount = pattern.slice(start + 1, start + 4).filter(Boolean).length;
  if (offbeatCount === 1) offsets.push(2 / 3);
  else if (offbeatCount >= 2) offsets.push(1 / 3, 2 / 3);
  return offsets;
}

function withMelodyEdits(notes: readonly NoteEvent[], edits: readonly MelodyEdit[] = []): NoteEvent[] {
  const result = notes.map((note) => ({ ...note }));
  for (const edit of edits) {
    const target = result.find((note) => (
      Math.abs(note.beat - edit.beat) < 0.001 && note.midi === edit.fromMidi
    ));
    if (target) target.midi = edit.toMidi;
  }
  return result;
}

/**
 * 標準語法向けの控えめな装飾計画。16小節に0〜1個、終止付近の応答小節へ
 * grace/turn だけを置く（shake は和風の語彙として残す）。
 */
function sparseOrnamentPlanFor(bars: ComposeBars, seed: number): Map<number, OrnamentType> {
  const rng = new Xoshiro128((seed ^ 0x4752_4143) >>> 0);
  const plan = new Map<number, OrnamentType>();
  for (let phrase = 0; phrase < bars; phrase += 16) {
    const candidates = [phrase + 3, phrase + 7, phrase + 11, phrase + 15].filter((bar) => bar < bars);
    if (candidates.length === 0 || rng.nextInt(100) >= 70) continue;
    plan.set(candidates[rng.nextInt(candidates.length)]!, rng.nextInt(2) === 0 ? 'grace' : 'turn');
  }
  return plan;
}

/** 4小節ごとに一度だけ装飾し、同じ応答処理が2小節おきに続くのを避ける。 */
function ornamentPlanFor(bars: ComposeBars, seed: number): Map<number, OrnamentType> {
  const rng = new Xoshiro128((seed ^ 0x4f52_4e4d) >>> 0);
  const selected: number[] = [];
  for (let phrase = 0; phrase < bars; phrase += 4) {
    const candidates = [phrase + 1, phrase + 3].filter((bar) => bar < bars);
    selected.push(candidates[rng.nextInt(candidates.length)]!);
  }
  const turnIndex = selected.length > 1 ? rng.nextInt(selected.length) : -1;
  return new Map(selected.map((bar, index) => [
    bar,
    index === turnIndex ? 'turn' : ((seed + index) & 1) === 0 ? 'grace' : 'shake',
  ]));
}

function closestPcToMidi(target: number, pcs: readonly number[], lo = 48, hi = 96): number {
  return nearestWithPc(target, pcs, lo, hi) % 12;
}

/** フレーズの役割・終止目標・対旋律の空間を、各声部より先に決める。 */
function makePhrasePlan(
  opts: ComposeOptions,
  style: StyleDef,
  rng: Rng,
  chordAt: (beat: number) => ChordEvent,
  startMidi: number,
  melodicLanguage: MelodicLanguage,
  scalePcs: readonly number[],
  japanesePlan: JapanesePlan | null,
  arrangementPlan: ArrangementPlan,
  songPlan: SongPlan,
): PhrasePlan {
  const promptA = makeMotifRhythm(style, rng);
  const answerA = makeMotifRhythm(style, rng, promptA);
  const promptB = makeDistinctMotifRhythm(style, rng, [promptA]);
  const answerB = makeDistinctMotifRhythm(style, rng, [answerA]);
  const promptC = makeDistinctMotifRhythm(style, rng, [promptA, promptB]);
  const answerC = makeDistinctMotifRhythm(style, rng, [answerA, answerB]);
  const promptD = makeDistinctMotifRhythm(style, rng, [promptA, promptB, promptC]);
  const answerD = makeDistinctMotifRhythm(style, rng, [answerA, answerB, answerC]);
  const promptE = makeDistinctMotifRhythm(style, rng, [promptA, promptB, promptC, promptD]);
  const answerE = makeDistinctMotifRhythm(style, rng, [answerA, answerB, answerC, answerD]);
  const rhythmFamilies = [
    [promptA, answerA],
    [promptB, answerB],
    [promptC, answerC],
    [promptD, answerD],
    [promptE, answerE],
  ] as const;
  const ornaments = melodicLanguage === 'japanese'
    ? ornamentPlanFor(opts.bars, opts.seed)
    : sparseOrnamentPlanFor(opts.bars, opts.seed);
  const climaxBar = songPlan.form.climaxBar;
  const bars: PhraseBarPlan[] = [];

  // 新しい表現デバイスは主系列の rng を消費せず、既存の抽選列を乱さない独立ストリームで決める。
  // 進行IDも混ぜ、同じシードでも進行が違えば別の表情の抽選になるようにする。
  let progressionHash = 0;
  for (let index = 0; index < opts.progressionId.length; index++) {
    progressionHash = (Math.imul(progressionHash, 31) + opts.progressionId.charCodeAt(index)) >>> 0;
  }
  const featureSeed = (opts.seed ^ progressionHash) >>> 0;
  const longToneRng = new Xoshiro128((featureSeed ^ 0x4c4f_4e47) >>> 0);
  const restRng = new Xoshiro128((featureSeed ^ 0x5245_5354) >>> 0);
  const registerRng = new Xoshiro128((featureSeed ^ 0x5245_4749) >>> 0);
  const leapRng = new Xoshiro128((featureSeed ^ 0x4c45_4150) >>> 0);

  // セクション別テッシトゥーラ: Aは主題の基準。以降の区間は±4半音まで変位し、対比を作る。
  const sectionCount = opts.bars === 40 ? 5 : opts.bars === 16 ? 2 : 1;
  const registerOffsets: number[] = Array.from({ length: sectionCount }, (_, index) => {
    if (index === 0) return 0;
    const choices = [-4, -2, 0, 2, 4] as const;
    return choices[registerRng.nextInt(choices.length)]!;
  });
  if (sectionCount > 1 && !registerOffsets.some((offset) => offset !== 0)) {
    registerOffsets[Math.max(1, sectionCount - 2)] = 3;
  }

  // 署名跳躍: 低音域の区間（40小節は谷のC）の展開頭で一度だけ許す9半音超の跳躍。
  // 高音域からは音域の天井とクライマックスの一意性を壊さずに跳べないため、谷から跳ぶ。
  let signatureLeapBar: number | null = null;
  if (opts.bars >= 16 && leapRng.nextInt(100) < 60) {
    const candidateBar = opts.bars === 40 ? 20 : 12;
    if (candidateBar !== climaxBar && candidateBar < opts.bars) signatureLeapBar = candidateBar;
  }

  let pendingSustainEntry = false;
  let lastLongToneBar = -8;

  for (let bar = 0; bar < opts.bars; bar++) {
    const sectionIndex = opts.bars === 40 ? Math.floor(bar / 8) : opts.bars === 16 && bar >= 8 ? 1 : 0;
    const section = (['A', 'B', 'C', 'D', 'E'] as const)[sectionIndex]!;
    const barInSection = opts.bars >= 16 ? bar % 8 : bar;
    const harmonyBar = songPlan.harmony[bar]!;
    const phraseFunction = harmonyBar.phraseFunction;
    const sectionDesign = songPlan.form.sections[sectionIndex]!;
    const phraseIndex = (['statement', 'restatement', 'departure', 'conclusion'] as const)
      .indexOf(phraseFunction) as 0 | 1 | 2 | 3;
    const borrowsExternalMotif = sectionDesign.motifSourceSection !== null
      && sectionDesign.externalMotifPhrases.includes(phraseIndex);
    const sourceSection = borrowsExternalMotif
      ? songPlan.form.sections.find((candidate) => candidate.id === sectionDesign.motifSourceSection) ?? sectionDesign
      : sectionDesign;
    const sourcePhrase = sectionDesign.motifSourcePhrases[phraseIndex];
    const motifSourceBar = sourceSection.startBar + (sectionDesign.bars >= 8
      ? sourcePhrase * 2 + (barInSection % 2)
      : sourcePhrase);
    const isAnswer = barInSection % 2 === 1;
    const rhythmFamily = rhythmFamilies[sectionDesign.phraseRhythmVariants[phraseIndex]]!;
    const sectionRhythm = rhythmFamily[isAnswer ? 1 : 0];
    const rhythm = [...sectionRhythm];
    const sectionPlan = arrangementPlan.sections[sectionIndex] ?? arrangementPlan.sectionA;
    const sectionBoundary = opts.bars >= 16 && barInSection === 7 && bar !== opts.bars - 1;
    const cadence = isAnswer ? harmonyBar.cadence : null;

    const counterSteps: number[] = [];
    let targetStep: number | null = null;
    if (isAnswer) {
      if (cadence === 'turnaround') {
        for (let step = 5; step < 8; step++) rhythm[step] = false;
        rhythm[4] = true;
        targetStep = 4;
      } else if (sectionBoundary) {
        rhythm[6] = true;
        rhythm[7] = false;
        targetStep = 6;
      } else if (
        arrangementPlan.counterRole === 'response'
        && sectionPlan.counterDensity > 0
        && bar !== opts.bars - 1
        // 薄い応答は各区間の中盤に一度。絶対4小節目へ固定するとB区間で鳴らなくなる。
        && (sectionPlan.counterDensity === 2 || barInSection === (opts.bars === 4 ? 1 : 3))
      ) {
        for (let step = 5; step < 8; step++) rhythm[step] = false;
        rhythm[4] = true;
        targetStep = 4;
        const preferred = sectionPlan.counterDensity === 2 && style.id === 'ska' ? [5, 7] : [6];
        counterSteps.push(...preferred);
      } else {
        targetStep = rhythm.reduce((last, on, step) => on ? step : last, 4);
      }
    }

    const targetChord = targetStep === null ? null : chordAt(bar * 4 + targetStep * 0.5);
    let targetPc: number | null = null;
    if (targetChord && cadence) {
      const rootPc = targetChord.pcs[0]!;
      const modalChordPcs = targetChord.pcs.filter((pc) => scalePcs.includes(pc));
      const targetPcs = melodicLanguage === 'japanese' && modalChordPcs.length > 0
        ? modalChordPcs
        : targetChord.pcs;
      const nuclearTargets = japanesePlan
        ? targetPcs.filter((pc) => japanesePlan.nuclearPcs.includes(pc))
        : [];
      const cadencePcs = nuclearTargets.length > 0 ? nuclearTargets : targetPcs;
      if (cadence === 'open') targetPc = cadencePcs.at(-1) ?? rootPc;
      else if (cadence === 'turnaround' || japanesePlan) {
        targetPc = closestPcToMidi(startMidi, cadencePcs);
      } else targetPc = rootPc;
    }

    if (
      arrangementPlan.counterRole === 'counterline'
      && sectionPlan.counterDensity > 0
      && bar !== opts.bars - 1
      && !sectionBoundary
      // 薄い対旋律は応答小節だけ、密な対旋律も展開の開始を足す程度に留める。
      && (isAnswer || (sectionPlan.counterDensity === 2 && phraseFunction === 'departure'))
    ) {
      // 密な区間は主旋律の前半／後半どちらかを3音の短い裏メロへ譲る。
      // 1音ずつ全小節へ散らすより、ひとかたまりの応答として知覚しやすくする。
      const plannedOrnament = ornaments.has(bar) && targetStep !== null;
      const responseStart = plannedOrnament
        ? targetStep! <= 4 ? 5 : 1
        : (barInSection + opts.seed) % 2 === 0 ? 1 : 5;
      const preferred = sectionPlan.counterDensity === 2
        ? [responseStart, responseStart + 1, responseStart + 2]
        : [bar % 2 === 0 ? 6 : 2];
      for (const step of preferred) {
        if (step === targetStep || step === 0 || step === 4) continue;
        rhythm[step] = false;
        if (step + 1 < 8 && step + 1 !== targetStep && step + 1 !== 4) rhythm[step + 1] = false;
        counterSteps.push(step);
      }
    }
    // 対旋律の場所を空けても、主題の提示が痩せすぎない最低密度は保つ。
    for (const step of [1, 3, 5, 7]) {
      if (rhythm.filter(Boolean).length >= 4) break;
      const reservedByCounter = counterSteps.some((counterStep) => step === counterStep || step === counterStep + 1);
      if (!reservedByCounter && step !== targetStep) rhythm[step] = true;
    }

    const ornamentSteps: number[] = [];
    const ornamentType = targetStep !== null ? ornaments.get(bar) ?? null : null;
    const reserveOrnament = (candidate: number): void => {
      const candidateBeat = candidate * 0.25;
      const clearsCounter = counterSteps.every((counterStep) => Math.abs(candidateBeat - counterStep * 0.5) >= 0.5);
      if (clearsCounter) ornamentSteps.push(candidate);
    };
    if (targetStep !== null && targetStep > 0) {
      if (ornamentType === 'grace') reserveOrnament(targetStep * 2 - 1);
      if (ornamentType === 'turn') {
        reserveOrnament(targetStep * 2 - 2);
        reserveOrnament(targetStep * 2 - 1);
      }
    }

    // 「間」は音数の不足ではなく、フレーズ上で意図した空白として記録する。
    const maSteps: number[] = [];
    if (melodicLanguage === 'japanese' && isAnswer) {
      if (ornamentType && targetStep !== null) {
        const beforeTarget = targetStep - 1;
        if (beforeTarget > 0 && beforeTarget !== 4 && !counterSteps.includes(beforeTarget)) {
          rhythm[beforeTarget] = false;
          maSteps.push(beforeTarget);
        }
      } else {
        const weakSteps = [7, 5, 3, 1].filter(
          (step) => step !== targetStep && !counterSteps.includes(step),
        );
        const active = weakSteps.find((step) => rhythm[step] && rhythm.filter(Boolean).length > 4);
        const maStep = active ?? weakSteps.find((step) => !rhythm[step]);
        if (maStep !== undefined) {
          rhythm[maStep] = false;
          maSteps.push(maStep);
        }
      }
    }

    // 前小節のロングトーンが頭拍を覆う小節は、主旋律の頭打ちを省いて保続を受け入れる。
    let sustainedEntry = false;
    if (pendingSustainEntry) {
      rhythm[0] = false;
      sustainedEntry = true;
      pendingSustainEntry = false;
    }

    // 休符始まり: 展開部の提示側かループ頭で、1拍目を意図した空白にする（伴奏は拍頭を保つ）。
    let restStart = false;
    if (!sustainedEntry && bar !== climaxBar && bar !== signatureLeapBar) {
      const departurePrompt = phraseFunction === 'departure' && !isAnswer;
      if (departurePrompt && restRng.nextInt(100) < 30) restStart = true;
      else if (bar === 0 && restRng.nextInt(100) < 20) restStart = true;
      if (restStart) rhythm[0] = false;
    }

    // ロングトーン: 終止の到達音を次小節の最初の発音まで保続し、下の和声変化をまたがせる。
    let longToneStep: number | null = null;
    if (
      isAnswer
      && (targetStep === 4 || targetStep === 6)
      && counterSteps.every((counterStep) => counterStep <= targetStep!)
      && bar + 1 < opts.bars
      && bar + 1 !== climaxBar
      && bar - lastLongToneBar >= 4
      && longToneRng.nextInt(100) < 30
    ) {
      // 保続の間、主旋律の残りは鳴らさない（副旋律の応答は残す）。
      for (let step = targetStep + 1; step < 8; step++) rhythm[step] = false;
      longToneStep = targetStep;
      pendingSustainEntry = true;
      lastLongToneBar = bar;
    }

    const energy = harmonyBar.energy;
    // 谷区間（ドラムのブレイクダウン）は基準ダイナミクスの床を下げ、本当に静かな部分を作る。
    const dynamicFloor = sectionPlan.drum === 'breakdown' ? 0.46 : 0.58;
    const dynamic = Math.min(1, dynamicFloor + energy * 0.07 + (sectionPlan.backingDensity === 'full' ? 0.04 : 0));
    const role: PhraseBarPlan['role'] = cadence && cadence !== 'open'
      ? 'cadence'
      : isAnswer
        ? 'answer'
        : barInSection >= 4
          ? 'continuation'
          : 'statement';
    bars.push({
      bar, section, role, rhythm, counterSteps, ornamentSteps, ornamentType, maSteps,
      phraseFunction, motifSourceBar, cadence, targetPc, targetStep, energy, dynamic,
      restStart, sustainedEntry, longToneStep,
      registerOffset: registerOffsets[sectionIndex] ?? 0,
    });
  }
  return { climaxBar, signatureLeapBar, bars };
}

interface RealizedIntro {
  chords: ChordEvent[];
  melody: NoteEvent[];
  bass: NoteEvent[];
  drums: DrumEvent[];
  chordNames: string[];
}

/** SongPlanの導入意図を、本編Aへの声部接続を見ながら実イベントへする。 */
function realizeIntro(
  plan: SongPlan['intro'],
  bodyChords: readonly ChordEvent[],
  bodyMelody: readonly NoteEvent[],
  style: StyleDef,
  keyRoot: number,
  scalePcs: readonly number[],
  melodicLanguage: MelodicLanguage,
  grooveFeel: GrooveFeel,
): RealizedIntro {
  if (!plan.enabled || plan.bars === 0) {
    return { chords: [], melody: [], bass: [], drums: [], chordNames: [] };
  }
  const firstBodyChord = bodyChords[0]!;
  const bodyMotif = bodyMelody.filter((note) => note.beat < 4 && note.role !== 'ornament');
  const firstLead = bodyMotif[0] ?? bodyMelody[0]!;
  const endBeat = 8 - plan.breakBeats;
  const chords: ChordEvent[] = [];
  const chordNames = plan.barPlans.map((barPlan) => (
    barPlan.tokens.map((token) => chordName(token, keyRoot)).join(' ')
  ));

  for (const barPlan of plan.barPlans) {
    let offset = 0;
    barPlan.tokens.forEach((token, index) => {
      const def = CHORDS[token]!;
      const pcs = def.tones.map((tone) => (tone + keyRoot) % 12);
      const dur = barPlan.durations[index]!;
      chords.push({
        beat: barPlan.bar * 4 + offset,
        dur,
        token,
        name: chordName(token, keyRoot),
        function: harmonicFunctionForToken(token),
        pcs,
        midis: [],
      });
      offset += dur;
    });
  }
  // A冒頭から逆向きに最短距離ボイシングを選び、イントロ末尾を実際の入口へ接続する。
  let nextVoicing: number[] | null = firstBodyChord.midis;
  for (let index = chords.length - 1; index >= 0; index--) {
    const chord = chords[index]!;
    chord.midis = voiceChord(chord.pcs, nextVoicing, melodicLanguage === 'japanese');
    nextVoicing = chord.midis;
  }
  const chordAt = (beat: number): ChordEvent => {
    let current = chords[0]!;
    for (const chord of chords) {
      if (chord.beat <= beat) current = chord;
      else break;
    }
    return current;
  };
  const melodicPcs = (chord: ChordEvent): readonly number[] => {
    const modal = chord.pcs.filter((pc) => scalePcs.includes(pc));
    return melodicLanguage === 'japanese' && modal.length > 0 ? modal : chord.pcs;
  };

  const melody: NoteEvent[] = [];
  const pushLead = (
    logicalBeat: number,
    dur: number,
    targetMidi: number,
    velocity: number,
    articulation: NoteArticulation = 'normal',
  ) => {
    const beat = grooveBeat(logicalBeat, grooveFeel);
    const available = endBeat - beat;
    if (available < 0.08) return;
    const inBar = ((logicalBeat % 4) + 4) % 4;
    const chord = chordAt(logicalBeat);
    const strong = Math.abs(inBar) < 0.001 || Math.abs(inBar - 2) < 0.001;
    const midi = strong
      ? nearestWithPc(targetMidi, melodicPcs(chord))
      : nearestWithPc(targetMidi, scalePcs);
    melody.push({
      beat,
      dur: Math.min(dur, available),
      midi,
      velocity,
      articulation: strong ? 'accent' : articulation,
      role: 'structural',
    });
  };

  for (const barPlan of plan.barPlans) {
    const barStart = barPlan.bar * 4;
    if (barPlan.leadGesture === 'motifFragment') {
      // Aの冒頭から特徴的な3〜4音だけを同じ音程関係で抜き出し、未完のまま提示する。
      for (const source of bodyMotif.slice(0, Math.min(4, bodyMotif.length))) {
        pushLead(source.beat, Math.min(0.65, source.dur * 0.8), source.midi, 0.58);
      }
    } else if (barPlan.leadGesture === 'motifAnswer') {
      const sources = bodyMotif.slice(0, 3);
      const onsets = [barStart, barStart + 1.5, Math.max(barStart + 2, endBeat - 0.5)];
      let previous = nearestWithPc(sources[0]?.midi ?? firstLead.midi, melodicPcs(chordAt(barStart)));
      onsets.forEach((onset, index) => {
        if (index > 0 && index < onsets.length - 1) {
          const before = sources[index - 1];
          const source = sources[index];
          const interval = before && source ? source.midi - before.midi : 2;
          previous = nearestWithPc(previous + interval, scalePcs);
        }
        if (index === onsets.length - 1) previous = stepOnScale(firstLead.midi, -1, scalePcs);
        const next = onsets[index + 1] ?? endBeat;
        pushLead(onset, Math.min(0.6, (next - onset) * 0.65), previous, 0.64);
      });
    } else if (barPlan.leadGesture === 'pickup') {
      const onsets = [barStart + 2, barStart + 2.5, barStart + 3, barStart + 3.5];
      const pitches = Array<number>(onsets.length);
      pitches[pitches.length - 1] = stepOnScale(firstLead.midi, -1, scalePcs);
      for (let index = pitches.length - 2; index >= 0; index--) {
        pitches[index] = stepOnScale(pitches[index + 1]!, -1, scalePcs);
      }
      onsets.forEach((onset, index) => pushLead(onset, 0.32, pitches[index]!, 0.66, 'staccato'));
    } else if (barPlan.leadGesture === 'fanfareCall' || barPlan.leadGesture === 'fanfareAnswer') {
      const onsets = barPlan.leadGesture === 'fanfareCall'
        ? [barStart, barStart + 1, barStart + 2, barStart + 3]
        : [barStart, barStart + 1, barStart + 2];
      onsets.forEach((onset, index) => {
        const chord = chordAt(onset);
        const target = firstLead.midi - 5 + index * 3 + (barPlan.bar === 1 ? 2 : 0);
        pushLead(onset, index === onsets.length - 1 ? 0.72 : 0.48, nearestWithPc(target, melodicPcs(chord)), 0.78);
      });
    } else if (barPlan.leadGesture === 'heldCall') {
      pushLead(barStart, 1.4, nearestWithPc(firstLead.midi - 5, melodicPcs(chordAt(barStart))), 0.6, 'tenuto');
      pushLead(barStart + 2, 0.9, nearestWithPc(firstLead.midi - 2, melodicPcs(chordAt(barStart + 2))), 0.64, 'tenuto');
    } else if (barPlan.leadGesture === 'scaleRun') {
      const onsets = [barStart + 2.5, barStart + 2.75, barStart + 3, barStart + 3.25, barStart + 3.5, barStart + 3.75];
      const pitches = Array<number>(onsets.length);
      pitches[pitches.length - 1] = stepOnScale(firstLead.midi, -1, scalePcs);
      for (let index = pitches.length - 2; index >= 0; index--) {
        pitches[index] = stepOnScale(pitches[index + 1]!, -1, scalePcs);
      }
      onsets.forEach((onset, index) => pushLead(onset, 0.16, pitches[index]!, 0.68, 'staccato'));
    }
  }

  const bass: NoteEvent[] = [];
  const pushBass = (logicalBeat: number, dur: number, upper = false) => {
    if (logicalBeat >= endBeat) return;
    const chord = chordAt(logicalBeat);
    const def = CHORDS[chord.token]!;
    const rootPc = (def.root + keyRoot) % 12;
    const alternatePc = style.bass === 'rootFifth'
      ? chord.pcs[Math.min(2, chord.pcs.length - 1)]!
      : rootPc;
    const pc = upper ? alternatePc : rootPc;
    let midi = nearestWithPc(43, [pc], 36, 64);
    if (upper && style.bass === 'octave8' && midi + 12 <= 64) midi += 12;
    const beat = grooveBeat(logicalBeat, grooveFeel);
    bass.push({
      beat,
      dur: Math.min(dur, endBeat - beat),
      midi,
      velocity: 0.62,
      articulation: 'staccato',
      role: 'structural',
    });
  };
  for (const barPlan of plan.barPlans) {
    const start = barPlan.bar * 4;
    if (barPlan.bassGesture === 'pedal') {
      pushBass(start, 0.65);
      pushBass(start + 2, 0.55, true);
    } else if (barPlan.bassGesture === 'groove') {
      [0, 0.5, 1.5, 2, 2.5, 3.5].forEach((offset, index) => pushBass(start + offset, 0.28, index % 2 === 1));
    } else if (barPlan.bassGesture === 'stopForLead') {
      [0, 0.5, 1.5].forEach((offset, index) => pushBass(start + offset, 0.3, index % 2 === 1));
    } else if (barPlan.bassGesture === 'hits') {
      pushBass(start, 0.5);
      pushBass(start + 2, 0.5, true);
    } else if (barPlan.bassGesture === 'pickup') {
      pushBass(start, 0.45);
      pushBass(Math.min(start + 2, endBeat - 0.75), 0.35, true);
    }
  }

  const drums: DrumEvent[] = [];
  for (const barPlan of plan.barPlans) {
    const start = barPlan.bar * 4;
    const addDrum = (beat: number, inst: DrumEvent['inst']) => {
      if (beat < endBeat) drums.push({ beat, inst });
    };
    if (barPlan.drumGesture === 'groove') {
      for (let step = 0; step < 16; step++) {
        const beat = grooveBeat(start + step * 0.25, grooveFeel);
        if (style.kick[step]) addDrum(beat, 'kick');
        if (style.snare[step]) addDrum(beat, 'snare');
        if (grooveFeel !== 'tripletOverlay' && style.hat[step]) addDrum(beat, 'hat');
      }
      if (grooveFeel === 'tripletOverlay') {
        for (let quarter = 0; quarter < 4; quarter++) {
          for (const offset of tripletHatOffsets(style.hat, quarter)) addDrum(start + quarter + offset, 'hat');
        }
      }
    } else if (barPlan.drumGesture === 'accents') {
      addDrum(start, 'kick');
      addDrum(start, 'cymbal');
      addDrum(start + 2, 'snare');
    } else if (barPlan.drumGesture === 'fill') {
      addDrum(start, 'kick');
      addDrum(start + 2, 'snare');
      addDrum(start + 2.5, 'tom');
      addDrum(start + 3, 'tom');
      addDrum(start + 3.5, 'tom');
    } else if (barPlan.drumGesture === 'countIn') {
      [1, 2, 3, 3.5].forEach((offset) => addDrum(start + offset, 'hat'));
      addDrum(start + 2, 'kick');
      addDrum(start + 3.5, 'snare');
    }
  }
  return { chords, melody, bass, drums, chordNames };
}

export function compose(opts: ComposeOptions): Piece {
  const progression = PROGRESSIONS.find((p) => p.id === opts.progressionId);
  if (!progression) throw new Error(`未知の進行: ${opts.progressionId}`);
  const style = STYLES.find((s) => s.id === opts.styleId);
  if (!style) throw new Error(`未知のスタイル: ${opts.styleId}`);
  const tonality = resolveTonality(opts);
  const prog = progressionForTonality(progression, tonality);
  if (!prog) {
    throw new Error(`${tonality === 'minor' ? '短調' : '長調'}では進行「${progression.name}」を使用できません`);
  }
  const progBars = prog.slots.length;
  if (progBars > opts.bars) throw new Error(`進行(${progBars}小節)が尺(${opts.bars}小節)より長い`);

  const rng = new Xoshiro128(opts.seed >>> 0);
  const keyRoot = ((opts.keyRoot % 12) + 12) % 12;
  const melodicLanguage = resolveMelodicLanguage(opts);
  const melodyMode = legacyMelodyMode(tonality, melodicLanguage);
  const japanesePlan = melodicLanguage === 'japanese'
    ? japanesePlanFor(keyRoot, opts.japaneseScale ?? 'auto', opts.seed)
    : null;
  const scalePcs = japanesePlan?.scalePcs
    ?? (tonality === 'minor' ? NATURAL_MINOR_SCALE : MAJOR_SCALE).map((t) => (t + keyRoot) % 12);
  const grooveFeel = opts.grooveFeel ?? 'straight';
  const choice = opts.choice ?? (opts.bars >= 8
    ? chooseVariedHarmony(prog, opts.bars, opts.seed)
    : defaultChoiceFor(prog, opts.bars));
  const songPlan = createSongPlan({
    bars: opts.bars,
    seed: opts.seed,
    tonality,
    melodicLanguage,
    grooveFeel,
    soundChip: opts.soundChip ?? 'opll',
    progression: prog,
    style,
    choice,
    intro: opts.intro !== false,
    ...(opts.compositionStrategy ? { compositionStrategy: opts.compositionStrategy } : {}),
  });
  const arrangementPlan = arrangementPlanFor(opts.bars, opts.seed, opts.progressionId, songPlan);

  // --- SongPlanで確定した和声機能と変化位置を、実コードへ展開する。 ---
  const barTokens = songPlan.harmony.map((bar) => [...bar.tokens]);
  const barChordDurations = songPlan.harmony.map((bar) => [...bar.durations]);

  const chords: ChordEvent[] = [];
  let previousVoicing: number[] | null = null;
  barTokens.forEach((tokens, bar) => {
    let offset = 0;
    tokens.forEach((token, i) => {
      const dur = barChordDurations[bar]![i]!;
      const def = CHORDS[token]!;
      const pcs = def.tones.map((t) => (t + keyRoot) % 12);
      const midis = voiceChord(pcs, previousVoicing, melodicLanguage === 'japanese');
      chords.push({
        beat: bar * 4 + offset,
        dur,
        token,
        name: chordName(token, keyRoot),
        function: harmonicFunctionForToken(token),
        pcs,
        midis,
      });
      previousVoicing = midis;
      offset += dur;
    });
  });
  // ループ末尾→先頭も同じ声部進行として扱い、循環パスで配置を安定させる。
  for (let pass = 0; pass < 2; pass++) {
    let previous = chords.at(-1)?.midis ?? null;
    for (const chord of chords) {
      chord.midis = voiceChord(chord.pcs, previous, melodicLanguage === 'japanese');
      previous = chord.midis;
    }
  }
  const chordAt = (beat: number): ChordEvent => {
    let cur = chords[0]!;
    for (const c of chords) {
      if (c.beat <= beat) cur = c;
      else break;
    }
    return cur;
  };

  // --- PhrasePlan（旋律・副旋律・ベースが共有する設計図） ---
  const melodyPcsForChord = (chord: ChordEvent): readonly number[] => {
    const modalTones = chord.pcs.filter((pc) => scalePcs.includes(pc));
    if (melodicLanguage !== 'japanese' || modalTones.length === 0) return chord.pcs;
    // 核音はPhrasePlanの到達点で優先する。通常の強拍まで核音だけに絞ると、
    // コードによって使用可能音が1音になり旋律線が痩せるため、ここでは共通音をすべて使う。
    return modalTones;
  };
  const startMidi = nearestWithPc(76, melodyPcsForChord(chordAt(0)));
  const phrasePlan = makePhrasePlan(
    opts, style, rng, chordAt, startMidi, melodicLanguage, scalePcs, japanesePlan, arrangementPlan, songPlan,
  );
  // 区間ごとに別の音程ジェスチャーを持つ。リズムだけ変えて同じ上下動をA〜Eへ貼らない。
  const phraseGestures = songPlan.form.sections.map(() => makePhraseGesture(rng, style));
  const baseCenter = style.id === 'rock' ? 77 : style.id === 'ska' ? 79 : 78;
  const climaxChord = chordAt(phrasePlan.climaxBar * 4);
  const climaxMidi = nearestWithPc(
    MELODY_HI,
    // 五音とコードの共通音が1音しかない場合も、山だけはコード全体へ開いて
    // 十分な高さを確保する。和声上は安定し、以後の音域制限にも12音分の余地が残る。
    climaxChord.pcs,
  );

  // --- 主旋律（PhrasePlanの目標音へ向かうモチーフ展開） ---
  const melody: NoteEvent[] = [];
  const externalMotifTransformStates = new Map<string, {
    transpose: number;
    sourceAnchor: number;
    targetAnchor: number;
    transform: MotifTransform;
  }>();
  let prev = startMidi;
  let prevBeat = 0;
  let signatureLeapPending = false;
  let signatureStepBack: 1 | -1 | null = null;
  for (const barPlan of phrasePlan.bars) {
    const { bar } = barPlan;
    const barInSection = opts.bars >= 16 ? bar % 8 : bar;
    const phraseStepOffset = (barInSection % 2) * 8;
    const isAnswerVariation = Math.floor(barInSection / 2) % 2 === 1;
    const center = bar === phrasePlan.climaxBar
      ? MELODY_HI - 2
      : baseCenter + barPlan.energy - 2 + barPlan.registerOffset;
    const onsets: number[] = [];
    barPlan.rhythm.forEach((on, step) => on && onsets.push(step));
    const sectionDesign = songPlan.form.sections.find((section) => section.id === barPlan.section)!;
    const phraseGesture = phraseGestures[sectionDesign.index]!;
    const borrowsExternalMotif = barPlan.motifSourceBar < sectionDesign.startBar
      || barPlan.motifSourceBar >= sectionDesign.startBar + sectionDesign.bars;
    const externalTransformKey = borrowsExternalMotif
      ? `${sectionDesign.id}:${Math.floor(barInSection / 2)}`
      : null;
    const persistedTransform = externalTransformKey
      ? externalMotifTransformStates.get(externalTransformKey)
      : undefined;
    let motifTranspose: number | null = persistedTransform?.transpose ?? null;
    let motifSourceAnchor: number | null = persistedTransform?.sourceAnchor ?? null;
    let motifTargetAnchor: number | null = persistedTransform?.targetAnchor ?? null;
    let activeMotifTransform: MotifTransform = persistedTransform?.transform
      ?? (borrowsExternalMotif ? sectionDesign.motifTransform : 'transpose');

    for (let index = 0; index < onsets.length; index++) {
      const step = onsets[index]!;
      const logicalBeat = bar * 4 + step * 0.5;
      const beat = grooveBeat(logicalBeat, grooveFeel);
      const chord = chordAt(logicalBeat);
      const structuralPcs = melodyPcsForChord(chord);
      const strong = step === 0 || step === 4;
      let midi: number;
      if (bar === phrasePlan.climaxBar && step === 0) {
        midi = climaxMidi;
      } else if (barPlan.targetStep === step && barPlan.targetPc !== null) {
        // 応答小節は、先に決めた終止音へ実際に到達させる。
        if (barPlan.cadence === 'turnaround') {
          midi = nearestWithPc(startMidi, [barPlan.targetPc]);
        } else if (bar + 1 === phrasePlan.climaxBar) {
          midi = bridgeWithPc(prev, climaxMidi, [barPlan.targetPc], MELODY_LO, climaxMidi - 1);
        } else {
          midi = nearestWithPc(prev + Math.round((center - prev) / 2), [barPlan.targetPc]);
        }
      } else if (!strong && melody.length > 0 && !chordAt(prevBeat).pcs.includes(prev % 12)) {
        // 弱拍の非和声音は、次の音で順次解決して方向を明確にする。
        midi = stepOnScale(prev, center >= prev ? 1 : -1, scalePcs);
      } else if (step === 0 && barInSection % 2 === 0) {
        midi = nearestWithPc(center, structuralPcs);
      } else if (strong) {
        midi = nearestWithPc(prev + Math.round((center - prev) / 3), structuralPcs);
      } else {
        const move = phraseGesture[phraseStepOffset + step]!;
        let dir = move.direction;
        if (isAnswerVariation && phraseStepOffset + step >= 12) dir = dir === 1 ? -1 : 1;
        if (barPlan.phraseFunction === 'departure') dir = dir === 1 ? -1 : 1;
        const phraseStep = phraseStepOffset + step;
        if (melodicLanguage === 'japanese' && phraseStep % 4 === 3 && scalePcs.includes(prev % 12)) {
          midi = prev;
        } else if (move.stepwise) {
          const motionPcs = melodicLanguage === 'japanese' || scalePcs.includes(prev % 12) ? scalePcs : chord.pcs;
          midi = stepOnScale(prev, dir, motionPcs);
        } else {
          const leap = melodicLanguage === 'japanese' ? (move.leap % 2 === 0 ? 7 : 5) : move.leap;
          midi = nearestWithPc(prev + dir * leap, structuralPcs);
        }
      }
      const nextPlannedStep = index + 1 < onsets.length ? onsets[index + 1]! : null;
      const bridgesToCadence = (
        barPlan.cadence === 'turnaround'
        && barPlan.targetPc !== null
        && nextPlannedStep === barPlan.targetStep
      );
      if (bridgesToCadence) {
        const loopTarget = nearestWithPc(startMidi, [barPlan.targetPc!]);
        midi = bridgeWithPc(prev, loopTarget, strong ? chord.pcs : scalePcs);
      }
      const repeatsMotif = barPlan.motifSourceBar !== bar && (
        borrowsExternalMotif
        || barPlan.phraseFunction === 'restatement'
        || (barPlan.phraseFunction === 'conclusion' && step < 4)
      );
      if (
        repeatsMotif
        && !bridgesToCadence
        && barPlan.targetStep !== step
        && !(bar === phrasePlan.climaxBar && step === 0)
      ) {
        const sourceBeat = grooveBeat(barPlan.motifSourceBar * 4 + step * 0.5, grooveFeel);
        const source = melody.find((note) => (
          note.role !== 'ornament' && Math.abs(note.beat - sourceBeat) < 0.001
        ));
        if (source) {
          if (motifTranspose === null) {
            motifTranspose = midi - source.midi;
            motifSourceAnchor = source.midi;
            motifTargetAnchor = midi;
            const returnRegister = songPlan.compositionPolicy.melody.returnRegister;
            const appliesReturnRegister = borrowsExternalMotif
              && returnRegister !== null
              && sectionDesign.id === returnRegister.to
              && sectionDesign.motifSourceSection === returnRegister.from;
            if (appliesReturnRegister) {
              const lower = returnRegister.offset < 0
                ? MELODY_LO
                : Math.min(MELODY_HI, source.midi + 1);
              const upper = returnRegister.offset < 0
                ? Math.max(MELODY_LO, source.midi - 1)
                : MELODY_HI;
              const displacedAnchor = nearestWithPc(
                source.midi + returnRegister.offset,
                structuralPcs,
                lower,
                upper,
              );
              motifTargetAnchor = displacedAnchor;
              motifTranspose = displacedAnchor - source.midi;
            } else if (borrowsExternalMotif && motifTranspose === 0) {
              // 同じ和声上では移調も反転軸も同じ音に留まりやすい。別コードトーンへ核をずらし、
              // それも不可能な移調だけは輪郭反転へ切り替えて、名前だけの変奏を避ける。
              const direction = ((opts.seed >>> ((sectionDesign.index + 3) % 24)) & 1) === 0 ? -1 : 1;
              const displacedAnchor = nearestWithPc(midi + direction * 4, structuralPcs);
              if (displacedAnchor !== midi) {
                motifTargetAnchor = displacedAnchor;
                motifTranspose = displacedAnchor - source.midi;
              } else if (activeMotifTransform === 'transpose') {
                activeMotifTransform = 'invert';
              }
            }
            if (externalTransformKey && motifTranspose !== null) {
              externalMotifTransformStates.set(externalTransformKey, {
                transpose: motifTranspose,
                sourceAnchor: motifSourceAnchor,
                targetAnchor: motifTargetAnchor,
                transform: activeMotifTransform,
              });
            }
          }
          const allowedPcs = strong ? structuralPcs : scalePcs;
          const transformed = activeMotifTransform === 'invert'
            ? motifTargetAnchor! - (source.midi - motifSourceAnchor!)
            : source.midi + motifTranspose;
          midi = nearestWithPc(transformed, allowedPcs);
        }
      }
      // 署名跳躍: 旋律の常用域(中心±数半音)からは9半音超を音域内に収められないため、
      // 展開小節の頭を低い和声音の「踏み切り」にし、2音目で一度だけ上へ跳ぶ。直後は反行順次。
      let isSignatureLeapNote = false;
      if (bar === phrasePlan.signatureLeapBar && step === 0 && onsets.length >= 3) {
        // 踏み切りは音域最下部の和声音。ここからでないと9半音超をクライマックス未満に収められない。
        midi = nearestWithPc(MELODY_LO + 1, structuralPcs, MELODY_LO, MELODY_LO + 4);
        if (midi >= MELODY_LO) signatureLeapPending = true;
        else midi = nearestWithPc(center, structuralPcs);
      } else if (signatureLeapPending) {
        signatureLeapPending = false;
        const lo = prev + 10;
        const hi = Math.min(climaxMidi - 1, prev + 14);
        const leapMidi = hi >= lo ? nearestWithPc(hi, structuralPcs, lo, hi) : -1;
        const followUp = onsets[index + 1];
        // 直後を弱拍の順次で受け止められるときだけ跳ぶ（均衡跳躍をデバイス側で保証する）。
        const canBalance = followUp !== undefined && followUp !== 4;
        if (leapMidi >= lo && leapMidi <= hi && canBalance) {
          midi = leapMidi;
          isSignatureLeapNote = true;
          signatureStepBack = -1;
        }
      } else if (signatureStepBack !== null) {
        // 受け音が強拍に当たる場合は和声音で受ける（順次幅は広がるが強拍規則を守る）。
        midi = stepOnScale(prev, signatureStepBack, strong ? structuralPcs : scalePcs);
        signatureStepBack = null;
      }
      if (
        !(bar === phrasePlan.climaxBar && step === 0)
        && !(barPlan.cadence === 'turnaround' && step === barPlan.targetStep)
        && !isSignatureLeapNote
        && Math.abs(midi - prev) > 9
      ) {
        // 音級は保ちつつ近いオクターブを選び、偶発的な大跳躍を避ける。
        midi = nearestWithPc(prev, [midi % 12]);
      }
      if (opts.bars >= 16 && !(bar === phrasePlan.climaxBar && step === 0) && midi >= climaxMidi) {
        const allowedPcs = barPlan.targetStep === step && barPlan.targetPc !== null
          ? [barPlan.targetPc]
          : strong
            ? structuralPcs
            : scalePcs;
        midi = nearestWithPc(climaxMidi - 1, allowedPcs, MELODY_LO, climaxMidi - 1);
      }
      const intervalFromPrev = Math.abs(midi - prev);
      const stepwiseFromPrev = (intervalFromPrev >= 1 && intervalFromPrev <= 2)
        || (melodicLanguage === 'japanese'
          && intervalFromPrev >= 1 && intervalFromPrev <= 4
          && scalePcs.includes(((prev % 12) + 12) % 12)
          && scalePcs.includes(midi % 12));
      if (
        !strong
        && melody.length > 0
        && barPlan.targetStep !== step
        && !stepwiseFromPrev
        && !chordAt(prevBeat).pcs.includes(prev % 12)
        && !chord.pcs.includes(midi % 12)
      ) {
        // 直前の弱拍非和声音を宙に浮かせない。同音連打は順次進行で、跳躍は和声音で受けて解決する。
        if (intervalFromPrev === 0) {
          midi = stepOnScale(prev, center >= prev ? 1 : -1, scalePcs);
        } else {
          midi = nearestWithPc(midi, structuralPcs);
          if (Math.abs(midi - prev) > 9) midi = nearestWithPc(prev, [midi % 12]);
        }
      }
      const nextLeadStep = index + 1 < onsets.length ? onsets[index + 1]! : 8;
      const nextCounterStep = barPlan.counterSteps.find((counterStep) => counterStep > step) ?? 8;
      const nextOrnamentStep = barPlan.ornamentSteps
        .map((ornamentStep) => ornamentStep * 0.5)
        .find((ornamentStep) => ornamentStep > step) ?? 8;
      const boundaryStep = Math.min(nextLeadStep, nextCounterStep, nextOrnamentStep);
      const boundaryBeat = grooveBeat(bar * 4 + boundaryStep * 0.5, grooveFeel);
      // ロングトーン: 到達音を次小節の最初の発音（主旋律・副旋律・装飾のどれか）まで保続する。
      const nextBarPlan = phrasePlan.bars[bar + 1];
      const longToneBoundary = barPlan.longToneStep === step && nextBarPlan !== undefined
        ? (() => {
            const nextMelodyOnset = nextBarPlan.rhythm.findIndex((on) => on);
            const boundary = Math.min(
              nextMelodyOnset < 0 ? 8 : nextMelodyOnset,
              nextBarPlan.counterSteps[0] ?? 8,
              (nextBarPlan.ornamentSteps[0] ?? 16) * 0.5,
            );
            return grooveBeat((bar + 1) * 4 + boundary * 0.5, grooveFeel);
          })()
        : null;
      const articulation: NoteArticulation = barPlan.targetStep === step
        ? barPlan.ornamentType === 'shake' ? 'ornament' : 'tenuto'
        : bar === phrasePlan.climaxBar && step === 0
          ? 'accent'
          : strong
            ? 'accent'
            : style.id === 'ska'
              ? 'staccato'
              : style.id === 'rock' && boundaryStep - step >= 2
                ? 'tenuto'
                : 'normal';
      const gate = articulation === 'staccato'
        ? style.melody.gate * 0.65
        : articulation === 'tenuto'
          ? Math.max(style.melody.gate, 0.92)
          : style.melody.gate;
      const velocity = Math.min(1, barPlan.dynamic + (strong ? 0.08 : 0) + (articulation === 'accent' ? 0.08 : 0));
      melody.push({
        beat,
        dur: longToneBoundary !== null
          ? Math.max(0.1, longToneBoundary - beat)
          : Math.max(0.1, (boundaryBeat - beat) * gate),
        midi,
        velocity,
        articulation,
        ...(barPlan.targetStep === step && barPlan.ornamentType === 'shake'
          ? { ornament: barPlan.ornamentType }
          : {}),
        role: 'structural',
      });
      prev = midi;
      prevBeat = logicalBeat;
    }

    // 和風モードの装飾は独立した「飛び道具」ではなく、応答の到達音へ食い込む前打音として置く。
    for (let ornamentIndex = 0; ornamentIndex < barPlan.ornamentSteps.length; ornamentIndex++) {
      const ornamentStep = barPlan.ornamentSteps[ornamentIndex]!;
      const beat = grooveBeat(bar * 4 + ornamentStep * 0.25, grooveFeel);
      const targetBeat = grooveBeat(bar * 4 + barPlan.targetStep! * 0.5, grooveFeel);
      const target = melody.find((note) => Math.abs(note.beat - targetBeat) < 0.001);
      if (!target) continue;
      const baseDirection: 1 | -1 = ((bar + opts.seed) & 1) === 0 ? -1 : 1;
      const direction: 1 | -1 = barPlan.ornamentType === 'turn' && ornamentIndex === 1
        ? (baseDirection === 1 ? -1 : 1)
        : baseDirection;
      const midi = stepOnScale(target.midi, direction, scalePcs);
      melody.push({
        beat,
        dur: 0.18,
        midi,
        velocity: Math.max(0.35, barPlan.dynamic - 0.18),
        articulation: 'ornament',
        ...(barPlan.ornamentType ? { ornament: barPlan.ornamentType } : {}),
        role: 'ornament',
      });
    }
  }
  melody.sort((a, b) => a.beat - b.beat);

  // --- 副旋律（主旋律と同時に予約した空間へ、反行を優先して返答） ---
  const counterMelody: NoteEvent[] = [];
  let previousCounter: number | null = null;
  for (const barPlan of phrasePlan.bars) {
    if (barPlan.counterSteps.length === 0) continue;
    const barStart = barPlan.bar * 4;
    const barNotes = melody.filter((note) => note.beat >= barStart && note.beat < barStart + 4);
    let phraseAnchor: number | null = null;
    let pendingResolution: number | null = null;
    for (let index = 0; index < barPlan.counterSteps.length; index++) {
      const step = barPlan.counterSteps[index]!;
      const logicalBeat = barStart + step * 0.5;
      const beat = grooveBeat(logicalBeat, grooveFeel);
      const chord = chordAt(logicalBeat);
      const leadBefore = [...barNotes].reverse().find((note) => note.beat < beat);
      const leadBeforeBefore = leadBefore
        ? [...barNotes].reverse().find((note) => note.beat < leadBefore.beat)
        : undefined;
      const leadAfter = barNotes.find((note) => note.beat > beat);
      const leadMotion = (leadBefore?.midi ?? 74) - (leadBeforeBefore?.midi ?? leadBefore?.midi ?? 74);
      const contraryTarget = previousCounter === null
        ? (leadBefore?.midi ?? 74) - 7
        : previousCounter + (leadMotion > 0 ? -2 : leadMotion < 0 ? 2 : 0);
      const phraseDirection = ((barPlan.bar + opts.seed) & 1) === 0 ? 1 : -1;
      const shapedTarget = index === 0 || previousCounter === null
        ? contraryTarget
        : previousCounter + (index === barPlan.counterSteps.length - 1 ? -phraseDirection * 2 : phraseDirection * 3);
      let midi = nearestWithPc(shapedTarget, melodyPcsForChord(chord), COUNTER_LO, COUNTER_HI);
      if (barPlan.counterSteps.length >= 3 && index === 0) phraseAnchor = midi;
      if (barPlan.counterSteps.length >= 3 && index === 1 && phraseAnchor !== null) {
        // 三音句の中央だけに、必ず次のコードトーンへ解決する経過音または刺繍音を許す。
        // コードトーンだけのアルペジオへ戻らず、線として聞こえる最小限の非和声音にする。
        const directions: readonly (1 | -1)[] = [phraseDirection, phraseDirection === 1 ? -1 : 1];
        for (const direction of directions) {
          const middle = stepOnScale(phraseAnchor, direction, scalePcs);
          if (middle < COUNTER_LO || middle > COUNTER_HI) continue;
          const middlePc = middle % 12;
          if (chord.pcs.includes(middlePc)) continue;
          const forward = stepOnScale(middle, direction, scalePcs);
          midi = middle;
          pendingResolution = forward >= COUNTER_LO
            && forward <= COUNTER_HI
            && chord.pcs.includes(forward % 12)
            ? forward
            : phraseAnchor;
          break;
        }
      } else if (barPlan.counterSteps.length >= 3 && index === 2 && pendingResolution !== null) {
        midi = nearestWithPc(pendingResolution, melodyPcsForChord(chord), COUNTER_LO, COUNTER_HI);
      }
      const nextCounterBeat = barPlan.counterSteps[index + 1] !== undefined
        ? grooveBeat(barStart + barPlan.counterSteps[index + 1]! * 0.5, grooveFeel)
        : barStart + 4;
      const boundary = Math.min(leadAfter?.beat ?? barStart + 4, nextCounterBeat);
      const shortCounterPhrase = barPlan.counterSteps.length >= 3;
      const maxDur = arrangementPlan.counterRole === 'counterline'
        ? shortCounterPhrase ? 0.38 : (style.id === 'rock' ? 1.25 : 0.85)
        : (style.id === 'rock' ? 0.75 : 0.4);
      const dur = Math.min(maxDur, boundary - beat - 0.05);
      if (dur >= 0.15) {
        counterMelody.push({
          beat,
          dur,
          midi,
          velocity: Math.max(0.4, barPlan.dynamic - 0.12),
          articulation: shortCounterPhrase
            ? 'staccato'
            : arrangementPlan.counterRole === 'counterline' ? 'tenuto' : 'staccato',
          role: 'structural',
        });
        previousCounter = midi;
      }
    }
  }

  // --- ベース（スタイルの刻み + PhrasePlanの終止機能） ---
  const bass: NoteEvent[] = [];
  for (const c of chords) {
    // ペダル低音は進行名だけで常設せず、曲全体で低音主導を選んだ場合にだけ使う。
    const chordRootPc = (CHORDS[c.token]!.root + keyRoot) % 12;
    const rootPc = arrangementPlan.bassRole === 'pedal' ? keyRoot : chordRootPc;
    const root = opts.bars === 40
      ? nearestWithPc(40, [rootPc], 36, 47) // BIGはC2前後まで下げ、低音の土台を明確にする。
      : 40 + ((rootPc - 4 + 12) % 12); // 通常フォームは従来のE2..D#3帯。
    if (style.bass === 'rootFifth') {
      // 五度は和音の品質に追従する（dimは減5度、augは増5度）。機械的な+7で和声外に落とさない。
      const fifthPc = ([7, 6, 8] as const)
        .map((interval) => (rootPc + interval) % 12)
        .find((pc) => c.pcs.includes(pc));
      const fifthOffset = fifthPc === undefined ? 7 : (fifthPc - rootPc + 12) % 12;
      for (let b = 0; b < c.dur; b++) {
        bass.push({ beat: c.beat + b, dur: 0.9, midi: b % 2 === 0 ? root : root + fifthOffset });
      }
    } else {
      for (let e = 0; e < c.dur * 2; e++) {
        const midi = style.bass === 'octave8' && e % 2 === 1 ? root + 12 : root;
        const beat = grooveBeat(c.beat + e * 0.5, grooveFeel);
        const nextBeat = grooveBeat(c.beat + (e + 1) * 0.5, grooveFeel);
        bass.push({ beat, dur: Math.min(0.4, Math.max(0.18, (nextBeat - beat) * 0.8)), midi });
      }
    }
  }

  for (const barPlan of phrasePlan.bars) {
    const bar = barPlan.bar;
    const sectionIndex = opts.bars === 40
      ? Math.floor(bar / 8)
      : opts.bars === 16 ? Math.floor(bar / 8) : 0;
    const phraseGesture = phraseGestures[sectionIndex]!;
    const inBar = bass.filter((note) => note.beat >= bar * 4 && note.beat < (bar + 1) * 4);
    const last = inBar[inBar.length - 1];
    if (!last) continue;
    const endChord = chordAt((bar + 1) * 4 - 0.001);
    const endRootPc = (CHORDS[endChord.token]!.root + keyRoot) % 12;
    const nextChord = bar + 1 < opts.bars ? chordAt((bar + 1) * 4) : chordAt(0);
    const nextRootPc = (CHORDS[nextChord.token]!.root + keyRoot) % 12;
    if (barPlan.cadence === 'closed') {
      last.midi = nearestWithPc(last.midi, [endRootPc], 36, 64);
    } else if (barPlan.cadence === 'open') {
      last.midi = nearestWithPc(last.midi, [(endRootPc + 7) % 12], 36, 64);
    } else if (barPlan.cadence === 'half' || barPlan.cadence === 'turnaround') {
      if (melodicLanguage !== 'japanese' && style.bassCadence === 'chromatic') {
        const approachPc = (nextRootPc + (phraseGesture[15]!.direction === 1 ? 11 : 1)) % 12;
        last.midi = nearestWithPc(last.midi, [approachPc], 36, 64);
      } else if (melodicLanguage !== 'japanese' && style.bassCadence === 'chordTone') {
        const nextRootMidi = nearestWithPc(last.midi, [nextRootPc], 36, 64);
        last.midi = nearestWithPc(nextRootMidi, endChord.pcs, 36, 64);
      } else {
        const dir = phraseGesture[15]!.direction;
        let distance = 1;
        let approachPc = nextRootPc;
        while (distance < 12 && approachPc === nextRootPc) {
          const candidate = (nextRootPc - dir * distance + 120) % 12;
          if (scalePcs.includes(candidate)) approachPc = candidate;
          distance++;
        }
        const pickup: NoteEvent = {
          beat: grooveBeat(bar * 4 + 3.5, grooveFeel),
          dur: 0.35,
          midi: nearestWithPc(last.midi, [approachPc], 36, 64),
          velocity: Math.max(0.4, barPlan.dynamic - 0.1),
          articulation: 'staccato',
          role: 'structural',
        };
        if (last.beat < pickup.beat) bass.push(pickup);
        else last.midi = pickup.midi;
      }
    }
  }
  for (const note of bass) {
    const barPlan = phrasePlan.bars[Math.min(opts.bars - 1, Math.floor(note.beat / 4))]!;
    note.velocity = Math.min(1, barPlan.dynamic + (note.beat % 1 === 0 ? 0.06 : -0.05));
    note.articulation = style.id === 'rock' ? 'tenuto' : 'staccato';
    note.role = 'structural';
  }
  bass.sort((a, b) => a.beat - b.beat);

  // --- 分散和音（コード伴奏とは別の、選ばれた区間だけを推進する声部） ---
  // 曲全体のTextureStrategyで有効になった区間だけに置き、常設レイヤーにはしない。
  // chordAtを各打点で引くため、2拍目など小節途中のコード変化にもその場で追従する。
  const ostinato: NoteEvent[] = [];
  for (const barPlan of phrasePlan.bars) {
    const sectionIndex = opts.bars === 40
      ? Math.floor(barPlan.bar / 8)
      : opts.bars === 16 && barPlan.bar >= 8 ? 1 : 0;
    const plannedDensity = arrangementPlan.sections[sectionIndex]?.ostinatoDensity ?? 0;
    if (plannedDensity === 0) continue;
    const sectionPlan = arrangementPlan.sections[sectionIndex]!;
    const peak = sectionPlan.ostinatoPeak ?? 'departure';
    const activeFunctions: readonly PhraseFunction[] = peak === 'restatement'
      ? ['restatement', 'departure']
      : peak === 'departure'
        ? ['departure', 'conclusion']
        : ['conclusion'];
    // 8分型は選ばれたフレーズ帯だけに置き、区間丸ごとの常設を避ける。
    if (plannedDensity === 1 && !activeFunctions.includes(barPlan.phraseFunction)) continue;
    // 16分型の加速点もSongPlanに沿う区間ごとの候補から選び、毎回「展開」に固定しない。
    const density = plannedDensity === 2 && barPlan.phraseFunction === peak ? 2 : 1;
    const subdivision = density === 2 ? 0.25 : 0.5;
    const fullStepCount = density === 2 ? 16 : 8;
    const stepCount = barPlan.cadence === 'half' || barPlan.cadence === 'turnaround'
      ? fullStepCount - (density === 2 ? 4 : 2)
      : fullStepCount;
    const contour = [
      [0, 1, 2, 1],
      [0, 2, 1, 2],
      [2, 1, 0, 1],
      [0, 1, 2, 0],
    ][(barPlan.bar + sectionIndex + opts.seed) % 4]!;
    for (let step = 0; step < stepCount; step++) {
      const logicalBeat = barPlan.bar * 4 + step * subdivision;
      const chord = chordAt(logicalBeat);
      const rootPc = (CHORDS[chord.token]!.root + keyRoot) % 12;
      const rootMidi = nearestWithPc(60, [rootPc], 55, 67);
      const chordMidis = chord.pcs.map((pc) => nearestWithPc(rootMidi, [pc], rootMidi, rootMidi + 16));
      const contourIndex = Math.min(contour[step % contour.length]!, chordMidis.length - 1);
      const midi = chordMidis[contourIndex]!;
      // 16分アルペジオは均等に保ち、bounceの8分スウィングで打点順が詰まるのを避ける。
      const beat = density === 2 ? logicalBeat : grooveBeat(logicalBeat, grooveFeel);
      const nextLogicalBeat = logicalBeat + subdivision;
      const nextBeat = density === 2 ? nextLogicalBeat : grooveBeat(nextLogicalBeat, grooveFeel);
      ostinato.push({
        beat,
        dur: Math.max(0.1, (nextBeat - beat) * (density === 2 ? 0.66 : 0.58)),
        midi,
        velocity: Math.max(0.38, barPlan.dynamic - 0.2),
        articulation: 'staccato',
        role: 'structural',
      });
    }
  }

  // --- ドラム（16 分グリッドを小節数ぶん敷く） ---
  const drums: DrumEvent[] = [];
  for (let bar = 0; bar < opts.bars; bar++) {
    const barPlan = phrasePlan.bars[bar]!;
    const sectionIndex = opts.bars === 40 ? Math.floor(bar / 8) : opts.bars === 16 && bar >= 8 ? 1 : 0;
    const sectionPlan = arrangementPlan.sections[sectionIndex] ?? arrangementPlan.sectionA;
    const pattern = sectionPlan.drum === 'sectionB' ? style.sectionB : style;
    if (bar % 8 === 0 && sectionPlan.entrance === 'cymbal') {
      drums.push({ beat: bar * 4, inst: 'cymbal' });
    }
    const sectionTransition = opts.bars >= 16 && bar % 8 === 7 && bar !== opts.bars - 1;
    const hasFill = sectionTransition && sectionPlan.exitFill !== 'none';
    for (let s = 0; s < 16; s++) {
      const beat = grooveBeat(bar * 4 + s * 0.25, grooveFeel);
      if (hasFill && s >= 12) {
        if (sectionPlan.exitFill === 'full') {
          if (s === 12 && style.kick[s]) drums.push({ beat, inst: 'kick' });
          if (s === 12) drums.push({ beat, inst: 'snare' });
          if (s === 14) drums.push({ beat, inst: 'tom' });
          if (s === 15) drums.push({ beat, inst: 'cymbal' });
          if (grooveFeel !== 'tripletOverlay' && s === 13) drums.push({ beat, inst: 'hat' });
        } else {
          if (s === 12 && style.kick[s]) drums.push({ beat, inst: 'kick' });
          if (s === 14) drums.push({ beat, inst: 'snare' });
          if (grooveFeel !== 'tripletOverlay' && (s === 13 || s === 15)) drums.push({ beat, inst: 'hat' });
        }
        continue;
      }
      // 最終小節の最後の 1 拍を空け、B の勢いを整理してループ先の A を迎える。
      if (barPlan.cadence === 'turnaround' && s >= 12) continue;
      if (sectionPlan.drum === 'breakdown') {
        if (s === 0 || s === 8) drums.push({ beat, inst: 'kick' });
        if (s === 4 || s === 12) drums.push({ beat, inst: 'snare' });
        if (grooveFeel !== 'tripletOverlay' && (s === 2 || s === 6 || s === 10 || s === 14)) {
          drums.push({ beat, inst: 'hat' });
        }
        continue;
      }
      if (pattern.kick[s]) drums.push({ beat, inst: 'kick' });
      if (pattern.snare[s]) drums.push({ beat, inst: 'snare' });
      if (grooveFeel !== 'tripletOverlay' && pattern.hat[s]) drums.push({ beat, inst: 'hat' });
    }
    if (grooveFeel === 'tripletOverlay') {
      // 三連を常時ロールとして足さず、元のスタイル譜を三連位置へ写す。
      // A→Bフィルとループ直前は最終拍のハットを休ませ、スネアと余白を立てる。
      const quarters = barPlan.cadence === 'turnaround'
        || hasFill
        ? 3
        : 4;
      for (let quarter = 0; quarter < quarters; quarter++) {
        const offsets = sectionPlan.drum === 'breakdown'
          ? [2 / 3]
          : tripletHatOffsets(pattern.hat, quarter);
        for (const offset of offsets) drums.push({ beat: bar * 4 + quarter + offset, inst: 'hat' });
      }
    }
  }

  // --- SongPlanで本編より先に決めた、初回だけのイントロ（16/40小節フォーム） ---
  // 実音はAのモチーフと入口ボイシングが確定してから逆算し、最後に本編を後ろへずらす。
  const introBars = songPlan.intro.bars;
  const introRole = songPlan.intro.role;
  const loopStartBeat = introBars * 4;
  const realizedIntro = realizeIntro(
    songPlan.intro, chords, melody, style, keyRoot, scalePcs, melodicLanguage, grooveFeel,
  );
  const introChords = realizedIntro.chords;
  const introMelody = realizedIntro.melody;
  const introBass = realizedIntro.bass;
  const introDrums = realizedIntro.drums;
  const introChordNames = realizedIntro.chordNames;

  if (loopStartBeat > 0) {
    for (const event of chords) event.beat += loopStartBeat;
    for (const event of melody) event.beat += loopStartBeat;
    for (const event of counterMelody) event.beat += loopStartBeat;
    for (const event of ostinato) event.beat += loopStartBeat;
    for (const event of bass) event.beat += loopStartBeat;
    for (const event of drums) event.beat += loopStartBeat;
  }

  const editedMelody = withMelodyEdits([...introMelody, ...melody], opts.melodyEdits);

  return {
    bpm: opts.bpm,
    styleId: style.id,
    tonality,
    melodicLanguage,
    melodyMode,
    japanesePlan,
    grooveFeel,
    bars: opts.bars,
    introBars,
    introRole,
    loopStartBeat,
    beats: loopStartBeat + opts.bars * 4,
    keyRoot,
    chords: [...introChords, ...chords],
    melody: editedMelody,
    counterMelody,
    ostinato,
    bass: [...introBass, ...bass],
    drums: [...introDrums, ...drums],
    phrasePlan,
    songPlan,
    arrangementPlan,
    introChordNames,
    barChordNames: barTokens.map((tokens, bar) => {
      const equalDuration = 4 / tokens.length;
      return tokens.map((token, index) => {
        const duration = barChordDurations[bar]![index]!;
        const durationLabel = Math.abs(duration - equalDuration) > 0.001 ? `(${duration}拍)` : '';
        return `${chordName(token, keyRoot)}${durationLabel}`;
      }).join(' ');
    }),
  };
}
