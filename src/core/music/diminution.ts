/**
 * ディミニューション(縮小変奏): 8分骨格の隣接音対の間へ、音組織上の音を16分で
 * 挿入する装置。挿入の語彙は古典的な縮小変奏のフィギュア3種に限る:
 *
 * - 経過音(passing): 8分対(間隔~0.5拍)の間に1音。両端に「真に挟まれる」音組織音のみ。
 * - 走句(run):       4分対(間隔~1拍)の間を音組織で歩いて埋める(最大3音)。到達側へ寄せ、
 *                    直前が16分の連なりになる = 中庸テンポの細分密度(ESTi系実測: BPM96-103で
 *                    音符の6割超が16分、16分裏拍率0.35)をこの装置だけで届かせる。
 * - 刺繍音(neighbor): 同音反復対の間に上下いずれかの隣接音組織音を1音(D-E-Dの型)。
 *
 * 共通の不変条件は従来どおり: 骨格音は位置も音高も変えず(dur短縮のみ)、挿入音は
 * role='ornament' なので PhrasePlan の骨格リズム検証は無傷。挿入音高は常に音組織
 * (scaleAtBeat)から取るため、五音語法では五音の走句・刺繍になる。
 */

import type { DiminutionPolicy, NoteEvent } from './types.js';

export const DIMINUTION_POLICY_LABELS: Record<'auto' | DiminutionPolicy, string> = {
  auto: 'スタイル既定',
  off: 'なし',
  light: '軽め（約1/3を細分）',
  rich: '濃いめ（約2/3を細分）',
};

/** 埋める確率(%)。骨格全対を埋めると機械的になるため常に抽選を残す。 */
const FILL_PERCENT: Record<Exclude<DiminutionPolicy, 'off'>, number> = {
  light: 35,
  rich: 70,
};

export interface DiminutionOptions {
  /**
   * フィギュアを置ける骨格対の最大間隔(拍)。既定0.75は8分対まで(=従来挙動)。
   * ストレートのグルーヴでは1.0を渡すと4分対にも走句が入る。bounce等では16分格子が
   * スウィング格子とずれるため、呼び出し側が0.75のまま据え置くこと。
   */
  maxGapBeats?: number;
  /**
   * 挿入を避ける発音位置(他声部が予約済みの拍)。予約拍が骨格対の間に落ちる場合、
   * その対にはフィギュアを置かない(挿入音が予約声部の持続と時間的に重なるため、
   * 発音点だけ避けても衝突扱いになる)。副旋律は「主旋律の隙間」を予約する声部なので、
   * 走句(4分対の16分埋め)がちょうどこの隙間に踏み込み得る。
   */
  blockedBeats?: readonly number[];
}

/**
 * 主旋律へ縮小変奏を挿入する。melodyは破壊的に更新される(骨格音のdur短縮+挿入)。
 * nextIntは骨格生成と独立した乱数(同一シードで骨格が1音も動かないことを保証する)。
 */
