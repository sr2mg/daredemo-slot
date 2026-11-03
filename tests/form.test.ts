import { describe, expect, it } from 'vitest';
import {
  FORM_PRESET_IDS,
  barInSection,
  formErrorMessage,
  formPresetIdOf,
  introDefaultFor,
  phraseFunctionFor,
  resolveForm,
  sectionIndexAt,
  sectionRng,
  sectionStartBars,
  totalBars,
  validateForm,
} from '../src/core/music/form.js';
import type { SectionSpec, SongFormSpec } from '../src/core/music/types.js';

/**
 * 曲型(form.ts)の規約を固定する:
 * - プリセットはシード非依存に同じ区間列へ展開され、従来の 4/8/16/40 小節と同じ骨格を持つ
 * - 小節→区間の検索は form.ts だけが持つ
 * - 検証は主題・引用・進行の整合を区間ごとに指摘する
 */

const defaults = { tonality: 'major', progressionId: 'royal-pop' } as const;

const spec = (sections: SectionSpec[], ending: SongFormSpec['ending'] = 'loop'): SongFormSpec => ({ sections, ending });

describe('曲型プリセット', () => {
  it('従来の 4/8/16/40 小節と同じ骨格へ展開される', () => {
    expect(totalBars(resolveForm('loop4'))).toBe(4);
    expect(totalBars(resolveForm('loop8'))).toBe(8);
    expect(totalBars(resolveForm('loop16'))).toBe(16);
    expect(totalBars(resolveForm('arc40'))).toBe(40);
    expect(resolveForm('arc40').sections.map((item) => item.role))
      .toEqual(['hook', 'development', 'relief', 'return', 'finale']);
    expect(resolveForm('arc40').sections.map((item) => item.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(resolveForm('loop16').sections[1]!.quote).toEqual({ from: 'A', phrases: [3], transform: 'literal' });
  });

  it('歌ものプリセットは 96 小節・終止で閉じ、主題が5つに収まる', () => {
    const song = resolveForm('song');
    expect(totalBars(song)).toBe(96);
    expect(song.ending).toBe('final');
    expect(new Set(song.sections.map((item) => item.theme)).size).toBe(5);
    expect(validateForm(song, defaults)).toEqual([]);
    expect(validateForm(song, { tonality: 'minor', progressionId: 'minor-drive' })).toEqual([]);
  });

  it('全プリセットが両調性で検証を通り、参照は同じ展開結果を返す', () => {
    for (const id of FORM_PRESET_IDS) {
      expect(resolveForm(id)).toBe(resolveForm(id));
      expect(formPresetIdOf(id)).toBe(id);
      expect(validateForm(resolveForm(id), defaults), id).toEqual([]);
      expect(validateForm(resolveForm(id), { tonality: 'minor', progressionId: 'minor-pedal' }), id).toEqual([]);
    }
    expect(formPresetIdOf(resolveForm('arc40'))).toBeNull();
    expect(introDefaultFor('loop4')).toBe(false);
    expect(introDefaultFor('loop8')).toBe(false);
    expect(introDefaultFor('loop16')).toBe(true);
    expect(introDefaultFor(resolveForm('song'))).toBe(true);
  });
});

describe('区間の検索', () => {
  const form = spec([
    { id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A' },
    { id: 'X', role: 'relief', bars: 4, energy: 2, theme: 'X' },
    { id: 'B', role: 'finale', bars: 8, energy: 5, theme: 'B' },
  ]);

  it('小節から区間と区間内オフセットを引ける', () => {
    expect(sectionStartBars(form)).toEqual([0, 8, 12]);
    expect([0, 7, 8, 11, 12, 19].map((bar) => sectionIndexAt(form, bar))).toEqual([0, 0, 1, 1, 2, 2]);
    expect(sectionIndexAt(form, 99)).toBe(2);
    expect(barInSection(form, 11)).toBe(3);
    expect(barInSection(form, 13)).toBe(1);
  });

  it('SRDC は 4小節区間で1小節ずつ、8小節区間で2小節ずつ', () => {
    expect([0, 1, 2, 3].map((bar) => phraseFunctionFor(bar, 4)))
      .toEqual(['statement', 'restatement', 'departure', 'conclusion']);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((bar) => phraseFunctionFor(bar, 8))).toEqual([
      'statement', 'statement', 'restatement', 'restatement',
      'departure', 'departure', 'conclusion', 'conclusion',
    ]);
  });

  it('区間ごとの乱数は用途と区間で独立し、同じ引数で再現する', () => {
    const a = sectionRng(42, 0, 0x1234).nextInt(1000);
    expect(sectionRng(42, 0, 0x1234).nextInt(1000)).toBe(a);
    const streams = new Set(Array.from({ length: 24 }, (_, index) => sectionRng(42, index, 0x1234).nextInt(1 << 30)));
    expect(streams.size).toBe(24);
    expect(sectionRng(42, 0, 0x1234).nextInt(1 << 30)).not.toBe(sectionRng(42, 0, 0x5678).nextInt(1 << 30));
  });
});

describe('曲型の検証', () => {
  const ok: SectionSpec = { id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A' };

  it('id の重複・intro・空を区間付きで指摘する', () => {
    const messages = validateForm(spec([ok, { ...ok, id: 'A' }, { ...ok, id: 'intro' }, { ...ok, id: '' }]), defaults)
      .map((issue) => `${issue.section}:${issue.message}`);
    expect(messages.some((message) => message.startsWith('A:') && message.includes('重複'))).toBe(true);
    expect(messages.some((message) => message.includes('intro'))).toBe(true);
    expect(messages.some((message) => message.includes('id がない'))).toBe(true);
  });

  it('主題の再登場と引用は同じ長さの先行区間にだけ成立する', () => {
    const shortReturn = validateForm(spec([ok, { ...ok, id: 'A2', bars: 4 }]), defaults);
    expect(shortReturn.map((issue) => issue.message).join()).toContain('小節数が違う');
    const quoteAhead = validateForm(spec([
      { ...ok, quote: { from: 'B', phrases: [3] } },
      { ...ok, id: 'B', theme: 'B' },
    ]), defaults);
    expect(quoteAhead.map((issue) => issue.message).join()).toContain('先行区間にない');
    const quoteAndReturn = validateForm(spec([
      ok,
      { ...ok, id: 'B', theme: 'B' },
      { ...ok, id: 'A2', quote: { from: 'B', phrases: [0] } },
    ]), defaults);
    expect(quoteAndReturn.map((issue) => issue.message).join()).toContain('併用できない');
    const shortQuote = validateForm(spec([
      { ...ok, bars: 4 },
      { ...ok, id: 'B', bars: 4, theme: 'B', quote: { from: 'A', phrases: [1] } },
    ]), defaults);
    expect(shortQuote.map((issue) => issue.message).join()).toContain('問い側');
  });

  it('区間の進行は区間の調性で実現できる長さのものに限る', () => {
    const canonIn4 = validateForm(spec([{ ...ok, bars: 4, progressionId: 'canon' }]), defaults);
    expect(canonIn4.map((issue) => issue.message).join()).toContain('より長い');
    const minorOnly = validateForm(spec([{ ...ok, progressionId: 'minor-drive' }]), defaults);
    expect(minorOnly.map((issue) => issue.message).join()).toContain('長調では');
    expect(validateForm(spec([{ ...ok, progressionId: 'minor-drive', tonality: 'minor' }]), defaults)).toEqual([]);
    expect(validateForm(spec([{ ...ok, progressionId: 'nope' }]), defaults).map((issue) => issue.message).join())
      .toContain('未知の進行');
  });

  it('主題が6種を超えると警告、エラーは1文にまとまる', () => {
    const many = spec(Array.from({ length: 6 }, (_, index) => ({ ...ok, id: `S${index}`, theme: `T${index}` })));
    const issues = validateForm(many, defaults);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('warning');
    expect(formErrorMessage(issues)).toBeNull();
    expect(formErrorMessage(validateForm(spec([]), defaults))).toBe('区間が1つもない');
    expect(formErrorMessage(validateForm(spec([{ ...ok, energy: 9 as 5 }]), defaults))).toContain('[A] エネルギー');
  });
});
