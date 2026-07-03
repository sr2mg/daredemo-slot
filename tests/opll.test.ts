import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
});
