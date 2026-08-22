import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { validatePiece } from '../src/core/music/diagnostics.js';
import { CURRENT_ENGINE_REV } from '../src/core/music/types.js';

/**
 * engineRevの一点式バージョニングの回帰テスト。
 * rev2 = 主題ジェスチャー抽選を主系列rngから区間ごとの独立ストリームへ分離。
 * 保存曲(rev1以前)の再現性と、rev2の新経路の健全性を固定する。
 */

describe('engineRevゲート(rev2: 主題ジェスチャーの独立ストリーム化)', () => {
  const base = {
    progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, bars: 16, seed: 21,
  } as const;

  it('現行リビジョンはrev2(保存曲の焼き込み値の前提)', () => {
    expect(CURRENT_ENGINE_REV).toBe(2);
  });

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
