// 筐体演出（cabinet-fx.ts）: 入賞ラインの点灯・状態ランプ・払い出しの刻み。
// 描画はブラウザスモークで見るので、ここでは「どの段が光るか」「何枚目がいつ入るか」を固定する。
import { describe, expect, it } from 'vitest';
import { winningLines, winsAt } from '../src/core/judge.js';
import { COINS_PER_SFX } from '../src/core/sfx/sfx-design.js';
import { sampleAType } from '../src/machines/sample-a.js';
import {
  COIN_TICK_MS,
  DIM_LEVEL,
  FLASH_LEVEL,
  flashLamps,
  lampsForRows,
  litRows,
  payoutSchedule,
  statusLamps,
} from '../src/ui/cabinet-fx.js';
import { LAMPS_ALL_ON } from '../src/ui/reel-gl.js';

/** 各リールで symbol が行 row に来る停止位置（最初に見つかったもの） */
function stopsShowing(symbol: string, row: number): number[] {
  return sampleAType.strips.map((strip) => {
    const n = sampleAType.frames;
    for (let s = 0; s < n; s++) if (strip[(s + row) % n] === symbol) return s;
    throw new Error(`${symbol} not on strip`);
  });
}

describe('入賞ラインの点灯', () => {
  it('中段ベル揃いなら中段ラインだけが入賞ラインになり、各リールの中段が点灯', () => {
    const stops = stopsShowing('bell', 1);
    expect(winsAt(sampleAType, stops)).toContain('bell');
    const lines = winningLines(sampleAType, stops);
    expect(lines).toContain(1);
    const rows = litRows(sampleAType, stops)!;
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.has(1)).toBe(true);
    // 中段ライン以外も揃っていない限り、上下段は点灯しない
    const extraLines = lines.filter((i) => i !== 1);
    if (extraLines.length === 0) for (const r of rows) expect([...r]).toEqual([1]);
  });

  it('何も揃っていなければ null（全段点灯のまま）', () => {
    // 全リールで下段ブランク・中段/上段が揃わない位置を総当たりで探す
    const n = sampleAType.frames;
    let found: number[] | null = null;
    outer: for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        for (let c = 0; c < n; c++) {
          if (winsAt(sampleAType, [a, b, c]).length === 0) {
            found = [a, b, c];
            break outer;
          }
        }
      }
    }
    expect(found).not.toBeNull();
    expect(winningLines(sampleAType, found!)).toEqual([]);
    expect(litRows(sampleAType, found!)).toBeNull();
  });

  it('lamps は [上, 中, 下] の順で、点灯行は 1・それ以外は減光', () => {
    expect(lampsForRows(null)).toBe(LAMPS_ALL_ON);
    expect(lampsForRows(new Set([1]))).toEqual([DIM_LEVEL, 1, DIM_LEVEL]);
    expect(lampsForRows(new Set([0, 2]))).toEqual([1, DIM_LEVEL, 1]);
  });

  it('確定フラッシュは全段を明滅（点灯側は通常より明るい）', () => {
    expect(flashLamps(true)).toEqual([FLASH_LEVEL, FLASH_LEVEL, FLASH_LEVEL]);
    expect(flashLamps(false)).toEqual([0, 0, 0]);
    expect(FLASH_LEVEL).toBeGreaterThan(1);
  });
});

describe('状態ランプ', () => {
  const base = { phase: 'ready' as const, betDone: false, pendingRebet: false, bet: 3 };

  it('未ベットの待機中は投入ランプだけ', () => {
    expect(statusLamps(base)).toEqual({ insert: true, betCount: 0, replay: false, start: false, wait: false });
  });

  it('ベット済みで待機中は BET 点灯 + スタート点滅、投入は消灯', () => {
    expect(statusLamps({ ...base, betDone: true })).toEqual({
      insert: false,
      betCount: 3,
      replay: false,
      start: true,
      wait: false,
    });
  });

  it('再遊技は投入なしで BET 全点灯・リプレイ点灯・スタート点滅', () => {
    expect(statusLamps({ ...base, pendingRebet: true })).toEqual({
      insert: false,
      betCount: 3,
      replay: true,
      start: true,
      wait: false,
    });
  });

  it('回転中は BET のみ、ウエイト中はさらにウエイトランプ', () => {
    expect(statusLamps({ ...base, phase: 'spinning' })).toEqual({
      insert: false,
      betCount: 3,
      replay: false,
      start: false,
      wait: false,
    });
    expect(statusLamps({ ...base, phase: 'waiting' }).wait).toBe(true);
    expect(statusLamps({ ...base, phase: 'waiting' }).start).toBe(false);
  });

  it('BET ランプは 3 個までで、1 枚掛け機種は 1 個', () => {
    expect(statusLamps({ ...base, betDone: true, bet: 1 }).betCount).toBe(1);
    expect(statusLamps({ ...base, betDone: true, bet: 5 }).betCount).toBe(3);
  });
});

describe('払い出しの刻み', () => {
  it('1 枚目は精算と同時、以降はコイン音の 1 打間隔で進む', () => {
    const s = payoutSchedule(15);
    expect(s.coinAtMs).toHaveLength(15);
    expect(s.coinAtMs[0]).toBe(0);
    expect(s.coinAtMs[1]).toBe(COIN_TICK_MS);
    expect(s.endMs).toBe(14 * COIN_TICK_MS);
  });

  it('払い出し音は 8 枚ごとに頭出しし、端数も 1 回鳴らす', () => {
    expect(payoutSchedule(15).sfxAtMs).toEqual([0, COINS_PER_SFX * COIN_TICK_MS]);
    expect(payoutSchedule(8).sfxAtMs).toEqual([0]);
    expect(payoutSchedule(2).sfxAtMs).toEqual([0]);
  });

  it('払い出し 0 なら何も予定しない', () => {
    expect(payoutSchedule(0)).toEqual({ coinAtMs: [], sfxAtMs: [], endMs: 0 });
  });

  it('15 枚は 1 秒以内に収まる（ホッパー約 16 枚/秒）', () => {
    expect(payoutSchedule(15).endMs).toBeLessThan(1000);
  });
});
