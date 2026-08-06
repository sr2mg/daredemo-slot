import { describe, expect, it } from 'vitest';
import { compose, diagnosePiece, validatePiece } from '../src/core/music/compose.js';
import type { ComposeOptions, Piece } from '../src/core/music/compose.js';
import {
  CHORDS, NATURAL_MINOR_SCALE, MAJOR_SCALE, PROGRESSIONS,
  chordScalePcs, progressionsForTonality,
} from '../src/core/music/theory.js';
import { featuredGuideStrand, guideStrands } from '../src/core/music/voice-leading.js';

/**
 * 声部連結の導出層（voice-leading.ts）と、その2つの応用の検証。
 * - コードスケール（一般法則）: 弱拍の音組織を小節の変位和音で上書きし、短9度の濁りを防ぐ
 * - 保続ガイドライン（表現装置）: 進行から導出した最短連結ストランドを選択的に敷く
 * どちらも実音ラインの手書きデータを持たず、コード列からの導出だけで動くこと。
 */

const base: ComposeOptions = {
  progressionId: 'minor-incantation',
  styleId: 'eurobeat',
  keyRoot: 0,
  bpm: 140,
  bars: 4,
  tonality: 'minor',
  seed: 0,
};

const relativeTones = (tokens: readonly string[]): number[][] => (
  tokens.map((token) => [...CHORDS[token]!.tones])
);
const relativeRoots = (tokens: readonly string[]): number[] => (
  tokens.map((token) => CHORDS[token]!.tones[0]!)
);
const chordFor = (piece: Piece, beat: number) => (
  [...piece.chords].reverse().find((chord) => chord.beat <= beat)!
);

describe('コードスケール導出（chordScalePcs）', () => {
  it('短調のV7は♭7を導音へ置き換える（和声的短音階）', () => {
    expect(chordScalePcs(NATURAL_MINOR_SCALE, CHORDS['V7m']!.tones, 7))
      .toEqual([0, 2, 3, 5, 7, 8, 11]);
  });

  it('短調のIV7は♭6を♮6へ置き換える（ドリアン）', () => {
    expect(chordScalePcs(NATURAL_MINOR_SCALE, CHORDS['IV7m']!.tones, 5))
      .toEqual([0, 2, 3, 5, 7, 9, 10]);
  });

  it('長調のIII7はG♮をG#へ置き換える（平行短調の和声的短音階と同じ集合）', () => {
    expect(chordScalePcs(MAJOR_SCALE, CHORDS['III7']!.tones, 4))
      .toEqual([0, 2, 4, 5, 8, 9, 11]);
  });

  it('長調のI7は長7度を♭7へ置き換える（ミクソリディア）', () => {
    expect(chordScalePcs(MAJOR_SCALE, CHORDS['I7']!.tones, 0))
      .toEqual([0, 2, 4, 5, 7, 9, 10]);
  });

  it('ダイアトニックなコードでは音階をそのまま返す', () => {
    expect(chordScalePcs(MAJOR_SCALE, CHORDS['IV']!.tones, 5)).toEqual([...MAJOR_SCALE]);
    expect(chordScalePcs(NATURAL_MINOR_SCALE, CHORDS['iv7']!.tones, 5))
      .toEqual([...NATURAL_MINOR_SCALE]);
  });
});

describe('最短声部連結ストランド（guideStrands / featuredGuideStrand）', () => {
  const incantation = ['i7', 'V7m', 'VII', 'IV7m'];

  it('i7–V7–♭VII–IV7 から主音起点の半音下行クリシェが導出される', () => {
    const strands = guideStrands(relativeTones(incantation));
    expect(strands.map((strand) => strand.pcs.join(','))).toContain('0,11,10,9');
  });

  it('フィーチャー対象はループ折り返しまで半音以内のストランドに限る', () => {
    const featured = featuredGuideStrand(relativeTones(incantation), relativeRoots(incantation));
    expect(featured).not.toBeNull();
    // 主音起点の 0→11→10→9 は折り返しで3半音跳ぶため、♭7起点の隣接線が勝つ。
    expect(featured!.pcs).toEqual([10, 11, 10, 9]);
    expect(featured!.maxMove).toBeLessThanOrEqual(1);
    expect(featured!.chromaticMoves).toBeGreaterThanOrEqual(2);
  });

  it('保続だけ・跳躍混じり・根音複製のストランドしかない列では発火しない', () => {
    expect(featuredGuideStrand(relativeTones(['I', 'vi']), relativeRoots(['I', 'vi']))).toBeNull();
    expect(featuredGuideStrand(relativeTones(['i', 'i']), relativeRoots(['i', 'i']))).toBeNull();
  });

  it('順位づけは移調不変（キーが違っても同じ相対ストランドを選ぶ）', () => {
    const relative = featuredGuideStrand(relativeTones(incantation), relativeRoots(incantation))!;
    const transposed = relativeTones(incantation).map((tones) => tones.map((pc) => (pc + 9) % 12));
    const roots = relativeRoots(incantation).map((pc) => (pc + 9) % 12);
    const shifted = featuredGuideStrand(transposed, roots)!;
    expect(shifted.pcs).toEqual(relative.pcs.map((pc) => (pc + 9) % 12));
  });
});

