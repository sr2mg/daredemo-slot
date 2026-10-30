import type { SfxDesign } from '../core/sfx/sfx-design.js';
import type { SfxName } from './sfx-names.js';

/**
 * 効果音ライブラリとゲーム内契機への割り当ての永続化層（bgm-library.ts と同じ方針）。
 * 保存の実体は SfxDesign（レシピ ID + パラメータ）のみで、生成が純関数なので完全再現できる。
 *
 * ゲームの既定効果音もすべてレシピのプリセット（PRESET_SFX）。かつては手書きの
 * レジスタ列（buildSfxDefs）だったが、レシピ生成 + OPLL レンダリングに一本化した。
 * App / SfxPlayer は再生・レンダリングの瞬間に読み直すため、パネルと状態同期しない。
 *
 * 契機の設計規則（パチスロ効果音の設計原則に従う）:
 * - 強度は「音そのもの」ではなく「契機（信頼度 × 頻度）」の属性。SFX_TRIGGERS の tier が
 *   相対段階（int-1 操作 … int-5 告知）で、自作音を割り当てても契機の段階は変わらない
 * - 告知・確定の直前には間（無音）を置く（preGapSec）。「無音が一番の音楽」
 * - 同じ瞬間に複数の契機が立ったら、優先度順に直列化し、告知があれば予告は鳴らさない
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

/**
 * 強度段階（相対ラウドネス）。1 = 基本操作音（基準）… 5 = 告知・確定（機種の最大値）。
 * プレミアは 5 を超えて大きくするのではなく「質の違い」（異質な音色・無音）で出す
 */
export type SfxTier = 1 | 2 | 3 | 4 | 5;

/**
 * 段階 → 出力係数（正規化ピークへの倍率）。段階ごとに約 2dB ずつ上がる相対表。
 * 「スタート音より目立って、スイカより目立たない」を数値にしたもので、最大音量を
 * 上げる方向ではなく基準（操作音）を下げる方向で差を作る
 */
export const TIER_LEVEL: Record<SfxTier, number> = { 1: 0.42, 2: 0.55, 3: 0.7, 4: 0.85, 5: 1 };

export interface SfxTrigger {
  name: SfxName;
  label: string;
  /** 強度段階（int-N） */
  tier: SfxTier;
  /** 直前に置く無音（秒）。告知・確定は「音で当たりを感じる」ための間を取る */
  preGapSec?: number;
}

/**
 * 契機表。配列の並び = 同時発火時の優先度（前ほど先に鳴る）。
 * 告知（tier 5）> 予告（3〜4）> 獲得（2）> 操作（1）の順で、同じ段階では情報の重さ順。
 */
export const SFX_TRIGGERS: readonly SfxTrigger[] = [
  { name: 'fanfare', label: 'ファンファーレ（ボーナス開始）', tier: 5, preGapSec: 0.2 },
  { name: 'rush', label: 'ラッシュ（AT・CT突入）', tier: 5, preGapSec: 0.15 },
  { name: 'siren', label: 'サイレン（放出開始）', tier: 5, preGapSec: 0.1 },
  { name: 'kyuin', label: 'キュイン（告知）', tier: 5, preGapSec: 0.3 },
  { name: 'yokokuStrong', label: '強予告（カットイン・対決）', tier: 4 },
  { name: 'yokokuMid', label: '中予告（示唆・継続）', tier: 3 },
  { name: 'yokokuWeak', label: '弱予告（点滅・賑やかし）', tier: 2 },
  { name: 'payoutBonus', label: '払い出し（ボーナス・AT 中）', tier: 2 },
  { name: 'payout', label: '払い出し（通常時）', tier: 2 },
  { name: 'payoutLow', label: '払い出し（賭け枚数以下）', tier: 1 },
  { name: 'replay', label: 'リプレイ', tier: 1 },
  { name: 'lever', label: 'レバーオン', tier: 1 },
  { name: 'betLever', label: 'ベット→レバー連結', tier: 1 },
  { name: 'bet', label: 'ベット', tier: 1 },
  { name: 'navLeft', label: '押し順ナビ（左）', tier: 2 },
  { name: 'navCenter', label: '押し順ナビ（中）', tier: 2 },
  { name: 'navRight', label: '押し順ナビ（右）', tier: 2 },
  { name: 'reelStop', label: 'リール停止', tier: 1 },
  { name: 'wait', label: 'ウエイト（待ち合図）', tier: 1 },
  { name: 'error', label: 'エラー（操作拒否）', tier: 1 },
];

const TRIGGER_BY_NAME: ReadonlyMap<SfxName, SfxTrigger> = new Map(SFX_TRIGGERS.map((t) => [t.name, t]));

export function sfxTrigger(name: SfxName): SfxTrigger {
  return TRIGGER_BY_NAME.get(name)!;
}

/** カスタム効果音を割り当てられるゲーム内契機（= 契機表そのもの） */
export const ASSIGNABLE_SFX: readonly { name: SfxName; label: string }[] = SFX_TRIGGERS.map(
  ({ name, label, tier }) => ({ name, label: `${label} [int-${tier}]` }),
);

