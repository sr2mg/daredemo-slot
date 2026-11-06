import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { normalizeComposeOptions } from '../src/core/music/options.js';
import { CURRENT_ENGINE_REV, engineRevOf } from '../src/core/music/types.js';
import type { ComposeOptions, SongFormSpec } from '../src/core/music/types.js';

/**
 * engineRevの一点式バージョニング。
 * rev5 で曲型を区間リストへ作り替えた際に旧リビジョン(rev0〜4)の再現経路を削除した
 * (ユーザー不在のうちのリセット)。rev5 未満の値は rev5 として扱う。
 * rev6: 元区間と調が違う literal の再登場は、フレーズアンカーを調差ぶん平行移動する(転調した
 * 最終サビのフックが持ち上がる)。同じ調の曲型(全プリセット)は rev5 と同じ音。
 */

const base: ComposeOptions = {
  progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, form: 'loop16', seed: 21,
};

/** サビ S を全音上へ転調して literal で戻す終幕(rev6 で音が変わる唯一の形)。 */
const liftForm: SongFormSpec = {
  sections: [
    { id: 'A', role: 'hook', bars: 8, energy: 3, theme: 'A' },
    { id: 'S', role: 'hook', bars: 8, energy: 4, theme: 'S' },
    { id: "S'", role: 'finale', bars: 8, energy: 5, theme: 'S', transform: 'literal', keyRoot: 2 },
  ],
  ending: 'final',
};

describe('engineRev(rev6: 転調した literal のアンカーを調差ぶん移す)', () => {
  it('現行リビジョンはrev6(保存曲の焼き込み値の前提)', () => {
    expect(CURRENT_ENGINE_REV).toBe(6);
  });

  it('rev5 未満は rev5、未来の値は現行へクランプ、省略は現行', () => {
    expect(engineRevOf({})).toBe(6);
    for (const engineRev of [0, 2, 4, 5]) expect(engineRevOf({ engineRev })).toBe(5);
    for (const engineRev of [6, 7, 99]) expect(engineRevOf({ engineRev })).toBe(6);
  });

  it('同じ調の曲型(プリセット)は省略・旧値・現行値で同じ音になる', () => {
    const current = compose(base);
    for (const engineRev of [undefined, 0, 2, 4, 5, 99]) {
      expect(compose({ ...base, ...(engineRev === undefined ? {} : { engineRev }) })).toEqual(current);
    }
  });

  it('転調した literal の終幕は rev5 と rev6 で音が違い、rev5 の保存曲は rev5 のまま再現する', () => {
    const rev6 = compose({ ...base, form: liftForm, engineRev: 6 });
    const rev5 = compose({ ...base, form: liftForm, engineRev: 5 });
    expect(compose({ ...base, form: liftForm })).toEqual(rev6);
    expect(compose({ ...base, form: liftForm, engineRev: 4 })).toEqual(rev5);
    expect(rev6.melody).not.toEqual(rev5.melody);
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
