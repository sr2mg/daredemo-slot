import { describe, expect, it } from 'vitest';
import { countSymbols, generateStrips, minCountForPb1 } from '../src/core/layout-gen.js';
import { checkLayout } from '../src/core/validate.js';
import { atBeast } from '../src/machines/at-beast.js';
import { sampleAType } from '../src/machines/sample-a.js';
import { stockSB } from '../src/machines/stock-sb.js';

describe('generateStrips（リール配列の自動生成）', () => {
  it('図柄個数を保ったまま全制約を満たす配列を生成する', () => {
    const result = generateStrips(sampleAType, { seed: 42 });
    expect(result.ok).toBe(true);
    expect(result.report?.ok).toBe(true);
    for (let reel = 0; reel < 3; reel++) {
      expect(countSymbols(result.strips![reel]!)).toEqual(countSymbols(sampleAType.strips[reel]!));
    }
    // 生成物を差し替えても総当たり検証に通る
    const regenerated = { ...sampleAType, strips: result.strips! };
    expect(checkLayout(regenerated).ok).toBe(true);
  }, 120_000);

  it('SB 役（replay/replay/bell）のような非対称 PB=1 パターンでも生成できる', () => {
    const result = generateStrips(stockSB, { seed: 7 });
    expect(result.ok).toBe(true);
    expect(checkLayout({ ...stockSB, strips: result.strips! }).ok).toBe(true);
  }, 120_000);

  it('押し順ベル機（同一パターンのフラグ細分化）でも生成できる', () => {
    const result = generateStrips(atBeast, { seed: 3 });
    expect(result.ok).toBe(true);
  }, 120_000);

  it('PB=1 図柄の個数が足りないときは具体的なエラーを返す', () => {
    const counts = sampleAType.strips.map((s) => ({ ...countSymbols(s) }));
    // 左リールのベルを 2 個に減らし、差分をブランクへ（PB=1 には 4 個必要）
    counts[0]!['bell'] = 2;
    counts[0]!['blank'] = (counts[0]!['blank'] ?? 0) + 2;
    const result = generateStrips(sampleAType, { seed: 1, counts });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('bell');
    expect(result.error).toContain(`${minCountForPb1(sampleAType.frames)} 個以上`);
  });

  it('コマ数と合わない個数指定はエラー', () => {
    const counts = sampleAType.strips.map((s) => ({ ...countSymbols(s) }));
    counts[1]!['bell'] = (counts[1]!['bell'] ?? 0) + 1; // 合計 21 個
    const result = generateStrips(sampleAType, { seed: 1, counts });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('リール2');
  });
});
