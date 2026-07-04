import { SeqBuilder } from './opll-core.js';

/**
 * MML 風ミニ言語 → OPLL レジスタイベントのコンパイラ（BGM 作曲用）。
 *
 * 対応構文（1 トラック = 1 チャンネル）:
 * - 音名: c d e f g a b（直後に + / # で半音上げ、- で半音下げ）
 * - 長さ: 音名の直後の数字（4=四分, 8=八分, ...）。省略時は l コマンドの既定長。直後の . で付点
 * - r: 休符（長さ指定は音名と同じ）
 * - o4: オクターブ指定 / > <: オクターブ上下 / l8: 既定長の変更
 * - '|' は小節の見た目区切り（空白扱い）
 *
 * ドラムは専用のパターン DSL（compileDrums）:
 * - 空白区切りの 1 トークン = 1 ステップ（既定 8 分）。文字の組で同時発音
 *   b=バスドラ s=スネア t=タム c=シンバル h=ハイハット、- =休み
 * - YM2413 のリズムモード（reg 0x0E）を使う。ch6〜8 がリズム専用になるので
 *   メロディトラックは ch0〜5 に置くこと
 */

const SEMITONE: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

export interface MmlTrackDef {
  /** OPLL チャンネル（リズムモード使用時は 0〜5） */
  ch: number;
  /** 内蔵音色 1〜15 */
  voice: number;
  /** 音量 0(大)〜15(小) */
  vol: number;
  /** 開始オクターブ（既定 4） */
  octave?: number;
  mml: string;
}

/** ノートオンからノートオフまでの比率（歯切れ） */
const GATE = 0.85;

/** 1 トラックをコンパイルして SeqBuilder に書き込み、トラック長（秒）を返す */
export function compileMmlTrack(b: SeqBuilder, track: MmlTrackDef, bpm: number): number {
  const beat = 60 / bpm;
  const src = track.mml.replace(/\|/g, ' ');
  let pos = 0;
  let octave = track.octave ?? 4;
  let defaultLen = 8;
  let i = 0;

  const readNumber = (): number | null => {
    const m = /^\d+/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };

  while (i < src.length) {
    const chr = src[i]!.toLowerCase();
    if (chr === ' ' || chr === '\n' || chr === '\t') {
      i++;
    } else if (chr === '>') {
      octave++;
      i++;
    } else if (chr === '<') {
      octave--;
      i++;
    } else if (chr === 'o') {
      i++;
      octave = readNumber() ?? octave;
    } else if (chr === 'l') {
      i++;
      defaultLen = readNumber() ?? defaultLen;
    } else if (chr === 'r' || SEMITONE[chr] !== undefined) {
      i++;
      let semi = SEMITONE[chr] ?? 0;
      if (chr !== 'r') {
        if (src[i] === '+' || src[i] === '#') {
          semi++;
          i++;
        } else if (src[i] === '-') {
          semi--;
          i++;
        }
      }
      const len = readNumber() ?? defaultLen;
      let dur = beat * (4 / len);
      if (src[i] === '.') {
        dur *= 1.5;
        i++;
      }
      if (chr !== 'r') {
        const midi = (octave + 1) * 12 + semi;
        const freq = 440 * 2 ** ((midi - 69) / 12);
        b.keyOn(track.ch, track.voice, track.vol, freq, pos);
        b.keyOff(track.ch, pos + dur * GATE);
      }
      pos += dur;
    } else {
      throw new Error(`MML パースエラー: 位置 ${i} の '${src[i]}'`);
    }
  }
  return pos;
}

const DRUM_BITS: Record<string, number> = {
  b: 0x10, // バスドラム
  s: 0x08, // スネア
  t: 0x04, // タム
  c: 0x02, // トップシンバル
  h: 0x01, // ハイハット
};

/** リズムモードの初期化（ch6〜8 の fnum/blk 定番値・リズム音量・モード ON）*/
export function initRhythmMode(b: SeqBuilder): void {
  b.raw(0x16, 0x20, 0)
    .raw(0x17, 0x50, 0)
    .raw(0x18, 0xc0, 0)
    .raw(0x26, 0x05, 0)
    .raw(0x27, 0x05, 0)
    .raw(0x28, 0x01, 0)
    .raw(0x36, 0x04, 0) //  BD 音量
    .raw(0x37, 0x24, 0) //  HH(上位) / SD(下位)
    .raw(0x38, 0x24, 0) //  TOM(上位) / CYM(下位)
    .raw(0x0e, 0x20, 0);
}

/** リズムモード有効化 + ドラムパターン。パターン長（秒）を返す */
export function compileDrums(b: SeqBuilder, pattern: string, bpm: number, step = 8): number {
  initRhythmMode(b);

  const stepDur = (60 / bpm) * (4 / step);
  const tokens = pattern.replace(/\|/g, ' ').trim().split(/\s+/);
  tokens.forEach((token, index) => {
    let bits = 0;
    for (const c of token) bits |= DRUM_BITS[c] ?? 0;
    if (bits === 0) return;
    const t = index * stepDur;
    // キービットの 0→1 遷移でリトリガーされるので、一度クリアしてから叩く
    b.raw(0x0e, 0x20, t);
    b.raw(0x0e, 0x20 | bits, t + 0.004);
  });
  return tokens.length * stepDur;
}

export interface SongDef {
  bpm: number;
  /** 4/4 の小節数（ループ長の検算用） */
  bars: number;
  tracks: MmlTrackDef[];
  /** ドラムパターン（省略可） */
  drums?: string;
}

/** 曲全体をコンパイル。全トラックが小節数どおりの長さかを検算する */
export function compileSong(song: SongDef): { events: SeqBuilder['events']; duration: number } {
  const b = new SeqBuilder();
  const duration = song.bars * 4 * (60 / song.bpm);
  for (const track of song.tracks) {
    const len = compileMmlTrack(b, track, song.bpm);
    if (Math.abs(len - duration) > 0.005) {
      throw new Error(
        `トラック ch${track.ch} の長さが合いません: ${len.toFixed(3)}s（期待 ${duration.toFixed(3)}s = ${song.bars} 小節）`,
      );
    }
  }
  if (song.drums !== undefined) {
    const len = compileDrums(b, song.drums, song.bpm);
    if (Math.abs(len - duration) > 0.005) {
      throw new Error(`ドラムの長さが合いません: ${len.toFixed(3)}s（期待 ${duration.toFixed(3)}s）`);
    }
  }
  return { events: b.events, duration };
}
