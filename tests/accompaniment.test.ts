import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { diagnosePiece, validatePiece } from '../src/core/music/diagnostics.js';
import { validateForm } from '../src/core/music/form.js';
import { arpeggioAccelerationSteps, gridFor } from '../src/core/music/grid.js';
import { canonicalForm } from '../src/core/music/options.js';
import { accompanimentCandidates, hasArpeggioAccompaniment, STYLES } from '../src/core/music/theory.js';
import { arrangeSf2Parts } from '../src/audio/pcm-arrange.js';
import { offbeatBackingRiff } from '../src/audio/backing-riff.js';
import type { ComposeOptions, Piece, SongFormSpec } from '../src/core/music/types.js';

/**
 * 区間の伴奏型(accompaniment)を固定する:
 * - 様式は候補列を宣言し、編成計画が区間の力を候補へ写す(アコースティック: 1-2 拍打ち / 3-4 分散和音 8 分 / 5 16 分)。
 *   全区間に同じ分散和音を敷く「床」は無い。
 * - 曲型の明示指定はどの様式でも効く(装置型の様式では装置の分散和音はそのまま)。
 * - 拍打ち(chords)は PCM では各拍頭のブロックコード、OPLL/2A03 の裏打ちリフでは各拍頭の 1 打。
 * - 分散和音の加速帯は 4 分音符あたり 4 打が上限(×3 の格子では格子のステップに留まる)。
 * - 検証: 不正値・テクスチャ区間への指定はエラー。正準化は明示指定を保つ。
 */

const inSection = <T extends { beat: number }>(piece: Piece, notes: readonly T[], index: number): T[] => {
  const section = piece.songPlan.form.sections[index]!;
  const start = piece.loopStartBeat + section.startBar * 4;
  const end = start + section.bars * 4;
  return notes.filter((note) => note.beat >= start && note.beat < end);
};

const notesPerBar = (piece: Piece, notes: readonly { beat: number }[], index: number): number[] => {
  const section = piece.songPlan.form.sections[index]!;
  return Array.from({ length: section.bars }, (_, bar) => {
    const start = piece.loopStartBeat + (section.startBar + bar) * 4;
    return notes.filter((note) => note.beat >= start && note.beat < start + 4).length;
  });
};

const ladder: SongFormSpec = {
  sections: [
    { id: 'A', role: 'hook', bars: 8, energy: 1, theme: 'A' },
    { id: 'B', role: 'development', bars: 8, energy: 2, theme: 'B' },
    { id: 'C', role: 'relief', bars: 8, energy: 3, theme: 'C' },
    { id: 'D', role: 'development', bars: 8, energy: 4, theme: 'D' },
    { id: 'E', role: 'finale', bars: 8, energy: 5, theme: 'E' },
  ],
  ending: 'loop',
};

const acoustic: ComposeOptions = {
  progressionId: 'drifting-orbit', styleId: 'acoustic', keyRoot: 9, bpm: 112, seed: 5, form: ladder,
  soundChip: 'pcm', intro: false,
};

describe('様式の伴奏候補', () => {
  it('候補を宣言しない様式は保続だけで、分散和音は伴奏役でない', () => {
    for (const style of STYLES) {
      if (style.id === 'acoustic') continue;
      expect(accompanimentCandidates(style.texture), style.id).toEqual(['pad']);
      expect(hasArpeggioAccompaniment(style.texture), style.id).toBe(false);
    }
    expect(hasArpeggioAccompaniment(STYLES.find((style) => style.id === 'acoustic')!.texture)).toBe(true);
  });

  it('加速帯の格子: 4x2 は 16 分、×3 の格子は 4 分あたり 4 打を超えるので格子のステップに留まる', () => {
    expect(arpeggioAccelerationSteps(gridFor('4x2'))).toBe(16);
    expect(arpeggioAccelerationSteps(gridFor('4x3'))).toBe(12);
    expect(arpeggioAccelerationSteps(gridFor('3x4'))).toBe(12);
  });
});

