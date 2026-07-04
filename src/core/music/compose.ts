/**
 * 決定論的な作曲エンジン（サウンドテスト用）。
 * 決定順序は「テンポ・キー → スタイル → フォーム → コード進行 → モチーフ → メロディ」の
 * トップダウン（docs 未整備。UI の SoundTestPanel が唯一の呼び出し元）。
 * 同一シード + 同一オプションなら常に同じ Piece を返す（Xoshiro128 再利用）。
 *
 * メロディの制約:
 * - 強拍（1・3 拍目）はその時点のコードトーンに限定
 * - 弱拍はスケール音の順次進行 or コードトーンへの跳躍
 * - クライマックス（最高音）は BB=7 小節目 / RB=3 小節目の頭に 1 箇所
 * - 最終小節の後半は音を減らしてループの頭に「渡す」
 */

import { Xoshiro128 } from '../rng.js';
import type { Rng } from '../rng.js';
import { CHORDS, MAJOR_SCALE, PROGRESSIONS, STYLES, chordName } from './theory.js';
import type { ProgressionDef } from './theory.js';

export interface ComposeOptions {
  progressionId: string;
  styleId: string;
  /** キー主音のピッチクラス（0 = C） */
  keyRoot: number;
  bpm: number;
  /** 4 = RB / 8 = BB。4 小節進行 × 8 小節は 2 周して A + A' 化 */
  bars: 4 | 8;
  seed: number;
  /** 全小節ぶんのスロット選択。省略時は defaultChoiceFor() */
  choice?: readonly number[];
}

export interface NoteEvent {
  beat: number;
  dur: number;
  midi: number;
}

export interface ChordEvent {
  beat: number;
  dur: number;
  token: string;
  name: string;
  /** 絶対ピッチクラス集合（検証用） */
  pcs: number[];
  /** パッド用の実音（オクターブ 4 帯） */
  midis: number[];
}

export interface DrumEvent {
  beat: number;
  inst: 'kick' | 'snare' | 'hat';
}

export interface Piece {
  bpm: number;
  bars: number;
  /** 総拍数（= bars * 4） */
  beats: number;
  keyRoot: number;
  chords: ChordEvent[];
  melody: NoteEvent[];
  bass: NoteEvent[];
  drums: DrumEvent[];
  /** 表示用: 小節ごとのコード名（半小節は空白区切り） */
  barChordNames: string[];
}

/** メロディ音域: C5..E6 */
const MELODY_LO = 72;
const MELODY_HI = 88;

/**
 * 進行を尺いっぱいに展開したときの定番スロット選択。
 * 2 周する場合、最終小節にドミナント(V)の選択肢があればそれを選び、
 * ループの頭（I など）へ引っ張る（A + A' の A' 側だけ変える定石）。
 */
export function defaultChoiceFor(prog: ProgressionDef, bars: number): number[] {
  const progBars = prog.slots.length;
  const rounds = Math.max(1, Math.floor(bars / progBars));
  const choice: number[] = [];
  for (let r = 0; r < rounds; r++) {
    for (let b = 0; b < progBars; b++) {
      let idx = prog.defaultChoice[b] ?? 0;
      if (rounds > 1 && r === rounds - 1 && b === progBars - 1) {
        const vIdx = prog.slots[b]!.findIndex((opt) => opt.length === 1 && opt[0] === 'V');
        if (vIdx >= 0) idx = vIdx;
      }
      choice.push(idx);
    }
  }
  return choice;
}

/** target に最も近い、pcs に含まれる MIDI ノート（音域内） */
function nearestWithPc(target: number, pcs: readonly number[], lo = MELODY_LO, hi = MELODY_HI): number {
  const t = Math.max(lo, Math.min(hi, target));
  let best = -1;
  let bestDist = Infinity;
  for (let m = lo; m <= hi; m++) {
    if (!pcs.includes(m % 12)) continue;
    const d = Math.abs(m - t);
    if (d < bestDist) {
      bestDist = d;
      best = m;
    }
  }
  return best; // pcs が空でない限り必ず見つかる
}

