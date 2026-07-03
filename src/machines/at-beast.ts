import type { MachineDef } from '../core/types.js';
import { cross5, sampleStrips } from './sample-a.js';

/**
 * AT 機プリセット（獣王型: docs/design/01 プリセット表「AT 機」）。
 * - ベルは押し順 3 択（第 1 停止のみ判定）のフラグ細分化: bell_L / bell_C / bell_R
 *   同一の図柄組み合わせ（ベル揃い 8 枚）を共有し、正解時のみ揃う。不正解は 1 枚のこぼしベル
 * - AT 中はナビ層（サブ基板）が正解の第 1 停止を開示する。メインの抽選は AT の有無で一切変わらない
 * - AT 抽選契機はレア役と純ハズレ（獣王の SC 抽選と同じ発想）
 */
export const atBeast: MachineDef = {
  name: 'サンプル AT機（押し順ナビタイプ）',
  bet: 3,
  frames: 20,
  strips: sampleStrips,
  lines: cross5,
  roles: [
    { id: 'replay', kind: 'replay', payout: 0, pattern: ['replay', 'replay', 'replay'], pullIn: 'guaranteed' },
    // 押し順ベル 3 択（フラグ細分化。pattern は 3 つとも同一 = 蹴飛ばしは組み合わせ単位）
    {
      id: 'bell_L', kind: 'small', payout: 8, pattern: ['bell', 'bell', 'bell'], pullIn: 'guaranteed',
      nav: { group: 'bell3', correctFirst: 0, onMiss: { type: 'reduced', roleRef: 'bell_weak' } },
    },
    {
      id: 'bell_C', kind: 'small', payout: 8, pattern: ['bell', 'bell', 'bell'], pullIn: 'guaranteed',
      nav: { group: 'bell3', correctFirst: 1, onMiss: { type: 'reduced', roleRef: 'bell_weak' } },
    },
    {
      id: 'bell_R', kind: 'small', payout: 8, pattern: ['bell', 'bell', 'bell'], pullIn: 'guaranteed',
      nav: { group: 'bell3', correctFirst: 2, onMiss: { type: 'reduced', roleRef: 'bell_weak' } },
    },
    // こぼしベル（押し順不正解時に入賞する 1 枚役）
    { id: 'bell_weak', kind: 'small', payout: 1, pattern: ['bell', 'bell', 'blank'], pullIn: 'guaranteed' },
    { id: 'cherry', kind: 'small', payout: 2, pattern: ['cherry', 'any', 'any'], pullIn: { missable: { targetRate: 0.35 } } },
    { id: 'melon', kind: 'small', payout: 15, pattern: ['melon', 'melon', 'melon'], pullIn: { missable: { targetRate: 0.14 } } },
    { id: 'bb_red', kind: 'bonus', payout: 0, pattern: ['seven_red', 'seven_red', 'seven_red'], pullIn: { missable: { targetRate: 0.043 } } },
  ],
  navGroups: [{ id: 'bell3' }],
  priority: 'role-first',
  bonuses: [{ id: 'bb_red', kind: 'bb', end: { games: 20 }, tableRef: 'in_bb' }],
  rtStates: [],
  carryover: { queueLimit: 1, lid: null },
  lottery: {
    base: [
      { roles: ['replay'], weight: 8978 },
      { roles: ['bell_L'], weight: 5000 }, // 3 択合計 ≒1/4.4
      { roles: ['bell_C'], weight: 5000 },
      { roles: ['bell_R'], weight: 5000 },
      { roles: ['cherry'], weight: 1057 },
      { roles: ['melon'], weight: 655 },
      { roles: ['bb_red'], weight: 250 },
    ],
  },
  tables: {
    in_bb: [{ roles: ['bell_L'], weight: 20000 }, { roles: ['bell_C'], weight: 20000 }, { roles: ['bell_R'], weight: 20000 }],
  },
  nav: {
    at: {
      triggers: [
        { on: 'roleHit', of: 'cherry', prob: 0.33 },
        { on: 'roleHit', of: 'melon', prob: 0.5 },
        { on: 'pureMiss', prob: 0.005 },
        { on: 'gamesCeiling', n: 500 },
      ],
      management: { type: 'set', gamesPerSet: 30, continueProb: 0.7 },
      addOn: [{ on: 'roleHit', of: 'melon', addGames: 10 }],
      navTargets: ['bell3'],
    },
  },
};
