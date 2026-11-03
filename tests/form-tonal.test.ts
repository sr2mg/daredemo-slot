import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { diagnosePiece, validatePiece } from '../src/core/music/diagnostics.js';
import { sectionStartBars } from '../src/core/music/form.js';
import { MAJOR_SCALE, NATURAL_MINOR_SCALE } from '../src/core/music/theory.js';
import type { ComposeOptions, SongFormSpec } from '../src/core/music/types.js';

/**
 * 区間ごとの調(SectionSpec.keyRoot / tonality)。
 * 短調のAメロと平行長調のサビ、終結の属調への転調が、和音の絶対pc・旋律の音組織・
 * 終止の目標音・ベースのペダルまで区間ごとに追従することを固定する。
 */

const base: Omit<ComposeOptions, 'form'> = {
  progressionId: 'minor-drive', styleId: 'eurobeat', keyRoot: 9, bpm: 170, seed: 3, tonality: 'minor',
};

/** 短調A(Am) → 平行長調サビ(C major, canon) → A帰還 → 属調E majorで終止。 */
const form: SongFormSpec = {
  sections: [
    { id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A' },
    { id: 'S', role: 'development', bars: 8, energy: 5, theme: 'S', keyRoot: 0, tonality: 'major', progressionId: 'canon' },
    { id: "A'", role: 'return', bars: 8, energy: 4, theme: 'A', transform: 'literal' },
    { id: 'E', role: 'finale', bars: 8, energy: 4, theme: 'S', transform: 'transpose', keyRoot: 4, tonality: 'major', progressionId: 'royal-pop' },
  ],
  ending: 'final',
};

const scaleOf = (keyRoot: number, major: boolean): number[] => (
  (major ? MAJOR_SCALE : NATURAL_MINOR_SCALE).map((interval) => (interval + keyRoot) % 12)
);

describe('区間ごとの調', () => {
  const piece = compose({ ...base, form });
  const starts = sectionStartBars(piece.songPlan.form);

  it('区間計画が調・進行・音組織を持ち、和声小節が区間の調を引き継ぐ', () => {
    const sections = piece.songPlan.form.sections;
    expect(sections.map((section) => [section.keyRoot, section.tonality]))
      .toEqual([[9, 'minor'], [0, 'major'], [9, 'minor'], [4, 'major']]);
    expect(sections[1]!.scalePcs).toEqual(scaleOf(0, true));
    expect(sections[3]!.scalePcs).toEqual(scaleOf(4, true));
    expect(sections.map((section) => section.progressionId)).toEqual(['minor-drive', 'canon', 'minor-drive', 'royal-pop']);
    for (const bar of piece.songPlan.harmony) {
      const section = sections.find((candidate) => candidate.id === bar.section)!;
      expect([bar.keyRoot, bar.tonality]).toEqual([section.keyRoot, section.tonality]);
    }
  });

  it('和音は区間の調で絶対pcへ展開され、サビの冒頭は C、終結は E major の V→I で閉じる', () => {
    const chordAtBar = (bar: number) => piece.chords.find((chord) => chord.beat === piece.loopStartBeat + bar * 4)!;
    expect(chordAtBar(starts[0]!).name).toBe('Am');
    expect(chordAtBar(starts[1]!).name).toBe('C');
    expect(chordAtBar(starts[1]!).rootPc).toBe(0);
    expect(chordAtBar(starts[2]!).name).toBe('Am');
    const finalBar = piece.songPlan.harmony.at(-1)!;
    expect(finalBar.tokens).toEqual(['V', 'I']);
    expect(piece.chords.at(-1)!.name).toBe('E');
    expect(piece.chords.at(-1)!.pcs).toEqual([4, 8, 11]);
    expect(piece.barChordNames[starts[1]!]).toMatch(/^C/);
  });

  it('旋律の弱拍は区間の音組織に収まり、終止の目標音は区間の調で測られる', () => {
    const sections = piece.songPlan.form.sections;
    for (const note of piece.melody) {
      if (note.role === 'ornament' || note.beat < piece.loopStartBeat) continue;
      const bar = Math.floor((note.beat - piece.loopStartBeat) / 4);
      const section = sections.find((candidate) => bar >= candidate.startBar && bar < candidate.startBar + candidate.bars)!;
      const chord = piece.chords.reduce((current, candidate) => (candidate.beat <= note.beat ? candidate : current), piece.chords[0]!);
      const allowed = new Set([...section.scalePcs, ...chord.pcs]);
      // 強拍倚音の解決先や変位和音の半音は和音側から来るので、区間の音階か和音の構成音のどちらかに入る。
      expect(allowed.has(note.midi % 12), `bar ${bar + 1} (${section.id}) midi ${note.midi}`).toBe(true);
    }
    expect(validatePiece(piece)).toEqual([]);
    expect(diagnosePiece(piece).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('同じ曲型でも区間の調指定を外すと曲既定の調へ戻る(正規化の省略規則と一致)', () => {
    const plain: SongFormSpec = {
      ...form,
      sections: form.sections.map(({ keyRoot: _k, tonality: _t, progressionId: _p, ...rest }) => rest),
    };
    const flat = compose({ ...base, form: plain });
    expect(new Set(flat.songPlan.form.sections.map((section) => `${section.keyRoot}/${section.tonality}`)).size).toBe(1);
    expect(flat.chords.every((chord) => chord.name !== 'E' || chord.pcs.includes(8))).toBe(true);
  });

  it('ベースライン装置は調の境界をまたいでも検証を通る', () => {
    for (const seed of [1, 2, 3]) {
      const lined = compose({ ...base, form, seed, bassLine: 'on' });
      expect(validatePiece(lined), `seed=${seed}`).toEqual([]);
      const report = diagnosePiece(lined);
      expect(report.issues.filter((issue) => issue.severity === 'error'), `seed=${seed}`).toEqual([]);
      // bassPc は小節の調からの相対度数を絶対pcへ写したもの。和音の構成音か半音経過のどちらか。
      for (const chord of lined.chords) {
        if (chord.bassPc === undefined) continue;
        expect(chord.bassPc).toBeGreaterThanOrEqual(0);
        expect(chord.bassPc).toBeLessThan(12);
      }
    }
  });
});
