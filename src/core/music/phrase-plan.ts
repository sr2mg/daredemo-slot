/**
 * フレーズ設計図（PhrasePlan）の生成。
 *
 * 実音を一切扱わない計画層: リズムモチーフ族・音程ジェスチャー・装飾計画・
 * ロングトーン/休符始まり/半小節タイ/弱起/倚音/テッシトゥーラ/署名跳躍という
 * 表現デバイスの抽選を行い、小節ごとの PhraseBarPlan を組む。
 *
 * 乱数の契約: 引数 rng は主系列（呼び出し順が保存曲の再現性契約）。
 * 各表現デバイスは主系列を消費せず、seed から派生した独立ストリームで決める。
 */

import { Xoshiro128 } from '../rng.js';
import type { Rng } from '../rng.js';
import { appoggiaturaRatePercent } from './melodic-theme.js';
import { barInSection, sectionIndexAt, totalBars } from './form.js';
import {
  DEFAULT_GROUPING, densityFor, gridFor, lastPulseStep, offPulseSteps, onsetWeightsFor, stepBeat,
} from './grid.js';
import type { GridDef } from './grid.js';
import { nearestWithPc } from './pitch.js';
import type { StyleDef } from './theory.js';
import type { MelodicIdiom } from './melodic-idiom.js';
import type {
  ArrangementPlan,
  BarGrouping,
  CadenceType,
  ChordEvent,
  ComposeInput,
  MelodicMotif,
  MotifMove,
  OrnamentType,
  PhraseBarPlan,
  PhrasePlan,
  RhythmFamilies,
  SongFormSpec,
  SongPlan,
} from './types.js';

export type PhraseMove = MotifMove;

/** 必須打点(小節頭とアンカー)以外のステップ。4x2 では [1,2,3,5,6,7]。 */
const optionalStepsOf = (grid: GridDef): number[] => (
  Array.from({ length: grid.steps }, (_, step) => step).filter((step) => step !== 0 && step !== grid.anchorStep)
);

