/**
 * OPLL（YM2413）エミュレータ emu2413 の WASM を使う効果音レンダラ。
 *
 * - 音源コア: emu2413 © Mitsutaka Okazaki（MIT License, vendor/emu2413/）
 * - サンプルレートは clock/72 = 49716Hz 固定。この値だと emu2413 内部の
 *   リサンプラが無効になり、OPLL_reset がメモリ確保しない（bump アロケータでも
 *   インスタンスを使い回せる）。AudioBuffer は 49716Hz のままブラウザが再生できる
 * - 効果音は「レジスタ書き込みイベント列」として定義する。実機音の吸い出しではなく
 *   内蔵音色 + ピッチ操作によるオリジナル定義（著作権的に安全側）
 */

import type { DrumEvent } from '../core/music/types.js';

export const OPLL_CLOCK = 3579545;
export const OPLL_RATE = 49716;

export interface OpllExports {
  OPLL_new(clock: number, rate: number): number;
  OPLL_reset(ptr: number): void;
  OPLL_writeReg(ptr: number, reg: number, val: number): void;
  OPLL_calc(ptr: number): number;
}

/** WASM の import object（sin/cos は WASM に命令が無いので JS から渡す） */
export const OPLL_IMPORTS = { env: { js_sin: Math.sin, js_cos: Math.cos } };

export interface RegEvent {
  /** 秒 */
  at: number;
  reg: number;
  val: number;
}

export interface SfxDef {
  duration: number;
  events: RegEvent[];
}

/** 周波数 → (fnum, block)。fnum = freq × 2^18 / (49715.9 × 2^(blk-1)) */
export function freqToFnum(freq: number): { fnum: number; blk: number } {
  const fs = OPLL_CLOCK / 72;
  let blk = 1;
  let fnum = Math.round((freq * 2 ** 18) / (fs * 2 ** (blk - 1)));
  while (fnum > 511 && blk < 7) {
    blk++;
    fnum = Math.round((freq * 2 ** 18) / (fs * 2 ** (blk - 1)));
  }
  return { fnum: Math.min(511, fnum), blk };
}

/**
 * 効果音シーケンスの組み立てヘルパ。
 * チャンネルごとの blk/fnum を覚えて、keyOn/pitch/keyOff を
 * レジスタ書き込み（0x10 fnum下位 / 0x20 sus|key|blk|fnum上位 / 0x30 音色|音量）に展開する。
 */
export class SeqBuilder {
  readonly events: RegEvent[] = [];
  private last = new Map<number, { fnum: number; blk: number; sus: boolean }>();

  /** vol: 0=最大 〜 15=最小 */
  keyOn(ch: number, voice: number, vol: number, freq: number, at: number, sus = false): this {
    const { fnum, blk } = freqToFnum(freq);
    this.last.set(ch, { fnum, blk, sus });
    this.events.push({ at, reg: 0x30 + ch, val: ((voice & 15) << 4) | (vol & 15) });
    this.events.push({ at, reg: 0x10 + ch, val: fnum & 0xff });
    this.events.push({ at, reg: 0x20 + ch, val: (sus ? 0x20 : 0) | 0x10 | (blk << 1) | ((fnum >> 8) & 1) });
    return this;
  }

  /** キーオンのままピッチだけ変更 */
  pitch(ch: number, freq: number, at: number): this {
    const state = this.last.get(ch);
    const { fnum, blk } = freqToFnum(freq);
    const sus = state?.sus ?? false;
    this.last.set(ch, { fnum, blk, sus });
    this.events.push({ at, reg: 0x10 + ch, val: fnum & 0xff });
    this.events.push({ at, reg: 0x20 + ch, val: (sus ? 0x20 : 0) | 0x10 | (blk << 1) | ((fnum >> 8) & 1) });
    return this;
  }

  keyOff(ch: number, at: number): this {
    const state = this.last.get(ch) ?? { fnum: 0, blk: 1, sus: false };
    this.events.push({
      at,
      reg: 0x20 + ch,
      val: (state.sus ? 0x20 : 0) | (state.blk << 1) | ((state.fnum >> 8) & 1),
    });
    return this;
  }

  /** 生のレジスタ書き込み（リズムモード等、ヘルパにない操作用） */
  raw(reg: number, val: number, at: number): this {
    this.events.push({ at, reg, val });
    return this;
  }

