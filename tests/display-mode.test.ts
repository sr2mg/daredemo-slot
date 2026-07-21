import { describe, expect, it } from 'vitest';
import { calculateLargeDisplayMetrics } from '../src/ui/display-mode.js';

describe('大画面モードの表示寸法', () => {
  it('3840x1400 の表示領域では高さを使ってリールを拡大する', () => {
    const metrics = calculateLargeDisplayMetrics({ width: 3840, height: 1400, devicePixelRatio: 1 });
    expect(metrics.cellHeight).toBe(207);
    expect(metrics.reelWidth).toBe(328);
    expect(metrics.panelWidth).toBe(642);
    expect(metrics.scale).toBeCloseTo(1.725);
  });

  it('十分に大きい画面でも図柄の元解像度を超えて過剰に拡大しない', () => {
    const metrics = calculateLargeDisplayMetrics({ width: 3840, height: 1600, devicePixelRatio: 1.25 });
    expect(metrics.cellHeight).toBe(240);
    expect(metrics.panelWidth).toBe(700);
    expect(metrics.physicalWidth).toBe(4800);
    expect(metrics.physicalHeight).toBe(2000);
  });

  it('狭く背の低い画面では安全な最小寸法まで縮める', () => {
    const metrics = calculateLargeDisplayMetrics({ width: 375, height: 700, devicePixelRatio: 2 });
    expect(metrics.cellHeight).toBe(40);
    expect(metrics.reelWidth).toBe(63);
    expect(metrics.physicalWidth).toBe(750);
  });
});
