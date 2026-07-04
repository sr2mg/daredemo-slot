/**
 * レシピベースの効果音デザイナー（データ層 + 生成器）。
 * 効果音は作曲と理論体系が違う:
 * - ジングル系   = 終止形（V→I の解決）と分散和音上行
 * - 操作音系     = 音程の意味論（上行 = 肯定 / 下行 = 否定、4度・5度 = 確認）
 * - 煽り系       = わざと解決させない（半音上昇・トレモロ）
 * - 警告・告知系 = トライトーン・ピッチベンド、耳が最も敏感な 2〜4kHz 帯
 * レシピ = その理論のテンプレート。パラメータ（基準音・速さ・音色）だけを動かす。
 * 生成は純関数なので、SfxDesign を保存すれば同じ音が完全に再現できる。
 */

export interface SfxDesign {
  recipeId: string;
  /** 基準音（MIDI）。レシピはこの音を主音として展開する */
  rootMidi: number;
  /** 速さ倍率（1 = 標準。大きいほど速い = 短い） */
  speed: number;
  /** メロディ音色 */
  wave: 'square' | 'triangle' | 'sawtooth' | 'sine';
}

export interface ToneEvent {
  kind: 'tone';
  /** 秒（標準速度時） */
  t: number;
  dur: number;
  midi: number;
  /** 指定するとピッチベンド（midi → midiTo へ滑らかに移動） */
  midiTo?: number;
  gain: number;
}

export interface NoiseEvent {
  kind: 'noise';
  t: number;
  dur: number;
  /** ハイパスのカットオフ Hz */
  freq: number;
  gain: number;
}

export type SfxEvent = ToneEvent | NoiseEvent;

export interface SfxRecipe {
  id: string;
  name: string;
  /** 背景理論の一行説明（UI に表示） */
  theory: string;
  /** 推奨基準音（MIDI） */
  defaultRoot: number;
  build(root: number): SfxEvent[];
}

const tone = (t: number, dur: number, midi: number, gain = 0.5, midiTo?: number): ToneEvent => ({
  kind: 'tone',
  t,
  dur,
  midi,
  gain,
  ...(midiTo !== undefined ? { midiTo } : {}),
});

export const SFX_RECIPES: SfxRecipe[] = [
  {
    id: 'kakutei',
    name: '確定・当選',
    theory: 'V→I の完全終止 + 分散和音上行。最後の音を最高音にして長く伸ばす',
    defaultRoot: 72, // C5
    build: (root) => [
      tone(0, 0.07, root - 5), // ソ（ドミナント）
      tone(0.08, 0.07, root), // ド
      tone(0.16, 0.07, root + 4), // ミ
      tone(0.24, 0.07, root + 7), // ソ
      tone(0.32, 0.5, root + 12, 0.55), // 高いドー（トニックで着地）
    ],
  },
  {
    id: 'aori',
    name: '煽り・期待',
    theory: '半音上昇のトレモロ。トニックに解決させないことで緊張を維持する',
    defaultRoot: 76, // E5
    build: (root) => {
      const events: SfxEvent[] = [];
      for (let g = 0; g < 3; g++) {
        for (let i = 0; i < 4; i++) {
          events.push(tone(g * 0.24 + i * 0.05, 0.04, root + g, 0.4));
        }
      }
      return events;
    },
  },
  {
    id: 'confirm',
    name: '操作確認',
    theory: '完全4度の2音上行 = 世界共通の「肯定」。100ms 以内に収める',
    defaultRoot: 79, // G5
    build: (root) => [tone(0, 0.05, root, 0.4), tone(0.055, 0.07, root + 5, 0.4)],
  },
  {
    id: 'cancel',
    name: 'キャンセル・ハズレ',
    theory: '2音下行 + 音量減衰 = 「否定」。上行の裏返し',
    defaultRoot: 76, // E5
    build: (root) => [tone(0, 0.08, root, 0.45), tone(0.09, 0.18, root - 4, 0.3)],
  },
  {
    id: 'keikoku',
    name: '警告・激熱',
    theory: 'トライトーン（増4度）へのベンド + 2〜4kHz 帯。キュインの理論形',
    defaultRoot: 84, // C6（貫通力のある高域）
    build: (root) => [
      tone(0, 0.22, root, 0.45, root + 6), // 増4度へずり上げ（警告の音程）
      { kind: 'noise', t: 0, dur: 0.06, freq: 6000, gain: 0.15 },
      tone(0.25, 0.4, root + 6, 0.5, root + 12), // さらにオクターブへ（激熱のリフト）
    ],
  },
];

/** design から再生イベント列を生成（速度倍率で時間軸を縮尺） */
export function buildSfxEvents(design: SfxDesign): SfxEvent[] {
  const recipe = SFX_RECIPES.find((r) => r.id === design.recipeId);
  if (!recipe) throw new Error(`未知のレシピ: ${design.recipeId}`);
  const scale = 1 / Math.max(0.25, design.speed);
  return recipe.build(design.rootMidi).map((e) => ({ ...e, t: e.t * scale, dur: e.dur * scale }));
}

/** 効果音の全長（秒） */
export function sfxDuration(events: SfxEvent[]): number {
  return events.reduce((max, e) => Math.max(max, e.t + e.dur), 0);
}
