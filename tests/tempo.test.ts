import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { diagnosePiece, validatePiece } from '../src/core/music/diagnostics.js';
import {
  FERMATA_FACTOR, RITARDANDO_BARS, RITARDANDO_FINAL_FACTOR, beatToSeconds, bpmAt, constantTempoMap,
  overlayTempoMap, ritardandoTempoMap, secondsToBeat, sectionTempoMap, tempoMapOf,
} from '../src/core/music/tempo.js';
import { arrangeSf2Parts } from '../src/audio/pcm-arrange.js';
import { pieceToSmf } from '../src/audio/midi-export.js';
import { arrangePiece } from '../src/audio/opll-arrange.js';
import type { ComposeOptions, SongFormSpec } from '../src/core/music/types.js';

/**
 * テンポ写像(tempo.ts)の規約を固定する:
 * - 一定テンポは従来の線形変換と同じ(写像を持たない曲は 1 サンプルも変わらない)
 * - 区分一定の積分と逆変換が往復する
 * - リタルダンドは単調減速で終止和音が延び、区間テンポは区間頭で切り替わる
 * - レンダラ(PCM / OPLL / MIDI)は写像で秒へ写す
 */

const base: Omit<ComposeOptions, 'form'> = {
  progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 120, seed: 9,
};

describe('テンポ写像', () => {
  it('一定テンポは線形変換と一致し、写像の無い曲は補完される', () => {
    const map = constantTempoMap(120);
    for (const beat of [0, 1, 2.5, 7 / 3, 40]) {
      expect(beatToSeconds(map, beat)).toBeCloseTo(beat * 0.5, 12);
      expect(secondsToBeat(map, beat * 0.5)).toBeCloseTo(beat, 12);
    }
    expect(tempoMapOf({ bpm: 150 })).toEqual([{ beat: 0, bpm: 150 }]);
    expect(bpmAt(map, 99)).toBe(120);
  });

  it('区分一定の積分と逆変換が往復し、bpmAt は点の左側で前の値を返す', () => {
    const map = [{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60 }, { beat: 6, bpm: 240 }];
    expect(beatToSeconds(map, 4)).toBeCloseTo(2, 12);
    expect(beatToSeconds(map, 6)).toBeCloseTo(2 + 2, 12);
    expect(beatToSeconds(map, 10)).toBeCloseTo(4 + 1, 12);
    expect(bpmAt(map, 3.999)).toBe(120);
    expect(bpmAt(map, 4)).toBe(60);
    expect(bpmAt(map, 5.5)).toBe(60);
    for (const beat of [0, 0.5, 4, 4 + 1 / 3, 5.999, 6, 9.25, 30]) {
      expect(secondsToBeat(map, beatToSeconds(map, beat))).toBeCloseTo(beat, 9);
    }
    // 秒は拍に対して単調増加。
    let previous = -1;
    for (let beat = 0; beat <= 12; beat += 0.25) {
      const seconds = beatToSeconds(map, beat);
      expect(seconds).toBeGreaterThan(previous);
      previous = seconds;
    }
  });

  it('リタルダンドは最終 2 小節を拍ごとに単調減速し、終止和音(最終 2 拍)をさらに延ばす', () => {
    const map = ritardandoTempoMap(120, 32);
    expect(map[0]).toEqual({ beat: 0, bpm: 120 });
    expect(map.length).toBe(1 + RITARDANDO_BARS * 4);
    const rit = map.slice(1);
    expect(rit[0]!.beat).toBe(24);
    for (let index = 1; index < rit.length; index++) expect(rit[index]!.bpm).toBeLessThan(rit[index - 1]!.bpm);
    // 最終拍の減速係数は RITARDANDO_FINAL_FACTOR、終止和音はさらに FERMATA_FACTOR で割る。
    expect(rit.at(-1)!.bpm).toBeCloseTo((120 * RITARDANDO_FINAL_FACTOR) / FERMATA_FACTOR, 9);
    expect(rit.at(-3)!.bpm).toBeGreaterThan(rit.at(-2)!.bpm * FERMATA_FACTOR * 0.9);
    // 全体は一定テンポより長く、最終 2 拍は一定テンポの 2 拍(1 秒)の 3 倍以上。
    expect(beatToSeconds(map, 32)).toBeGreaterThan(16);
    expect(beatToSeconds(map, 32) - beatToSeconds(map, 30)).toBeGreaterThan(3);
  });

  it('区間テンポは区間頭で切り替わり、リタルダンドは区間テンポの上に相対で乗る', () => {
    const sections = [{ startBar: 0, tempo: undefined }, { startBar: 8, tempo: 90 }, { startBar: 16 }];
    expect(sectionTempoMap(120, 4, [{ startBar: 0 }, { startBar: 8 }])).toBeNull();
    const map = sectionTempoMap(120, 4, sections)!;
    expect(map).toEqual([{ beat: 0, bpm: 120 }, { beat: 36, bpm: 90 }, { beat: 68, bpm: 120 }]);
    const combined = overlayTempoMap(map, ritardandoTempoMap(120, 100));
    expect(bpmAt(combined, 40)).toBe(90);
    expect(bpmAt(combined, 70)).toBe(120);
    expect(bpmAt(combined, 92)).toBeLessThan(120);
    expect(bpmAt(combined, 99)).toBeCloseTo((120 * RITARDANDO_FINAL_FACTOR) / FERMATA_FACTOR, 9);
  });
});

