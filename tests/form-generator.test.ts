import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { diagnosePiece, validatePiece } from '../src/core/music/diagnostics.js';
import { RHYTHM_FAMILY_COUNT, totalBars, validateForm } from '../src/core/music/form.js';
import { generateForm } from '../src/core/music/form-generator.js';
import { effectiveGroove } from '../src/core/music/grid.js';
import { STYLES, allowedGroupings, progressionsForTonality } from '../src/core/music/theory.js';
import type { StyleDef } from '../src/core/music/theory.js';
import type { ComposeOptions, SectionSpec, SongFormSpec, Tonality } from '../src/core/music/types.js';

/**
 * 曲型生成器(form-generator.ts)の規約を固定する。
 * - 生成結果は常に validateForm を通り(error 0・主題はリズム族の本数以内で warning 0)、同じ入力なら同じ出力。
 * - 区間機能の文法: 先頭は通常テクスチャ、力 5 の区間は 1 つの連なり、頂点の直前に全体最小の谷、
 *   終幕は単調減少で低く着地、2 区間以下はループで 3 区間以上は終止。
 * - 拍の割り方は様式の拍節ファセットが許す範囲で、主題ごとに一定。
 * - 受理: 12/8 の主題 A・S と 6/4 の主題 B、頂点前のロングトーンの谷とパワーコードの助走、
 *   リタルダンドで閉じる 100 小節前後の歌ものと同じ構造クラスを、特定の区間列を期待値にせず出せる。
 */

const defaultsFor = (tonality: Tonality, keyRoot = 0) => ({
  tonality,
  progressionId: progressionsForTonality(tonality)[0]!.id,
  keyRoot,
});

const generate = (style: StyleDef, seed: number, targetBars: number, tonality: Tonality = 'major'): SongFormSpec =>
  generateForm({ style, seed, targetBars, defaults: defaultsFor(tonality) });

const TARGETS = [8, 16, 32, 48, 64, 96, 100, 128] as const;
const SEEDS = Array.from({ length: 32 }, (_, index) => index * 7919 + 1);

/** 力 5 の連なり(連続区間の塊)の数。 */
function peakRuns(sections: readonly SectionSpec[]): number {
  let runs = 0;
  sections.forEach((section, index) => {
    if (section.energy === 5 && sections[index - 1]?.energy !== 5) runs += 1;
  });
  return runs;
}

