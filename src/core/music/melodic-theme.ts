/**
 * 実音テーマ（記憶に残る旋律の核）。
 *
 * これまでの旋律は「方向・順次/跳躍」の抽象ジェスチャーを毎音 nearestWithPc で
 * 和声へ吸着させて実現していたため、同じモチーフを2回鳴らしても音程が毎回変異し、
 * 聴き手が掴む「実音の図形」が存在しなかった。本モジュールはモチーフを
 * 「スケール度数列 × 8分グリッド」の具体物として一度だけ確定し、以後の反復・変形を
 * この度数列からの決定論的な導出に置き換える。
 *
 * 理論的根拠:
 * - リテラル反復が記憶性の主エンジン（Margulis "On Repeat"）。フックが一曲で
 *   ほぼ原形のまま複数回現れるのはポピュラー音楽の通例（こちらは慣習知）
 * - 反復時に全音を和声へ吸着せず、フレーズの柱（開始音・終止音）だけを調整するのは
 *   フーガの応答（実答/変応 tonal answer）と同じ「音程の同一性を保ちながら調性へ
 *   適応させる」古典手法
 * - 単一頂点（single culmination): 1フレーズに最高音は一度だけ置く（Toch/Hindemith）。
 *   頂点が複数回現れる線は輪郭の焦点を失う
 * - ゼクエンツ（反復進行): 断片を2度ずつ移して繰り返す装置は、調性音楽で
 *   「同じ材料から展開している」と聴かせる最強の手段（Schoenberg のセンテンス構文:
 *   提示→反復→断片化・ゼクエンツ→リキダーション）
 *
 * 保存形式は変えない: テーマは既存の MotifMove 列（Piece.motif / externalMotif）から
 * 決定論的に導出するため、保存曲の交換形式・曲間モチーフ流用はそのまま機能する。
 */

import type { MotifMove } from './compose.js';

/** 2小節=8分16ステップの実音テーマ。度数は最初の発音からの音組織上のステップ数。 */
export interface ThemeSpec {
  /**
   * 全16ステップぶんの度数。発音位置以外も埋めておき、表現デバイスがリズムを
   * 局所的に変えた小節でも「そのステップで鳴るべき高さ」を引けるようにする。
   */
  degreeByStep: readonly number[];
  /** テーマ本来の発音ステップ（区間の提示リズム）。 */
  onsetSteps: readonly number[];
  /** 単一頂点のステップ位置。 */
  peakStep: number;
}

/** ゼクエンツで運ぶ断片。相対度数列（先頭=0）だけを持ち、実音はアンカーが決める。 */
export interface ThemeFragment {
  relativeDegrees: readonly number[];
}

/**
 * 跳躍半音数を音組織のステップ数へ写す。
 * ダイアトニックでは2ステップ=3度(3-4半音)、3ステップ=4度前後(5-6半音)なので、
 * 3-4半音→2ステップ / 5-7半音→3ステップが同じ跳躍語彙の度数表現になる。
 */
function leapDegrees(leapSemitones: number): number {
  return leapSemitones <= 4 ? 2 : 3;
}

/**
 * 単一頂点の強制。最大度数が複数ステップに現れる場合、黄金比位置(全長の約61.8%)に
 * 最も近い1つを頂点として残し、他を1度下げる。頂点位置の目安を後半へ置くのは
 * 「フレーズの緊張は終止直前に最大化する」という旋律アーチの経験則による。
 */
function enforceSinglePeak(degrees: number[], onsetSteps: readonly number[]): number {
  const max = Math.max(...onsetSteps.map((step) => degrees[step]!));
  const peaks = onsetSteps.filter((step) => degrees[step] === max);
  const goldenStep = degrees.length * 0.618;
  const keep = peaks.reduce((best, step) => (
    Math.abs(step - goldenStep) < Math.abs(best - goldenStep) ? step : best
  ));
  for (const step of peaks) {
    if (step !== keep) degrees[step] = max - 1;
  }
  return keep;
}

/**
 * MotifMove 列と提示リズム（2小節ぶんの8分オンセット）から実音テーマを構築する。
 * 発音ステップでは move を適用した累積ウォーク、非発音ステップは直前の発音の度数を
 * 保持する（リズムが変わった小節で引いても近傍の度数が返る）。
 */
