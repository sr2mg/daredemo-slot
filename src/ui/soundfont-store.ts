/**
 * SoundFontの取得と保持。3系統のソースを同じ形で返す:
 * - bundled: 同梱の GeneralUser GS（再配布可ライセンス。public/soundfonts/）
 * - local:   git管理外の public/soundfonts/local/user.sf2（SC-88系など再配布不可の私物）
 * - picked:  ファイル選択。IndexedDBへ保存し、次回以降も使える
 *
 * どの系統も部分読み(audio/sf2-lazy.ts)で開く。ここで読むのは目録だけで、波形は曲が
 * 実際に鳴らすプリセットの分だけ後から取りに行く。HTTP は Range 要求、選択ファイルは
 * Blob.slice が取得口になるので、数百 MB のフォントでもメモリへ丸ごとは載らない。
 */

import { openSf2 } from '../audio/sf2-lazy.js';
import type { LazySf2, Sf2ByteSource } from '../audio/sf2-lazy.js';

export type SoundFontSource = 'bundled' | 'local' | 'picked';

export interface ActiveSoundFont {
  /** レンダリングキャッシュのキーに入る識別子。フォントが変われば必ず変わること。 */
  id: string;
  label: string;
  font: LazySf2;
}

export const SOUND_FONT_SOURCE_LABELS: Record<SoundFontSource, string> = {
  bundled: '同梱 GeneralUser GS',
  local: 'local/user.sf2（git管理外）',
  picked: 'ファイルを選ぶ…',
};

const DB_NAME = 'daredemo.soundfont.v1';
const STORE = 'fonts';
const PICKED_KEY = 'picked';

/** 保存形式。blob が現行(ディスク上の参照のまま持てる)、buffer は部分読み導入前の旧形式。 */
interface StoredFont {
  name: string;
  blob?: Blob;
  buffer?: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDBを開けません'));
  });
}

async function idbGet(): Promise<StoredFont | null> {
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

async function idbPut(value: StoredFont): Promise<void> {
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

/** Blob(選択ファイル・IndexedDB の保存物)を取得口にする。slice は必要な範囲だけディスクから読む。 */
function blobSource(blob: Blob): Sf2ByteSource {
  return {
    size: blob.size,
    read: (offset, length) => blob.slice(offset, offset + length).arrayBuffer(),
  };
}

/** 最初の要求でまとめて読む長さ。ヘッダと INFO がここに収まり、往復を1回減らせる。 */
const FIRST_BLOCK_BYTES = 65536;

/**
 * HTTP の Range 要求を取得口にする。サーバーが Range に応じない(200 で全体を返す)場合は、
 * その全体をメモリに持って従来どおり動かす。
 */
async function httpSource(url: string, label: string): Promise<Sf2ByteSource> {
  const first = await fetch(url, { headers: { Range: `bytes=0-${FIRST_BLOCK_BYTES - 1}` } });
  if (!first.ok) throw new Error(`${label} を取得できません (HTTP ${first.status})`);
  const head = await first.arrayBuffer();
  const total = Number(/\/(\d+)\s*$/.exec(first.headers.get('Content-Range') ?? '')?.[1]);
  if (first.status !== 206 || !Number.isFinite(total)) {
    return { size: head.byteLength, read: async (offset, length) => head.slice(offset, offset + length) };
  }
  let whole: ArrayBuffer | null = null;
  return {
    size: total,
    read: async (offset, length) => {
      if (whole) return whole.slice(offset, offset + length);
      if (offset + length <= head.byteLength) return head.slice(offset, offset + length);
      const response = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
      if (!response.ok) throw new Error(`${label} を取得できません (HTTP ${response.status})`);
      const body = await response.arrayBuffer();
      if (response.status === 206 && body.byteLength === length) return body;
      // 途中から Range に応じなくなった場合(中継の差し替え等)は、返ってきた全体で続ける。
      if (response.status === 200 && body.byteLength === total) {
        whole = body;
        return whole.slice(offset, offset + length);
      }
      throw new Error(`${label} の部分取得に失敗しました`);
    },
  };
}

const cache = new Map<string, Promise<ActiveSoundFont>>();

async function fetchFont(url: string, id: string, label: string): Promise<ActiveSoundFont> {
  const source = await httpSource(url, label);
  return { id: `${id}:${source.size}`, label, font: await openSf2(source) };
}

/** 選択ソースのフォントを開く(目録だけ読み、開いたものをメモリキャッシュ)。 */
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
    const blob = stored?.blob ?? (stored?.buffer ? new Blob([stored.buffer]) : null);
    if (!stored || !blob) throw new Error('保存済みのSoundFontがありません。ファイルを選んでください');
    return {
      id: `picked:${stored.name}:${blob.size}`,
      label: stored.name,
      font: await openSf2(blobSource(blob)),
    };
  })();
  cache.set(source, promise);
  promise.catch(() => cache.delete(source));
  return promise;
}

/**
 * ファイル選択からの取り込み。目録を読めた時点ですぐ使えるようにし、IndexedDB への保存
 * (以後 'picked' で再利用するため)は裏で進める。保存の完了は saved で知らせる。
 */
export async function savePickedSoundFont(file: File): Promise<{ active: ActiveSoundFont; saved: Promise<void> }> {
  const font = await openSf2(blobSource(file)); // 保存前に検証(壊れたファイルを覚えない)
  const active = { id: `picked:${file.name}:${file.size}`, label: file.name, font };
  cache.set('picked', Promise.resolve(active));
  return { active, saved: idbPut({ name: file.name, blob: file }) };
}
