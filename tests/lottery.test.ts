import { describe, expect, it } from 'vitest';
import { drawLottery, totalWeight } from '../src/core/lottery.js';
import type { Rng, RngState } from '../src/core/rng.js';
import { Xoshiro128 } from '../src/core/rng.js';
import { sampleAType } from '../src/machines/sample-a.js';

/** draw16 が固定値を返すスタブ（区間境界の検証用） */
function stubRng(value16: number): Rng {
  return {
    nextUint32: () => value16 << 16,
    draw16: () => value16,
    nextInt: () => 0,
    getState: (): RngState => ({ s0: 0, s1: 0, s2: 0, s3: 0 }),
  };
}

describe('drawLottery', () => {
  const table = sampleAType.lottery.base;

  it('重み合計が 65536 以下', () => {
    expect(totalWeight(table)).toBeLessThanOrEqual(65536);
  });

  it('区間境界どおりにフラグを引く', () => {
    // replay: [0, 8978)
    expect(drawLottery(table, stubRng(0))).toEqual(['replay']);
    expect(drawLottery(table, stubRng(8977))).toEqual(['replay']);
    // bell: [8978, 17978)
    expect(drawLottery(table, stubRng(8978))).toEqual(['bell']);
    expect(drawLottery(table, stubRng(17977))).toEqual(['bell']);
    // cherry: [17978, 19035)
    expect(drawLottery(table, stubRng(17978))).toEqual(['cherry']);
    // melon: [19035, 20235)
    expect(drawLottery(table, stubRng(19035))).toEqual(['melon']);
    // cherry+bb_red: [20235, 20301)
    expect(drawLottery(table, stubRng(20235))).toEqual(['cherry', 'bb_red']);
    // bb_red: [20301, 20511)
    expect(drawLottery(table, stubRng(20301))).toEqual(['bb_red']);
    // rb: [20511, 20791)
    expect(drawLottery(table, stubRng(20790))).toEqual(['rb']);
    // ハズレ: [20791, 65536)
    expect(drawLottery(table, stubRng(20791))).toEqual([]);
    expect(drawLottery(table, stubRng(65535))).toEqual([]);
  });

  it('実測確率が理論値に収束する（シード固定）', () => {
    const rng = new Xoshiro128(12345);
    const games = 200_000;
    let replayCount = 0;
    for (let i = 0; i < games; i++) {
      const flags = drawLottery(table, rng);
      if (flags.includes('replay')) replayCount++;
    }
    const expected = 8978 / 65536;
    expect(replayCount / games).toBeGreaterThan(expected * 0.95);
    expect(replayCount / games).toBeLessThan(expected * 1.05);
  });
});

describe('Xoshiro128', () => {
  it('同一シードで同一系列を生成する', () => {
    const a = new Xoshiro128(42);
    const b = new Xoshiro128(42);
    for (let i = 0; i < 100; i++) expect(a.nextUint32()).toBe(b.nextUint32());
  });

  it('状態を復元すると続きが再現される', () => {
    const a = new Xoshiro128(7);
    for (let i = 0; i < 10; i++) a.nextUint32();
    const b = new Xoshiro128(a.getState());
    for (let i = 0; i < 100; i++) expect(a.nextUint32()).toBe(b.nextUint32());
  });

  it('draw16 は 0..65535 に収まる', () => {
    const rng = new Xoshiro128(1);
    for (let i = 0; i < 10_000; i++) {
      const v = rng.draw16();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(65535);
    }
  });
});
