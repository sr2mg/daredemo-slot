import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildBgmDefs } from '../src/ui/bgm.js';
import { compileDrums, compileMmlTrack, compileSong } from '../src/ui/mml.js';
import type { OpllExports } from '../src/ui/opll-core.js';
import {
  buildSfxDefs,
  freqToFnum,
  OPLL_CLOCK,
  OPLL_IMPORTS,
  OPLL_RATE,
  renderSequence,
  SeqBuilder,
} from '../src/ui/opll-core.js';

const wasmBytes = readFileSync(new URL('../src/ui/emu2413.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(wasmBytes, OPLL_IMPORTS);
const exports = instance.exports as unknown as OpllExports;
const opll = exports.OPLL_new(OPLL_CLOCK, OPLL_RATE);

describe('emu2413 WASM（OPLL 音源コア）', () => {
  it('トランペット A4 を 0.5 秒レンダリングして波形が出る', () => {
    const seq = new SeqBuilder().keyOn(0, 7, 0, 440, 0).keyOff(0, 0.4);
    const wave = renderSequence(exports, opll, { duration: 0.5, events: seq.events }, 1);
    expect(wave.length).toBe(Math.round(0.5 * OPLL_RATE));
    const peak = Math.max(...wave.map(Math.abs));
    expect(peak).toBeCloseTo(1, 5); // 正規化後のピーク
    // 無音でない（先頭 0.1 秒に十分なエネルギー）
    const head = wave.slice(0, 4971);
    expect(Math.max(...head.map(Math.abs))).toBeGreaterThan(0.2);
  });

  it('同じシーケンスは決定論的にレンダリングされる（インスタンス使い回し）', () => {
    const seq = new SeqBuilder().keyOn(0, 10, 3, 660, 0).keyOff(0, 0.1);
    const a = renderSequence(exports, opll, { duration: 0.2, events: seq.events });
    const b = renderSequence(exports, opll, { duration: 0.2, events: seq.events });
    expect(a).toEqual(b);
  });

  it('freqToFnum は 9 ビットに収まる', () => {
    for (const freq of [55, 110, 440, 1568, 2093, 4186]) {
      const { fnum, blk } = freqToFnum(freq);
      expect(fnum).toBeGreaterThan(0);
      expect(fnum).toBeLessThanOrEqual(511);
      expect(blk).toBeGreaterThanOrEqual(1);
      expect(blk).toBeLessThanOrEqual(7);
    }
  });
});

describe('効果音プリセット（アルゼ風オリジナル定義）', () => {
  const defs = buildSfxDefs();

  it('全効果音が鳴る波形にレンダリングされる（NaN なし・十分な音量）', () => {
    for (const [name, def] of Object.entries(defs)) {
      const wave = renderSequence(exports, opll, def);
      expect(wave.length, name).toBe(Math.round(def.duration * OPLL_RATE));
      let peak = 0;
      for (const v of wave) {
        expect(Number.isNaN(v), name).toBe(false);
        const abs = Math.abs(v);
        if (abs > peak) peak = abs;
      }
      expect(peak, name).toBeCloseTo(0.65, 2); // 正規化ピーク
      expect(peak, name).toBeLessThanOrEqual(1);
    }
  });

  it('キュインはピッチスイープのイベントを大量に含む', () => {
    expect(defs.kyuin.events.length).toBeGreaterThan(50);
    expect(defs.kyuin.duration).toBeGreaterThan(1);
  });

  it('ベット=G4+E5・レバーオン=C5+A5 の 2 音ハモリ（大花火風）', () => {
    // fnum 下位バイト（reg 0x10=ch0 / 0x11=ch1）でピッチが区別できる
    const fnumLoOf = (def: (typeof defs)['bet'], ch: number) =>
      def.events.filter((e) => e.reg === 0x10 + ch).map((e) => e.val);
    const note = (freq: number) => freqToFnum(freq).fnum & 0xff;
    expect(fnumLoOf(defs.bet, 0)).toEqual([note(659.26)]); //  E5
    expect(fnumLoOf(defs.bet, 1)).toEqual([note(392.0)]); //   G4
    expect(fnumLoOf(defs.lever, 0)).toEqual([note(880)]); //   A5
    expect(fnumLoOf(defs.lever, 1)).toEqual([note(523.25)]); // C5
    expect(fnumLoOf(defs.betLever, 0)).toEqual([note(659.26), note(880)]); // ベット→レバー
    expect(fnumLoOf(defs.betLever, 1)).toEqual([note(392.0), note(523.25)]);
    expect(defs.betLever.duration).toBeGreaterThan(defs.lever.duration);
  });

  it('MML: 音名・長さ・オクターブ・付点・休符を解釈する', () => {
    const b = new SeqBuilder();
    // 120BPM: 四分 = 0.5 秒。c d e c で 2.0 秒
    const len = compileMmlTrack(b, { ch: 0, voice: 7, vol: 3, mml: 'l4 c d e c' }, 120);
    expect(len).toBeCloseTo(2.0, 6);
    const keyOns = b.events.filter((e) => e.reg === 0x20 && (e.val & 0x10) !== 0);
    expect(keyOns).toHaveLength(4);
    // 先頭は C4 = 261.63Hz
    const firstFnumLo = b.events.find((e) => e.reg === 0x10)!.val;
    expect(firstFnumLo).toBe(freqToFnum(261.63).fnum & 0xff);

    // 付点とオクターブ記号と半音
    const b2 = new SeqBuilder();
    const len2 = compileMmlTrack(b2, { ch: 1, voice: 7, vol: 3, mml: 'l8 o5 c. > f+16 < r4' }, 120);
    expect(len2).toBeCloseTo(0.25 * 1.5 + 0.125 + 0.5, 6);
    expect(() => compileMmlTrack(new SeqBuilder(), { ch: 0, voice: 7, vol: 3, mml: 'c x' }, 120)).toThrow(
      'MML パースエラー',
    );
  });

  it('ドラム DSL: リズムモードを有効化し、トークンごとにリトリガーする', () => {
    const b = new SeqBuilder();
    const len = compileDrums(b, 'bh - s -', 120, 8);
    expect(len).toBeCloseTo(0.25 * 4, 6);
    const rhythmWrites = b.events.filter((e) => e.reg === 0x0e);
    expect(rhythmWrites[0]!.val).toBe(0x20); // リズムモード ON
    // 2 トークンぶんのクリア→トリガー（+ 初期化 1 回）
    expect(rhythmWrites.filter((e) => e.val > 0x20)).toHaveLength(2);
    expect(rhythmWrites.some((e) => e.val === (0x20 | 0x10 | 0x01))).toBe(true); // b+h
  });

  it('compileSong はトラック長のズレを検出する', () => {
    expect(() =>
      compileSong({ bpm: 120, bars: 2, tracks: [{ ch: 0, voice: 7, vol: 3, mml: 'l4 c d e c' }] }),
    ).toThrow('長さが合いません');
  });

  it('BB/RB の BGM がループ長ぴったりでレンダリングされる', { timeout: 120_000 }, () => {
    const bgm = buildBgmDefs();
    expect(bgm.bb.duration).toBeCloseTo((8 * 4 * 60) / 138, 3);
    expect(bgm.rb.duration).toBeCloseTo((4 * 4 * 60) / 126, 3);
    for (const [name, def] of Object.entries(bgm)) {
      const wave = renderSequence(exports, opll, def);
      expect(wave.length, name).toBe(Math.round(def.duration * OPLL_RATE));
      let peak = 0;
      let energy = 0;
      for (const v of wave) {
        expect(Number.isNaN(v), name).toBe(false);
        const abs = Math.abs(v);
        if (abs > peak) peak = abs;
        energy += abs;
      }
      expect(peak, name).toBeCloseTo(0.65, 2);
      // 曲として鳴り続けている（平均振幅が無音でない）
      expect(energy / wave.length, name).toBeGreaterThan(0.01);
    }
  });

  it('ビープ音色を差し替えられる（既定はシンセサイザー 10 番）', () => {
    const voiceOf = (def: (typeof defs)['bet']) =>
      def.events.filter((e) => e.reg >= 0x30 && e.reg <= 0x31).map((e) => e.val >> 4);
    expect(voiceOf(defs.bet)).toEqual([10, 10]); // ch0/ch1 とも既定音色
    const clarinet = buildSfxDefs({ beepVoice: 5 });
    expect(voiceOf(clarinet.bet)).toEqual([5, 5]);
    expect(voiceOf(clarinet.lever)).toEqual([5, 5]);
    // ビープ以外の効果音は影響を受けない
    expect(clarinet.fanfare.events).toEqual(defs.fanfare.events);
    // 波形も実際に変わる
    const a = renderSequence(exports, opll, defs.bet);
    const b = renderSequence(exports, opll, clarinet.bet);
    expect(a).not.toEqual(b);
  });
});
