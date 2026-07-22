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
import { CHORDS, MAJOR_SCALE, PROGRESSIONS, STYLES, YO_SCALE, chordName } from './theory.js';
import type { ProgressionDef, StyleDef } from './theory.js';

export type ComposeBars = 4 | 8 | 16;
export type MelodyMode = 'major' | 'japanese';
export type IntroRole = 'motif' | 'groove' | 'fanfare' | 'runup';
export type CadenceType = 'open' | 'half' | 'closed' | 'turnaround';
export type ArrangementArc = 'build' | 'contrast' | 'terrace' | 'compact';
export type CounterRole = 'response' | 'counterline';
export type NoteArticulation = 'normal' | 'staccato' | 'tenuto' | 'accent' | 'ornament';
export type HarmonicFunction = 'tonic' | 'predominant' | 'dominant' | 'colour';

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
};

export const COUNTER_ROLE_LABELS: Record<CounterRole, string> = {
  response: '短い応答',
  counterline: '独立対旋律',
};

export interface ComposeOptions {
  progressionId: string;
  styleId: string;
  /** キー主音のピッチクラス（0 = C） */
  keyRoot: number;
  bpm: number;
  /** 4 = RB / 8 = BB / 16 = ゲーム BGM。16 小節では 8 小節ずつ A → B に展開 */
  bars: ComposeBars;
  /** 16小節曲の先頭へ、初回だけ鳴る2小節イントロを付ける。省略時は有効。 */
  intro?: boolean;
  /** 省略時は従来どおりメジャー。japanese は陽旋法寄りの五音音階で弱拍を作る。 */
  melodyMode?: MelodyMode;
  seed: number;
  /** 全小節ぶんのスロット選択。省略時は defaultChoiceFor() */
  choice?: readonly number[];
  /**
   * OPLL 音色の上書き（1〜15。opll-core.ts の OPLL_VOICES）。省略時はスタイル既定。
   * compose() 自体は使わない編曲層のパラメータだが、曲の保存単位・BGM キャッシュの
   * キーが ComposeOptions の JSON なので、ここに持たせて「同じ曲 = 同じ音色」を保証する
   */
  voices?: VoiceOverride;
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
}

export interface NoteEvent {
  beat: number;
  dur: number;
  midi: number;
  /** 0..1。編曲層がチップ固有の音量段階へ変換する。 */
  velocity?: number;
  articulation?: NoteArticulation;
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
  inst: 'kick' | 'snare' | 'hat';
}

export interface PhraseBarPlan {
  bar: number;
  section: 'A' | 'B';
  role: 'statement' | 'answer' | 'continuation' | 'cadence';
  /** 8分グリッド上の主旋律発音位置。 */
  rhythm: boolean[];
  /** 主旋律と同時に確保した、副旋律専用の8分グリッド位置。 */
  counterSteps: number[];
  /** 16分グリッド上の短い装飾音位置。 */
  ornamentSteps: number[];
  cadence: CadenceType | null;
  /** フレーズが到達する音のピッチクラス。 */
  targetPc: number | null;
  targetStep: number | null;
  /** 0..5。音域・編成の起伏に使う。 */
  energy: number;
  /** 0..1。小節内の基準ダイナミクス。 */
  dynamic: number;
}

export interface PhrasePlan {
  climaxBar: number;
  bars: PhraseBarPlan[];
}

export interface ArrangementSectionPlan {
  backingDensity: 'sparse' | 'full';
  echo: boolean;
  drum: 'base' | 'sectionB' | 'breakdown';
  counterDensity: 0 | 1 | 2;
}

export interface ArrangementPlan {
  arc: ArrangementArc;
  counterRole: CounterRole;
  sectionA: ArrangementSectionPlan;
  sectionB: ArrangementSectionPlan;
}

