import type { Piece } from '../core/music/compose.js';
import { initRhythmMode } from './mml.js';
import { SeqBuilder } from './opll-core.js';
import type { SfxDef } from './opll-core.js';

/** 編曲済み BGM（レジスタ列 + ループ検算用のメタ） */
export interface ArrangedBgm extends SfxDef {
  bpm: number;
  /** 4/4 換算の小節数 */
  bars: number;
}

/**
 * 作曲エンジンの Piece を OPLL（YM2413）のレジスタシーケンスへ編曲するコンバータ。
 * エフェクター無しの当時技術だけで音を太くする:
 * - アクセント     = 音量レジスタ（強拍を 1 段大きく）。4bit 音量は 80 年代打ち込みの基本
 * - チャンネルエコー = 空き ch5 にメロディを 8 分遅れ・小音量で複製（ロックマン式）。
 *                     ループ境界を跨ぐぶんは頭に折り返す（トラッカーのループと同じ挙動）
 * - ビブラート     = 長い音符だけ F ナンバーを毎フレーム書き換えるソフトウェアベンド
 * - FM 音色        = スタイルごとに内蔵音色を割り当て（エンベロープの時間変化はチップが持つ）
 *
 * チャンネル予算は内蔵曲（bgm.ts）と同じ: 効果音 ch0-1 / リード ch2 / バッキング ch3 /
 * ベース ch4 / エコー ch5 / リズム ch6-8。
 */

const CH_LEAD = 2;
const CH_BACKING = 3;
const CH_BASS = 4;
const CH_ECHO = 5;

/** 音量（0=最大〜15=最小）: 強拍リード / 弱拍リード / エコー / バッキング / ベース */
const VOL_LEAD_STRONG = 2;
const VOL_LEAD_WEAK = 4;
const VOL_ECHO = 7;
const VOL_BACKING = 7;
const VOL_BASS = 2;

interface StyleVoices {
  lead: number;
  backing: number;
  bass: number;
  /** バッキングの刻み: offbeat = 裏打ち 8 分 / half = 2 分音符サステイン */
  backingPattern: 'offbeat' | 'half';
}

/** スタイル → 内蔵音色の割り当て（1〜15。opll-core.ts の OPLL_VOICES 参照） */
const STYLE_VOICES: Record<string, StyleVoices> = {
  eurobeat: { lead: 10, backing: 8, bass: 13, backingPattern: 'offbeat' }, // シンセ/オルガン/シンベ
  rock: { lead: 7, backing: 15, bass: 13, backingPattern: 'half' }, // トランペット/Eギター/シンベ
  ska: { lead: 4, backing: 8, bass: 14, backingPattern: 'offbeat' }, // フルート/オルガン/アコベース
};
const DEFAULT_VOICES: StyleVoices = STYLE_VOICES['eurobeat']!;

const midiFreq = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

const DRUM_BITS: Record<string, number> = { kick: 0x10, snare: 0x08, hat: 0x01 };

/** ソフトウェアビブラートを掛ける最短音価（拍）と、深さ・速さ */
const VIBRATO_MIN_BEATS = 1;
const VIBRATO_DEPTH_CENTS = 10;
const VIBRATO_HZ = 5.5;
const VIBRATO_DELAY_RATIO = 0.3; // 音の頭はまっすぐ、途中から揺らす（歌と同じ）