/** from から dir 方向に 1 歩、pcs 上を進む（順次進行） */
function stepOnScale(from: number, dir: 1 | -1, pcs: readonly number[]): number {
  let m = from + dir;
  while (m >= MELODY_LO - 12 && m <= MELODY_HI + 12 && !pcs.includes(((m % 12) + 12) % 12)) m += dir;
  return Math.max(MELODY_LO, Math.min(MELODY_HI, m));
}

/**
 * モチーフのリズム（8 分グリッド 8 ステップ）。
 * 1・3 拍目（step 0, 4）は必ず発音。音数は 4〜6 に収める
 * （少なすぎると寂しく、多すぎると BPM170 で忙しない）。
 */
function makeMotifRhythm(rng: Rng): boolean[] {
  const r = Array.from({ length: 8 }, (_, i) => i === 0 || i === 4 || rng.nextInt(100) < 55);
  const optional = [1, 2, 3, 5, 6, 7];
  let count = r.filter(Boolean).length;
  while (count > 6) {
    const i = optional[rng.nextInt(optional.length)]!;
    if (r[i]) {
      r[i] = false;
      count--;
    }
  }
  while (count < 4) {
    const i = optional[rng.nextInt(optional.length)]!;
    if (!r[i]) {
      r[i] = true;
      count++;
    }
  }
  return r;
}

