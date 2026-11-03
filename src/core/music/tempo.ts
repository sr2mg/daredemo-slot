/**
 * テンポ写像: 拍(4分音符)と秒の変換を一箇所に置く。
 *
 * エンジンの時間単位は拍で、レンダラ(OPLL / 2A03 / PCM / MIDI)はこれまで `spb = 60 / bpm` の
 * 線形変換で秒へ写していた。区間ごとのテンポと終結のリタルダンドを入れるため、変換を
 * 「区分一定のテンポ写像」へ一般化する:
 * - TempoMap は拍で昇順の点列。各点から次の点までその bpm が一定(階段関数)。
 *   区分線形(点間で bpm が連続に変わる)より表現は粗いが、積分と逆変換が閉形式で正確に
 *   往復し、拍ごとに点を置けばリタルダンドの滑らかさは十分(1 拍=数百 ms)。
 * - 写像を持たない曲(Piece.tempoMap 省略)は従来どおり一定テンポ。tempoMapOf が補完するので
 *   テストの手組み Piece も壊れない。
 * - 単一の遅延線(bus-fx の release、オーディオ段ディレイ)は曲の名目 bpm のまま。
 */

export interface TempoPoint {
  /** 絶対拍(イントロ込み)。 */
  beat: number;
  bpm: number;
}

/** 拍で昇順、先頭は beat 0。各点の bpm が次の点まで一定。 */
export type TempoMap = readonly TempoPoint[];

export function constantTempoMap(bpm: number): TempoMap {
  return [{ beat: 0, bpm }];
}

/** Piece(や名目 bpm を持つもの)の実効テンポ写像。省略時は一定。 */
export function tempoMapOf(piece: { bpm: number; tempoMap?: TempoMap | undefined }): TempoMap {
  return piece.tempoMap && piece.tempoMap.length > 0 ? piece.tempoMap : constantTempoMap(piece.bpm);
}

/** その拍で効く bpm(点の左側は先頭の bpm)。 */
export function bpmAt(map: TempoMap, beat: number): number {
  let bpm = map[0]!.bpm;
  for (const point of map) {
    if (point.beat <= beat + 1e-9) bpm = point.bpm;
    else break;
  }
  return bpm;
}

/** 拍 → 秒(写像の区分一定テンポを積分)。負の拍は先頭の bpm で線形に外挿する。 */
export function beatToSeconds(map: TempoMap, beat: number): number {
  let seconds = 0;
  for (let index = 0; index < map.length; index++) {
    const point = map[index]!;
    const next = map[index + 1];
    const segmentStart = index === 0 ? Math.min(0, beat) : point.beat;
    const segmentEnd = next ? Math.min(next.beat, beat) : beat;
    if (segmentEnd <= segmentStart) {
      if (beat <= point.beat) break;
      continue;
    }
    // 一定テンポでは従来の `beat * (60 / bpm)` とビット同一になる順序で掛ける。
    seconds += (segmentEnd - segmentStart) * (60 / point.bpm);
    if (!next || beat <= next.beat) break;
  }
  return seconds;
}

/** 秒 → 拍(beatToSeconds の逆)。 */
export function secondsToBeat(map: TempoMap, seconds: number): number {
  let elapsed = 0;
  for (let index = 0; index < map.length; index++) {
    const point = map[index]!;
    const next = map[index + 1];
    const start = index === 0 ? 0 : point.beat;
    const secondsPerBeat = 60 / point.bpm;
    if (!next) return start + (seconds - elapsed) / secondsPerBeat;
    const segmentSeconds = (next.beat - start) * secondsPerBeat;
    if (seconds < elapsed + segmentSeconds) return start + (seconds - elapsed) / secondsPerBeat;
    elapsed += segmentSeconds;
  }
  return 0;
}

/** 秒の区間長(拍 from..to)。 */
export function beatsToSeconds(map: TempoMap, from: number, to: number): number {
  return beatToSeconds(map, to) - beatToSeconds(map, from);
}

/**
 * 終結のリタルダンド(ending='ritardando')。
 * 最終 RITARDANDO_BARS 小節を拍ごとに減速し、最終拍で RITARDANDO_FINAL_FACTOR に達する
 * (拍位置に対して線形。Friberg & Sundberg 1999 は走者の減速に倣う指数 ~2 のべき曲線を
 * 報告するが、2 小節・8 段では線形との差が知覚閾の内側なので最も単純な形を採る)。
 * 終止和音(最終小節後半の V→I の I、2 拍)はさらに FERMATA_FACTOR 倍に延ばす。
 */
export const RITARDANDO_BARS = 2;
export const RITARDANDO_FINAL_FACTOR = 0.5;
export const FERMATA_FACTOR = 2;

export function ritardandoTempoMap(bpm: number, endBeat: number, fermataBeats = 2): TempoMap {
  const beats = RITARDANDO_BARS * 4;
  const start = Math.max(0, endBeat - beats);
  const points: TempoPoint[] = [{ beat: 0, bpm }];
  for (let k = 0; k < beats; k++) {
    const beat = start + k;
    if (beat >= endBeat) break;
    const progress = (k + 1) / beats;
    const factor = 1 - (1 - RITARDANDO_FINAL_FACTOR) * progress;
    const fermata = beat >= endBeat - fermataBeats ? FERMATA_FACTOR : 1;
    points.push({ beat, bpm: bpm * factor / fermata });
  }
  return points.filter((point, index) => index === 0 || point.beat > 0);
}

/**
 * 区間ごとのテンポ(SectionSpec.tempo)から写像を組む。イントロは曲の bpm。
 * どの区間もテンポを持たなければ null(Piece.tempoMap を省略する)。
 */
export function sectionTempoMap(
  bpm: number,
  loopStartBeat: number,
  sections: readonly { startBar: number; tempo?: number | undefined }[],
): TempoMap | null {
  if (!sections.some((section) => section.tempo !== undefined)) return null;
  const points: TempoPoint[] = [{ beat: 0, bpm }];
  for (const section of sections) {
    const beat = loopStartBeat + section.startBar * 4;
    const sectionBpm = section.tempo ?? bpm;
    if (beat === 0) points[0] = { beat: 0, bpm: sectionBpm };
    else if (points.at(-1)!.bpm !== sectionBpm) points.push({ beat, bpm: sectionBpm });
  }
  return points;
}

/** 2 つの写像を重ねる(後者の最終点以降は後者が優先: 区間テンポの上にリタルダンドを乗せる)。 */
export function overlayTempoMap(base: TempoMap, ritardando: TempoMap): TempoMap {
  if (ritardando.length <= 1) return base;
  const ritStart = ritardando[1]!.beat;
  const baseBpmAtRit = bpmAt(base, ritStart);
  const scale = baseBpmAtRit / ritardando[0]!.bpm;
  return [
    ...base.filter((point) => point.beat < ritStart),
    ...ritardando.slice(1).map((point) => ({ beat: point.beat, bpm: point.bpm * scale })),
  ];
}
