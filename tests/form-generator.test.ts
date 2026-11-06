import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { diagnosePiece, validatePiece } from '../src/core/music/diagnostics.js';
import { RHYTHM_FAMILY_COUNT, sectionStartBars, totalBars, validateForm } from '../src/core/music/form.js';
import { generateForm } from '../src/core/music/form-generator.js';
import { effectiveGroove } from '../src/core/music/grid.js';
import {
  STYLES, allowedGroupings, closingEndingFor, harmonicFunctionForToken, progressionsForTonality,
} from '../src/core/music/theory.js';
import type { StyleDef } from '../src/core/music/theory.js';
import type { ComposeOptions, SectionSpec, SongFormSpec, Tonality } from '../src/core/music/types.js';

/**
 * 曲型生成器(form-generator.ts)の規約を固定する。
 * - 生成結果は常に validateForm を通り(error 0・主題は 4 種以内で warning 0)、同じ入力なら同じ出力。
 * - 旋回の文法: 提示(力 2)→展開(力 3)→サビ(力 4)の階段。頂点(力 5)は 1 つの連なりで、全体最小 1 は
 *   落ちサビ(サビ主題)だけで頂点の直前。終幕は単調減少で低く着地。2 区間以下はループ、3 区間以上は
 *   様式の曲型ファセットの終わり方。
 * - 転調する終幕(リフト)以降は転調した調に留まり、literal のまま(エンジンが持ち上げる)。
 * - 拍の割り方は様式の曲型ファセットが許す範囲で、主題ごとに一定。
 * - 受理: 12/8 の主題 A・S と 6/4 の主題 B、頂点前のロングトーンの落ちサビとパワーコードの助走、
 *   リタルダンドで閉じる 100 小節前後の歌ものと同じ構造クラスを、特定の区間列を期待値にせず出せる。
 */

const defaultsFor = (tonality: Tonality, keyRoot = 0) => ({
  tonality,
  progressionId: progressionsForTonality(tonality)[0]!.id,
  keyRoot,
});

const generate = (style: StyleDef, seed: number, targetBars: number, tonality: Tonality = 'major'): SongFormSpec =>
  generateForm({ style, seed, targetBars, defaults: defaultsFor(tonality) });

