import type { MachineDef } from '../core/types.js';

/**
 * 機種定義の共有: URL ハッシュ埋め込み・JSON ファイルのエクスポート/インポート。
 * URL 共有は deflate 圧縮 + base64url でハッシュ（#m=...）に載せる。
 * サーバー不要（定義そのものが URL に入る）なので、リンクを送るだけで相手が遊べる。
 */

const HASH_PREFIX = '#m=';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): Uint8Array {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const readable = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(readable).arrayBuffer());
}

/** 機種定義 → 共有用文字列（deflate + base64url） */
export async function encodeMachine(def: MachineDef): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(def));
  const compressed = await pipe(json, new CompressionStream('deflate-raw'));
  return toBase64Url(compressed);
}

/** 共有用文字列 → 機種定義。壊れた入力は例外を投げる（呼び出し側で検証パイプラインに通すこと） */
export async function decodeMachine(encoded: string): Promise<MachineDef> {
  const compressed = fromBase64Url(encoded);
  const json = await pipe(compressed, new DecompressionStream('deflate-raw'));
  return JSON.parse(new TextDecoder().decode(json)) as MachineDef;
}

/** 現在のページ URL に機種を埋め込んだ共有リンクを作る */
export async function buildShareUrl(def: MachineDef): Promise<string> {
  const encoded = await encodeMachine(def);
  return `${location.origin}${location.pathname}${HASH_PREFIX}${encoded}`;
}

/** location.hash から共有ペイロードを取り出す（無ければ null） */
export function parseShareHash(hash: string): string | null {
  return hash.startsWith(HASH_PREFIX) ? hash.slice(HASH_PREFIX.length) : null;
}

/** 機種定義を JSON ファイルとしてダウンロードさせる */
export function downloadMachine(def: MachineDef): void {
  const blob = new Blob([JSON.stringify(def, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${def.name.replace(/[\\/:*?"<>|\s]+/g, '_') || 'machine'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** JSON ファイルから機種定義を読み込む（パースのみ。検証は呼び出し側） */
export async function readMachineFile(file: File): Promise<MachineDef> {
  return JSON.parse(await file.text()) as MachineDef;
}
