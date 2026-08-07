import { describe, expect, it } from 'vitest';
import { applyDrumArticulation } from '../src/core/music/drum-articulation.js';
import type { DrumEvent } from '../src/core/music/compose.js';
import { compose } from '../src/core/music/compose.js';
import { arrangeSf2Parts } from '../src/audio/pcm-arrange.js';

const hats = (beats: readonly number[]): DrumEvent[] =>
  beats.map((beat) => ({ beat, inst: 'hat' as const }));

describe('ドラムアーティキュレーション導出', () => {
  it('裏打ち(1拍間隙)はオープンになり、ループ末尾は先頭へ巻き戻して測る', () => {
    const result = applyDrumArticulation(hats([0.5, 1.5, 2.5, 3.5]), 0, 4);
    // 最後の3.5も巻き戻し間隙(4-3.5 + 0.5)=1拍でオープン。
    expect(result.every((drum) => drum.open === true)).toBe(true);
  });

  it('8分刻みはクローズのまま拍節アクセントが付く', () => {
    const result = applyDrumArticulation(
      hats([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]), 0, 4,
    );
    expect(result.every((drum) => drum.open !== true)).toBe(true);
    expect(result[0]!.velocity).toBeCloseTo(1.0); // 小節頭
    expect(result[2]!.velocity).toBeCloseTo(0.82); // 拍頭
    expect(result[1]!.velocity).toBeCloseTo(0.82 ** 2); // 8分裏
  });

  it('16分位置は最弱のアクセントになる', () => {
    const result = applyDrumArticulation(hats([0.5, 0.75, 1.0, 1.5]), 0, 4);
    const sixteenth = result.find((drum) => drum.beat === 0.75)!;
    expect(sixteenth.open).not.toBe(true);
    expect(sixteenth.velocity).toBeCloseTo(0.82 ** 3);
  });

  it('1拍を超える間隙は余白として残し、開かない', () => {
    const result = applyDrumArticulation(hats([0.5, 2.5]), 0, 8);
    expect(result[0]!.open).not.toBe(true);
  });

  it('表拍(拍頭)は間隙があっても開かない', () => {
    const result = applyDrumArticulation(hats([0, 1, 2, 3]), 0, 4);
    expect(result.every((drum) => drum.open !== true)).toBe(true);
  });

  it('ハット以外の音色は変更しない', () => {
    const drums: DrumEvent[] = [
      { beat: 0, inst: 'kick' },
      { beat: 1, inst: 'snare' },
    ];
    const result = applyDrumArticulation(drums, 0, 4);
    expect(result[0]).toEqual({ beat: 0, inst: 'kick' });
    expect(result[1]).toEqual({ beat: 1, inst: 'snare' });
  });
});

describe('compose→PCMのアーティキュレーション貫通', () => {
  it('ユーロビート(裏打ち)のハットはオープンとしてGM46で鳴る', () => {
    const piece = compose({
      progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, bars: 4, seed: 42,
    });
    const bodyHats = piece.drums.filter(
      (drum) => drum.inst === 'hat' && drum.beat >= piece.loopStartBeat,
    );
    expect(bodyHats.length).toBeGreaterThan(0);
    expect(bodyHats.some((drum) => drum.open === true)).toBe(true);

    const drums = arrangeSf2Parts(piece).drums;
    expect(drums.some((note) => note.midi === 46)).toBe(true);
    // オープンは鳴り残す(0.2秒のクローズより長い)。
    const openNote = drums.find((note) => note.midi === 46)!;
    expect(openNote.durSec).toBeGreaterThan(0.2);
  });

  it('ロック(8分刻み)のハットは全てクローズで、拍節の強弱が付く', () => {
    const piece = compose({
      progressionId: 'minor-pedal', styleId: 'rock', keyRoot: 9, bpm: 150, bars: 8,
      tonality: 'minor', seed: 7,
    });
    const bodyHats = piece.drums.filter(
      (drum) => drum.inst === 'hat' && drum.beat >= piece.loopStartBeat,
    );
    expect(bodyHats.length).toBeGreaterThan(0);
    expect(bodyHats.every((drum) => drum.open !== true)).toBe(true);
    const velocities = new Set(bodyHats.map((drum) => drum.velocity));
    expect(velocities.size).toBeGreaterThan(1); // 小節頭・拍頭・裏で強弱が分かれる

    const drums = arrangeSf2Parts(piece).drums;
    expect(drums.every((note) => note.midi !== 46)).toBe(true);
  });
});
