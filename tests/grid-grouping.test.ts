import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { diagnosePiece, validatePiece } from '../src/core/music/diagnostics.js';
import { resolveForm, totalBars } from '../src/core/music/form.js';
import { gridFor, nearBeat, pulseBeats, snapDurationsToPulses, stepBeat } from '../src/core/music/grid.js';
import { offbeatBackingRiff } from '../src/audio/backing-riff.js';
import { STYLES } from '../src/core/music/theory.js';
import type { ComposeOptions, Piece, SongFormSpec } from '../src/core/music/types.js';

/**
 * 12/8(4x3)・6/4(3x4)の区間を実際に生成して固定する:
 * - 生成検証・診断エラーがゼロ
 * - 旋律の打点は区間の格子(1/3 拍)に乗り、強拍(小節頭・アンカー)は和声音
 * - 3x4 の和音変化・伴奏の再打鍵・ベースの刻み・ドラムのキックは格子の拍頭
 * - ×3 の格子ではスウィングが効かない(bounce を指定しても打点は格子上)
 * - 既存プリセット(4x2 だけ)の出力は不変(スナップショットテストが別途固定)
 */

const base: Omit<ComposeOptions, 'form'> = {
  progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 150, seed: 5,
};

const mixedForm: SongFormSpec = {
  sections: [
    { id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A', grouping: '4x3' },
    { id: 'B', role: 'development', bars: 8, energy: 4, theme: 'B', grouping: '3x4' },
    { id: "A'", role: 'return', bars: 8, energy: 5, theme: 'A', transform: 'literal', grouping: '4x3' },
    { id: 'C', role: 'finale', bars: 8, energy: 2, theme: 'C' },
  ],
  ending: 'loop',
};

const bodyNotes = <T extends { beat: number }>(piece: Piece, notes: readonly T[], startBar: number, bars: number): T[] => {
  const start = piece.loopStartBeat + startBar * 4;
  return notes.filter((note) => note.beat >= start && note.beat < start + bars * 4);
};

const closeTo = (actual: readonly number[], expected: readonly number[]): void => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 9));
};

/** B 区間(小節 8..15)に半小節の和音変化を含めるレシピ(royal-pop: IV・V と I・vi)。 */
const mixedChoice = [
  ...[0, 0, 0, 0, 0, 0, 0, 0],
  ...[0, 0, 0, 1, 0, 0, 1, 1],
  ...[0, 0, 0, 0, 0, 0, 0, 0],
  ...[0, 0, 0, 0, 0, 0, 0, 0],
];

const onGrid = (piece: Piece, beat: number, steps: number): boolean => {
  const inBar = ((beat - piece.loopStartBeat) % 4 + 4) % 4;
  const step = (inBar * steps) / 4;
  return Math.abs(step - Math.round(step)) < 1e-6;
};

