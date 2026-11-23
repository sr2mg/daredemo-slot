import { describe, expect, it } from 'vitest';
import { renderNesPiece } from '../src/audio/nes-apu.js';
import { arrangePiece } from '../src/audio/opll-arrange.js';
import { bgmCacheKey } from '../src/audio/render.js';
import { STAGE_ROLES } from '../src/audio/stage.js';
import { compose } from '../src/core/music/compose.js';
import { resolveForm } from '../src/core/music/form.js';
import { normalizeComposeOptions } from '../src/core/music/options.js';
import { diffPieceSections } from '../src/core/music/piece-diff.js';
import type { ComposeOptions } from '../src/core/music/types.js';
import { PRESET_SONGS } from '../src/ui/bgm-library.js';
import { formFromOptions, optionsOfForm } from '../src/ui/composer-form.js';
import {
  BAR_BEATS, blockAtBeat, effectiveMuted, formatBarBeat, nesChannelLanes, opllChannelLanes, scoreLanes,
  sectionBlocks, themeMemberIds, themeOriginId,
} from '../src/ui/composer/piece-view.js';

const SONG: ComposeOptions = {
  progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, form: 'song', seed: 12345,
};

/** 2 曲の間で音が違う区間 → 違うパートの一覧。 */
const differing = (a: ComposeOptions, b: ComposeOptions): Record<string, string[]> => Object.fromEntries(
  diffPieceSections([compose(a), compose(b)])
    .filter((section) => section.differingParts.length > 0)
    .map((section) => [section.section, [...section.differingParts]]),
);

describe('区間単位の作り直し(sectionSeeds)', () => {
  it('指定が無い・空の指定は曲を変えない', () => {
    expect(differing(SONG, { ...SONG, sectionSeeds: {} })).toEqual({});
  });

  it('主題の初出区間を引き直すと、その主題の区間の旋律だけが変わる', () => {
    // 歌もの: B と、B を移調して再登場する B' だけが変わる。他の主題の区間は不変。
    expect(differing(SONG, { ...SONG, sectionSeeds: { B: 999 } })).toEqual({ B: ['melody'], "B'": ['melody'] });
  });

  it('和声とドラムはどの区間を引き直しても変わらない', () => {
    for (const section of resolveForm('song').sections) {
      const parts = Object.values(differing(SONG, { ...SONG, sectionSeeds: { [section.id]: 4242 } })).flat();
      expect(parts, section.id).not.toContain('chords');
      expect(parts, section.id).not.toContain('drums');
    }
  });

  it('同じ指定は同じ曲を再現し、別のシードは別の旋律になる', () => {
    const once = { ...SONG, sectionSeeds: { A: 7 } };
    expect(differing(once, { ...SONG, sectionSeeds: { A: 7 } })).toEqual({});
    expect(Object.keys(differing(once, { ...SONG, sectionSeeds: { A: 8 } }))).toContain('A');
  });
});

