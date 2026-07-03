import { describe, expect, it } from 'vitest';
import { checkCompliance, RULESETS } from '../src/core/compliance.js';
import { atBeast } from '../src/machines/at-beast.js';
import { sampleAType } from '../src/machines/sample-a.js';
import { stockBB } from '../src/machines/stock-bb.js';
import { stockSB } from '../src/machines/stock-sb.js';

/** テスト用の軽量試行数 */
const FAST = { 400: 5, 6000: 2, 17500: 2 };

describe('適合試験チェック', () => {
  it('ルールセットが規則の数値を持つ', () => {
    expect(RULESETS.yon.spans.find((s) => s.games === 17500)).toEqual({ games: 17500, min: 0.6, max: 1.2 });
    expect(RULESETS.go.spans.find((s) => s.games === 400)?.max).toBe(2.2);
  });

  it('同一シードで決定論的', () => {
    const a = checkCompliance(sampleAType, { setting: 6, seed: 42, trialsOverride: FAST });
    const b = checkCompliance(sampleAType, { setting: 6, seed: 42, trialsOverride: FAST });
    expect(a).toEqual(b);
  }, 120_000);

  it('全プリセットが設定 1・6 で 4 号機基準に適合する', () => {
    for (const machine of [sampleAType, atBeast, stockBB, stockSB]) {
      for (const setting of [1, 6]) {
        const result = checkCompliance(machine, { setting, seed: 42, trialsOverride: FAST });
        expect(result.pass, `${machine.name} 設定${setting}`).toBe(true);
      }
    }
  }, 120_000);

  it('サンプル A タイプは下限・上限に対して余裕を持って適合する', () => {
    // 設定 1 の下限側: 適当打ちでも 17500G で 60% を上回る
    const s1 = checkCompliance(sampleAType, { setting: 1, seed: 42, trialsOverride: FAST });
    const long1 = s1.spans.find((s) => s.games === 17500)!;
    expect(long1.naive.min).toBeGreaterThanOrEqual(0.6);
    // 設定 6 の上限側: 完全打ちでも 17500G で 120% 未満
    const s6 = checkCompliance(sampleAType, { setting: 6, seed: 42, trialsOverride: FAST });
    const long6 = s6.spans.find((s) => s.games === 17500)!;
    expect(long6.perfect.max).toBeLessThan(1.2);
  }, 120_000);
});