export interface Piece {
  bpm: number;
  styleId: string;
  melodyMode: MelodyMode;
  /** ループ本体の小節数。introBars は含めない。 */
  bars: number;
  /** 初回だけ鳴るイントロの小節数。16小節フォーム以外は0。 */
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
  bass: NoteEvent[];
  drums: DrumEvent[];
  /** 全声部が共有する、フレーズ・終止・起伏の設計図。 */
  phrasePlan: PhrasePlan;
  /** A/Bの密度・エコー・対旋律の役割を決める編成設計。 */
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

/**
 * 進行を尺いっぱいに展開したときの定番スロット選択。
 * 2 周する場合、最終小節にドミナント(V)の選択肢があればそれを選び、
 * ループの頭（I など）へ引っ張る（A + A' の A' 側だけ変える定石）。
 */
export function defaultChoiceFor(prog: ProgressionDef, bars: number): number[] {
  const progBars = prog.slots.length;
  const rounds = Math.max(1, Math.floor(bars / progBars));
  const choice: number[] = [];
  for (let r = 0; r < rounds; r++) {
    for (let b = 0; b < progBars; b++) {
      let idx = prog.defaultChoice[b] ?? 0;
      if (rounds > 1 && r === rounds - 1 && b === progBars - 1) {
        const vIdx = prog.slots[b]!.findIndex((opt) => opt.length === 1 && opt[0] === 'V');
        if (vIdx >= 0) idx = vIdx;
      }
      choice.push(idx);
    }
  }
  return choice;
}

export interface ChoiceVariationOptions {
  /** 変化レシピを選ぶ確率。通常の自動変化は 25、専用ボタンは 100。 */
  chancePercent?: number;
  /** 専用ボタンで、現在表示中のレシピを抽選対象から外すために渡す。 */
  currentChoice?: readonly number[];
}

function expandedVariationsFor(prog: ProgressionDef, bars: ComposeBars): number[][] {
  if (bars === 16) {
    const sectionA = defaultChoiceFor(prog, 8);
    const withTurnaround = (choice: number[]): number[] => {
      const next = [...choice];
      const lastBar = next.length - 1;
      const slot = prog.slots[lastBar % prog.slots.length]!;
      // ループ頭へ最も強く戻れる選択肢を優先する。I7→IV も JTTou 進行の定番ターンアラウンド。
      const idx = slot.findIndex((option) => option.length === 1 && option[0] === 'V');
      const fallback = slot.findIndex((option) => option[option.length - 1] === 'V');
      const secondary = slot.findIndex((option) => option[option.length - 1] === 'I7');
      const selected = idx >= 0 ? idx : fallback >= 0 ? fallback : secondary;
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
  return a.length >= bars && b.length >= bars && Array.from({ length: bars }, (_, bar) => a[bar] === b[bar]).every(Boolean);
}

/** 現在とは異なる、カタログ登録済みの変化レシピがあるか。 */
export function hasVariedChoiceFor(
  prog: ProgressionDef,
  bars: ComposeBars,
  currentChoice: readonly number[] = defaultChoiceFor(prog, bars),
): boolean {
  return expandedVariationsFor(prog, bars).some((variation) => !choicesEqual(variation, currentChoice, bars));
}

/**
 * 定番進行または現在の進行から、音楽的に確認済みの変化レシピを 1 つ抽選する。
 * 4 小節進行を 8 小節へ展開する場合は、前半を定番のまま保って後半だけを A' にする。
 * 16 小節では前半 8 小節を A として固定し、後半 8 小節を B の変化レシピにする。
 * メロディ用 RNG とは別系列にし、同じ seed から常に同じ進行を再現する。
 */
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

  // 別系列と分かる固定 salt。4/8 小節は曲全体の 25%、16 小節は必ず B を展開する。
  const rng = new Xoshiro128((seed ^ 0x4348_4f52) >>> 0);
  const chance = Math.max(0, Math.min(100, options.chancePercent ?? (bars === 16 ? 100 : 25)));
  if (rng.nextInt(100) >= chance) return current;
  return [...candidates[rng.nextInt(candidates.length)]!];
}

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

function harmonicFunction(token: string): HarmonicFunction {
  if (['I', 'vi', 'vi7', 'iii', 'iii7'].includes(token)) return 'tonic';
  if (['IV', 'IVM7', 'ii', 'ii7'].includes(token)) return 'predominant';
  if (['V', 'III7', 'I7'].includes(token)) return 'dominant';
  return 'colour';
}

/** 16小節のA→Bを、常に「後半を足す」一択にしないための編成設計。 */
export function arrangementPlanFor(bars: ComposeBars, seed: number): ArrangementPlan {
  if (bars !== 16) {
    const compact: ArrangementSectionPlan = {
      backingDensity: 'full', echo: true, drum: 'base', counterDensity: 1,
    };
    return { arc: 'compact', counterRole: 'response', sectionA: compact, sectionB: compact };
  }

  const variants: readonly ArrangementPlan[] = [
    {
      arc: 'build',
      counterRole: 'response',
      sectionA: { backingDensity: 'sparse', echo: false, drum: 'base', counterDensity: 1 },
      sectionB: { backingDensity: 'full', echo: true, drum: 'sectionB', counterDensity: 2 },
    },
    {
      arc: 'contrast',
      counterRole: 'counterline',
      sectionA: { backingDensity: 'full', echo: false, drum: 'sectionB', counterDensity: 2 },
      sectionB: { backingDensity: 'sparse', echo: true, drum: 'breakdown', counterDensity: 1 },
    },
    {
      arc: 'terrace',
      counterRole: 'counterline',
      sectionA: { backingDensity: 'sparse', echo: true, drum: 'base', counterDensity: 1 },
      sectionB: { backingDensity: 'full', echo: false, drum: 'sectionB', counterDensity: 2 },
    },
  ];
  // 隣り合う2シードを同型にして、既存の曲変化ボタンで編成まで過敏に変わらないようにする。
  return variants[(seed >>> 1) % variants.length]!;
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
  melodyMode: MelodyMode,
  scalePcs: readonly number[],
  arrangementPlan: ArrangementPlan,
): PhrasePlan {
  const promptA = makeMotifRhythm(style, rng);
  const answerA = makeMotifRhythm(style, rng, promptA);
  const promptB = opts.bars === 16 ? makeMotifRhythm(style, rng, promptA) : promptA;
  const answerB = opts.bars === 16 ? makeMotifRhythm(style, rng, answerA) : answerA;
  const lateClimax = (opts.seed & 1) === 1;
  // 山は新しいフレーズを提示する小節頭へ置く。位置だけを前後2候補から選ぶ。
  const climaxBar = opts.bars === 16 ? (lateClimax ? 14 : 12) : opts.bars === 8 ? (lateClimax ? 6 : 4) : 2;
  const bars: PhraseBarPlan[] = [];

  for (let bar = 0; bar < opts.bars; bar++) {
    const section: 'A' | 'B' = opts.bars === 16 && bar >= 8 ? 'B' : 'A';
    const barInSection = section === 'B' ? bar - 8 : bar;
    const isAnswer = barInSection % 2 === 1;
    const rhythm = [...(section === 'B'
      ? (isAnswer ? answerB : promptB)
      : (isAnswer ? answerA : promptA))];
    const sectionPlan = section === 'B' ? arrangementPlan.sectionB : arrangementPlan.sectionA;
    let cadence: CadenceType | null = null;
    if (isAnswer) {
      if (bar === opts.bars - 1) cadence = 'turnaround';
      else if (opts.bars === 16 && bar === 7) cadence = 'half';
      else if (barInSection % 4 === 3) {
        const endingFunction = harmonicFunction(chordAt(bar * 4 + 3.99).token);
        cadence = endingFunction === 'dominant'
          ? 'half'
          : endingFunction === 'tonic'
            ? 'closed'
            : 'open';
      } else cadence = 'open';
    }

    const counterSteps: number[] = [];
    let targetStep: number | null = null;
    if (isAnswer) {
      if (cadence === 'turnaround') {
        for (let step = 5; step < 8; step++) rhythm[step] = false;
        rhythm[4] = true;
        targetStep = 4;
      } else if (opts.bars === 16 && bar === 7) {
        rhythm[6] = true;
        rhythm[7] = false;
        targetStep = 6;
      } else if (
        arrangementPlan.counterRole === 'response'
        && sectionPlan.counterDensity > 0
        && bar !== opts.bars - 1
        && (opts.bars !== 16 || sectionPlan.counterDensity === 2 || bar === 3)
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
      const targetPcs = melodyMode === 'japanese' && modalChordPcs.length > 0
        ? modalChordPcs
        : targetChord.pcs;
      if (cadence === 'open') targetPc = targetPcs.at(-1) ?? rootPc;
      else if (cadence === 'turnaround') targetPc = closestPcToMidi(startMidi, targetPcs);
      else targetPc = rootPc;
    }

    if (
      arrangementPlan.counterRole === 'counterline'
      && sectionPlan.counterDensity > 0
      && bar !== opts.bars - 1
      && !(opts.bars === 16 && bar === 7)
    ) {
      const preferred = sectionPlan.counterDensity === 2 ? [2, 6] : [bar % 2 === 0 ? 6 : 2];
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
    if (melodyMode === 'japanese' && isAnswer && targetStep !== null && targetStep > 0) {
      ornamentSteps.push(targetStep * 2 - 1);
    }

    const cycleEnergy = [1, 2, 3, 1][barInSection % 4]!;
    const sectionLift = section === 'B' && sectionPlan.backingDensity === 'full' ? 1 : 0;
    const energy = bar === climaxBar ? 5 : Math.min(4, cycleEnergy + sectionLift);
    const dynamic = Math.min(1, 0.58 + energy * 0.07 + (sectionPlan.backingDensity === 'full' ? 0.04 : 0));
    const role: PhraseBarPlan['role'] = cadence && cadence !== 'open'
      ? 'cadence'
      : isAnswer
        ? 'answer'
        : barInSection >= 4
          ? 'continuation'
          : 'statement';
    bars.push({
      bar, section, role, rhythm, counterSteps, ornamentSteps,
      cadence, targetPc, targetStep, energy, dynamic,
    });
  }
  return { climaxBar, bars };
}

interface IntroPlan {
  role: IntroRole;
  leadSteps: [number[], number[]];
  bassSteps: [number[], number[]];
}

const uniqueSorted = (steps: readonly number[]): number[] =>
  [...new Set(steps)].sort((a, b) => a - b);

/** Aの8分グリッドをイントロ応答の前半2.5拍へ縮め、不足する弱拍を補って密度を上げる。 */
function densifyIntroAnswer(bodySteps: readonly number[], count: number): number[] {
  const compressed = uniqueSorted(bodySteps.map((step) => Math.min(9, Math.round(step * 9 / 14))));
  if (!compressed.includes(0)) compressed.unshift(0);
  for (const step of [1, 3, 5, 7, 9, 2, 4, 6, 8]) {
    if (compressed.length >= count) break;
    if (!compressed.includes(step)) compressed.push(step);
  }
  return uniqueSorted(compressed).slice(0, count);
}

/** スタイルに馴染む役割だけを候補にし、シードから決定論的に選ぶ。 */
function chooseIntroRole(styleId: string, seed: number): IntroRole {
  const rolesByStyle: Record<string, readonly IntroRole[]> = {
    eurobeat: ['runup', 'motif', 'groove'],
    rock: ['fanfare', 'motif', 'runup'],
    ska: ['groove', 'motif', 'fanfare'],
  };
  const roles = rolesByStyle[styleId] ?? (['motif', 'groove', 'fanfare', 'runup'] as const);
  return roles[((seed ^ 0x494e_5452) >>> 0) % roles.length]!;
}

/** 役割を先に決め、本編Aの冒頭モチーフを変形して2小節の導入計画へする。 */
function makeIntroPlan(role: IntroRole, bodySteps: readonly number[], bassStyle: StyleDef['bass']): IntroPlan {
  const motifPrompt = uniqueSorted(bodySteps);
  const motifAnswer = densifyIntroAnswer(bodySteps, Math.min(10, Math.max(8, motifPrompt.length + 4)));
  const groovePrompt = uniqueSorted(bodySteps.map((step) => step === 0 || step === 8 ? step : Math.min(14, step + 1)));
  const grooveAnswer = densifyIntroAnswer(groovePrompt, Math.max(8, groovePrompt.length + 2));
  const grooveBass = bassStyle === 'rootFifth'
    ? [0, 3, 6, 8, 11, 14]
    : [0, 2, 4, 6, 8, 10, 12, 14];

  if (role === 'motif') {
    return {
      role,
      leadSteps: [motifPrompt, motifAnswer],
      bassSteps: [uniqueSorted([0, ...motifPrompt, 14]), densifyIntroAnswer(bodySteps, 9)],
    };
  }
  if (role === 'groove') {
    return {
      role,
      leadSteps: [groovePrompt, grooveAnswer],
      bassSteps: [grooveBass, densifyIntroAnswer(grooveBass, Math.max(8, grooveBass.length + 2))],
    };
  }
  if (role === 'fanfare') {
    return {
      role,
      leadSteps: [[0, 4, 8, 10, 12], [0, 1, 3, 4, 5, 7, 8, 9]],
      bassSteps: [[0, 4, 8, 12], [0, 2, 4, 6, 8]],
    };
  }
  return {
    role,
    leadSteps: [[0, 4, 6, 8, 10, 12], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
    bassSteps: [[0, 4, 8, 12], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
  };
}

export function compose(opts: ComposeOptions): Piece {
  const prog = PROGRESSIONS.find((p) => p.id === opts.progressionId);
  if (!prog) throw new Error(`未知の進行: ${opts.progressionId}`);
  const style = STYLES.find((s) => s.id === opts.styleId);
  if (!style) throw new Error(`未知のスタイル: ${opts.styleId}`);
  const progBars = prog.slots.length;
  if (progBars > opts.bars) throw new Error(`進行(${progBars}小節)が尺(${opts.bars}小節)より長い`);

  const rng = new Xoshiro128(opts.seed >>> 0);
  const keyRoot = ((opts.keyRoot % 12) + 12) % 12;
  const melodyMode = opts.melodyMode ?? 'major';
  const scalePcs = (melodyMode === 'japanese' ? YO_SCALE : MAJOR_SCALE).map((t) => (t + keyRoot) % 12);
  const arrangementPlan = arrangementPlanFor(opts.bars, opts.seed);
  const choice = opts.choice ?? defaultChoiceFor(prog, opts.bars);

  // --- コード進行の確定（スロット選択 → 小節ごとの実コード列） ---
  const barTokens: string[][] = [];
  for (let bar = 0; bar < opts.bars; bar++) {
    const slot = prog.slots[bar % progBars]!;
    const idx = Math.max(0, Math.min(slot.length - 1, choice[bar] ?? 0));
    barTokens.push([...slot[idx]!]);
  }

  const chords: ChordEvent[] = [];
  let previousVoicing: number[] | null = null;
  barTokens.forEach((tokens, bar) => {
    const dur = 4 / tokens.length;
    tokens.forEach((token, i) => {
      const def = CHORDS[token]!;
      const pcs = def.tones.map((t) => (t + keyRoot) % 12);
      const midis = voiceChord(pcs, previousVoicing, melodyMode === 'japanese');
      chords.push({
        beat: bar * 4 + i * dur,
        dur,
        token,
        name: chordName(token, keyRoot),
        function: harmonicFunction(token),
        pcs,
        midis,
      });
      previousVoicing = midis;
    });
  });
  // ループ末尾→先頭も同じ声部進行として扱い、循環パスで配置を安定させる。
  for (let pass = 0; pass < 2; pass++) {
    let previous = chords.at(-1)?.midis ?? null;
    for (const chord of chords) {
      chord.midis = voiceChord(chord.pcs, previous, melodyMode === 'japanese');
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
    return melodyMode === 'japanese' && modalTones.length > 0 ? modalTones : chord.pcs;
  };
  const startMidi = nearestWithPc(76, melodyPcsForChord(chordAt(0)));
  const phrasePlan = makePhrasePlan(
    opts, style, rng, chordAt, startMidi, melodyMode, scalePcs, arrangementPlan,
  );
  const phraseGesture = makePhraseGesture(rng, style);
  const baseCenter = style.id === 'rock' ? 77 : style.id === 'ska' ? 79 : 78;
  const climaxMidi = nearestWithPc(
    MELODY_HI,
    melodyPcsForChord(chordAt(phrasePlan.climaxBar * 4)),
  );

  // --- 主旋律（PhrasePlanの目標音へ向かうモチーフ展開） ---
  const melody: NoteEvent[] = [];
  let prev = startMidi;
  let prevBeat = 0;
  for (const barPlan of phrasePlan.bars) {
    const { bar } = barPlan;
    const barInSection = barPlan.section === 'B' ? bar - 8 : bar;
    const phraseStepOffset = (barInSection % 2) * 8;
    const isAnswerVariation = Math.floor(barInSection / 2) % 2 === 1;
    const center = bar === phrasePlan.climaxBar
      ? MELODY_HI - 2
      : baseCenter + barPlan.energy - 2;
    const onsets: number[] = [];
    barPlan.rhythm.forEach((on, step) => on && onsets.push(step));

    for (let index = 0; index < onsets.length; index++) {
      const step = onsets[index]!;
      const beat = bar * 4 + step * 0.5;
      const chord = chordAt(beat);
      const structuralPcs = melodyPcsForChord(chord);
      const strong = step === 0 || step === 4;
      let midi: number;
      if (bar === phrasePlan.climaxBar && step === 0) {
        midi = nearestWithPc(MELODY_HI, structuralPcs);
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
        if (barPlan.section === 'B' && phraseStepOffset + step >= 8) dir = dir === 1 ? -1 : 1;
        const phraseStep = phraseStepOffset + step;
        if (melodyMode === 'japanese' && phraseStep % 4 === 3 && scalePcs.includes(prev % 12)) {
          midi = prev;
        } else if (move.stepwise) {
          const motionPcs = melodyMode === 'japanese' || scalePcs.includes(prev % 12) ? scalePcs : chord.pcs;
          midi = stepOnScale(prev, dir, motionPcs);
        } else {
          const leap = melodyMode === 'japanese' ? (move.leap % 2 === 0 ? 7 : 5) : move.leap;
          midi = nearestWithPc(prev + dir * leap, structuralPcs);
        }
      }
      const nextPlannedStep = index + 1 < onsets.length ? onsets[index + 1]! : null;
      if (
        barPlan.cadence === 'turnaround'
        && barPlan.targetPc !== null
        && nextPlannedStep === barPlan.targetStep
      ) {
        const loopTarget = nearestWithPc(startMidi, [barPlan.targetPc]);
        midi = bridgeWithPc(prev, loopTarget, strong ? chord.pcs : scalePcs);
      }
      if (
        !(bar === phrasePlan.climaxBar && step === 0)
        && !(barPlan.cadence === 'turnaround' && step === barPlan.targetStep)
        && Math.abs(midi - prev) > 9
      ) {
        // 音級は保ちつつ近いオクターブを選び、偶発的な大跳躍を避ける。
        midi = nearestWithPc(prev, [midi % 12]);
      }
      if (opts.bars === 16 && !(bar === phrasePlan.climaxBar && step === 0) && midi >= climaxMidi) {
        const allowedPcs = barPlan.targetStep === step && barPlan.targetPc !== null
          ? [barPlan.targetPc]
          : strong
            ? structuralPcs
            : scalePcs;
        midi = nearestWithPc(climaxMidi - 1, allowedPcs, MELODY_LO, climaxMidi - 1);
      }
      const nextLeadStep = index + 1 < onsets.length ? onsets[index + 1]! : 8;
      const nextCounterStep = barPlan.counterSteps.find((counterStep) => counterStep > step) ?? 8;
      const nextOrnamentStep = barPlan.ornamentSteps
        .map((ornamentStep) => ornamentStep * 0.5)
        .find((ornamentStep) => ornamentStep > step) ?? 8;
      const boundaryStep = Math.min(nextLeadStep, nextCounterStep, nextOrnamentStep);
      const articulation: NoteArticulation = barPlan.targetStep === step
        ? 'tenuto'
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
        dur: Math.max(0.1, (boundaryStep - step) * 0.5 * gate),
        midi,
        velocity,
        articulation,
        role: 'structural',
      });
      prev = midi;
      prevBeat = beat;
    }

    // 和風モードの装飾は独立した「飛び道具」ではなく、応答の到達音へ食い込む前打音として置く。
    for (const ornamentStep of barPlan.ornamentSteps) {
      const beat = bar * 4 + ornamentStep * 0.25;
      const targetBeat = beat + 0.25;
      const target = melody.find((note) => Math.abs(note.beat - targetBeat) < 0.001);
      if (!target) continue;
      const direction: 1 | -1 = ((bar + opts.seed) & 1) === 0 ? -1 : 1;
      const midi = stepOnScale(target.midi, direction, scalePcs);
      melody.push({
        beat,
        dur: 0.18,
        midi,
        velocity: Math.max(0.35, barPlan.dynamic - 0.18),
        articulation: 'ornament',
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
    for (let index = 0; index < barPlan.counterSteps.length; index++) {
      const step = barPlan.counterSteps[index]!;
      const beat = barStart + step * 0.5;
      const chord = chordAt(beat);
      const leadBefore = [...barNotes].reverse().find((note) => note.beat < beat);
      const leadBeforeBefore = leadBefore
        ? [...barNotes].reverse().find((note) => note.beat < leadBefore.beat)
        : undefined;
      const leadAfter = barNotes.find((note) => note.beat > beat);
      const leadMotion = (leadBefore?.midi ?? 74) - (leadBeforeBefore?.midi ?? leadBefore?.midi ?? 74);
      const contraryTarget = previousCounter === null
        ? (leadBefore?.midi ?? 74) - 7
        : previousCounter + (leadMotion > 0 ? -2 : leadMotion < 0 ? 2 : 0);
      const midi = nearestWithPc(contraryTarget, melodyPcsForChord(chord), COUNTER_LO, COUNTER_HI);
      const nextCounterBeat = barPlan.counterSteps[index + 1] !== undefined
        ? barStart + barPlan.counterSteps[index + 1]! * 0.5
        : barStart + 4;
      const boundary = Math.min(leadAfter?.beat ?? barStart + 4, nextCounterBeat);
      const maxDur = arrangementPlan.counterRole === 'counterline'
        ? (style.id === 'rock' ? 1.25 : 0.85)
        : (style.id === 'rock' ? 0.75 : 0.4);
      const dur = Math.min(maxDur, boundary - beat - 0.05);
      if (dur >= 0.15) {
        counterMelody.push({
          beat,
          dur,
          midi,
          velocity: Math.max(0.4, barPlan.dynamic - 0.12),
          articulation: arrangementPlan.counterRole === 'counterline' ? 'tenuto' : 'staccato',
          role: 'structural',
        });
        previousCounter = midi;
      }
    }
  }

  // --- ベース（スタイルの刻み + PhrasePlanの終止機能） ---
  const bass: NoteEvent[] = [];
  for (const c of chords) {
    const rootPc = (CHORDS[c.token]!.root + keyRoot) % 12;
    const root = 40 + ((rootPc - 4 + 12) % 12); // E2..D#3 帯
    if (style.bass === 'rootFifth') {
      for (let b = 0; b < c.dur; b++) {
        bass.push({ beat: c.beat + b, dur: 0.9, midi: b % 2 === 0 ? root : root + 7 });
      }
    } else {
      for (let e = 0; e < c.dur * 2; e++) {
        const midi = style.bass === 'octave8' && e % 2 === 1 ? root + 12 : root;
        bass.push({ beat: c.beat + e * 0.5, dur: 0.4, midi });
      }
    }
  }

  for (const barPlan of phrasePlan.bars) {
    const bar = barPlan.bar;
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
      if (melodyMode !== 'japanese' && style.bassCadence === 'chromatic') {
        const approachPc = (nextRootPc + (phraseGesture[15]!.direction === 1 ? 11 : 1)) % 12;
        last.midi = nearestWithPc(last.midi, [approachPc], 36, 64);
      } else if (melodyMode !== 'japanese' && style.bassCadence === 'chordTone') {
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
          beat: bar * 4 + 3.5,
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

  // --- ドラム（16 分グリッドを小節数ぶん敷く） ---
  const drums: DrumEvent[] = [];
  for (let bar = 0; bar < opts.bars; bar++) {
    const barPlan = phrasePlan.bars[bar]!;
    const sectionPlan = barPlan.section === 'B' ? arrangementPlan.sectionB : arrangementPlan.sectionA;
    const pattern = sectionPlan.drum === 'sectionB' ? style.sectionB : style;
    for (let s = 0; s < 16; s++) {
      const beat = bar * 4 + s * 0.25;
      if (barPlan.cadence === 'half' && barPlan.section === 'A' && s >= 12) {
        // Aの半終止だけを細かくし、次のBセクションを予告する。
        if (s === 12 && style.kick[s]) drums.push({ beat, inst: 'kick' });
        if (s === 12 || s === 14 || s === 15) drums.push({ beat, inst: 'snare' });
        if (s === 13 || s === 15) drums.push({ beat, inst: 'hat' });
        continue;
      }
      // 最終小節の最後の 1 拍を空け、B の勢いを整理してループ先の A を迎える。
      if (barPlan.cadence === 'turnaround' && s >= 12) continue;
      if (sectionPlan.drum === 'breakdown') {
        if (s === 0 || s === 8) drums.push({ beat, inst: 'kick' });
        if (s === 4 || s === 12) drums.push({ beat, inst: 'snare' });
        if (s === 2 || s === 6 || s === 10 || s === 14) drums.push({ beat, inst: 'hat' });
        continue;
      }
      if (pattern.kick[s]) drums.push({ beat, inst: 'kick' });
      if (pattern.snare[s]) drums.push({ beat, inst: 'snare' });
      if (pattern.hat[s]) drums.push({ beat, inst: 'hat' });
    }
  }

  // --- 初回だけのイントロ（16小節フォーム） ---
  // ループ本体は従来どおり0拍から組み立て、最後に丸ごと後ろへずらす。
  // 本編Aのモチーフとスタイルから役割別の導入を作り、拍グリッド上の間を空けてAへ入る。
  const introBars = opts.bars === 16 && opts.intro !== false ? 2 : 0;
  const introRole = introBars > 0 ? chooseIntroRole(style.id, opts.seed) : null;
  const loopStartBeat = introBars * 4;
  const introChords: ChordEvent[] = [];
  const introMelody: NoteEvent[] = [];
  const introBass: NoteEvent[] = [];
  const introDrums: DrumEvent[] = [];
  const introChordNames: string[] = [];

  if (introBars > 0) {
    const firstChord = chords[0]!;
    const firstLead = melody[0]!;
    const bodyMotifNotes = melody.filter((note) => note.beat < 4 && note.role !== 'ornament');
    const bodySteps = bodyMotifNotes.map((note) => Math.round(note.beat * 4));
    const introPlan = makeIntroPlan(introRole!, bodySteps, style.bass);
    const rootPc = (CHORDS[firstChord.token]!.root + keyRoot) % 12;
    const root = 40 + ((rootPc - 4 + 12) % 12);
    for (let bar = 0; bar < introBars; bar++) {
      const beat = bar * 4;
      // 2小節目のコード伴奏も1.5拍前で止め、全パート共通のブレイクにする。
      const dur = bar === introBars - 1 ? 2.5 : 4;
      introChords.push({ ...firstChord, beat, dur, pcs: [...firstChord.pcs], midis: [...firstChord.midis] });
      introChordNames.push(firstChord.name);
    }

    // 役割ごとにAのモチーフを予告・リズム化・ファンファーレ化・駆け上がり化する。
    const introChordPcs = melodyPcsForChord(firstChord);
    let introPrev = nearestWithPc(firstLead.midi - 7, introChordPcs);
    for (let bar = 0; bar < introBars; bar++) {
      const onsets = introPlan.leadSteps[bar]!;
      for (let index = 0; index < onsets.length; index++) {
        const step = onsets[index]!;
        const strong = step === 0 || step === 8;
        const sourceIndex = Math.min(
          bodyMotifNotes.length - 1,
          Math.floor(index * bodyMotifNotes.length / onsets.length),
        );
        const sourceMidi = bodyMotifNotes[sourceIndex]?.midi ?? firstLead.midi;
        let midi: number;
        if (introPlan.role === 'motif') {
          midi = nearestWithPc(sourceMidi - (bar === 0 ? 5 : 2), scalePcs);
        } else if (introPlan.role === 'groove') {
          const target = index % 2 === 0 ? sourceMidi - (bar === 0 ? 7 : 5) : introPrev;
          midi = nearestWithPc(target, introChordPcs);
        } else if (introPlan.role === 'fanfare') {
          const pc = introChordPcs[(index + bar) % introChordPcs.length]!;
          midi = nearestWithPc(firstLead.midi - 7 + (index % introChordPcs.length) * 2, [pc]);
        } else if (bar === 0 && index === 0) {
          midi = nearestWithPc(firstLead.midi - 12, introChordPcs);
        } else {
          midi = stepOnScale(introPrev, 1, scalePcs);
        }
        // 役割にかかわらず1・3拍目は和声の柱へ揃える。
        if (strong) midi = nearestWithPc(midi, introChordPcs);
        const nextStep = index + 1 < onsets.length ? onsets[index + 1]! : 16;
        // 応答末尾は6.5拍の手前で切り、拍グリッド上でAまで1.5拍の余白を取る。
        const dur = bar === 1 && index === onsets.length - 1
          ? 0.2
          : (nextStep - step) * 0.25 * 0.8;
        introMelody.push({
          beat: bar * 4 + step * 0.25,
          dur,
          midi,
          velocity: strong ? 0.78 : 0.65,
          articulation: strong ? 'accent' : introPlan.role === 'groove' ? 'staccato' : 'normal',
          role: 'structural',
        });
        introPrev = midi;
      }
    }

    // ベースの音程型は本編スタイルを引き継ぎ、イントロだけ別ジャンルになるのを避ける。
    const bassTargets = style.bass === 'octave8'
      ? [0, 12]
      : style.bass === 'rootFifth'
        ? [0, 7]
        : [0];
    for (let bar = 0; bar < introBars; bar++) {
      const onsets = introPlan.bassSteps[bar]!;
      for (let index = 0; index < onsets.length; index++) {
        const step = onsets[index]!;
        const lastAnswerNote = bar === 1 && index === onsets.length - 1;
        introBass.push({
          beat: bar * 4 + step * 0.25,
          dur: lastAnswerNote ? 0.2 : bar === 0 ? 0.4 : 0.2,
          midi: nearestWithPc(root + bassTargets[index % bassTargets.length]!, firstChord.pcs, 36, 64),
          velocity: bar === 0 ? 0.64 : 0.72,
          articulation: 'staccato',
          role: 'structural',
        });
      }
    }

    // グルーヴ提示型だけは、本編と同じドラム語彙を薄く先出しする。
    if (introPlan.role === 'groove') {
      for (let bar = 0; bar < introBars; bar++) {
        introDrums.push({ beat: bar * 4, inst: 'kick' });
        for (let step = 0; step < 16; step++) {
          if (bar === 1 && step > 8) break;
          if (style.hat[step]) introDrums.push({ beat: bar * 4 + step * 0.25, inst: 'hat' });
        }
      }
    }
  }

  if (loopStartBeat > 0) {
    for (const event of chords) event.beat += loopStartBeat;
    for (const event of melody) event.beat += loopStartBeat;
    for (const event of counterMelody) event.beat += loopStartBeat;
    for (const event of bass) event.beat += loopStartBeat;
    for (const event of drums) event.beat += loopStartBeat;
  }

  return {
    bpm: opts.bpm,
    styleId: style.id,
    melodyMode,
    bars: opts.bars,
    introBars,
    introRole,
    loopStartBeat,
    beats: loopStartBeat + opts.bars * 4,
    keyRoot,
    chords: [...introChords, ...chords],
    melody: [...introMelody, ...melody],
    counterMelody,
    bass: [...introBass, ...bass],
    drums: [...introDrums, ...drums],
    phrasePlan,
    arrangementPlan,
    introChordNames,
    barChordNames: barTokens.map((tokens) => tokens.map((t) => chordName(t, keyRoot)).join(' ')),
  };
}

export interface Violation {
  beat: number;
  midi: number;
  reason: string;
}

export type DiagnosticCategory =
  | 'harmony'
  | 'melody'
  | 'voiceLeading'
  | 'rhythm'
  | 'counterpoint'
  | 'form'
  | 'loop';

export interface CompositionIssue extends Violation {
  category: DiagnosticCategory;
  severity: 'error' | 'warning';
}

export interface CompositionReport {
  overall: number;
  scores: Record<DiagnosticCategory, number>;
  issues: CompositionIssue[];
}

/**
 * 生成結果の多面的な作曲診断。合否だけでなく、和声・旋律・声部進行・
 * リズム・対旋律・フォーム・ループ接続を個別に採点する。
 */
export function diagnosePiece(piece: Piece): CompositionReport {
  const issues: CompositionIssue[] = [];
  const categories: DiagnosticCategory[] = [
    'harmony', 'melody', 'voiceLeading', 'rhythm', 'counterpoint', 'form', 'loop',
  ];
  const add = (
    category: DiagnosticCategory,
    severity: CompositionIssue['severity'],
    beat: number,
    midi: number,
    reason: string,
  ) => issues.push({ category, severity, beat, midi, reason });
  const chordAt = (beat: number): ChordEvent => {
    let cur = piece.chords[0]!;
    for (const c of piece.chords) {
      if (c.beat <= beat) cur = c;
      else break;
    }
    return cur;
  };
  const bodyStart = piece.loopStartBeat;
  for (const n of piece.melody) {
    if (n.midi < MELODY_LO || n.midi > MELODY_HI) {
      add('melody', 'error', n.beat, n.midi, '主旋律が音域外');
    }
    if (n.beat < 0 || n.dur <= 0 || n.beat + n.dur > piece.beats + 0.001) {
      add('rhythm', 'error', n.beat, n.midi, '主旋律の音価が曲の範囲外');
    }
    const inBar = n.beat % 4;
    if (inBar === 0 || inBar === 2) {
      const chord = chordAt(n.beat);
      if (!chord.pcs.includes(n.midi % 12)) {
        add('harmony', 'error', n.beat, n.midi, `強拍が ${chord.name} のコードトーン外`);
      }
    }
  }
  const bodyMelody = piece.melody.filter((note) => note.beat >= piece.loopStartBeat);
  for (let index = 1; index < bodyMelody.length; index++) {
    const previous = bodyMelody[index - 1]!;
    const current = bodyMelody[index]!;
    if (Math.abs(current.midi - previous.midi) > 9) {
      add('melody', 'warning', current.beat, current.midi, '主旋律の跳躍が9半音を超える');
    }
    const chord = chordAt(previous.beat);
    if (!chord.pcs.includes(previous.midi % 12)) {
      const resolvesByStep = Math.abs(current.midi - previous.midi) <= 2;
      const resolvesToHarmony = chordAt(current.beat).pcs.includes(current.midi % 12);
      if (!resolvesByStep && !resolvesToHarmony) {
        add('melody', 'warning', previous.beat, previous.midi, '非和声音の進行方向が不明瞭');
      }
    }
  }

  for (let index = 0; index < piece.chords.length; index++) {
    const chord = piece.chords[index]!;
    if (chord.midis.some((midi, voice) => voice > 0 && midi <= chord.midis[voice - 1]!)) {
      add('voiceLeading', 'error', chord.beat, chord.midis[0] ?? -1, `${chord.name} のボイシングが交差`);
    }
    const previous = piece.chords[index - 1];
    if (!previous || previous.beat < piece.loopStartBeat && chord.beat >= piece.loopStartBeat) continue;
    for (const voice of [1, 2]) {
      if (chord.midis[voice] === undefined || previous.midis[voice] === undefined) continue;
      if (Math.abs(chord.midis[voice]! - previous.midis[voice]!) > 7) {
        add('voiceLeading', 'warning', chord.beat, chord.midis[voice]!, '伴奏声部の移動が7半音を超える');
      }
    }
  }
  const loopChords = piece.chords.filter((chord) => chord.beat >= piece.loopStartBeat);
  if (loopChords.length > 1) {
    const firstChord = loopChords[0]!;
    const lastChord = loopChords.at(-1)!;
    for (const voice of [1, 2]) {
      if (firstChord.midis[voice] === undefined || lastChord.midis[voice] === undefined) continue;
      if (Math.abs(firstChord.midis[voice]! - lastChord.midis[voice]!) > 7) {
        add('voiceLeading', 'warning', lastChord.beat, lastChord.midis[voice]!, '伴奏のループ境界が7半音を超える');
      }
    }

    const directedTransitions = loopChords.filter((from, index) => {
      const to = loopChords[(index + 1) % loopChords.length]!;
      if (from.function === 'predominant' && to.function === 'dominant') return true;
      if (from.function === 'dominant' && (to.function === 'tonic' || to.function === 'predominant')) return true;
      if (from.function === 'tonic' && (to.function === 'predominant' || to.function === 'dominant')) return true;
      return (from.token === 'III7' && ['vi', 'vi7'].includes(to.token))
        || (from.token === 'I7' && ['IV', 'IVM7'].includes(to.token));
    }).length;
    if (directedTransitions === 0) {
      add('harmony', 'warning', firstChord.beat, -1, 'コード機能の方向づけが見えない');
    }
  }

  for (const n of piece.counterMelody) {
    if (n.midi < COUNTER_LO || n.midi > COUNTER_HI) {
      add('counterpoint', 'error', n.beat, n.midi, '副旋律が音域外');
    }
    const chord = chordAt(n.beat);
    if (!chord.pcs.includes(n.midi % 12)) {
      add('counterpoint', 'error', n.beat, n.midi, `副旋律が ${chord.name} のコードトーン外`);
    }
    if (piece.melody.some((lead) => lead.beat < n.beat + n.dur && n.beat < lead.beat + lead.dur)) {
      add('counterpoint', 'error', n.beat, n.midi, '主旋律と副旋律の発音が衝突');
    }
  }

  if (piece.phrasePlan.bars.length !== piece.bars) {
    add('form', 'error', bodyStart, -1, 'PhrasePlanと曲の小節数が一致しない');
  }
  for (const barPlan of piece.phrasePlan.bars) {
    const expectedSteps = barPlan.rhythm
      .map((on, step) => on ? step : -1)
      .filter((step) => step >= 0);
    const actualSteps = piece.melody
      .filter((note) => (
        note.role !== 'ornament'
        && note.beat >= bodyStart + barPlan.bar * 4
        && note.beat < bodyStart + (barPlan.bar + 1) * 4
      ))
      .map((note) => Math.round((note.beat - bodyStart - barPlan.bar * 4) * 2));
    if (expectedSteps.join(',') !== actualSteps.join(',')) {
      add('rhythm', 'error', bodyStart + barPlan.bar * 4, -1, `${barPlan.bar + 1}小節目がPhrasePlanのリズムと不一致`);
    }
    if (!actualSteps.includes(0) || !actualSteps.includes(4)) {
      add('rhythm', 'error', bodyStart + barPlan.bar * 4, -1, `${barPlan.bar + 1}小節目の強拍に主旋律がない`);
    }
    if (barPlan.targetStep === null || barPlan.targetPc === null) continue;
    const targetBeat = bodyStart + barPlan.bar * 4 + barPlan.targetStep * 0.5;
    const target = piece.melody.find((note) => Math.abs(note.beat - targetBeat) < 0.001);
    if (!target || target.midi % 12 !== barPlan.targetPc) {
      add('form', 'error', targetBeat, target?.midi ?? -1, `${barPlan.bar + 1}小節目が終止目標へ未到達`);
    }
    const targetChord = chordAt(targetBeat);
    if (barPlan.cadence === 'half' && targetChord.function !== 'dominant') {
      add('harmony', 'warning', targetBeat, target?.midi ?? -1, `${barPlan.bar + 1}小節目の半終止がドミナント機能ではない`);
    }
    if (barPlan.cadence === 'closed' && targetChord.function !== 'tonic') {
      add('harmony', 'warning', targetBeat, target?.midi ?? -1, `${barPlan.bar + 1}小節目の完全終止がトニック機能ではない`);
    }
  }

  for (let index = 0; index < piece.bass.length; index++) {
    const note = piece.bass[index]!;
    if (note.beat < piece.loopStartBeat) continue;
    const chord = chordAt(note.beat);
    if (chord.pcs.includes(note.midi % 12)) continue;
    const inBar = note.beat % 1;
    const next = piece.bass[index + 1] ?? piece.bass.find((candidate) => candidate.beat >= piece.loopStartBeat);
    const nextChordBeat = next === piece.bass[index + 1] ? next?.beat ?? note.beat : piece.loopStartBeat;
    const nextChord = chordAt(nextChordBeat);
    const nextRootPc = (CHORDS[nextChord.token]!.root + piece.keyRoot) % 12;
    if (inBar !== 0.5 || !next || next.midi % 12 !== nextRootPc) {
      add('harmony', 'warning', note.beat, note.midi, 'ベースの経過音が弱拍から次コードの根音へ解決していない');
    }
  }

  if (bodyMelody.length > 1) {
    const first = bodyMelody[0]!;
    const last = bodyMelody.at(-1)!;
    if (Math.abs(first.midi - last.midi) > 7) {
      add('loop', 'warning', last.beat, last.midi, '主旋律のループ境界が7半音を超える');
    }
  }
  const lastPlan = piece.phrasePlan.bars.at(-1);
  if (!lastPlan || lastPlan.cadence !== 'turnaround') {
    add('loop', 'error', piece.beats, -1, 'ループ終端にターンアラウンド設計がない');
  }

  const scores = Object.fromEntries(categories.map((category) => {
    const score = issues
      .filter((issue) => issue.category === category)
      .reduce((value, issue) => value - (issue.severity === 'error' ? 20 : 7), 100);
    return [category, Math.max(0, score)];
  })) as Record<DiagnosticCategory, number>;
  const overall = Math.round(categories.reduce((sum, category) => sum + scores[category], 0) / categories.length);
  return { overall, scores, issues };
}

/** 後方互換用の厳格検証。診断レポート中、生成上のエラーだけを返す。 */
export function validatePiece(piece: Piece): Violation[] {
  return diagnosePiece(piece).issues
    .filter((issue) => issue.severity === 'error')
    .map(({ beat, midi, reason }) => ({ beat, midi, reason }));
}