describe('保存形式(ComposeOptions)への反映', () => {
  const form = formFromOptions(SONG);

  it('区間シードと局所修正は、あるときだけ JSON へ入る(無い曲のキャッシュキーは従来と同一)', () => {
    const plain = optionsOfForm(form);
    expect(plain).not.toHaveProperty('sectionSeeds');
    expect(plain).not.toHaveProperty('melodyEdits');
    const edited = optionsOfForm({
      ...form, sectionSeeds: { B: 5 }, melodyEdits: [{ beat: 8, fromMidi: 72, toMidi: 74 }],
    });
    expect(edited.sectionSeeds).toEqual({ B: 5 });
    expect(edited.melodyEdits).toEqual([{ beat: 8, fromMidi: 72, toMidi: 74 }]);
    const { sectionSeeds: _seeds, melodyEdits: _edits, ...rest } = edited;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(plain));
  });

  it('別のシード・曲型の案(ブラインド比較)には、この曲の区間シードを持ち込まない', () => {
    const derived = optionsOfForm({ ...form, sectionSeeds: { B: 5 } }, undefined, { seed: 1 });
    expect(derived).not.toHaveProperty('sectionSeeds');
  });

  it('normalizeComposeOptions は空の指定を省く', () => {
    const draft = {
      progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, form: 'loop8' as const, seed: 1,
      choice: [], soundChip: 'opll' as const, intro: false, tonality: 'major' as const,
      melodicLanguage: form.melodicLanguage, japaneseScale: 'auto' as const, grooveFeel: form.grooveFeel,
      tupletOverlay: 'auto' as const, tensionPolicy: 'auto' as const, diminution: 'auto' as const,
      duet: 'auto' as const, glide: 'auto' as const, bassLine: 'auto' as const, voices: {},
      opllUserPatch: 'brightLead' as const, nes: {},
    };
    expect(normalizeComposeOptions({ ...draft, sectionSeeds: {}, melodyEdits: [] }))
      .toEqual(normalizeComposeOptions(draft));
  });

  it('プリセット曲を編集フォームへ読み込んでも、音は変わらない', () => {
    for (const song of PRESET_SONGS) {
      expect(differing(song.options, optionsOfForm(formFromOptions(song.options))), song.name).toEqual({});
    }
  });
});

describe('ミュート / ソロ(試聴用のミックス)', () => {
  const options: ComposeOptions = { ...SONG, form: 'loop16', seed: 2024 };
  const piece = compose(options);

  it('キャッシュキーはミュート無しなら従来どおり、あれば順序に依らない接尾辞が付く', () => {
    expect(bgmCacheKey(options)).toBe(JSON.stringify(options));
    expect(bgmCacheKey(options, null, { muted: [] })).toBe(JSON.stringify(options));
    expect(bgmCacheKey(options, null, { muted: ['drums', 'bass'] }))
      .toBe(bgmCacheKey(options, null, { muted: ['bass', 'drums'] }));
    expect(bgmCacheKey(options, null, { muted: ['bass'] })).not.toBe(bgmCacheKey(options));
  });

  it('OPLL: ミュートは割り当てを変えず、発音だけを落とす', () => {
    const full = arrangePiece(piece, options.styleId);
    const withoutLead = arrangePiece(piece, options.styleId, undefined, undefined, { muted: ['lead'] });
    expect(withoutLead.channelNotes).toEqual(full.channelNotes);
    expect(withoutLead.voiceStats).toEqual(full.voiceStats);
    expect(withoutLead.events.length).toBeLessThan(full.events.length);
    const silent = arrangePiece(piece, options.styleId, undefined, undefined, { muted: [...STAGE_ROLES] });
    expect(silent.events.length).toBeLessThan(withoutLead.events.length);
  });

  it('OPLL: チャンネル表示の音数は割り当ての統計と一致する', () => {
    const { channelNotes, voiceStats } = arrangePiece(piece, options.styleId);
    expect(channelNotes.filter((note) => note.ch !== null)).toHaveLength(voiceStats.assigned);
    expect(channelNotes.filter((note) => note.ch === null)).toHaveLength(voiceStats.dropped);
    expect(channelNotes.every((note) => note.ch === null || (note.ch >= 0 && note.ch <= 5))).toBe(true);
  });

  it('2A03: 全役割をミュートすると無音になる', () => {
    const short = compose({ ...SONG, form: 'loop4', soundChip: 'nes2a03' });
    const wave = renderNesPiece(short, {}, { muted: [...STAGE_ROLES] });
    expect(wave.every((sample) => Math.abs(sample) < 1e-6)).toBe(true);
    expect(renderNesPiece(short, {}).some((sample) => Math.abs(sample) > 1e-3)).toBe(true);
  });

  it('ソロ中はソロ以外すべてを落とし、ミュートは役割の順で返す', () => {
    expect(effectiveMuted(['drums', 'bass'], null)).toEqual(['bass', 'drums']);
    expect(effectiveMuted(['drums'], 'lead')).toEqual(STAGE_ROLES.filter((role) => role !== 'lead'));
    expect(effectiveMuted([], null)).toEqual([]);
  });
});

