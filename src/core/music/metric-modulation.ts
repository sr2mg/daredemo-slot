import type { TupletDivision } from './compose.js';

/**
 * 暗示的メトリック・モジュレーションの理論カタログ（Krebsのgrouping dissonance G(n:4)）。
 *
 * 4/4の1小節（4拍）を n 等分するレイヤーは、n 個の打点が暗示テンポ bpm×n/4 の
 * 4分音符列として知覚され、不動の基準面との摩擦で「別のテンポの曲が同時に鳴っている」
 * 錯覚を作る（LeaF「彁」がBPM125固定のまま156.25/187.5/218.75を聴かせる装置と同型）。
 *
 * 分割数の範囲は列挙ではなく導出する: 4 < n < 8 の開区間。
 * - n<=4 は同一か減速側で、加速の錯覚を作らない。
 * - n=8 は基準の8分そのもの（gcd(8,4)=4で毎拍合流し、不協和が消える）。
 * - よって「基準4分より速く、最初の協和分割より遅い」全域が 5..7 になる。
 *   TupletDivision型はこの開区間を写した型で、CARRIER_BEATSを変えるなら型も変える。
 *
 * 緊張度は合流点の希少さで順序づける（Krebs/Cohn: 比の複雑さ＝不協和の強さ）:
 * 合流間隔 4/gcd(n,4) 拍が長いほど強く、同間隔なら分割数が大きい（速い）ほど強い。
 * → 6連（3:2ヘミオラ族、半小節ごとに合流）< 5連 < 7連。
 */
export interface GroupingDissonance {
  division: TupletDivision;
  /** 暗示テンポ係数。bpm×この値が、レイヤーが聴かせる「別の曲」のテンポ。 */
  impliedTempoFactor: number;
  /** 基準面（4分）と打点が一致する間隔（拍）。長いほど不協和が強い。 */
  realignmentBeats: number;
  /** 小節内の合流点（拍）。アクセントはここへ置き、錯覚の錨にする。 */
  anchorBeats: readonly number[];
  /** カタログ内の正規化緊張度 0..1。編成層が区間エネルギーの順位を写す先。 */
  tension: number;
}

const CARRIER_BEATS = 4;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

function dissonanceEntries(): GroupingDissonance[] {
  const divisions: TupletDivision[] = [];
  for (let n = CARRIER_BEATS + 1; n < CARRIER_BEATS * 2; n++) divisions.push(n as TupletDivision);
  const entries = divisions.map((division) => {
    const realignmentBeats = CARRIER_BEATS / gcd(division, CARRIER_BEATS);
    const anchorBeats: number[] = [];
    for (let beat = 0; beat < CARRIER_BEATS; beat += realignmentBeats) anchorBeats.push(beat);
    return {
      division,
      impliedTempoFactor: division / CARRIER_BEATS,
      realignmentBeats,
      anchorBeats,
      tension: 0,
    };
  });
  entries.sort((a, b) => a.realignmentBeats - b.realignmentBeats || a.division - b.division);
  return entries.map((entry, index) => ({
    ...entry,
    tension: entries.length === 1 ? 0 : index / (entries.length - 1),
  }));
}

/** 緊張度の昇順。現行キャリア（4拍）では 6連 → 5連 → 7連。 */
export const GROUPING_DISSONANCES: readonly GroupingDissonance[] = dissonanceEntries();

export function groupingDissonanceFor(division: TupletDivision): GroupingDissonance {
  return GROUPING_DISSONANCES.find((entry) => entry.division === division)!;
}
