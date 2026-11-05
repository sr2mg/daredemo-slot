/**
 * リール駆動のステッピングモーターモデル（描画とは独立した純関数群）。
 *
 * 実機のリールはステッピングモーターで回り、位置は「ステップ」の整数で管理される
 * （一般的な構成: 1 周 504 ステップ、21 コマ ⇒ 1 コマ 24 ステップ）。本モデルは
 * 1 コマ = 24 ステップを固定し、1 周のステップ数はコマ数から導く（20 コマなら 480）。
 *
 * 時間の扱い: 回転開始時刻を原点として「経過時間 → ステップ数」を決定論的に計算する。
 * 描画フレームや rAF の間隔には一切依存しないので、押下時刻からのコマ番号の量子化
 * （docs/design/03）も描画も同じ関数を見るだけでよい。
 *
 * 速度: 規格上限相当の 80rpm（1 周 750ms）。ステップ周期は 750ms ÷ 1 周ステップ数。
 * 20 コマ（480 ステップ）なら 1.5625ms/ステップ、滑り最大 4 コマ + 整列 = 最大 119 ステップ
 * ≒ 186ms で、規則の「押下から 190ms 以内に停止」と整合する。
 *
 * 起動: 停止状態から定速までは直線加速（ステッピングモーターの脱調を避ける台形駆動の
 * 加速区間）。定速に達するまでストップボタンは有効にならない（実機の「ボタン有効化」）。
 * 加速時間は規格値ではなく感触の定数。
 */

/** 1 コマあたりのステップ数（504 ステップ ÷ 21 コマ） */
export const STEPS_PER_KOMA = 24;
/** 定速回転数 [rpm]（規格上限相当） */
export const REEL_RPM = 80;
/** 停止状態から定速に達するまでの加速時間 [ms]（この間はストップ無効） */
export const ACCEL_MS = 400;

export interface MotorSpec {
  /** コマ数 */
  readonly frames: number;
  /** 1 周のステップ数 = frames × STEPS_PER_KOMA */
  readonly stepsPerRev: number;
  /** 定速時のステップ周期 [ms] */
  readonly stepMs: number;
}

export function motorSpec(frames: number): MotorSpec {
  const stepsPerRev = frames * STEPS_PER_KOMA;
  const revMs = 60_000 / REEL_RPM;
  return { frames, stepsPerRev, stepMs: revMs / stepsPerRev };
}

/**
 * 1 回の回転指令。startAt の時点で startStep にあり、そこから加速 → 定速で進む。
 * targetStep が与えられると、軌道はそのステップで打ち切られそこで励磁保持される。
 */
export interface MotorCommand {
  readonly startAt: number;
  readonly startStep: number;
  readonly targetStep: number | null;
}

/** 加速区間で進むステップ数（定速 v で時間 ACCEL_MS の直線加速 ⇒ v·A/2） */
function accelSteps(spec: MotorSpec): number {
  return ACCEL_MS / spec.stepMs / 2;
}

/** 自由回転の軌道: 開始からの経過時間 → 進んだステップ数（連続値、負の時間は 0） */
export function freeRunSteps(spec: MotorSpec, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  const v = 1 / spec.stepMs;
  if (elapsedMs < ACCEL_MS) return (v * elapsedMs * elapsedMs) / (2 * ACCEL_MS);
  return accelSteps(spec) + v * (elapsedMs - ACCEL_MS);
}

/** freeRunSteps の逆関数: 進んだステップ数 → 到達までの経過時間 [ms] */
export function freeRunTimeMs(spec: MotorSpec, steps: number): number {
  if (steps <= 0) return 0;
  const v = 1 / spec.stepMs;
  const sa = accelSteps(spec);
  if (steps < sa) return Math.sqrt((2 * ACCEL_MS * steps) / v);
  return ACCEL_MS + (steps - sa) / v;
}

/** 定速に達してストップボタンが有効か */
export function isArmed(elapsedMs: number): boolean {
  return elapsedMs >= ACCEL_MS;
}

/** 時刻 now におけるステップ位置（整数。targetStep があればそこで止まる） */
export function stepAt(spec: MotorSpec, cmd: MotorCommand, now: number): number {
  const free = cmd.startStep + Math.floor(freeRunSteps(spec, now - cmd.startAt));
  return cmd.targetStep === null ? free : Math.min(free, cmd.targetStep);
}

/** targetStep に到達する時刻（絶対時刻。既に到達していれば過去の時刻） */
export function arrivalAt(spec: MotorSpec, cmd: MotorCommand & { targetStep: number }): number {
  return cmd.startAt + freeRunTimeMs(spec, cmd.targetStep - cmd.startStep);
}

/** ステップ位置 → コマ位置（連続値）。コアの stopPosition と同じ基準段を 0 とする */
export function stepToKoma(step: number): number {
  return step / STEPS_PER_KOMA;
}

/**
 * 押下位置の量子化: ステップ位置 → 次に基準段へ整列するコマ番号。
 * 整列ステップ上（step % 24 === 0）ならそのコマ自身（滑り 0 ならその場で止まる）。
 */
export function pushKomaAt(spec: MotorSpec, step: number): number {
  return Math.ceil(step / STEPS_PER_KOMA) % spec.frames;
}

/**
 * 停止目標ステップ（非正規化）: 押下ステップから、コアが決めた停止コマ stopPosition に
 * 最初に整列するステップ。押下コマから前進 0〜4 コマの範囲に収まる
 * （滑り上限はコアの規則。ここでは単に「次にその図柄が整列する位置」を取る）。
 */
export function stopTargetStep(spec: MotorSpec, pushStep: number, stopPosition: number): number {
  const pushKoma = Math.ceil(pushStep / STEPS_PER_KOMA);
  const slip = (((stopPosition - pushKoma) % spec.frames) + spec.frames) % spec.frames;
  return (pushKoma + slip) * STEPS_PER_KOMA;
}

/** コマ番号 → 整列ステップ（停止状態の正規化位置。次の回転の startStep に使う） */
export function komaToStep(koma: number): number {
  return koma * STEPS_PER_KOMA;
}