describe('呪文ループ進行（minor-incantation）', () => {
  it('キーCの定番形は Cm7 G7 A# F7（i7–V7–♭VII–IV7）', () => {
    const piece = compose(base);
    expect(piece.barChordNames).toEqual(['Cm7', 'G7', 'A#', 'F7']);
    expect(validatePiece(piece)).toEqual([]);
  });

  it('短調専用で、長調カタログには現れない', () => {
    expect(progressionsForTonality('minor').map((prog) => prog.id)).toContain('minor-incantation');
    expect(progressionsForTonality('major').map((prog) => prog.id)).not.toContain('minor-incantation');
  });

  it('IV7の小節では主旋律に♭6が現れない（コードスケール法則の実効）', () => {
    for (let seed = 0; seed < 16; seed++) {
      const piece = compose({ ...base, bars: 8, seed });
      for (const note of piece.melody.filter((candidate) => candidate.role !== 'ornament')) {
        const chord = chordFor(piece, note.beat);
        if (chord.token !== 'IV7m') continue;
        expect(note.midi % 12, `seed=${seed}/beat=${note.beat}`).not.toBe((piece.keyRoot + 8) % 12);
      }
    }
  });
});

describe('保続ガイドライン（counterRole: guideline）', () => {
  it('発火した曲では対旋律がストランドをなぞるロングトーンになり、診断エラーを出さない', () => {
    const fired: Piece[] = [];
    for (let seed = 0; seed < 128 && fired.length < 3; seed++) {
      const piece = compose({ ...base, seed });
      if (piece.arrangementPlan.counterRole === 'guideline' && piece.counterMelody.length > 0) {
        fired.push(piece);
      }
    }
    expect(fired.length).toBeGreaterThan(0);
    for (const piece of fired) {
      const strand = featuredGuideStrand(
        piece.chords.map((chord) => chord.pcs),
        piece.chords.map((chord) => chord.pcs[0]!),
      )!;
      expect(strand).not.toBeNull();
      piece.counterMelody.forEach((note) => {
        // 主旋律域（C5=72以上）と完全ユニゾンしない下側の保続。
        expect(note.midi).toBeLessThan(72);
        expect(note.dur).toBeGreaterThanOrEqual(0.5);
        expect(note.articulation).toBe('tenuto');
        expect(chordFor(piece, note.beat).pcs).toContain(note.midi % 12);
      });
      // 発音区間のピッチクラス列は導出ストランドと一致する。
      const strandAt = new Map(piece.chords.map((chord, index) => [chord.beat, strand.pcs[index]!]));
      for (const note of piece.counterMelody) {
        expect(note.midi % 12, `beat=${note.beat}`).toBe(strandAt.get(note.beat));
      }
      const report = diagnosePiece(piece);
      expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    }
  });

  it('発火は選択的で、全曲へ一律適用されない（進行間でも曲間でも按分される）', () => {
    const firedByProgression = new Map<string, number>();
    for (const prog of PROGRESSIONS) {
      let fired = 0;
      for (let seed = 0; seed < 64; seed++) {
        const piece = compose({
          ...base, progressionId: prog.id, tonality: prog.tonality, bars: 8, seed,
        });
        if (piece.arrangementPlan.counterRole === 'guideline') fired++;
      }
      firedByProgression.set(prog.id, fired);
    }
    const counts = [...firedByProgression.values()];
    const total = counts.reduce((sum, count) => sum + count, 0);
    // 全体では少数派の装置（1/4未満）だが、死んだ機能でもない。
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(PROGRESSIONS.length * 64 * 0.25);
    // 品質ゲートが進行を選別する: 発火する進行と、まったく発火しない進行の両方がある。
    expect(counts.some((count) => count === 0)).toBe(true);
    expect(firedByProgression.get('minor-incantation')!).toBeGreaterThan(0);
  });

  it('2A03では応答の代替として抽選され、伴奏刻みと同じパルス2で保続線に置き換わる', () => {
    let fired = 0;
    for (let seed = 0; seed < 64; seed++) {
      const piece = compose({ ...base, bars: 8, seed, soundChip: 'nes2a03' });
      if (piece.arrangementPlan.counterRole !== 'guideline') continue;
      fired++;
      expect(validatePiece(piece), `seed=${seed}`).toEqual([]);
    }
    expect(fired).toBeGreaterThan(0);
    expect(fired).toBeLessThan(32);
  });
});
