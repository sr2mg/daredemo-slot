import { describe, expect, it } from 'vitest';
import { checkLayout } from '../src/core/validate.js';
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
  });
});
