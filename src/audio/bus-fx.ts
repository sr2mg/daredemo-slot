/**
 * ドラムバスの後段処理(バスコンプ・サチュレーション・サンプラー質感)。
 *
 * DnB/UKガラージの「サンプリングされたブレイク」の質感は、素材よりも処理に由来する:
 * 90年代の制作様式は「クリーンなドラム録音をサンプラーへ取り込み、潰して使う」
 * だった。ここはその処理段をオフラインレンダリングのドラムステムへ適用する。
 * どのスタイルに何を掛けるかの宣言は pcm-arrange(STYLE_DRUM_BUS)が持ち、
 * 宣言のないスタイルは素通し(既存スタイルの音は1サンプルも変わらない)。
 *
 * パラメータの導出根拠:
 * - comp.attackMs≈8: キックの立ち上がりトランジェント(数ms)を素通しし、胴鳴りから潰す。
 *   トランジェントが残るのでパンチは保たれ、余韻だけが持ち上がる。
 * - comp.releaseBeats=0.25(16分音符): リダクションの戻り(ポンピング)が曲の細分格子に
 *   同期する。時間でなく拍で持つのは、テンポが変わっても同じグルーヴ感を保つため。
 * - comp.thresholdDbBelowPeak/ratio: しきい値はバスの実測ピークからの相対で取り、
 *   ピーク近傍の主打(キック・スネア)だけが圧縮に入る。ゴーストやハットの余韻が
 *   相対的に持ち上がるのが「ブレイクの粘り」の正体。メイクアップは自動(ピーク一致)。
 * - crush 12bit/26040Hz: Akai S950の実スペック(ジャングル/初期DnB制作の標準機)。
 *   ビット量子化の粒とサンプルレート低下の折り返しが、いわゆる「ジャングルの質感」。
 */

export interface DrumBusFx {
  /**
   * tanhソフトクリップへの入力ゲイン(倍)。1=歪みなし素通し。
   * 2(+6dB)で奇数次倍音が乗り始める。出力はピーク一致で正規化するので音量は増えない。
   */
  drive: number;
  comp: {
    /** バス実測ピークからの相対しきい値(dB)。 */
    thresholdDbBelowPeak: number;
    ratio: number;
    attackMs: number;
    /** リリース長(拍)。0.25=16分でグルーヴ同期のポンピング。 */
    releaseBeats: number;
  } | null;
  crush: {
    bits: number;
    sampleRate: number;
  } | null;
}

function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const level = Math.abs(samples[i]!);
    if (level > peak) peak = level;
  }
  return peak;
}

function scaleTo(samples: Float32Array, targetPeak: number): void {
  const post = peakOf(samples);
  if (post <= 0) return;
  const gain = targetPeak / post;
  for (let i = 0; i < samples.length; i++) samples[i] = samples[i]! * gain;
}

/** フィードフォワードのバスコンプ。しきい値は実測ピーク相対、メイクアップはピーク一致。 */
function compress(
  samples: Float32Array,
  sampleRate: number,
  spb: number,
  comp: NonNullable<DrumBusFx['comp']>,
): void {
  const peak = peakOf(samples);
  if (peak <= 0) return;
  const threshold = peak * 10 ** (-comp.thresholdDbBelowPeak / 20);
  const attackCoef = Math.exp(-1 / (sampleRate * (comp.attackMs / 1000)));
  const releaseCoef = Math.exp(-1 / (sampleRate * comp.releaseBeats * spb));
  let env = 0;
  for (let i = 0; i < samples.length; i++) {
    const level = Math.abs(samples[i]!);
    const coef = level > env ? attackCoef : releaseCoef;
    env = coef * env + (1 - coef) * level;
    if (env > threshold) {
      samples[i] = samples[i]! * ((threshold + (env - threshold) / comp.ratio) / env);
    }
  }
  scaleTo(samples, peak);
}

/** tanhソフトクリップ。ピーク一致の正規化で、音量でなく密度(小音量部の相対量)が上がる。 */
function saturate(samples: Float32Array, drive: number): void {
  if (drive <= 1) return;
  const peak = peakOf(samples);
  if (peak <= 0) return;
  for (let i = 0; i < samples.length; i++) samples[i] = Math.tanh(samples[i]! * drive);
  scaleTo(samples, peak);
}

/** サンプラー質感: サンプル&ホールドのレート低下+振幅のビット量子化。 */
function crush(
  samples: Float32Array,
  sampleRate: number,
  spec: NonNullable<DrumBusFx['crush']>,
): void {
  const step = 1 / 2 ** (spec.bits - 1); // 符号1bitを除いた振幅の量子化幅
  const increment = Math.min(1, spec.sampleRate / sampleRate);
  let phase = 1; // 先頭サンプルを必ず取り込む
  let held = 0;
  for (let i = 0; i < samples.length; i++) {
    if (phase >= 1) {
      phase -= 1;
      held = Math.round(samples[i]! / step) * step;
    }
    phase += increment;
    samples[i] = held;
  }
}

/**
 * ドラムステムへFX鎖を適用する(in place・決定論的)。
 * 鎖の順序はコンプ→サチュレーション→クラッシュ(サンプラーが最後段に来る90s流)。
 */
export function applyDrumBusFx(
  samples: Float32Array,
  sampleRate: number,
  spb: number,
  fx: DrumBusFx,
): void {
  if (fx.comp) compress(samples, sampleRate, spb, fx.comp);
  saturate(samples, fx.drive);
  if (fx.crush) crush(samples, sampleRate, fx.crush);
}
