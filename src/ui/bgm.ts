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
 * - BB: 草競馬（S. フォスター, 1864 年没）。明るい競走曲。バニーガール等の古典手法
 * - RB: チャールダーシュ（V. モンティ, 1937 年没）フリスカ部。短めボーナスの疾走感
 * - RB 候補 2: ジムノペディ第 1 番（E. サティ, 1925 年没）。しっとり・寂しめ
 * - RB 候補 3: 別れの曲（F. ショパン, 1849 年没）主題。聴き比べ用
 *
 * 調の統一: 操作音（ベット G4+E5 / レバー C5+A5 / C メジャーのファンファーレ）が
 * 曲に乗るよう、チャールダーシュはイ短調（C メジャーの平行調）、他はハ長調。
 * チャンネル予算: 効果音 ch0-1 / リード ch2 / バッキング ch3 / ベース ch4 / リズム ch6-8
 */

export type BgmName = 'bb' | 'rb' | 'rb2' | 'rb3';

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
  // ---- BB: 草競馬 ハ長調・8 小節・120BPM（原曲 2/4 × 16 小節を 4/4 に圧縮） ----
  // メロディは The Session 掲載の ABC 譜（G メジャー）を C に移調して採譜。
  // 前半 4 小節 = 主節（ドゥーダー・ドゥーダー）、後半 4 小節 = コーラス
  // （E-G-A-B と駆け上がって高いドが頂点）。トランペットは競馬ファンファーレの見立て
  const bb = compileSong({
    bpm: 120,
    bars: 8,
    tracks: [
      {
        ch: 2,
        voice: V_TRUMPET,
        vol: 3,
        octave: 5,
        mml:
          'a8 g8 e8 g8 a8 g8 e4 | e8 d8 d8 c16 d16 e8 d8 d8 e16 g16 | a8 g8 e8 g8 a8 g8 e8 c8 | d8 c16 d16 e8 d8 c4 c4 |' +
          'e8 g8 a8 b8 > c4 c4 < | b8 a8 b8 a8 g4 g8 e16 g16 | a8 g8 e8 g8 a8 g8 e8 c8 | d8 c16 d16 e8 d8 c4 c4',
      },
      {
        ch: 3,
        voice: V_ORGAN,
        vol: 7,
        octave: 4,
        mml:
          'l8 r e r g r e r g | r d r f r d r f | r e r g r e r g | r d r f r e r g |' +
          '   r e r g r e r g | r d r f r e r g | r e r g r e r g | r d r f r e r g',
      },
      {
        ch: 4,
        voice: V_SYNBASS,
        vol: 3,
        octave: 3,
        mml:
          'l8 c r g r c r g r | g r d r g r d r | c r g r c r g r | g r d r c r g r |' +
          '   c r g r c r g r | g r d r c r g r | c r g r c r g r | g r d r c r c r',
      },
    ],
    drums:
      'bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sh h |' +
      'bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sc h',
  });

  // ---- RB: チャールダーシュ（フリスカ）イ短調・8 小節・116BPM ----
  // MIDI 採譜で照合した本来のフリスカ主部（原曲 2/4 × 16 小節 = ちょうど 8 小節）:
  // 高音へのオクターブ跳躍→下降句 / 16 分の反復音型（ラシドシ→レミファミ→ドレミレ）/
  // 上昇スケール一気駆け→下降→カデンツ。D 短調原曲をイ短調に移調
  const rb = compileSong({
    bpm: 116,
    bars: 8,
    tracks: [
      {
        ch: 2,
        voice: V_TRUMPET,
        vol: 3,
        octave: 4,
        mml:
          'l16 a8 > a4 f4 e4 c8 | < b8 a4 g+8 a2 |' +
          ' a b > c < b a b > c < b a b > c < b a b > c < a |' +
          ' > c8 < b4 a+8 b2 |' +
          ' > d e f e d e f e d e f e d f e d |' +
          ' c d e d c d e d c d e d c e d c |' +
          ' < e f+ g+ a b > c d e f e d c < b a g+ b |' +
          ' b8 a4 g+8 a2',
      },
      {
        ch: 3,
        voice: V_ORGAN,
        vol: 7,
        octave: 4,
        mml:
          'l8 r c r e r c r e | r d r e r c r e | r c r e r c r e | r d r e r d r e |' +
          '   r f r a r f r a | r e r g r e r g | r c r e r d r e | r d r e r c r e',
      },
      {
        ch: 4,
        voice: V_SYNBASS,
        vol: 3,
        octave: 3,
        mml:
          'l8 a r e r a r e r | e r e r a r a r | a r e r a r e r | e r e r e r e r |' +
          '   d r a r d r a r | c r g r c r g r | a r e r e r e r | e r e r a r a r',
      },
    ],
    drums:
      'bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sh h |' +
      'bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sc h',
  });

  // ---- RB 候補 2: ジムノペディ第 1 番 ハ長調・3/4 × 8 小節（4/4 換算 6 小節）・66BPM ----
  // MIDI 採譜で照合。メロディは原曲どおり 2 拍目から入り（休符→ソシ…ではなく r ミソ｜ファミシ｜
  // ラシド｜ソ—｜ミ—）、伴奏は 1 拍目ベース + 2〜3 拍目の和音（Fmaj7 / Cmaj7 の交互）。ドラムなし
  const rb2 = compileSong({
    bpm: 66,
    bars: 6,
    tracks: [
      {
        ch: 2,
        voice: V_FLUTE,
        vol: 3,
        octave: 5,
        mml: 'r2. | r2. | r4 e4 g4 | f4 e4 < b4 | a4 b4 > c4 | < g2. | e2. | r2.',
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

  // ---- RB 候補 3: 別れの曲 ハ長調・4 小節・60BPM ----
  // MIDI 採譜で照合した主題（原曲ホ長調: ミ・レ♯・ミ・ファ♯｜ソ♯・ソ♯・ファ♯・ミ →
  // ハ長調: ド・シ・ド・レ｜ミ・ミ・レ・ド）+ 応答句（ファ・ファ・ミ・ラ）+ 下行カデンツ
  const rb3 = compileSong({
    bpm: 60,
    bars: 4,
    tracks: [
      {
        ch: 2,
        voice: V_VIOLIN,
        vol: 3,
        octave: 5,
        mml: 'c4. < b8 > c4 d4 | e4 e8 d8 c2 | f4 f8 e8 a4 f4 | g8 f8 e8 d8 c2',
      },
      {
        ch: 3,
        voice: V_PIANO,
        vol: 6,
        octave: 3,
        mml: 'l8 c e g e c e g e | c e g e d f g f | f a > c < a f a > c < a | d f g f c e g e',
      },
      {
        ch: 4,
        voice: V_ABASS,
        vol: 4,
        octave: 2,
        mml: 'c2 g2 | c2 g2 | f2 f2 | g2 c2',
      },
    ],
  });

  return {
    bb: { duration: bb.duration, events: bb.events, bpm: 120, bars: 8 },
    rb: { duration: rb.duration, events: rb.events, bpm: 116, bars: 8 },
    rb2: { duration: rb2.duration, events: rb2.events, bpm: 66, bars: 6 },
    rb3: { duration: rb3.duration, events: rb3.events, bpm: 60, bars: 4 },
  };
}