/** スタイル固有の拍節アクセント(8分格子の宣言を格子へ写したもの)から、格子上のモチーフを作る。 */
function makeMotifRhythm(style: StyleDef, grid: GridDef, rng: Rng, contrastFrom?: readonly boolean[]): boolean[] {
  const optional = optionalStepsOf(grid);
  const weights = onsetWeightsFor(grid, style.melody.onsetWeights);
  const scored = optional.map((step) => {
    const roll = rng.nextInt(100);
    return { step, score: weights[step]! - roll, on: roll < weights[step]! };
  });
  const rhythm = Array.from({ length: grid.steps }, (_, step) => step === 0 || step === grid.anchorStep);
  for (const candidate of scored) rhythm[candidate.step] = candidate.on;

  const [minNotes, maxNotes] = densityFor(grid, style.melody.density);
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
  grid: GridDef,
  rng: Rng,
  previous: readonly (readonly boolean[])[],
): boolean[] {
  const rhythm = makeMotifRhythm(style, grid, rng, previous.at(-1));
  const equalsAny = (candidate: readonly boolean[]): boolean => previous.some(
    (known) => candidate.every((on, step) => on === known[step]),
  );
  if (!equalsAny(rhythm)) return rhythm;
  const optional = optionalStepsOf(grid);
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

/** 1つの割り方の5族([問い, 答え]×5)。主系列 rng の消費順は族の順(A..E)で固定。 */
function makeRhythmFamilies(style: StyleDef, grid: GridDef, rng: Rng): RhythmFamilies {
  const promptA = makeMotifRhythm(style, grid, rng);
  const answerA = makeMotifRhythm(style, grid, rng, promptA);
  const promptB = makeDistinctMotifRhythm(style, grid, rng, [promptA]);
  const answerB = makeDistinctMotifRhythm(style, grid, rng, [answerA]);
  const promptC = makeDistinctMotifRhythm(style, grid, rng, [promptA, promptB]);
  const answerC = makeDistinctMotifRhythm(style, grid, rng, [answerA, answerB]);
  const promptD = makeDistinctMotifRhythm(style, grid, rng, [promptA, promptB, promptC]);
  const answerD = makeDistinctMotifRhythm(style, grid, rng, [answerA, answerB, answerC]);
  const promptE = makeDistinctMotifRhythm(style, grid, rng, [promptA, promptB, promptC, promptD]);
  const answerE = makeDistinctMotifRhythm(style, grid, rng, [answerA, answerB, answerC, answerD]);
  return [
    [promptA, answerA],
    [promptB, answerB],
    [promptC, answerC],
    [promptD, answerD],
    [promptE, answerE],
  ];
}

/**
 * 外部モチーフを検証済みのジェスチャー列へ正規化する。壊れた保存データでも
 * compose() を決定論のまま完走させるため、欠けたステップは fallback で補う
 * (長さは fallback = 先頭区間の格子に従い、長い外部モチーフは切り詰める)。
 */
export function sanitizeMotif(motif: MelodicMotif, fallback: readonly PhraseMove[]): PhraseMove[] {
  return fallback.map((base, index) => {
    const move = motif.moves[index];
    if (!move) return { ...base };
    return {
      direction: move.direction === -1 ? -1 : 1,
      stepwise: move.stepwise === true,
      leap: Math.min(7, Math.max(3, Math.round(Number(move.leap) || 3))),
    };
  });
}

/**
 * 2 小節（格子ステップ×2、4x2 では 8 分 16 ステップ）ぶんの旋律ジェスチャー。
 * 実音ではなく「上行/下行・順次/跳躍」を保存し、コードが変わっても同じ動き方を再利用する。
 * 輪郭は 16 要素の宣言で、他の格子では位置比で伸ばす(抽選回数は 2×ステップ)。
 */
export function makePhraseGesture(rng: Rng, style: StyleDef, steps = 8): PhraseMove[] {
  const primary: 1 | -1 = rng.nextInt(2) === 0 ? 1 : -1;
  const contour = [1, 1, -1, 1, 1, -1, -1, -1, 1, -1, 1, 1, -1, -1, 1, -1] as const;
  const length = steps * 2;
  return Array.from({ length }, (_, index) => {
    const direction = contour[Math.floor((index * contour.length) / length)]!;
    return {
      direction: (direction * primary) as 1 | -1,
      stepwise: rng.nextInt(100) < style.melody.stepwisePercent,
      leap: 3 + rng.nextInt(3),
    };
  });
}
/**
 * 標準語法向けの控えめな装飾計画。16小節に0〜1個、終止付近の応答小節へ
 * grace/turn だけを置く（shake は和風の語彙として残す）。
 */
function sparseOrnamentPlanFor(bars: number, seed: number): Map<number, OrnamentType> {
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
function ornamentPlanFor(bars: number, seed: number): Map<number, OrnamentType> {
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
export function makePhrasePlan(
  opts: ComposeInput,
  form: SongFormSpec,
  style: StyleDef,
  rng: Rng,
  chordAt: (beat: number) => ChordEvent,
  startMidi: number,
  idiom: MelodicIdiom,
  arrangementPlan: ArrangementPlan,
  songPlan: SongPlan,
): PhrasePlan {
  const bars = totalBars(form);
  const sections = songPlan.form.sections;
  // リズム族は 4x2 の5族を従来どおり先に主系列 rng から引き、曲型に他の割り方があれば
  // 出現順に続けて引く(4x2 だけの曲型では消費列が不変)。
  const rhythmFamilies: Partial<Record<BarGrouping, RhythmFamilies>> = {
    [DEFAULT_GROUPING]: makeRhythmFamilies(style, gridFor(DEFAULT_GROUPING), rng),
  };
  for (const section of sections) {
    if (!rhythmFamilies[section.grouping]) {
      rhythmFamilies[section.grouping] = makeRhythmFamilies(style, gridFor(section.grouping), rng);
    }
  }
  const ornaments = idiom.ornamentDensity === 'dense'
    ? ornamentPlanFor(bars, opts.seed)
    : sparseOrnamentPlanFor(bars, opts.seed);
  const climaxBar = songPlan.form.climaxBar;
  const barPlans: PhraseBarPlan[] = [];

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
  const tieRng = new Xoshiro128((featureSeed ^ 0x414e_5443) >>> 0);
  const anacrusisRng = new Xoshiro128((featureSeed ^ 0x4143_5255) >>> 0);
  const appoggRng = new Xoshiro128((featureSeed ^ 0x4150_5047) >>> 0);

  // セクション別テッシトゥーラ: Aは主題の基準。以降の区間は±4半音まで変位し、対比を作る。
  const sectionCount = sections.length;
  const registerOffsets: number[] = Array.from({ length: sectionCount }, (_, index) => {
    if (index === 0) return 0;
    const choices = [-4, -2, 0, 2, 4] as const;
    return choices[registerRng.nextInt(choices.length)]!;
  });
  if (sectionCount > 1 && !registerOffsets.some((offset) => offset !== 0)) {
    registerOffsets[Math.max(1, sectionCount - 2)] = 3;
  }

  // 署名跳躍: 低音域の区間(谷の役割、無ければ2番目の区間)の展開頭で一度だけ許す9半音超の跳躍。
  // 高音域からは音域の天井とクライマックスの一意性を壊さずに跳べないため、谷から跳ぶ。
  let signatureLeapBar: number | null = null;
  if (sectionCount > 1 && leapRng.nextInt(100) < 60) {
    const leapSection = sections.find((section) => section.role === 'relief') ?? sections[1]!;
    const candidateBar = leapSection.startBar + 4;
    // 旋律を持たない区間(テクスチャ)には跳躍を置けない。
    if (candidateBar !== climaxBar && candidateBar < bars && leapSection.texture === 'normal') {
      signatureLeapBar = candidateBar;
    }
  }

  let pendingSustainEntry = false;
  let lastLongToneBar = -8;
  let lastTieBar = -8;
  let lastAnacrusisBar = -8;
  let lastAppoggiaturaBar = -8;
  let pendingAnacrusis = false;

  for (let bar = 0; bar < bars; bar++) {
    const sectionIndex = sectionIndexAt(form, bar);
    const sectionDesign = sections[sectionIndex]!;
    const section = sectionDesign.id;
    const grouping = sectionDesign.grouping;
    const grid = gridFor(grouping);
    const { anchorStep, steps } = grid;
    const lastPulse = lastPulseStep(grid);
    const offPulse = offPulseSteps(grid);
    const offsetInSection = barInSection(form, bar);
    const harmonyBar = songPlan.harmony[bar]!;
    const phraseFunction = harmonyBar.phraseFunction;
    const phraseIndex = (['statement', 'restatement', 'departure', 'conclusion'] as const)
      .indexOf(phraseFunction) as 0 | 1 | 2 | 3;
    const borrowsExternalMotif = sectionDesign.motifSourceSection !== null
      && sectionDesign.externalMotifPhrases.includes(phraseIndex);
    const sourceSection = borrowsExternalMotif
      ? songPlan.form.sections.find((candidate) => candidate.id === sectionDesign.motifSourceSection) ?? sectionDesign
      : sectionDesign;
    const sourcePhrase = sectionDesign.motifSourcePhrases[phraseIndex];
    const motifSourceBar = sourceSection.startBar + (sectionDesign.bars >= 8
      ? sourcePhrase * 2 + (offsetInSection % 2)
      : sourcePhrase);
    const isAnswer = offsetInSection % 2 === 1;
    const rhythmFamily = rhythmFamilies[grouping]![sectionDesign.phraseRhythmVariants[phraseIndex]]!;
    const sectionRhythm = rhythmFamily[isAnswer ? 1 : 0];
    const rhythm = [...sectionRhythm];
    const sectionPlan = arrangementPlan.sections[sectionIndex] ?? arrangementPlan.sections[0]!;
    const sectionBoundary = sectionCount > 1
      && offsetInSection === sectionDesign.bars - 1
      && bar !== bars - 1;
    const energy = harmonyBar.energy;
    // 谷区間（ドラムのブレイクダウン）は基準ダイナミクスの床を下げ、本当に静かな部分を作る。
    const dynamicFloor = sectionPlan.drum === 'breakdown' ? 0.46 : 0.58;
    const dynamic = Math.min(1, dynamicFloor + energy * 0.07 + (sectionPlan.backingDensity === 'full' ? 0.04 : 0));

    // テクスチャ区間: sustain は区間頭の 1 音を区間末尾まで保続、pulse は旋律を休ませる。
    // 表現デバイス(終止・対旋律・装飾・間・タイ・倚音・弱起)は持たず、前小節からの持ち越しも切る。
    if (sectionDesign.texture !== 'normal') {
      const holds = sectionDesign.texture === 'sustain' && offsetInSection === 0;
      pendingSustainEntry = false;
      pendingAnacrusis = false;
      barPlans.push({
        bar, section, grouping, role: 'statement',
        rhythm: Array.from({ length: steps }, (_, step) => holds && step === 0),
        counterSteps: [], ornamentSteps: [], ornamentType: null, maSteps: [],
        phraseFunction, motifSourceBar: bar, cadence: null, targetPc: null, targetStep: null,
        energy, dynamic, restStart: false, sustainedEntry: false, longToneStep: null, anchorTie: false,
        anacrusis: false, appoggiaturaStep: null, registerOffset: registerOffsets[sectionIndex] ?? 0,
        holdUntilBeat: holds ? (sectionDesign.startBar + sectionDesign.bars) * 4 : null,
      });
      continue;
    }
    const cadence = isAnswer ? harmonyBar.cadence : null;

    const counterSteps: number[] = [];
    let targetStep: number | null = null;
    if (isAnswer) {
      if (cadence === 'turnaround') {
        for (let step = anchorStep + 1; step < steps; step++) rhythm[step] = false;
        rhythm[anchorStep] = true;
        targetStep = anchorStep;
      } else if (sectionBoundary) {
        // 区間境界は最終拍頭で到達し、その後は空ける。
        rhythm[lastPulse] = true;
        for (let step = lastPulse + 1; step < steps; step++) rhythm[step] = false;
        targetStep = lastPulse;
      } else if (
        arrangementPlan.counterRole === 'response'
        && sectionPlan.counterDensity > 0
        && bar !== bars - 1
        // 薄い応答は各区間の中盤に一度。絶対4小節目へ固定するとB区間で鳴らなくなる。
        // 変奏反復(restatement)の答句はフックのリテラル反復を担うため空けない。
        && (sectionPlan.counterDensity === 2 || offsetInSection === (sectionDesign.bars === 4 ? 1 : 5))
      ) {
        for (let step = anchorStep + 1; step < steps; step++) rhythm[step] = false;
        rhythm[anchorStep] = true;
        targetStep = anchorStep;
        // 様式の密な応答位置は 8 分格子の宣言なので位置比で写す。既定は最終拍頭。
        const declared = sectionPlan.counterDensity === 2 ? style.texture.counter?.denseSteps : undefined;
        const preferred = declared
          ? declared.map((step) => Math.floor((step * steps) / 8))
          : [lastPulse];
        counterSteps.push(...preferred);
      } else {
        targetStep = rhythm.reduce((last, on, step) => on ? step : last, anchorStep);
      }
    }

    const targetChord = targetStep === null ? null : chordAt(bar * 4 + stepBeat(grid, targetStep));
    let targetPc: number | null = null;
    if (targetChord && cadence) {
      const rootPc = targetChord.pcs[0]!;
      // 終止の目標音も語法の中から選ぶ(強拍の着地候補 melodyPcsForChord と同じ規則を
      // melodic-idiom.ts の landingPcs が単一の出所として持つ)。
      // 終止の目標音は区間の調の音組織・核音計画から(区間ごとの転調に追従)。
      const scalePcs = sectionDesign.scalePcs;
      const japanesePlan = sectionDesign.japanesePlan;
      const targetPcs = idiom.landingPcs(targetChord.pcs, scalePcs);
      const nuclearTargets = japanesePlan
        ? targetPcs.filter((pc) => japanesePlan.nuclearPcs.includes(pc))
        : [];
      const cadencePcs = nuclearTargets.length > 0 ? nuclearTargets : targetPcs;
      if (cadence === 'turnaround' || japanesePlan) {
        targetPc = closestPcToMidi(startMidi, cadencePcs);
      } else {
        // 終止音度の物語（SongSectionPlan.cadenceDegrees）: フレーズ終止を毎回ルートへ
        // 落とさず、目標音度に円環距離が最短の和声音へ着地して主音へ段階的に収束させる。
        // 音度→pcは長音階の半音距離(1̂=0,2̂=2,3̂=4,5̂=7)で写す。音組織の添字で引くと
        // 五音音階では別の音度(短ペンタのindex2=4̂等)になり、物語が語法で化けてしまう。
        const degreeSemitones = [0, 2, 4, 5, 7, 9, 11] as const;
        const goalPc = (sectionDesign.keyRoot + degreeSemitones[sectionDesign.cadenceDegrees[phraseIndex]! % 7]!) % 12;
        const distance = (pc: number): number => Math.min((pc - goalPc + 12) % 12, (goalPc - pc + 12) % 12);
        targetPc = [...cadencePcs].sort((a, b) => distance(a) - distance(b))[0] ?? rootPc;
      }
    }

    if (
      arrangementPlan.counterRole === 'counterline'
      && sectionPlan.counterDensity > 0
      && bar !== bars - 1
      && !sectionBoundary
      // 薄い対旋律は応答小節だけ、密な対旋律も展開の開始を足す程度に留める。
      && (isAnswer || (sectionPlan.counterDensity === 2 && phraseFunction === 'departure'))
    ) {
      // 密な区間は主旋律の前半／後半どちらかを3音の短い裏メロへ譲る。
      // 1音ずつ全小節へ散らすより、ひとかたまりの応答として知覚しやすくする。
      const plannedOrnament = ornaments.has(bar) && targetStep !== null;
      // 区間内で同じ半分を空ける(区間安定パリティ)。提示と変奏反復が別の半分を
      // 削られるとフックのリテラル反復が壊れるため、小節単位のパリティは使わない。
      const responseStart = plannedOrnament
        ? targetStep! <= anchorStep ? anchorStep + 1 : 1
        : (sectionIndex + opts.seed) % 2 === 0 ? 1 : anchorStep + 1;
      // 薄い対旋律は最終拍頭と第 2 拍頭を小節ごとに交互に使う。
      const preferred = sectionPlan.counterDensity === 2
        ? [responseStart, responseStart + 1, responseStart + 2]
        : [bar % 2 === 0 ? lastPulse : grid.pulseSteps[1]!];
      for (const step of preferred) {
        if (step === targetStep || step === 0 || step === anchorStep) continue;
        rhythm[step] = false;
        if (step + 1 < steps && step + 1 !== targetStep && step + 1 !== anchorStep) rhythm[step + 1] = false;
        counterSteps.push(step);
      }
    }
    // 対旋律の場所を空けても、主題の提示が痩せすぎない最低密度(格子の半分)は保つ。
    const minimumNotes = Math.ceil(steps / 2);
    for (const step of offPulse) {
      if (rhythm.filter(Boolean).length >= minimumNotes) break;
      const reservedByCounter = counterSteps.some((counterStep) => step === counterStep || step === counterStep + 1);
      if (!reservedByCounter && step !== targetStep) rhythm[step] = true;
    }

    const ornamentSteps: number[] = [];
    const ornamentType = targetStep !== null ? ornaments.get(bar) ?? null : null;
    const reserveOrnament = (candidate: number): void => {
      // 装飾は細かい格子(ステップの 2 分割)上。副旋律の予約から 1 ステップ以上離す。
      const candidateBeat = (candidate * grid.stepBeats) / 2;
      const clearsCounter = counterSteps.every((counterStep) => (
        Math.abs(candidateBeat - stepBeat(grid, counterStep)) >= grid.stepBeats - 1e-9
      ));
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
    if (idiom.usesMa && isAnswer) {
      if (ornamentType && targetStep !== null) {
        const beforeTarget = targetStep - 1;
        if (beforeTarget > 0 && beforeTarget !== anchorStep && !counterSteps.includes(beforeTarget)) {
          rhythm[beforeTarget] = false;
          maSteps.push(beforeTarget);
        }
      } else {
        const weakSteps = [...offPulse].reverse().filter(
          (step) => step !== targetStep && !counterSteps.includes(step),
        );
        const active = weakSteps.find((step) => rhythm[step] && rhythm.filter(Boolean).length > minimumNotes);
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
    // 前小節が弱起で掛かってきた小節は、掛かり先の頭拍を消さない。
    const anacrusisEntry = pendingAnacrusis;
    pendingAnacrusis = false;
    let restStart = false;
    if (!sustainedEntry && !anacrusisEntry && bar !== climaxBar && bar !== signatureLeapBar) {
      const departurePrompt = phraseFunction === 'departure' && !isAnswer;
      if (departurePrompt && restRng.nextInt(100) < 30) restStart = true;
      else if (bar === 0 && restRng.nextInt(100) < 20) restStart = true;
      if (restStart) rhythm[0] = false;
    }

    // ロングトーン: 終止の到達音を次小節の最初の発音まで保続し、下の和声変化をまたがせる。
    let longToneStep: number | null = null;
    if (
      isAnswer
      && (targetStep === anchorStep || targetStep === lastPulse)
      && counterSteps.every((counterStep) => counterStep <= targetStep!)
      && bar + 1 < bars
      && bar + 1 !== climaxBar
      && bar - lastLongToneBar >= 4
      && longToneRng.nextInt(100) < 30
    ) {
      // 保続の間、主旋律の残りは鳴らさない（副旋律の応答は残す）。
      for (let step = targetStep + 1; step < steps; step++) rhythm[step] = false;
      longToneStep = targetStep;
      pendingSustainEntry = true;
      lastLongToneBar = bar;
    }

    // 半小節タイ（食い）: 3拍目の強制リアタックを外し、直前の8分（2拍目/2拍目裏）の
    // 発音をアンカー越しに保続する。答句の終止は最弱の'open'（到達音は最後の発音に
    // 付くだけ）に限り共存させ、強い終止・セクション境界・装飾・副旋律・ロングトーン・
    // クライマックスとは干渉させない。到達音がアンカー後（step5以降）にある小節に限る
    // ので、タイの後で旋律が動き直して終止機構も保たれる。保続音の和声整合
    // （先取音=跨いだ先の和音の構成音）は実現側とdiagnostics.tsの検証で保証する。
    // 頻度・間隔は独立乱数で、骨格の抽選列を乱さない。
    // 跨ぎ元は第 2 拍頭からアンカー手前まで(4x2 では 2 拍目とその裏)。
    const tieSourceSteps = Array.from({ length: steps }, (_, step) => step)
      .filter((step) => step >= grid.pulseSteps[1]! && step < anchorStep);
    let anchorTie = false;
    if (
      isAnswer
      && (cadence === null || cadence === 'open')
      && !sectionBoundary
      && longToneStep === null
      && ornamentType === null
      && counterSteps.length === 0
      && tieSourceSteps.some((step) => rhythm[step])
      && rhythm[anchorStep]
      && targetStep !== null
      && targetStep > anchorStep
      && bar !== climaxBar
      && bar !== signatureLeapBar
      && bar - lastTieBar >= 2
      && tieRng.nextInt(100) < 40
    ) {
      rhythm[anchorStep] = false;
      anchorTie = true;
      lastTieBar = bar;
    }

    // 強拍倚音の許可小節。実現側は、テーマ音が3拍目(step4)で非和声かつ半拍〜1拍後の
    // 発音で2度の和声音へ解決できるときだけ倚音として保持する(できなければ従来どおり
    // 和声音へ吸着)。頻度上限はスタイルの順次進行率から導く(melodic-theme.ts)。
    // 和風は核音・間の体系と衝突するため対象外(語法の宣言)。ターゲット音を解決音として
    // 上書きしないよう、解決ステップが終止目標と重なる小節も外す。
    let appoggiaturaStep: number | null = null;
    const appoggiaturaResolutionStep = [anchorStep + 1, anchorStep + 2].find((step) => rhythm[step]);
    if (
      idiom.allowsAppoggiatura
      && ['statement', 'restatement', 'departure'].includes(phraseFunction)
      && rhythm[anchorStep]
      && targetStep !== anchorStep
      && appoggiaturaResolutionStep !== undefined
      && appoggiaturaResolutionStep !== targetStep
      && ornamentType === null
      && !anchorTie
      && longToneStep === null
      && bar !== climaxBar
      && bar !== signatureLeapBar
      && bar - lastAppoggiaturaBar >= 2
      && appoggRng.nextInt(100) < appoggiaturaRatePercent(style.melody.stepwisePercent)
    ) {
      appoggiaturaStep = anchorStep;
      lastAppoggiaturaBar = bar;
    }

    // 弱起(アウフタクト): 次のフレーズ頭へ2度下から掛かる先行音を答句の末尾(step7)へ
    // 置き、フレーズが小節線を跨いで息をする重心を作る。終止目標の確定より後に足す
    // (targetStepが弱起音へ移ってはいけない)。和風は「間」の候補(step7優先)と
    // 衝突するため対象外(語法の宣言)。
    let anacrusis = false;
    if (
      idiom.allowsAnacrusis
      && isAnswer
      && (cadence === null || cadence === 'open')
      && !sectionBoundary
      && longToneStep === null
      && !anchorTie
      && ornamentType === null
      && counterSteps.length === 0
      && !rhythm[steps - 1]
      && targetStep !== null
      && targetStep <= anchorStep + 1
      && bar + 1 < bars
      && bar + 1 !== signatureLeapBar
      // 次小節が旋律を持たない区間なら掛かる先が無い。
      && sections[sectionIndexAt(form, bar + 1)]!.texture === 'normal'
      && bar - lastAnacrusisBar >= 4
      && anacrusisRng.nextInt(100) < 35
    ) {
      rhythm[steps - 1] = true;
      anacrusis = true;
      lastAnacrusisBar = bar;
      pendingAnacrusis = true;
    }

    const role: PhraseBarPlan['role'] = cadence && cadence !== 'open'
      ? 'cadence'
      : isAnswer
        ? 'answer'
        : offsetInSection >= 4
          ? 'continuation'
          : 'statement';
    barPlans.push({
      bar, section, grouping, role, rhythm, counterSteps, ornamentSteps, ornamentType, maSteps,
      phraseFunction, motifSourceBar, cadence, targetPc, targetStep, energy, dynamic,
      restStart, sustainedEntry, longToneStep, anchorTie, anacrusis, appoggiaturaStep,
      registerOffset: registerOffsets[sectionIndex] ?? 0,
      holdUntilBeat: null,
    });
  }
  return { climaxBar, signatureLeapBar, rhythmFamilies, bars: barPlans };
}
