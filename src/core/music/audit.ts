/**
 * 曲の一括監査（聴かない層のファジング・プロファイル）。
 *
 * - auditPieceInvariants: 1曲がどのシード・進行・戦略でも破ってはならない不変条件。
 *   破れは「聴いたら壊れている」系の退化を意味するため、ファズテストでゼロを強制する。
 * - profilePieces: エンジンの表現レンジ（何をやり、何を一度もやらないか）の定点観測。
 *   数値の変化は良し悪しではなく「表現が動いた」ことを聴かずに確認するための指標。
 *
 * 2026-07 の初回監査（168曲）: 不変条件違反0件。表現レンジの穴として
 * ロングトーン皆無・音域固定・裏拍シンコペ皆無・休符始まり皆無・標準語法の装飾休眠を検出。
 */
import type { Piece } from './compose.js';

export interface AuditAnomaly {
  kind:
    | 'melody-empty'
    | 'melody-silence'
    | 'melody-degenerate-pcs'
    | 'melody-copy-run'
    | 'bass-empty'
    | 'drums-empty'
    | 'unison-collision'
    | 'voice-crossing';
  detail: string;
}

/** ループ本体の構造音（装飾を除く主旋律）を拍順で返す。 */
function structuralMelody(piece: Piece) {
  return piece.melody
    .filter((note) => note.role !== 'ornament' && note.beat >= piece.loopStartBeat)
    .sort((a, b) => a.beat - b.beat);
}

export function auditPieceInvariants(piece: Piece): AuditAnomaly[] {
  const anomalies: AuditAnomaly[] = [];
  const structural = structuralMelody(piece);
  if (structural.length === 0) {
    return [{ kind: 'melody-empty', detail: 'ループ本体に構造音がない' }];
  }

  // 2小節（8拍）を超える完全な旋律不在は、意図した「間」を超えた欠落として扱う
  let maxGap = structural[0]!.beat - piece.loopStartBeat;
  for (let index = 1; index < structural.length; index++) {
    const prev = structural[index - 1]!;
    maxGap = Math.max(maxGap, structural[index]!.beat - (prev.beat + prev.dur));
  }
  const last = structural[structural.length - 1]!;
  maxGap = Math.max(maxGap, piece.beats - (last.beat + last.dur));
  if (maxGap > 8) {
    anomalies.push({ kind: 'melody-silence', detail: `最大${maxGap.toFixed(1)}拍の旋律不在` });
  }

  const pcs = new Set(structural.map((note) => note.midi % 12));
  if (pcs.size <= 3) {
    anomalies.push({ kind: 'melody-degenerate-pcs', detail: `使用ピッチクラス数=${pcs.size}` });
  }

  // 同一内容の小節が5小節以上連続するコピペ退化
  const barKey = (bar: number): string => structural
    .filter((note) => (
      note.beat >= piece.loopStartBeat + bar * 4 && note.beat < piece.loopStartBeat + (bar + 1) * 4
    ))
    .map((note) => `${(note.beat - piece.loopStartBeat) % 4}:${note.dur}:${note.midi % 12}`)
    .join(',');
  let run = 1;
  for (let bar = 1; bar < piece.bars; bar++) {
    run = barKey(bar) !== '' && barKey(bar) === barKey(bar - 1) ? run + 1 : 1;
    if (run >= 5) {
      anomalies.push({ kind: 'melody-copy-run', detail: `同一小節が${run}連続（bar ${bar - run + 2}〜）` });
      break;
    }
  }

  if (piece.bass.length === 0) anomalies.push({ kind: 'bass-empty', detail: 'ベースが完全に無い' });
  if (piece.drums.length === 0) anomalies.push({ kind: 'drums-empty', detail: 'ドラムが完全に無い' });

  // 主旋律と副旋律が同じ音を同時に発音し続ける（意図しない完全ユニゾン化）
  let unisonOverlap = 0;
  for (const counter of piece.counterMelody) {
    for (const note of structural) {
      if (
        note.midi === counter.midi
        && note.beat < counter.beat + counter.dur
        && counter.beat < note.beat + note.dur
      ) unisonOverlap++;
    }
  }
  if (unisonOverlap > 4) {
    anomalies.push({ kind: 'unison-collision', detail: `主旋律と副旋律の同音重複${unisonOverlap}回` });
  }

  // ベースが主旋律の上へ出る声部交差
  const bassAbove = piece.bass.filter((bassNote) => structural.some((note) => (
    note.beat < bassNote.beat + bassNote.dur
    && bassNote.beat < note.beat + note.dur
    && bassNote.midi > note.midi
  ))).length;
  if (bassAbove > 0) {
    anomalies.push({ kind: 'voice-crossing', detail: `ベースが旋律の上に${bassAbove}音` });
  }

  return anomalies;
}