/**
 * 既定効果音のプリセットデザイン。操作音は C メジャーのコードトーンだけで
 * 設計してあり、どのタイミングで BGM に重なっても濁らない（調の統一。BGM のキーが
 * C 以外のときは SfxPlayer がレシピごと平行移動する）。
 * ベット = ド・ミ・ソの 3 連上行（MAX BET 3 枚の可聴化）、
 * レバー = テレレレ（主和音の速い分散上行。4号機始動音の様式調査に基づく）。
 * 強度（出力係数）はここでは持たず、契機の tier（SFX_TRIGGERS）から決まる。
 * 旧・始動ベンド（leverStart）や大花火風ハモリ（beep2/beepChain）はレシピとして残っている。
 */
export const PRESET_SFX: Record<SfxName, SfxDesign> = {
  bet: { recipeId: 'coinIn', rootMidi: 72, speed: 1, voice: 10 }, // C5・E5・G5（既定は無音割り当て）
  lever: { recipeId: 'startArp', rootMidi: 72, speed: 1, voice: 12 }, // C5-E5-G5-C6 テレレレ
  betLever: { recipeId: 'startArp', rootMidi: 72, speed: 1, voice: 12 }, // MAX BET 前提 = レバー音のみ
  reelStop: { recipeId: 'thud', rootMidi: 60, speed: 1, voice: 13 }, // バスドラ + C4 クリック
  wait: { recipeId: 'waitTick', rootMidi: 60, speed: 1, voice: 4 }, // C4 の平坦な 2 打
  error: { recipeId: 'cancel', rootMidi: 76, speed: 1.4, voice: 4 }, // E5 → C5 の短い下行（否定）
  navLeft: { recipeId: 'confirm', rootMidi: 72, speed: 1.4, voice: 4 }, // ド → ファ
  navCenter: { recipeId: 'confirm', rootMidi: 76, speed: 1.4, voice: 4 }, // ミ → ラ
  navRight: { recipeId: 'confirm', rootMidi: 79, speed: 1.4, voice: 4 }, // ソ → ド（左<中<右で音程が上がる）
  replay: { recipeId: 'confirm', rootMidi: 81, speed: 1, voice: 4 }, // A5 → D6（4度上行）
  payoutLow: { recipeId: 'payoutLow', rootMidi: 84, speed: 1, voice: 12 }, // 祝福しない受領音
  payout: { recipeId: 'coins', rootMidi: 96, speed: 1, voice: 12 }, // C7/G6 交互連打
  payoutBonus: { recipeId: 'coins', rootMidi: 91, speed: 1.4, voice: 10 }, // G6/D6・速く・シンセ（状態別の音色）
  yokokuWeak: { recipeId: 'confirm', rootMidi: 84, speed: 1.4, voice: 12 }, // 高めの短い上行
  yokokuMid: { recipeId: 'aori', rootMidi: 76, speed: 1.4, voice: 10 }, // 速い半音上昇トレモロ
  yokokuStrong: { recipeId: 'keikoku', rootMidi: 84, speed: 1, voice: 10 }, // トライトーンへのベンド（激熱）
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

/** 契機の強度段階をデザインの出力係数へ焼き込む（design.level は段階の中での微調整） */
export function applyTier(design: SfxDesign, name: SfxName): SfxDesign {
  return { ...design, level: (design.level ?? 1) * TIER_LEVEL[sfxTrigger(name).tier] };
}

/**
 * 契機の効果音デザインを解決する。'none' は null（鳴らさない）。
 * 不正値・消えた自作音はプリセットへフォールバック。
 * 戻り値には契機の強度段階が焼き込まれている（自作音を割り当てても段階は契機のもの）
 */
export function resolveSfxAssign(name: SfxName): SfxDesign | null {
  const choice = loadSfxAssign()[name] ?? DEFAULT_CHOICE[name] ?? 'preset';
  if (choice === 'none') return null;
  if (choice.startsWith('custom:')) {
    const id = choice.slice('custom:'.length);
    const custom = loadSfxDesigns().find((s) => s.id === id)?.design;
    if (custom) return applyTier(custom, name);
  }
  return applyTier(PRESET_SFX[name], name);
}

/**
 * 同じ瞬間に立った契機の集合を「鳴らす順」に整える（純関数）。
 * - 優先度順（SFX_TRIGGERS の並び）に直列化する。同時に重ねない
 * - 告知・確定（tier 5）があれば予告（tier 3〜4）は鳴らさない（告知が予告を上書きする）
 * - ファンファーレがあれば払い出し音は鳴らさない（ファンファーレ → BGM サビへ直結させる）
 * - 同じ契機の重複は 1 回にまとめる
 */
export function planSfxBatch(names: readonly SfxName[]): SfxName[] {
  const unique = [...new Set(names)];
  const hasAnnounce = unique.some((n) => sfxTrigger(n).tier === 5);
  const hasFanfare = unique.includes('fanfare');
  return unique
    .filter((n) => {
      if (hasAnnounce && n.startsWith('yokoku')) return false;
      if (hasFanfare && n.startsWith('payout')) return false;
      return true;
    })
    .sort((a, b) => SFX_TRIGGERS.findIndex((t) => t.name === a) - SFX_TRIGGERS.findIndex((t) => t.name === b));
}
