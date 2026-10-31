import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MELODIC_LANGUAGE, idiomFor, isMelodicLanguage, MELODIC_IDIOMS, MELODIC_LANGUAGES,
} from '../src/core/music/melodic-idiom.js';
import { STYLE_TIMBRES } from '../src/audio/style-timbre.js';
import {
  MAJOR_HEXATONIC_SCALE, MAJOR_SCALE, PROGRESSIONS, progressionForTonality, STYLE_IDS, STYLES,
} from '../src/core/music/theory.js';

/**
 * 構造の規約: 語法と様式は「宣言の束」であり、生成器は名前で分岐しない。
 * 新しい語法・様式を足すときに触る場所が1箇所ずつであることをここで固定する。
 */

describe('旋律語法の戦略オブジェクト', () => {
  it('全語法が宣言を持ち、識別子は宣言表から導出される', () => {
    for (const language of MELODIC_LANGUAGES) {
      expect(MELODIC_IDIOMS[language].id).toBe(language);
      expect(idiomFor(language).label.length).toBeGreaterThan(0);
      expect(isMelodicLanguage(language)).toBe(true);
    }
    expect(isMelodicLanguage('not-a-language')).toBe(false);
    expect(isMelodicLanguage(undefined)).toBe(false);
    expect(MELODIC_LANGUAGES).toContain(DEFAULT_MELODIC_LANGUAGE);
  });

  it('強拍の着地規則: 標準・五音は和音全体、和風は共通音1音から、六音は共通音2音から絞る', () => {
    // キーC・IVM7(F A C E)。六音 {0,2,4,7,9,11} との共通音は A C E の3音、F は語法外。
    const ivM7 = [5, 9, 0, 4];
    expect(idiomFor('standard').landingPcs(ivM7, [...MAJOR_SCALE])).toEqual(ivM7);
    expect(idiomFor('pentatonic').landingPcs(ivM7, [0, 2, 4, 7, 9])).toEqual(ivM7);
    expect(idiomFor('hexatonic').landingPcs(ivM7, [...MAJOR_HEXATONIC_SCALE])).toEqual([9, 0, 4]);
    // 共通音が1音しか残らない和音(IV の三和音 F A C → 六音との共通音は A C の2音、
    // 五音 {0,2,4,7,9} に対する F A C は A C): 六音は2音なら絞り、和風は1音でも絞る。
    expect(idiomFor('hexatonic').landingPcs([5, 9, 0], [...MAJOR_HEXATONIC_SCALE])).toEqual([9, 0]);
    expect(idiomFor('hexatonic').landingPcs([5, 10, 1], [...MAJOR_HEXATONIC_SCALE])).toEqual([5, 10, 1]);
    expect(idiomFor('japanese').landingPcs([5, 10, 2], [0, 2, 5, 7, 9])).toEqual([5, 2]);
    expect(idiomFor('japanese').landingPcs([1, 6, 10], [0, 2, 5, 7, 9])).toEqual([1, 6, 10]);
  });

  it('語法の宣言は置き換え前の分岐と同じ値(互換)', () => {
    const standard = idiomFor('standard');
    const japanese = idiomFor('japanese');
    expect(standard.followsChordScale).toBe(true);
    expect(standard.scaleStepMax([...MAJOR_SCALE])).toBe(2);
    expect(standard.culturalPlan(0, 'auto', 1)).toBeNull();
    expect(japanese.followsChordScale).toBe(false);
    expect(japanese.openFifthsVoicing).toBe(true);
    expect(japanese.suppressesDevices).toBe(true);
    expect(japanese.scaleStepMax([0, 2, 5, 7, 9])).toBe(4);
    expect(japanese.motifIntroBreakBeats).toBe(1.5);
    expect(japanese.culturalPlan(0, 'ritsu', 1)?.id).toBe('ritsu');
    expect(japanese.legacyMelodyMode).toBe('japanese');
    // 五音系は隣接音級の最大間隔から導出(無半音五音=3、六音=半音を含むが最大は3)。
    expect(idiomFor('pentatonic').scaleStepMax([0, 2, 4, 7, 9])).toBe(3);
    expect(idiomFor('hexatonic').scaleStepMax([...MAJOR_HEXATONIC_SCALE])).toBe(3);
  });
});

describe('様式のファセット合成', () => {
  it('打楽器ファセットは判別共用体で、kit だけが譜を持つ', () => {
    for (const style of STYLES) {
      if (style.percussion.kind === 'kit') {
        expect(style.percussion.kick.length % 16, style.id).toBe(0);
      } else {
        expect(Object.keys(style.percussion), style.id).toEqual(['kind']);
      }
    }
  });

  it('様式の既定が宣言する語法・進行は実在し、両調性で使える', () => {
    for (const style of STYLES) {
      const language = style.defaults.melodicLanguage;
      if (language !== undefined) expect(isMelodicLanguage(language), style.id).toBe(true);
      for (const id of style.defaults.progressionIds ?? []) {
        const prog = PROGRESSIONS.find((p) => p.id === id);
        expect(prog, `${style.id}/${id}`).toBeDefined();
        expect(progressionForTonality(prog!, 'major'), `${style.id}/${id}/major`).not.toBeNull();
        expect(progressionForTonality(prog!, 'minor'), `${style.id}/${id}/minor`).not.toBeNull();
      }
    }
    const acoustic = STYLES.find((s) => s.id === 'acoustic')!;
    expect(acoustic.defaults.melodicLanguage).toBe('hexatonic');
    expect(acoustic.defaults.progressionIds).toEqual(['drifting-orbit']);
  });

  it('音色定義は1様式1レコードで全様式を覆う', () => {
    expect(Object.keys(STYLE_TIMBRES).sort()).toEqual([...STYLE_IDS].sort());
    for (const id of STYLE_IDS) {
      const timbre = STYLE_TIMBRES[id];
      expect(timbre.roomRt60Sec, id).toBeGreaterThan(0);
      expect(timbre.pcm.leadPalette.length, id).toBeGreaterThan(0);
    }
  });
});
