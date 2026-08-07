import { describe, expect, it } from 'vitest';
import { exportMp3, FADE_SEC, unrollChannel } from '../src/audio/mp3-export.js';

describe('ループ展開(unrollChannel)', () => {
  // イントロ2サンプル+本体3サンプルの玩具波形(float32で正確に表せる値)。
  const wave = new Float32Array([0.125, 0.25, 1, 2, 3]);

  it('イントロ+本体×Nに展開される', () => {
    const out = unrollChannel(wave, 2, 5, 2, 0);
    expect(Array.from(out)).toEqual([0.125, 0.25, 1, 2, 3, 1, 2, 3]);
  });

  it('フェードは次ループの頭へ食い込み、レイズドコサインで無音へ落ちる', () => {
    const out = unrollChannel(wave, 2, 5, 1, 3);
    expect(out).toHaveLength(2 + 3 + 3);
    // 食い込み部は本体先頭のコピーにレイズドコサイン係数が掛かり、最終サンプルで0。
    expect(out[5]!).toBeCloseTo(1 * 0.75, 6);
    expect(out[6]!).toBeCloseTo(2 * 0.25, 6);
    expect(out[7]!).toBeCloseTo(0, 6);
  });

  it('フェード長は本体長を超えない', () => {
    const out = unrollChannel(wave, 2, 5, 1, 100);
    expect(out).toHaveLength(2 + 3 + 3);
  });
});

describe('MP3エンコード', () => {
  const sine = (rate: number, sec: number): Float32Array => {
    const wave = new Float32Array(Math.round(rate * sec));
    for (let i = 0; i < wave.length; i++) wave[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
    return wave;
  };

  it('チップ音源の49716Hz(非標準レート)のモノラル入力でMP3が出る', async () => {
    const rate = 49716;
    const blob = await exportMp3(
      { wave: sine(rate, 1), sampleRate: rate, loopStartSec: 0.25, loopEndSec: 1 },
      { loopCount: 2, fade: true },
    );
    expect(blob.type).toBe('audio/mpeg');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(1000);
    // MP3フレーム同期(0xFFE0)がどこかに存在する(LAMEはVBRヘッダフレームから始まる)。
    const hasSync = bytes.some((b, i) => b === 0xff && (bytes[i + 1]! & 0xe0) === 0xe0);
    expect(hasSync).toBe(true);
  });

  it('ステレオ入力は左右を同じ形で展開してエンコードする', async () => {
    const rate = 44100;
    const wave = sine(rate, 0.5);
    const blob = await exportMp3(
      { wave, waveRight: wave, sampleRate: rate, loopStartSec: 0, loopEndSec: 0.5 },
      { loopCount: 1, fade: false },
    );
    expect(blob.size).toBeGreaterThan(500);
  });

  it('進捗コールバックは単調に1へ到達する', async () => {
    const rate = 44100;
    const seen: number[] = [];
    await exportMp3(
      { wave: sine(rate, FADE_SEC / 2), sampleRate: rate, loopStartSec: 0, loopEndSec: FADE_SEC / 2 },
      { loopCount: 1, fade: false },
      (ratio) => seen.push(ratio),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  });
});
