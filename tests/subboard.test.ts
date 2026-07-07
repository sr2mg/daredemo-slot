import { describe, expect, it } from 'vitest';
import { initialState } from '../src/core/game.js';
import type { EngineState, GameEvent } from '../src/core/types.js';
import { atBeast } from '../src/machines/at-beast.js';
import { ctMachine } from '../src/machines/ct-machine.js';
import { sampleAType } from '../src/machines/sample-a.js';
import { stockBB } from '../src/machines/stock-bb.js';
import { stockSB } from '../src/machines/stock-sb.js';
import { Subboard, subboardKind } from '../src/ui/subboard.js';

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

describe('subboardKind（機構からサブ基板タイプを自動判別）', () => {
  it('プリセット 4 タイプ + フォールバックを判別する', () => {
    expect(subboardKind(sampleAType)).toBe('atype');
    expect(subboardKind(atBeast)).toBe('at');
    expect(subboardKind(stockBB)).toBe('battle');
    expect(subboardKind(stockSB)).toBe('sbzone');
    expect(subboardKind(ctMachine)).toBe('atype'); // lid なし・nav なしは A タイプ扱い
  });
});

describe('atype: 完全告知 + 第四リール', () => {
  it('ボーナス成立から必ず 4G 以内に告知され、告知後はボーナス図柄が点滅し続ける', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const sub = new Subboard(sampleAType, seed);
      const st: EngineState = { ...initialState(sampleAType), queue: ['bb_red'] };
      let fx = sub.onSettle(eventWith({ flags: ['bb_red'], queuedBonus: 'bb_red' }), st, null);
      let waited = 0;
      while (!fx.sfx.includes('kyuin') && waited < 10) {
        expect(fx.view.lamp).toBe(false); // 潜伏中はランプも点かない
        fx = sub.onSettle(eventWith({}), st, null);
        waited++;
      }
      expect(fx.sfx).toContain('kyuin');
      expect(fx.notes).toContain('⚡ 完全告知！');
      expect(waited).toBeLessThanOrEqual(4);
      expect(fx.view.fourth?.symbol).toBe('seven_red');
      expect(fx.view.fourth?.flash).toBe(true);
      expect(fx.view.lamp).toBe(true);
      // 告知後は 7 が維持され、キュインは 1 回だけ
      const after = sub.onSettle(eventWith({ flags: ['bell'] }), st, null);
      expect(after.sfx).toHaveLength(0);
      expect(after.view.fourth?.symbol).toBe('seven_red');
      expect(after.view.lamp).toBe(true);
    }
  });

  it('通常時の図柄は嘘をつかない: 対応図柄以外は絶対に出ない（点滅ガセはあり得る）', () => {
    const sub = new Subboard(sampleAType, 5);
    const st = initialState(sampleAType);
    let sawFlash = false;
    for (let i = 0; i < 300; i++) {
      const fx = sub.onSettle(eventWith({ flags: ['bell'] }), st, null);
      expect(fx.view.fourth?.symbol).toBe('bell');
      expect(fx.view.lamp).toBe(false);
      if (fx.view.fourth?.flash) sawFlash = true;
    }
    for (let i = 0; i < 300; i++) {
      expect(sub.onSettle(eventWith({}), st, null).view.fourth?.symbol).toBe('blank');
    }
    expect(sub.onSettle(eventWith({ flags: ['melon'] }), st, null).view.fourth?.symbol).toBe('melon');
    expect(sawFlash).toBe(true); // ガセ点滅（≒1/48）は 300G あればまず出る
  });

  it('潜伏中は矛盾図柄（成立役と違う図柄）が出うる = 分かる人だけの先読み確定パターン', () => {
    let sawContradiction = false;
    for (let seed = 1; seed <= 200 && !sawContradiction; seed++) {
      const sub = new Subboard(sampleAType, seed);
      const st: EngineState = { ...initialState(sampleAType), queue: ['bb_red'] };
      // 成立ゲーム（ベル重複扱い）から告知まで、潜伏中の表示をすべて観測する
      let fx = sub.onSettle(eventWith({ flags: ['bell', 'bb_red'], queuedBonus: 'bb_red' }), st, null);
      while (!fx.sfx.includes('kyuin')) {
        const symbol = fx.view.fourth?.symbol;
        if (symbol !== 'bell') {
          expect(symbol).not.toBe('seven_red'); // 告知前に確定図柄は出ない
          sawContradiction = true;
        }
        fx = sub.onSettle(eventWith({ flags: ['bell'] }), st, null);
      }
    }
    expect(sawContradiction).toBe(true);
  });

  it('告知前に自力で揃えたら告知は流れる（キュインは鳴らずに通常へ戻る）', () => {
    // 潜伏を確実に踏むため、遅延告知（announceIn >= 1）を引くまでシードを探す
    for (let seed = 1; seed <= 30; seed++) {
      const sub = new Subboard(sampleAType, seed);
      const st: EngineState = { ...initialState(sampleAType), queue: ['bb_red'] };
      const first = sub.onSettle(eventWith({ flags: ['bb_red'], queuedBonus: 'bb_red' }), st, null);
      if (first.sfx.includes('kyuin')) continue; // 即告知シードは対象外
      // 潜伏中に BB 入賞（queue が空に）
      const hit = sub.onSettle(
        eventWith({ flags: ['bb_red'], wins: ['bb_red'], bonusStarted: 'bb_red' }),
        initialState(sampleAType),
        null,
      );
      expect(hit.sfx).not.toContain('kyuin');
      expect(hit.view.lamp).toBe(false);
      return;
    }
    throw new Error('遅延告知を引くシードが見つからない（振り分けを確認）');
  });

  it('レバー ON で第四リールが回転状態（symbol null）になる', () => {
    const sub = new Subboard(sampleAType, 1);
    expect(sub.onLever(['replay']).view.fourth?.symbol).toBeNull();
  });
});

