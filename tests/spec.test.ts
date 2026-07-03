import { describe, expect, it } from 'vitest';
import { simulate } from '../src/core/sim.js';
import {
  analyzeSensitivity,
  estimateSpec,
  formatOneIn,
  formatPct,
  mergedBaseTable,
} from '../src/core/spec.js';
import { checkLayout } from '../src/core/validate.js';
import { atBeast } from '../src/machines/at-beast.js';
import { sampleAType } from '../src/machines/sample-a.js';
import { stockBB } from '../src/machines/stock-bb.js';
import { stockSB } from '../src/machines/stock-sb.js';

const machines = [sampleAType, atBeast, stockBB, stockSB];

function measuredPullIn(machine: (typeof machines)[number]) {
  return Object.fromEntries(checkLayout(machine).roleChecks.map((c) => [c.id, c.measured]));
}

describe('estimateSpec（理論スペック近似）', () => {
  it('全プリセットで実測とおおむね一致する（完全打ち ±6pt / 適当打ち ±10pt）', () => {
    for (const machine of machines) {
      for (const setting of [1, 6]) {
        const est = estimateSpec(machine, setting, { measuredPullIn: measuredPullIn(machine) });
        const naive = simulate(machine, { games: 50_000, strategy: 'naive', seed: 21, setting });
        const perfect = simulate(machine, { games: 50_000, strategy: 'perfect', seed: 21, setting });
        expect(
          Math.abs(est.perfect - perfect.payoutRate),
          `${machine.name} 設定${setting} 完全打ち est=${est.perfect} meas=${perfect.payoutRate}`,
        ).toBeLessThan(0.06);
        expect(
          Math.abs(est.naive - naive.payoutRate),
          `${machine.name} 設定${setting} 適当打ち est=${est.naive} meas=${naive.payoutRate}`,
        ).toBeLessThan(0.1);
      }
    }
  }, 300_000);

  it('設定オーバーレイが合成される', () => {
    const table = mergedBaseTable(sampleAType, 6);
    expect(table.find((e) => e.roles.length === 1 && e.roles[0] === 'bb_red')?.weight).toBe(450);
    expect(table.find((e) => e.roles.length === 1 && e.roles[0] === 'replay')?.weight).toBe(8978);
  });

  it('設定 6 は設定 1 より理論機械割が高い', () => {
    for (const machine of machines) {
      const s1 = estimateSpec(machine, 1);
      const s6 = estimateSpec(machine, 6);
      expect(s6.naive, machine.name).toBeGreaterThan(s1.naive);
      expect(s6.perfect, machine.name).toBeGreaterThan(s1.perfect);
    }
  });

  it('ボーナス行にフラグ確率と期待獲得枚数が入る', () => {
    const est = estimateSpec(sampleAType, 1);
    const bb = est.bonuses.find((b) => b.id === 'bb_red')!;
    expect(bb.oneIn).toBeGreaterThan(200);
    expect(bb.oneIn).toBeLessThan(280);
    expect(bb.expectedMedalsNaive).toBeGreaterThan(180); // 30G × 8枚ベル高確率 ≒ 220枚
    expect(bb.expectedMedalsNaive).toBeLessThan(260);
  });
});

describe('analyzeSensitivity（感度分析）', () => {
  it('ベルの重み増は機械割をプラスに動かし、|dNaive| 降順に並ぶ', () => {
    const rows = analyzeSensitivity(sampleAType, 1);
    const bell = rows.find((r) => r.label.startsWith('bell '))!;
    expect(bell.dNaive).toBeGreaterThan(0);
    expect(bell.dPerfect).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) {
      expect(Math.abs(rows[i - 1]!.dNaive)).toBeGreaterThanOrEqual(Math.abs(rows[i]!.dNaive));
    }
    // BB 消化ゲーム数のつまみも含まれる
    expect(rows.some((r) => r.label.includes('消化ゲーム数'))).toBe(true);
  });
});

describe('表示ヘルパー', () => {
  it('formatOneIn / formatPct', () => {
    expect(formatOneIn(0)).toBe('—');
    expect(formatOneIn(0.5)).toBe('1/2.0');
    expect(formatOneIn(1 / 240)).toBe('1/240');
    expect(formatPct(0.6)).toBe('60.0%');
  });
});
