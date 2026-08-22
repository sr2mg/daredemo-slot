/**
 * テンション方針: アヴェイラブル・テンション理論によるカラートーンの導出。
 *
 * 規則は列挙ではなく導出する。コードスケール(小節の局所音組織)の音のうち、
 * - コードトーンでない
 * - どのコードトーンの半音上でもない(アヴォイド・ノート規則)
 * 音だけがテンションとして使える。この2条件だけで、長三和音には9th/6th/M7、
 * 短三和音にはm7/9th、Vにはb7/9th/13thという実際のポップスの色彩が自動的に出る。
 *
 * 選好順はESTi系実測分布(M7 41% > add9系 34% > 6th 11%)を写した
 * 7度系(M7/b7) → 9th → 6th/13th → 11th。和声機能(ChordEvent.pcs)は
 * 一切触らず、ボイシング(midis)にだけ乗せる=テンションは声部の選択であって
 * 機能の変更ではない、という理論上の位置づけをコード上でも保つ。
 */

import type { TensionPolicy } from './types.js';

export const TENSION_POLICY_LABELS: Record<'auto' | TensionPolicy, string> = {
  auto: 'スタイル既定',
  off: 'なし（素の和音）',
  soft: 'ソフト（1音）',
  // 4和音(7th系)は密集配置の5声上限により1音に丸まる。三和音でだけ2音になる。
  lush: 'リッチ（最大2音）',
};

/** ルートからの相対音程による選好順。7度系→9th→6th/13th→11th。 */
const PREFERENCE_ORDER: readonly number[] = [11, 10, 2, 9, 5];

/**
 * 使えるテンションを絶対ピッチクラスで返す(選好順)。
 * chordPcs: コードトーン(絶対pc)、scalePcs: その小節のコードスケール(絶対pc)。
 */
export function availableTensionPcs(
  chordPcs: readonly number[],
  scalePcs: readonly number[],
  rootPc: number,
): number[] {
  const halfAbove = new Set(chordPcs.map((pc) => (pc + 1) % 12));
  const available = scalePcs.filter((pc) => !chordPcs.includes(pc) && !halfAbove.has(pc));
  const rank = (pc: number): number => {
    const index = PREFERENCE_ORDER.indexOf((((pc - rootPc) % 12) + 12) % 12);
    return index === -1 ? 99 : index;
  };
  return [...available].sort((a, b) => rank(a) - rank(b));
}

/** 方針に応じて実際にボイシングへ足すテンションを選ぶ。soft=1音、lush=2音まで。 */
export function selectTensionPcs(
  chordPcs: readonly number[],
  scalePcs: readonly number[],
  rootPc: number,
  policy: TensionPolicy,
): number[] {
  if (policy === 'off') return [];
  const ranked = availableTensionPcs(chordPcs, scalePcs, rootPc)
    .filter((pc) => PREFERENCE_ORDER.includes((((pc - rootPc) % 12) + 12) % 12));
  return ranked.slice(0, policy === 'lush' ? 2 : 1);
}
