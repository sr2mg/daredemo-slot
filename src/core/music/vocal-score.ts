import type { NoteEvent, Piece } from './compose.js';

/**
 * ハミング声部の設計層。Piece の旋律から、フォルマント合成エンジン（klattsch）の
 * スケジュール（{atMs, target, transitionMs} の列）を導出する純データコンパイラ。
 * - klattsch へのランタイム依存は持たない。スケジュール形状だけを公開契約として共有し、
 *   レンダリングは UI 層（vocal-audio.ts）が行う
 * - 歌詞ではなくハミング／母音の持続で歌う。フォルマント値は Klatt(1980) の音素表に基づく
 * - フレーズの呼吸は作曲済みの休符（ターンアラウンド・間・応答の空白）から導き、
 *   ロングトーンには遅延ビブラートを掛ける。順次進行はポルタメントで繋ぐ
 */

/** klattsch FormantSynth の PARAMS と同名のパラメータ集合（部分指定で上書き）。 */
export interface VocalTarget {
  F0?: number;
  voicing?: number;
  F1?: number;
  BW1?: number;
  A1?: number;
  F2?: number;
  BW2?: number;
  A2?: number;
  F3?: number;
  BW3?: number;
  A3?: number;
  gain?: number;
  vibratoDepth?: number;
  vibratoRate?: number;
  tremoloDepth?: number;
  tremoloRate?: number;
  aspiration?: number;
  tilt?: number;
  effort?: number;
}

export interface VocalEvent {
  atMs: number;
  target: VocalTarget;
  transitionMs: number;
}

export interface VocalScore {
  events: VocalEvent[];
  totalMs: number;
}

export type VocalVowel = 'hum' | 'oo' | 'ah';

export interface VocalVoiceOptions {
  /** 歌う声部。counter は副旋律（保続ガイドライン発火時はストランドを歌う）。 */
  part?: 'melody' | 'counter';
  /** 半音単位の移調。主旋律(C5..E6)は-12で自然なハミング域(C4..E5)に入る。 */
  octaveShift?: number;
  /** 'auto' は低い音を口を閉じたハム、高音・強音を開いた「あ」にする。 */
  vowel?: VocalVowel | 'auto';
  /** コーラス用デチューン（セント）。 */
  detuneCents?: number;
  /** ビブラート深さの倍率（0で無効）。 */
  vibratoScale?: number;
  /** フォルマント倍率。1.0=男声寄り、1.17前後=女声寄り（Klattの慣例値）。 */
  formantScale?: number;
}

/** Klatt(1980) の音素表に基づく持続母音のフォルマント目標（M / UW / AA 相当）。 */
const VOWELS: Record<VocalVowel, VocalTarget> = {
  hum: { F1: 270, BW1: 40, A1: 0.7, F2: 1270, BW2: 200, A2: 0.18, F3: 2130, BW3: 200, A3: 0.1 },
  oo: { F1: 350, BW1: 65, A1: 1, F2: 1250, BW2: 110, A2: 0.9, F3: 2200, BW3: 140, A3: 0.7 },
  ah: { F1: 700, BW1: 130, A1: 1, F2: 1220, BW2: 70, A2: 0.9, F3: 2600, BW3: 160, A3: 0.7 },
};

/** これ以下の隙間はレガート（音を切らず次の目標へ滑る）。 */
const LEGATO_GAP_MS = 40;
/** これ以上の休みで、次のフレーズ頭の直前に吸気ノイズを置く。 */
const BREATH_REST_MS = 350;
/** ノート内でビブラートを始める最低長さ。 */
const VIBRATO_MIN_MS = 500;
/** 声のベースの気息感。 */
const BREATHINESS = 0.05;

export function midiToHz(midi: number, detuneCents = 0): number {
  return 440 * 2 ** ((midi - 69) / 12) * 2 ** (detuneCents / 1200);
}

function vowelTargetFor(
  vowel: VocalVowel | 'auto',
  shiftedMidi: number,
  velocity: number,
  formantScale: number,
): VocalTarget {
  const resolved: VocalVowel = vowel !== 'auto'
    ? vowel
    : shiftedMidi >= 76 || velocity >= 0.85
      ? 'ah'
      : 'hum';
  const base = VOWELS[resolved];
  if (formantScale === 1) return { ...base };
  return {
    ...base,
    F1: base.F1! * formantScale,
    F2: base.F2! * formantScale,
    F3: base.F3! * formantScale,
  };
}

/**
 * 1声部ぶんのスケジュールを導出する。イベントは atMs 昇順。
 * 休符では voicing を 0 へ落とし、長い休みの後は吸気を置いてから歌い直す。
 */
