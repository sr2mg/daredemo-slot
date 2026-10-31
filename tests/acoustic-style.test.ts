import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { diagnosePiece, validatePiece } from '../src/core/music/diagnostics.js';
import {
  CHORDS, MAJOR_HEXATONIC_SCALE, MAJOR_PENTATONIC_SCALE, MINOR_HEXATONIC_SCALE, PROGRESSIONS,
  STYLES, progressionForTonality, stackedFifthsScale,
} from '../src/core/music/theory.js';
import { normalizeComposeOptions } from '../src/core/music/options.js';
import type { ComposeDraft } from '../src/core/music/options.js';

import { CURRENT_ENGINE_REV } from '../src/core/music/types.js';
import type { ComposeOptions } from '../src/core/music/types.js';

/**
 * アコースティック(弾き語り)様式と、それを支える3つの語彙の検証:
 * - 打楽器なし + 分散和音の常設伴奏 + 持続低音(StyleDef の宣言フィールドで分岐する)
 * - 主音に着地しない進行(drifting-orbit)と3度を薄めた属和音・掛留のトークン
 * - 五度圏6連続から導く六音語法(hexatonic)
 */

const base: ComposeOptions = {
  progressionId: 'drifting-orbit', styleId: 'acoustic', keyRoot: 9, bpm: 112, bars: 16, seed: 42,
  melodicLanguage: 'hexatonic', soundChip: 'pcm', engineRev: CURRENT_ENGINE_REV,
};

describe('音階の導出(五度圏の連続音)', () => {
  it('5連続は既存の長五音と同値、6連続は長音階から第4音を抜いた六音', () => {
    expect(stackedFifthsScale(5)).toEqual([...MAJOR_PENTATONIC_SCALE]);
    expect([...MAJOR_HEXATONIC_SCALE]).toEqual([0, 2, 4, 7, 9, 11]);
    // 相対短調の回転: 自然短音階から第6音を抜いた形(短五音+長2度)。
    expect([...MINOR_HEXATONIC_SCALE]).toEqual([0, 2, 3, 5, 7, 10]);
    // 7連続はリディア(第4音が#4になる)。長音階そのものではない。
    expect(stackedFifthsScale(7)).toEqual([0, 2, 4, 6, 7, 9, 11]);
  });
});

describe('3度を薄めた和音トークン', () => {
  it('tonesは品質表から導出され、rootから始まる', () => {
    expect([...CHORDS.Vadd9!.tones]).toEqual([7, 11, 2, 9]);
    expect([...CHORDS.V6!.tones]).toEqual([7, 11, 2, 4]);
    expect([...CHORDS.Isus2!.tones]).toEqual([0, 2, 7]);
    expect([...CHORDS.VIIsus4!.tones]).toEqual([10, 3, 5]);
    // 掛留の主和音は着地判定の対象外(colour)。属系は b7 を持たなくても dominant。
    expect(CHORDS.Isus2!.function).toBe('colour');
    expect(CHORDS.Vadd9!.function).toBe('dominant');
    expect(CHORDS.V6!.tones).not.toContain(5);
    expect(CHORDS.Vadd9!.tones).not.toContain(5);
  });

  it('主音不在ループは長調スロットに主和音(root=0のtonic)を一つも持たず、短調へも解決できる', () => {
    const prog = PROGRESSIONS.find((p) => p.id === 'drifting-orbit')!;
    for (const slot of prog.slots) {
      for (const option of slot) {
        for (const token of option) {
          const def = CHORDS[token]!;
          expect(def.root === 0 && def.function === 'tonic', token).toBe(false);
        }
      }
    }
    const minor = progressionForTonality(prog, 'minor')!;
    expect(minor.slots).toHaveLength(4);
    for (const slot of minor.slots) {
      for (const option of slot) for (const token of option) expect(CHORDS[token], token).toBeDefined();
    }
    // variations の添字は両調性のスロット選択肢数に収まる(harmony-plan の展開が参照する)。
    for (const realized of [prog, minor]) {
      for (const recipe of [realized.defaultChoice, ...realized.variations]) {
        recipe.forEach((choice, bar) => {
          expect(realized.slots[bar]!.length, `${realized.tonality}/bar${bar + 1}`).toBeGreaterThan(choice);
        });
      }
    }
  });
});

describe('六音語法は全進行・全スタイル・両調性で生成検証を通る', () => {
  it('hexatonic × 全進行 × 全スタイル × 8小節', () => {
    for (const prog of PROGRESSIONS) {
      for (const tonality of ['major', 'minor'] as const) {
        if (!progressionForTonality(prog, tonality)) continue;
        for (const style of STYLES) {
          for (const seed of [3, 1234]) {
            const piece = compose({
              ...base, progressionId: prog.id, styleId: style.id, tonality, bars: 8, seed, keyRoot: (seed * 5) % 12,
            });
            expect(validatePiece(piece), `${prog.id}/${tonality}/${style.id}/seed=${seed}`).toEqual([]);
            expect(piece.melodicScalePcs, `${prog.id}/${tonality}`).toHaveLength(6);
          }
        }
      }
    }
  });
});

