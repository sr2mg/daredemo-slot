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
  'blank', //     5
  'bell', //      6
  'blank', //     7
  'replay', //    8
  'blank', //     9
  'bar', //      10
  'bell', //     11
  'blank', //    12
  'replay', //   13
  'blank', //    14
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
  'blank', //     3
  'seven_red', // 4
  'bell', //      5
  'blank', //     6
  'replay', //    7
  'blank', //     8
  'bar', //       9
  'bell', //     10
  'blank', //    11
  'replay', //   12
  'blank', //    13
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
  'blank', //     4
  'bell', //      5
  'blank', //     6
  'replay', //    7
  'bar', //       8
  'blank', //     9
  'bell', //     10
  'blank', //    11
  'replay', //   12
  'blank', //    13
  'blank', //    14
  'bell', //     15
  'blank', //    16
  'replay', //   17
  'blank', //    18
  'blank', //    19
] as const;

export const sampleAType: MachineDef = {
  name: 'サンプル A タイプ',
  frames: 20,
  strips: [L, C, R],
  // クロス 5 ライン（水平 3 + 対角 2）
  lines: [
    [0, 0, 0],
    [1, 1, 1],
    [2, 2, 2],
    [0, 1, 2],
    [2, 1, 0],
  ],
  roles: [
    { id: 'replay', kind: 'replay', payout: 0, pattern: ['replay', 'replay', 'replay'], pullIn: 'guaranteed' },
    { id: 'bell', kind: 'small', payout: 8, pattern: ['bell', 'bell', 'bell'], pullIn: 'guaranteed' },
    { id: 'cherry', kind: 'small', payout: 2, pattern: ['cherry', 'any', 'any'], pullIn: { missable: { targetRate: 0.35 } } },
    { id: 'bb_red', kind: 'bonus', payout: 0, pattern: ['seven_red', 'seven_red', 'seven_red'], pullIn: { missable: { targetRate: 0.25 } } },
    { id: 'rb', kind: 'bonus', payout: 0, pattern: ['bar', 'bar', 'bar'], pullIn: { missable: { targetRate: 0.25 } } },
  ],
  priority: 'role-first',
  baseTable: [
    { roles: ['replay'], weight: 8978 }, //  ≒1/7.3
    { roles: ['bell'], weight: 6552 }, //    ≒1/10
    { roles: ['cherry'], weight: 1057 }, //  ≒1/62
    { roles: ['cherry', 'bb_red'], weight: 66 },
    { roles: ['bb_red'], weight: 200 },
    { roles: ['rb'], weight: 273 },
  ],
};
