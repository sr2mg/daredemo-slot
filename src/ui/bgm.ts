import { compileSong } from './mml.js';
import type { SfxDef } from './opll-core.js';

/**
 * BGM 定義（すべてオリジナル曲。実機楽曲の再現ではない）。
 *
 * 作曲方針（アルゼ系 4 号機の「文法」に寄せる）:
 * - C メジャーで統一（ベット=ミ・レバー=ラ・ファンファーレと同じ調 → 操作音が曲に乗る）
 * - BB は 8 小節ループの祭り系（I-IV-V 進行、裏打ちオルガン、8 分駆動のベース）
 * - RB は BB と同じモチーフの 4 小節縮約・テンポ落とし（兄弟曲にして機種の統一感を出す）
 * - チャンネル予算: 効果音 ch0-1 / リード ch2 / バッキング ch3 / ベース ch4 / リズム ch6-8
 */

export type BgmName = 'bb' | 'rb';

export interface BgmDef extends SfxDef {
  bpm: number;
  bars: number;
}

const V_TRUMPET = 7;
const V_ORGAN = 8;
const V_SYNBASS = 13;

export function buildBgmDefs(): Record<BgmName, BgmDef> {
  // ---- BB: 8 小節・138BPM・進行 C C F G | C F G C ----
  const bb = compileSong({
    bpm: 138,
    bars: 8,
    tracks: [
      {
        ch: 2,
        voice: V_TRUMPET,
        vol: 3,
        octave: 5,
        mml:
          'l8 e e r e g e r c | e e r e g4 a4 | f f r f a f r d | g g r g b4 > c4 < |' +
          '   e e r e g e r c | a a r a g4 e4 | f a g f e c d e | c2. r4',
      },
      {
        ch: 3,
        voice: V_ORGAN,
        vol: 7,
        octave: 4,
        mml:
          'l8 r e r g r e r g | r e r g r e r g | r f r a r f r a | r d r g r d r g |' +
          '   r e r g r e r g | r f r a r f r a | r d r g r d r g | r e r g r e r g',
      },
      {
        ch: 4,
        voice: V_SYNBASS,
        vol: 3,
        octave: 3,
        mml:
          'l8 c c c c c c g g | c c c c c c g g | f f f f f f a a | g g g g g g d d |' +
          '   c c c c c c g g | f f f f f f a a | g g g g g g d d | c c c c c4 r4',
      },
    ],
    drums:
      'bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sh h |' +
      'bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sc h',
  });

  // ---- RB: 4 小節・126BPM・BB モチーフの縮約 ----
  const rb = compileSong({
    bpm: 126,
    bars: 4,
    tracks: [
      {
        ch: 2,
        voice: V_TRUMPET,
        vol: 3,
        octave: 5,
        mml: 'l8 e e r e g e r c | e e r e g4 a4 | f a g f e c d e | c2 r2',
      },
      {
        ch: 3,
        voice: V_ORGAN,
        vol: 7,
        octave: 4,
        mml: 'l8 r e r g r e r g | r e r g r e r g | r f r a r f r a | r e r g r e r g',
      },
      {
        ch: 4,
        voice: V_SYNBASS,
        vol: 3,
        octave: 3,
        mml: 'l8 c c c c c c g g | c c c c c c g g | f f f f f f a a | c c c c c4 r4',
      },
    ],
    drums:
      'bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sh h | bh h sh h bh h sc h',
  });

  return {
    bb: { duration: bb.duration, events: bb.events, bpm: 138, bars: 8 },
    rb: { duration: rb.duration, events: rb.events, bpm: 126, bars: 4 },
  };
}
