/**
 * SC-88+VS世代の音響設計カタログ。
 *
 * 音色そのものではなく、当時の制作環境が生んだ「技法」を装置として一般化する:
 * - エコートラック: ハードのエフェクトセンド不足を、旋律トラックの複製+遅延+減衰で
 *   補った定番。ディレイをエフェクトでなく時間方向のレイヤー=編曲として書く(MIDI段)
 * - フィードバックディレイ: rei harakami等のVSシリーズ運用に見られる、MIDI段の上へ
 *   オーディオ段のディレイをもう一周重ねる二重時間軸。コンプでなくフィードバック量で
 *   ダイナミクスを作る (https://sai96i.hateblo.jp/entry/2021/05/10/204035)
 * - ロール別センド: 楽器でなくパートの役割ごとに決まる定番の送り量
 *   (パッドにコーラス深め、リードは浅いリバーブ+エコー、ベースはドライ)
 * - 舞台配置: オスティナート左・対旋律右・リード中央の固定ステージ
 *
 * 実装はSC-88のインサート不可・センド2系統(リバーブ/コーラス)+VSのディレイという
 * 当時のバス構造を写した「dry + 3送りバス」のオフラインミキサー。
 */

export interface StereoWave {
  left: Float32Array;
  right: Float32Array;
}

/** エコートラック(MIDI段ディレイ)。遅延は拍で指定し、テンポに追従する。 */
export interface EchoTrackSpec {
  /** 1タップの遅延(拍)。付点8分=0.75が定番。 */
  delayBeats: number;
  taps: number;
  /** タップごとの減衰率。 */
  decay: number;
}

/** パートの役割ごとの音響プロファイル。音色ではなく役割に紐づくのが当時の運用。 */
export interface RoleSoundProfile {
  /** -1(左)..0(中央)..1(右)。 */
  pan: number;
  reverbSend: number;
  chorusSend: number;
  delaySend: number;
  echo: EchoTrackSpec | null;
}

export const ROLE_PROFILES: Record<string, RoleSoundProfile> = {
  lead: {
    pan: 0,
    reverbSend: 0.3,
    chorusSend: 0.08,
    delaySend: 0.22,
    echo: { delayBeats: 0.75, taps: 2, decay: 0.55 },
  },
  counter: {
    pan: 0.42,
    reverbSend: 0.28,
    chorusSend: 0.2,
    delaySend: 0.12,
    echo: { delayBeats: 0.5, taps: 1, decay: 0.5 },
  },
  ostinato: { pan: -0.42, reverbSend: 0.18, chorusSend: 0.22, delaySend: 0, echo: null },
  backing: { pan: 0.12, reverbSend: 0.38, chorusSend: 0.45, delaySend: 0, echo: null },
  bass: { pan: 0, reverbSend: 0.06, chorusSend: 0, delaySend: 0, echo: null },
  drums: { pan: 0, reverbSend: 0.16, chorusSend: 0, delaySend: 0, echo: null },
};

/** 等パワーパン。 */
export function panGains(pan: number): [number, number] {
  const angle = (Math.max(-1, Math.min(1, pan)) + 1) * (Math.PI / 4);
  return [Math.cos(angle), Math.sin(angle)];
}

/**
 * エコートラック: ノート列へ遅延コピーを足す純関数。
 * どのレンダラでも使える形(開始秒+ゲインの複製)に留める。
 */
export function withEchoTracks<T extends { startSec: number; gain: number }>(
  notes: readonly T[],
  spec: EchoTrackSpec,
  beatSec: number,
): T[] {
  const result: T[] = [...notes];
  for (const note of notes) {
    for (let tap = 1; tap <= spec.taps; tap++) {
      result.push({
        ...note,
        startSec: note.startSec + spec.delayBeats * beatSec * tap,
        gain: note.gain * spec.decay ** tap,
      });
    }
  }
  return result;
}

/**
 * Schroeder型ステレオリバーブ。左右でコム遅延を僅かにずらし、モノ入力から広がりを作る。
 * 入力=センドバス(ウェットのみ返す)。
 */
