import { describe, expect, it } from 'vitest';
import {
  ACCEL_MS,
  STEPS_PER_KOMA,
  arrivalAt,
  freeRunSteps,
  freeRunTimeMs,
  isArmed,
  komaToStep,
  motorSpec,
  pushKomaAt,
  stepAt,
  stopTargetStep,
} from '../src/ui/reel-motor.js';

const spec = motorSpec(20);

describe('ステッピングモーターの諸元', () => {
  it('20 コマは 1 周 480 ステップ、80rpm で 1.5625ms/ステップ', () => {
    expect(spec.stepsPerRev).toBe(480);
    expect(spec.stepMs).toBeCloseTo(1.5625);
  });

  it('21 コマなら実機と同じ 504 ステップ', () => {
    expect(motorSpec(21).stepsPerRev).toBe(504);
  });

  it('滑り 4 コマ + 整列 = 最大 119 ステップは 190ms 以内', () => {
    expect((5 * STEPS_PER_KOMA - 1) * spec.stepMs).toBeLessThan(190);
  });
});

describe('自由回転の軌道', () => {
  it('加速区間は定速の半分しか進まず、以降は定速', () => {
    const steady = ACCEL_MS / spec.stepMs;
    expect(freeRunSteps(spec, ACCEL_MS)).toBeCloseTo(steady / 2);
    expect(freeRunSteps(spec, ACCEL_MS + 750)).toBeCloseTo(steady / 2 + 480);
  });

  it('負の経過時間では動かない', () => {
    expect(freeRunSteps(spec, -10)).toBe(0);
  });

  it('逆関数が往復で一致する（加速中・定速中とも）', () => {
    for (const t of [0, 50, 200, ACCEL_MS, 1000, 5000]) {
      expect(freeRunTimeMs(spec, freeRunSteps(spec, t))).toBeCloseTo(t, 6);
    }
  });

  it('定速到達までストップは無効', () => {
    expect(isArmed(ACCEL_MS - 1)).toBe(false);
    expect(isArmed(ACCEL_MS)).toBe(true);
  });
});

describe('時刻からのステップ位置', () => {
  it('整数ステップで単調に進み、目標で打ち切られる', () => {
    const cmd = { startAt: 1000, startStep: 48, targetStep: null };
    let prev = -1;
    for (let t = 1000; t < 3000; t += 7) {
      const s = stepAt(spec, cmd, t);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
    const stopping = { ...cmd, targetStep: 300 };
    expect(stepAt(spec, stopping, 10_000)).toBe(300);
    expect(stepAt(spec, stopping, arrivalAt(spec, stopping) + 1)).toBe(300);
    expect(stepAt(spec, stopping, arrivalAt(spec, stopping) - 5)).toBeLessThan(300);
  });
});

describe('押下の量子化と停止目標', () => {
  it('整列ステップ上ならそのコマ、少しでも過ぎたら次のコマ', () => {
    expect(pushKomaAt(spec, 5 * STEPS_PER_KOMA)).toBe(5);
    expect(pushKomaAt(spec, 5 * STEPS_PER_KOMA + 1)).toBe(6);
    expect(pushKomaAt(spec, 19 * STEPS_PER_KOMA + 23)).toBe(0); // 1 周の境界で巻き戻る
  });

  it('コマ内 24 ステップのどこで押しても押下コマは同じで、滑り込み距離だけが変わる', () => {
    const komas = new Set<number>();
    for (let sub = 1; sub <= STEPS_PER_KOMA; sub++) {
      const step = 7 * STEPS_PER_KOMA + sub;
      komas.add(pushKomaAt(spec, step));
      // 滑り 0: 次の整列位置 = 押下コマ 8 の整列ステップ
      expect(stopTargetStep(spec, step, 8) - step).toBe(STEPS_PER_KOMA - sub);
    }
    expect([...komas]).toEqual([8]);
  });

  it('停止目標は押下コマから前進 0〜4 コマに収まり、1 周超えでも非正規化ステップで表す', () => {
    const pushStep = 480 * 3 + 18 * STEPS_PER_KOMA + 5; // 4 周目、コマ 18 を少し過ぎた
    expect(pushKomaAt(spec, pushStep)).toBe(19);
    for (let slip = 0; slip <= 4; slip++) {
      const stop = (19 + slip) % 20;
      const target = stopTargetStep(spec, pushStep, stop);
      expect(target).toBe((20 * 3 + 19 + slip) * STEPS_PER_KOMA);
      expect(target % 480).toBe(komaToStep(stop));
    }
  });
});