export function compose(opts: ComposeOptions): Piece {
  const prog = PROGRESSIONS.find((p) => p.id === opts.progressionId);
  if (!prog) throw new Error(`未知の進行: ${opts.progressionId}`);
  const style = STYLES.find((s) => s.id === opts.styleId);
  if (!style) throw new Error(`未知のスタイル: ${opts.styleId}`);
  const progBars = prog.slots.length;
  if (progBars > opts.bars) throw new Error(`進行(${progBars}小節)が尺(${opts.bars}小節)より長い`);

  const rng = new Xoshiro128(opts.seed >>> 0);
  const keyRoot = ((opts.keyRoot % 12) + 12) % 12;
  const choice = opts.choice ?? defaultChoiceFor(prog, opts.bars);

  // --- コード進行の確定（スロット選択 → 小節ごとの実コード列） ---
  const barTokens: string[][] = [];
  for (let bar = 0; bar < opts.bars; bar++) {
    const slot = prog.slots[bar % progBars]!;
    const idx = Math.max(0, Math.min(slot.length - 1, choice[bar] ?? 0));
    barTokens.push([...slot[idx]!]);
  }

  const chords: ChordEvent[] = [];
  barTokens.forEach((tokens, bar) => {
    const dur = 4 / tokens.length;
    tokens.forEach((token, i) => {
      const def = CHORDS[token]!;
      const pcs = def.tones.map((t) => (t + keyRoot) % 12);
      chords.push({
        beat: bar * 4 + i * dur,
        dur,
        token,
        name: chordName(token, keyRoot),
        pcs,
        midis: pcs.map((pc) => 60 + pc),
      });
    });
  });
  const chordAt = (beat: number): ChordEvent => {
    let cur = chords[0]!;
    for (const c of chords) {
      if (c.beat <= beat) cur = c;
      else break;
    }
    return cur;
  };

  // --- メロディ（モチーフ + 展開） ---
  const scalePcs = MAJOR_SCALE.map((t) => (t + keyRoot) % 12);
  const motif = makeMotifRhythm(rng);
  // 小節ごとの目標センター（起伏）: 呼びかけ → 応答で少し上がって戻る
  const centerOffsets = [0, 2, 4, 1];
  const climaxBar = opts.bars === 8 ? 6 : 2; // BB=7小節目 / RB=3小節目
  const baseCenter = 78;

  const melody: NoteEvent[] = [];
  let prev = nearestWithPc(76, chordAt(0).pcs);
  for (let bar = 0; bar < opts.bars; bar++) {
    const isCadence = bar === opts.bars - 1;
    const isClimax = bar === climaxBar;
    const center = isClimax ? MELODY_HI - 2 : baseCenter + centerOffsets[bar % 4]!;
    // 最終小節は後半（step 5..7）を落として頭に渡す。着地の step 4 は残す
    const rhythm = isCadence ? motif.map((on, i) => on && i < 5) : motif;
    const onsets: number[] = [];
    rhythm.forEach((on, i) => on && onsets.push(i));

    for (let k = 0; k < onsets.length; k++) {
      const step = onsets[k]!;
      const beat = bar * 4 + step * 0.5;
      const chord = chordAt(beat);
      const strong = step === 0 || step === 4;
      let midi: number;
      if (isClimax && step === 0) {
        // クライマックス: 音域上限に最も近いコードトーン
        midi = nearestWithPc(MELODY_HI, chord.pcs);
      } else if (strong) {
        // 強拍はコードトーン限定。センターへ 1/3 だけ寄せて滑らかに
        midi = nearestWithPc(prev + Math.round((center - prev) / 3), chord.pcs);
      } else if (rng.nextInt(100) < 70) {
        // 弱拍 70%: スケール上の順次進行（センター方向に偏らせる）
        const dir: 1 | -1 = rng.nextInt(100) < 75 ? (center >= prev ? 1 : -1) : center >= prev ? -1 : 1;
        midi = stepOnScale(prev, dir, scalePcs.includes(prev % 12) ? scalePcs : chord.pcs);
      } else {
        // 弱拍 30%: コードトーンへ跳躍
        const dir = rng.nextInt(2) === 0 ? 1 : -1;
        midi = nearestWithPc(prev + dir * (3 + rng.nextInt(3)), chord.pcs);
      }
      const nextStep = k + 1 < onsets.length ? onsets[k + 1]! : 8;
      melody.push({ beat, dur: (nextStep - step) * 0.5 * 0.9, midi });
      prev = midi;
    }
  }

  // --- ベース（スタイル依存） ---
  const bass: NoteEvent[] = [];
  for (const c of chords) {
    const rootPc = (CHORDS[c.token]!.root + keyRoot) % 12;
    const root = 40 + ((rootPc - 4 + 12) % 12); // E2..D#3 帯
    if (style.bass === 'rootFifth') {
      for (let b = 0; b < c.dur; b++) {
        bass.push({ beat: c.beat + b, dur: 0.9, midi: b % 2 === 0 ? root : root + 7 });
      }
    } else {
      for (let e = 0; e < c.dur * 2; e++) {
        const midi = style.bass === 'octave8' && e % 2 === 1 ? root + 12 : root;
        bass.push({ beat: c.beat + e * 0.5, dur: 0.4, midi });
      }
    }
  }

  // --- ドラム（16 分グリッドを小節数ぶん敷く） ---
  const drums: DrumEvent[] = [];
  for (let bar = 0; bar < opts.bars; bar++) {
    for (let s = 0; s < 16; s++) {
      const beat = bar * 4 + s * 0.25;
      if (style.kick[s]) drums.push({ beat, inst: 'kick' });
      if (style.snare[s]) drums.push({ beat, inst: 'snare' });
      if (style.hat[s]) drums.push({ beat, inst: 'hat' });
    }
  }

  return {
    bpm: opts.bpm,
    bars: opts.bars,
    beats: opts.bars * 4,
    keyRoot,
    chords,
    melody,
    bass,
    drums,
    barChordNames: barTokens.map((tokens) => tokens.map((t) => chordName(t, keyRoot)).join(' ')),
  };
}

export interface Violation {
  beat: number;
  midi: number;
  reason: string;
}

/**
 * 生成結果の機械的検証。
 * - 強拍（各小節の 1・3 拍目）のメロディ音がコードトーンか
 * - メロディが音域内か
 * LLM や将来の手動作曲入力にも同じ検証を通す想定。
 */
export function validatePiece(piece: Piece): Violation[] {
  const violations: Violation[] = [];
  const chordAt = (beat: number): ChordEvent => {
    let cur = piece.chords[0]!;
    for (const c of piece.chords) {
      if (c.beat <= beat) cur = c;
      else break;
    }
    return cur;
  };
  for (const n of piece.melody) {
    if (n.midi < MELODY_LO || n.midi > MELODY_HI) {
      violations.push({ beat: n.beat, midi: n.midi, reason: '音域外' });
    }
    const inBar = n.beat % 4;
    if (inBar === 0 || inBar === 2) {
      const chord = chordAt(n.beat);
      if (!chord.pcs.includes(n.midi % 12)) {
        violations.push({ beat: n.beat, midi: n.midi, reason: `強拍が ${chord.name} のコードトーン外` });
      }
    }
  }
  return violations;
}
