import type { ComposeOptions } from '../core/music/compose.js';
import type { BgmName } from './bgm.js';

/**
 * 自作 BGM ライブラリと BB/RB への割り当ての永続化層。
 * 曲はレンダリング結果ではなく ComposeOptions（進行・スロット選択・シード）で保存する。
 * compose() が決定論なので、これだけで同じ曲が完全に再現できる（保存サイズも極小）。
 *
 * App 側は再生の瞬間に localStorage から読み直すため、パネルと App の間で
 * React 状態を同期する必要がない。
 */

export interface SavedSong {
  id: string;
  name: string;
  options: ComposeOptions;
}

/** 割り当て値: 'builtin:<BgmName>' か 'song:<SavedSong.id>' */
export interface BgmAssign {
  bb: string;
  rb: string;
}

const SONGS_KEY = 'daredemo.bgmSongs.v1';
const ASSIGN_KEY = 'daredemo.bgmAssign.v1';
const VOLUME_KEY = 'daredemo.bgmComposer.volume.v1';

export const DEFAULT_ASSIGN: BgmAssign = { bb: 'builtin:bb', rb: 'builtin:rb' };

/** 割り当てドロップダウンに出す内蔵曲（sound-test.tsx の試聴リストと同じ曲目） */
export const BUILTIN_BGM: readonly { name: BgmName; label: string }[] = [
  { name: 'bb', label: '内蔵: 草競馬' },
  { name: 'rb', label: '内蔵: チャールダーシュ' },
  { name: 'rb2', label: '内蔵: ジムノペディ第1番' },
  { name: 'rb3', label: '内蔵: 別れの曲' },
];

export function loadSongs(): SavedSong[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SONGS_KEY) ?? '[]') as SavedSong[];
    return Array.isArray(parsed) ? parsed.filter((s) => s && s.id && s.options) : [];
  } catch {
    return [];
  }
}

export function saveSongs(songs: SavedSong[]): void {
  try {
    localStorage.setItem(SONGS_KEY, JSON.stringify(songs));
  } catch {
    // 容量超過等。保存できなくても再生には支障なし
  }
}

export function loadAssign(): BgmAssign {
  try {
    const parsed = JSON.parse(localStorage.getItem(ASSIGN_KEY) ?? 'null') as Partial<BgmAssign> | null;
    return {
      bb: typeof parsed?.bb === 'string' ? parsed.bb : DEFAULT_ASSIGN.bb,
      rb: typeof parsed?.rb === 'string' ? parsed.rb : DEFAULT_ASSIGN.rb,
    };
  } catch {
    return { ...DEFAULT_ASSIGN };
  }
}

export function saveAssign(assign: BgmAssign): void {
  try {
    localStorage.setItem(ASSIGN_KEY, JSON.stringify(assign));
  } catch {
    // 保存できなくても再生には支障なし
  }
}

/** BGM 作成パネルの音量（0..100）。ゲーム中の自作 BGM も同じ音量で鳴らす */
export function loadBgmVolume(): number {
  const raw = localStorage.getItem(VOLUME_KEY);
  const v = raw === null ? NaN : Number(raw);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 50;
}

export function saveBgmVolume(volume: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    // 保存できなくても再生には支障なし
  }
}

/** 割り当て値を解決する。曲が消えている等の不正値は内蔵のデフォルト曲へフォールバック */
export function resolveAssign(
  slot: 'bb' | 'rb',
): { kind: 'builtin'; name: BgmName } | { kind: 'song'; song: SavedSong } {
  const choice = loadAssign()[slot];
  if (choice.startsWith('song:')) {
    const id = choice.slice('song:'.length);
    const song = loadSongs().find((s) => s.id === id);
    if (song) return { kind: 'song', song };
  }
  if (choice.startsWith('builtin:')) {
    const name = choice.slice('builtin:'.length);
    if (BUILTIN_BGM.some((b) => b.name === name)) return { kind: 'builtin', name: name as BgmName };
  }
  return { kind: 'builtin', name: slot };
}
