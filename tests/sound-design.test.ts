import { describe, expect, it } from 'vitest';
import {
  panGains,
  pingPongDelay,
  stereoChorus,
  stereoReverb,
  withEchoTracks,
} from '../src/ui/sound-design.js';

describe('エコートラック(MIDI段ディレイ)', () => {
  it('遅延コピーを拍指定+減衰で複製する', () => {
    const notes = [{ startSec: 1.0, gain: 0.8 }];
    const result = withEchoTracks(notes, { delayBeats: 0.75, taps: 2, decay: 0.5 }, 0.5);
    expect(result).toHaveLength(3);
    expect(result[1]!.startSec).toBeCloseTo(1.375, 6); // +0.75拍(spb=0.5)
    expect(result[1]!.gain).toBeCloseTo(0.4, 6);
    expect(result[2]!.startSec).toBeCloseTo(1.75, 6);
    expect(result[2]!.gain).toBeCloseTo(0.2, 6);
  });
});

describe('等パワーパン', () => {
  it('端で片チャンネル、中央で等分', () => {
    const [hardLeftL, hardLeftR] = panGains(-1);
    expect(hardLeftL).toBeCloseTo(1, 6);
    expect(hardLeftR).toBeCloseTo(0, 6);
    const [centerL, centerR] = panGains(0);
    expect(centerL).toBeCloseTo(Math.SQRT1_2, 6);
    expect(centerR).toBeCloseTo(Math.SQRT1_2, 6);
  });
});

describe('ピンポン・フィードバックディレイ', () => {
  it('インパルスが左→右の順に遅延して跳ね返る', () => {
    const rate = 1000;
    const input = new Float32Array(1000);
    input[0] = 1;
    const { left, right } = pingPongDelay(input, rate, 0.1, 0.5); // 100サンプル遅延
    expect(left[100]!).toBeGreaterThan(0.9); // 1発目は左
    expect(Math.abs(right[100]!)).toBeLessThan(0.01); // このとき右は無音
    expect(right[200]!).toBeGreaterThan(0.03); // 2発目は右(減衰+ダンプ済み)
    expect(Math.abs(left[100]!)).toBeGreaterThan(Math.abs(right[200]!)); // 減衰している
  });
});

describe('ステレオリバーブ/コーラス', () => {
  const rate = 8000;
  const impulse = new Float32Array(rate);
  impulse[0] = 1;

  it('リバーブは左右で異なる残響尾を持つ', () => {
    const { left, right } = stereoReverb(impulse, rate);
    const tail = (wave: Float32Array): number =>
      wave.slice(400, 4000).reduce((sum, v) => sum + Math.abs(v), 0);
    expect(tail(left)).toBeGreaterThan(0.1);
    expect(tail(right)).toBeGreaterThan(0.1);
    let differs = false;
    for (let i = 400; i < 4000; i++) {
      if (Math.abs(left[i]! - right[i]!) > 1e-4) { differs = true; break; }
    }
    expect(differs).toBe(true);
    expect(left.some((v) => !Number.isFinite(v))).toBe(false);
  });

  it('コーラスは入力を変調遅延で揺らす', () => {
    const tone = new Float32Array(rate);
    for (let i = 0; i < rate; i++) tone[i] = Math.sin(2 * Math.PI * 220 * (i / rate));
    const { left, right } = stereoChorus(tone, rate);
    const rms = (wave: Float32Array): number =>
      Math.sqrt(wave.slice(800).reduce((sum, v) => sum + v * v, 0) / (wave.length - 800));
    expect(rms(left)).toBeGreaterThan(0.3);
    expect(rms(right)).toBeGreaterThan(0.3);
    let differs = false;
    for (let i = 800; i < rate; i++) {
      if (Math.abs(left[i]! - right[i]!) > 1e-3) { differs = true; break; }
    }
    expect(differs).toBe(true); // LFO位相反転で左右が別の揺れ方をする
  });
});