  /** 指数カーブのピッチスイープ（stepSec 刻み） */
  sweep(ch: number, from: number, to: number, start: number, end: number, stepSec = 0.01): this {
    const steps = Math.max(1, Math.floor((end - start) / stepSec));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.pitch(ch, from * (to / from) ** t, start + (end - start) * t);
    }
    return this;
  }
}

/** YM2413 の内蔵メロディ音色 15 種（UI のドロップダウン用） */
export const OPLL_VOICES: readonly { id: number; label: string }[] = [
  { id: 1, label: 'ヴァイオリン' },
  { id: 2, label: 'ギター' },
  { id: 3, label: 'ピアノ' },
  { id: 4, label: 'フルート' },
  { id: 5, label: 'クラリネット（SQR寄り）' },
  { id: 6, label: 'オーボエ' },
  { id: 7, label: 'トランペット' },
  { id: 8, label: 'オルガン' },
  { id: 9, label: 'ホルン' },
  { id: 10, label: 'シンセサイザー（SAW寄り・既定）' },
  { id: 11, label: 'ハープシコード' },
  { id: 12, label: 'ビブラフォン' },
  { id: 13, label: 'シンセベース' },
  { id: 14, label: 'アコースティックベース' },
  { id: 15, label: 'エレキギター' },
];

/** リズムモード5音の音量レジスタの置き場(reg と上位/下位ニブル)。 */
export const RHYTHM_LEVEL_SLOT: Record<DrumEvent['inst'], { reg: number; high: boolean }> = {
  kick: { reg: 0x36, high: false },
  hat: { reg: 0x37, high: true },
  snare: { reg: 0x37, high: false },
  tom: { reg: 0x38, high: true },
  cymbal: { reg: 0x38, high: false },
};

/** 従来の固定リズム音量(0=最大、3dB/段)。様式が rhythm を宣言しないときはこのまま。 */
export const RHYTHM_DEFAULT_LEVELS: Record<DrumEvent['inst'], number> = {
  kick: 4, snare: 4, hat: 2, tom: 2, cymbal: 4,
};

/** 5音の音量を3本の音量レジスタ値(0x36 / 0x37 / 0x38)へ畳む。 */
export function rhythmLevelRegs(levels: Record<DrumEvent['inst'], number>): Record<number, number> {
  const regs: Record<number, number> = { 0x36: 0, 0x37: 0, 0x38: 0 };
  for (const inst of Object.keys(RHYTHM_LEVEL_SLOT) as DrumEvent['inst'][]) {
    const slot = RHYTHM_LEVEL_SLOT[inst];
    const level = Math.max(0, Math.min(15, Math.round(levels[inst])));
    regs[slot.reg] = (regs[slot.reg] ?? 0) | (slot.high ? level << 4 : level);
  }
  return regs;
}

/** リズムモードの初期化（ch6〜8 の fnum/blk 定番値・リズム音量・モード ON）*/
export function initRhythmMode(b: SeqBuilder): void {
  b.raw(0x16, 0x20, 0) // BD 基音: fnum 288 / blk 2 ≈ 109Hz(様式が kickHz を宣言すれば上書き)
    .raw(0x17, 0x50, 0)
    .raw(0x18, 0xc0, 0)
    .raw(0x26, 0x05, 0)
    .raw(0x27, 0x05, 0)
    .raw(0x28, 0x01, 0);
  for (const [reg, val] of Object.entries(rhythmLevelRegs(RHYTHM_DEFAULT_LEVELS))) b.raw(Number(reg), val, 0);
  b.raw(0x0e, 0x20, 0);
}

/** ラウドネス正規化: 実効値(RMS)を目標へ合わせ、ただしピークは上限を超えない。 */
export interface LoudnessNormalization {
  targetRms: number;
  peakCeil: number;
}

/** 正規化の指定。peak = ピーク合わせ(効果音)、それ以外 = ラウドネス合わせ(BGM)。 */
export type Normalization = { peak: number } | LoudnessNormalization;

/**
 * BGM の正規化。従来はピーク 0.65 固定だったため、打点が疎で波高率(ピーク/RMS)の高い
 * 様式(2ステップ ≈ 20dB)は密な様式(ユーロビート ≈ 15dB)より数 dB 小さく鳴っていた。
 * 波高率 15dB の素材がピーク 0.65 になる RMS を目標にし(= 密な様式の音量は従来どおり)、
 * 疎な素材だけをピーク上限 0.95 まで持ち上げる。ゲイン 1 本の操作なので波形の形は変えない
 * (コンプやサチュレーションのような後段処理は入れない。チップ素の出力を保つ)。
 */
