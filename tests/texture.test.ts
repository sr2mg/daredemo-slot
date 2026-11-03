import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { diagnosePiece, validatePiece } from '../src/core/music/diagnostics.js';
import { validateForm } from '../src/core/music/form.js';
import { canonicalForm } from '../src/core/music/options.js';
import { arrangeSf2Parts } from '../src/audio/pcm-arrange.js';
import { offbeatBackingRiff } from '../src/audio/backing-riff.js';
import type { ComposeOptions, Piece, SongFormSpec } from '../src/core/music/types.js';

/**
 * 区間テクスチャ(sustain / pulse)を固定する:
 * - sustain: 区間頭の 1 音を区間末尾まで保続、ドラム無し、ベースは持続、伴奏は同じボイシングを再打鍵しない
 * - pulse: 旋律は休み、和音はパワーコード(開放五度)、伴奏は格子の各ステップで刻む、ベースはオクターブ 8 分
 * - どちらも生成検証・診断エラーがゼロで、頂点と署名跳躍は旋律を持つ区間に置かれる
 * - 先頭区間と主題・引用の元はテクスチャを持てない(validateForm)
 */

const base: Omit<ComposeOptions, 'form'> = {
  progressionId: 'royal-pop', styleId: 'rock', keyRoot: 2, bpm: 140, seed: 21, tensionPolicy: 'lush',
};

