import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import type { ComposeOptions, Piece, TupletDivision } from '../src/core/music/compose.js';
import { diagnosePiece } from '../src/core/music/diagnostics.js';

/**
 * 連符オーバーレイ（暗示的メトリック・モジュレーション）の検証。
 *
 * 設計の核は「基準面の不動」: 連符レイヤーは分散和音だけを1小節div等分の
 * グリッドへ乗せ、旋律・低音・ドラム・コードは8分/16分の基準グリッドから
 * 一切動かさない。錯覚（暗示テンポ bpm×div/4）は両グリッドの摩擦で生まれる。
 */

const base: ComposeOptions = {
  progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, bars: 16, seed: 11,
};

interface SectionRange {
  start: number;
  end: number;
  tuplet: TupletDivision | null;
}

function sectionRanges(piece: Piece): SectionRange[] {
  const barsPerSection = piece.bars === 40 ? 8 : piece.bars === 16 ? 8 : piece.bars;
  return piece.arrangementPlan.sections.map((section, index) => ({
    start: piece.loopStartBeat + index * barsPerSection * 4,
    end: piece.loopStartBeat + (index + 1) * barsPerSection * 4,
    tuplet: section.ostinatoTuplet,
  }));
}

const nearInteger = (value: number): boolean => Math.abs(value - Math.round(value)) < 1e-6;

