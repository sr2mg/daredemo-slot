import { describe, expect, it } from 'vitest';
import { buildSfxEvents, sfxDuration } from '../src/core/music/sfx-design.js';
import type { SfxDesign } from '../src/core/music/sfx-design.js';
import { arrangeSfx } from '../src/ui/sfx-arrange.js';
import { ASSIGNABLE_SFX, PRESET_SFX } from '../src/ui/sfx-library.js';

/**
 * 効果音デザイン → OPLL レジスタ列の変換（sfx-arrange.ts）と、
 * 既定効果音プリセット（PRESET_SFX）の検証。
 * これが通っていれば、ゲーム内の全効果音がレシピから正しく OPLL 化できる。
 */

/**
 * ch のキーオン数。pitch() もキービット付きで 0x20 を書くため、
 * キーオン時に 1 回だけ書かれる音色|音量レジスタ（0x30+ch）で数える
 * （レガート中の音量変更でも書かれるが、gain が同じなら書かれない）
 */
const keyOnCount = (def: ReturnType<typeof arrangeSfx>, ch: number) =>
  def.events.filter((e) => e.reg === 0x30 + ch).length;

/** ch のキーオフ（キービットなしの 0x20+ch 書き込み）数 */
const keyOffCount = (def: ReturnType<typeof arrangeSfx>, ch: number) =>
  def.events.filter((e) => e.reg === 0x20 + ch && (e.val & 0x10) === 0).length;

describe('arrangeSfx（デザイン → OPLL レジスタ列）', () => {
  it('全契機のプリセットが変換でき、イベントが曲中に収まる', () => {
    for (const { name } of ASSIGNABLE_SFX) {
      const design = PRESET_SFX[name];
      const def = arrangeSfx(design);
      expect(def.events.length, name).toBeGreaterThan(0);
      expect(def.duration, name).toBeCloseTo(sfxDuration(buildSfxEvents(design)) + 0.05, 6);
      for (const e of def.events) {
        expect(e.at, name).toBeGreaterThanOrEqual(0);
        expect(e.at, name).toBeLessThanOrEqual(def.duration);
      }
    }
  });

  it('同時発音は別チャンネルに割り当てられる（ハモリビープのレシピ）', () => {
    const def = arrangeSfx({ recipeId: 'beep2', rootMidi: 76, speed: 1, voice: 10 }); // 2 音同時
    expect(keyOnCount(def, 0)).toBe(1);
    expect(keyOnCount(def, 1)).toBe(1);
  });

  it('連続するベンドはレガート結合される（サイレンはキーオン/オフ 1 回ずつ）', () => {
    const def = arrangeSfx(PRESET_SFX.siren); // 4 セグメントの連続ベンド
    expect(keyOnCount(def, 0)).toBe(1); // リトリガーなし
    expect(keyOffCount(def, 0)).toBe(1); // 途中で切れない
    // ベンドぶんのピッチ書き込みが大量にある
    expect(def.events.filter((e) => e.reg === 0x10).length).toBeGreaterThan(20);
  });

  it('音量は gain から OPLL 音量（0=最大）へ写像され、指定音色が使われる', () => {
    const def = arrangeSfx({ recipeId: 'kakutei', rootMidi: 72, speed: 1, voice: 7 });
    const inst = def.events.filter((e) => e.reg === 0x30);
    expect(inst.length).toBeGreaterThan(0);
    for (const e of inst) expect(e.val >> 4).toBe(7); // トランペット
    // 最後の音（gain 0.55）は途中の音（gain 0.5）より大きい = vol 値が小さい
    const vols = inst.map((e) => e.val & 15);
    expect(Math.min(...vols)).toBeLessThan(Math.max(...vols));
  });

  it('ノイズは周波数帯でリズム楽器に振り分けられる（高域=ハイハット / 低域=バスドラ）', () => {
    const hat = arrangeSfx({ recipeId: 'keikoku', rootMidi: 84, speed: 1, voice: 10 });
    expect(hat.events.some((e) => e.reg === 0x0e && e.val === (0x20 | 0x01))).toBe(true); // ハイハット
    const bd = arrangeSfx(PRESET_SFX.reelStop); // thud = バスドラ + クリック
    expect(bd.events.some((e) => e.reg === 0x0e && e.val === (0x20 | 0x10))).toBe(true); // バスドラ
  });

  it('プリセットのベット/レバーは C メジャーのコードトーン設計（BGM と濁らない）', () => {
    expect(PRESET_SFX.bet).toMatchObject({ recipeId: 'coinIn', rootMidi: 72 }); // ド・ミ・ソ
    expect(PRESET_SFX.lever).toMatchObject({ recipeId: 'leverStart', rootMidi: 79 }); // ソ → ド
    // MAX BET 前提: 連結もレバー音のみ。毎ゲーム鳴る音は控えめレベル
    expect(PRESET_SFX.betLever).toMatchObject({ recipeId: 'leverStart', rootMidi: 79 });
    expect(PRESET_SFX.lever.level).toBeLessThan(1);
  });
});