export function stereoReverb(input: Float32Array, sampleRate: number): StereoWave {
  const render = (detune: number): Float32Array => {
    const combDelaysMs = [29.7, 37.1, 41.1, 43.7].map((ms) => ms * detune);
    const combFeedback = 0.78;
    const allpassDelaysMs = [5.0, 1.7];
    const allpassGain = 0.7;
    const combBuffers = combDelaysMs.map((ms) => new Float32Array(Math.max(1, Math.round(ms * sampleRate / 1000))));
    const combIndices = combDelaysMs.map(() => 0);
    const allpassBuffers = allpassDelaysMs.map((ms) => new Float32Array(Math.max(1, Math.round(ms * sampleRate / 1000))));
    const allpassIndices = allpassDelaysMs.map(() => 0);
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const dry = input[i]!;
      let combSum = 0;
      for (let c = 0; c < combBuffers.length; c++) {
        const buffer = combBuffers[c]!;
        const index = combIndices[c]!;
        const delayed = buffer[index]!;
        buffer[index] = dry + delayed * combFeedback;
        combIndices[c] = (index + 1) % buffer.length;
        combSum += delayed;
      }
      let wet = combSum / combBuffers.length;
      for (let a = 0; a < allpassBuffers.length; a++) {
        const buffer = allpassBuffers[a]!;
        const index = allpassIndices[a]!;
        const delayed = buffer[index]!;
        const stageInput = wet;
        wet = -stageInput * allpassGain + delayed;
        buffer[index] = stageInput + delayed * allpassGain;
        allpassIndices[a] = (index + 1) % buffer.length;
      }
      out[i] = wet;
    }
    return out;
  };
  return { left: render(1.0), right: render(1.017) };
}

/**
 * ステレオコーラス。LFO位相を左右で反転させたモジュレーテッドディレイ。
 * SC-88の音の半分はこれ、というくらいの定番(パッド・エレピ向け)。ウェットのみ返す。
 */
export function stereoChorus(input: Float32Array, sampleRate: number): StereoWave {
  const baseMs = 18;
  const depthMs = 5.5;
  const rateHz = 0.55;
  const maxDelay = Math.ceil(((baseMs + depthMs) / 1000) * sampleRate) + 2;
  const render = (phase: number): Float32Array => {
    const buffer = new Float32Array(maxDelay);
    let writeIndex = 0;
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      buffer[writeIndex] = input[i]!;
      const delaySamples = ((baseMs + depthMs * Math.sin(2 * Math.PI * rateHz * (i / sampleRate) + phase)) / 1000) * sampleRate;
      let readPosition = writeIndex - delaySamples;
      while (readPosition < 0) readPosition += maxDelay;
      const readFloor = Math.floor(readPosition) % maxDelay;
      const frac = readPosition - Math.floor(readPosition);
      const next = (readFloor + 1) % maxDelay;
      out[i] = buffer[readFloor]! + frac * (buffer[next]! - buffer[readFloor]!);
      writeIndex = (writeIndex + 1) % maxDelay;
    }
    return out;
  };
  return { left: render(0), right: render(Math.PI) };
}

/**
 * ピンポン・フィードバックディレイ(オーディオ段)。左右の遅延線が互いへ送り合う。
 * フィードバック量がそのまま残響の伸び=ダイナミクスを決める。ウェットのみ返す。
 */
export function pingPongDelay(
  input: Float32Array,
  sampleRate: number,
  delaySec: number,
  feedback = 0.45,
): StereoWave {
  const delaySamples = Math.max(1, Math.round(delaySec * sampleRate));
  const bufferL = new Float32Array(delaySamples);
  const bufferR = new Float32Array(delaySamples);
  const left = new Float32Array(input.length);
  const right = new Float32Array(input.length);
  let index = 0;
  let dampL = 0;
  let dampR = 0;
  for (let i = 0; i < input.length; i++) {
    const outL = bufferL[index]!;
    const outR = bufferR[index]!;
    left[i] = outL;
    right[i] = outR;
    // フィードバック経路に1次ローパス(繰り返すほど丸くなるアナログ的減衰)。
    dampL += (outR - dampL) * 0.4;
    dampR += (outL - dampR) * 0.4;
    bufferL[index] = input[i]! + dampL * feedback;
    bufferR[index] = dampR * feedback;
    index = (index + 1) % delaySamples;
  }
  return { left, right };
}
