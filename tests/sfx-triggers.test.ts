import { describe, expect, it } from 'vitest';
import { buildSfxEvents, SFX_RECIPES, transposeDesign } from '../src/core/sfx/sfx-design.js';
import type { SfxDesign, ToneEvent } from '../src/core/sfx/sfx-design.js';
import type { SfxName } from '../src/ui/sfx-names.js';
import {
  applyTier,
  planSfxBatch,
  PRESET_SFX,
  SFX_TRIGGERS,
  sfxTrigger,
  TIER_LEVEL,
} from '../src/ui/sfx-library.js';

/**
 * 契機表（強度段階・間・優先度）の検証。パチスロ効果音の設計原則:
 * - 強さは信頼度に比例し、頻度に反比例する（操作 < 獲得 < 予告 < 告知）
 * - 告知の直前に間（無音）を置く
 * - 同時発火は優先度順に直列化し、告知があれば予告は鳴らさない
 * - 効果音は BGM のキーに合わせる（外す記号は除く）
 * - 賭け枚数以下の払い出しを祝福しない
 */

const tones = (d: SfxDesign): ToneEvent[] =>
  buildSfxEvents(d).filter((e): e is ToneEvent => e.kind === 'tone');

const tierOf = (name: SfxName) => sfxTrigger(name).tier;

describe('強度段階（int トークン）', () => {
  it('全契機にプリセットと段階があり、段階 → 出力係数は単調増加で最大が 1', () => {
    for (const t of SFX_TRIGGERS) {
      expect(PRESET_SFX[t.name], t.name).toBeDefined();
      expect(SFX_RECIPES.some((r) => r.id === PRESET_SFX[t.name].recipeId), t.name).toBe(true);
    }
    expect(TIER_LEVEL[1]).toBeLessThan(TIER_LEVEL[2]);
    expect(TIER_LEVEL[2]).toBeLessThan(TIER_LEVEL[3]);
    expect(TIER_LEVEL[3]).toBeLessThan(TIER_LEVEL[4]);
    expect(TIER_LEVEL[4]).toBeLessThan(TIER_LEVEL[5]);
    expect(TIER_LEVEL[5]).toBe(1); // 最大音量を上げる方向ではなく、基準を下げる方向で差を作る
  });

  it('基本操作音 < 払い出し < 予告 < 告知 の相対段階になっている', () => {
    const ops: SfxName[] = ['bet', 'lever', 'betLever', 'reelStop', 'wait', 'error', 'replay'];
    for (const op of ops) expect(tierOf(op), op).toBe(1);
    expect(tierOf('payoutLow')).toBe(1); // 賭け枚数以下は操作音並み（祝福しない）
    expect(tierOf('payout')).toBe(2);
    expect(tierOf('payoutBonus')).toBe(2);
    expect(tierOf('yokokuWeak')).toBeGreaterThanOrEqual(2);
    expect(tierOf('yokokuWeak')).toBeLessThan(tierOf('yokokuMid'));
    expect(tierOf('yokokuMid')).toBeLessThan(tierOf('yokokuStrong'));
    expect(tierOf('yokokuStrong')).toBeLessThan(tierOf('kyuin'));
    for (const ann of ['kyuin', 'fanfare', 'siren', 'rush'] as const) expect(tierOf(ann), ann).toBe(5);
  });

  it('applyTier は契機の段階を出力係数に焼き込む（自作音を割り当てても段階は契機のもの）', () => {
    const custom: SfxDesign = { recipeId: 'kakutei', rootMidi: 72, speed: 1, voice: 7 }; // 派手なレシピ
    expect(applyTier(custom, 'lever').level).toBeCloseTo(TIER_LEVEL[1], 6);
    expect(applyTier(custom, 'fanfare').level).toBeCloseTo(TIER_LEVEL[5], 6);
    // design.level は段階の中での微調整として掛け合わさる
    expect(applyTier({ ...custom, level: 0.5 }, 'payout').level).toBeCloseTo(TIER_LEVEL[2] * 0.5, 6);
  });
});

describe('間（告知直前の無音）', () => {
  it('告知・確定（int-5）だけが直前の無音を持ち、操作音は持たない', () => {
    for (const t of SFX_TRIGGERS) {
      if (t.tier === 5) expect(t.preGapSec ?? 0, t.name).toBeGreaterThan(0);
      else expect(t.preGapSec ?? 0, t.name).toBe(0);
    }
    // キュインは「目で察知する前に音で感じる」ための最長の間
    expect(sfxTrigger('kyuin').preGapSec!).toBeGreaterThanOrEqual(sfxTrigger('fanfare').preGapSec!);
  });
});

