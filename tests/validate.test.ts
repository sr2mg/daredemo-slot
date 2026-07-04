import { describe, expect, it } from 'vitest';
import { checkLayout, checkSpacing, validateMachine } from '../src/core/validate.js';
import type { MachineDef } from '../src/core/types.js';
import { machines } from '../src/machines/index.js';
import { sampleAType } from '../src/machines/sample-a.js';

describe('checkLayout（配列の総当たり検証）', () => {
  const report = checkLayout(sampleAType);

  it('フィクスチャ配列は全制約を満たす', () => {
    expect(report.ok).toBe(true);
    expect(report.kickViolations).toBe(0);
    expect(report.replayMisses).toBe(0);
  });

  it('PB=1 役の実測引き込み率は 100%', () => {
    const replay = report.roleChecks.find((c) => c.id === 'replay')!;
    const bell = report.roleChecks.find((c) => c.id === 'bell')!;
    expect(replay.measured).toBe(1);
    expect(bell.measured).toBe(1);
  });

  it('目押し役の実測引き込み率が目標近傍にある', () => {
    const cherry = report.roleChecks.find((c) => c.id === 'cherry')!;
    expect(cherry.measured).toBeGreaterThan(0.2);
    expect(cherry.measured).toBeLessThan(0.5);
    expect(cherry.ok).toBe(true);
  });
});

describe('全プリセット機種の配列検証', () => {
  it.each(machines.map((m) => [m.name, m] as const))('%s は全制約を満たす', (_name, machine) => {
    const report = checkLayout(machine);
    expect(report.kickViolations).toBe(0);
    expect(report.replayMisses).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.violationExamples).toEqual([]);
  });
});

describe('checkSpacing（PB=1 配置間隔の診断）', () => {
  it('フィクスチャ配列は全 PB=1 図柄が間隔 5 コマ以内', () => {
    const checks = checkSpacing(sampleAType);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('間隔が壊れた配列はどのリールのどの図柄かを特定する', () => {
    const strips = sampleAType.strips.map((s) => [...s]);
    strips[0]![3] = 'blank'; // 左リールのリプレイを 1 個潰す → 間隔 10 コマ
    const broken: MachineDef = { ...sampleAType, strips };
    const bad = checkSpacing(broken).filter((c) => !c.ok);
    expect(bad.some((c) => c.reel === 0 && c.symbol === 'replay' && c.maxGap > 5)).toBe(true);
    // PB=1 前提が壊れた配列は制御エンジンが停止不能例外を投げる。
    // だからこそ総当たりの前にこのプリチェックで具体的な原因を報告する
    expect(() => checkLayout(broken)).toThrow();
  });
});

describe('validateMachine の実機制約', () => {
  it('payout 16 枚はエラー（上限 15 枚）', () => {
    const broken: MachineDef = {
      ...sampleAType,
      roles: sampleAType.roles.map((r) => (r.id === 'bell' ? { ...r, payout: 16 } : r)),
    };
    expect(validateMachine(broken).errors.some((e) => e.includes('15'))).toBe(true);
  });

  it('bet 4 枚はエラー（1〜3 枚）', () => {
    expect(validateMachine({ ...sampleAType, bet: 4 }).errors.some((e) => e.includes('bet'))).toBe(true);
  });

  it('重み合計超過のエラーに削減量のヒントが付く', () => {
    const broken: MachineDef = {
      ...sampleAType,
      lottery: {
        ...sampleAType.lottery,
        base: [...sampleAType.lottery.base, { roles: ['bell'], weight: 60000 }],
      },
    };
    expect(validateMachine(broken).errors.some((e) => e.includes('減らして'))).toBe(true);
  });

  it('プリセットは強化後もエラーなし', () => {
    for (const machine of machines) {
      expect(validateMachine(machine).errors, machine.name).toEqual([]);
    }
  });
});
