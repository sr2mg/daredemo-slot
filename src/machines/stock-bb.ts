import type { MachineDef } from '../core/types.js';
import { cross5, sampleRoles, sampleStrips } from './sample-a.js';

/**
 * BB ストック機プリセット（吉宗型: docs/design/01 プリセット表「ストック機」）。
 * - BB/RB をキューにストックし、蓋（gameCountTable 解除）で放出を管理
 * - モード付き解除: 通常モードは深め、天国モードは 1G 連中心
 * - ボーナス終了時にモード移行抽選 + 蓋の掛け直し（engageOn: bonusEnd）
 */
export const stockBB: MachineDef = {
  name: 'サンプル ストック機（1G連タイプ）',
  bet: 3,
  frames: 20,
  strips: sampleStrips,
  lines: cross5,
  roles: sampleRoles,
  priority: 'role-first',
  bonuses: [
    // BB: 24 ゲーム消化で終了（獲得目安 ≒ 176 枚。連チャンで波を作る）
    { id: 'bb_red', kind: 'bb', end: { games: 24 }, tableRef: 'in_bb' },
    { id: 'rb', kind: 'rb', end: { games: 12, wins: 8 }, tableRef: 'in_rb' },
  ],
  rtStates: [],
  carryover: {
    queueLimit: 50,
    lid: {
      engageOn: ['bonusFlag', 'bonusEnd'],
      modes: {
        initial: 'normal',
        states: [
          {
            id: 'normal',
            release: {
              type: 'gameCountTable',
              table: [
                { games: 32, weight: 40 },
                { games: 64, weight: 30 },
                { games: 96, weight: 20 },
                { games: 8, weight: 10 },
              ],
            },
            onBonusEnd: [
              { to: 'normal', weight: 70 },
              { to: 'heaven', weight: 30 },
            ],
          },
          {
            id: 'heaven',
            release: {
              type: 'gameCountTable',
              table: [
                { games: 1, weight: 80 }, // 1G 連
                { games: 8, weight: 20 },
              ],
            },
            onBonusEnd: [
              { to: 'heaven', weight: 50 },
              { to: 'normal', weight: 50 },
            ],
          },
        ],
      },
    },
  },
  lottery: {
    settings: 6,
    base: [
      { roles: ['replay'], weight: 8978 },
      { roles: ['bell'], weight: 6552 },
      { roles: ['cherry'], weight: 1057 },
      { roles: ['melon'], weight: 1200 },
      { roles: ['cherry', 'bb_red'], weight: 66 },
      // ストック機なので成立自体は軽め（≒1/116）。出玉の波は蓋とモードが作る
      { roles: ['bb_red'], weight: 500 },
      { roles: ['rb'], weight: 273 },
    ],
    settingOverrides: {
      '2': [{ roles: ['bb_red'], weight: 545 }],
      '3': [{ roles: ['bb_red'], weight: 595 }],
      '4': [{ roles: ['bb_red'], weight: 650 }],
      '5': [{ roles: ['bb_red'], weight: 710 }],
      '6': [{ roles: ['bb_red'], weight: 900 }, { roles: ['rb'], weight: 340 }],
    },
  },
  tables: {
    in_bb: [{ roles: ['bell'], weight: 60000 }],
    in_rb: [{ roles: ['bell'], weight: 40000 }],
  },
};