export function vocalScoreFor(piece: Piece, options: VocalVoiceOptions = {}): VocalScore {
  const part = options.part ?? 'melody';
  const octaveShift = options.octaveShift ?? (part === 'melody' ? -12 : 0);
  const vowel = options.vowel ?? 'auto';
  const detuneCents = options.detuneCents ?? 0;
  const vibratoScale = options.vibratoScale ?? 1;
  const formantScale = options.formantScale ?? 1;

  const msPerBeat = 60000 / piece.bpm;
  const totalMs = piece.beats * msPerBeat;
  const source: readonly NoteEvent[] = part === 'counter' ? piece.counterMelody : piece.melody;
  const notes = source
    .filter((note) => note.role !== 'ornament' && note.dur > 0)
    .slice()
    .sort((a, b) => a.beat - b.beat);

  // デチューンした声どうしのビブラートが同期して機械的にならないよう、率も僅かにずらす。
  const vibratoRate = 5.3 + detuneCents * 0.02;
  const events: VocalEvent[] = [{
    atMs: 0,
    transitionMs: 1,
    target: {
      voicing: 0,
      gain: 0,
      vibratoDepth: 0,
      vibratoRate,
      aspiration: 0,
      tilt: -0.2,
      effort: 0.45,
      ...(notes.length > 0
        ? { F0: midiToHz(notes[0]!.midi + octaveShift, detuneCents) }
        : {}),
    },
  }];
  if (notes.length === 0) return { events, totalMs };

  let previousOffMs: number | null = null;
  let previousMidi: number | null = null;
  for (let index = 0; index < notes.length; index++) {
    const note = notes[index]!;
    const shiftedMidi = note.midi + octaveShift;
    const onMs = note.beat * msPerBeat;
    const offMs = (note.beat + note.dur) * msPerBeat;
    const velocity = note.velocity ?? 0.7;
    const legato = previousOffMs !== null && onMs - previousOffMs <= LEGATO_GAP_MS;
    const interval = previousMidi === null ? 0 : Math.abs(shiftedMidi - previousMidi);
    // 順次進行は聴こえるポルタメント、跳躍は素早く、フレーズ頭は短いアタック。
    const transitionMs = legato ? (interval <= 2 ? 70 : 25) : 15;

    events.push({
      atMs: onMs,
      transitionMs,
      target: {
        F0: midiToHz(shiftedMidi, detuneCents),
        voicing: 1,
        gain: 1.6 + velocity * 2.2,
        vibratoDepth: 0,
        aspiration: BREATHINESS,
        ...vowelTargetFor(vowel, shiftedMidi, velocity, formantScale),
      },
    });

    const durMs = offMs - onMs;
    if (durMs >= VIBRATO_MIN_MS && vibratoScale > 0) {
      events.push({
        atMs: onMs + Math.min(280, durMs * 0.4),
        transitionMs: 260,
        target: { vibratoDepth: midiToHz(shiftedMidi, detuneCents) * 0.02 * vibratoScale },
      });
    }

    const nextOnMs = index + 1 < notes.length ? notes[index + 1]!.beat * msPerBeat : totalMs;
    if (nextOnMs - offMs > LEGATO_GAP_MS) {
      events.push({
        atMs: offMs,
        transitionMs: index === notes.length - 1 ? 80 : 60,
        target: { voicing: 0, vibratoDepth: 0 },
      });
      if (index + 1 < notes.length && nextOnMs - offMs >= BREATH_REST_MS) {
        events.push({
          atMs: nextOnMs - 160,
          transitionMs: 60,
          target: { aspiration: 0.32 },
        });
      }
    }
    previousOffMs = offMs;
    previousMidi = shiftedMidi;
  }

  events.sort((a, b) => a.atMs - b.atMs);
  return { events, totalMs };
}

export interface VocalEnsembleOptions {
  /** 'auto' は低音ハム・高音「あ」の自動切り替え。 */
  vowel?: VocalVowel | 'auto';
  /** 主旋律の移調。既定 -12。 */
  octaveShift?: number;
  /** フォルマント倍率（声の性別・体格感）。 */
  formantScale?: number;
  /**
   * コーラス声部を足す。副旋律があればそれをユニゾン域で歌い
   * （保続ガイドライン発火時はストランドのコーラスになる）、
   * なければ主旋律のデチューン・ダブルにする。
   */
  chorus?: boolean;
}

/** アンサンブル全体のスケジュール群。UI はこれを1声ずつレンダリングして加算する。 */
export function vocalEnsembleFor(piece: Piece, options: VocalEnsembleOptions = {}): VocalScore[] {
  const shared = {
    ...(options.vowel !== undefined ? { vowel: options.vowel } : {}),
    ...(options.formantScale !== undefined ? { formantScale: options.formantScale } : {}),
  };
  const lead = vocalScoreFor(piece, {
    ...shared,
    part: 'melody',
    ...(options.octaveShift !== undefined ? { octaveShift: options.octaveShift } : {}),
  });
  if (!options.chorus) return [lead];
  const hasCounter = piece.counterMelody.some((note) => note.role !== 'ornament' && note.dur > 0);
  const chorus = hasCounter
    ? vocalScoreFor(piece, { ...shared, part: 'counter', detuneCents: 5 })
    : vocalScoreFor(piece, {
      ...shared,
      part: 'melody',
      ...(options.octaveShift !== undefined ? { octaveShift: options.octaveShift } : {}),
      detuneCents: -9,
      vibratoScale: 0.7,
    });
  return [lead, chorus];
}