export const BGM_NORMALIZATION: LoudnessNormalization = {
  targetRms: 0.65 / 10 ** (15 / 20),
  peakCeil: 0.95,
};

export function normalizationGain(peak: number, rms: number, norm: Normalization): number {
  if (peak <= 0) return 0;
  if ('peak' in norm) return norm.peak / peak;
  const ceilGain = norm.peakCeil / peak;
  return rms > 0 ? Math.min(ceilGain, norm.targetRms / rms) : ceilGain;
}

/**
 * 仕上げ。ピーク合わせは従来どおり波形に触れない。ラウドネス合わせでは先に直流を除く
 * (emu2413 の出力は DC を含み、実機ではアナログ段の AC カップリングで落ちる。DC が
 * ピーク余裕を食うとその分だけ音楽が小さく正規化されてしまう)。
 */
function finalize(out: Float32Array, norm: Normalization): void {
  if (!('peak' in norm)) {
    let mean = 0;
    for (const v of out) mean += v;
    mean /= out.length || 1;
    for (let i = 0; i < out.length; i++) out[i] = out[i]! - mean;
  }
  let peak = 0;
  let energy = 0;
  for (const v of out) {
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
    energy += v * v;
  }
  const gain = normalizationGain(peak, Math.sqrt(energy / (out.length || 1)), norm);
  for (let i = 0; i < out.length; i++) out[i] = out[i]! * gain;
}

/**
 * レジスタイベント列を 49716Hz のモノラル波形へレンダリングする。
 * インスタンスはリセットして使い回す（レートが 49716 なら reset は追加確保しない）。
 */
export function renderSequence(
  exports: OpllExports,
  opll: number,
  def: SfxDef,
  normalizePeak = 0.65,
): Float32Array {
  exports.OPLL_reset(opll);
  const total = Math.round(def.duration * OPLL_RATE);
  const sorted = [...def.events].sort((a, b) => a.at - b.at);
  const out = new Float32Array(total);
  let next = 0;
  for (let i = 0; i < total; i++) {
    const t = i / OPLL_RATE;
    while (next < sorted.length && sorted[next]!.at <= t) {
      exports.OPLL_writeReg(opll, sorted[next]!.reg, sorted[next]!.val);
      next++;
    }
    out[i] = exports.OPLL_calc(opll);
  }
  finalize(out, { peak: normalizePeak });
  return out;
}

/**
 * renderSequence の非同期版。レンダリングはサンプル単位で OPLL_calc を回すため
 * ほぼ実時間かかる（12 秒の曲 ≒ 10 秒前後）。チャンクごとに制御をイベントループへ
 * 返し、UI を固めずに進捗を報告する。
 * 注意: OPLL インスタンスは共有・ステートフルなので、await を跨いで他のレンダリングと
 * 同時実行してはいけない（呼び出し側 = SfxPlayer がキューで直列化する）。
 * 正規化は既定で BGM 用のラウドネス合わせ(BGM_NORMALIZATION)。
 */
export async function renderSequenceAsync(
  exports: OpllExports,
  opll: number,
  def: SfxDef,
  onProgress?: (ratio: number) => void,
  normalize: Normalization = BGM_NORMALIZATION,
): Promise<Float32Array> {
  exports.OPLL_reset(opll);
  const total = Math.round(def.duration * OPLL_RATE);
  const sorted = [...def.events].sort((a, b) => a.at - b.at);
  const out = new Float32Array(total);
  const chunk = Math.round(0.5 * OPLL_RATE); // 0.5 秒ぶんずつ
  let next = 0;
  for (let start = 0; start < total; start += chunk) {
    const end = Math.min(total, start + chunk);
    for (let i = start; i < end; i++) {
      const t = i / OPLL_RATE;
      while (next < sorted.length && sorted[next]!.at <= t) {
        exports.OPLL_writeReg(opll, sorted[next]!.reg, sorted[next]!.val);
        next++;
      }
      out[i] = exports.OPLL_calc(opll);
    }
    onProgress?.(end / total);
    if (end < total) await new Promise((r) => setTimeout(r, 0));
  }
  finalize(out, normalize);
  return out;
}
