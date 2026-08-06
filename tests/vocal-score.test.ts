import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import type { ComposeOptions, Piece } from '../src/core/music/compose.js';
import { midiToHz, vocalEnsembleFor, vocalScoreFor } from '../src/core/music/vocal-score.js';
import { mixVocalIntoWave, renderVocalWave } from '../src/ui/vocal-audio.js';

/**
 * ハミング声部の検証。
 * - 設計層（vocal-score）はスケジュールの性質を純関数として検証する
 * - 音響層は klattsch（固定シードxorshift＝決定論）でレンダリングし、
 *   自己相関でF0が旋律の音高を実際に追っていることを聴かずに確認する
 */

const base: ComposeOptions = {
  progressionId: 'minor-incantation',
  styleId: 'eurobeat',
  keyRoot: 0,
  bpm: 140,
  bars: 4,
  tonality: 'minor',
  seed: 5,
};

const structuralMelody = (piece: Piece) => piece.melody
  .filter((note) => note.role !== 'ornament' && note.dur > 0)
  .slice()
  .sort((a, b) => a.beat - b.beat);

describe('vocalScoreFor（設計層）', () => {
  const piece = compose(base);
  const score = vocalScoreFor(piece, { vibratoScale: 0 });
  const msPerBeat = 60000 / piece.bpm;

  it('総尺は曲の拍数どおり、イベントは時刻昇順', () => {
    expect(score.totalMs).toBeCloseTo(piece.beats * msPerBeat, 6);
    for (let i = 1; i < score.events.length; i++) {
      expect(score.events[i]!.atMs).toBeGreaterThanOrEqual(score.events[i - 1]!.atMs);
    }
  });

  it('各ノートオンのF0は主旋律の1オクターブ下の音高と一致する', () => {
    const notes = structuralMelody(piece);
    const expected = new Set(notes.map((note) => midiToHz(note.midi - 12).toFixed(3)));
    const noteOns = score.events.filter((event) => event.target.voicing === 1);
    expect(noteOns.length).toBe(notes.length);
    for (const event of noteOns) {
      expect(expected.has(event.target.F0!.toFixed(3)), `atMs=${event.atMs}`).toBe(true);
    }
  });

  it('休符でvoicingを落とし、長い休みの前後で吸気を置く曲が存在する', () => {
    expect(score.events.some((event) => event.target.voicing === 0)).toBe(true);
    const breathes = Array.from({ length: 8 }, (_, seed) => {
      const candidate = vocalScoreFor(compose({ ...base, bars: 8, seed }), { vibratoScale: 0 });
      return candidate.events.some((event) => event.target.aspiration === 0.32);
    });
    expect(breathes.some(Boolean)).toBe(true);
  });

  it('十分長いノートには遅延ビブラートが付き、vibratoScale 0 で消える', () => {
    const seeds = Array.from({ length: 8 }, (_, seed) => seed);
    const withVibrato = seeds.map((seed) => {
      const candidate = vocalScoreFor(compose({ ...base, bars: 8, seed }));
      return candidate.events.some((event) => (event.target.vibratoDepth ?? 0) > 0);
    });
    expect(withVibrato.some(Boolean)).toBe(true);
    expect(score.events.every((event) => (event.target.vibratoDepth ?? 0) === 0)).toBe(true);
  });

  it('同じ入力から同じスケジュールを返す（決定論）', () => {
    expect(vocalScoreFor(piece, { vibratoScale: 0 })).toEqual(score);
  });
});

describe('vocalEnsembleFor（コーラス）', () => {
  it('副旋律がある曲のコーラスは副旋律を原音域で歌う', () => {
    const piece = Array.from({ length: 32 }, (_, seed) => compose({ ...base, bars: 8, seed }))
      .find((candidate) => candidate.counterMelody.some((note) => note.role !== 'ornament'))!;
    expect(piece).toBeDefined();
    const scores = vocalEnsembleFor(piece, { chorus: true });
    expect(scores).toHaveLength(2);
    const counterNotes = piece.counterMelody.filter((note) => note.role !== 'ornament' && note.dur > 0);
    const noteOns = scores[1]!.events.filter((event) => event.target.voicing === 1);
    expect(noteOns.length).toBe(counterNotes.length);
    const expected = new Set(counterNotes.map((note) => midiToHz(note.midi, 5).toFixed(3)));
    for (const event of noteOns) {
      expect(expected.has(event.target.F0!.toFixed(3))).toBe(true);
    }
  });

  it('副旋律がない曲のコーラスは主旋律のデチューン・ダブルになる', () => {
    const piece = Array.from({ length: 32 }, (_, seed) => compose({ ...base, seed }))
      .find((candidate) => candidate.counterMelody.length === 0);
    expect(piece).toBeDefined();
    const scores = vocalEnsembleFor(piece!, { chorus: true });
    expect(scores).toHaveLength(2);
    const leadOns = scores[0]!.events.filter((event) => event.target.voicing === 1);
    const doubleOns = scores[1]!.events.filter((event) => event.target.voicing === 1);
    expect(doubleOns.length).toBe(leadOns.length);
    const detune = 2 ** (-9 / 1200);
    for (let i = 0; i < leadOns.length; i++) {
      expect(doubleOns[i]!.target.F0!).toBeCloseTo(leadOns[i]!.target.F0! * detune, 6);
    }
  });
});

