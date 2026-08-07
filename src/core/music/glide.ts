/**
 * スライド(ポルタメント): 前音から目標音高へ滑って入る指示(NoteEvent.glideFrom)の
 * 付与規則と、その解釈(グライド時間)の共有規則。バックエンド(OPLL/SF2)は
 * glideDurationSecを参照し、独自の時間定数を持たない。
 *
 * 付与規則は様式仮説であり未検証(四千年由来を名乗っていた「±250セント級の遅い滑り」に
 * 測定物のコミットはない。なお現行のグライド時間は最大90msで、「遅い滑り」の主張とは
 * 別物の速いスラーである——測定して裏を取るまで時間定数は変えない):
 * 前音とほぼ地続き(間隙0.3拍以内)の3〜9半音の移動で、強拍でない着地に限る(決定論)。
 */

import type { NoteEvent } from './compose.js';

export type GlidePolicy = 'on' | 'off';

/** グライド時間の共有規則: 音価の半分、最大90ms。 */
export function glideDurationSec(noteDurSec: number): number {
  return Math.min(0.09, noteDurSec * 0.5);
}

/** 主旋律の該当音へglideFrom指示を付ける(破壊的更新)。 */
export function applyGlideMarks(melody: readonly NoteEvent[], loopStartBeat: number): void {
  const line = melody
    .filter((note) => note.beat >= loopStartBeat)
    .sort((a, b) => a.beat - b.beat);
  for (let i = 1; i < line.length; i++) {
    const prev = line[i - 1]!;
    const note = line[i]!;
    const restGap = note.beat - (prev.beat + prev.dur);
    const interval = Math.abs(note.midi - prev.midi);
    const strongBeat = ((note.beat - loopStartBeat) % 2) === 0;
    if (restGap <= 0.3 && interval >= 3 && interval <= 9 && !strongBeat) {
      note.glideFrom = prev.midi;
    }
  }
}
