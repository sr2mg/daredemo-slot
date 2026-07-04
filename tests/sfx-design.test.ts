import { describe, expect, it } from 'vitest';
import { buildSfxEvents, SFX_RECIPES, sfxDuration } from '../src/core/music/sfx-design.js';
import type { SfxDesign, ToneEvent } from '../src/core/music/sfx-design.js';

const design = (recipeId: string, over: Partial<SfxDesign> = {}): SfxDesign => ({
  recipeId,
  rootMidi: SFX_RECIPES.find((r) => r.id === recipeId)!.defaultRoot,
  speed: 1,
  wave: 'square',
  ...over,
});

const tones = (d: SfxDesign): ToneEvent[] =>
  buildSfxEvents(d).filter((e): e is ToneEvent => e.kind === 'tone');

describe('効果音レシピ', () => {
  it('全レシピがイベントを生成し、時刻・長さが正の値', () => {
    for (const r of SFX_RECIPES) {
      const events = buildSfxEvents(design(r.id));
      expect(events.length, r.id).toBeGreaterThan(0);
      for (const e of events) {
        expect(e.t, r.id).toBeGreaterThanOrEqual(0);
        expect(e.dur, r.id).toBeGreaterThan(0);
        expect(e.gain, r.id).toBeGreaterThan(0);
      }
    }
  });

  it('確定レシピは理論どおり: 上行して最後の音が最高音・最長・主音のオクターブ上', () => {
    const t = tones(design('kakutei'));
    const last = t[t.length - 1]!;
    expect(last.midi).toBe(72 + 12);
    expect(Math.max(...t.map((e) => e.midi))).toBe(last.midi);
    expect(Math.max(...t.map((e) => e.dur))).toBe(last.dur);
  });

  it('操作確認レシピは完全4度の上行', () => {
    const t = tones(design('confirm'));
    expect(t).toHaveLength(2);
    expect(t[1]!.midi - t[0]!.midi).toBe(5);
  });

  it('キャンセルレシピは下行 + 減衰', () => {
    const t = tones(design('cancel'));
    expect(t[1]!.midi).toBeLessThan(t[0]!.midi);
    expect(t[1]!.gain).toBeLessThan(t[0]!.gain);
  });

  it('煽りレシピは半音ずつ上昇し、主音（解決）で終わらない', () => {
    const t = tones(design('aori'));
    const root = 76;
    const pitches = [...new Set(t.map((e) => e.midi))].sort((a, b) => a - b);
    expect(pitches).toEqual([root, root + 1, root + 2]);
    expect(t[t.length - 1]!.midi % 12).not.toBe(root % 12);
  });

  it('警告レシピはトライトーンへのピッチベンドを含む', () => {
    const t = tones(design('keikoku'));
    const bend = t.find((e) => e.midiTo !== undefined);
    expect(bend).toBeDefined();
    expect(bend!.midiTo! - bend!.midi).toBe(6); // 増4度
  });

  it('速さ倍率は全長を反比例で縮める', () => {
    const normal = sfxDuration(buildSfxEvents(design('kakutei')));
    const fast = sfxDuration(buildSfxEvents(design('kakutei', { speed: 2 })));
    expect(fast).toBeCloseTo(normal / 2, 6);
  });

  it('基準音を変えると全体が平行移動する', () => {
    const base = tones(design('confirm'));
    const up = tones(design('confirm', { rootMidi: 84 }));
    expect(up.map((e) => e.midi)).toEqual(base.map((e) => e.midi + 5));
  });

  it('未知のレシピはエラー', () => {
    expect(() => buildSfxEvents(design('nazo'))).toThrow();
  });
});
