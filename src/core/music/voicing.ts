/**
 * 伴奏ボイシング: 直前の和音から最短声部連結になる密集配置を全探索で選ぶ。
 * compose の和声実音化と intro の逆算ボイシングが共有する。
 */


export function midiCandidatesForPc(pc: number, lo: number, hi: number): number[] {
  const result: number[] = [];
  for (let midi = lo; midi <= hi; midi++) if (midi % 12 === pc) result.push(midi);
  return result;
}

/**
 * 各コードを低音から高音へ並べ、直前の同じ声部から最短距離になる転回形を選ぶ。
 * OPLLの単音バッキングが参照する中央2声を特に滑らかにする。
 */
export function voiceChord(
  pcs: readonly number[],
  previous: readonly number[] | null,
  openFifths = false,
): number[] {
  // 和風モードでは三度・七度を伴奏から抜き、根音－五度－根音の開いた配置にする。
  // 和声機能そのものは ChordEvent.pcs に残すので、進行の意味までは失わない。
  const voicingPcs = openFifths && pcs.length >= 3 ? [pcs[0]!, pcs[2]!, pcs[0]!] : [...pcs];
  const choices = voicingPcs.map((pc) => midiCandidatesForPc(pc, 55, 79));
  const candidates: number[][] = [];
  const visit = (index: number, picked: number[]) => {
    if (index === choices.length) {
      const sorted = [...picked].sort((a, b) => a - b);
      if (new Set(sorted).size === sorted.length && sorted.at(-1)! - sorted[0]! <= 14) candidates.push(sorted);
      return;
    }
    for (const midi of choices[index]!) visit(index + 1, [...picked, midi]);
  };
  visit(0, []);

  const reference = previous ?? (voicingPcs.length === 4 ? [57, 60, 64, 67] : [57, 62, 66]);
  const voiceAt = (notes: readonly number[], index: number): number =>
    notes[Math.min(index, notes.length - 1)]!;
  const score = (notes: readonly number[]): number => {
    let total = Math.abs(notes.reduce((sum, midi) => sum + midi, 0) / notes.length - 64) * 0.2;
    for (let index = 0; index < notes.length; index++) {
      const movement = Math.abs(notes[index]! - voiceAt(reference, index));
      total += movement + Math.max(0, movement - 5) * 3;
    }
    // 実際に鳴らす中央声部を優先して連結する。
    for (const index of [1, 2]) {
      if (notes[index] !== undefined) total += Math.abs(notes[index]! - voiceAt(reference, index)) * 1.5;
    }
    return total;
  };
  return candidates.sort((a, b) => score(a) - score(b))[0]
    ?? voicingPcs.map((pc) => 60 + pc).sort((a, b) => a - b);
}
