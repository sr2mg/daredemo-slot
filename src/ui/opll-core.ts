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

// ---- YM2413 内蔵音色（1〜15。0 はユーザー音色） ----
const V_FLUTE = 4;
const V_TRUMPET = 7;
const V_HORN = 9;
const V_SYNTH = 10;
const V_VIBES = 12;
const V_SYNBASS = 13;
const V_EGUITAR = 15;

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

export const DEFAULT_BEEP_VOICE = V_SYNTH;

export interface SfxOptions {
  /** ベット/レバービープの音色（1〜15。既定はシンセサイザー） */
  beepVoice?: number;
}

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
 * 大花火風のベット/レバー音階（長 6 度の 2 音ハモリ）。
 * ベット = G4+E5、レバーオン = C5+A5。違ったらここを直すだけで全体に反映される。
 */
export const BET_CHORD = { main: 659.26, sub: 392.0 } as const; //  E5 + G4
export const LEVER_CHORD = { main: 880, sub: 523.25 } as const; // A5 + C5

/** 効果音の定義（すべてオリジナルのレジスタシーケンス。アルゼ風の文法で作曲） */
export function buildSfxDefs(opts: SfxOptions = {}): Record<SfxName, SfxDef> {
  const beepVoice = opts.beepVoice ?? DEFAULT_BEEP_VOICE;
  // ベット「ペッ」とレバー「ピッ」: 選択音色の 2 音ハモリビープ
  const beep = (b: SeqBuilder, chord: { main: number; sub: number }, at: number, off: number): SeqBuilder =>
    b
      .keyOn(0, beepVoice, 4, chord.main, at)
      .keyOn(1, beepVoice, 5, chord.sub, at)
      .keyOff(0, off)
      .keyOff(1, off);
  const bet = beep(new SeqBuilder(), BET_CHORD, 0, 0.055);
  const lever = beep(new SeqBuilder(), LEVER_CHORD, 0, 0.065);
  // ベットせずにレバーを叩いたとき用: ベット→レバーを実機のリズムで連結
  const betLever = beep(beep(new SeqBuilder(), BET_CHORD, 0, 0.055), LEVER_CHORD, 0.09, 0.155);

  const reelStop = new SeqBuilder().keyOn(0, V_SYNBASS, 2, 175, 0).pitch(0, 147, 0.03).keyOff(0, 0.08);

  const replay = new SeqBuilder()
    .keyOn(0, V_FLUTE, 5, 880, 0)
    .keyOff(0, 0.07)
    .keyOn(0, V_FLUTE, 5, 1175, 0.12)
    .keyOff(0, 0.22);

  // コイン払い出し: ビブラフォンの高音交互連打
  const payout = new SeqBuilder();
  for (let i = 0; i < 8; i++) {
    const ch = i % 2;
    payout.keyOn(ch, V_VIBES, 3, i % 2 === 0 ? 2093 : 1568, i * 0.062).keyOff(ch, i * 0.062 + 0.05);
  }

  // キュイン: エレキギター + シンセの指数スイープ 392→1568Hz → 微上昇ホールド
  const kyuin = new SeqBuilder()
    .keyOn(0, V_EGUITAR, 2, 392, 0, true)
    .keyOn(1, V_SYNTH, 5, 392, 0, true)
    .sweep(0, 392, 1568, 0, 0.35)
    .sweep(1, 392, 1568, 0, 0.35)
    .sweep(0, 1568, 1660, 0.35, 0.9, 0.03)
    .sweep(1, 1568, 1660, 0.35, 0.9, 0.03)
    .keyOff(0, 1.0)
    .keyOff(1, 1.0);

  // ボーナス開始ファンファーレ: トランペット + ハーモニー
  const fanfare = new SeqBuilder()
    .keyOn(0, V_TRUMPET, 3, 523, 0)
    .keyOff(0, 0.11)
    .keyOn(0, V_TRUMPET, 3, 523, 0.15)
    .keyOff(0, 0.26)
    .keyOn(0, V_TRUMPET, 3, 523, 0.3)
    .keyOff(0, 0.41)
    .keyOn(0, V_TRUMPET, 2, 784, 0.45)
    .keyOn(1, V_TRUMPET, 5, 659, 0.45)
    .keyOn(2, V_TRUMPET, 6, 523, 0.45)
    .keyOff(0, 0.95)
    .keyOff(1, 0.95)
    .keyOff(2, 0.95);

  // 放出サイレン: ホーンの上下スイープ × 2 周
  const siren = new SeqBuilder().keyOn(0, V_HORN, 3, 600, 0, true);
  siren
    .sweep(0, 600, 950, 0, 0.3, 0.02)
    .sweep(0, 950, 600, 0.3, 0.6, 0.02)
    .sweep(0, 600, 950, 0.6, 0.9, 0.02)
    .sweep(0, 950, 600, 0.9, 1.2, 0.02)
    .keyOff(0, 1.25);

  // AT/CT 突入: シンセの上昇アルペジオ → コード
  const rush = new SeqBuilder();
  [523, 659, 784, 1047].forEach((f, i) => {
    rush.keyOn(0, V_SYNTH, 4, f, i * 0.09).keyOff(0, i * 0.09 + 0.07);
  });
  rush.keyOn(0, V_SYNTH, 3, 1047, 0.4).keyOn(1, V_SYNTH, 5, 784, 0.4).keyOff(0, 0.72).keyOff(1, 0.72);

  return {
    bet: { duration: 0.1, events: bet.events },
    lever: { duration: 0.12, events: lever.events },
    betLever: { duration: 0.25, events: betLever.events },
    reelStop: { duration: 0.15, events: reelStop.events },
    replay: { duration: 0.35, events: replay.events },
    payout: { duration: 0.75, events: payout.events },
    kyuin: { duration: 1.3, events: kyuin.events },
    fanfare: { duration: 1.15, events: fanfare.events },
    siren: { duration: 1.4, events: siren.events },
    rush: { duration: 0.85, events: rush.events },
  };
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
