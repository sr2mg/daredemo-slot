import type { MachineDef } from '../core/types.js';
import { cross5, sampleRoles, sampleStrips } from './sample-a.js';

/**
 * CT 機プリセット（4号機後期に認められた技術介入タイプ）。
 * - BB 終了後に CT（チャレンジタイム）へ突入
 * - CT 中は抽選テーブルは通常のまま、リール制御だけが変わり、
 *   スイカ（15 枚）が成立フラグに関係なく引き込み制御へ乗る
 *   = 目押しできる人は毎ゲーム 15 枚を狙えて、できない人はほぼ増えない
 * - 終了はゲーム数 / 獲得枚数 / リプレイ入賞のパンクの早いもの勝ち
 * 「技術介入の出玉ゾーン」が完全打ちと適当打ちの差そのものになる教材機。
 */
export const ctMachine: MachineDef = {
  name: 'サンプル CT機（技術介入タイプ）',
  bet: 3,
  frames: 20,
  strips: sampleStrips,
  lines: cross5,
  roles: sampleRoles,
  priority: 'role-first',
  bonuses: [
    { id: 'bb_red', kind: 'bb', end: { games: 25 }, tableRef: 'in_bb' },
    { id: 'rb', kind: 'rb', end: { games: 12, wins: 8 }, tableRef: 'in_rb' },
  ],
  rtStates: [],
  ct: [
    {
      id: 'ct',
      freeRoles: ['melon'],
      entry: [{ on: 'bonusEnd', of: 'bb_red' }],
      // リプレイが揃うとパンク（実機の JAC IN パンクに相当）
      end: { games: 30, maxPayout: 120, punkRoles: ['replay'] },
    },
  ],
  carryover: { queueLimit: 1, lid: null },
  lottery: {
    settings: 6,
    base: [
      { roles: ['replay'], weight: 8978 }, //  ≒1/7.3
      { roles: ['bell'], weight: 9300 }, //    ≒1/7.0
      { roles: ['cherry'], weight: 1057 }, //  ≒1/62
      { roles: ['melon'], weight: 1100 }, //   ≒1/60
      { roles: ['cherry', 'bb_red'], weight: 66 },
      { roles: ['bb_red'], weight: 190 }, //   単独 ≒1/345（重複込み ≒1/256）
      { roles: ['rb'], weight: 280 }, //       ≒1/234
    ],
    settingOverrides: {
      '2': [{ roles: ['bb_red'], weight: 215 }],
      '3': [{ roles: ['bb_red'], weight: 245 }],
      '4': [{ roles: ['bb_red'], weight: 280 }],
      '5': [{ roles: ['bb_red'], weight: 335 }],
      '6': [{ roles: ['bb_red'], weight: 400 }, { roles: ['rb'], weight: 310 }],
    },
  },
  tables: {
    in_bb: [{ roles: ['bell'], weight: 60000 }],
    in_rb: [{ roles: ['bell'], weight: 40000 }],
  },
};
