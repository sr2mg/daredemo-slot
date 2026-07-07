import { useCallback, useState } from 'react';

/**
 * UI 設定の localStorage 永続化ヘルパ。
 * 方針は各ライブラリ（bgm-library / sfx-library）と同じ:
 * - 読み込みは必ず検証を通し、壊れた値・古い形式は初期値へ落とす
 * - 保存失敗（容量超過・プライベートモード等）は握りつぶす（動作には支障なし）
 * 保存対象は「設定」だけ。ゲーム状態（クレジット・内部状態）は対象外
 */

export function loadStored<T>(key: string, fallback: T, validate: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return validate(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function saveStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できなくてもその場の動作には支障なし
  }
}

/** useState + localStorage。初期値は保存値（検証つき）、set で自動保存 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  validate: (v: unknown) => v is T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => loadStored(key, initial, validate));
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        saveStored(key, resolved);
        return resolved;
      });
    },
    [key],
  );
  return [value, set];
}

/** よく使う検証: 候補リストのどれか */
export const oneOf =
  <T extends string | number | boolean>(...candidates: readonly T[]) =>
  (v: unknown): v is T =>
    candidates.includes(v as T);
