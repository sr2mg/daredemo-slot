import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { arrangementSectionFor } from '../src/core/music/arrangement.js';
import type { Piece } from '../src/core/music/types.js';
import { arrangeSf2Parts } from '../src/audio/pcm-arrange.js';
import type { Sf2Note } from '../src/audio/sf2.js';

/**
 * 主旋律の受け渡し(leadColor)と、色別上書き(leadColorVoices)の優先順の検証。
 * kmmo 16小節: 前半=hook(色0)、後半=development(色1)。
 */

const piece16 = (): Piece => compose({
  progressionId: 'relative-orbit', styleId: 'kmmo', keyRoot: 0, bpm: 120, bars: 16, seed: 8,
});

const programsByColor = (piece: Piece, lead: readonly Sf2Note[]): Map<number, Set<number>> => {
  const spb = 60 / piece.bpm;
  const result = new Map<number, Set<number>>();
  for (const note of lead) {
    const color = arrangementSectionFor(piece, note.startSec / spb).leadColor ?? 0;
    if (!result.has(color)) result.set(color, new Set());
    result.get(color)!.add(note.program);
  }
  return result;
};

describe('PCM主旋律の受け渡しと色別上書き', () => {
  it('上書きなし: 色0と色1でスタイル既定パレットが切り替わる', () => {
    const piece = piece16();
    const byColor = programsByColor(piece, arrangeSf2Parts(piece).lead);
    expect([...byColor.get(0)!]).toEqual([110]); // kmmo看板色(二胡系)
    expect([...byColor.get(1)!]).toEqual([73]); // 展開色(フルート)
  });

  it('leadColorVoicesは指定した色だけ差し替え、他の色は既定の受け渡しを保つ', () => {
    const piece = piece16();
    const byColor = programsByColor(piece, arrangeSf2Parts(piece, {
      leadColorVoices: { 1: { bank: 0, program: 24 } },
    }).lead);
    expect([...byColor.get(0)!]).toEqual([110]); // 看板は既定のまま
    expect([...byColor.get(1)!]).toEqual([24]); // 展開だけギターへ
  });

  it('旧形式のlead(全区間固定)は引き続き全色へ効き、色別指定があればそちらが勝つ', () => {
    const piece = piece16();
    const fixed = programsByColor(piece, arrangeSf2Parts(piece, {
      lead: { bank: 0, program: 0 },
    }).lead);
    expect([...fixed.get(0)!]).toEqual([0]);
    expect([...fixed.get(1)!]).toEqual([0]);

    const mixed = programsByColor(piece, arrangeSf2Parts(piece, {
      lead: { bank: 0, program: 0 },
      leadColorVoices: { 1: { bank: 0, program: 24 } },
    }).lead);
    expect([...mixed.get(0)!]).toEqual([0]); // 固定が生きる
    expect([...mixed.get(1)!]).toEqual([24]); // 色別が勝つ
  });

  it('ハモリは上書きしない限り、その区間の主旋律の音色(色別上書き込み)へ追随する', () => {
    const piece = piece16();
    const parts = arrangeSf2Parts(piece, {
      leadColorVoices: { 1: { bank: 0, program: 24 } },
    });
    expect(parts.duet.length).toBeGreaterThan(0); // kmmoはハモリあり
    const byColor = programsByColor(piece, parts.duet);
    if (byColor.has(1)) expect([...byColor.get(1)!]).toEqual([24]);
    expect([...(byColor.get(0) ?? new Set([110]))]).toEqual([110]);
  });
});
