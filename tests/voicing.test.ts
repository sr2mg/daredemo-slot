import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { CHORDS } from '../src/core/music/theory.js';
import type { ComposeOptions } from '../src/core/music/types.js';
import { hasSecondCluster, voiceChord } from '../src/core/music/voicing.js';

/**
 * 伴奏ボイシングの音塊回避(rev7)。
 * 音塊 = 隣り合う3声が長3度以内(2度が2つ連続)。テンションを足した5声の和音を最短連結だけで
 * 選ぶとここへ寄るので、音塊にならない配置があるときはその中から選ぶ。
 */

const pcsOf = (token: string, extra: readonly number[] = []): number[] => [...CHORDS[token]!.tones, ...extra];

describe('音塊の判定(hasSecondCluster)', () => {
  it('隣り合う3声が長3度以内なら音塊', () => {
    expect(hasSecondCluster([59, 61, 63, 64, 68])).toBe(true); // B C# D# E G#
    expect(hasSecondCluster([60, 62, 64, 67])).toBe(true); // C D E G(add9 の密集)
  });

  it('2度が離れて1か所ずつなら音塊ではない', () => {
    expect(hasSecondCluster([61, 64, 68, 71, 75])).toBe(false); // 3度堆積の m9
    expect(hasSecondCluster([62, 64, 67, 72])).toBe(false); // D E G C
    expect(hasSecondCluster([59, 63, 64, 68])).toBe(false); // M7 の転回(短2度は1か所)
  });
});

describe('voiceChord の音塊回避', () => {
  // 短調 i7 に 9th を足した m9(主音 0)。直前の配置は音塊へ寄りやすい低めの密集。
  const minorNinth = pcsOf('i7', [2]);
  const previous = [58, 60, 62, 63, 67];

  it('avoidClusters なしは従来どおり最短連結だけで選ぶ(音塊を許す)', () => {
    expect(hasSecondCluster(voiceChord(minorNinth, previous))).toBe(true);
  });

  it('avoidClusters ありは音塊にならない配置を選び、構成音は変えない', () => {
    const voiced = voiceChord(minorNinth, previous, false, true);
    expect(hasSecondCluster(voiced)).toBe(false);
    expect([...new Set(voiced.map((midi) => midi % 12))].sort((a, b) => a - b))
      .toEqual([...minorNinth].sort((a, b) => a - b));
    expect(voiced.at(-1)! - voiced[0]!).toBeLessThanOrEqual(14);
  });

  it('音塊を作れない三和音・七の和音は avoidClusters の有無で同じ配置', () => {
    for (const token of ['I', 'i', 'V7m', 'IVM7', 'vi7', 'I6', 'Vsus4', 'iim7b5']) {
      for (const reference of [null, [57, 60, 64, 67], [55, 59, 62, 65]]) {
        expect(voiceChord(pcsOf(token), reference, false, true), token)
          .toEqual(voiceChord(pcsOf(token), reference));
      }
    }
  });
});

describe('rev7: 本編の伴奏は音塊を避ける', () => {
  const lush: ComposeOptions = {
    progressionId: 'neapolitan-drift', styleId: 'dnb', keyRoot: 1, bpm: 148, form: 'loop16', intro: false,
    tonality: 'minor', tensionPolicy: 'lush', seed: 3, soundChip: 'pcm',
  };

  it('rev6 は5声の和音が音塊になり、rev7 は全和音が音塊を持たない', () => {
    const rev6 = compose({ ...lush, engineRev: 6 });
    const rev7 = compose({ ...lush, engineRev: 7 });
    expect(rev6.chords.some((chord) => hasSecondCluster(chord.midis))).toBe(true);
    expect(rev7.chords.filter((chord) => hasSecondCluster(chord.midis))).toEqual([]);
  });

  it('変わるのは配置だけで、和音の構成音・旋律・ベースは rev6 と同じ', () => {
    const rev6 = compose({ ...lush, engineRev: 6 });
    const rev7 = compose({ ...lush, engineRev: 7 });
    expect(rev7.chords.map((chord) => [chord.token, chord.pcs, chord.colorPcs]))
      .toEqual(rev6.chords.map((chord) => [chord.token, chord.pcs, chord.colorPcs]));
    expect(rev7.melody).toEqual(rev6.melody);
    expect(rev7.bass).toEqual(rev6.bass);
  });
});