describe('同時発火の直列化（planSfxBatch）', () => {
  it('優先度順（告知 > 予告 > 獲得 > 操作）に並び、重複は 1 回にまとまる', () => {
    expect(planSfxBatch(['payout', 'kyuin', 'kyuin', 'lever'])).toEqual(['kyuin', 'payout', 'lever']);
    expect(planSfxBatch(['navLeft', 'lever'])).toEqual(['lever', 'navLeft']); // 操作音 → ナビ
  });

  it('告知があれば予告は鳴らさない（告知が予告を上書きする）', () => {
    expect(planSfxBatch(['yokokuStrong', 'kyuin', 'yokokuWeak'])).toEqual(['kyuin']);
    expect(planSfxBatch(['yokokuStrong', 'yokokuWeak'])).toEqual(['yokokuStrong', 'yokokuWeak']);
  });

  it('ファンファーレがあれば払い出し音は鳴らさない（BGM サビへ直結させる）', () => {
    expect(planSfxBatch(['payoutBonus', 'fanfare'])).toEqual(['fanfare']);
    expect(planSfxBatch(['payout', 'siren'])).toEqual(['siren', 'payout']); // サイレンは払い出しを消さない
  });

  it('空集合は空', () => {
    expect(planSfxBatch([])).toEqual([]);
  });
});

describe('BGM キーへの追従（transposeDesign）', () => {
  it('調の中で意味を持つレシピは最寄り方向へ平行移動し、外す記号（サイレン・キュイン・警告）は動かない', () => {
    expect(transposeDesign(PRESET_SFX.lever, 0).rootMidi).toBe(72);
    expect(transposeDesign(PRESET_SFX.lever, 2).rootMidi).toBe(74); // D
    expect(transposeDesign(PRESET_SFX.lever, 9).rootMidi).toBe(69); // A は下へ（音域を保つ）
    expect(transposeDesign(PRESET_SFX.lever, 12).rootMidi).toBe(72); // オクターブは同じ調
    for (const name of ['siren', 'kyuin', 'yokokuStrong'] as const) {
      expect(transposeDesign(PRESET_SFX[name], 5), name).toEqual(PRESET_SFX[name]);
    }
  });

  it('移動後もプリセットの操作音は新しいキーのコードトーンに乗る', () => {
    const d = transposeDesign(PRESET_SFX.lever, 7); // G
    const pcs = tones(d).map((t) => ((t.midi % 12) + 12) % 12);
    for (const pc of pcs) expect([7, 11, 2]).toContain(pc); // ソ・シ・レ
  });
});

describe('帯域と状態別の払い出し', () => {
  it('告知・確定・サイレンは低域補強（キック）を持ち、操作音は持たない', () => {
    const hasKick = (d: SfxDesign) => buildSfxEvents(d).some((e) => e.kind === 'noise' && e.freq < 500);
    expect(hasKick(PRESET_SFX.fanfare)).toBe(true);
    expect(hasKick(PRESET_SFX.kyuin)).toBe(true);
    expect(hasKick(PRESET_SFX.siren)).toBe(true);
    expect(hasKick(PRESET_SFX.lever)).toBe(false);
    expect(hasKick(PRESET_SFX.replay)).toBe(false);
  });

  it('賭け枚数以下の払い出し音は短い確認音で、通常の払い出し音より音数が少ない', () => {
    expect(tones(PRESET_SFX.payoutLow).length).toBeLessThan(tones(PRESET_SFX.payout).length);
    expect(PRESET_SFX.payoutBonus.recipeId).toBe(PRESET_SFX.payout.recipeId); // 同系統の
    expect(PRESET_SFX.payoutBonus.voice).not.toBe(PRESET_SFX.payout.voice); // 状態別バリエーション
  });

  it('押し順ナビは左 < 中 < 右 の音程で聞き分けられ、ウエイト音は平坦な単音', () => {
    expect(PRESET_SFX.navLeft.rootMidi).toBeLessThan(PRESET_SFX.navCenter.rootMidi);
    expect(PRESET_SFX.navCenter.rootMidi).toBeLessThan(PRESET_SFX.navRight.rootMidi);
    const w = tones(PRESET_SFX.wait);
    expect(new Set(w.map((t) => t.midi)).size).toBe(1);
  });
});
