import type { ComposeOptions } from '../core/music/compose.js';

/**
 * BGM ライブラリと BB/RB への割り当ての永続化層。
 * 曲はレンダリング結果ではなく ComposeOptions（進行・スロット選択・シード）で保存する。
 * compose() が決定論なのでこれだけで同じ曲が完全に再現できる（保存サイズも極小）。
 *
 * デフォルト BGM も同じ仕組みのプリセット曲（固定シードの ComposeOptions）。
 * かつては PD クラシックの採譜（草競馬・チャールダーシュ等）を内蔵していたが、
 * 作曲エンジン + OPLL 編曲で置き換えて削除した。
 *
 * App 側は再生の瞬間に localStorage から読み直すため、パネルと App の間で
 * React 状態を同期する必要がない。
 */

export interface SavedSong {
  id: string;
  name: string;
  options: ComposeOptions;
}

/** 割り当て値: 'preset:<id>' か 'song:<SavedSong.id>' */
export interface BgmAssign {
  bb: string;
  rb: string;
}

const SONGS_KEY = 'daredemo.bgmSongs.v1';
const ASSIGN_KEY = 'daredemo.bgmAssign.v1';
const VOLUME_KEY = 'daredemo.bgmComposer.volume.v1';

/**
 * プリセット曲（デフォルト BGM）。固定シードなので全員の環境で同じ曲になる。
 * BB = 田中・真部進行の 8 小節 A+A'、RB = 王道ポップの 4 小節ループ。
 */
export const PRESET_SONGS: readonly SavedSong[] = [
  {
    id: 'preset-bb',
    name: 'プリセット: 疾走（BB 向き）',
    options: {
      progressionId: 'tanaka-manabe',
      styleId: 'eurobeat',
      keyRoot: 0,
      bpm: 170,
      bars: 8,
      seed: 20260704,
    },
  },
  {
    id: 'preset-rb',
    name: 'プリセット: 軽快（RB 向き）',
    options: {
      progressionId: 'royal-pop',
      styleId: 'eurobeat',
      keyRoot: 0,
      bpm: 170,
      bars: 4,
      seed: 777,
    },
  },
];

export const DEFAULT_ASSIGN: BgmAssign = { bb: 'preset:preset-bb', rb: 'preset:preset-rb' };

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

/** 旧形式（'builtin:*' = 削除済みの内蔵曲）はプリセットへ読み替える */
function normalizeChoice(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  if (value.startsWith('builtin:')) return fallback;
  return value;
}

export function loadAssign(): BgmAssign {
  try {
    const parsed = JSON.parse(localStorage.getItem(ASSIGN_KEY) ?? 'null') as Partial<BgmAssign> | null;
    return {
      bb: normalizeChoice(parsed?.bb, DEFAULT_ASSIGN.bb),
      rb: normalizeChoice(parsed?.rb, DEFAULT_ASSIGN.rb),
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

/** BGM 音量（0..100）。ゲーム中の BGM も試聴も同じ音量で鳴らす */
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

/**
 * 割り当て値を曲に解決する。自作曲が消えている等の不正値は
 * そのスロットのデフォルトプリセットへフォールバック。
 */
export function resolveAssign(slot: 'bb' | 'rb'): SavedSong {
  const fallback = PRESET_SONGS.find((p) => `preset:${p.id}` === DEFAULT_ASSIGN[slot])!;
  const choice = loadAssign()[slot];
  if (choice.startsWith('song:')) {
    const id = choice.slice('song:'.length);
    return loadSongs().find((s) => s.id === id) ?? fallback;
  }
  if (choice.startsWith('preset:')) {
    const id = choice.slice('preset:'.length);
    return PRESET_SONGS.find((p) => p.id === id) ?? fallback;
  }
  return fallback;
}
