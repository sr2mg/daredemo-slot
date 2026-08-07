/**
 * BGMのMP3書き出し。mp3はギャップレスループができないため、
 * 「イントロ+ループ本体×N周(+次ループ頭へ食い込むフェードアウト)」の直線波形へ
 * 展開してからエンコードする(ゲームBGM配布の定番形)。
 *
 * エンコーダはwasm-media-encoders(LAMEのWASMビルド、ラッパーはMIT)。
 * 入力レートは任意(チップ音源の49716Hz含む)でLAMEが内部リサンプリングする。
 * エンコードはチャンクごとにイベントループへ譲り、UIを固めない。
 *
 * ライブラリはWASMをbase64同梱しており(≈185KB)、静的importすると全ページの
 * 初期バンドルへ入ってしまうため、初回書き出し時の動的importで遅延ロードする。
 */

export interface Mp3ExportSource {
  /** モノラル、またはステレオの左チャンネル。 */
  wave: Float32Array;
  /** ステレオの右チャンネル(waveと同一長)。省略時はモノラルで書き出す。 */
  waveRight?: Float32Array;
  sampleRate: number;
  loopStartSec: number;
  loopEndSec: number;
}

export interface Mp3ExportSpec {
  /** ループ本体を何周入れるか(1..)。 */
  loopCount: number;
  /** 最終周のあと、次ループの頭へ食い込みながらフェードアウトする。 */
  fade: boolean;
}

/** フェード長(秒)。ループ本体がこれより短ければ本体長へ丸める。 */
export const FADE_SEC = 4;

/** VBR品質(0=最高..9)。2は≈190kbps相当で、配布・試聴用途の定番。 */
const VBR_QUALITY = 2;

/** 1チャンネルぶんをイントロ+本体×N(+フェード食い込み)へ展開する純関数。 */
export function unrollChannel(
  wave: Float32Array,
  loopStartSample: number,
  loopEndSample: number,
  loopCount: number,
  fadeSamples: number,
): Float32Array {
  const body = wave.subarray(loopStartSample, loopEndSample);
  const fade = Math.min(fadeSamples, body.length);
  const total = loopStartSample + body.length * loopCount + fade;
  const out = new Float32Array(total);
  out.set(wave.subarray(0, loopStartSample), 0);
  for (let i = 0; i < loopCount; i++) {
    out.set(body, loopStartSample + body.length * i);
  }
  if (fade > 0) {
    out.set(body.subarray(0, fade), loopStartSample + body.length * loopCount);
    // レイズドコサインで最終サンプルちょうどに無音へ到達する。
    for (let i = 0; i < fade; i++) {
      out[total - fade + i]! *= 0.5 * (1 + Math.cos(Math.PI * ((i + 1) / fade)));
    }
  }
  return out;
}

/** 波形を展開してMP3のBlobを返す。onProgressは0..1。 */
export async function exportMp3(
  source: Mp3ExportSource,
  spec: Mp3ExportSpec,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  const rate = source.sampleRate;
  const loopStartSample = Math.max(0, Math.min(Math.round(source.loopStartSec * rate), source.wave.length));
  const loopEndSample = Math.max(loopStartSample, Math.min(Math.round(source.loopEndSec * rate), source.wave.length));
  const loopCount = Math.max(1, Math.round(spec.loopCount));
  const fadeSamples = spec.fade ? Math.round(FADE_SEC * rate) : 0;
  const left = unrollChannel(source.wave, loopStartSample, loopEndSample, loopCount, fadeSamples);
  const right = source.waveRight && source.waveRight.length === source.wave.length
    ? unrollChannel(source.waveRight, loopStartSample, loopEndSample, loopCount, fadeSamples)
    : null;

  const { createMp3Encoder } = await import('wasm-media-encoders');
  const encoder = await createMp3Encoder();
  encoder.configure({
    sampleRate: rate,
    channels: right ? 2 : 1,
    vbrQuality: VBR_QUALITY,
  });
  const chunks: Uint8Array[] = [];
  const CHUNK_SAMPLES = 1 << 17; // ≈2.6秒@49716Hz。進捗表示とUI譲りの粒度
  for (let at = 0; at < left.length; at += CHUNK_SAMPLES) {
    const end = Math.min(left.length, at + CHUNK_SAMPLES);
    const slice: readonly Float32Array[] = right
      ? [left.subarray(at, end), right.subarray(at, end)]
      : [left.subarray(at, end)];
    // encodeの戻りはエンコーダ所有のバッファなので、次の呼び出し前に必ずコピーする。
    const data = encoder.encode(slice);
    if (data.length > 0) chunks.push(data.slice());
    onProgress?.(end / left.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const tail = encoder.finalize();
  if (tail.length > 0) chunks.push(tail.slice());
  return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
}
