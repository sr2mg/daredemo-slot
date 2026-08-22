import { describe, expect, it } from 'vitest';
import { bassDegreesFor } from '../src/core/music/bassline.js';
import { compose } from '../src/core/music/compose.js';
import { CURRENT_ENGINE_REV } from '../src/core/music/types.js';
import { diagnosePiece } from '../src/core/music/diagnostics.js';

/**
 * ベースライン生成器(bassline.ts)と、その配線(bassDegrees → ChordEvent.bassPc →
 * ベース声部/診断)のテスト。実測様式の骨子「ルート跳躍より順次のライン」が
 * DPのコスト設計から創発することを、小さな断片と実曲の両方で固定する。
 */

describe('bassDegreesFor(和声計画からのベース度数DP)', () => {
  it('曲頭と終止(turnaround)はルートポジションで固定される', () => {
    const result = bassDegreesFor([
      { tokens: ['I'], durations: [4], cadence: null },
      { tokens: ['V'], durations: [4], cadence: 'turnaround' },
    ]);
    // I→Vはd5の跳躍だがVは終止ロック。全ルートの小節は省略(undefined)になる。
    expect(result).toEqual([undefined, undefined]);
  });

  it('跳躍進行では転回をベースに置いて順次ライン(do-re-mi-fa)を作る', () => {
    const result = bassDegreesFor([
      { tokens: ['I'], durations: [4], cadence: null },
      { tokens: ['V'], durations: [4], cadence: null },
      { tokens: ['vi'], durations: [4], cadence: null },
      { tokens: ['IV'], durations: [4], cadence: 'turnaround' },
    ]);
    // ルートだと 0→7→9→5(跳躍だらけ)。DPは V/2̂・vi/3̂ を選び 0→2→4→5 の
    // 完全な上行順次ラインへ組み替える(終止IVはロックでルートのまま)。
    expect(result).toEqual([undefined, [2], [4], undefined]);
  });

  it('同一和音の分割では半音経過(コードトーン外)で次の根音へ降りる', () => {
    const result = bassDegreesFor([
      { tokens: ['ii', 'ii'], durations: [2, 2], cadence: null },
      { tokens: ['I'], durations: [4], cadence: 'turnaround' },
    ]);
    // 2̂→(♯1̂)→1̂: 後半のiiだけベースが半音下がり、静止(コスト3)より安く次へ届く。
    expect(result).toEqual([[null, 1], undefined]);
  });

  it('bassDegreesはtokensと同じ長さで、ルートポジションはnullになる', () => {
    const result = bassDegreesFor([
      { tokens: ['ii', 'ii'], durations: [2, 2], cadence: null },
      { tokens: ['I'], durations: [4], cadence: 'turnaround' },
    ]);
    expect(result[0]).toHaveLength(2);
    expect(result[0]![0]).toBeNull();
  });
});

describe('bassLine装置の配線(compose)', () => {
  const base = {
    progressionId: 'royal-pop',
    styleId: 'kmmo',
    keyRoot: 0,
    bpm: 120,
    bars: 16,
    seed: 3,
    engineRev: CURRENT_ENGINE_REV,
  } as const;

  it('既定はoff: どのコードにもbassPcが付かない', () => {
    const piece = compose(base);
    expect(piece.chords.every((chord) => chord.bassPc === undefined)).toBe(true);
  });

  it('onで転回がbassPcへ書かれ、ベース声部が追従し、診断警告を出さない', () => {
    const piece = compose({ ...base, bassLine: 'on' });
    const withBass = piece.chords.filter((chord) => chord.bassPc !== undefined);
    expect(withBass.length).toBeGreaterThan(0);
    // コード頭のベース音は指定されたベース音を弾く(終止処理は小節末しか触らない)。
    for (const chord of withBass) {
      const head = piece.bass.find((note) => note.beat === chord.beat);
      expect(head, `beat ${chord.beat} のベースが見つからない`).toBeDefined();
      expect(head!.midi % 12).toBe(chord.bassPc);
    }
    const report = diagnosePiece(piece);
    expect(report.issues.filter((issue) => issue.reason.includes('ベースの経過音'))).toEqual([]);
  });

  it('半音経過ベース(コードトーン外のbassPc)も診断を通る', () => {
    const piece = compose({
      ...base, seed: 42, tonality: 'minor', bassLine: 'on',
    });
    const chromatic = piece.chords.filter(
      (chord) => chord.bassPc !== undefined && !chord.pcs.includes(chord.bassPc),
    );
    expect(chromatic.length).toBeGreaterThan(0);
    const report = diagnosePiece(piece);
    expect(report.issues.filter((issue) => issue.reason.includes('ベースの経過音'))).toEqual([]);
  });

  it('装置はベースだけを変え、旋律・和声トークン列には触れない', () => {
    const off = compose(base);
    const on = compose({ ...base, bassLine: 'on' });
    expect(on.melody).toEqual(off.melody);
    expect(on.chords.map((chord) => chord.token)).toEqual(off.chords.map((chord) => chord.token));
  });
});

describe('engineRevゲート(rev1: ベースアンカーの最短連結)', () => {
  const base = {
    progressionId: 'royal-pop',
    styleId: 'kmmo',
    keyRoot: 0,
    bpm: 120,
    bars: 16,
    seed: 11,
    tonality: 'minor',
  } as const;

  it('rev0(未指定)とrev1でベースが変わり、旋律は変わらない', () => {
    const rev0 = compose(base);
    const rev1 = compose({ ...base, engineRev: CURRENT_ENGINE_REV });
    expect(rev1.bass).not.toEqual(rev0.bass);
    expect(rev1.melody).toEqual(rev0.melody);
  });

  it('rev1のベースアンカーはD#2..D3窓に収まる', () => {
    const rev1 = compose({ ...base, engineRev: CURRENT_ENGINE_REV, bassLine: 'on' });
    // 終止の接近音(36..64)を含む全ベース音でも、逸脱しないことの粗い上限を固定する。
    for (const note of rev1.bass) {
      expect(note.midi).toBeGreaterThanOrEqual(36);
      expect(note.midi).toBeLessThanOrEqual(64);
    }
  });
});
