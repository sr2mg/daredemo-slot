import { compileSong } from './mml.js';
import type { SfxDef } from './opll-core.js';

/**
 * BGM 定義。
 *
 * 権利方針: 実機楽曲の再現はしない。使うのはパブリックドメイン（作曲者の
 * 没後 70 年経過）のクラシックのみで、アレンジ（OPLL 3ch + リズムへの落とし込み）
 * は自作。実機で同曲を使った機種があっても、その機種のアレンジは参照しない。
 *
 * 選曲:
 * - BB: チャールダーシュ（V. モンティ, 1937 年没）フリスカ部。剣の舞系の疾走感
 * - RB: ジムノペディ第 1 番（E. サティ, 1925 年没）。しっとり・寂しめ
 * - RB 候補 2: 別れの曲（F. ショパン, 1849 年没）主題。聴き比べ用
 *
 * 調の統一: 操作音（ベット G4+E5 / レバー C5+A5 / C メジャーのファンファーレ）が
 * 曲に乗るよう、チャールダーシュはイ短調（C メジャーの平行調）、サティとショパンは
 * ハ長調に移調してある。
 * チャンネル予算: 効果音 ch0-1 / リード ch2 / バッキング ch3 / ベース ch4 / リズム ch6-8
 */

export type BgmName = 'bb' | 'rb' | 'rb2';

export interface BgmDef extends SfxDef {
  bpm: number;
  /** 4/4 換算の小節数（3 拍子の曲は拍数を 4 で割った値） */
  bars: number;
}

const V_VIOLIN = 1;
const V_PIANO = 3;
const V_FLUTE = 4;
const V_TRUMPET = 7;
const V_ORGAN = 8;
const V_VIBRAPHONE = 12;
const V_SYNBASS = 13;
const V_ABASS = 14;

export function buildBgmDefs(): Record<BgmName, BgmDef> {
  // ---- BB: チャールダーシュ（フリスカ）イ短調・8 小節・104BPM・構成 A A B A ----
  // A = フリスカ主題 2 小節（16 分の駆け上がり + 連打）。B = トレモロで上昇→下降する対比句
  const MEL_A =
    'a b > c d e e e e e f e d c c c c | c d c < b a a a a g+ a b g+ a a a a ';
  const MEL_B =
    '> c c c c d d d d e e e e f f f f | e e e e d d d d < b b b b g+ g+ g+ g+ ';
  const BAK_A = 'r e r e r e r e | r f r f r e r e ';
  const BAK_B = 'r a r a r f r f | r e r e r e r e ';
  const BAS_A = 'a r e r a r e r | a r e r e r e r ';
  const BAS_B = 'a r a r f r f r | e r e r e r e r ';
  const bb = compileSong({
    bpm: 104,
    bars: 8,
    tracks: [
      { ch: 2, voice: V_TRUMPET, vol: 3, octave: 4, mml: 'l16 ' + MEL_A + MEL_A + MEL_B + MEL_A },
      { ch: 3, voice: V_ORGAN, vol: 7, octave: 4, mml: 'l8 ' + BAK_A + BAK_A + BAK_B + BAK_A },
      { ch: 4, voice: V_SYNBASS, vol: 3, octave: 3, mml: 'l8 ' + BAS_A + BAS_A + BAS_B + BAS_A },
    ],
    drums:
      'bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sh h |' +
      'bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sc h',
  });

  // ---- RB: ジムノペディ第 1 番 ハ長調・3/4 × 8 小節（4/4 換算 6 小節）・66BPM ----
  // 原曲どおり 1 拍目ベース + 2〜3 拍目の和音（Fmaj7 / Cmaj の交互）。ドラムなし
  const rb = compileSong({
    bpm: 66,
    bars: 6,
    tracks: [
      {
        ch: 2,
        voice: V_FLUTE,
        vol: 3,
        octave: 5,
        mml: 'r2. | r2. | e4 g4 f4 | e4 < b4 a4 | b4 > c4 < g4 | g2. | e4 d4 c4 | d2.',
      },
      {
        ch: 3,
        voice: V_VIBRAPHONE,
        vol: 5,
        octave: 4,
        mml:
          'r4 a4 e4 | r4 g4 e4 | r4 a4 e4 | r4 g4 e4 |' +
          'r4 a4 e4 | r4 g4 e4 | r4 a4 e4 | r4 g4 e4',
      },
      {
        ch: 4,
        voice: V_ABASS,
        vol: 3,
        octave: 2,
        mml: 'f2. | > c2. < | f2. | > c2. < | f2. | > c2. < | f2. | > c2. <',
      },
    ],
  });

  // ---- RB 候補 2: 別れの曲 ハ長調・4 小節・60BPM ----
  // 主題（3-2-3-4-5 の上行 → 上声の応答 → ため息の下行 → 解決）+ ピアノ分散和音
  const rb2 = compileSong({
    bpm: 60,
    bars: 4,
    tracks: [
      {
        ch: 2,
        voice: V_VIOLIN,
        vol: 3,
        octave: 4,
        mml: 'e4 d8 e8 f4 g4 | > c4 < b8 > c8 d4 < g4 | a4 g8 f8 e4 d4 | e4 d4 c2',
      },
      {
        ch: 3,
        voice: V_PIANO,
        vol: 6,
        octave: 3,
        mml: 'l8 c e g e c e g e | c e g e d f g f | c f a f d f g f | c e g e g e c4',
      },
      {
        ch: 4,
        voice: V_ABASS,
        vol: 4,
        octave: 2,
        mml: 'c2 g2 | c2 g2 | f2 g2 | c1',
      },
    ],
  });

  return {
    bb: { duration: bb.duration, events: bb.events, bpm: 104, bars: 8 },
    rb: { duration: rb.duration, events: rb.events, bpm: 66, bars: 6 },
    rb2: { duration: rb2.duration, events: rb2.events, bpm: 60, bars: 4 },
  };
}