export function arrangePiece(piece: Piece, styleId: string): ArrangedBgm {
  const voices = STYLE_VOICES[styleId] ?? DEFAULT_VOICES;
  const spb = 60 / piece.bpm;
  const duration = piece.beats * spb;
  const echoDelay = spb / 2; // 8 分遅れ
  const b = new SeqBuilder();

  // --- リード（ch2）: アクセント + 長音ビブラート。エコー（ch5）は同じ列を遅れて複製 ---
  for (const n of piece.melody) {
    const t = n.beat * spb;
    const dur = n.dur * spb;
    const inBar = n.beat % 4;
    const vol = inBar === 0 || inBar === 2 ? VOL_LEAD_STRONG : VOL_LEAD_WEAK;
    const freq = midiFreq(n.midi);
    b.keyOn(CH_LEAD, voices.lead, vol, freq, t);
    if (n.dur >= VIBRATO_MIN_BEATS) {
      // F ナンバーの毎フレーム書き換えによる揺れ（当時のドライバの常套手段）
      const from = t + dur * VIBRATO_DELAY_RATIO;
      for (let vt = from; vt < t + dur; vt += 0.025) {
        const cents = VIBRATO_DEPTH_CENTS * Math.sin(2 * Math.PI * VIBRATO_HZ * (vt - from));
        b.pitch(CH_LEAD, freq * 2 ** (cents / 1200), vt);
      }
    }
    b.keyOff(CH_LEAD, t + dur);

    // チャンネルエコー: ループ境界を跨ぐ音は頭に折り返す
    let echoT = t + echoDelay;
    if (echoT + dur > duration) {
      echoT = echoT >= duration ? echoT - duration : echoT; // 開始が境界を越えたら折り返し
      if (echoT + dur > duration) {
        // 開始は境界内で終わりだけはみ出す音: 境界で切る（ループ先頭の音を邪魔しない）
        b.keyOn(CH_ECHO, voices.lead, VOL_ECHO, freq, echoT);
        b.keyOff(CH_ECHO, duration - 0.005);
        continue;
      }
    }
    b.keyOn(CH_ECHO, voices.lead, VOL_ECHO, freq, echoT);
    b.keyOff(CH_ECHO, echoT + dur);
  }

  // --- バッキング（ch3）: コードの 3rd/5th をスタイルの刻みで ---
  for (const c of piece.chords) {
    const third = c.midis[1] ?? c.midis[0]!;
    const fifth = c.midis[2] ?? third;
    if (voices.backingPattern === 'offbeat') {
      // 裏打ち 8 分（スカ/ユーロの刻み）。3rd と 5th を交互に
      for (let beat = 0; beat < c.dur; beat++) {
        const t = (c.beat + beat + 0.5) * spb;
        b.keyOn(CH_BACKING, voices.backing, VOL_BACKING, midiFreq(beat % 2 === 0 ? third : fifth), t);
        b.keyOff(CH_BACKING, t + 0.2 * spb);
      }
    } else {
      // 2 分音符サステイン（ロックの白玉）
      for (let beat = 0; beat < c.dur; beat += 2) {
        const t = (c.beat + beat) * spb;
        const len = Math.min(2, c.dur - beat);
        b.keyOn(CH_BACKING, voices.backing, VOL_BACKING, midiFreq(third), t);
        b.keyOff(CH_BACKING, t + len * 0.9 * spb);
      }
    }
  }

  // --- ベース（ch4）: compose 済みのラインをそのまま ---
  for (const n of piece.bass) {
    const t = n.beat * spb;
    b.keyOn(CH_BASS, voices.bass, VOL_BASS, midiFreq(n.midi), t);
    b.keyOff(CH_BASS, t + n.dur * spb);
  }

  // --- リズム（ch6-8）: 同時刻の打点はビットを合成して 1 回で叩く ---
  initRhythmMode(b);
  const hits = new Map<number, number>();
  for (const d of piece.drums) {
    const t = d.beat * spb;
    hits.set(t, (hits.get(t) ?? 0) | (DRUM_BITS[d.inst] ?? 0));
  }
  for (const [t, bits] of hits) {
    // キービットの 0→1 遷移でリトリガーされるので、一度クリアしてから叩く
    b.raw(0x0e, 0x20, t);
    b.raw(0x0e, 0x20 | bits, t + 0.004);
  }

  return { bpm: piece.bpm, bars: piece.bars, duration, events: b.events };
}
