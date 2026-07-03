import { describe, expect, it } from 'vitest';
import { checkCompliance, RULESETS } from '../src/core/compliance.js';
import { sampleAType } from '../src/machines/sample-a.js';

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
  });

  it('現行フィクスチャは 17500G の下限 60% を割って不適合になる（設定 6 でも辛すぎる）', () => {
    const result = checkCompliance(sampleAType, { setting: 6, seed: 42, trialsOverride: FAST });
    expect(result.pass).toBe(false);
    const long = result.spans.find((s) => s.games === 17500)!;
    expect(long.pass).toBe(false);
    expect(long.naive.min).toBeLessThan(0.6); // 下限割れが原因
    // 上限側（短期の射幸性）は健全
    const short = result.spans.find((s) => s.games === 400)!;
    expect(short.pass).toBe(true);
  });
});
