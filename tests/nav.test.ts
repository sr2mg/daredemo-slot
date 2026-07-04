import { describe, expect, it } from 'vitest';
import { NavLayer } from '../src/core/nav.js';
import type { GameEvent } from '../src/core/types.js';
import { validateMachine } from '../src/core/validate.js';
import { atBeast } from '../src/machines/at-beast.js';
import { sampleAType } from '../src/machines/sample-a.js';

function eventWith(partial: Partial<GameEvent>): GameEvent {
  return {
    bet: 3,
    flags: [],
    queuedBonus: null,
    stops: [0, 0, 0],
    wins: [],
    payout: 0,
    replayWon: false,
    bonusStarted: null,
    bonusEnded: null,
    rtEntered: null,
    rtExited: null,
    ctEntered: null,
    ctExited: null,
    lidReleased: false,
    modeChanged: null,
    ...partial,
  };
}

describe('NavLayer（サブ基板の AT 状態機械）', () => {
  it('ゲーム数天井で AT に突入し、AT 中はナビを返す', () => {
    const nav = new NavLayer(atBeast, 1);
    expect(nav.atActive).toBe(false);
    expect(nav.navFor(['bell_C'])).toBeNull(); // AT 非作動中はナビなし

    // 天井 500G まで純ハズレを回す（確率トリガーは 0 にできないので天井で確実に入れる）
    let notes: string[] = [];
    for (let i = 0; i < 500; i++) notes = nav.onEvent(eventWith({ flags: ['replay'] }));
    expect(nav.atActive).toBe(true);
    expect(notes).toContain('🎉 AT 突入！');

    // AT 中は navTargets の打ち分け役に対して正解を開示する
    expect(nav.navFor(['bell_C'])?.correctFirst).toBe(1);
    expect(nav.navFor(['bell_R'])?.correctFirst).toBe(2);
    expect(nav.navFor(['replay'])).toBeNull(); // 打ち分けのない役にはナビ不要
  });

  it('上乗せと残ゲーム消化・終了が機能する', () => {
    const nav = new NavLayer(atBeast, 1);
    // flags: [] は純ハズレ扱いで確率トリガーが発火しうるので、リプレイで天井まで回す
    for (let i = 0; i < 500; i++) nav.onEvent(eventWith({ flags: ['replay'] }));
    expect(nav.atRemainingGames).toBe(30);

    nav.onEvent(eventWith({ flags: ['melon'] })); // 上乗せ +10G、消化 -1G
    expect(nav.atRemainingGames).toBe(39);
  });

  it('状態をシリアライズして復元できる（セーブデータ）', () => {
    const nav = new NavLayer(atBeast, 1);
    for (let i = 0; i < 500; i++) nav.onEvent(eventWith({ flags: ['replay'] }));
    const restored = new NavLayer(atBeast, nav.getState());
    expect(restored.atActive).toBe(true);
    expect(restored.atRemainingGames).toBe(nav.atRemainingGames);
  });
});

describe('validateMachine（機種エディタの構造検証）', () => {
  it('プリセット機種はエラーなし', () => {
    for (const machine of [sampleAType, atBeast]) {
      const result = validateMachine(machine);
      expect(result.errors).toEqual([]);
    }
  });

  it('参照切れ・重み超過を検出する', () => {
    const broken = structuredClone(sampleAType) as typeof sampleAType & {
      lottery: { base: { roles: string[]; weight: number }[] };
    };
    broken.lottery.base.push({ roles: ['unknown_role'], weight: 99999 });
    const result = validateMachine(broken);
    expect(result.errors.some((e) => e.includes('unknown_role'))).toBe(true);
    expect(result.errors.some((e) => e.includes('65536'))).toBe(true);
  });

  it('リプレイ役の onMiss: lose を拒否する', () => {
    const broken = structuredClone(atBeast) as typeof atBeast & { roles: { id: string; kind: string; nav?: unknown }[] };
    const replay = broken.roles.find((r) => r.id === 'replay')!;
    replay.nav = { group: 'bell3', correctFirst: 0, onMiss: { type: 'lose' } };
    const result = validateMachine(broken as never);
    expect(result.errors.some((e) => e.includes('lose'))).toBe(true);
  });
});
