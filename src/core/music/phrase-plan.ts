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
import { phraseFunctionFor } from './song-plan.js';
import { nearestWithPc } from './pitch.js';
import type { StyleDef } from './theory.js';
import type {
  ArrangementPlan,
  CadenceType,
  ChordEvent,
  ComposeBars,
  ComposeInput,
  JapanesePlan,
  MelodicLanguage,
  MelodicMotif,
  MotifMove,
  OrnamentType,
  PhraseBarPlan,
  PhrasePlan,
  SongPlan,
} from './types.js';

export type PhraseMove = MotifMove;

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


/**
 * 外部モチーフを検証済みのジェスチャー列へ正規化する。壊れた保存データでも
 * compose() を決定論のまま完走させるため、欠けたステップは fallback で補う。
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
 * 2 小節（8 分グリッド 16 ステップ）ぶんの旋律ジェスチャー。
 * 実音ではなく「上行/下行・順次/跳躍」を保存し、コードが変わっても同じ動き方を再利用する。
 */
export function makePhraseGesture(rng: Rng, style: StyleDef): PhraseMove[] {
  const primary: 1 | -1 = rng.nextInt(2) === 0 ? 1 : -1;
  const contour = [1, 1, -1, 1, 1, -1, -1, -1, 1, -1, 1, 1, -1, -1, 1, -1] as const;
  return contour.map((direction) => ({
    direction: (direction * primary) as 1 | -1,
    stepwise: rng.nextInt(100) < style.melody.stepwisePercent,
    leap: 3 + rng.nextInt(3),
  }));
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
export function makePhrasePlan(
  opts: ComposeInput,
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
  const tieRng = new Xoshiro128((featureSeed ^ 0x414e_5443) >>> 0);
  const anacrusisRng = new Xoshiro128((featureSeed ^ 0x4143_5255) >>> 0);
  const appoggRng = new Xoshiro128((featureSeed ^ 0x4150_5047) >>> 0);

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
  let lastTieBar = -8;
  let lastAnacrusisBar = -8;
  let lastAppoggiaturaBar = -8;
  let pendingAnacrusis = false;

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
        // 変奏反復(restatement)の答句はフックのリテラル反復を担うため空けない。
        && (sectionPlan.counterDensity === 2 || barInSection === (opts.bars === 4 ? 1 : 5))
      ) {
        for (let step = 5; step < 8; step++) rhythm[step] = false;
        rhythm[4] = true;
        targetStep = 4;
        const preferred = sectionPlan.counterDensity === 2 ? style.denseCounterSteps ?? [6] : [6];
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
      if (cadence === 'turnaround' || japanesePlan) {
        targetPc = closestPcToMidi(startMidi, cadencePcs);
      } else {
        // 終止音度の物語（SongSectionPlan.cadenceDegrees）: フレーズ終止を毎回ルートへ
        // 落とさず、目標音度に円環距離が最短の和声音へ着地して主音へ段階的に収束させる。
        // 音度→pcは長音階の半音距離(1̂=0,2̂=2,3̂=4,5̂=7)で写す。音組織の添字で引くと
        // 五音音階では別の音度(短ペンタのindex2=4̂等)になり、物語が語法で化けてしまう。
        const degreeSemitones = [0, 2, 4, 5, 7, 9, 11] as const;
        const goalPc = (scalePcs[0]! + degreeSemitones[sectionDesign.cadenceDegrees[phraseIndex]! % 7]!) % 12;
        const distance = (pc: number): number => Math.min((pc - goalPc + 12) % 12, (goalPc - pc + 12) % 12);
        targetPc = [...cadencePcs].sort((a, b) => distance(a) - distance(b))[0] ?? rootPc;
      }
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
      // 区間内で同じ半分を空ける(区間安定パリティ)。提示と変奏反復が別の半分を
      // 削られるとフックのリテラル反復が壊れるため、小節単位のパリティは使わない。
      const responseStart = plannedOrnament
        ? targetStep! <= 4 ? 5 : 1
        : (sectionIndex + opts.seed) % 2 === 0 ? 1 : 5;
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

    // 半小節タイ（食い）: 3拍目の強制リアタックを外し、直前の8分（2拍目/2拍目裏）の
    // 発音をアンカー越しに保続する。答句の終止は最弱の'open'（到達音は最後の発音に
    // 付くだけ）に限り共存させ、強い終止・セクション境界・装飾・副旋律・ロングトーン・
    // クライマックスとは干渉させない。到達音がアンカー後（step5以降）にある小節に限る
    // ので、タイの後で旋律が動き直して終止機構も保たれる。保続音の和声整合
    // （先取音=跨いだ先の和音の構成音）は実現側とdiagnostics.tsの検証で保証する。
    // 頻度・間隔は独立乱数で、骨格の抽選列を乱さない。
    let anchorTie = false;
    if (
      isAnswer
      && (cadence === null || cadence === 'open')
      && !sectionBoundary
      && longToneStep === null
      && ornamentType === null
      && counterSteps.length === 0
      && (rhythm[2] || rhythm[3])
      && rhythm[4]
      && targetStep !== null
      && targetStep >= 5
      && bar !== climaxBar
      && bar !== signatureLeapBar
      && bar - lastTieBar >= 2
      && tieRng.nextInt(100) < 40
    ) {
      rhythm[4] = false;
      anchorTie = true;
      lastTieBar = bar;
    }

    // 強拍倚音の許可小節。実現側は、テーマ音が3拍目(step4)で非和声かつ半拍〜1拍後の
    // 発音で2度の和声音へ解決できるときだけ倚音として保持する(できなければ従来どおり
    // 和声音へ吸着)。頻度上限はスタイルの順次進行率から導く(melodic-theme.ts)。
    // 和風は核音・間の体系と衝突するため対象外。ターゲット音を解決音として
    // 上書きしないよう、解決ステップが終止目標と重なる小節も外す。
    let appoggiaturaStep: number | null = null;
    const appoggiaturaResolutionStep = [5, 6].find((step) => rhythm[step]);
    if (
      melodicLanguage !== 'japanese'
      && ['statement', 'restatement', 'departure'].includes(phraseFunction)
      && rhythm[4]
      && targetStep !== 4
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
      appoggiaturaStep = 4;
      lastAppoggiaturaBar = bar;
    }

    // 弱起(アウフタクト): 次のフレーズ頭へ2度下から掛かる先行音を答句の末尾(step7)へ
    // 置き、フレーズが小節線を跨いで息をする重心を作る。終止目標の確定より後に足す
    // (targetStepが弱起音へ移ってはいけない)。和風は「間」の候補(step7優先)と
    // 衝突するため対象外。
    let anacrusis = false;
    if (
      melodicLanguage !== 'japanese'
      && isAnswer
      && (cadence === null || cadence === 'open')
      && !sectionBoundary
      && longToneStep === null
      && !anchorTie
      && ornamentType === null
      && counterSteps.length === 0
      && !rhythm[7]
      && targetStep !== null
      && targetStep <= 5
      && bar + 1 < opts.bars
      && bar + 1 !== signatureLeapBar
      && bar - lastAnacrusisBar >= 4
      && anacrusisRng.nextInt(100) < 35
    ) {
      rhythm[7] = true;
      anacrusis = true;
      lastAnacrusisBar = bar;
      pendingAnacrusis = true;
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
      restStart, sustainedEntry, longToneStep, anchorTie, anacrusis, appoggiaturaStep,
      registerOffset: registerOffsets[sectionIndex] ?? 0,
    });
  }
  return { climaxBar, signatureLeapBar, rhythmFamilies, bars };
}