describe('アコースティック: 力 → 伴奏型', () => {
  const piece = compose(acoustic);

  it('1-2 は拍打ち、3-4 は分散和音 8 分、5 は 16 分。生成検証・診断エラーはゼロ', () => {
    expect(piece.arrangementPlan.sections.map((section) => section.accompaniment)).toEqual([
      'chords', 'chords', 'arpeggio8', 'arpeggio8', 'arpeggio16',
    ]);
    expect(piece.arrangementPlan.sections.map((section) => section.backingRhythm)).toEqual([
      'beat', 'beat', 'normal', 'normal', 'normal',
    ]);
    expect(piece.arrangementPlan.sections.map((section) => section.ostinatoDensity)).toEqual([0, 0, 1, 1, 2]);
    expect(validatePiece(piece)).toEqual([]);
    expect(diagnosePiece(piece).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('拍打ちの区間に分散和音は無く、分散和音の区間は全小節に敷かれ、16 分の区間だけ加速する', () => {
    expect(inSection(piece, piece.ostinato, 0)).toEqual([]);
    expect(inSection(piece, piece.ostinato, 1)).toEqual([]);
    for (const index of [2, 3]) {
      const perBar = notesPerBar(piece, piece.ostinato, index);
      expect(Math.min(...perBar), `section=${index}`).toBeGreaterThanOrEqual(6);
      expect(Math.max(...perBar), `section=${index}`).toBeLessThanOrEqual(8);
    }
    const peak = notesPerBar(piece, piece.ostinato, 4);
    expect(Math.max(...peak)).toBe(16);
    expect(Math.min(...peak)).toBeGreaterThanOrEqual(6);
  });

  it('PCM の拍打ちは和音内の各拍頭でブロックコードを打ち、次の拍頭まで鳴らす', () => {
    const parts = arrangeSf2Parts(piece);
    const section = piece.songPlan.form.sections[0]!;
    const spb = 60 / piece.bpm;
    const start = (piece.loopStartBeat + section.startBar * 4) * spb;
    const end = (piece.loopStartBeat + (section.startBar + section.bars) * 4) * spb;
    const backing = parts.backing.filter((note) => note.startSec >= start - 1e-6 && note.startSec < end - 1e-6);
    const chords = inSection(piece, piece.chords, 0);
    const expectedCount = chords.reduce((sum, chord) => sum + Math.round(chord.dur) * chord.midis.length, 0);
    expect(backing.length).toBe(expectedCount);
    const onsets = [...new Set(backing.map((note) => Math.round(note.startSec / spb * 1000) / 1000))];
    for (const onset of onsets) expect(Math.abs(onset - Math.round(onset))).toBeLessThan(1e-3);
    for (const note of backing) expect(note.durSec).toBeLessThanOrEqual(spb + 1e-6);
  });

  it('独立アルペジオの予算が無い 2A03 では分散和音の候補が拍打ちへ落ち、裏打ちリフは和音内の各拍頭で 1 打', () => {
    const nes = compose({ ...acoustic, soundChip: 'nes2a03' });
    expect(nes.arrangementPlan.sections.map((section) => section.accompaniment)).toEqual([
      'chords', 'chords', 'chords', 'chords', 'chords',
    ]);
    expect(nes.ostinato).toEqual([]);
    for (const chord of inSection(nes, nes.chords, 4)) {
      const riff = offbeatBackingRiff(nes, chord, 'onset');
      expect(riff).toHaveLength(Math.round(chord.dur));
      riff.forEach((step, index) => expect(step.beat).toBeCloseTo(chord.beat + index, 6));
    }
    expect(validatePiece(nes)).toEqual([]);
    // OPLL は独立アルペジオを持つので候補どおり。
    const opll = compose({ ...acoustic, soundChip: 'opll' });
    expect(opll.arrangementPlan.sections.map((section) => section.accompaniment)).toEqual([
      'chords', 'chords', 'arpeggio8', 'arpeggio8', 'arpeggio16',
    ]);
    expect(validatePiece(opll)).toEqual([]);
  });

  it('×3 の格子では 16 分の区間も 1 小節 12 打に留まる', () => {
    const form: SongFormSpec = {
      sections: [
        { id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A', grouping: '4x3' },
        { id: 'S', role: 'hook', bars: 8, energy: 5, theme: 'S', grouping: '4x3' },
        { id: 'T', role: 'development', bars: 8, energy: 5, theme: 'T', grouping: '3x4' },
      ],
      ending: 'loop',
    };
    const hemiola = compose({ ...acoustic, form });
    expect(hemiola.arrangementPlan.sections.map((section) => section.accompaniment)).toEqual(['arpeggio8', 'arpeggio16', 'arpeggio16']);
    for (const index of [1, 2]) {
      const perBar = notesPerBar(hemiola, hemiola.ostinato, index);
      expect(Math.max(...perBar), `section=${index}`).toBe(12);
    }
    expect(validatePiece(hemiola)).toEqual([]);
  });
});

describe('曲型の明示指定', () => {
  const rock: ComposeOptions = {
    progressionId: 'royal-pop', styleId: 'rock', keyRoot: 2, bpm: 140, seed: 21, intro: false,
    form: {
      sections: [
        { id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A' },
        { id: 'B', role: 'development', bars: 8, energy: 4, theme: 'B', accompaniment: 'chords' },
        { id: 'C', role: 'relief', bars: 8, energy: 2, theme: 'C', accompaniment: 'arpeggio8' },
        { id: "A'", role: 'return', bars: 8, energy: 4, theme: 'A', transform: 'literal' },
      ],
      ending: 'loop',
    },
  };

  it('装置型の様式でも指定は効き、未指定の区間は保続のまま装置を保つ', () => {
    const piece = compose(rock);
    const plain = compose({ ...rock, form: { ...(rock.form as SongFormSpec), sections: (rock.form as SongFormSpec).sections.map(({ accompaniment: _, ...rest }) => rest) } });
    const sections = piece.arrangementPlan.sections;
    expect(sections.map((section) => section.accompaniment)).toEqual(['pad', 'chords', 'arpeggio8', 'pad']);
    expect(sections[1]!.backingRhythm).toBe('beat');
    // 拍打ちは装置の分散和音を外さない(装置型の様式では別の層)。
    expect(sections[1]!.ostinatoDensity).toBe(plain.arrangementPlan.sections[1]!.ostinatoDensity);
    expect(sections[2]!.ostinatoDensity).toBe(1);
    // 明示の分散和音はフレーズ帯の間引きをせず全小節に敷く。
    const perBar = notesPerBar(piece, piece.ostinato, 2);
    expect(Math.min(...perBar)).toBeGreaterThanOrEqual(6);
    // 未指定の区間は指定無しの曲と同じ編成。
    for (const index of [0, 3]) expect(sections[index]).toEqual(plain.arrangementPlan.sections[index]);
    expect(validatePiece(piece)).toEqual([]);
    expect(diagnosePiece(piece).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('検証: 不正値とテクスチャ区間への指定はエラー。正準化は指定を保つ', () => {
    const defaults = { tonality: 'major', progressionId: 'royal-pop' } as const;
    const bad: SongFormSpec = {
      sections: [
        { id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A' },
        { id: 'B', role: 'development', bars: 8, energy: 3, theme: 'B', accompaniment: 'strum' as never },
        { id: 'L', role: 'relief', bars: 8, energy: 2, theme: 'L', texture: 'sustain', accompaniment: 'chords' },
      ],
      ending: 'loop',
    };
    expect(validateForm(bad, defaults).map((issue) => [issue.section, issue.message])).toEqual([
      ['B', '伴奏型が不正: strum'],
      ['L', 'ロングトーンの区間に伴奏型は指定できない'],
    ]);
    const canonical = canonicalForm(rock.form as SongFormSpec, { progressionId: 'royal-pop', keyRoot: 2, tonality: 'major' }) as SongFormSpec;
    expect(canonical.sections.map((section) => section.accompaniment)).toEqual([undefined, 'chords', 'arpeggio8', undefined]);
    expect('accompaniment' in canonical.sections[0]!).toBe(false);
  });
});
