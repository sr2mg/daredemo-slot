import type { MachineDef } from '../core/types.js';
import { cross5, sampleRoles, sampleStrips } from './sample-a.js';

/**
 * SB ストック機プリセット（サラ金型）。
 * - SB（シングルボーナス）を高頻度で抽選してキューにストック
 * - 解除契機は「純ハズレ」時の解除抽選（release: lottery, on: pureMiss）
 * - 解除されるとキューが尽きるまで毎ゲーム SB が放出される（KC 的な放出ゾーン）。
 *   放出中に新たな SB が成立してもキューに積まれるだけで蓋は掛からない
 *   （engageOn: bonusFlag = 空→非空遷移時のみ）
 */
export const stockSB: MachineDef = {
  name: 'サンプル SBストック機（放出ゾーンタイプ）',
  bet: 3,
  frames: 20,
  strips: sampleStrips,
  lines: cross5,
  roles: [
    ...sampleRoles,
    // SB 役: 揃えやすい図柄の組み合わせ（replay/replay/bell は各リール PB=1 → 中段で常に引き込める）。
    // 実機サラ金に合わせて揃った瞬間に 15 枚直払い（作動ゲーム側はほぼ素通り）
    { id: 'sb_kin', kind: 'bonus', payout: 15, pattern: ['replay', 'replay', 'bell'], pullIn: 'guaranteed' },
  ],
  priority: 'role-first',
  bonuses: [
    { id: 'sb_kin', kind: 'sb', end: {}, tableRef: 'in_sb' },
    { id: 'bb_red', kind: 'bb', end: { games: 20 }, tableRef: 'in_bb' },
  ],
  rtStates: [],
  carryover: {
    queueLimit: 30,
    lid: {
      engageOn: ['bonusFlag'],
      release: { type: 'lottery', weight: 6553, on: 'pureMiss' }, // 純ハズレの 10% で放出開始
    },
  },
  lottery: {
    base: [
      { roles: ['replay'], weight: 8978 },
      { roles: ['bell'], weight: 6552 },
      { roles: ['cherry'], weight: 1057 },
      { roles: ['melon'], weight: 655 },
      { roles: ['sb_kin'], weight: 5000 }, // ≒1/13 で SB がストックされていく
      { roles: ['bb_red'], weight: 150 },
    ],
  },
  tables: {
    // SB の価値は揃った瞬間の 15 枚。作動ゲーム（1 ゲーム）は小役確率がわずかに上がる程度
    in_sb: [{ roles: ['bell'], weight: 12000 }],
    in_bb: [{ roles: ['bell'], weight: 60000 }],
  },
};
