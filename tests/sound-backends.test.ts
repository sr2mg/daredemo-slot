import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import type { ComposeOptions, PcmPart } from '../src/core/music/compose.js';
import { capabilitiesFor, SOUND_CAPABILITIES } from '../src/core/music/sound-capabilities.js';
import type { StageRole } from '../src/audio/stage.js';

/**
 * 能力プロファイル(sound-capabilities)とIR表現層(ハモリ・スライド)の検証。
 * 原則: 豊かに書いて、能力のないバックエンドでは作曲段階で畳む。
 */

// PcmPart(core: 保存単位のPCM音色語彙)とStageRole(編曲層: 舞台の役割語彙)は同一語彙。
// 片方にだけ役割を足すとここが型エラーになる(相互代入可能性のコンパイル時検証)。
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const pcmPartMatchesStageRole: MutuallyAssignable<PcmPart, StageRole> = true;
void pcmPartMatchesStageRole;

const kmmo: ComposeOptions = {
  progressionId: 'relative-orbit', styleId: 'kmmo', keyRoot: 2, bpm: 100, bars: 16, seed: 8,
};

describe('能力プロファイル', () => {
  it('カタログは3バックエンドを宣言し、既定はOPLL', () => {
    expect(Object.keys(SOUND_CAPABILITIES).sort()).toEqual(['nes2a03', 'opll', 'pcm']);
    expect(capabilitiesFor(undefined).id).toBe('opll');
  });

  it('PCM対象ではテンションが作曲段階から有効になる', () => {
    const piece = compose({ ...kmmo, soundChip: 'pcm' });
    expect(piece.chords.some((chord) => (chord.colorPcs ?? []).length > 0)).toBe(true);
  });

  it('2A03では声部予算のない装置(ハモリ・スライド)が畳まれる', () => {
    const piece = compose({ ...kmmo, soundChip: 'nes2a03', duet: 'on', glide: 'on' });
    expect(piece.duet).toHaveLength(0);
    expect(piece.melody.every((note) => note.glideFrom === undefined)).toBe(true);
  });
});

describe('ハモリ層(平行下3度)', () => {
  const piece = compose(kmmo); // kmmoはstyle既定でduet:'on'

  it('kmmo既定でハモリが生成され、常に主旋律の3〜5半音下に居る', () => {
    expect(piece.duet.length).toBeGreaterThan(0);
    for (const note of piece.duet) {
      const partner = piece.melody.find(
        (m) => m.role !== 'ornament' && Math.abs(m.beat - note.beat) < 1e-6,
      );
      expect(partner).toBeDefined();
      const interval = partner!.midi - note.midi;
      expect(interval).toBeGreaterThanOrEqual(3);
      expect(interval).toBeLessThanOrEqual(5);
    }
  });

  it('既存スタイルの既定では空(後方互換)', () => {
    const plain = compose({
      progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, bars: 16, seed: 11,
    });
    expect(plain.duet).toHaveLength(0);
  });
});

describe('スライド(ポルタメント)指示', () => {
  const piece = compose(kmmo); // kmmoはstyle既定でglide:'on'

  it('glideFromは直前の音の音高で、強拍には付かない', () => {
    const marked = piece.melody.filter((note) => note.glideFrom !== undefined);
    expect(marked.length).toBeGreaterThan(0);
    const line = piece.melody
      .filter((note) => note.beat >= piece.loopStartBeat)
      .sort((a, b) => a.beat - b.beat);
    for (const note of marked) {
      expect(((note.beat - piece.loopStartBeat) % 2)).not.toBe(0);
      const index = line.findIndex((n) => n === note);
      expect(line[index - 1]!.midi).toBe(note.glideFrom);
    }
  });
});

