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

export type SfxName =
  | 'bet'
  | 'lever'
  | 'betLever'
  | 'reelStop'
  | 'replay'
  | 'payout'
  | 'kyuin'
  | 'fanfare'
  | 'siren'
  | 'rush';

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
  let peak = 0;
  for (let i = 0; i < total; i++) {
    const t = i / OPLL_RATE;
    while (next < sorted.length && sorted[next]!.at <= t) {
      exports.OPLL_writeReg(opll, sorted[next]!.reg, sorted[next]!.val);
      next++;
    }
    const v = exports.OPLL_calc(opll);
    out[i] = v;
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
  }
  const scale = peak > 0 ? normalizePeak / peak : 0;
  for (let i = 0; i < total; i++) out[i] = out[i]! * scale;
  return out;
}

/**
 * renderSequence の非同期版。レンダリングはサンプル単位で OPLL_calc を回すため
 * ほぼ実時間かかる（12 秒の曲 ≒ 10 秒前後）。チャンクごとに制御をイベントループへ
 * 返し、UI を固めずに進捗を報告する。
 * 注意: OPLL インスタンスは共有・ステートフルなので、await を跨いで他のレンダリングと
 * 同時実行してはいけない（呼び出し側 = SfxPlayer がキューで直列化する）。
 */
export async function renderSequenceAsync(
  exports: OpllExports,
  opll: number,
  def: SfxDef,
  onProgress?: (ratio: number) => void,
  normalizePeak = 0.65,
): Promise<Float32Array> {
  exports.OPLL_reset(opll);
  const total = Math.round(def.duration * OPLL_RATE);
  const sorted = [...def.events].sort((a, b) => a.at - b.at);
  const out = new Float32Array(total);
  const chunk = Math.round(0.5 * OPLL_RATE); // 0.5 秒ぶんずつ
  let next = 0;
  let peak = 0;
  for (let start = 0; start < total; start += chunk) {
    const end = Math.min(total, start + chunk);
    for (let i = start; i < end; i++) {
      const t = i / OPLL_RATE;
      while (next < sorted.length && sorted[next]!.at <= t) {
        exports.OPLL_writeReg(opll, sorted[next]!.reg, sorted[next]!.val);
        next++;
      }
      const v = exports.OPLL_calc(opll);
      out[i] = v;
      const abs = Math.abs(v);
      if (abs > peak) peak = abs;
    }
    onProgress?.(end / total);
    if (end < total) await new Promise((r) => setTimeout(r, 0));
  }
  const scale = peak > 0 ? normalizePeak / peak : 0;
  for (let i = 0; i < total; i++) out[i] = out[i]! * scale;
  return out;
}
