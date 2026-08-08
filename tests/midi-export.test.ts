import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { pieceToSmf } from '../src/audio/midi-export.js';

/**
 * SMF書き出しの検証。ライターはランニングステータスを使わない設計なので、
 * ステータスバイト込みの部分列走査でイベントの存在を確認できる。
 */

const indexOfSeq = (data: Uint8Array, seq: readonly number[], from = 0): number => {
  outer: for (let i = from; i <= data.length - seq.length; i++) {
    for (let k = 0; k < seq.length; k++) {
      if (data[i + k] !== seq[k]) continue outer;
    }
    return i;
  }
  return -1;
};

const containsSeq = (data: Uint8Array, seq: readonly number[]): boolean => indexOfSeq(data, seq) >= 0;

const asciiSeq = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));

describe('MIDI(SMF)書き出し', () => {
  const kmmo = compose({
    progressionId: 'relative-orbit', styleId: 'kmmo', keyRoot: 2, bpm: 100, bars: 16, seed: 8,
  });

  it('format 1 / PPQ480のヘッダとトラック数が正しい', () => {
    const smf = pieceToSmf(kmmo);
    // 'MThd' + 長さ6 + format 1
    expect([...smf.slice(0, 10)]).toEqual([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1]);
    expect((smf[12]! << 8) | smf[13]!).toBe(480); // PPQ
    const declaredTracks = (smf[10]! << 8) | smf[11]!;
    let mtrkCount = 0;
    for (let at = indexOfSeq(smf, asciiSeq('MTrk')); at >= 0; at = indexOfSeq(smf, asciiSeq('MTrk'), at + 4)) {
      mtrkCount += 1;
    }
    expect(mtrkCount).toBe(declaredTracks);
  });

  it('主旋律トラックに受け渡しのプログラムチェンジ(二胡系110→笛73)が入る', () => {
    const smf = pieceToSmf(kmmo);
    expect(containsSeq(smf, [0xc0, 110])).toBe(true);
    expect(containsSeq(smf, [0xc0, 73])).toBe(true);
  });

  it('色別上書き(leadColorVoices)がプログラムチェンジへ反映される', () => {
    const smf = pieceToSmf(kmmo, { leadColorVoices: { 1: { bank: 0, program: 24 } } });
    expect(containsSeq(smf, [0xc0, 110])).toBe(true); // 看板は既定のまま
    expect(containsSeq(smf, [0xc0, 24])).toBe(true); // 展開だけギター
    expect(containsSeq(smf, [0xc0, 73])).toBe(false); // 笛は差し替えられて消える
  });

  it('ドラムは10ch固定で、オープンハット(GM46)のノートが出る', () => {
    const eurobeat = compose({
      progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, bars: 4, seed: 42,
    });
    const smf = pieceToSmf(eurobeat);
    expect(containsSeq(smf, [0x99, 36])).toBe(true); // キック
    expect(containsSeq(smf, [0x99, 46])).toBe(true); // 裏打ちオープンハット
  });

  it('ループ位置がmarkerメタ(loopStart/loopEnd)として入る', () => {
    const smf = pieceToSmf(kmmo);
    expect(containsSeq(smf, asciiSeq('loopStart'))).toBe(true);
    expect(containsSeq(smf, asciiSeq('loopEnd'))).toBe(true);
  });
});