describe('拍の割り方が混在する曲型の生成', () => {
  const piece = compose({ ...base, form: mixedForm, intro: false, choice: mixedChoice });
  const sections = piece.songPlan.form.sections;

  it('生成検証・診断エラーがゼロで、区間ごとの割り方が計画へ写る', () => {
    expect(validatePiece(piece)).toEqual([]);
    expect(diagnosePiece(piece).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(sections.map((section) => section.grouping)).toEqual(['4x3', '3x4', '4x3', '4x2']);
    expect(piece.phrasePlan.bars.map((bar) => bar.grouping).slice(0, 25))
      .toEqual([...Array(8).fill('4x3'), ...Array(8).fill('3x4'), ...Array(8).fill('4x3'), '4x2']);
    expect(Object.keys(piece.phrasePlan.rhythmFamilies).sort()).toEqual(['3x4', '4x2', '4x3']);
  });

  it('12/8 区間の旋律は 12 ステップ(1/3 拍)の格子に乗り、8 分格子より密い', () => {
    const notes = bodyNotes(piece, piece.melody.filter((note) => note.role !== 'ornament'), 0, 8);
    expect(notes.every((note) => onGrid(piece, note.beat, 12))).toBe(true);
    expect(notes.some((note) => !onGrid(piece, note.beat, 8))).toBe(true);
    // 小節頭は和声音(アンカー=3 拍目は倚音として解決する場合があり、診断が検査する)。
    for (const note of notes) {
      const inBar = ((note.beat - piece.loopStartBeat) % 4 + 4) % 4;
      if (!nearBeat(inBar, 0)) continue;
      const chord = [...piece.chords].reverse().find((candidate) => candidate.beat <= note.beat + 1e-6)!;
      expect(chord.pcs, `${note.beat}`).toContain(note.midi % 12);
    }
  });

  it('6/4 区間の和音変化・ベースの刻み・ドラムのキックは拍頭(0, 4/3, 8/3)に乗る', () => {
    const grid = gridFor('3x4');
    const pulses = pulseBeats(grid);
    const onPulse = (beat: number): boolean => {
      const inBar = ((beat - piece.loopStartBeat) % 4 + 4) % 4;
      return pulses.some((pulse) => nearBeat(inBar, pulse));
    };
    const chords = bodyNotes(piece, piece.chords, 8, 8);
    expect(chords.length).toBeGreaterThan(8);
    expect(chords.every((chord) => onPulse(chord.beat))).toBe(true);
    const splitBar = chords.find((chord) => Math.abs(chord.dur - 4) > 1e-6);
    expect(splitBar).toBeDefined();
    expect(piece.barChordNames.slice(8, 16).some((label) => label.includes('/3拍'))).toBe(true);
    // ユーロビートのベースは 8 分(格子のステップ)刻み。ステップは 1/3 拍。
    const bass = bodyNotes(piece, piece.bass, 8, 8);
    expect(bass.every((note) => onGrid(piece, note.beat, 12))).toBe(true);
    const kicks = bodyNotes(piece, piece.drums.filter((drum) => drum.inst === 'kick'), 8, 8);
    expect(kicks.length).toBeGreaterThan(0);
    expect(kicks.every((drum) => onPulse(drum.beat))).toBe(true);
    // 旋律の強拍は小節頭と第 2 拍(4/3 拍)。
    const notes = bodyNotes(piece, piece.melody.filter((note) => note.role !== 'ornament'), 8, 8);
    expect(notes.every((note) => onGrid(piece, note.beat, 12))).toBe(true);
    expect(notes.some((note) => nearBeat(((note.beat - piece.loopStartBeat) % 4 + 4) % 4, stepBeat(grid, 4)))).toBe(true);
  });

  it('和声リズムの吸着: 3x4 では整数拍の境界を拍頭へ(同距離なら前を長く)、4x2/4x3 では恒等', () => {
    const sixFour = gridFor('3x4');
    closeTo(snapDurationsToPulses(sixFour, [2, 2]), [8 / 3, 4 / 3]);
    closeTo(snapDurationsToPulses(sixFour, [1, 3]), [4 / 3, 8 / 3]);
    closeTo(snapDurationsToPulses(sixFour, [3, 1]), [8 / 3, 4 / 3]);
    expect(snapDurationsToPulses(sixFour, [4])).toEqual([4]);
    for (const grouping of ['4x2', '4x3'] as const) {
      for (const durations of [[2, 2], [1, 3], [3, 1], [4]]) {
        expect(snapDurationsToPulses(gridFor(grouping), durations)).toEqual(durations);
      }
    }
  });

  it('裏打ちバッキング(OPLL/2A03 共有)は 6/4 区間では各拍頭の 2/3 拍後に打つ', () => {
    const grid = gridFor('3x4');
    const pulses = pulseBeats(grid);
    const chords = bodyNotes(piece, piece.chords, 8, 8);
    const steps = chords.flatMap((chord) => offbeatBackingRiff(piece, chord, 'chordStart'));
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      const inBar = ((step.beat - piece.loopStartBeat) % 4 + 4) % 4;
      expect(pulses.some((pulse) => nearBeat(inBar, pulse + 2 / 3)), `${step.beat}`).toBe(true);
    }
  });

  it('×3 の格子ではスウィングが効かない(bounce でも打点は格子上)', () => {
    const bounced = compose({ ...base, form: mixedForm, intro: false, grooveFeel: 'bounce', choice: mixedChoice });
    expect(validatePiece(bounced)).toEqual([]);
    const notes = bodyNotes(bounced, bounced.melody, 0, 16);
    expect(notes.every((note) => onGrid(bounced, note.beat, 12))).toBe(true);
    // 4x2 の区間(C)では従来どおり跳ねる(格子外の 2/3 位置がある)。
    const straightSection = bodyNotes(bounced, bounced.melody.filter((note) => note.role !== 'ornament'), 24, 8);
    expect(straightSection.some((note) => !onGrid(bounced, note.beat, 8))).toBe(true);
  });
});

describe('歌もの(12/8↔6/4)プリセット', () => {
  it('song と同じ区間列で、主題ごとに割り方が揃い、両調性で検証を通る', () => {
    const hemiola = resolveForm('songHemiola');
    const song = resolveForm('song');
    expect(totalBars(hemiola)).toBe(96);
    expect(hemiola.sections.map((section) => [section.id, section.theme]))
      .toEqual(song.sections.map((section) => [section.id, section.theme]));
    const byTheme = new Map<string, Set<string>>();
    for (const section of hemiola.sections) {
      const set = byTheme.get(section.theme) ?? new Set();
      set.add(section.grouping ?? '4x2');
      byTheme.set(section.theme, set);
    }
    for (const [theme, groupings] of byTheme) expect(groupings.size, theme).toBe(1);
    expect(byTheme.get('A')).toEqual(new Set(['4x3']));
    expect(byTheme.get('B')).toEqual(new Set(['3x4']));
    expect(byTheme.get('C')).toEqual(new Set(['4x2']));
  });

  it('全スタイルで生成検証・診断エラーがゼロ', () => {
    for (const style of STYLES) {
      const piece = compose({
        ...base, styleId: style.id, form: 'songHemiola', tonality: 'minor', progressionId: 'aeolian-ladder',
      });
      expect(validatePiece(piece), style.id).toEqual([]);
      const errors = diagnosePiece(piece).issues.filter((issue) => issue.severity === 'error');
      expect(errors, style.id).toEqual([]);
      expect(piece.ending).toBe('final');
    }
  });
});
