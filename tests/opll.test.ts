import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileDrums, compileMmlTrack, compileSong } from '../src/ui/mml.js';
import type { OpllExports } from '../src/ui/opll-core.js';
import {
  freqToFnum,
  OPLL_CLOCK,
  OPLL_IMPORTS,
  OPLL_RATE,
  renderSequence,
  SeqBuilder,
} from '../src/ui/opll-core.js';
import { arrangeSfx } from '../src/ui/sfx-arrange.js';
import { ASSIGNABLE_SFX, PRESET_SFX } from '../src/ui/sfx-library.js';

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

describe('効果音プリセット（レシピ生成 + OPLL）', () => {
  it('全契機のプリセットが鳴る波形にレンダリングされる（NaN なし・十分な音量）', { timeout: 30_000 }, () => {
    for (const { name } of ASSIGNABLE_SFX) {
      const def = arrangeSfx(PRESET_SFX[name]);
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

  it('デザインの音色を差し替えると波形が実際に変わる', () => {
    const synth = renderSequence(exports, opll, arrangeSfx({ ...PRESET_SFX.bet, voice: 10 }));
    const clarinet = renderSequence(exports, opll, arrangeSfx({ ...PRESET_SFX.bet, voice: 5 }));
    expect(synth).not.toEqual(clarinet);
  });
});