describe('曲型生成器', () => {
  it('同じ入力なら同じ区間列、seed が違えば別の区間列が出る', () => {
    const acoustic = STYLES.find((style) => style.id === 'acoustic')!;
    expect(generate(acoustic, 42, 100)).toEqual(generate(acoustic, 42, 100));
    const distinct = new Set(SEEDS.map((seed) => JSON.stringify(generate(acoustic, seed, 100))));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('全様式・全長で validateForm を通り、主題はリズム族の本数以内、総小節は目標 ±4', () => {
    for (const style of STYLES) {
      for (const tonality of ['major', 'minor'] as const) {
        for (const targetBars of TARGETS) {
          for (const seed of SEEDS) {
            const label = `${style.id}/${tonality}/${targetBars}/${seed}`;
            const form = generate(style, seed, targetBars, tonality);
            expect(validateForm(form, defaultsFor(tonality)), label).toEqual([]);
            expect(new Set(form.sections.map((section) => section.theme)).size, label)
              .toBeLessThanOrEqual(RHYTHM_FAMILY_COUNT);
            expect(Math.abs(totalBars(form) - targetBars), label).toBeLessThanOrEqual(4);
          }
        }
      }
    }
  });

  it('区間機能の文法: 先頭は通常、頂点は 1 つの連なり、頂点前に全体最小の谷、終幕は下降、短い曲型はループ', () => {
    for (const style of STYLES) {
      for (const targetBars of TARGETS) {
        for (const seed of SEEDS.slice(0, 8)) {
          const label = `${style.id}/${targetBars}/${seed}`;
          const form = generate(style, seed, targetBars);
          const { sections } = form;
          expect(sections[0]!.texture ?? 'normal', label).toBe('normal');
          if (sections.length <= 2) {
            expect(form.ending, label).toBe('loop');
            continue;
          }
          expect(form.ending, label).toBe(style.percussion.kind === 'none' ? 'ritardando' : 'final');
          expect(peakRuns(sections), label).toBe(1);
          const peakIndex = sections.findIndex((section) => section.energy === 5);
          const minimum = Math.min(...sections.map((section) => section.energy));
          const troughIndex = sections.findIndex((section) => section.energy === minimum);
          // 谷(全体最小)は頂点より前。谷が無い短い弧(全体最小が終幕の着地)は除く。
          if (sections.length >= 5) expect(troughIndex, label).toBeLessThan(peakIndex);
          const finale = sections.filter((section) => section.role === 'finale').map((section) => section.energy);
          finale.forEach((energy, index) => {
            if (index > 0) expect(energy, label).toBeLessThanOrEqual(finale[index - 1]!);
          });
          if (finale.length > 0 && sections.length >= 4) expect(finale.at(-1)!, label).toBeLessThanOrEqual(2);
          // テクスチャ: ロングトーンの谷は助走(パワーコード)の直前、助走は頂点の連なりの直前。
          const sustainIndex = sections.findIndex((section) => section.texture === 'sustain');
          const pulseIndex = sections.findIndex((section) => section.texture === 'pulse');
          if (sustainIndex >= 0) {
            expect(pulseIndex, label).toBe(sustainIndex + 1);
            expect(sections[sustainIndex]!.energy, label).toBe(minimum);
          }
          if (pulseIndex >= 0) expect(sections[pulseIndex + 1]?.energy, label).toBe(5);
        }
      }
    }
  });

  it('拍の割り方は様式の拍節ファセットの範囲で、主題ごとに一定', () => {
    for (const style of STYLES) {
      const allowed = allowedGroupings(style.meter);
      for (const seed of SEEDS.slice(0, 8)) {
        const form = generate(style, seed, 100);
        const byTheme = new Map<string, Set<string>>();
        for (const section of form.sections) {
          const grouping = section.grouping ?? '4x2';
          expect(allowed, `${style.id}/${seed}/${section.id}`).toContain(grouping);
          byTheme.set(section.theme, (byTheme.get(section.theme) ?? new Set()).add(grouping));
        }
        for (const [theme, groupings] of byTheme) expect(groupings.size, `${style.id}/${seed}/${theme}`).toBe(1);
      }
    }
  });

  it('拍節ファセット: 4x2 以外を宣言する様式はスウィングを既定に持たない(×3 の格子では無効になる)', () => {
    for (const style of STYLES) {
      for (const grouping of allowedGroupings(style.meter)) {
        if (grouping === '4x2') continue;
        expect(effectiveGroove(style.defaults.groove ?? 'straight', grouping), `${style.id}/${grouping}`)
          .toBe(style.defaults.groove ?? 'straight');
      }
    }
  });

  it('受理: 12/8 の A・S と 6/4 の B、頂点前のロングトーンの谷と助走、rit. で閉じる 100 小節前後の歌ものを出せる', () => {
    const acoustic = STYLES.find((style) => style.id === 'acoustic')!;
    const defaults = { tonality: 'major' as const, progressionId: 'drifting-orbit', keyRoot: 0 };
    const matches = (form: SongFormSpec): boolean => {
      const groupingOf = (theme: string) => form.sections.find((section) => section.theme === theme)?.grouping;
      const peakIndex = form.sections.findIndex((section) => section.energy === 5);
      const sustainIndex = form.sections.findIndex((section) => section.texture === 'sustain');
      const pulseIndex = form.sections.findIndex((section) => section.texture === 'pulse');
      return groupingOf('A') === '4x3'
        && groupingOf('S') === '4x3'
        && groupingOf('B') === '3x4'
        && sustainIndex >= 0
        && pulseIndex === sustainIndex + 1
        && peakIndex === pulseIndex + 1
        && form.ending === 'ritardando'
        && Math.abs(totalBars(form) - 100) <= 8;
    };
    const seeds = Array.from({ length: 200 }, (_, index) => index);
    const seed = seeds.find((candidate) => matches(generateForm({ style: acoustic, seed: candidate, targetBars: 100, defaults })));
    expect(seed).toBeDefined();

    const form = generateForm({ style: acoustic, seed: seed!, targetBars: 100, defaults });
    const options: ComposeOptions = {
      ...defaults, styleId: 'acoustic', bpm: 112, melodicLanguage: 'hexatonic', soundChip: 'pcm', seed: seed!, form,
    };
    const piece = compose(options);
    expect(piece.bars).toBe(totalBars(form));
    expect(piece.ending).toBe('ritardando');
    expect(validatePiece(piece)).toEqual([]);
    expect(diagnosePiece(piece).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });
});
