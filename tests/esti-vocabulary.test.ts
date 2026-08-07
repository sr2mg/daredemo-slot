import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import type { ComposeOptions } from '../src/core/music/compose.js';
import { diagnosePiece } from '../src/core/music/diagnostics.js';
import { availableTensionPcs, selectTensionPcs } from '../src/core/music/tension.js';
import { MAJOR_SCALE } from '../src/core/music/theory.js';

/**
 * ESTi/SoundTeMP系実測から導入した3語彙の検証:
 * テンション方針(アヴェイラブル・テンション導出) / ディミニューション(縮小変奏) /
 * vi軌道進行。共通の設計原則は「機能和声の骨格と旋律骨格は1音も動かさない」。
 */

const base: ComposeOptions = {
  progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, bars: 16, seed: 11,
};

const cMajor = [...MAJOR_SCALE];

describe('テンション導出(アヴェイラブル・テンション理論)', () => {
  it('長三和音は9th/6th/M7が使え、アヴォイド(3度の半音上)は除外される', () => {
    const available = availableTensionPcs([0, 4, 7], cMajor, 0);
    expect(available).not.toContain(5); // 4th = E の半音上
    expect(new Set(available)).toEqual(new Set([11, 2, 9]));
    expect(selectTensionPcs([0, 4, 7], cMajor, 0, 'soft')).toEqual([11]); // M7優先
    expect(selectTensionPcs([0, 4, 7], cMajor, 0, 'lush')).toEqual([11, 2]); // M7+9th
  });

  it('Vにはb7が最優先で導出され、soft一発でV7になる', () => {
    expect(selectTensionPcs([7, 11, 2], cMajor, 7, 'soft')).toEqual([5]); // F = G7の7th
  });

  it('短三和音(vi)はm7→9thの順で色づく', () => {
    expect(selectTensionPcs([9, 0, 4], cMajor, 9, 'soft')).toEqual([7]); // G = Am7の7th
    expect(selectTensionPcs([9, 0, 4], cMajor, 9, 'lush')).toEqual([7, 11]); // 7th+9th
  });

  it('offは空', () => {
    expect(selectTensionPcs([0, 4, 7], cMajor, 0, 'off')).toEqual([]);
  });
});

describe('テンション方針(曲レベル)', () => {
  it('ボイシングだけが変わり、旋律・低音・ドラム・和声機能は1音も動かない', () => {
    const plain = compose(base);
    const lush = compose({ ...base, tensionPolicy: 'lush' });
    expect(lush.melody).toEqual(plain.melody);
    expect(lush.bass).toEqual(plain.bass);
    expect(lush.drums).toEqual(plain.drums);
    expect(lush.chords.map((c) => c.token)).toEqual(plain.chords.map((c) => c.token));
    expect(lush.chords.map((c) => c.pcs)).toEqual(plain.chords.map((c) => c.pcs));
    expect(lush.chords.map((c) => c.midis)).not.toEqual(plain.chords.map((c) => c.midis));
  });

  it('カラートーンはコードトーンの半音上に置かれない(アヴォイド規則の実地検証)', () => {
    const lush = compose({ ...base, tensionPolicy: 'lush' });
    const bodyChords = lush.chords.filter((c) => c.beat >= lush.loopStartBeat);
    expect(bodyChords.some((c) => (c.colorPcs ?? []).length > 0)).toBe(true);
    for (const chord of bodyChords) {
      for (const color of chord.colorPcs ?? []) {
        expect(chord.pcs).not.toContain(color);
        expect(chord.pcs.map((pc) => (pc + 1) % 12)).not.toContain(color);
      }
    }
  });

  it('診断エラーを出さない', () => {
    const report = diagnosePiece(compose({ ...base, tensionPolicy: 'lush' }));
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });
});

