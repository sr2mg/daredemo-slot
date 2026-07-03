import { describe, expect, it } from 'vitest';
import { describeMachine } from '../src/core/describe.js';
import { atBeast } from '../src/machines/at-beast.js';
import { sampleAType } from '../src/machines/sample-a.js';
import { stockBB } from '../src/machines/stock-bb.js';
import { stockSB } from '../src/machines/stock-sb.js';

describe('describeMachine（ガイド自動生成）', () => {
  it('A タイプ: ボーナス行・設定差・技術介入度が入る', () => {
    const guide = describeMachine(sampleAType);
    expect(guide.specRows.some((r) => r.label.includes('BIG BONUS'))).toBe(true);
    expect(guide.specRows.some((r) => r.label.includes('REGULAR BONUS'))).toBe(true);
    expect(guide.specRows.some((r) => r.probMax !== null)).toBe(true); // 設定差あり
    expect(guide.points.some((p) => p.includes('技術介入度'))).toBe(true);
    expect(guide.points.some((p) => p.includes('リーチ目'))).toBe(true); // queueLimit=1 の持ち越し説明
    expect(guide.rateNote).toContain('設定6');
  });

  it('ストック機: 蓋とモードの説明が生成される', () => {
    const guide = describeMachine(stockBB);
    expect(guide.summary).toContain('ストック');
    expect(guide.points.some((p) => p.includes('ストック'))).toBe(true);
    expect(guide.points.some((p) => p.includes('モード「heaven」'))).toBe(true);
  });

  it('SB ストック機: 純ハズレ解除の説明が生成される', () => {
    const guide = describeMachine(stockSB);
    expect(guide.points.some((p) => p.includes('純ハズレ'))).toBe(true);
  });

  it('AT 機: AT のきっかけとセット管理の説明が生成される', () => {
    const guide = describeMachine(atBeast);
    expect(guide.points.some((p) => p.includes('AT 突入'))).toBe(true);
    expect(guide.points.some((p) => p.includes('継続率'))).toBe(true);
    expect(guide.specRows.some((r) => r.label.includes('押し順'))).toBe(true);
  });
});
