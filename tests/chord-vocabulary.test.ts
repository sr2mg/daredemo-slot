import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { digestPiece } from '../src/core/music/piece-diff.js';
import { approachTokenFor } from '../src/core/music/song-plan.js';
import {
  CHORDS, chordOriginsFor, harmonicFunctionForToken, progressionsForTonality,
} from '../src/core/music/theory.js';
import type { HarmonicFunction, ProgressionTonality } from '../src/core/music/theory.js';

/**
 * 和音語彙のメタデータ化(度数root/品質quality/機能function + tonesの品質表導出)の検証。
 *
 * - 既存25+2トークンのtones/functionは列挙時代の値を厳密に固定する(導出表の
 *   打ち間違いはスナップショット以前にここで落ちる)
 * - 新トークン(M7/6th/add9/sus4/借用)は導出結果と借用解釈(chordOriginsFor)を固定する
 */

describe('和音カタログの導出は列挙時代の値を厳密に保存する', () => {
  // 旧 CHORDS の literal tones(コミット d3d11e1 時点)。導出化の等価性の根拠。
  const LEGACY_TONES: Record<string, readonly number[]> = {
    I: [0, 4, 7], ii: [2, 5, 9], iii: [4, 7, 11], IV: [5, 9, 0], V: [7, 11, 2], vi: [9, 0, 4],
    IVM7: [5, 9, 0, 4], III7: [4, 8, 11, 2], ii7: [2, 5, 9, 0], iii7: [4, 7, 11, 2],
    vi7: [9, 0, 4, 7], v7: [7, 10, 2, 5], I7: [0, 4, 7, 10],
    i: [0, 3, 7], i7: [0, 3, 7, 10], iiDim: [2, 5, 8], III: [3, 7, 10], III7m: [3, 7, 10, 1],
    iv: [5, 8, 0], iv7: [5, 8, 0, 3], IV7m: [5, 9, 0, 3], v: [7, 10, 2], V7m: [7, 11, 2, 5],
    VI: [8, 0, 3], VImaj7: [8, 0, 3, 7], VII: [10, 2, 5], VIIm7: [10, 1, 5, 8],
  };

  // 旧 harmonicFunctionForToken のリスト照合(同時点)と同じ写像。
  const LEGACY_FUNCTIONS: Record<HarmonicFunction, readonly string[]> = {
    tonic: ['I', 'vi', 'vi7', 'iii', 'iii7', 'i', 'i7', 'III'],
    predominant: ['IV', 'IVM7', 'ii', 'ii7', 'iv', 'iv7', 'IV7m', 'iiDim', 'VI', 'VImaj7', 'VIIm7'],
    dominant: ['V', 'III7', 'I7', 'V7m', 'v', 'v7', 'VII', 'III7m'],
    colour: [],
  };

  it('既存トークンのtones(並び含む)が変わっていない', () => {
    for (const [token, tones] of Object.entries(LEGACY_TONES)) {
      expect([...CHORDS[token]!.tones], token).toEqual([...tones]);
    }
  });

  it('既存トークンの機能写像が変わっていない', () => {
    for (const [fn, tokens] of Object.entries(LEGACY_FUNCTIONS)) {
      for (const token of tokens) {
        expect(harmonicFunctionForToken(token), token).toBe(fn);
      }
    }
    expect(harmonicFunctionForToken('unknown-token')).toBe('colour');
  });

  it('全トークンでtonesはrootから始まる(編曲層がtones[0]をルートとして読む)', () => {
    for (const [token, def] of Object.entries(CHORDS)) {
      expect(def.tones[0], token).toBe(def.root);
      expect(def.tones.length, token).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('イントロ接近和音(approachTokenFor)のメタデータ化は旧リテラル判定と等価', () => {
  // 旧実装(トークン名のリスト照合)。root メタデータ判定への置換の等価性の根拠。
  const legacyApproach = (entryToken: string, tonality: ProgressionTonality): string => {
    const entryFunction = harmonicFunctionForToken(entryToken);
    if (entryFunction === 'tonic') return tonality === 'minor' ? 'V7m' : 'V';
    if (entryFunction === 'dominant') return tonality === 'minor' ? 'iv' : 'IV';
    if (entryFunction === 'predominant') {
      if (tonality === 'major' && ['IV', 'IVM7'].includes(entryToken)) return 'I7';
      if (tonality === 'major' && ['ii', 'ii7'].includes(entryToken)) return 'vi';
      if (tonality === 'minor' && entryToken === 'iiDim') return 'VI';
      return tonality === 'minor' ? 'i' : 'I';
    }
    return tonality === 'minor' ? 'V7m' : 'V';
  };

  it('全進行 × 全調性実体の到達可能なA冒頭トークンで戻り値が一致する', () => {
    for (const tonality of ['major', 'minor'] as const) {
      for (const prog of progressionsForTonality(tonality)) {
        // entryToken は harmony[0].tokens[0] = 先頭スロットの各選択肢の最初のトークン。
        for (const option of prog.slots[0]!) {
          const entry = option[0]!;
          expect(approachTokenFor(entry, tonality), `${prog.id}/${tonality}/${entry}`)
            .toBe(legacyApproach(entry, tonality));
        }
      }
    }
  });
});

describe('新トークン(カラーコード・借用)の導出', () => {
  it('機能メタデータが意図どおり', () => {
    const expected: Record<string, HarmonicFunction> = {
      IM7: 'tonic', I6: 'tonic', Iadd9: 'tonic', IIIM7: 'tonic',
      IVadd9: 'predominant',
      Vsus4: 'dominant', VIIM7: 'dominant',
      vii: 'colour',
    };
    for (const [token, fn] of Object.entries(expected)) {
      expect(harmonicFunctionForToken(token), token).toBe(fn);
    }
  });

  it('tonesが品質表から正しく導出される', () => {
    expect([...CHORDS.IM7!.tones]).toEqual([0, 4, 7, 11]);
    expect([...CHORDS.I6!.tones]).toEqual([0, 4, 7, 9]);
    expect([...CHORDS.Iadd9!.tones]).toEqual([0, 4, 7, 2]);
    expect([...CHORDS.IVadd9!.tones]).toEqual([5, 9, 0, 7]);
    expect([...CHORDS.Vsus4!.tones]).toEqual([7, 0, 2]);
    expect([...CHORDS.VIIM7!.tones]).toEqual([10, 2, 5, 9]);
    expect([...CHORDS.IIIM7!.tones]).toEqual([3, 7, 10, 2]);
    expect([...CHORDS.vii!.tones]).toEqual([10, 1, 5]);
  });

  it('借用解釈: 長調のv7はミクソリディア借用、短調ではダイアトニック', () => {
    const major = chordOriginsFor('v7', 'major')!;
    expect(major.diatonic).toBe(false);
    expect(major.modes).toContain('mixolydian');
    expect(chordOriginsFor('v7', 'minor')!.diatonic).toBe(true);
  });

  it('借用解釈: ♭VIIM7は長調でミクソリディア、短調でドリアン借用', () => {
    const major = chordOriginsFor('VIIM7', 'major')!;
    expect(major.diatonic).toBe(false);
    expect(major.modes).toContain('mixolydian');
    const minor = chordOriginsFor('VIIM7', 'minor')!;
    expect(minor.diatonic).toBe(false);
    expect(minor.modes).toContain('dorian');
  });

  it('借用解釈: ♭IIIM7は短調でダイアトニック、長調で同主短調(エオリア)借用', () => {
    expect(chordOriginsFor('IIIM7', 'minor')!.diatonic).toBe(true);
    const major = chordOriginsFor('IIIM7', 'major')!;
    expect(major.diatonic).toBe(false);
    expect(major.modes).toContain('aeolian');
  });

  it('借用解釈: ♭VIImはフリギア借用で、機能はcolour', () => {
    const minor = chordOriginsFor('vii', 'minor')!;
    expect(minor.diatonic).toBe(false);
    expect(minor.modes).toContain('phrygian');
    expect(harmonicFunctionForToken('vii')).toBe('colour');
  });

  it('セカンダリードミナント解釈: III7=V/vi、I7=V/IV。主要ドミナントは含めない', () => {
    expect(chordOriginsFor('III7', 'major')!.secondaryDominantOf).toBe(9);
    expect(chordOriginsFor('III7', 'major')!.modes).toHaveLength(0);
    expect(chordOriginsFor('I7', 'major')!.secondaryDominantOf).toBe(5);
    // V7m(短調の主要ドミナント)はV/iとは呼ばない。和声的短音階由来として導出される。
    const primary = chordOriginsFor('V7m', 'minor')!;
    expect(primary.secondaryDominantOf).toBeNull();
    expect(primary.modes).toContain('harmonicMinor');
    // 短調のIV7mはドリアン借用ともV/VIIとも読める。単一ラベルへ丸めず両方返す。
    const dual = chordOriginsFor('IV7m', 'minor')!;
    expect(dual.modes).toContain('dorian');
    expect(dual.secondaryDominantOf).toBe(10);
  });
});

describe('pcmVoicesは編曲層のパラメータでcompose()に影響しない', () => {
  it('同一曲へのpcmVoices指定でPiece層は1音も変わらない', () => {
    const base = {
      progressionId: 'relative-orbit', styleId: 'kmmo', keyRoot: 2, bpm: 100, bars: 16, seed: 8,
      soundChip: 'pcm',
    } as const;
    expect(digestPiece(compose({ ...base, pcmVoices: { bass: { bank: 0, program: 33 } } })))
      .toEqual(digestPiece(compose(base)));
  });
});
