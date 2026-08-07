/**
 * ディミニューション(縮小変奏): 8分骨格の隣接音対の間に、コードスケール上の
 * 経過音を16分で1音だけ挿入する装置。
 *
 * 理論上の根拠は古典的な縮小変奏(diminution)そのもの: 骨格音は位置も音高も
 * 変えず、間を歩く音だけを増やす。だから
 * - PhrasePlanの骨格リズム検証は無傷(挿入音はrole='ornament')
 * - 挿入音は両端の間に「真に挟まれる」スケール音に限る(経過音の定義)
 * - 到達側(後続音)へ寄せて選ぶ = アプローチ・ノート
 * ESTi系実測(BPM96-103で音符の6割超が16分)の「中庸テンポ+細分密度」を、
 * グリッド全面改築なしで骨格の局所細分として得る。
 */

import type { NoteEvent } from './compose.js';

export type DiminutionPolicy = 'off' | 'light' | 'rich';

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

/**
 * 主旋律へ経過音を挿入する。melodyは破壊的に更新される(骨格音のdur短縮+挿入)。
 * nextIntは骨格生成と独立した乱数(同一シードで骨格が1音も動かないことを保証する)。
 */
export function applyDiminution(
  melody: NoteEvent[],
  policy: DiminutionPolicy,
  scaleAtBeat: (beat: number) => readonly number[],
  nextInt: (bound: number) => number,
): void {
  if (policy === 'off') return;
  const percent = FILL_PERCENT[policy];
  const structural = melody
    .filter((note) => note.role !== 'ornament')
    .sort((a, b) => a.beat - b.beat);
  const inserted: NoteEvent[] = [];
  for (let i = 0; i + 1 < structural.length; i++) {
    const from = structural[i]!;
    const to = structural[i + 1]!;
    const gap = to.beat - from.beat;
    // 8分相当の対だけ。長い音は歌わせたまま残す。下限0.45は、bounceの
    // 「裏拍(k+2/3)→次拍頭」対(間隔1/3)を除外するための境界——そこへ挿入すると
    // 音価が1/6拍(170BPMで約40ms)のグリッド外ブリップになる。表→裏対(2/3)は許す。
    if (gap < 0.45 || gap > 0.75) continue;
    const interval = to.midi - from.midi;
    // 全音以下の順次には挟む音が存在しない(半音階は語彙外)。
    if (Math.abs(interval) < 3) continue;
    if (nextInt(100) >= percent) continue;
    const scale = scaleAtBeat(from.beat);
    // 両端に真に挟まれるスケール音のうち、到達側に最も近いもの(アプローチ)。
    const lo = Math.min(from.midi, to.midi);
    const hi = Math.max(from.midi, to.midi);
    let passing: number | null = null;
    for (let midi = lo + 1; midi < hi; midi++) {
      if (!scale.includes(midi % 12)) continue;
      if (passing === null || Math.abs(midi - to.midi) < Math.abs(passing - to.midi)) passing = midi;
    }
    if (passing === null) continue;
    const mid = (from.beat + to.beat) / 2;
    // 既存の装飾(前打音等)が同じ位置に居るなら譲る。
    if (melody.some((note) => Math.abs(note.beat - mid) < 0.05)) continue;
    from.dur = Math.min(from.dur, (mid - from.beat) * 0.9);
    inserted.push({
      beat: mid,
      dur: (to.beat - mid) * 0.66,
      midi: passing,
      velocity: Math.max(0.3, (from.velocity ?? 0.7) - 0.06),
      articulation: 'normal',
      role: 'ornament',
    });
  }
  melody.push(...inserted);
  melody.sort((a, b) => a.beat - b.beat);
}