export function themeFromGesture(
  moves: readonly MotifMove[],
  promptRhythm: readonly boolean[],
  answerRhythm: readonly boolean[],
): ThemeSpec {
  const rhythm = [...promptRhythm, ...answerRhythm];
  const onsetSteps: number[] = [];
  const degreeByStep: number[] = Array.from({ length: 16 }, () => 0);
  let degree = 0;
  for (let step = 0; step < 16; step++) {
    if (rhythm[step] && step > 0) {
      const move = moves[step] ?? { direction: 1 as const, stepwise: true, leap: 3 };
      degree += move.direction * (move.stepwise ? 1 : leapDegrees(move.leap));
    }
    degreeByStep[step] = degree;
    if (rhythm[step]) onsetSteps.push(step);
  }
  const peakStep = enforceSinglePeak(degreeByStep, onsetSteps);
  // 頂点調整で非発音ステップの保持値がずれた分を再同期する。
  for (let step = 1; step < 16; step++) {
    if (!rhythm[step]) degreeByStep[step] = degreeByStep[step - 1]!;
  }
  return { degreeByStep, onsetSteps, peakStep };
}

/** 全音度移調（トーナルアンサー相当）。音程の相対関係は完全に保存される。 */
export function transposeTheme(theme: ThemeSpec, shift: number): ThemeSpec {
  return {
    ...theme,
    degreeByStep: theme.degreeByStep.map((degree) => degree + shift),
  };
}

/** 度数反転（輪郭の鏡像）。頂点は谷になるため peakStep は最小値の位置へ更新する。 */
export function invertTheme(theme: ThemeSpec): ThemeSpec {
  const degreeByStep = theme.degreeByStep.map((degree) => -degree);
  const max = Math.max(...theme.onsetSteps.map((step) => degreeByStep[step]!));
  const peakStep = theme.onsetSteps.find((step) => degreeByStep[step] === max) ?? theme.peakStep;
  return { ...theme, degreeByStep, peakStep };
}

/**
 * ゼクエンツで運ぶ断片の抽出。tail（テーマ末尾の最大3音）を既定とするのは、
 * センテンス構文の断片化が「直前に聴いた語尾」を切り出すため。
 */
export function fragmentOf(theme: ThemeSpec, part: 'head' | 'tail' = 'tail'): ThemeFragment {
  const source = part === 'head'
    ? theme.onsetSteps.slice(0, 3)
    : theme.onsetSteps.slice(-3);
  const base = theme.degreeByStep[source[0] ?? 0] ?? 0;
  return {
    relativeDegrees: source.map((step) => theme.degreeByStep[step]! - base),
  };
}

/** anchorMidi から音組織上を degree ステップだけ歩いた実音。 */
export function realizeDegree(
  anchorMidi: number,
  degree: number,
  scalePcs: readonly number[],
  lo: number,
  hi: number,
): number {
  const direction = degree >= 0 ? 1 : -1;
  let midi = anchorMidi;
  let remaining = Math.abs(degree);
  while (remaining > 0) {
    // 音組織音は必ず12半音以内にあるため、探索は反復上限だけで打ち切る
    // (範囲条件で打ち切ると音組織外の半音階音がそのまま返ってしまう)。
    let next = midi + direction;
    let guard = 0;
    while (guard++ < 12 && !scalePcs.includes(((next % 12) + 12) % 12)) {
      next += direction;
    }
    midi = next;
    remaining--;
  }
  // 音域を超える場合はオクターブで畳む（音級=度数の同一性は保つ）。
  while (midi > hi) midi -= 12;
  while (midi < lo) midi += 12;
  return midi;
}

/** テーマの度数スパン（アンカー配置で音域とクライマックス未満を保証するために使う）。 */
export function themeDegreeSpan(theme: ThemeSpec): { min: number; max: number } {
  const degrees = theme.onsetSteps.map((step) => theme.degreeByStep[step]!);
  return { min: Math.min(0, ...degrees), max: Math.max(0, ...degrees) };
}

/**
 * 強拍倚音の採用率(%)をスタイルの順次進行率から導く。
 * 倚音は「強拍の非和声音が2度で解決する」装置なので、順次進行の語彙が濃い様式ほど
 * 自然に頻度を上げられる。順次50%以下の様式では採用しない。
 * 上限25%は「例外は例外のまま」というアクセントの一般則（毎小節鳴る倚音は
 * もはや倚音ではなく音組織の一部になってしまう）による。
 * 傾き0.8は、カタログ中最も順次寄りの様式(stepwisePercent=80)がちょうど上限へ
 * 達するように定めた((80-50)*0.8=24)。
 */
export function appoggiaturaRatePercent(stepwisePercent: number): number {
  return Math.max(0, Math.min(25, Math.round((stepwisePercent - 50) * 0.8)));
}
