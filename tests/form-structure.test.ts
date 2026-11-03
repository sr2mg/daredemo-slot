import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compose } from '../src/core/music/compose.js';
import { diagnosePiece, validatePiece } from '../src/core/music/diagnostics.js';
import { resolveForm, totalBars } from '../src/core/music/form.js';
import type { ComposeOptions, SongFormSpec } from '../src/core/music/types.js';

/**
 * 曲型の構造規約を固定する。
 * - 「小節 N がどの区間か」は form.ts だけが知る: 生成器に小節数の固定値による区間算術を書かない。
 * - 曲型は区間数に上限を持たない: プリセット以外の区間列(終止曲型・4小節区間の混在)でも
 *   生成検証を通り、ループ/終止の終わり方が計画どおりになる。
 */

const MUSIC_ROOT = resolve(__dirname, '../src/core/music');

describe('曲型の構造規約', () => {
  it('生成器は小節数の固定値(=== 40 / === 16 / bars >= 16)で区間を決めない', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(MUSIC_ROOT)) {
      if (!name.endsWith('.ts') || name === 'form.ts') continue;
      const text = readFileSync(join(MUSIC_ROOT, name), 'utf8');
      text.split(/\r?\n/).forEach((line, index) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (/\b(bars|piece\.bars|opts\.bars)\s*(===|!==|>=|<)\s*(40|16)\b/.test(line)
          || /\bfloor\(\s*bar\s*\/\s*8\s*\)/.test(line)) {
          offenders.push(`${name}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  const base: Omit<ComposeOptions, 'form'> = {
    progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, seed: 5,
  };

  it('歌ものプリセットは96小節で、終止曲型として完全終止で閉じる', () => {
    const piece = compose({ ...base, form: 'song', tonality: 'minor', progressionId: 'minor-drive' });
    expect(piece.bars).toBe(96);
    expect(piece.ending).toBe('final');
    expect(piece.songPlan.form.sections).toHaveLength(12);
    expect(piece.phrasePlan.bars.at(-1)!.cadence).toBe('closed');
    expect(piece.songPlan.harmony.at(-1)!.tokens).toEqual(['V7m', 'i']);
    expect(piece.chords.at(-1)!.name).toBe('Cm');
    expect(validatePiece(piece)).toEqual([]);
    expect(diagnosePiece(piece).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('明示の区間列(4小節区間の混在・区間ごとの進行)でも生成検証を通る', () => {
    const form: SongFormSpec = {
      sections: [
        { id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A' },
        { id: 'X', role: 'relief', bars: 4, energy: 2, theme: 'X', progressionId: 'fanfare' },
        { id: 'B', role: 'development', bars: 8, energy: 4, theme: 'B', progressionId: 'canon' },
        { id: "A'", role: 'return', bars: 8, energy: 5, theme: 'A' },
        { id: 'Z', role: 'finale', bars: 4, energy: 2, theme: 'X', transform: 'transpose' },
      ],
      ending: 'loop',
    };
    expect(totalBars(resolveForm(form))).toBe(32);
    for (const seed of [1, 7, 42]) {
      const piece = compose({ ...base, form, seed });
      expect(piece.bars).toBe(32);
      expect(piece.songPlan.form.sections.map((section) => section.progressionId))
        .toEqual(['royal-pop', 'fanfare', 'canon', 'royal-pop', 'royal-pop']);
      expect(piece.songPlan.form.sections[3]!.motifSourceSection).toBe('A');
      expect(piece.songPlan.form.sections[4]!.motifSourceSection).toBe('X');
      expect(piece.phrasePlan.bars.at(-1)!.cadence).toBe('turnaround');
      expect(validatePiece(piece), `seed=${seed}`).toEqual([]);
    }
  });

  it('不正な曲型は理由付きで拒否される', () => {
    expect(() => compose({
      ...base,
      form: { sections: [{ id: 'A', role: 'hook', bars: 4, energy: 3, theme: 'A', progressionId: 'canon' }], ending: 'loop' },
    })).toThrow(/曲型が不正.*\[A\]/);
  });
});
