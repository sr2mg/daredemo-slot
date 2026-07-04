import type { SfxDesign } from '../core/music/sfx-design.js';
import type { SfxName } from './opll-core.js';

/**
 * 自作効果音ライブラリとゲーム内契機への割り当ての永続化層（bgm-library.ts と同じ方針）。
 * 保存の実体は SfxDesign（レシピ ID + パラメータ）のみで、生成が純関数なので完全再現できる。
 * App は再生の瞬間に読み直すため、パネルと React 状態を同期する必要がない。
 */

export interface SavedSfx {
  id: string;
  name: string;
  design: SfxDesign;
}

/** 割り当て値: 'builtin' か 'custom:<SavedSfx.id>' */
export type SfxAssign = Partial<Record<SfxName, string>>;

const SFX_KEY = 'daredemo.sfxDesigns.v1';
const ASSIGN_KEY = 'daredemo.sfxAssignments.v1';

/** カスタム効果音を割り当てられるゲーム内契機 */
export const ASSIGNABLE_SFX: readonly { name: SfxName; label: string }[] = [
  { name: 'fanfare', label: 'ファンファーレ（ボーナス開始）' },
  { name: 'kyuin', label: 'キュイン（告知）' },
  { name: 'siren', label: 'サイレン（放出開始）' },
  { name: 'rush', label: 'ラッシュ（AT・CT突入）' },
  { name: 'payout', label: 'コイン払い出し' },
  { name: 'replay', label: 'リプレイ' },
  { name: 'reelStop', label: 'リール停止' },
  { name: 'bet', label: 'ベット' },
  { name: 'lever', label: 'レバーオン' },
  { name: 'betLever', label: 'ベット→レバー連結' },
];

export function loadSfxDesigns(): SavedSfx[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SFX_KEY) ?? '[]') as SavedSfx[];
    return Array.isArray(parsed) ? parsed.filter((s) => s && s.id && s.design) : [];
  } catch {
    return [];
  }
}

export function saveSfxDesigns(designs: SavedSfx[]): void {
  try {
    localStorage.setItem(SFX_KEY, JSON.stringify(designs));
  } catch {
    // 保存できなくても再生には支障なし
  }
}

export function loadSfxAssign(): SfxAssign {
  try {
    const parsed = JSON.parse(localStorage.getItem(ASSIGN_KEY) ?? '{}') as SfxAssign;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveSfxAssign(assign: SfxAssign): void {
  try {
    localStorage.setItem(ASSIGN_KEY, JSON.stringify(assign));
  } catch {
    // 保存できなくても再生には支障なし
  }
}

/** 契機に割り当てられた自作効果音を返す。内蔵・不正値・消えた曲は null（= OPLL で鳴らす） */
export function resolveSfxAssign(name: SfxName): SfxDesign | null {
  const choice = loadSfxAssign()[name];
  if (!choice || !choice.startsWith('custom:')) return null;
  const id = choice.slice('custom:'.length);
  return loadSfxDesigns().find((s) => s.id === id)?.design ?? null;
}
