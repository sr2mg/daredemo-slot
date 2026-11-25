import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { parseSf2, renderSf2 } from '../src/audio/sf2.js';
import { loadSf2Stack, mergeSampleRanges, openSf2 } from '../src/audio/sf2-lazy.js';
import type { Sf2ByteSource } from '../src/audio/sf2-lazy.js';
import { pcmPresetRefs, renderSf2Bgm } from '../src/audio/pcm-arrange.js';

/**
 * SF2 の部分読みの検証。同梱 GeneralUser GS を「読んだバイト数を数える取得口」越しに開き、
 * (1) 目録だけで開けること、(2) 曲に必要な波形しか読まないこと、
 * (3) 全体を読んだ場合と同じ音が出ること、を確かめる。
 *
 * 「同じ音」は丸め誤差の範囲での一致で判定する。合成は再生位置を浮動小数で進めるので、
 * 波形を詰め直してサンプル位置の基準が変わると、補間の端数が 1e-7 程度ずれる(データは同一)。
 */
const ROUNDING = 1e-5;

const file = readFileSync('public/soundfonts/GeneralUser-GS.sf2');
const whole = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;

function countingSource(): { source: Sf2ByteSource; stats: { bytes: number; reads: number } } {
  const stats = { bytes: 0, reads: 0 };
  return {
    stats,
    source: {
      size: whole.byteLength,
      read: async (offset, length) => {
        stats.bytes += length;
        stats.reads += 1;
        return whole.slice(offset, offset + length);
      },
    },
  };
}

const piece = compose({
  progressionId: 'relative-orbit', styleId: 'kmmo', keyRoot: 2, bpm: 100, form: 'loop4' as const, seed: 8,
});

describe('SF2 の部分読み', () => {
  it('近い範囲をまとめ、離れた範囲は分けて読む', () => {
    expect(mergeSampleRanges([{ from: 100, to: 200 }, { from: 0, to: 50 }, { from: 150, to: 300 }], 10))
      .toEqual([{ from: 0, to: 50 }, { from: 100, to: 300 }]);
    expect(mergeSampleRanges([{ from: 0, to: 50 }, { from: 55, to: 80 }], 10)).toEqual([{ from: 0, to: 80 }]);
  });

  it('目録だけで開き、全体読みと同じプリセット一覧になる', async () => {
    const { source, stats } = countingSource();
    const lazy = await openSf2(source);
    const full = parseSf2(whole);
    expect(lazy.presets.map((p) => `${p.bank}:${p.program}:${p.name}:${p.zones.length}`))
      .toEqual(full.presets.map((p) => `${p.bank}:${p.program}:${p.name}:${p.zones.length}`));
    // 波形には触れていない(目録はファイルのごく一部)
    expect(stats.bytes).toBeLessThan(whole.byteLength * 0.1);
  });

  it('曲に必要な波形だけを読み、全体読みと同じ音になる', async () => {
    const { source, stats } = countingSource();
    const lazy = await openSf2(source);
    const fonts = await loadSf2Stack([lazy], pcmPresetRefs(piece));
    expect(stats.bytes).toBeLessThan(whole.byteLength * 0.5);
    expect(fonts[0]!.sampleData.length * 2).toBeLessThan(whole.byteLength * 0.5);

    const partial = await renderSf2Bgm(piece, fonts);
    const reference = await renderSf2Bgm(piece, parseSf2(whole));
    expect(partial.wave.length).toBe(reference.wave.length);
    let maxDiff = 0;
    for (let i = 0; i < reference.wave.length; i++) {
      maxDiff = Math.max(
        maxDiff,
        Math.abs(partial.wave[i]! - reference.wave[i]!),
        Math.abs(partial.waveRight![i]! - reference.waveRight![i]!),
      );
    }
    expect(maxDiff).toBeLessThan(ROUNDING);

    // 同じ組をもう一度求めても読み直さない
    const readsBefore = stats.reads;
    await loadSf2Stack([lazy], pcmPresetRefs(piece));
    expect(stats.reads).toBe(readsBefore);
  });

  it('無いプリセットは、全体読みと同じ代替へ解決される', async () => {
    const lazy = await openSf2(countingSource().source);
    const full = parseSf2(whole);
    // バンク 96 は GeneralUser GS に無い → 同じ番号のバンク 0 へ落ちる
    const note = { program: 81, bank: 96, midi: 69, velocity: 100, startSec: 0, durSec: 0.5, gain: 1 };
    const fonts = await loadSf2Stack([lazy], [note]);
    expect(fonts[0]!.presets.map((p) => `${p.bank}:${p.program}`)).toEqual(['0:81']);
    const a = renderSf2(fonts, [note], 44100, 1);
    const b = renderSf2(full, [note], 44100, 1);
    expect(a.some((value) => value !== 0)).toBe(true);
    expect(a.length).toBe(b.length);
    expect(a.every((value, i) => Math.abs(value - b[i]!) < ROUNDING)).toBe(true);
  });

  it('重ねでは、主フォントに無い音色だけを補完フォントから読む', async () => {
    const primary = await openSf2(countingSource().source);
    const complement = countingSource();
    const secondary = await openSf2(complement.source);
    const before = complement.stats.bytes;
    const fonts = await loadSf2Stack([primary, secondary], [{ bank: 0, program: 0 }]);
    expect(fonts[0]!.presets).toHaveLength(1);
    expect(fonts[1]!.presets).toHaveLength(0);
    expect(complement.stats.bytes).toBe(before); // 補完側の波形は読まれない
  });

  it('SF2 でないデータは開けない', async () => {
    const junk = new Uint8Array(64).buffer;
    await expect(openSf2({ size: 64, read: async (o, l) => junk.slice(o, o + l) })).rejects.toThrow('SF2ではない');
  });
});