describe('アコースティック様式', () => {
  const style = STYLES.find((s) => s.id === 'acoustic')!;

  it('宣言フィールド: 打楽器なし・分散和音は伴奏役・低音は持続', () => {
    expect(style.percussion.kind).toBe('none');
    expect(style.texture.ostinato).toBe('accompaniment');
    expect(style.bass.pattern).toBe('sustain');
    expect(style.defaults.bpm).toBe(112);
  });

  it('本編にもイントロにもドラムイベントが無い(フィル・シンバル・ブレイクダウン含む)', () => {
    for (const bars of [8, 16, 40] as const) {
      for (const seed of [1, 42, 12345]) {
        const piece = compose({ ...base, bars, seed });
        expect(piece.drums, `bars=${bars}/seed=${seed}`).toEqual([]);
        expect(validatePiece(piece), `bars=${bars}/seed=${seed}`).toEqual([]);
      }
    }
  });

  it('分散和音は全区間で有効になり、本編の全小節で鳴る', () => {
    for (const bars of [8, 16, 40] as const) {
      const piece = compose({ ...base, bars, seed: 7 });
      for (const section of piece.arrangementPlan.sections) {
        expect(section.ostinatoDensity, `bars=${bars}`).toBeGreaterThan(0);
      }
      for (let bar = 0; bar < bars; bar++) {
        const start = piece.loopStartBeat + bar * 4;
        const inBar = piece.ostinato.filter((note) => note.beat >= start && note.beat < start + 4);
        expect(inBar.length, `bars=${bars}/bar=${bar + 1}`).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('独立アルペジオの予算が無いバックエンド(2A03)では常設化を強要しない', () => {
    // 未解決: compact 戦略(texture.compactStrategy='bassDrive')へ落ちると、様式の核である
    // 常設分散和音が 2A03 では失われる。ここは現状の挙動(床を敷かない)を固定するだけで、
    // 是認ではない。pulse2 を伴奏から分散和音へ振る編曲が入ったら期待値を変える。
    const piece = compose({ ...base, soundChip: 'nes2a03', bars: 16 });
    expect(piece.ostinato).toEqual([]);
    expect(validatePiece(piece)).toEqual([]);
  });

  it('低音は各コードイベントの頭で持続する(刻まない)', () => {
    const piece = compose({ ...base, bars: 8, seed: 42 });
    for (const chord of piece.chords) {
      const head = piece.bass.find((note) => Math.abs(note.beat - chord.beat) < 0.001);
      expect(head, `beat=${chord.beat}`).toBeDefined();
      expect(head!.dur).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('六音語法の旋律は調の第4音(IVの根音)を使わず、強拍は和音と語法の共通音へ着地する', () => {
    const fourth = (base.keyRoot + 5) % 12;
    for (const seed of [1, 42, 12345]) {
      const piece = compose({ ...base, seed });
      expect(piece.melodicScalePcs).toHaveLength(6);
      expect(piece.melodicScalePcs).not.toContain(fourth);
      const body = piece.melody.filter((note) => note.beat >= piece.loopStartBeat && note.role !== 'ornament');
      expect(body.map((note) => note.midi % 12), `seed=${seed}`).not.toContain(fourth);
      expect(diagnosePiece(piece).issues.filter((issue) => issue.severity === 'error'), `seed=${seed}`).toEqual([]);
    }
  });

  it('保存JSONは六音語法を明示し、標準語法は省く(キャッシュキーの同一性)', () => {
    const draft: ComposeDraft = {
      progressionId: 'drifting-orbit', styleId: 'acoustic', keyRoot: 9, bpm: 112, bars: 16, seed: 42,
      choice: [0, 0, 0, 0], soundChip: 'pcm', intro: true, tonality: 'major',
      melodicLanguage: 'hexatonic', japaneseScale: 'auto', grooveFeel: 'straight', tupletOverlay: 'off',
      tensionPolicy: 'auto', diminution: 'auto', duet: 'auto', glide: 'auto',
      voices: {}, opllUserPatch: 'brightLead', nes: {},
    };
    expect(normalizeComposeOptions(draft).melodicLanguage).toBe('hexatonic');
    expect(normalizeComposeOptions({ ...draft, melodicLanguage: 'standard' })).not.toHaveProperty('melodicLanguage');
  });
});

describe('5音の開離配置で周回する主音不在ループ', () => {
  const dense = [2, 3, 3, 3] as const;
  const choiceFor = (bars: number) => Array.from({ length: bars }, (_, bar) => dense[bar % 4]!);

  it('キーAで参照音源と同じ4和音(F#m7add11 / DM13 / E69 / B9sus4)になり、伴奏は5声の密集配置', () => {
    const piece = compose({ ...base, bars: 8, seed: 42, choice: choiceFor(8) });
    const names = piece.chords.slice(0, 4).map((chord) => chord.name);
    expect(names).toEqual(['F#m7add11', 'DM13', 'E69', 'B9sus4']);
    for (const chord of piece.chords) {
      expect(chord.pcs, chord.name).toHaveLength(5);
      expect(chord.midis, chord.name).toHaveLength(5);
      expect(chord.midis.at(-1)! - chord.midis[0]!, chord.name).toBeLessThanOrEqual(14);
      // 5音で密集配置の上限に達するのでカラートーンは足さない。
      expect(chord.colorPcs ?? [], chord.name).toEqual([]);
    }
    // 低音は「A/B」の B を弾く(II9sus4 のルート)。
    const fourth = piece.chords[3]!;
    const bassAtFourth = piece.bass.find((note) => Math.abs(note.beat - fourth.beat) < 0.001)!;
    expect(bassAtFourth.midi % 12).toBe(11);
  });

  it('5音ループは全バックエンド・両調性・六音語法で生成検証を通る', () => {
    for (const soundChip of ['pcm', 'opll', 'nes2a03'] as const) {
      for (const tonality of ['major', 'minor'] as const) {
        for (const bars of [8, 16] as const) {
          const piece = compose({ ...base, soundChip, tonality, bars, seed: 7, choice: choiceFor(bars) });
          expect(validatePiece(piece), `${soundChip}/${tonality}/${bars}`).toEqual([]);
          const errors = diagnosePiece(piece).issues.filter((issue) => issue.severity === 'error');
          expect(errors, `${soundChip}/${tonality}/${bars}`).toEqual([]);
        }
      }
    }
  });
});
