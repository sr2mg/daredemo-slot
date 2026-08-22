/**
 * 分散和音（オスティナート）: TextureStrategy で選ばれた区間だけを推進する独立声部。
 * 窓（密集配置）は最短声部連結の原理で滑らかに繋ぎ、連符レイヤー
 * （grouping dissonance）のときは基準面と摩擦する均等分割で鳴らす。
 */

import { grooveBeat } from './groove.js';
import { groupingDissonanceFor } from './metric-modulation.js';
import { nearestWithPc } from './pitch.js';
import { CHORDS } from './theory.js';
import type { ComposeContext } from './compose-context.js';
import type { NoteEvent, PhraseFunction } from './types.js';

export function generateOstinato(ctx: ComposeContext): NoteEvent[] {
  const { opts, keyRoot, grooveFeel, arrangementPlan, phrasePlan, chordAt } = ctx;
  // --- 分散和音（コード伴奏とは別の、選ばれた区間だけを推進する声部） ---
  // 曲全体のTextureStrategyで有効になった区間だけに置き、常設レイヤーにはしない。
  // chordAtを各打点で引くため、2拍目など小節途中のコード変化にもその場で追従する。
  const ostinato: NoteEvent[] = [];
  // アルペジオが回る窓（密集配置）を毎小節ルートへ戻さず、直前の窓から総移動距離が
  // 最小の転回形を選ぶ。伴奏voiceChordの「最短声部連結」原理を窓決めへ適用したもので、
  // 和声が動いても層の音域がなだらかに繋がる。初回だけ従来どおりルート基調で入る。
  let ostinatoWindow: number[] | null = null;
  let ostinatoWindowBeat = -1;
  const ostinatoWindowAt = (logicalBeat: number): number[] => {
    const chord = chordAt(logicalBeat);
    if (ostinatoWindow !== null && chord.beat === ostinatoWindowBeat) return ostinatoWindow;
    const previous = ostinatoWindow;
    const candidates = chord.pcs.map((bassPc) => {
      const bass = nearestWithPc(previous?.[0] ?? 60, [bassPc], 55, 67);
      const upper = chord.pcs
        .filter((pc) => pc !== bassPc)
        .map((pc) => bass + ((pc - bassPc + 12) % 12))
        .sort((a, b) => a - b);
      return [bass, ...upper];
    });
    const rootPc = (CHORDS[chord.token]!.root + keyRoot) % 12;
    const cost = (candidate: number[]): number => previous === null
      ? candidate[0]! % 12 === rootPc ? 0 : 1
      : candidate.reduce(
        (sum, midi, i) => sum + Math.abs(midi - previous[Math.min(i, previous.length - 1)]!),
        0,
      );
    ostinatoWindow = candidates.reduce((best, candidate) => (
      cost(candidate) < cost(best) ? candidate : best
    ));
    ostinatoWindowBeat = chord.beat;
    return ostinatoWindow;
  };
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
    const contour = [
      [0, 1, 2, 1],
      [0, 2, 1, 2],
      [2, 1, 0, 1],
      [0, 1, 2, 0],
    ][(barPlan.bar + sectionIndex + opts.seed) % 4]!;
    const pitchAt = (logicalBeat: number, step: number): number => {
      const window = ostinatoWindowAt(logicalBeat);
      const contourIndex = Math.min(contour[step % contour.length]!, window.length - 1);
      return window[contourIndex]!;
    };
    const tuplet = sectionPlan.ostinatoTuplet;
    if (tuplet !== null) {
      // 連符レイヤー（grouping dissonance G(n:4)）: 1小節をn等分（加速小節は半小節を
      // n等分）し、各打点を暗示テンポ（bpm×n/4）の4分・8分として鳴らす。基準面
      // （他声部）は不動のまま摩擦を作る装置なので、グルーヴ変形は適用せず均等へ保つ。
      const dissonance = groupingDissonanceFor(tuplet);
      const unit = density === 2 ? 2 / tuplet : 4 / tuplet;
      const total = tuplet * (density === 2 ? 2 : 1);
      for (let k = 0; k < total; k++) {
        const offset = k * unit;
        // 終止小節は最終拍ぶんを休ませ、基準グリッドとの合流点（次小節頭）を空ける。
        if ((barPlan.cadence === 'half' || barPlan.cadence === 'turnaround') && offset >= 3) break;
        const logicalBeat = barPlan.bar * 4 + offset;
        // アクセントは基準面との合流点（カタログのanchorBeats）。錯覚の錨を毎回同じ
        // 位置で聴かせ、n=6なら半小節ごと、n=5/7なら小節頭だけが浮き上がる。
        const isAnchor = dissonance.anchorBeats.some((anchor) => Math.abs(offset - anchor) < 1e-6);
        ostinato.push({
          beat: logicalBeat,
          // ゲートは既存の8分(0.58)/16分(0.66)スタッカートの中間。
          dur: Math.max(0.1, unit * 0.62),
          midi: pitchAt(logicalBeat, k),
          // ベース強拍と同じ+0.06の家内規約でアクセントを付ける。
          velocity: Math.min(1, Math.max(0.38, barPlan.dynamic - 0.2) + (isAnchor ? 0.06 : 0)),
          articulation: 'staccato',
          role: 'structural',
        });
      }
      continue;
    }
    const subdivision = density === 2 ? 0.25 : 0.5;
    const fullStepCount = density === 2 ? 16 : 8;
    const stepCount = barPlan.cadence === 'half' || barPlan.cadence === 'turnaround'
      ? fullStepCount - (density === 2 ? 4 : 2)
      : fullStepCount;
    for (let step = 0; step < stepCount; step++) {
      const logicalBeat = barPlan.bar * 4 + step * subdivision;
      const midi = pitchAt(logicalBeat, step);
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
  return ostinato;
}