describe('タイムラインの表示モデル', () => {
  const piece = compose(SONG);
  const blocks = sectionBlocks(piece);

  it('区間ブロックはイントロから曲の終わりまでを隙間なく覆う', () => {
    expect(blocks[0]!.isIntro).toBe(true);
    expect(blocks[0]!.startBeat).toBe(0);
    for (let index = 1; index < blocks.length; index++) {
      expect(blocks[index]!.startBeat).toBe(blocks[index - 1]!.endBeat);
    }
    expect(blocks.at(-1)!.endBeat).toBe(piece.beats);
    expect(blocks.filter((block) => !block.isIntro).map((block) => block.id))
      .toEqual(resolveForm('song').sections.map((section) => section.id));
    expect(blocks.every((block) => block.endBeat - block.startBeat === block.bars * BAR_BEATS)).toBe(true);
  });

  it('拍からブロックを引ける(曲の外は null)', () => {
    expect(blockAtBeat(blocks, 0)?.id).toBe('intro');
    expect(blockAtBeat(blocks, piece.loopStartBeat)?.id).toBe('A');
    expect(blockAtBeat(blocks, piece.beats)).toBeNull();
  });

  it('イントロなしの短いループは区間だけ', () => {
    const loop = sectionBlocks(compose({ ...SONG, form: 'loop4' }));
    expect(loop.map((block) => block.id)).toEqual(['A']);
  });

  it('主題の初出と、同じ主題の区間を引ける', () => {
    const form = resolveForm('song');
    expect(themeOriginId(form, "A''")).toBe('A');
    expect(themeOriginId(form, 'B')).toBe('B');
    expect(themeMemberIds(form, "B'")).toEqual(['B', "B'"]);
    expect(themeOriginId(form, '存在しない')).toBe('存在しない');
  });

  it('譜面レーンは音のある役割だけを、役割の順で出す', () => {
    const lanes = scoreLanes(piece);
    const roles = lanes.map((lane) => lane.role);
    expect(roles).toEqual(STAGE_ROLES.filter((role) => roles.includes(role)));
    expect(roles).toEqual(expect.arrayContaining(['lead', 'backing', 'bass', 'drums']));
    for (const lane of lanes) {
      expect(lane.notes.length).toBeGreaterThan(0);
      expect(lane.notes.every((note) => note.row >= lane.lo && note.row <= lane.hi)).toBe(true);
    }
    expect(lanes.find((lane) => lane.role === 'lead')!.notes).toHaveLength(piece.melody.length);
  });

  it('チャンネル表示: OPLL は 6ch(+落ちた音)、2A03 は固定配線の 4ch', () => {
    const { channelNotes, voiceStats } = arrangePiece(piece, SONG.styleId);
    const lanes = opllChannelLanes(channelNotes);
    expect(lanes.slice(0, 6).map((lane) => lane.id)).toEqual(['ch0', 'ch1', 'ch2', 'ch3', 'ch4', 'ch5']);
    expect(lanes).toHaveLength(voiceStats.dropped > 0 ? 7 : 6);
    expect(lanes.slice(0, 6).reduce((sum, lane) => sum + lane.notes.length, 0)).toBe(voiceStats.assigned);
    expect(nesChannelLanes(piece).map((lane) => lane.id)).toEqual(['pulse1', 'pulse2', 'triangle', 'noise']);
  });

  it('位置表示は 1 始まりの「小節.拍」', () => {
    expect(formatBarBeat(0)).toBe('1.1');
    expect(formatBarBeat(5.5)).toBe('2.2');
    expect(formatBarBeat(-3)).toBe('1.1');
  });
});
