import type { MachineDef } from '../core/types.js';

/**
 * 手組みのフィクスチャ機種（A タイププリセット相当のオリジナル機種）。
 * docs/design/04-reel-layout.md の制約を手動で満たしている:
 * - replay / bell: PB=1（各リールで最大間隔 5 コマ以内 = 20 コマに 4 個）
 * - cherry: 左リール 1 個のみ（目押し要素）
 * - seven_red / bar: 各リール 1 個（ボーナス図柄）
 * リール制御エンジンの開発フィクスチャ兼、総当たり性質テストの対象。
 */

const L = [
  'seven_red', // 0
  'bell', //      1
  'blank', //     2
  'replay', //    3
  'cherry', //    4
  'melon', //     5
  'bell', //      6
  'blank', //     7
  'replay', //    8
  'blank', //     9
  'bar', //      10
  'bell', //     11
  'blank', //    12
  'replay', //   13
  'melon', //    14
  'blank', //    15
  'bell', //     16
  'blank', //    17
  'replay', //   18
  'blank', //    19
] as const;

const C = [
  'bell', //      0
  'blank', //     1
  'replay', //    2
  'melon', //     3
  'seven_red', // 4
  'bell', //      5
  'blank', //     6
  'replay', //    7
  'blank', //     8
  'bar', //       9
  'bell', //     10
  'blank', //    11
  'replay', //   12
  'melon', //    13
  'blank', //    14
  'bell', //     15
  'blank', //    16
  'replay', //   17
  'blank', //    18
  'blank', //    19
] as const;

const R = [
  'bell', //      0
  'blank', //     1
  'replay', //    2
  'seven_red', // 3
  'melon', //     4
  'bell', //      5
  'blank', //     6
  'replay', //    7
  'bar', //       8
  'blank', //     9
  'bell', //     10
  'blank', //    11
  'replay', //   12
  'melon', //    13
  'blank', //    14
  'bell', //     15
  'blank', //    16
  'replay', //   17
  'blank', //    18
  'blank', //    19
] as const;

/** 共有リール配列（ストック機プリセットでも再利用。docs/design/04 の制約検証済み） */
export const sampleStrips = [L, C, R] as const;

/** 共有の役定義（Aタイプ標準構成） */
export const sampleRoles: MachineDef['roles'] = [
  { id: 'replay', kind: 'replay', payout: 0, pattern: ['replay', 'replay', 'replay'], pullIn: 'guaranteed' },
  { id: 'bell', kind: 'small', payout: 8, pattern: ['bell', 'bell', 'bell'], pullIn: 'guaranteed' },
  { id: 'cherry', kind: 'small', payout: 2, pattern: ['cherry', 'any', 'any'], pullIn: { missable: { targetRate: 0.35 } } },
  // スイカ: 3 リール目押しのレア役（各リール 2 個。実測引き込み率 ≒14%）
  { id: 'melon', kind: 'small', payout: 15, pattern: ['melon', 'melon', 'melon'], pullIn: { missable: { targetRate: 0.14 } } },
  // targetRate は「単独成立時に適当押しで入賞する率」。3 リール役は各リールの引き込み率の積になる
  // （seven/bar は各リール 7/20 ≒ 35% → 全体 ≒ 4.3%、制御の都合で実測 2.6%）
  { id: 'bb_red', kind: 'bonus', payout: 0, pattern: ['seven_red', 'seven_red', 'seven_red'], pullIn: { missable: { targetRate: 0.043 } } },
  { id: 'rb', kind: 'bonus', payout: 0, pattern: ['bar', 'bar', 'bar'], pullIn: { missable: { targetRate: 0.043 } } },
];

/** 共有の有効ライン（クロス 5 ライン） */
export const cross5: MachineDef['lines'] = [
  [0, 0, 0],
  [1, 1, 1],
  [2, 2, 2],
  [0, 1, 2],
  [2, 1, 0],
];

export const sampleAType: MachineDef = {
  name: 'サンプル A タイプ',
  bet: 3,
  frames: 20,
  strips: sampleStrips,
  lines: cross5,
  roles: sampleRoles,
  priority: 'role-first',
  bonuses: [
    // BB: 30 ゲーム消化で終了（獲得目安 ≒ 30G × (60000/65536) × 8 枚 ≒ 220 枚）
    { id: 'bb_red', kind: 'bb', end: { games: 30 }, tableRef: 'in_bb' },
    // RB: 12 ゲーム or 8 回入賞で終了
    { id: 'rb', kind: 'rb', end: { games: 12, wins: 8 }, tableRef: 'in_rb' },
  ],
  rtStates: [
    // BB 終了後 50 ゲームのリプレイ高確率 RT
    {
      id: 'rt_high',
      replayWeights: { replay: 29127 },
      entry: [{ on: 'bonusEnd', of: 'bb_red' }],
      exit: [{ on: 'games', n: 50 }],
    },
  ],
  carryover: { queueLimit: 1, lid: null },
  lottery: {
    settings: 6,
    base: [
      // 基底 = 設定 1
      { roles: ['replay'], weight: 8978 }, //  ≒1/7.3
      { roles: ['bell'], weight: 9000 }, //    ≒1/7.3
      { roles: ['cherry'], weight: 1057 }, //  ≒1/62
      { roles: ['melon'], weight: 1200 }, //   ≒1/55（目押しできる人へのご褒美）
      { roles: ['cherry', 'bb_red'], weight: 66 },
      { roles: ['bb_red'], weight: 210 }, //   ≒1/312
      { roles: ['rb'], weight: 280 }, //       ≒1/234
    ],
    // 設定差はボーナス確率 + 高設定のベル（差分上書き）
    settingOverrides: {
      '2': [{ roles: ['bb_red'], weight: 240 }, { roles: ['rb'], weight: 290 }],
      '3': [{ roles: ['bb_red'], weight: 275 }, { roles: ['rb'], weight: 300 }],
      '4': [{ roles: ['bb_red'], weight: 320 }, { roles: ['rb'], weight: 310 }],
      '5': [{ roles: ['bb_red'], weight: 380 }, { roles: ['rb'], weight: 320 }],
      '6': [{ roles: ['bb_red'], weight: 450 }, { roles: ['rb'], weight: 330 }, { roles: ['bell'], weight: 9600 }],
    },
  },
  tables: {
    in_bb: [{ roles: ['bell'], weight: 60000 }],
    in_rb: [{ roles: ['bell'], weight: 40000 }],
  },
};
