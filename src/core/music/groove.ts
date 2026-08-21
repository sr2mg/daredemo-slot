/**
 * グルーヴの宣言カタログ。
 *
 * 作曲・診断・UIは「フィールの名前」でなく「軸の値」で分岐する。従来は
 * `grooveFeel !== 'tripletOverlay'` 型のアイデンティティ比較がcompose/diagnostics/
 * arrangement/UIに十数箇所散らばり、フィール追加のたびに全箇所の再訪が必要だった
 * (sound-capabilities.tsがバックエンドで治療したのと同じ病気)。ここに軸を宣言として
 * 集約し、各分岐は該当軸を参照するだけにする。
 *
 * グルーヴを構成する直交軸は2本:
 * - swing: 裏拍の変位。「どの幅の対で(8分スウィング=1拍)・対のどこへ(2:1=2/3)」の
 *   ペアで表す。位置を動かす唯一の軸で、機構はgrooveBeatが単一に所有する。
 * - subdivisionOverlay: ハット層が基準の16分グリッドと別の細分を敷くか。
 *   'triplet'はスタイル譜のハットを三連位置へ要約して写す(機構はtripletHatOffsets)。
 *
 * 残りの性質(走句の可否・連符レイヤーとの共存・イントロのグルーヴ提示候補)は
 * この2軸から導出する(下部のヘルパ)。軸に還元できない性質を足したくなったら、
 * まずそれが本当に独立軸なのかを疑うこと。
 */

/** グルーヴの外部ID。保存曲(JSON)へ書かれる識別子なので値は変えない。 */
export type GrooveFeel = 'straight' | 'tripletOverlay' | 'bounce' | 'shuffle16';

export interface GrooveDef {
  id: GrooveFeel;
  label: string;
  /**
   * スウィング(裏拍の変位)。nullはストレート。
   * pairSpanBeats: 変位が起こる表裏対の幅(拍)。8分スウィング=1、16分スウィングなら0.5。
   * offbeatPosition: 対の中で裏拍が落ちる位置の比率。ストレート相当0.5、2:1は2/3。
   */
  swing: { pairSpanBeats: number; offbeatPosition: number } | null;
  /**
   * 細分オーバーレイ。オーバーレイを持つグルーヴは、同じ「細分の注意」を占有する
   * 装置(連符レイヤー・長形式の分散和音主導)と併用しない(導出ヘルパ参照)。
   */
  subdivisionOverlay: 'none' | 'triplet';
}

export const GROOVES: Record<GrooveFeel, GrooveDef> = {
  straight: {
    id: 'straight',
    label: 'ストレート',
    swing: null,
    subdivisionOverlay: 'none',
  },
  tripletOverlay: {
    id: 'tripletOverlay',
    label: '三連オーバーレイ',
    swing: null,
    subdivisionOverlay: 'triplet',
  },
  bounce: {
    id: 'bounce',
    label: '跳ねる8分',
    swing: { pairSpanBeats: 1, offbeatPosition: 2 / 3 },
    subdivisionOverlay: 'none',
  },
  // 16分スウィング(UKガラージ/2ステップの跳ね)。対の幅が8分(0.5拍)なので
  // 8分裏は対の先頭に当たり変位しない=旋律・ベースの8分骨格はストレートのまま、
  // 16分裏(ドラムの16分・装飾音)だけが2:1へ跳ねる。機構はgrooveBeatがそのまま扱う。
  shuffle16: {
    id: 'shuffle16',
    label: 'シャッフル16分',
    swing: { pairSpanBeats: 0.5, offbeatPosition: 2 / 3 },
    subdivisionOverlay: 'none',
  },
};

/** UI表示順を兼ねる全ID。 */
export const GROOVE_FEELS = Object.keys(GROOVES) as GrooveFeel[];

/** 保存JSONで省略される既定値。 */
export const DEFAULT_GROOVE_FEEL: GrooveFeel = 'straight';

export const GROOVE_FEEL_LABELS: Record<GrooveFeel, string> = Object.fromEntries(
  GROOVE_FEELS.map((id) => [id, GROOVES[id].label]),
) as Record<GrooveFeel, string>;

export function grooveFor(feel: GrooveFeel): GrooveDef {
  return GROOVES[feel];
}

export function isGrooveFeel(value: unknown): value is GrooveFeel {
  return typeof value === 'string' && value in GROOVES;
}

/**
 * 論理拍(ストレート格子)を実際の発音拍へ写す。swing軸だけが位置を動かす。
 * 対の中央(=ストレートの裏拍)に乗る打点のみ変位し、それ以外は素通しなので、
 * スウィングより細かい格子(bounce時の16分)は呼び出し側が論理拍のまま使えばよい。
 */
export function grooveBeat(beat: number, feel: GrooveFeel): number {
  const swing = GROOVES[feel].swing;
  if (!swing) return beat;
  const span = swing.pairSpanBeats;
  const pairStart = Math.floor(beat / span) * span;
  const fraction = (beat - pairStart) / span;
  return Math.abs(fraction - 0.5) < 0.001 ? pairStart + swing.offbeatPosition * span : beat;
}

/**
 * subdivisionOverlay='triplet' の機構: 元の16分ハット譜(1拍ぶん)を三連グリッドへ
 * 要約する。1拍を常に3発で埋めず、表拍は表、単独の裏拍は三連の後ろ、
 * 裏が2発以上ある細かい譜だけを三連の中・後ろへ写す。
 */
export function tripletHatOffsets(pattern: readonly number[], quarter: number): number[] {
  const start = quarter * 4;
  const offsets: number[] = [];
  if (pattern[start]) offsets.push(0);
  const offbeatCount = pattern.slice(start + 1, start + 4).filter(Boolean).length;
  if (offbeatCount === 1) offsets.push(2 / 3);
  else if (offbeatCount >= 2) offsets.push(1 / 3, 2 / 3);
  return offsets;
}

// --- 2軸からの導出 ---

/**
 * ストレートな16分格子が旋律側で有効か(=ディミニューションの走句が置けるか)。
 * スウィングは16分位置をスウィング格子とずらし、細分オーバーレイは16分の走句と
 * 別細分のハット層を衝突させるため、どちらか一方でもあれば不可。
 */
export function hasStraightSixteenths(feel: GrooveFeel): boolean {
  const def = GROOVES[feel];
  return def.swing === null && def.subdivisionOverlay === 'none';
}

/**
 * 連符レイヤー(tupletOverlay)と共存できるか。細分オーバーレイを持つグルーヴは
 * 同じ細分の注意を既に占有しているため不可。
 */
export function allowsTupletOverlay(feel: GrooveFeel): boolean {
  return GROOVES[feel].subdivisionOverlay === 'none';
}

/**
 * グルーヴ自体が提示に値する装置を持つか(イントロの「グルーヴ提示型」候補になるか)。
 * どちらかの軸が既定値から動いていれば、その語り口を冒頭で聴かせる価値がある。
 */
export function hasGrooveDevice(feel: GrooveFeel): boolean {
  const def = GROOVES[feel];
  return def.swing !== null || def.subdivisionOverlay !== 'none';
}
