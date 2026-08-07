/**
 * ハモリ層(平行下3度): 主旋律の骨格音に、コードスケール上の2度数下の音を並走させる装置。
 *
 * 付与規則は様式仮説であり未検証(四千年由来を名乗っていた「3度の同時音が約3割」に
 * 測定物のコミットはない。一次資料での測定を経るまで実測とは呼ばない):
 * - 連れは骨格音だけに付ける(装飾音に付けると濁る)
 * - 編成がfullの区間だけ鳴らす(エコートラック等と同じく出し引きの対象)
 * - スケール外の音には付けない(半音階的な音は並行写像が定義できない)
 *
 * 音量はここでは決めない: velocityは主旋律のフレージングをそのまま継承し、
 * パート間バランスは各ミキサー(PCMのPART_GAINS / OPLLの音量オフセット)が単独で所有する。
 */

import type { ArrangementSectionPlan, NoteEvent } from './compose.js';

export type DuetPolicy = 'on' | 'off';

/** ハモリの音域下限(G3)。低すぎる3度は濁るので連れを付けない。 */
const DUET_FLOOR_MIDI = 55;

/**
 * 主旋律からハモリ声部を導出する純関数。
 * sectionAt/scaleAtBeatは絶対拍(イントロ込み)を受け取るコールバック。
 */
export function duetLayerFor(
  melody: readonly NoteEvent[],
  loopStartBeat: number,
  sectionAt: (beat: number) => ArrangementSectionPlan,
  scaleAtBeat: (beat: number) => readonly number[],
): NoteEvent[] {
  // 主旋律用のstepOnScaleは音域端で反転するため使わない(ハモリは旋律音域の下へ出る)。
  const scaleStepBelow = (midi: number, pcs: readonly number[]): number => {
    for (let m = midi - 1; m >= midi - 12; m--) {
      if (pcs.includes(((m % 12) + 12) % 12)) return m;
    }
    return midi;
  };
  const duet: NoteEvent[] = [];
  for (const note of melody) {
    if (note.role === 'ornament' || note.beat < loopStartBeat) continue;
    if (sectionAt(note.beat).backingDensity !== 'full') continue;
    const scale = scaleAtBeat(note.beat);
    if (!scale.includes(note.midi % 12)) continue; // 半音階的な音には連れを付けない
    const below = scaleStepBelow(scaleStepBelow(note.midi, scale), scale);
    if (below >= note.midi || below < DUET_FLOOR_MIDI || note.midi - below > 5) continue; // 下3度圏のみ
    duet.push({
      beat: note.beat,
      dur: note.dur,
      midi: below,
      ...(note.velocity !== undefined ? { velocity: note.velocity } : {}),
      articulation: note.articulation ?? 'normal',
      role: 'structural',
    });
  }
  return duet;
}