export function applyDiminution(
  melody: NoteEvent[],
  policy: DiminutionPolicy,
  scaleAtBeat: (beat: number) => readonly number[],
  nextInt: (bound: number) => number,
  options: DiminutionOptions = {},
): void {
  if (policy === 'off') return;
  const percent = FILL_PERCENT[policy];
  const maxGap = options.maxGapBeats ?? 0.75;
  const structural = melody
    .filter((note) => note.role !== 'ornament')
    .sort((a, b) => a.beat - b.beat);
  if (structural.length < 2) return;
  // 装飾は骨格が既に使っている音域を広げない(刺繍音が音域検証の外へ出ないための導出則)。
  const compassLo = Math.min(...structural.map((note) => note.midi));
  const compassHi = Math.max(...structural.map((note) => note.midi));
  const inserted: NoteEvent[] = [];
  const blocked = options.blockedBeats ?? [];
  const insertFigure = (from: NoteEvent, to: NoteEvent, midis: readonly number[], beats: readonly number[]) => {
    // 既存の装飾(前打音等)が同じ位置に居るなら、フィギュアごと譲る。
    for (const beat of beats) {
      if (melody.some((note) => Math.abs(note.beat - beat) < 0.05)) return;
      if (inserted.some((note) => Math.abs(note.beat - beat) < 0.05)) return;
    }
    from.dur = Math.min(from.dur, (beats[0]! - from.beat) * 0.9);
    beats.forEach((beat, index) => {
      const nextBeat = beats[index + 1] ?? to.beat;
      inserted.push({
        beat,
        dur: (nextBeat - beat) * 0.66,
        midi: midis[index]!,
        velocity: Math.max(0.3, (from.velocity ?? 0.7) - 0.06),
        articulation: 'normal',
        role: 'ornament',
      });
    });
  };
  for (let i = 0; i + 1 < structural.length; i++) {
    const from = structural[i]!;
    const to = structural[i + 1]!;
    const gap = to.beat - from.beat;
    // 下限0.45は、bounceの「裏拍(k+2/3)→次拍頭」対(間隔1/3)を除外するための境界——
    // そこへ挿入すると音価が1/6拍(170BPMで約40ms)のグリッド外ブリップになる。
    // 上限maxGapを超える長い音は歌わせたまま残す。
    if (gap < 0.45 || gap > maxGap + 0.01) continue;
    // 対の間に他声部の予約拍がある(=そこから持続音が鳴る)なら、この対は歌わせたまま譲る。
    if (blocked.some((beat) => beat > from.beat + 0.05 && beat < to.beat - 0.05)) continue;
    const interval = to.midi - from.midi;
    const scale = scaleAtBeat(from.beat);

    if (interval === 0) {
      // 刺繍音: 同音反復の間に隣の音組織音を1音。方向は抽選(上下とも古典的に等価)。
      if (gap > 0.75) continue; // 4分対の同音は保続として歌わせたまま残す
      if (nextInt(100) >= percent) continue;
      const direction = nextInt(2) === 0 ? 1 : -1;
      const inCompass = (midi: number | null): midi is number =>
        midi !== null && midi >= compassLo && midi <= compassHi;
      const primary = stepOnScaleLocal(from.midi, direction, scale);
      const fallback = stepOnScaleLocal(from.midi, -direction as 1 | -1, scale);
      const neighbor = inCompass(primary) ? primary : inCompass(fallback) ? fallback : null;
      if (neighbor === null) continue;
      insertFigure(from, to, [neighbor], [(from.beat + to.beat) / 2]);
      continue;
    }

    // 全音以下の順次には挟む音が存在しない(半音階は語彙外)。
    if (Math.abs(interval) < 3) continue;
    if (nextInt(100) >= percent) continue;
    // 両端に真に挟まれる音組織音を、低い順に集める。
    const lo = Math.min(from.midi, to.midi);
    const hi = Math.max(from.midi, to.midi);
    const between: number[] = [];
    for (let midi = lo + 1; midi < hi; midi++) {
      if (scale.includes(midi % 12)) between.push(midi);
    }
    if (between.length === 0) continue;

    if (gap <= 0.76) {
      // 経過音: 到達側に最も近い1音を対の中点へ(従来挙動)。中点はbounceの
      // 表→裏対(間隔2/3)でもスウィング格子上の正しい位置(k+1/3)に落ちる。
      const passing = between.reduce((best, midi) => (
        Math.abs(midi - to.midi) < Math.abs(best - to.midi) ? midi : best
      ));
      insertFigure(from, to, [passing], [(from.beat + to.beat) / 2]);
      continue;
    }

    // 走句: 4分対(ストレート時のみ到達)を到達側へ寄せた16分の歩みで埋める。
    // 到達側に近いものから最大3音を採り、進行方向へ単調に並べ直す。
    const approachOrdered = [...between].sort(
      (a, b) => Math.abs(a - to.midi) - Math.abs(b - to.midi),
    ).slice(0, 3);
    const walking = approachOrdered.sort((a, b) => (interval > 0 ? a - b : b - a));
    // 到達直前の連続スロットへ置く(最後の挿入音が to の16分前に来る)。
    const beats = walking.map((_, index) => to.beat - 0.25 * (walking.length - index));
    if (beats[0]! <= from.beat + 0.05) continue;
    insertFigure(from, to, walking, beats);
  }
  melody.push(...inserted);
  melody.sort((a, b) => a.beat - b.beat);
}

/** 音域を反転せず、その方向に音組織音が無ければ null を返す局所版 stepOnScale。 */
function stepOnScaleLocal(from: number, dir: 1 | -1, pcs: readonly number[]): number | null {
  for (let midi = from + dir; Math.abs(midi - from) <= 12; midi += dir) {
    if (pcs.includes(((midi % 12) + 12) % 12)) return midi;
  }
  return null;
}
