import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import type { ComposeOptions, NoteEvent } from '../src/core/music/types.js';
import { diagnosePiece } from '../src/core/music/diagnostics.js';
import { applyDiminution } from '../src/core/music/diminution.js';
import { availableTensionPcs, selectTensionPcs } from '../src/core/music/tension.js';
import {
  MAJOR_PENTATONIC_SCALE, MAJOR_SCALE, MINOR_PENTATONIC_SCALE,
} from '../src/core/music/theory.js';

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

  it('骨格(structural)の位置と音高は不変で、挿入は縮小変奏フィギュアのみ', () => {
    const plain = compose(base);
    const rich = compose({ ...base, diminution: 'rich' });
    const skeleton = (piece: typeof plain) => piece.melody
      .filter((note) => note.role !== 'ornament')
      .map((note) => [note.beat, note.midi]);
    expect(skeleton(rich)).toEqual(skeleton(plain));
    const inserted = rich.melody.filter((note) => note.role === 'ornament');
    expect(inserted.length).toBeGreaterThan(plain.melody.filter((n) => n.role === 'ornament').length);
    // 挿入音は骨格対に対する古典フィギュアに限る:
    // 異音対→両端に真に挟まれる(経過音・走句)、同音対→隣接音組織音(刺繍音)。
    const structural = rich.melody
      .filter((note) => note.role !== 'ornament')
      .sort((a, b) => a.beat - b.beat);
    for (const note of inserted) {
      const before = [...structural].reverse().find((s) => s.beat < note.beat);
      const after = structural.find((s) => s.beat > note.beat);
      if (!before || !after) continue;
      if (before.midi === after.midi) {
        expect(note.midi).not.toBe(before.midi);
        expect(Math.abs(note.midi - before.midi)).toBeLessThanOrEqual(4);
      } else {
        expect(note.midi).toBeGreaterThan(Math.min(before.midi, after.midi));
        expect(note.midi).toBeLessThan(Math.max(before.midi, after.midi));
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
      if (before.midi === after.midi) continue; // 刺繍音は両端の間に挟まれない
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

describe('五音ペンタ語法(pentatonic): 五音語彙とカラートーン装置の共存', () => {
  const kmmoPenta: ComposeOptions = {
    progressionId: 'relative-orbit', styleId: 'kmmo', keyRoot: 2, bpm: 103, bars: 16, seed: 8,
    melodicLanguage: 'pentatonic',
  };

  it('長調はメジャーペンタ、短調はマイナーペンタが旋律語彙になる', () => {
    const major = compose(kmmoPenta);
    expect(new Set(major.melodicScalePcs))
      .toEqual(new Set(MAJOR_PENTATONIC_SCALE.map((t) => (t + 2) % 12)));
    const minor = compose({ ...kmmoPenta, tonality: 'minor' });
    expect(new Set(minor.melodicScalePcs))
      .toEqual(new Set(MINOR_PENTATONIC_SCALE.map((t) => (t + 2) % 12)));
  });

  it('和風と違い、テンション・ディミニューション等の装置は生きたまま(四千年型の組合せ)', () => {
    const piece = compose(kmmoPenta);
    // カラートーン和声(kmmo既定lush)が発火している
    expect(piece.chords.some((c) => (c.colorPcs ?? []).length > 0)).toBe(true);
    // ディミニューション(kmmo既定rich)が発火し、挿入音は全て五音語彙から出る
    const ornaments = piece.melody.filter((n) => n.role === 'ornament');
    expect(ornaments.length).toBeGreaterThan(0);
    for (const note of ornaments) {
      expect(piece.melodicScalePcs).toContain(note.midi % 12);
    }
    // 同条件の和風は装置が全てoff(既存挙動の確認)
    const japanese = compose({ ...kmmoPenta, melodicLanguage: 'japanese' });
    expect(japanese.chords.every((c) => (c.colorPcs ?? []).length === 0)).toBe(true);
  });

  it('弱拍の歩みは五音に乗る(強拍のコードトーン規則は保持)', () => {
    const piece = compose(kmmoPenta);
    const chordAt = (beat: number) => {
      let current = piece.chords[0]!;
      for (const chord of piece.chords) {
        if (chord.beat <= beat) current = chord;
        else break;
      }
      return current;
    };
    const structural = piece.melody.filter(
      (n) => n.role !== 'ornament' && n.beat >= piece.loopStartBeat,
    );
    for (const note of structural) {
      const inChord = chordAt(note.beat).pcs.includes(note.midi % 12);
      const inPenta = piece.melodicScalePcs.includes(note.midi % 12);
      // 全ての旋律音は「五音語彙」か「その拍の和声音」のどちらかに属する
      expect(inChord || inPenta).toBe(true);
    }
    // 大半は五音側(四千年実測: 旋律pc上位5音=五音で54%。和声音経由の逸脱は少数)
    const pentaRatio = structural.filter(
      (n) => piece.melodicScalePcs.includes(n.midi % 12),
    ).length / structural.length;
    expect(pentaRatio).toBeGreaterThan(0.6);
  });

  it('診断エラーを出さない(複数シード)', () => {
    for (const seed of [3, 8, 21]) {
      for (const tonality of ['major', 'minor'] as const) {
        const piece = compose({ ...kmmoPenta, seed, tonality });
        expect(
          diagnosePiece(piece).issues.filter((i) => i.severity === 'error'),
          `seed=${seed} ${tonality}`,
        ).toEqual([]);
      }
    }
  });
});

describe('ディミニューションの走句・刺繍音フィギュア', () => {
  const cMajorScale = () => MAJOR_SCALE as readonly number[];

  it('4分対(間隔1拍)は到達側へ寄せた16分走句で埋まる', () => {
    const melody: NoteEvent[] = [
      { beat: 0, dur: 1, midi: 76, role: 'structural' },
      { beat: 1, dur: 1, midi: 83, role: 'structural' },
    ];
    applyDiminution(melody, 'rich', cMajorScale, () => 0, { maxGapBeats: 1.0 });
    const inserted = melody.filter((n) => n.role === 'ornament');
    // E5→B5の間のCメジャー音(F,G,A)が3音、到達直前の連続16分スロットへ並ぶ
    expect(inserted.map((n) => n.beat)).toEqual([0.25, 0.5, 0.75]);
    expect(inserted.map((n) => n.midi)).toEqual([77, 79, 81]);
  });

  it('既定(maxGap 0.75)では4分対に走句が入らない(bounce系の据え置き)', () => {
    const melody: NoteEvent[] = [
      { beat: 0, dur: 1, midi: 76, role: 'structural' },
      { beat: 1, dur: 1, midi: 83, role: 'structural' },
    ];
    applyDiminution(melody, 'rich', cMajorScale, () => 0);
    expect(melody.filter((n) => n.role === 'ornament')).toEqual([]);
  });

  it('同音反復対には隣接音組織音の刺繍音が入り、骨格の音域を広げない', () => {
    const melody: NoteEvent[] = [
      { beat: 0, dur: 0.5, midi: 76, role: 'structural' },
      { beat: 0.5, dur: 0.5, midi: 76, role: 'structural' },
      { beat: 1, dur: 1, midi: 81, role: 'structural' },
    ];
    applyDiminution(melody, 'rich', cMajorScale, () => 0, { maxGapBeats: 1.0 });
    const neighbor = melody.find((n) => n.role === 'ornament' && Math.abs(n.beat - 0.25) < 0.01);
    expect(neighbor).toBeDefined();
    expect(neighbor!.midi).not.toBe(76);
    expect(neighbor!.midi).toBeGreaterThanOrEqual(76); // 上隣(抽選0=上)、かつ音域内
    expect(neighbor!.midi).toBeLessThanOrEqual(81);
    expect(cMajorScale().includes(neighbor!.midi % 12)).toBe(true);
  });

  it('他声部の予約位置(blockedBeats)とは衝突しない', () => {
    const melody: NoteEvent[] = [
      { beat: 0, dur: 1, midi: 76, role: 'structural' },
      { beat: 1, dur: 1, midi: 83, role: 'structural' },
    ];
    applyDiminution(melody, 'rich', cMajorScale, () => 0, {
      maxGapBeats: 1.0, blockedBeats: [0.5],
    });
    expect(melody.filter((n) => n.role === 'ornament')).toEqual([]);
  });
});

describe('曲間モチーフ流用(externalMotif)', () => {
  it('Piece.motifはJSONで往復でき、externalMotifへ渡すと同一モチーフが再実現される', () => {
    const source = compose({ ...base, styleId: 'kmmo', bpm: 103 });
    expect(source.motif.moves).toHaveLength(16);
    const carried = JSON.parse(JSON.stringify(source.motif));
    // 別のキー・調性・語法・スタイルの曲へ移植
    const target: ComposeOptions = {
      progressionId: 'relative-orbit', styleId: 'eurobeat', keyRoot: 7, bpm: 170, bars: 16,
      seed: 99, tonality: 'minor', melodicLanguage: 'pentatonic', externalMotif: carried,
    };
    const piece = compose(target);
    // モチーフは主題区間のジェスチャーとしてそのまま持ち越される(往復不変)
    expect(piece.motif).toEqual(source.motif);
    // 移植は決定論的で、モチーフ無しとは異なる旋律になる
    expect(compose(target)).toEqual(piece);
    const { externalMotif: _omitted, ...targetWithoutMotif } = target;
    const without = compose(targetWithoutMotif);
    expect(piece.melody).not.toEqual(without.melody);
    // 旋律以外の設計(和声・ドラム)は動かない
    expect(piece.chords.map((c) => c.token)).toEqual(without.chords.map((c) => c.token));
    expect(piece.drums).toEqual(without.drums);
  });

  it('外部モチーフを与えても診断を通る', () => {
    const source = compose(base);
    const piece = compose({
      ...base, seed: 4, keyRoot: 9, externalMotif: source.motif,
    });
    expect(diagnosePiece(piece).issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('壊れた保存データでも決定論のまま完走する(正規化)', () => {
    const piece = compose({
      ...base,
      externalMotif: { moves: [{ direction: 3 as unknown as 1, stepwise: 1 as unknown as boolean, leap: 99 }] },
    });
    expect(piece.motif.moves).toHaveLength(16);
    expect(piece.motif.moves[0]!.leap).toBeLessThanOrEqual(7);
  });
});