describe('renderVocalWave（音響層）', () => {
  const SR = 16000;
  const piece = compose(base);
  const wave = renderVocalWave(piece, { vowel: 'hum' }, SR);

  /** lagサンプル周期に対する正規化自己相関。1に近いほどその周期で周期的。 */
  const autocorrAt = (start: number, length: number, lag: number): number => {
    let cross = 0;
    let energyA = 0;
    let energyB = 0;
    for (let i = start; i < start + length; i++) {
      const a = wave[i]!;
      const b = wave[i + lag]!;
      cross += a * b;
      energyA += a * a;
      energyB += b * b;
    }
    return energyA === 0 || energyB === 0 ? 0 : cross / Math.sqrt(energyA * energyB);
  };

  it('曲の長さぶんの有限な波形が決定論的に出る', () => {
    expect(wave.length).toBe(Math.ceil(piece.beats * (60000 / piece.bpm) * SR / 1000));
    expect(wave.every((sample) => Number.isFinite(sample))).toBe(true);
    const again = renderVocalWave(piece, { vowel: 'hum' }, SR);
    expect(again).toEqual(wave);
  });

  /** 探索範囲内の最初の強い自己相関ピークを放物線補間つきで周期として推定する。 */
  const estimatePeriod = (start: number, window: number): number => {
    const lo = Math.floor(SR / 700);
    const hi = Math.ceil(SR / 150);
    const acf = Array.from({ length: hi - lo + 1 }, (_, i) => autocorrAt(start, window, lo + i));
    const best = Math.max(...acf);
    // 倍周期（2T, 3T…）も同程度に相関するため、最初に最大近傍へ達したlagを基本周期とみなす。
    const index = acf.findIndex((value) => value >= best * 0.97);
    const lag = lo + index;
    const a = acf[index - 1] ?? acf[index]!;
    const b = acf[index]!;
    const c = acf[index + 1] ?? acf[index]!;
    const denom = a - 2 * b + c;
    const delta = denom === 0 ? 0 : Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / denom));
    return lag + delta;
  };

  it('ノート中央のF0が主旋律の1オクターブ下の音高を追う', () => {
    const msPerBeat = 60000 / piece.bpm;
    const notes = structuralMelody(piece)
      .filter((note) => note.dur * msPerBeat >= 250 && note.dur * msPerBeat < 500)
      .slice(0, 4);
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      const hz = midiToHz(note.midi - 12);
      const centerMs = (note.beat + note.dur / 2) * msPerBeat;
      const start = Math.floor(centerMs * SR / 1000);
      const window = Math.floor(SR * 0.06);
      const matched = autocorrAt(start, window, Math.round(SR / hz));
      expect(matched, `beat=${note.beat} hz=${hz.toFixed(1)} 周期性`).toBeGreaterThan(0.8);
      const estimated = SR / estimatePeriod(start, window);
      // 半音=6%を確実に弾ける3%以内で、推定F0が設計どおりの音高に一致する。
      expect(Math.abs(estimated - hz) / hz, `beat=${note.beat} 推定${estimated.toFixed(1)}Hz`)
        .toBeLessThan(0.03);
    }
  });

  it('ミックスは楽器波形の長さを保ち、静かな区間では素通しになる', () => {
    const instrumental = new Float32Array(wave.length + 500).fill(0.1);
    const mixed = mixVocalIntoWave(instrumental, wave, 0.5);
    expect(mixed.length).toBe(instrumental.length);
    expect(mixed[wave.length + 100]).toBeCloseTo(0.1, 6);
    expect(mixed.every((sample) => sample >= -1 && sample <= 1)).toBe(true);
  });
});
