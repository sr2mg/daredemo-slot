import { describe, expect, it } from 'vitest';
import {
  duckWet,
  onePoleLowpass,
  pingPongDelay,
  stereoChorus,
  stereoReverb,
} from '../src/audio/effects.js';
import { DEFAULT_ROOM, panGains, ROLE_STAGE, roomFor, STYLE_ROOMS } from '../src/audio/stage.js';
import { noteStageEchoFor, withEchoTracks } from '../src/audio/time-layer.js';

/**
 * 音響カタログ(舞台/部屋/時間装置)とDSPプリミティブの検証。
 * 原則: リバーブ系パラメータは深度から導出、時間装置はグルーヴから導出。
 */

describe('舞台と部屋(深度モデル)', () => {
  it('深いほど送りが増え、プリディレイが縮み、高域が落ちる(単調性)', () => {
    const room = DEFAULT_ROOM;
    expect(room.sendAt(0.8)).toBeGreaterThan(room.sendAt(0.2));
    expect(room.preDelayMsAt(0.8)).toBeLessThan(room.preDelayMsAt(0.2));
    expect(room.dampHzAt(0.8)).toBeLessThan(room.dampHzAt(0.2));
    expect(room.dryAt(0.8)).toBeLessThan(room.dryAt(0.2));
  });

  it('kmmoの部屋は実測RT60(≈2.85s)を宣言し、未登録スタイルは既定の部屋へ', () => {
    expect(STYLE_ROOMS['kmmo']!.rt60Sec).toBeCloseTo(2.85, 2);
    expect(roomFor('unknown-style')).toBe(DEFAULT_ROOM);
  });

  it('全ロールが舞台位置を持ち、ベースが最前・パッドが最奥', () => {
    expect(ROLE_STAGE['bass']!.depth).toBeLessThan(ROLE_STAGE['lead']!.depth);
    expect(ROLE_STAGE['backing']!.depth).toBeGreaterThan(ROLE_STAGE['lead']!.depth);
  });

  it('等パワーパン: 端で片チャンネル、中央で等分', () => {
    const [hardLeftL, hardLeftR] = panGains(-1);
    expect(hardLeftL).toBeCloseTo(1, 6);
    expect(hardLeftR).toBeCloseTo(0, 6);
    const [centerL, centerR] = panGains(0);
    expect(centerL).toBeCloseTo(Math.SQRT1_2, 6);
    expect(centerR).toBeCloseTo(Math.SQRT1_2, 6);
  });
});

describe('時間装置(二重時間軸)', () => {
  it('MIDI段エコーの遅延はグルーヴから導出される(OPLLと同一規則)', () => {
    expect(noteStageEchoFor('straight').delayBeats).toBe(0.5);
    expect(noteStageEchoFor('bounce').delayBeats).toBeCloseTo(2 / 3, 6);
  });

  it('エコータップはループ末尾を越えるとループ区間へ巻き戻る', () => {
    const notes = [{ startSec: 7.8, gain: 1 }];
    const result = withEchoTracks(
      notes, { delayBeats: 0.5, taps: 2, decay: 0.5 }, 1.0, { startSec: 2.0, endSec: 8.0 },
    );
    expect(result).toHaveLength(3);
    expect(result[1]!.startSec).toBeCloseTo(2.3, 6); // 8.3 → 2.0 + 0.3
    expect(result[2]!.startSec).toBeCloseTo(2.8, 6);
  });
});

describe('DSPプリミティブ', () => {
  const rate = 8000;

  it('リバーブのRT60導出: 長いRT60ほど尾が長い + プリディレイで立ち上がりが遅れる', () => {
    const impulse = new Float32Array(rate);
    impulse[0] = 1;
    const tail = (wave: Float32Array, fromSec: number, toSec: number): number =>
      wave.slice(Math.floor(fromSec * rate), Math.floor(toSec * rate))
        .reduce((sum, v) => sum + Math.abs(v), 0);
    const short = stereoReverb(impulse, rate, 0.5);
    const long = stereoReverb(impulse, rate, 3.0);
    expect(tail(long.left, 0.5, 1.0)).toBeGreaterThan(tail(short.left, 0.5, 1.0) * 2);
    const preDelayed = stereoReverb(impulse, rate, 1.0, 40);
    expect(tail(preDelayed.left, 0, 0.03)).toBeLessThan(1e-6); // 40ms前は無音
  });

  it('ピンポン: インパルスが左→右の順に跳ね返る', () => {
    const input = new Float32Array(1000);
    input[0] = 1;
    const { left, right } = pingPongDelay(input, 1000, 0.1, 0.5);
    expect(left[100]!).toBeGreaterThan(0.9);
    expect(Math.abs(right[100]!)).toBeLessThan(0.01);
    expect(right[200]!).toBeGreaterThan(0.03);
  });

  it('コーラスはLFO位相反転で左右が別の揺れ方をする', () => {
    const tone = new Float32Array(rate);
    for (let i = 0; i < rate; i++) tone[i] = Math.sin(2 * Math.PI * 220 * (i / rate));
    const { left, right } = stereoChorus(tone, rate);
    let differs = false;
    for (let i = 800; i < rate; i++) {
      if (Math.abs(left[i]! - right[i]!) > 1e-3) { differs = true; break; }
    }
    expect(differs).toBe(true);
  });

  it('ローパスは高周波を減衰させる', () => {
    const noise = new Float32Array(rate);
    for (let i = 0; i < rate; i++) noise[i] = Math.sin(2 * Math.PI * 3000 * (i / rate));
    const before = noise.reduce((sum, v) => sum + v * v, 0);
    onePoleLowpass(noise, rate, 500);
    const after = noise.reduce((sum, v) => sum + v * v, 0);
    expect(after).toBeLessThan(before * 0.2);
  });

  it('ダッキング: ドライが鳴っている間はウェットが沈み、切れ目で戻る', () => {
    const dry = new Float32Array(rate);
    for (let i = 0; i < rate / 2; i++) dry[i] = 0.8; // 前半だけ鳴る
    const wet = { left: new Float32Array(rate).fill(0.5), right: new Float32Array(rate).fill(0.5) };
    duckWet(wet, dry, rate, 0.5);
    const early = wet.left[Math.floor(rate * 0.25)]!;
    const late = wet.left[rate - 1]!;
    expect(early).toBeLessThan(0.35); // 沈む
    expect(late).toBeGreaterThan(0.45); // 開花
  });
});