describe('at: ステージ示唆 + カットイン（獣王風）', () => {
  const nav = { atActive: false, atMode: 'low', atStarted: false, atContinued: false };

  it('常にステージ表示があり、AT 突入でカットイン、AT 中は RUSH ステージ', () => {
    const sub = new Subboard(atBeast, 1);
    const st = initialState(atBeast);
    const fx = sub.onSettle(eventWith({}), st, nav);
    expect(fx.view.stage).not.toBeNull();
    const start = sub.onSettle(eventWith({}), st, { ...nav, atActive: true, atStarted: true });
    expect(start.view.cutin?.text).toContain('RUSH');
    expect(start.view.stage?.id).toBe('rush');
    const cont = sub.onSettle(eventWith({}), st, { ...nav, atActive: true, atContinued: true });
    expect(cont.view.cutin?.text).toContain('継続');
  });

  it('高確モードは夜ステージ寄りに振れる（統計的示唆）', () => {
    const count = (mode: string) => {
      const sub = new Subboard(atBeast, 7);
      const st = initialState(atBeast);
      let night = 0;
      for (let i = 0; i < 2000; i++) {
        const fx = sub.onSettle(eventWith({}), st, { ...nav, atMode: mode });
        if (fx.view.stage?.id === 'night') night++;
      }
      return night;
    };
    expect(count('high')).toBeGreaterThan(count('low') * 2);
  });
});

