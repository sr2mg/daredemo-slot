import { describe, expect, it } from 'vitest';
import { renderSf2 } from '../src/audio/sf2.js';
import type { Sf2Font, Sf2Preset, Sf2Zone } from '../src/audio/sf2.js';

/**
 * フォントスタック(Sf2FontStack)の解決順の検証:
 * 「主フォントの正確な一致 > 補完フォントの正確な一致 > 劣化代替(bank128任意→
 * 同番号→ピアノ)」。合成フォント(手組みのサイン波サンプル)で、どのフォントの
 * サンプルが鳴ったかを振幅の違いから判別する。
 */

/** 一定振幅の矩形波もどき1周期を持つ極小フォントを作る。振幅でフォントを識別する。 */
function makeFont(presetDefs: { bank: number; program: number }[], amplitude: number): Sf2Font {
  const length = 400;
  const sampleData = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    sampleData[i] = Math.round((i % 100 < 50 ? 1 : -1) * amplitude * 32767);
  }
  const zone: Sf2Zone = {
    keyLo: 0,
    keyHi: 127,
    velLo: 0,
    velHi: 127,
    sample: {
      name: 'osc',
      start: 0,
      end: length,
      loopStart: 0,
      loopEnd: length - 1,
      rate: 44100,
      originalKey: 60,
      correction: 0,
      type: 1,
    },
    rootKey: 60,
    cents: 0,
    scaleTuning: 100,
    sampleModes: 1,
    attenuationCb: 0,
    exclusiveClass: 0,
    delaySec: 0.001,
    attackSec: 0.001,
    holdSec: 10,
    decaySec: 10,
    sustainLevel: 1,
    releaseSec: 0.001,
  };
  const presets: Sf2Preset[] = presetDefs.map(({ bank, program }) => ({
    name: `p${bank}:${program}`,
    bank,
    program,
    zones: [zone],
  }));
  return { presets, sampleData };
}

const peak = (wave: Float32Array): number => {
  let max = 0;
  for (let i = 0; i < wave.length; i++) max = Math.max(max, Math.abs(wave[i]!));
  return max;
};

const note = (program: number, bank = 0) => [
  { program, bank, midi: 60, velocity: 127, startSec: 0, durSec: 0.1, gain: 1 },
];

describe('SoundFontスタックの補完解決', () => {
  // 主フォント(振幅1.0)はprogram 0とドラムのみ。補完(振幅0.5)はフルGM相当。
  const primary = makeFont([{ bank: 0, program: 0 }, { bank: 128, program: 0 }], 1.0);
  const complement = makeFont(
    [{ bank: 0, program: 0 }, { bank: 0, program: 46 }, { bank: 128, program: 0 }],
    0.5,
  );

  it('主フォントにあるプリセットは主フォントが鳴る', () => {
    const wave = renderSf2([primary, complement], note(0), 44100, 0.2);
    expect(peak(wave)).toBeGreaterThan(0.15); // 振幅1.0系(×0.25スケール)
  });

  it('主フォントに無いプリセットは補完フォントの正確な一致が鳴る(主のピアノ代替より優先)', () => {
    const wave = renderSf2([primary, complement], note(46), 44100, 0.2);
    const amplitude = peak(wave);
    expect(amplitude).toBeGreaterThan(0.05);
    expect(amplitude).toBeLessThan(0.15); // 振幅0.5系=補完側が選ばれた証拠
  });

  it('どちらにも無いプリセットは従来どおりピアノへ劣化する(主フォント優先)', () => {
    const wave = renderSf2([primary, complement], note(99), 44100, 0.2);
    expect(peak(wave)).toBeGreaterThan(0.15); // 主フォントのpiano
  });

  it('単一フォント渡し(後方互換)も同じ結果になる', () => {
    const single = renderSf2(primary, note(0), 44100, 0.2);
    const stacked = renderSf2([primary], note(0), 44100, 0.2);
    expect(Array.from(stacked)).toEqual(Array.from(single));
  });

  it('ドラム(bank128)はスタック先頭のキットが鳴る', () => {
    const wave = renderSf2([primary, complement], note(0, 128), 44100, 0.2);
    expect(peak(wave)).toBeGreaterThan(0.15);
  });
});
