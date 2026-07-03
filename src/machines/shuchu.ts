import type { MachineDef } from '../core/types.js';
import { cross5, sampleRoles, sampleStrips } from './sample-a.js';

/**
 * 集中機プリセット（2〜3号機風。歴史教材）。
 * - スイカ入賞で「SB 集中」に突入: シングルボーナスの重みが 1500 → 36000（≒1/1.8）に跳ね上がる
 * - チェリー入賞でパンク（150G の保険転落つき）
 * - 集中は RT の仕組み（単独役エントリの重み差し替え + roleHit 転落）で表現している。
 *   SB は普通役物なので集中を横切っても状態を壊さない（エンジンの SB 例外規則）
 *
 * ⚠ 集中は 4号機で禁止された仕組みなので、この機種は 4号機基準の適合試験に
 * 「通らないのが正しい」。適合試験パネルで落ちる様子ごと教材として見るための機種。
 */
export const shuchuMachine: MachineDef = {
  name: 'サンプル 集中機（3号機風・SB集中）',
  bet: 3,
  frames: 20,
  strips: sampleStrips,
  lines: cross5,
  roles: [
    ...sampleRoles,
    // SB: replay/replay/bell は各リール PB=1 → どこを押しても揃う 15 枚（stock-sb と同じ構成）
    { id: 'sb_kin', kind: 'bonus', payout: 15, pattern: ['replay', 'replay', 'bell'], pullIn: 'guaranteed' },
  ],
  priority: 'role-first',
  bonuses: [
    { id: 'sb_kin', kind: 'sb', end: {}, tableRef: 'in_sb' },
    { id: 'bb_red', kind: 'bb', end: { games: 20 }, tableRef: 'in_bb' },
  ],
  rtStates: [
    {
      id: 'shuchu',
      // ボーナス役（SB）の確率を状態で変える = 集中。4号機以降は禁止された表現
      replayWeights: { sb_kin: 36000 },
      entry: [{ on: 'roleHit', of: 'melon' }],
      exit: [
        { on: 'roleHit', of: 'cherry' }, // パンク役
        { on: 'games', n: 150 }, //         保険転落
      ],
    },
  ],
  carryover: { queueLimit: 30, lid: null },
  lottery: {
    settings: 1, // 3号機風なので設定なし
    base: [
      { roles: ['replay'], weight: 8978 },
      { roles: ['bell'], weight: 6552 },
      { roles: ['cherry'], weight: 1057 }, // パンク役でもある
      { roles: ['melon'], weight: 800 }, //   集中突入役（目押し必須）
      { roles: ['sb_kin'], weight: 1500 }, // 通常時 SB ≒1/44
      { roles: ['bb_red'], weight: 200 },
    ],
  },
  tables: {
    in_sb: [{ roles: ['bell'], weight: 12000 }],
    in_bb: [{ roles: ['bell'], weight: 60000 }],
  },
};
