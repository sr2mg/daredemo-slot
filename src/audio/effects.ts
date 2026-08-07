/**
 * オフラインDSPプリミティブ。カタログ(stage.ts/time-layer.ts)から独立した純関数群で、
 * 物理量(RT60、ms、Hz)だけを受け取る——DSPがカタログへ逆依存しない。
 */

import type { StereoWave } from './stage.js';

/**
 * Schroeder型ステレオリバーブ。
 * - フィードバックはRT60(秒)から導出: fb = 10^(-3·delay/RT60)
 * - プリディレイ: 直接音と尾を分離し、深い残響でも明瞭さを保つ古典則
 * - 左右でコム遅延を1.7%ずらしモノ送りから広がりを作る。ウェットのみ返す
 */
export function stereoReverb(
  input: Float32Array,
  sampleRate: number,
  rt60Sec: number,
  preDelayMs = 0,
): StereoWave {
  const preDelaySamples = Math.round((preDelayMs / 1000) * sampleRate);
  const render = (detune: number): Float32Array => {
    const combDelaysSec = [0.0297, 0.0371, 0.0411, 0.0437].map((sec) => sec * detune);
    const combBuffers = combDelaysSec.map((sec) => new Float32Array(Math.max(1, Math.round(sec * sampleRate))));
    const combFeedbacks = combDelaysSec.map((sec) => 10 ** (-3 * sec / Math.max(0.1, rt60Sec)));
    const combIndices = combDelaysSec.map(() => 0);
    const allpassBuffers = [5.0, 1.7].map((ms) => new Float32Array(Math.max(1, Math.round(ms * sampleRate / 1000))));
    const allpassIndices = allpassBuffers.map(() => 0);
    const allpassGain = 0.7;
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const dry = i >= preDelaySamples ? input[i - preDelaySamples]! : 0;
      let combSum = 0;
      for (let c = 0; c < combBuffers.length; c++) {
        const buffer = combBuffers[c]!;
        const index = combIndices[c]!;
        const delayed = buffer[index]!;
        buffer[index] = dry + delayed * combFeedbacks[c]!;
        combIndices[c] = (index + 1) % buffer.length;
        combSum += delayed;
      }
      let wet = combSum / combBuffers.length;
      for (let a = 0; a < allpassBuffers.length; a++) {
        const buffer = allpassBuffers[a]!;
        const index = allpassIndices[a]!;
        const delayed = buffer[index]!;
        const stageInput = wet;
        wet = -stageInput * allpassGain + delayed;
        buffer[index] = stageInput + delayed * allpassGain;
        allpassIndices[a] = (index + 1) % buffer.length;
      }
      out[i] = wet;
    }
    return out;
  };
  return { left: render(1.0), right: render(1.017) };
}

/** ステレオコーラス。LFO位相を左右反転したモジュレーテッドディレイ。ウェットのみ返す。 */
export function stereoChorus(input: Float32Array, sampleRate: number): StereoWave {
  const baseMs = 18;
  const depthMs = 5.5;
  const rateHz = 0.55;
  const maxDelay = Math.ceil(((baseMs + depthMs) / 1000) * sampleRate) + 2;
  const render = (phase: number): Float32Array => {
    const buffer = new Float32Array(maxDelay);
    let writeIndex = 0;
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      buffer[writeIndex] = input[i]!;
      const delaySamples = ((baseMs + depthMs * Math.sin(2 * Math.PI * rateHz * (i / sampleRate) + phase)) / 1000) * sampleRate;
      let readPosition = writeIndex - delaySamples;
      while (readPosition < 0) readPosition += maxDelay;
      const readFloor = Math.floor(readPosition) % maxDelay;
      const frac = readPosition - Math.floor(readPosition);
      const next = (readFloor + 1) % maxDelay;
      out[i] = buffer[readFloor]! + frac * (buffer[next]! - buffer[readFloor]!);
      writeIndex = (writeIndex + 1) % maxDelay;
    }
    return out;
  };
  return { left: render(0), right: render(Math.PI) };
}

/**
 * ピンポン・フィードバックディレイ。左右の遅延線が互いへ送り合い、
 * フィードバック経路の1次ローパスで繰り返すほど丸くなる。ウェットのみ返す。
 */
export function pingPongDelay(
  input: Float32Array,
  sampleRate: number,
  delaySec: number,
  feedback = 0.45,
): StereoWave {
  const delaySamples = Math.max(1, Math.round(delaySec * sampleRate));
  const bufferL = new Float32Array(delaySamples);
  const bufferR = new Float32Array(delaySamples);
  const left = new Float32Array(input.length);
  const right = new Float32Array(input.length);
  let index = 0;
  let dampL = 0;
  let dampR = 0;
  for (let i = 0; i < input.length; i++) {
    const outL = bufferL[index]!;
    const outR = bufferR[index]!;
    left[i] = outL;
    right[i] = outR;
    dampL += (outR - dampL) * 0.4;
    dampR += (outL - dampR) * 0.4;
    bufferL[index] = input[i]! + dampL * feedback;
    bufferR[index] = dampR * feedback;
    index = (index + 1) % delaySamples;
  }
  return { left, right };
}

/** 1次ローパス(インプレース)。深度由来の「遠いほどこもる」用。 */
export function onePoleLowpass(wave: Float32Array, sampleRate: number, cutoffHz: number): void {
  const alpha = 1 - Math.exp(-2 * Math.PI * cutoffHz / sampleRate);
  let state = 0;
  for (let i = 0; i < wave.length; i++) {
    state += (wave[i]! - state) * alpha;
    wave[i] = state;
  }
}

/**
 * リバーブ・ダッキング: ドライの包絡でウェットを沈め、音の切れ目で尾が開花する。
 * アタック10ms/リリース200msの包絡フォロワ(現代の定番のオフライン版)。
 */
export function duckWet(wet: StereoWave, dry: Float32Array, sampleRate: number, amount: number): void {
  if (amount <= 0) return;
  const attack = 1 - Math.exp(-1 / (0.01 * sampleRate));
  const release = 1 - Math.exp(-1 / (0.2 * sampleRate));
  // 2パス: 包絡と全体ピークを先に確定してから適用(正規化が時間位置で偏らない)。
  const envelope = new Float32Array(dry.length);
  let state = 0;
  let peak = 1e-6;
  for (let i = 0; i < dry.length; i++) {
    const level = Math.abs(dry[i]!);
    state += (level - state) * (level > state ? attack : release);
    envelope[i] = state;
    if (state > peak) peak = state;
  }
  const threshold = peak * 0.6 + 1e-6;
  for (let i = 0; i < dry.length; i++) {
    const gain = 1 - amount * Math.min(1, envelope[i]! / threshold);
    wet.left[i] = wet.left[i]! * gain;
    wet.right[i] = wet.right[i]! * gain;
  }
}
