import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { arrangeComposedBgm, isPcmBgm } from '../src/ui/bgm-audio.js';
import {
  NES_SAMPLE_RATE,
  pulseFrequencyForTimer,
  pulseTimerForMidi,
  renderNesPiece,
  triangleFrequencyForTimer,
  triangleTimerForMidi,
} from '../src/ui/nes-apu.js';

const options = {
  progressionId: 'royal-pop',
  styleId: 'eurobeat',
  keyRoot: 0,
  bpm: 170,
  bars: 4 as const,
  seed: 42,
};

describe('ファミコン2A03音源', () => {
  it('整数タイマーへ量子化し、実機式から同じ近似周波数を得る', () => {
    const pulseTimer = pulseTimerForMidi(69);
    const triangleTimer = triangleTimerForMidi(69);
    expect(pulseTimer).toBe(253);
    expect(triangleTimer).toBe(126);
    expect(pulseFrequencyForTimer(pulseTimer)).toBeCloseTo(440, 0);
    expect(triangleFrequencyForTimer(triangleTimer)).toBeCloseTo(440, 0);
  });

  it('曲尺どおりの有限PCMを決定論的に生成する', () => {
    const piece = compose(options);
    const a = renderNesPiece(piece, { pulse1Duty: 1, pulse2Duty: 2 });
    const b = renderNesPiece(piece, { pulse1Duty: 1, pulse2Duty: 2 });
    expect(a.length).toBe(Math.round(piece.beats * 60 / piece.bpm * NES_SAMPLE_RATE));
    expect(a).toEqual(b);
    let peak = 0;
    for (const sample of a) {
      expect(Number.isFinite(sample)).toBe(true);
      peak = Math.max(peak, Math.abs(sample));
    }
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(1);
  }, 10_000);

  it('パルスのデューティ変更が実波形を変える', () => {
    const piece = compose(options);
    const thin = renderNesPiece(piece, { pulse1Duty: 0, pulse2Duty: 0 });
    const square = renderNesPiece(piece, { pulse1Duty: 2, pulse2Duty: 2 });
    expect(thin).not.toEqual(square);
  });

  it('和風の「揺り」をパルス1のタイマー変化としてレンダリングする', () => {
    const piece = compose({
      ...options, progressionId: 'tanaka-manabe', seed: 1,
      melodyMode: 'japanese', japaneseScale: 'ritsu',
    });
    expect(piece.melody.some((note) => note.ornament === 'shake')).toBe(true);
    const withoutShake = {
      ...piece,
      melody: piece.melody.map((note) => {
        if (note.ornament !== 'shake') return note;
        const { ornament: _ornament, ...plainNote } = note;
        return plainNote;
      }),
    };
    expect(renderNesPiece(piece)).not.toEqual(renderNesPiece(withoutShake));
  }, 10_000);

  it('音源指定をPCM BGM定義へ統合し、旧曲はOPLLのまま保つ', () => {
    const piece = compose(options);
    const nes = arrangeComposedBgm(piece, { ...options, soundChip: 'nes2a03' });
    const legacy = arrangeComposedBgm(piece, options);
    expect(isPcmBgm(nes)).toBe(true);
    expect(isPcmBgm(legacy)).toBe(false);
  });

  it('16小節PCMにもイントロ後のループ区間を秒で持たせる', () => {
    const gameOptions = { ...options, bars: 16 as const, seed: 43, soundChip: 'nes2a03' as const };
    const piece = compose(gameOptions);
    const def = arrangeComposedBgm(piece, gameOptions);
    expect(isPcmBgm(def)).toBe(true);
    if (!isPcmBgm(def)) return;
    expect(def.loopStart).toBeCloseTo(piece.loopStartBeat * 60 / piece.bpm, 9);
    expect(def.loopEnd).toBeCloseTo(piece.beats * 60 / piece.bpm, 9);
    expect(def.loopStart).toBeGreaterThan(0);
    expect(def.loopEnd).toBeGreaterThan(def.loopStart);
  });
});
