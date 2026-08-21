import { describe, expect, it } from 'vitest';
import { applyDrumBusFx } from '../src/audio/bus-fx.js';
import type { DrumBusFx } from '../src/audio/bus-fx.js';
import { arrangeSf2Parts, drumBusFxFor } from '../src/audio/pcm-arrange.js';
import { compose } from '../src/core/music/compose.js';
import { STYLES } from '../src/core/music/theory.js';

const SR = 44100;
const SPB = 60 / 170;

/** 主打(強スパイク)+ゴースト帯(弱い持続)の合成ドラム風信号。 */
function drumLikeSignal(): Float32Array {
  const samples = new Float32Array(SR);
  for (let i = 0; i < SR; i++) {
    samples[i] = 0.08 * Math.sin((2 * Math.PI * 180 * i) / SR);
  }
  for (const at of [0, 11025, 22050, 33075]) {
    for (let i = 0; i < 200; i++) {
      samples[at + i]! += 0.85 * Math.sin((2 * Math.PI * 60 * i) / SR) * (1 - i / 200);
    }
  }
  return samples;
}

const rms = (samples: Float32Array): number =>
  Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
const peak = (samples: Float32Array): number =>
  samples.reduce((max, v) => Math.max(max, Math.abs(v)), 0);

describe('ドラムバスFX', () => {
  it('バスコンプは大信号と小信号の比を圧縮する(主打に対するゴーストの相対持ち上げ)', () => {
    // 前半=主打相当の大振幅、後半=ゴースト相当の小振幅。比の圧縮だけを見る。
    const wet = new Float32Array(SR);
    for (let i = 0; i < SR; i++) {
      const amp = i < SR / 2 ? 0.9 : 0.09;
      wet[i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR);
    }
    const dry = wet.slice();
    const fx: DrumBusFx = {
      drive: 1,
      comp: { thresholdDbBelowPeak: 9, ratio: 4, attackMs: 8, releaseBeats: 0.25 },
      crush: null,
    };
    applyDrumBusFx(wet, SR, SPB, fx);
    // 立ち上がり・境界・リリース尾を避けた定常区間で測る。
    const loudRatio = rms(wet.subarray(4410, 22050)) / rms(dry.subarray(4410, 22050));
    const softRatio = rms(wet.subarray(SR - 8820, SR)) / rms(dry.subarray(SR - 8820, SR));
    expect(loudRatio).toBeLessThan(softRatio);
    // メイクアップはピーク一致(音量は上がらない)。
    expect(peak(wet)).toBeCloseTo(peak(dry), 3);
  });

  it('サチュレーションはピーク一致の正規化で音量でなく密度(実効値)を上げる', () => {
    const dry = drumLikeSignal();
    const wet = drumLikeSignal();
    applyDrumBusFx(wet, SR, SPB, { drive: 2, comp: null, crush: null });
    expect(peak(wet)).toBeCloseTo(peak(dry), 3);
    expect(rms(wet)).toBeGreaterThan(rms(dry));
  });

  it('クラッシュは振幅をビット格子へ量子化し、レート低下でサンプルを保持する', () => {
    const wet = drumLikeSignal();
    applyDrumBusFx(wet, SR, SPB, {
      drive: 1, comp: null, crush: { bits: 12, sampleRate: 26040 },
    });
    const step = 1 / 2 ** 11;
    for (const i of [100, 5000, 20000, 40000]) {
      const remainder = Math.abs(wet[i]! / step - Math.round(wet[i]! / step));
      expect(remainder, `sample ${i}`).toBeLessThan(1e-4);
    }
    // 26.04kHz/44.1kHz ≈ 0.59 なので、隣接サンプルの少なくとも4割は保持(同値)になる。
    let holds = 0;
    for (let i = 1; i < wet.length; i++) if (wet[i] === wet[i - 1]) holds++;
    expect(holds / wet.length).toBeGreaterThan(0.35);
  });

  it('drive=1・comp/crushなしは素通し', () => {
    const dry = drumLikeSignal();
    const wet = drumLikeSignal();
    applyDrumBusFx(wet, SR, SPB, { drive: 1, comp: null, crush: null });
    expect(wet).toEqual(dry);
  });
});

describe('スタイル別ドラムキットとバス宣言', () => {
  const pieceFor = (styleId: string) => compose({
    progressionId: 'royal-pop', styleId, keyRoot: 0, bpm: 170, bars: 4, seed: 42,
  });

  it('dnbはPowerキット(16)+潰す宣言、garage2stepはDanceキット(26)+軽い宣言', () => {
    const dnbDrums = arrangeSf2Parts(pieceFor('dnb')).drums;
    expect(dnbDrums.every((note) => note.bank === 128 && note.program === 16)).toBe(true);
    expect(drumBusFxFor('dnb')?.crush).not.toBeNull();
    const garageDrums = arrangeSf2Parts(pieceFor('garage2step')).drums;
    expect(garageDrums.every((note) => note.bank === 128 && note.program === 26)).toBe(true);
    expect(drumBusFxFor('garage2step')?.crush).toBeNull();
  });

  it('既存スタイルはスタンダードキット(0)のままバス宣言を持たない(後方互換)', () => {
    for (const style of STYLES) {
      if (style.id === 'dnb' || style.id === 'garage2step') continue;
      const drums = arrangeSf2Parts(pieceFor(style.id)).drums;
      expect(drums.every((note) => note.bank === 128 && note.program === 0), style.id).toBe(true);
      expect(drumBusFxFor(style.id), style.id).toBeNull();
    }
  });

  it('ユーザーのドラム上書きはスタイル既定キットに勝つ', () => {
    const drums = arrangeSf2Parts(pieceFor('dnb'), { drums: { bank: 128, program: 25 } }).drums;
    expect(drums.every((note) => note.program === 25)).toBe(true);
  });
});