const form: SongFormSpec = {
  sections: [
    { id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A' },
    { id: 'S', role: 'relief', bars: 8, energy: 2, theme: 'S', texture: 'sustain' },
    { id: 'P', role: 'development', bars: 8, energy: 5, theme: 'P', texture: 'pulse' },
    { id: "A'", role: 'return', bars: 8, energy: 4, theme: 'A', transform: 'literal' },
  ],
  ending: 'loop',
};

const inSection = <T extends { beat: number }>(piece: Piece, notes: readonly T[], index: number): T[] => {
  const section = piece.songPlan.form.sections[index]!;
  const start = piece.loopStartBeat + section.startBar * 4;
  const end = start + section.bars * 4;
  return notes.filter((note) => note.beat >= start && note.beat < end);
};

describe('区間テクスチャ', () => {
  const piece = compose({ ...base, form, intro: false });

  it('生成検証・診断エラーがゼロで、編成と計画にテクスチャが写る', () => {
    expect(validatePiece(piece)).toEqual([]);
    expect(diagnosePiece(piece).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(piece.songPlan.form.sections.map((section) => section.texture)).toEqual(['normal', 'sustain', 'pulse', 'normal']);
    expect(piece.arrangementPlan.sections.map((section) => section.backingRhythm)).toEqual(['normal', 'sustain', 'stab', 'normal']);
    expect(piece.arrangementPlan.sections[1]!.counterDensity).toBe(0);
    expect(piece.arrangementPlan.sections[2]!.ostinatoDensity).toBe(0);
    // 頂点と署名跳躍は旋律を持つ区間に。
    const climaxSection = piece.songPlan.form.sections.find((section) => (
      piece.phrasePlan.climaxBar >= section.startBar && piece.phrasePlan.climaxBar < section.startBar + section.bars
    ))!;
    expect(climaxSection.texture).toBe('normal');
    if (piece.phrasePlan.signatureLeapBar !== null) {
      const leapSection = piece.songPlan.form.sections.find((section) => (
        piece.phrasePlan.signatureLeapBar! >= section.startBar
        && piece.phrasePlan.signatureLeapBar! < section.startBar + section.bars
      ))!;
      expect(leapSection.texture).toBe('normal');
    }
  });

  it('sustain: 区間頭の 1 音が区間末尾まで保続し、ドラム無し、ベースは持続、副旋律・分散和音も無い', () => {
    const notes = inSection(piece, piece.melody, 1);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.beat).toBe(piece.loopStartBeat + 8 * 4);
    expect(notes[0]!.dur).toBeCloseTo(32, 6);
    expect(notes[0]!.articulation).toBe('tenuto');
    const chord = piece.chords.find((candidate) => candidate.beat <= notes[0]!.beat && notes[0]!.beat < candidate.beat + candidate.dur)!;
    expect(chord.pcs).toContain(notes[0]!.midi % 12);
    expect(inSection(piece, piece.drums, 1)).toEqual([]);
    expect(inSection(piece, piece.counterMelody, 1)).toEqual([]);
    expect(inSection(piece, piece.ostinato, 1)).toEqual([]);
    const bass = inSection(piece, piece.bass, 1);
    expect(bass.length).toBeGreaterThan(0);
    expect(bass.every((note) => note.dur >= 0.5 && note.articulation === 'tenuto')).toBe(true);
    // 第 1 小節のリズムは step 0 だけ、以降は空。
    expect(piece.phrasePlan.bars[8]!.rhythm.filter(Boolean)).toHaveLength(1);
    expect(piece.phrasePlan.bars[8]!.holdUntilBeat).toBe(16 * 4);
    expect(piece.phrasePlan.bars[9]!.rhythm.some(Boolean)).toBe(false);
  });

  it('pulse: 旋律は休み、和音はパワーコード、ベースはオクターブ 8 分、ドラムは鳴る', () => {
    expect(inSection(piece, piece.melody, 2)).toEqual([]);
    const chords = inSection(piece, piece.chords, 2);
    expect(chords.length).toBeGreaterThan(0);
    for (const chord of chords) {
      expect(chord.voicing).toBe('power');
      expect(chord.colorPcs ?? []).toEqual([]);
      const intervals = chord.midis.slice(1).map((midi, index) => midi - chord.midis[index]!);
      expect(intervals).toEqual([7, 5]);
    }
    // 旋律を持つ区間のパワーコード無し。
    expect(inSection(piece, piece.chords, 0).every((chord) => chord.voicing === undefined)).toBe(true);
    const bass = inSection(piece, piece.bass, 2);
    expect(bass.length).toBe(8 * 8);
    expect(inSection(piece, piece.drums, 2).length).toBeGreaterThan(0);
  });

  it('伴奏: sustain は同じボイシングを再打鍵せず、stab は格子の各ステップで刻む', () => {
    const parts = arrangeSf2Parts(piece);
    const sectionRange = (index: number): [number, number] => {
      const section = piece.songPlan.form.sections[index]!;
      const spb = 60 / piece.bpm;
      return [(piece.loopStartBeat + section.startBar * 4) * spb, (piece.loopStartBeat + (section.startBar + section.bars) * 4) * spb];
    };
    const within = (index: number) => {
      const [start, end] = sectionRange(index);
      return parts.backing.filter((note) => note.startSec >= start - 1e-6 && note.startSec < end - 1e-6);
    };
    const sustainChords = inSection(piece, piece.chords, 1);
    const sustainNotes = within(1);
    const repeated = sustainChords.filter((chord, index) => (
      index > 0 && chord.midis.join(',') === sustainChords[index - 1]!.midis.join(',')
    )).length;
    expect(sustainNotes.length).toBe((sustainChords.length - repeated) * sustainChords[0]!.midis.length);
    expect(sustainNotes.some((note) => note.durSec > (4 * 60) / piece.bpm)).toBe(repeated > 0);
    const stabNotes = within(2);
    expect(stabNotes.length).toBe(8 * 8 * 3);
    // 共有の裏打ちリフも stab 区間は各 8 分、sustain 区間は和音頭だけ。
    const stabChord = inSection(piece, piece.chords, 2)[0]!;
    expect(offbeatBackingRiff(piece, stabChord, 'chordStart')).toHaveLength(Math.round(stabChord.dur / 0.5));
    expect(offbeatBackingRiff(piece, sustainChords[0]!, 'chordStart')).toHaveLength(1);
  });

  it('検証: 先頭区間と主題・引用の元はテクスチャを持てない。正準化は normal を省く', () => {
    const defaults = { tonality: 'major', progressionId: 'royal-pop' } as const;
    const first: SongFormSpec = {
      sections: [{ id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A', texture: 'sustain' }],
      ending: 'loop',
    };
    expect(validateForm(first, defaults).map((issue) => issue.message)).toEqual([
      '先頭区間のテクスチャは通常であること(イントロが主題を借りる)',
    ]);
    const source: SongFormSpec = {
      sections: [
        { id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A' },
        { id: 'P', role: 'development', bars: 8, energy: 5, theme: 'P', texture: 'pulse' },
        { id: "P'", role: 'return', bars: 8, energy: 4, theme: 'P' },
        { id: 'Q', role: 'finale', bars: 8, energy: 4, theme: 'Q', quote: { from: 'P', phrases: [3] } },
      ],
      ending: 'loop',
    };
    expect(validateForm(source, defaults).map((issue) => [issue.section, issue.message])).toEqual([
      ["P'", '主題「P」の元区間「P」がパワーコード連打で旋律を持たない'],
      ['Q', '引用元「P」がパワーコード連打で旋律を持たない'],
    ]);
    const canonical = canonicalForm(
      { sections: [{ ...form.sections[0]!, texture: 'normal' }, form.sections[1]!], ending: 'loop' },
      { progressionId: 'royal-pop', keyRoot: 0, tonality: 'major' },
    ) as SongFormSpec;
    expect('texture' in canonical.sections[0]!).toBe(false);
    expect(canonical.sections[1]!.texture).toBe('sustain');
  });
});
