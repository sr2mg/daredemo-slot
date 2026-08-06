import { FormantSynth } from 'klattsch';
import type { Piece } from '../core/music/compose.js';
import { vocalEnsembleFor } from '../core/music/vocal-score.js';
import type { VocalEnsembleOptions } from '../core/music/vocal-score.js';

/**
 * ハミング声部のレンダリングとミックス。
 * 設計（vocal-score.ts）が出したスケジュールを klattsch の FormantSynth で
 * PCM 化し、レンダリング済みの楽器 BGM 波形へ加算する。
 * klattsch のノイズ源は固定シードの xorshift なので、この経路も完全に決定論。
 */

export interface VocalSettings extends VocalEnsembleOptions {
  /** ミックス時のボーカル相対ゲイン（0..1）。 */
  volume: number;
}

/** 1声ずつレンダリングして加算した、アンサンブル全体のボーカル波形。 */
export function renderVocalWave(
  piece: Piece,
  settings: VocalEnsembleOptions,
  sampleRate: number,
): Float32Array {
  const scores = vocalEnsembleFor(piece, settings);
  const length = Math.ceil((scores[0]?.totalMs ?? 0) * sampleRate / 1000);
  const mix = new Float32Array(length);
  const voice = new Float32Array(length);
  const voiceGain = 1 / Math.sqrt(Math.max(1, scores.length));
  for (const score of scores) {
    const synth = new FormantSynth({
      sampleRate,
      schedule: score.events.map((event) => ({
        atMs: event.atMs,
        target: event.target as Record<string, number>,
        transitionMs: event.transitionMs,
      })),
    });
    voice.fill(0);
    synth.process(voice);
    for (let i = 0; i < length; i++) mix[i]! += voice[i]! * voiceGain;
  }
  return mix;
}

/** ボーカル波形キャッシュ（1曲=数MB。レンダリングは同期CPUなので再利用する）。 */
const VOCAL_CACHE_MAX = 4;
const vocalWaveCache = new Map<string, Float32Array>();

/** 同じ曲・同じ設定のボーカルは再レンダリングしない。 */
export function renderVocalWaveCached(
  cacheKey: string,
  piece: Piece,
  settings: VocalEnsembleOptions,
  sampleRate: number,
): Float32Array {
  const cached = vocalWaveCache.get(cacheKey);
  if (cached) return cached;
  const wave = renderVocalWave(piece, settings, sampleRate);
  vocalWaveCache.set(cacheKey, wave);
  while (vocalWaveCache.size > VOCAL_CACHE_MAX) {
    vocalWaveCache.delete(vocalWaveCache.keys().next().value!);
  }
  return wave;
}

/** 楽器波形へボーカルを加算した新しい波形を返す（入力は書き換えない）。 */
export function mixVocalIntoWave(
  instrumental: Float32Array,
  vocal: Float32Array,
  vocalGain: number,
): Float32Array {
  const out = new Float32Array(instrumental.length);
  out.set(instrumental);
  const length = Math.min(instrumental.length, vocal.length);
  for (let i = 0; i < length; i++) {
    const mixed = out[i]! + vocal[i]! * vocalGain;
    // 加算でクリップした場合だけ軽く丸める（通常域は素通し）。
    out[i] = mixed > 1 ? 1 - 1 / (1 + mixed) : mixed < -1 ? -1 + 1 / (1 - mixed) : mixed;
  }
  return out;
}
