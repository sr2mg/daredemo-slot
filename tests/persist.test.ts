import { beforeEach, describe, expect, it } from 'vitest';
import { loadStored, oneOf, saveStored } from '../src/ui/persist.js';

/**
 * UI 設定の永続化ヘルパ（persist.ts）。
 * ここが通っていれば、壊れた保存値・古い形式・localStorage 無し環境で
 * アプリが初期値に落ちて動き続けることが保証される。
 */

/** Node 環境には localStorage が無いので Map で代用 */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

const isNum = (v: unknown): v is number => typeof v === 'number';

describe('persist（UI 設定の localStorage 永続化）', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = fakeStorage();
  });

  it('保存 → 読み込みが往復する（検証つき）', () => {
    saveStored('k', 42);
    expect(loadStored('k', 0, isNum)).toBe(42);
    saveStored('obj', { a: 1 });
    expect(loadStored('obj', { a: 0 }, (v): v is { a: number } => typeof v === 'object' && v !== null)).toEqual({
      a: 1,
    });
  });

  it('未保存・検証 NG・壊れた JSON は初期値に落ちる', () => {
    expect(loadStored('nothing', 7, isNum)).toBe(7);
    saveStored('wrongType', 'str');
    expect(loadStored('wrongType', 7, isNum)).toBe(7);
    localStorage.setItem('broken', '{oops');
    expect(loadStored('broken', 7, isNum)).toBe(7);
  });

  it('oneOf は候補だけを通す（boolean も可）', () => {
    const v = oneOf('none', 'flag', 'release');
    expect(v('flag')).toBe(true);
    expect(v('hack')).toBe(false);
    const b = oneOf(true, false);
    expect(b(true)).toBe(true);
    expect(b('true')).toBe(false);
  });

  it('localStorage が無い環境でも例外を出さず初期値で動く', () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    expect(() => saveStored('k', 1)).not.toThrow();
    expect(loadStored('k', 9, isNum)).toBe(9);
  });
});
