/**
 * SoundFontの取得と保持。3系統のソースを同じ形で返す:
 * - bundled: 同梱の GeneralUser GS（再配布可ライセンス。public/soundfonts/）
 * - local:   git管理外の public/soundfonts/local/user.sf2（SC-88系など再配布不可の私物）
 * - picked:  ファイル選択。IndexedDBへ保存し、次回以降も使える
 */

import { parseSf2 } from '../audio/sf2.js';
import type { Sf2Font } from '../audio/sf2.js';

export type SoundFontSource = 'bundled' | 'local' | 'picked';

export interface ActiveSoundFont {
  /** レンダリングキャッシュのキーに入る識別子。フォントが変われば必ず変わること。 */
  id: string;
  label: string;
  font: Sf2Font;
}

export const SOUND_FONT_SOURCE_LABELS: Record<SoundFontSource, string> = {
  bundled: '同梱 GeneralUser GS',
  local: 'local/user.sf2（git管理外）',
  picked: 'ファイルを選ぶ…',
};

const DB_NAME = 'daredemo.soundfont.v1';
const STORE = 'fonts';
const PICKED_KEY = 'picked';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDBを開けません'));
  });
}

async function idbGet(): Promise<{ name: string; buffer: ArrayBuffer } | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(PICKED_KEY);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error('読み込み失敗'));
    });
  } finally {
    db.close();
  }
}

async function idbPut(value: { name: string; buffer: ArrayBuffer }): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, PICKED_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('保存失敗'));
    });
  } finally {
    db.close();
  }
}

const cache = new Map<string, Promise<ActiveSoundFont>>();

async function fetchFont(url: string, id: string, label: string): Promise<ActiveSoundFont> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} を取得できません (HTTP ${response.status})`);
  const buffer = await response.arrayBuffer();
  return { id: `${id}:${buffer.byteLength}`, label, font: parseSf2(buffer) };
}

/** 選択ソースのフォントを読み込む(パース済みをメモリキャッシュ)。 */
export function loadSoundFont(source: SoundFontSource): Promise<ActiveSoundFont> {
  const cached = cache.get(source);
  if (cached) return cached;
  const base = import.meta.env.BASE_URL;
  const promise = (async () => {
    if (source === 'bundled') {
      return fetchFont(`${base}soundfonts/GeneralUser-GS.sf2`, 'gu-gs', '同梱 GeneralUser GS');
    }
    if (source === 'local') {
      return fetchFont(`${base}soundfonts/local/user.sf2`, 'local-user', 'local/user.sf2');
    }
    const stored = await idbGet();
    if (!stored) throw new Error('保存済みのSoundFontがありません。ファイルを選んでください');
    return {
      id: `picked:${stored.name}:${stored.buffer.byteLength}`,
      label: stored.name,
      font: parseSf2(stored.buffer),
    };
  })();
  cache.set(source, promise);
  promise.catch(() => cache.delete(source));
  return promise;
}

/** ファイル選択からの取り込み。IndexedDBへ保存して以後 'picked' で再利用できる。 */
export async function savePickedSoundFont(file: File): Promise<ActiveSoundFont> {
  const buffer = await file.arrayBuffer();
  const font = parseSf2(buffer); // 保存前に検証(壊れたファイルを覚えない)
  await idbPut({ name: file.name, buffer });
  const active = { id: `picked:${file.name}:${buffer.byteLength}`, label: file.name, font };
  cache.set('picked', Promise.resolve(active));
  return active;
}