describe('終わり方 ritardando の曲', () => {
  const form: SongFormSpec = {
    sections: [
      { id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A' },
      { id: 'B', role: 'finale', bars: 8, energy: 4, theme: 'B', tempo: 100 },
    ],
    ending: 'ritardando',
  };
  const piece = compose({ ...base, form, intro: false });

  it('終止で閉じ、写像を持ち、生成検証・診断エラーがゼロ', () => {
    expect(piece.ending).toBe('ritardando');
    expect(piece.chords.at(-1)!.token).toBe('I');
    expect(piece.phrasePlan.bars.at(-1)!.cadence).toBe('closed');
    expect(validatePiece(piece)).toEqual([]);
    expect(diagnosePiece(piece).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    const map = tempoMapOf(piece);
    expect(bpmAt(map, 0)).toBe(120);
    expect(bpmAt(map, 32)).toBe(100);
    expect(bpmAt(map, 63)).toBeCloseTo((100 * RITARDANDO_FINAL_FACTOR) / FERMATA_FACTOR, 9);
  });

  it('PCM 編曲の発音秒は写像で写り、最終和音が延びる', () => {
    const parts = arrangeSf2Parts(piece);
    const map = tempoMapOf(piece);
    const backing = parts.backing.sort((a, b) => a.startSec - b.startSec);
    const last = backing.at(-1)!;
    expect(last.startSec).toBeCloseTo(beatToSeconds(map, 62), 6);
    // 一定テンポなら 2 拍=1 秒。減速+フェルマータで 3 秒以上。
    expect(last.durSec).toBeGreaterThan(3);
    const first = backing[0]!;
    expect(first.startSec).toBe(0);
  });

  it('OPLL 編曲の総時間とループ点も写像から', () => {
    const arranged = arrangePiece(piece, 'eurobeat');
    const map = tempoMapOf(piece);
    expect(arranged.loopEnd).toBeCloseTo(beatToSeconds(map, piece.beats), 6);
    expect(arranged.loopEnd).toBeGreaterThan(64 * 0.5);
  });

  it('MIDI 書き出しは写像の点ごとにテンポイベントを持ち、音符のティックは拍のまま', () => {
    const smf = pieceToSmf(piece);
    const bytes = [...smf];
    let tempoEvents = 0;
    for (let index = 0; index + 2 < bytes.length; index++) {
      if (bytes[index] === 0xff && bytes[index + 1] === 0x51 && bytes[index + 2] === 0x03) tempoEvents++;
    }
    expect(tempoEvents).toBe(tempoMapOf(piece).length);
    // 一定テンポの曲はテンポイベント 1 つ(従来どおり)。
    const steady = compose({ ...base, form: 'loop8' });
    expect([...pieceToSmf(steady)].filter((_, index, all) => (
      all[index] === 0xff && all[index + 1] === 0x51 && all[index + 2] === 0x03
    )).length).toBe(1);
  });
});
