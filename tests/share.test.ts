import { describe, expect, it } from 'vitest';
import { decodeMachine, encodeMachine, parseShareHash } from '../src/ui/share.js';
import { sampleAType } from '../src/machines/sample-a.js';
import { stockBB } from '../src/machines/stock-bb.js';

describe('共有エンコード（deflate + base64url）', () => {
  it('エンコード → デコードで元の定義に戻る', async () => {
    for (const machine of [sampleAType, stockBB]) {
      const encoded = await encodeMachine(machine);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/); // URL セーフ
      const decoded = await decodeMachine(encoded);
      expect(decoded).toEqual(JSON.parse(JSON.stringify(machine)));
    }
  });

  it('壊れたペイロードは例外になる', async () => {
    await expect(decodeMachine('zzz@@@')).rejects.toThrow();
  });

  it('parseShareHash は #m= プレフィクスだけ受け付ける', () => {
    expect(parseShareHash('#m=abc')).toBe('abc');
    expect(parseShareHash('#other=abc')).toBeNull();
    expect(parseShareHash('')).toBeNull();
  });
});
