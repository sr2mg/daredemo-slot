import { describe, expect, it } from 'vitest';
import { buildFromRecipe, isConcentrationStyle } from '../src/core/recipes.js';
import type { SweetnessId, WaveId } from '../src/core/recipes.js';
import { simulate } from '../src/core/sim.js';
import { findTuningKnob, solveTargetRate } from '../src/core/solve.js';
import { checkLayout, validateMachine } from '../src/core/validate.js';
import { machines } from '../src/machines/index.js';
import { atBeast } from '../src/machines/at-beast.js';
import { sampleAType } from '../src/machines/sample-a.js';
import { shuchuMachine } from '../src/machines/shuchu.js';

describe('solveTargetRate（逆算ソルバー: 目標機械割 → 重み）', () => {
  it('目標の理論機械割に収束する', () => {
    for (const target of [0.65, 0.72, 0.8]) {
      const result = solveTargetRate(sampleAType, { target });
      expect(result.clamped).toBe(false);
      expect(Math.abs(result.achieved - target), `target=${target}`).toBeLessThan(0.01);
      expect(validateMachine(result.machine).errors).toEqual([]);
    }
  });

  it('つまみは共通ベル相当（単独・小役・PB=1・押し順なし）を選ぶ', () => {
    expect(sampleAType.lottery.base[findTuningKnob(sampleAType)]!.roles).toEqual(['bell']);
    expect(atBeast.lottery.base[findTuningKnob(atBeast)]!.roles).toEqual(['bell']);
  });

  it('設定オーバーレイは比率を保ってスケールされる（設定差の形が崩れない）', () => {
    const result = solveTargetRate(sampleAType, { target: 0.8 });
    const base = result.machine.lottery.base.find((e) => e.roles.length === 1 && e.roles[0] === 'bell')!.weight;
    const s6 = result.machine.lottery.settingOverrides?.['6']?.find((e) => e.roles[0] === 'bell')?.weight;
    expect(s6).toBeDefined();
    expect(s6! / base).toBeCloseTo(9600 / 9000, 1); // 元プリセットの設定差比率
  });

  it('届かない目標は clamped で正直に報告する', () => {
    const result = solveTargetRate(sampleAType, { target: 3 });
    expect(result.clamped).toBe(true);
    // clamp されても重み合計は 65536 以下（validateMachine が通る）
    expect(validateMachine(result.machine).errors).toEqual([]);
  });
});

describe('buildFromRecipe（かんたんウィザードのレシピ）', () => {
  const SWEETS: SweetnessId[] = ['karai', 'futsu', 'amai'];
  const WAVES: WaveId[] = ['mild', 'nami', 'ichigeki'];

  it('全タイプ × 全甘さ × 全波 の 54 通りが構造検証を通り、目標に収束する', () => {
    for (const archetype of machines) {
      for (const sweetness of SWEETS) {
        for (const wave of WAVES) {
          const label = `${archetype.name} ${sweetness} ${wave}`;
          const r = buildFromRecipe(archetype, { name: 'テスト機', sweetness, wave });
          expect(r.machine.name).toBe('テスト機');
          expect(validateMachine(r.machine).errors, label).toEqual([]);
          if (!r.clamped) {
            expect(Math.abs(r.achieved - r.target), label).toBeLessThan(0.01);
          }
        }
      }
    }
  });

  it('波は BB の大きさと頻度を逆方向に動かす', () => {
    const mild = buildFromRecipe(sampleAType, { name: 'a', sweetness: 'futsu', wave: 'mild' });
    const ichigeki = buildFromRecipe(sampleAType, { name: 'a', sweetness: 'futsu', wave: 'ichigeki' });
    const games = (m: typeof mild) => m.machine.bonuses.find((b) => b.id === 'bb_red')!.end.games!;
    const bbWeight = (m: typeof mild) =>
      m.machine.lottery.base.find((e) => e.roles.length === 1 && e.roles[0] === 'bb_red')!.weight;
    expect(games(mild)).toBeLessThan(games(ichigeki));
    expect(bbWeight(mild)).toBeGreaterThan(bbWeight(ichigeki));
  });

  it('実測でも目標近傍に落ちる（標準・波あり・サンプル A）', () => {
    const measuredPullIn = Object.fromEntries(checkLayout(sampleAType).roleChecks.map((c) => [c.id, c.measured]));
    const r = buildFromRecipe(sampleAType, {
      name: 'e2e',
      sweetness: 'futsu',
      wave: 'nami',
      estimate: { measuredPullIn },
    });
    const meas = simulate(r.machine, { games: 50_000, strategy: 'naive', seed: 5 });
    expect(Math.abs(meas.payoutRate - r.target)).toBeLessThan(0.06);
  });

  it('集中構成（時代ラベル対象）の判定', () => {
    expect(isConcentrationStyle(shuchuMachine)).toBe(true);
    expect(isConcentrationStyle(sampleAType)).toBe(false);
  });
});