const TARGETS = [4, 8, 16, 24, 32, 40, 48, 64, 96, 100, 128, 160] as const;
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

  it('全様式・全長で validateForm を通り、主題は 4 種(リズム族 5 本に 1 本の余り)、総小節は目標に合う', () => {
    for (const style of STYLES) {
      for (const tonality of ['major', 'minor'] as const) {
        for (const targetBars of TARGETS) {
          for (const seed of SEEDS) {
            const label = `${style.id}/${tonality}/${targetBars}/${seed}`;
            const form = generate(style, seed, targetBars, tonality);
            expect(validateForm(form, defaultsFor(tonality)), label).toEqual([]);
            expect(new Set(form.sections.map((section) => section.theme)).size, label)
              .toBeLessThanOrEqual(RHYTHM_FAMILY_COUNT - 1);
            // 8 小節の倍数(3 単位以上)は半単位の余りを助走で吸収してちょうどに合わせる。
            if (targetBars % 8 === 0 && targetBars >= 24) expect(totalBars(form), label).toBe(targetBars);
            else expect(Math.abs(totalBars(form) - targetBars), label).toBeLessThanOrEqual(4);
          }
        }
      }
    }
  });

  it('旋回の文法: 提示 2 → 展開 3 → サビ 4 の階段、頂点は 1 つの連なり、全体最小は頂点直前の落ちサビ、終幕は下降', () => {
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
          expect(form.ending, label).toBe(closingEndingFor(style.form));
          expect(peakRuns(sections), label).toBe(1);
          sections.forEach((section, index) => {
            if (section.theme === 'A') expect(section.energy, label).toBe(2);
            if (section.role === 'development' && (section.texture ?? 'normal') === 'normal') {
              // 展開(プリコーラス)はサビへ直結する。
              expect(section.energy, label).toBe(3);
              expect(sections[index + 1]?.theme, label).toBe('S');
              expect(sections[index + 1]!.energy, label).toBeGreaterThanOrEqual(4);
            }
          });
          // 全体最小 1 は落ちサビ(サビ主題)だけで、助走を挟むか直接、頂点の連なりへつながる。
          const troughs = sections.filter((section) => section.energy === 1);
          expect(troughs.length, label).toBeLessThanOrEqual(1);
          for (const trough of troughs) {
            expect(trough.theme, label).toBe('S');
            const index = sections.indexOf(trough);
            const next = sections[index + 1]!;
            if (next.texture === 'pulse') expect(sections[index + 2]!.energy, label).toBe(5);
            else expect(next.energy, label).toBe(5);
          }
          const finale = sections.filter((section) => section.role === 'finale').map((section) => section.energy);
          finale.forEach((energy, index) => {
            if (index > 0) expect(energy, label).toBeLessThanOrEqual(finale[index - 1]!);
          });
          if (finale.length > 0 && sections.length >= 4) expect(finale.at(-1)!, label).toBeLessThanOrEqual(2);
          // テクスチャ: ロングトーンの落ちサビは助走(パワーコード)の直前、助走は頂点の連なりの直前。
          const sustainIndex = sections.findIndex((section) => section.texture === 'sustain');
          const pulseIndex = sections.findIndex((section) => section.texture === 'pulse');
          if (sustainIndex >= 0) {
            expect(pulseIndex, label).toBe(sustainIndex + 1);
            expect(sections[sustainIndex]!.energy, label).toBe(1);
          }
          if (pulseIndex >= 0) {
            expect(sections[pulseIndex + 1]?.energy, label).toBe(5);
            expect(sections[pulseIndex]!.theme, label).toBe('S');
          }
        }
      }
    }
  });

  it('転調する終幕(リフト)以降は転調した調に留まり、literal のまま持ち上げる(アウトロが元の調へ落ちない)', () => {
    let lifted = 0;
    for (const style of STYLES) {
      for (const seed of SEEDS.slice(0, 8)) {
        const form = generate(style, seed, 96);
        const liftIndex = form.sections.findIndex((section) => section.keyRoot !== undefined);
        if (liftIndex < 0) continue;
        lifted += 1;
        const liftKey = form.sections[liftIndex]!.keyRoot;
        expect(form.sections[liftIndex]!.role).toBe('finale');
        expect(form.sections[liftIndex]!.theme).toBe('S');
        expect(form.sections[liftIndex - 1]!.energy).toBe(5);
        for (const section of form.sections.slice(liftIndex)) {
          expect(section.keyRoot).toBe(liftKey);
          expect(section.transform).toBeUndefined();
        }
      }
    }
    expect(lifted).toBeGreaterThan(0);
  });

  it('拍の割り方は様式の曲型ファセットの範囲で、主題ごとに一定。切り替えない seed もある', () => {
    for (const style of STYLES) {
      const allowed = allowedGroupings(style.form);
      let switched = 0;
      for (const seed of SEEDS.slice(0, 16)) {
        const form = generate(style, seed, 100);
        const byTheme = new Map<string, Set<string>>();
        for (const section of form.sections) {
          const grouping = section.grouping ?? '4x2';
          expect(allowed, `${style.id}/${seed}/${section.id}`).toContain(grouping);
          byTheme.set(section.theme, (byTheme.get(section.theme) ?? new Set()).add(grouping));
        }
        for (const [theme, groupings] of byTheme) expect(groupings.size, `${style.id}/${seed}/${theme}`).toBe(1);
        if (new Set(form.sections.map((section) => section.grouping ?? '4x2')).size > 1) switched += 1;
      }
      if (allowed.length > 1) {
        expect(switched, style.id).toBeGreaterThan(0);
        expect(switched, style.id).toBeLessThan(16);
      } else expect(switched, style.id).toBe(0);
    }
  });

  it('曲型ファセット: 4x2 以外を宣言する様式はスウィングを既定に持たない(×3 の格子では無効になる)', () => {
    for (const style of STYLES) {
      for (const grouping of allowedGroupings(style.form)) {
        if (grouping === '4x2') continue;
        expect(effectiveGroove(style.defaults.groove ?? 'straight', grouping), `${style.id}/${grouping}`)
          .toBe(style.defaults.groove ?? 'straight');
      }
    }
  });

  it('受理: 12/8 の A・S と 6/4 の B、頂点前のロングトーンの落ちサビと助走、rit. で閉じる 100 小節前後の歌ものを出せる', () => {
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
    // 助走の末尾は主要ドミナントで頂点へ引っ張る(harmony-plan が区間の進行のレシピから寄せる)。
    const pulseIndex = form.sections.findIndex((section) => section.texture === 'pulse');
    const starts = sectionStartBars(form);
    const lastApproachBar = starts[pulseIndex]! + form.sections[pulseIndex]!.bars - 1;
    expect(harmonicFunctionForToken(piece.songPlan.harmony[lastApproachBar]!.tokens.at(-1)!)).toBe('dominant');
  });
});
