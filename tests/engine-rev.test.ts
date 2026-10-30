import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { diagnosePiece, validatePiece } from '../src/core/music/diagnostics.js';
import { variedChoiceFor } from '../src/core/music/harmony-plan.js';
import { CURRENT_ENGINE_REV } from '../src/core/music/types.js';
import type { ComposeOptions, Piece } from '../src/core/music/types.js';
import { LOOP_BOUNDARY_MAX_SEMITONES, progressionsForTonality } from '../src/core/music/theory.js';

/**
 * engineRevの一点式バージョニングの回帰テスト。
 * rev2 = 主題ジェスチャー抽選を主系列rngから区間ごとの独立ストリームへ分離。
 * rev3 = ファズ監査(現行rev)で露出した生成と診断の乖離3点を生成側で閉じる。
 * 保存曲(旧リビジョン)の再現性と、新経路の健全性を固定する。
 */

/** ファズコーパスと同じ組み立て(40小節・BPM150・進行ごとの変奏選択)。 */
function corpusCase(
  progressionId: string,
  tonality: 'major' | 'minor',
  styleId: string,
  compositionStrategy: 'current' | 'memoryArc' | 'premiseArc',
  seed: number,
  keyRoot: number,
): ComposeOptions {
  const prog = progressionsForTonality(tonality).find((candidate) => candidate.id === progressionId)!;
  return {
    progressionId, styleId, keyRoot, bpm: 150, bars: 40, tonality, seed,
    choice: variedChoiceFor(prog, 40, seed), compositionStrategy,
  };
}

function loopBoundary(piece: Piece): number {
  const body = piece.melody.filter((note) => note.beat >= piece.loopStartBeat && note.role !== 'ornament');
  return Math.abs(body[0]!.midi - body.at(-1)!.midi);
}

describe('engineRevゲート(rev3: ファズ監査の乖離を生成側で閉じる)', () => {
  it('現行リビジョンはrev3(保存曲の焼き込み値の前提)', () => {
    expect(CURRENT_ENGINE_REV).toBe(3);
  });

  it('ターンアラウンドの着地音はループ頭の実音に合わせ、境界跳躍が許容内になる', () => {
    // rev2: 最初の発音(84)が高く、目標音級の最寄りがクライマックス以上→クランプで76へ落ちて8半音。
    const base = corpusCase('canon', 'major', 'rock', 'memoryArc', 7920, 5);
    const rev2 = compose({ ...base, engineRev: 2 });
    const rev3 = compose({ ...base, engineRev: 3 });
    expect(loopBoundary(rev2)).toBeGreaterThan(LOOP_BOUNDARY_MAX_SEMITONES);
    expect(loopBoundary(rev3)).toBeLessThanOrEqual(LOOP_BOUNDARY_MAX_SEMITONES);
    expect(diagnosePiece(rev3).issues.filter((issue) => issue.category === 'loop')).toEqual([]);
    expect(diagnosePiece(rev3).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    // 差は主旋律の終止小節だけ(着地音級を差し替えた場合は計画の targetPc も追従する)。
    const lastBarStart = rev2.beats - 4;
    expect(rev3.melody.filter((note) => note.beat < lastBarStart))
      .toEqual(rev2.melody.filter((note) => note.beat < lastBarStart));
    expect(rev3.melody).not.toEqual(rev2.melody);
    expect(rev3.phrasePlan.bars.at(-1)!.targetPc).toBe(rev3.melody.at(-1)!.midi % 12);
    expect(rev3.chords).toEqual(rev2.chords);
    expect(rev3.drums).toEqual(rev2.drums);
  });

  it('倚音の解決は順次に限り、増2度の解決で強拍非和声音が残らない', () => {
    // rev2: 和声的短音階のコードスケール(V7上)で C→D# を解決先に取り、倚音の契約が破れていた。
    const base = corpusCase('royal-pop', 'minor', 'kmmo', 'premiseArc', 63353, 4);
    const rev2 = compose({ ...base, engineRev: 2 });
    const rev3 = compose({ ...base, engineRev: 3 });
    expect(validatePiece(rev2).map((issue) => issue.reason)).toContain('強拍が B7 のコードトーン外');
    expect(validatePiece(rev3)).toEqual([]);
    expect(diagnosePiece(rev3).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('開放終止のベース5度は和音の品質に追従し、減三和音上で和声外に落ちない', () => {
    // rev2: iiDim上の開放終止で機械的な完全5度(和声外)。持続サブは小節全体が動いていた。
    const base = corpusCase('fanfare', 'minor', 'dnb', 'premiseArc', 87110, 7);
    const rev2 = compose({ ...base, engineRev: 2 });
    const rev3 = compose({ ...base, engineRev: 3 });
    const bassWarnings = (piece: Piece): number => diagnosePiece(piece).issues
      .filter((issue) => issue.reason.startsWith('ベースの経過音')).length;
    expect(bassWarnings(rev2)).toBeGreaterThan(0);
    expect(bassWarnings(rev3)).toBe(0);
    // 差はベースだけ。
    expect(rev3.melody).toEqual(rev2.melody);
    expect(rev3.chords).toEqual(rev2.chords);
    expect(rev3.bass).not.toEqual(rev2.bass);
  });
});

describe('engineRevゲート(rev2: 主題ジェスチャーの独立ストリーム化)', () => {
  const base = {
    progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, bars: 16, seed: 21,
  } as const;

  it('rev2で主題(モチーフ)と旋律が変わり、検証エラーは出ない', () => {
    const rev1 = compose({ ...base, engineRev: 1 });
    const rev2 = compose({ ...base, engineRev: 2 });
    expect(rev2.motif).not.toEqual(rev1.motif);
    expect(rev2.melody).not.toEqual(rev1.melody);
    expect(validatePiece(rev2)).toEqual([]);
  });

  it('rev1以前の保存曲は独立ストリーム化の影響を受けない(rev0とrev1で主題・旋律が同一)', () => {
    const rev0 = compose(base);
    const rev1 = compose({ ...base, engineRev: 1 });
    expect(rev1.motif).toEqual(rev0.motif);
    expect(rev1.melody).toEqual(rev0.melody);
  });
});
