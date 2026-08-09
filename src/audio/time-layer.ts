/**
 * 時間装置: 「二重時間軸」(MIDI段のエコートラック+オーディオ段のフィードバックディレイ)
 * を明示的な仕様として一箇所に置く。
 *
 * - MIDI段(noteStage): 旋律の複製+遅延+減衰。再発音なのでアタックが立つ。
 *   遅延則(8分、bounce時はスウィング後の2/3拍)はnoteStageEchoForが単一に所有し、
 *   OPLL編曲(opll-arrange)もPCM編曲もこの関数を参照する。タップ数と減衰だけは
 *   声部予算の都合でバックエンド固有(OPLLは1タップの減衰ダブリング)。
 * - オーディオ段(audioStage): 付点8分のピンポンディレイ。スメアの軸。
 *   noteStageと**意図的に別の分割**を持つことで初めて「軸が2本」になる。
 * - どちらもarrangement層のセクション計画(section.echo)が有効にした区間だけで鳴る。
 *   常時掛けはしない(SC-88世代でもエコートラックは編曲の一部=出し引きの対象)。
 *
 * 出典系譜: rei harakamiのVSシリーズ運用(MIDI段+オーディオ段の二重構造)
 * https://sai96i.hateblo.jp/entry/2021/05/10/204035
 */

import { grooveBeat } from '../core/music/compose.js';
import type { GrooveFeel } from '../core/music/compose.js';
import type { StageRole } from './stage.js';

export interface NoteStageEcho {
  /** タップ遅延(拍)。 */
  delayBeats: number;
  taps: number;
  decay: number;
}

/**
 * MIDI段エコーの遅延をグルーヴから導出する(OPLLエコー装置と同一の規則)。
 * タップは「8分裏をグルーヴ格子へ写した位置」= grooveBeat(0.5) に置く(スウィング軸に追随)。
 */
export function noteStageEchoFor(grooveFeel: GrooveFeel): NoteStageEcho {
  return {
    delayBeats: grooveBeat(0.5, grooveFeel),
    taps: 2,
    decay: 0.5,
  };
}

/** オーディオ段ディレイの遅延(拍)。付点8分=MIDI段と異なる第二の時間軸。 */
export const AUDIO_STAGE_DELAY_BEATS = 0.75;

/** オーディオ段ディレイへの送り量(ロール別)。時間装置は空間(depth)と独立の軸。 */
export const ROLE_DELAY_SEND: Record<StageRole, number> = {
  lead: 0.22,
  duet: 0.08,
  counter: 0.12,
  ostinato: 0,
  backing: 0,
  bass: 0,
  drums: 0,
};

/**
 * エコートラック: ノート列へ遅延コピーを足す純関数。
 * loopStartSec/loopEndSecを与えると、ループ末尾を越えるタップをループ先頭側へ
 * 巻き戻す(OPLLエコー装置と同じループ意味論)。
 */
export function withEchoTracks<T extends { startSec: number; gain: number }>(
  notes: readonly T[],
  spec: NoteStageEcho,
  beatSec: number,
  loop?: { startSec: number; endSec: number },
): T[] {
  const result: T[] = [...notes];
  for (const note of notes) {
    for (let tap = 1; tap <= spec.taps; tap++) {
      let startSec = note.startSec + spec.delayBeats * beatSec * tap;
      if (loop && startSec >= loop.endSec) {
        startSec = loop.startSec + (startSec - loop.endSec);
      }
      result.push({
        ...note,
        startSec,
        gain: note.gain * spec.decay ** tap,
      });
    }
  }
  return result;
}
