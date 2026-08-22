/**
 * 声部ジェネレータが共有する読み取り専用の作曲コンテキスト。
 *
 * compose() が設計図（SongPlan / ArrangementPlan / PhrasePlan）と和声実音
 * （chords / chordAt）を確定した後に組み、各声部（melody-voice / counter-voice /
 * bass-voice / ostinato-voice / drum-voice）はこれだけを見て実音を生成する。
 * 声部間の依存（例: 副旋律が主旋律の発音を避ける）は関数引数として明示する。
 *
 * 声部ジェネレータは乱数を持たない: 抽選はすべて設計図の段階で済んでおり、
 * ここから先は決定論的な実現だけを行う（シードのビット読みは順序非依存で許容）。
 */

import type { StyleDef } from './theory.js';
import type { GrooveFeel } from './groove.js';
import type {
  ArrangementPlan,
  BassLinePolicy,
  ChordEvent,
  ComposeInput,
  MelodicLanguage,
  MotifMove,
  PhrasePlan,
  SongPlan,
} from './types.js';

export interface ComposeContext {
  opts: ComposeInput;
  style: StyleDef;
  /** 0..11 に正規化済みのキー主音。 */
  keyRoot: number;
  melodicLanguage: MelodicLanguage;
  /** 旋律語彙の絶対ピッチクラス。 */
  scalePcs: readonly number[];
  grooveFeel: GrooveFeel;
  engineRev: number;
  bassLinePolicy: BassLinePolicy;
  songPlan: SongPlan;
  arrangementPlan: ArrangementPlan;
  phrasePlan: PhrasePlan;
  /** 区間ごとの音程ジェスチャー（外部モチーフ差し替え済み）。 */
  phraseGestures: readonly (readonly MotifMove[])[];
  /** ループ本体の和声（イントロを含まない、シフト前の拍位置）。 */
  chords: readonly ChordEvent[];
  chordAt: (beat: number) => ChordEvent;
  /** その和音の局所音組織（コードスケール）。 */
  scaleAt: (chord: ChordEvent) => readonly number[];
  /** 旋律の強拍・到達点が使える和声音（和風は共通音優先）。 */
  melodyPcsForChord: (chord: ChordEvent) => readonly number[];
  startMidi: number;
  climaxMidi: number;
  baseCenter: number;
  scaleStepMax: number;
}
