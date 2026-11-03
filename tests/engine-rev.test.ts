import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { normalizeComposeOptions } from '../src/core/music/options.js';
import { CURRENT_ENGINE_REV, engineRevOf } from '../src/core/music/types.js';
import type { ComposeOptions } from '../src/core/music/types.js';

/**
 * engineRevの一点式バージョニング。
 * rev5 で曲型を区間リストへ作り替えた際に旧リビジョン(rev0〜4)の再現経路を削除した
 * (ユーザー不在のうちのリセット)。以後、engineRev の値は読まれず常に現行として生成する。
 * 次に音を変える生成器変更を入れるときは rev6 のゲートを足し、ここへ再現テストを戻す。
 */

const base: ComposeOptions = {
  progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, form: 'loop16', seed: 21,
};

describe('engineRev(rev5: 曲型を区間リストへ、旧リビジョンの再現経路を削除)', () => {
  it('現行リビジョンはrev5(保存曲の焼き込み値の前提)', () => {
    expect(CURRENT_ENGINE_REV).toBe(5);
  });

  it('engineRev の値は読まれず、省略・旧値・現行値で同じ音になる', () => {
    const current = compose(base);
    for (const engineRev of [undefined, 0, 2, 4, 5, 99]) {
      expect(engineRevOf(engineRev === undefined ? {} : { engineRev })).toBe(CURRENT_ENGINE_REV);
      expect(compose({ ...base, ...(engineRev === undefined ? {} : { engineRev }) })).toEqual(current);
    }
  });

  it('正規化は現行リビジョンを焼く', () => {
    const options = normalizeComposeOptions({
      progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, form: 'loop16', seed: 11,
      choice: [], soundChip: 'opll', intro: true, tonality: 'major', melodicLanguage: 'standard',
      japaneseScale: 'auto', grooveFeel: 'straight', tupletOverlay: 'auto', tensionPolicy: 'auto',
      diminution: 'auto', duet: 'auto', glide: 'auto', bassLine: 'auto', voices: {},
      opllUserPatch: 'brightLead', nes: {},
    });
    expect(options.engineRev).toBe(CURRENT_ENGINE_REV);
  });
});
