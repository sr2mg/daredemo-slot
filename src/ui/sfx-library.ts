import type { SfxDesign } from '../core/music/sfx-design.js';
import type { SfxName } from './opll-core.js';

/**
 * 効果音ライブラリとゲーム内契機への割り当ての永続化層（bgm-library.ts と同じ方針）。
 * 保存の実体は SfxDesign（レシピ ID + パラメータ）のみで、生成が純関数なので完全再現できる。
 *
 * ゲームの既定効果音もすべてレシピのプリセット（PRESET_SFX）。かつては手書きの
 * レジスタ列（buildSfxDefs）だったが、レシピ生成 + OPLL レンダリングに一本化した。
 * App / SfxPlayer は再生・レンダリングの瞬間に読み直すため、パネルと状態同期しない。
 */

export interface SavedSfx {
  id: string;
  name: string;
  design: SfxDesign;
}

/**
 * 割り当て値: 'preset'（既定音）/ 'none'（鳴らさない）/ 'custom:<SavedSfx.id>'。
 * 未設定は DEFAULT_CHOICE（なければ 'preset'）に従う
 */
export type SfxAssign = Partial<Record<SfxName, string>>;

/**
 * 契機ごとの既定割り当て。bet は MAX BET 前提で既定無音
 * （投入音はレバーオンに集約。鳴らしたければパネルで preset/custom を選べる）
 */
export const DEFAULT_CHOICE: SfxAssign = { bet: 'none' };

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

/**
 * 既定効果音のプリセットデザイン。操作音は C メジャーのコードトーンだけで
 * 設計してあり、どのタイミングで BGM に重なっても濁らない（調の統一）。
 * ベット = ド・ミ・ソの 3 連上行（MAX BET 3 枚の可聴化）、
 * レバー = ソ→ド（完全4度上行 = 始動の記号）。
 * 旧・大花火風ハモリ（beep2/beepChain）はレシピとしてデザイナに残っている。
 */
export const PRESET_SFX: Record<SfxName, SfxDesign> = {
  bet: { recipeId: 'coinIn', rootMidi: 72, speed: 1, voice: 10 }, // C5・E5・G5（既定は無音割り当て）
  lever: { recipeId: 'leverStart', rootMidi: 79, speed: 1, voice: 10, level: 0.55 }, // G5 → C6・控えめ
  betLever: { recipeId: 'leverStart', rootMidi: 79, speed: 1, voice: 10, level: 0.55 }, // MAX BET 前提 = レバー音のみ
  reelStop: { recipeId: 'thud', rootMidi: 60, speed: 1, voice: 13 }, // バスドラ + C4 クリック
  replay: { recipeId: 'confirm', rootMidi: 81, speed: 1, voice: 4 }, // A5 → D6（4度上行）
  payout: { recipeId: 'coins', rootMidi: 96, speed: 1, voice: 12 }, // C7/G6 交互連打
  kyuin: { recipeId: 'kyuin', rootMidi: 67, speed: 1, voice: 15 }, // G4 → 2 オクターブ上
  fanfare: { recipeId: 'kakutei', rootMidi: 72, speed: 1, voice: 7 }, // C5・トランペット
  siren: { recipeId: 'siren', rootMidi: 74, speed: 1, voice: 9 }, // D5・ホルン
  rush: { recipeId: 'kakutei', rootMidi: 72, speed: 1.4, voice: 10 }, // 速い上行・シンセ
};

/** 旧形式（wave: Web Audio のオシレータ種）を OPLL 音色へ読み替える */
function migrateDesign(design: SfxDesign & { wave?: string }): SfxDesign {
  if (typeof design.voice === 'number') return design;
  const voiceOf: Record<string, number> = { square: 5, triangle: 4, sawtooth: 10, sine: 4 };
  const { wave, ...rest } = design;
  return { ...rest, voice: voiceOf[wave ?? ''] ?? 10 };
}

export function loadSfxDesigns(): SavedSfx[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SFX_KEY) ?? '[]') as SavedSfx[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s) => s && s.id && s.design)
      .map((s) => ({ ...s, design: migrateDesign(s.design) }));
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

/**
 * 契機の効果音デザインを解決する。'none' は null（鳴らさない）。
 * 不正値・消えた自作音はプリセットへフォールバック
 */
export function resolveSfxAssign(name: SfxName): SfxDesign | null {
  const choice = loadSfxAssign()[name] ?? DEFAULT_CHOICE[name] ?? 'preset';
  if (choice === 'none') return null;
  if (choice.startsWith('custom:')) {
    const id = choice.slice('custom:'.length);
    const custom = loadSfxDesigns().find((s) => s.id === id)?.design;
    if (custom) return custom;
  }
  return PRESET_SFX[name];
}
