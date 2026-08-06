/**
 * 声部連結の導出層。
 * コード列そのものが持つ最短声部連結（共通音の保持・最近接移動）を計算し、
 * 半音下行クリシェのような特徴的な内声ラインを進行から機械的に取り出す。
 *
 * 導出は任意のコード列に対して常に可能な純関数で、採用（どの声部で鳴らすか・
 * 鳴らすかどうか）は編曲層が別途選ぶ。進行カタログへ手書きのライン指定は持たせない。
 * 例: i7–V7–♭VII–IV7 からは 主音→導音→♭7→♮6 の半音下行が導出される。
 */

export interface GuideStrand {
  /** コードイベントごとのピッチクラス列（入力と同じ音空間）。 */
  pcs: number[];
  /** 隣接移動の半音数（ループ末尾→先頭の折り返しを含む）。 */
  moves: number[];
  /** 半音移動の数。クリシェらしさの主指標。 */
  chromaticMoves: number;
  /** 共通音保持の数。 */
  commonTones: number;
  maxMove: number;
}

function pcDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 12;
  return Math.min(diff, 12 - diff);
}

/** prev から最短距離のコードトーン。同距離なら下行を優先する（決定論と下行クリシェの美観）。 */
function nearestChordPc(prev: number, chordPcs: readonly number[]): number {
  let best = chordPcs[0]!;
  let bestScore = Infinity;
  for (const pc of chordPcs) {
    const dist = pcDistance(prev, pc);
    const downward = ((prev - pc) % 12 + 12) % 12 === dist;
    const score = dist * 2 + (dist > 0 && !downward ? 1 : 0);
    if (score < bestScore) {
      best = pc;
      bestScore = score;
    }
  }
  return best;
}

/** 先頭コードの各構成音から列を歩いた、重複除去済みのストランド群。 */
export function guideStrands(chordPcsSeq: readonly (readonly number[])[]): GuideStrand[] {
  if (chordPcsSeq.length === 0) return [];
  const seen = new Set<string>();
  const strands: GuideStrand[] = [];
  for (const start of chordPcsSeq[0]!) {
    const pcs = [start];
    for (let index = 1; index < chordPcsSeq.length; index++) {
      pcs.push(nearestChordPc(pcs[index - 1]!, chordPcsSeq[index]!));
    }
    const key = pcs.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const moves = pcs.map((pc, index) => pcDistance(pc, pcs[(index + 1) % pcs.length]!));
    strands.push({
      pcs,
      moves,
      chromaticMoves: moves.filter((move) => move === 1).length,
      commonTones: moves.filter((move) => move === 0).length,
      maxMove: moves.reduce((max, move) => Math.max(max, move), 0),
    });
  }
  return strands;
}

/**
 * フィーチャーに値するストランドだけを返す品質ゲート。
 * 全移動が半音以内（保続とクリシェの性格）で、半音移動を2回以上含み、
 * 根音列の複製でも1音の保続でもないものがなければ null（＝装置を発火させない）。
 * 同格候補の順位は移調不変（先頭コードの根音からの音程）で決める。
 */
export function featuredGuideStrand(
  chordPcsSeq: readonly (readonly number[])[],
  rootPcs: readonly number[],
): GuideStrand | null {
  const candidates = guideStrands(chordPcsSeq).filter((strand) => (
    strand.maxMove <= 1
    && strand.chromaticMoves >= 2
    && new Set(strand.pcs).size >= 2
    && !strand.pcs.every((pc, index) => pc === rootPcs[index])
  ));
  const rank = (strand: GuideStrand): number => ((strand.pcs[0]! - rootPcs[0]!) % 12 + 12) % 12;
  candidates.sort((a, b) => (
    b.chromaticMoves - a.chromaticMoves
    || b.commonTones - a.commonTones
    || rank(a) - rank(b)
  ));
  return candidates[0] ?? null;
}