describe('連符オーバーレイ', () => {
  it('省略とoffは同一の曲になる', () => {
    expect(compose({ ...base, tupletOverlay: 'off' })).toEqual(compose(base));
  });

  it('分割数を変えても基準面（旋律・低音・ドラム・コード・副旋律）は1音も動かない', () => {
    const p5 = compose({ ...base, tupletOverlay: 5 });
    const p7 = compose({ ...base, tupletOverlay: 7 });
    expect(p7.melody).toEqual(p5.melody);
    expect(p7.bass).toEqual(p5.bass);
    expect(p7.drums).toEqual(p5.drums);
    expect(p7.chords).toEqual(p5.chords);
    expect(p7.counterMelody).toEqual(p5.counterMelody);
    expect(p5.ostinato.length).toBeGreaterThan(0);
    expect(p7.ostinato.map((n) => n.beat)).not.toEqual(p5.ostinato.map((n) => n.beat));
  });

  it('連符打点は宣言グリッドへ正確に乗り、他声部は基準グリッドに留まる', () => {
    const piece = compose({ ...base, tupletOverlay: 7 });
    const ranges = sectionRanges(piece);
    const tupletRanges = ranges.filter((range) => range.tuplet !== null);
    expect(tupletRanges.length).toBeGreaterThan(0);
    for (const note of piece.ostinato) {
      const range = ranges.find((r) => note.beat >= r.start && note.beat < r.end);
      expect(range).toBeDefined();
      const offsetInBar = (note.beat - piece.loopStartBeat) % 4;
      if (range!.tuplet !== null) {
        // 半小節をdiv等分したグリッド（密度1=1小節div等分を包含）
        expect(nearInteger(offsetInBar * range!.tuplet / 2)).toBe(true);
      } else {
        expect(nearInteger(offsetInBar * 12)).toBe(true);
      }
    }
    // 基準面の全声部は8分/16分（bounce 2/3含む）グリッドの上
    for (const voice of [piece.melody, piece.counterMelody, piece.bass]) {
      for (const note of voice) expect(nearInteger((note.beat % 4) * 12)).toBe(true);
    }
    for (const drum of piece.drums) expect(nearInteger((drum.beat % 4) * 12)).toBe(true);
  });

  it('通常小節は暗示テンポ（bpm×div/4）の4分として等間隔で鳴る', () => {
    const piece = compose({ ...base, tupletOverlay: 5 });
    const byBar = new Map<number, number[]>();
    for (const note of piece.ostinato) {
      const bar = Math.floor((note.beat - piece.loopStartBeat) / 4);
      byBar.set(bar, [...(byBar.get(bar) ?? []), note.beat]);
    }
    // 密度1の完全小節: 5打点・間隔4/5拍。終止小節や加速小節もあるため「1つ以上」を要求する。
    const uniformBars = [...byBar.values()].filter((beats) => {
      if (beats.length !== 5) return false;
      const sorted = [...beats].sort((a, b) => a - b);
      return sorted.every((beat, i) => i === 0 || Math.abs(beat - sorted[i - 1]! - 4 / 5) < 1e-6);
    });
    expect(uniformBars.length).toBeGreaterThan(0);
  });

  it('autoは区間エネルギーで段階づけ、頂点のオスティナート区間が7連になる', () => {
    const piece = compose({
      progressionId: 'minor-pedal', styleId: 'eurobeat', keyRoot: 0, bpm: 150,
      bars: 40, tonality: 'minor', seed: 42, tupletOverlay: 'auto',
    });
    const arpSections = piece.arrangementPlan.sections
      .map((section, index) => ({ section, energy: piece.songPlan.form.sections[index]!.energy }))
      .filter(({ section }) => section.ostinatoDensity > 0);
    expect(arpSections.length).toBeGreaterThan(0);
    for (const { section } of arpSections) {
      expect([5, 6, 7]).toContain(section.ostinatoTuplet);
    }
    const peak = arpSections.reduce((a, b) => (b.energy > a.energy ? b : a));
    expect(peak.section.ostinatoTuplet).toBe(7);
  });

  it('オスティナートの窓は最短声部連結で繋がり、小節間で跳ばない', () => {
    // ルート密着（旧実装）はこのフィクスチャでF(65)→G(55)と10半音落ちる。
    // 最短連結の窓は前の窓の近傍から転回形を選ぶため、隣接小節の最低音は近接する。
    const piece = compose({ ...base, tupletOverlay: 5 });
    const lowestByBar = new Map<number, number>();
    for (const note of piece.ostinato) {
      const bar = Math.floor((note.beat - piece.loopStartBeat) / 4);
      lowestByBar.set(bar, Math.min(lowestByBar.get(bar) ?? Infinity, note.midi));
    }
    const bars = [...lowestByBar.keys()].sort((a, b) => a - b);
    expect(bars.length).toBeGreaterThan(1);
    for (let i = 1; i < bars.length; i++) {
      if (bars[i]! !== bars[i - 1]! + 1) continue;
      expect(Math.abs(lowestByBar.get(bars[i]!)! - lowestByBar.get(bars[i - 1]!)!)).toBeLessThanOrEqual(7);
    }
  });

  it('和声が動く区間では転回形の窓が選ばれ、毎小節ルートへ戻らない', () => {
    const piece = compose({
      progressionId: 'minor-pedal', styleId: 'eurobeat', keyRoot: 0, bpm: 150,
      bars: 40, tonality: 'minor', seed: 42, tupletOverlay: 'auto',
    });
    const chordAt = (beat: number) => piece.chords.filter((c) => c.beat <= beat).at(-1)!;
    const lowestByBar = new Map<number, { beat: number; midi: number }>();
    for (const note of piece.ostinato) {
      const bar = Math.floor((note.beat - piece.loopStartBeat) / 4);
      const current = lowestByBar.get(bar);
      if (!current || note.midi < current.midi) lowestByBar.set(bar, note);
    }
    // 例: Cm(C-E♭-G)→G7では、ルートのGへ落ちるのではなくC→Bの半音接続で
    // 第1転回形（B最低音）が選ばれる。最低音pc≠ルートpcの小節がその証拠。
    const inverted = [...lowestByBar.values()]
      .filter((note) => chordAt(note.beat).pcs[0]! !== note.midi % 12);
    expect(inverted.length).toBeGreaterThan(0);
  });

  it('三連オーバーレイとの併用時は静かに無効化される', () => {
    const withTuplet = compose({ ...base, grooveFeel: 'tripletOverlay', tupletOverlay: 7 });
    expect(withTuplet).toEqual(compose({ ...base, grooveFeel: 'tripletOverlay' }));
    expect(withTuplet.arrangementPlan.sections.every((s) => s.ostinatoTuplet === null)).toBe(true);
  });

  it('2A03では無効化される', () => {
    const withTuplet = compose({ ...base, soundChip: 'nes2a03', tupletOverlay: 7 });
    expect(withTuplet).toEqual(compose({ ...base, soundChip: 'nes2a03' }));
  });

  it('決定論: 同一オプションは同一の曲になる', () => {
    const options: ComposeOptions = { ...base, tupletOverlay: 'auto' };
    expect(compose(options)).toEqual(compose(options));
  });

  it('診断エラーを出さない', () => {
    for (const tupletOverlay of ['auto', 5, 6, 7] as const) {
      const report = diagnosePiece(compose({ ...base, tupletOverlay }));
      expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    }
  });
});