describe('ディミニューション(縮小変奏)', () => {
  it('省略とoffは同一の曲になる', () => {
    expect(compose({ ...base, diminution: 'off' })).toEqual(compose(base));
  });

  it('骨格(structural)の位置と音高は不変で、挿入は経過音のみ', () => {
    const plain = compose(base);
    const rich = compose({ ...base, diminution: 'rich' });
    const skeleton = (piece: typeof plain) => piece.melody
      .filter((note) => note.role !== 'ornament')
      .map((note) => [note.beat, note.midi]);
    expect(skeleton(rich)).toEqual(skeleton(plain));
    const inserted = rich.melody.filter((note) => note.role === 'ornament');
    expect(inserted.length).toBeGreaterThan(plain.melody.filter((n) => n.role === 'ornament').length);
    // 挿入音は隣接する骨格音の間に真に挟まれる(経過音の定義)。
    const structural = rich.melody
      .filter((note) => note.role !== 'ornament')
      .sort((a, b) => a.beat - b.beat);
    for (const note of inserted) {
      const before = [...structural].reverse().find((s) => s.beat < note.beat);
      const after = structural.find((s) => s.beat > note.beat);
      if (!before || !after) continue;
      const lo = Math.min(before.midi, after.midi);
      const hi = Math.max(before.midi, after.midi);
      if (Math.abs(note.beat - (before.beat + after.beat) / 2) < 0.01) {
        expect(note.midi).toBeGreaterThan(lo);
        expect(note.midi).toBeLessThan(hi);
      }
    }
  });

  it('診断エラーを出さない', () => {
    const report = diagnosePiece(compose({ ...base, diminution: 'rich' }));
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('局所修正(melodyEdits)の後に経過音を選ぶ(修正で挿入音が孤児化しない)', () => {
    const plain = compose(base);
    const target = plain.melody.find(
      (note) => note.role !== 'ornament' && note.beat >= plain.loopStartBeat + 8,
    )!;
    const piece = compose({
      ...base,
      diminution: 'rich',
      melodyEdits: [{ beat: target.beat, fromMidi: target.midi, toMidi: target.midi + 2 }],
    });
    const structural = piece.melody
      .filter((note) => note.role !== 'ornament')
      .sort((a, b) => a.beat - b.beat);
    for (const note of piece.melody.filter((n) => n.role === 'ornament')) {
      const before = [...structural].reverse().find((s) => s.beat < note.beat);
      const after = structural.find((s) => s.beat > note.beat);
      if (!before || !after) continue;
      if (Math.abs(note.beat - (before.beat + after.beat) / 2) >= 0.01) continue;
      expect(note.midi).toBeGreaterThan(Math.min(before.midi, after.midi));
      expect(note.midi).toBeLessThan(Math.max(before.midi, after.midi));
    }
  });
});

describe('vi軌道進行と韓国MMO風スタイル', () => {
  it('vi軌道は長調・短調の両実体で診断を通る', () => {
    for (const seed of [3, 11, 42]) {
      const major = compose({ ...base, progressionId: 'relative-orbit', seed });
      expect(diagnosePiece(major).issues.filter((i) => i.severity === 'error')).toEqual([]);
      const minor = compose({
        ...base, progressionId: 'relative-orbit', tonality: 'minor', seed,
      });
      expect(diagnosePiece(minor).issues.filter((i) => i.severity === 'error')).toEqual([]);
    }
  });

  it('kmmoスタイルは既定でlush+richになり、診断を通る', () => {
    const piece = compose({
      progressionId: 'relative-orbit', styleId: 'kmmo', keyRoot: 2, bpm: 100, bars: 16, seed: 8,
    });
    expect(piece.chords.some((c) => (c.colorPcs ?? []).length > 0)).toBe(true);
    expect(piece.melody.some((n) => n.role === 'ornament')).toBe(true);
    expect(diagnosePiece(piece).issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('既存スタイルの既定は変わらない(テンション・細分ともoff)', () => {
    const piece = compose(base);
    expect(piece.chords.every((c) => (c.colorPcs ?? []).length === 0)).toBe(true);
  });
});
