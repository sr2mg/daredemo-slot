/**
 * コードの中央声部を単音リフとして刻む「裏打ちバッキング」のリズム骨格。
 *
 * どの拍を鳴らし・どこを間引き・どちらの声部と交互になるかという編曲判断は
 * チップ固有ではないので、OPLL(opll-arrange)と2A03(nes-apu)がここを共有する。
 * どのMIDIノートを「下声部/上声部」に選ぶかはバックエンドの声部予算・カラートーン
 * 能力に依存するため、呼び出し側が slot から実音へ写像する。
 */

import { arrangementSectionFor } from '../core/music/arrangement.js';
import { gridAtBeat } from '../core/music/form.js';
import { effectiveGroove, pulseBeats, stepBeat } from '../core/music/grid.js';
import { grooveBeat } from '../core/music/groove.js';
import type { ChordEvent, Piece } from '../core/music/types.js';

export interface BackingRiffStep {
  /** グルーヴ格子へ写した絶対拍。 */
  beat: number;
  /** 交互刻みのどちら側か。lower=表(下声部)、upper=裏(上声部/カラートーン)。 */
  slot: 'lower' | 'upper';
  /** イントロ・sparse区間の打点(音量を落とす)。表拍は間引かれてこの配列に現れない。 */
  thin: boolean;
}

/**
 * 1コードぶんの裏打ちリフ骨格。
 * thinFrom はsparse判定の基準位置で、OPLLはコード頭('chordStart')、2A03は
 * 各打点('onset')を使ってきた歴史的挙動をそのまま保存している(統一すると
 * 区間境界を跨ぐコードで音が変わるため、意図して分岐のまま共有する)。
 */
export function offbeatBackingRiff(
  piece: Piece,
  chord: ChordEvent,
  thinFrom: 'chordStart' | 'onset',
): BackingRiffStep[] {
  const steps: BackingRiffStep[] = [];
  const section = arrangementSectionFor(piece, chord.beat);
  const chordThin = chord.beat < piece.loopStartBeat || section.backingDensity === 'sparse';
  // テクスチャ区間: sustain は和音頭の 1 打だけ、stab は格子の各ステップで下声部を刻む。
  if (chord.beat >= piece.loopStartBeat && section.backingRhythm !== 'normal') {
    const textureGrid = gridAtBeat(piece.songPlan.form, piece.loopStartBeat, chord.beat);
    if (section.backingRhythm === 'sustain') return [{ beat: chord.beat, slot: 'lower', thin: false }];
    const count = Math.round(chord.dur / textureGrid.stepBeats);
    for (let step = 0; step < count; step++) {
      steps.push({ beat: chord.beat + step * textureGrid.stepBeats, slot: 'lower', thin: false });
    }
    return steps;
  }
  // 裏打ちは各拍頭(格子のもの)から「拍の半分以上の最初のステップ」後(4x2 では 8 分裏、
  // ×3 の格子では 3 連の 3 つ目=2/3)。コードは小節を跨がない。
  const grid = gridAtBeat(piece.songPlan.form, piece.loopStartBeat, chord.beat);
  const feel = effectiveGroove(piece.grooveFeel, grid.grouping);
  const barStart = Math.floor(chord.beat / 4) * 4;
  const chordOffset = chord.beat - barStart;
  const offbeat = stepBeat(grid, Math.ceil(grid.subdivision / 2));
  const pulses = pulseBeats(grid)
    .filter((pulse) => pulse >= chordOffset - 1e-6 && pulse + offbeat < chordOffset + chord.dur - 0.001);
  for (let beat = 0; beat < pulses.length; beat++) {
    const groovedBeat = grooveBeat(barStart + pulses[beat]! + offbeat, feel);
    const thin = thinFrom === 'chordStart'
      ? chordThin
      : groovedBeat < piece.loopStartBeat
        || arrangementSectionFor(piece, groovedBeat).backingDensity === 'sparse';
    // sparse区間は表拍を間引いて密度を半分にする。
    if (thin && beat % 2 === 0) continue;
    steps.push({ beat: groovedBeat, slot: beat % 2 === 0 ? 'lower' : 'upper', thin });
  }
  return steps;
}