export interface ExpressionProfile {
  pieces: number;
  melodyNotes: number;
  /** 2拍以上の保続音の総数。ロングトーン装置の発火を聴かずに観測する。 */
  longNotes: number;
  durMax: number;
  velocityMin: number;
  velocityMax: number;
  pitchLo: number;
  pitchHi: number;
  /** 隣接音程が2半音以内の割合（0..1, 3桁丸め）。 */
  stepRatio: number;
  /** 7半音超の跳躍の割合（0..1, 3桁丸め）。 */
  wideLeapRatio: number;
  /** 16分裏拍で発音する構造音の割合（0..1, 3桁丸め）。 */
  offbeat16thRatio: number;
  /** ループ頭（1拍目）に構造音が無い曲の数。休符始まり装置の観測。 */
  restStartPieces: number;
  ornamentNotes: number;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export function profilePieces(pieces: readonly Piece[]): ExpressionProfile {
  const profile = {
    pieces: pieces.length,
    melodyNotes: 0,
    longNotes: 0,
    durMax: 0,
    velocityMin: Infinity,
    velocityMax: -Infinity,
    pitchLo: Infinity,
    pitchHi: -Infinity,
    steps: 0,
    wideLeaps: 0,
    intervals: 0,
    offbeat16th: 0,
    restStartPieces: 0,
    ornamentNotes: 0,
  };
  for (const piece of pieces) {
    const structural = structuralMelody(piece);
    profile.ornamentNotes += piece.melody.filter((note) => note.role === 'ornament').length;
    if (!structural.some((note) => note.beat === piece.loopStartBeat)) profile.restStartPieces++;
    for (let index = 0; index < structural.length; index++) {
      const note = structural[index]!;
      profile.melodyNotes++;
      if (note.dur >= 2) profile.longNotes++;
      profile.durMax = Math.max(profile.durMax, note.dur);
      if (note.velocity !== undefined) {
        profile.velocityMin = Math.min(profile.velocityMin, note.velocity);
        profile.velocityMax = Math.max(profile.velocityMax, note.velocity);
      }
      profile.pitchLo = Math.min(profile.pitchLo, note.midi);
      profile.pitchHi = Math.max(profile.pitchHi, note.midi);
      const phase = ((note.beat % 1) + 1) % 1;
      if (Math.abs(phase - 0.25) < 0.01 || Math.abs(phase - 0.75) < 0.01) profile.offbeat16th++;
      if (index > 0) {
        const interval = Math.abs(note.midi - structural[index - 1]!.midi);
        profile.intervals++;
        if (interval <= 2) profile.steps++;
        if (interval > 7) profile.wideLeaps++;
      }
    }
  }
  return {
    pieces: profile.pieces,
    melodyNotes: profile.melodyNotes,
    longNotes: profile.longNotes,
    durMax: round3(profile.durMax),
    velocityMin: round3(profile.velocityMin),
    velocityMax: round3(profile.velocityMax),
    pitchLo: profile.pitchLo,
    pitchHi: profile.pitchHi,
    stepRatio: round3(profile.steps / Math.max(1, profile.intervals)),
    wideLeapRatio: round3(profile.wideLeaps / Math.max(1, profile.intervals)),
    offbeat16thRatio: round3(profile.offbeat16th / Math.max(1, profile.melodyNotes)),
    restStartPieces: profile.restStartPieces,
    ornamentNotes: profile.ornamentNotes,
  };
}