describe('battle: 対決連続演出 + 高確率ゾーン（吉宗 + SHAKE 風）', () => {
  it('残り放出 G 数で高確率ゾーンの色が変わる', () => {
    const sub = new Subboard(stockBB, 1);
    const at = (releaseIn: number) => {
      const st: EngineState = { ...initialState(stockBB), queue: ['bb_red'], lid: true, lidReleaseIn: releaseIn };
      return sub.onSettle(eventWith({}), st, null).view.zone;
    };
    expect(at(25)).toEqual({ label: '高確率', level: 0 });
    expect(at(18)?.level).toBe(1);
    expect(at(10)?.level).toBe(2);
    expect(at(4)?.level).toBe(3);
    expect(at(72)).toBeNull(); // 深いところではゾーンなし（ガセを除く）
  });

  it('放出 3G 前から対決が始まり、蓋が開くと勝利で終わる', () => {
    const sub = new Subboard(stockBB, 1);
    const base = initialState(stockBB);
    const lidded = (releaseIn: number): EngineState => ({ ...base, queue: ['bb_red'], lid: true, lidReleaseIn: releaseIn });
    expect(sub.onSettle(eventWith({}), lidded(3), null).view.battle).not.toBeNull();
    expect(sub.onSettle(eventWith({}), lidded(2), null).view.battle).not.toBeNull();
    expect(sub.onSettle(eventWith({}), lidded(1), null).view.battle).not.toBeNull();
    const win = sub.onSettle(
      eventWith({ lidReleased: true }),
      { ...base, queue: ['bb_red'], lid: false, lidReleaseIn: null },
      null,
    );
    expect(win.view.battle).toBeNull();
    expect(win.view.cutin?.text).toContain('撃破');
    expect(win.notes).toContain('⚔ 対決勝利！');
    // 放出後は「狙え」ゾーンで揃えるまで案内する
    expect(win.view.zone?.label).toContain('狙え');
  });

  it('ガセ対決は必ず敗北で終わり、本物と区別が付かない長さで収束する', () => {
    const sub = new Subboard(stockBB, 3);
    const st = initialState(stockBB); // ストックなし = 対決はすべてガセ
    let sawBattle = false;
    let sawLose = false;
    for (let i = 0; i < 2000 && !sawLose; i++) {
      const fx = sub.onSettle(eventWith({}), st, null);
      if (fx.view.battle !== null) sawBattle = true;
      if (sawBattle && fx.view.cutin?.text.includes('敗北')) sawLose = true;
      expect(fx.view.cutin?.text.includes('撃破') ?? false).toBe(false); // 勝利は絶対に出ない
    }
    expect(sawBattle).toBe(true);
    expect(sawLose).toBe(true);
  });

  it('ボーナス消化中は通常時演出をすべて畳む', () => {
    const sub = new Subboard(stockBB, 1);
    const st: EngineState = {
      ...initialState(stockBB),
      base: { type: 'bonus', run: { bonusId: 'bb_red', gamesPlayed: 3, totalPayout: 24, wins: 3 } },
      queue: ['bb_red'],
      lid: true,
      lidReleaseIn: 2,
    };
    const fx = sub.onSettle(eventWith({}), st, null);
    expect(fx.view.zone).toBeNull();
    expect(fx.view.battle).toBeNull();
  });
});

describe('sbzone: SB 放出ゾーン（サラ金風）', () => {
  it('蓋が開いて SB がキューにいる間だけ祭りになり、尽きると終了ログ', () => {
    const sub = new Subboard(stockSB, 1);
    const base = initialState(stockSB);
    const inZone: EngineState = { ...base, queue: ['sb_kin', 'sb_kin'], lid: false };
    const enter = sub.onSettle(eventWith({ lidReleased: true }), inZone, null);
    expect(enter.view.zone?.rainbow).toBe(true);
    expect(enter.view.lamp).toBe(true);
    expect(enter.view.cutin?.text).toContain('突入');
    // ゾーン継続中は突入カットインを繰り返さない
    const stay = sub.onSettle(eventWith({}), inZone, null);
    expect(stay.view.cutin).toBeNull();
    const exit = sub.onSettle(eventWith({}), { ...base, queue: [], lid: false }, null);
    expect(exit.view.zone).toBeNull();
    expect(exit.view.lamp).toBe(false);
    expect(exit.notes).toContain('💤 放出ゾーン終了');
  });

  it('蓋が閉まっている間はストックが溜まっていてもゾーンにならない', () => {
    const sub = new Subboard(stockSB, 1);
    const st: EngineState = { ...initialState(stockSB), queue: Array(12).fill('sb_kin'), lid: true };
    expect(sub.onSettle(eventWith({}), st, null).view.zone).toBeNull();
  });
});
