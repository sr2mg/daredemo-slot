import type {
  ArrangementSectionPlan, NoteEvent, Piece, VoiceOverride,
} from '../core/music/compose.js';
import { grooveBeat } from '../core/music/compose.js';
import { initRhythmMode } from './mml.js';
import { SeqBuilder } from './opll-core.js';
import type { SfxDef } from './opll-core.js';

/** 編曲済み BGM（レジスタ列 + ループ検算用のメタ） */
export interface ArrangedBgm extends SfxDef {
  bpm: number;
  /** ループ本体の4/4換算小節数（イントロを含めない） */
  bars: number;
  /** AudioBufferSourceNode に渡す、初回イントロ後のループ区間（秒）。 */
  loopStart: number;
  loopEnd: number;
}

/**
 * 作曲エンジンの Piece を OPLL（YM2413）のレジスタシーケンスへ編曲するコンバータ。
 * エフェクター無しの当時技術だけで音を太くする:
 * - アクセント     = 音量レジスタ（強拍を 1 段大きく）。4bit 音量は 80 年代打ち込みの基本
 * - チャンネルエコー = 空き ch5 にメロディを 8 分遅れ・小音量で複製（ロックマン式）。
 *                     ループ境界を跨ぐぶんは頭に折り返す（トラッカーのループと同じ挙動）
 * - ビブラート     = 長い音符だけ F ナンバーを毎フレーム書き換えるソフトウェアベンド
 * - FM 音色        = スタイルごとに内蔵音色を割り当て（エンベロープの時間変化はチップが持つ）
 *
 * チャンネル予算は内蔵曲（bgm.ts）と同じ: 効果音 ch0-1 / リード ch2 / バッキング ch3 /
 * ベース ch4 / エコー ch5 / リズム ch6-8。
 */

const CH_LEAD = 2;
const CH_BACKING = 3;
const CH_BASS = 4;
const CH_ECHO = 5;

/** 音量（0=最大〜15=最小）: 強拍リード / 弱拍リード / エコー / バッキング / ベース */
const VOL_LEAD_STRONG = 2;
const VOL_LEAD_WEAK = 4;
const VOL_ECHO = 7;
const VOL_BACKING = 7;
const VOL_BACKING_THIN = 9;
const VOL_COUNTER = 5;
const VOL_BASS = 2;

interface BackingNote extends NoteEvent {
  volume: number;
}

const volumeFor = (note: NoteEvent, fallback: number): number => note.velocity === undefined
  ? fallback
  : Math.max(0, Math.min(15, Math.round(12 - note.velocity * 11)));

function sectionPlanAt(piece: Piece, beat: number): ArrangementSectionPlan | null {
  if (beat < piece.loopStartBeat) return null;
  const bodyBeat = beat - piece.loopStartBeat;
  return piece.bars === 16 && bodyBeat >= 8 * 4
    ? piece.arrangementPlan.sectionB
    : piece.arrangementPlan.sectionA;
}

/** 単音チャンネル上で、副旋律が鳴る区間だけコード伴奏を切り分ける。 */
function makeRoomForCounter(note: BackingNote, counter: readonly NoteEvent[]): BackingNote[] {
  let segments = [note];
  for (const response of counter) {
    const windowStart = response.beat - 0.03;
    const windowEnd = response.beat + response.dur + 0.03;
    segments = segments.flatMap((segment) => {
      const start = segment.beat;
      const end = segment.beat + segment.dur;
      if (end <= windowStart || start >= windowEnd) return [segment];
      const split: BackingNote[] = [];
      if (windowStart - start >= 0.1) split.push({ ...segment, dur: windowStart - start });
      if (end - windowEnd >= 0.1) split.push({ ...segment, beat: windowEnd, dur: end - windowEnd });
      return split;
    });
  }
  return segments;
}

export interface StyleVoices {
  lead: number;
  backing: number;
  bass: number;
  /** バッキングの刻み: offbeat = 裏打ち 8 分 / half = 2 分音符サステイン */
  backingPattern: 'offbeat' | 'half';
}

/** スタイル → 内蔵音色の割り当て（1〜15。opll-core.ts の OPLL_VOICES 参照） */
const STYLE_VOICES: Record<string, StyleVoices> = {
  eurobeat: { lead: 4, backing: 8, bass: 8, backingPattern: 'offbeat' }, // フルート/オルガン/オルガン
  rock: { lead: 4, backing: 15, bass: 8, backingPattern: 'half' }, // フルート/Eギター/オルガン
  ska: { lead: 4, backing: 8, bass: 8, backingPattern: 'offbeat' }, // フルート/オルガン/オルガン
};
const DEFAULT_VOICES: StyleVoices = STYLE_VOICES['eurobeat']!;

/** スタイルの既定音色（UI の「スタイル既定（○○）」表示用） */
export function defaultVoicesFor(styleId: string): StyleVoices {
  return STYLE_VOICES[styleId] ?? DEFAULT_VOICES;
}

/** 上書きから有効な音色（内蔵 1〜15）だけ拾う。undefined でスタイル既定を潰さないため */
function pickVoices(override?: VoiceOverride): Partial<StyleVoices> {
  const out: Partial<StyleVoices> = {};
  for (const part of ['lead', 'backing', 'bass'] as const) {
    const v = override?.[part];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 15) out[part] = v;
  }
  return out;
}

const midiFreq = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

const DRUM_BITS: Record<string, number> = { kick: 0x10, snare: 0x08, hat: 0x01 };

/** ソフトウェアビブラートを掛ける最短音価（拍）と、深さ・速さ */
const VIBRATO_MIN_BEATS = 1;
const VIBRATO_DEPTH_CENTS = 10;
const VIBRATO_HZ = 5.5;
const VIBRATO_DELAY_RATIO = 0.3; // 音の頭はまっすぐ、途中から揺らす（歌と同じ）

export function arrangePiece(piece: Piece, styleId: string, override?: VoiceOverride): ArrangedBgm {
  // 音色だけ曲単位で差し替えられる（刻み・ドラムはスタイルのまま）。エコーはリードに追従
  const voices = { ...(STYLE_VOICES[styleId] ?? DEFAULT_VOICES), ...pickVoices(override) };
  const spb = 60 / piece.bpm;
  const duration = piece.beats * spb;
  const loopStart = piece.loopStartBeat * spb;
  const echoDelay = spb * (piece.grooveFeel === 'bounce' ? 2 / 3 : 1 / 2);
  const b = new SeqBuilder();

  // --- リード（ch2）: アクセント + 長音ビブラート。エコー（ch5）は同じ列を遅れて複製 ---
  for (const n of piece.melody) {
    const t = n.beat * spb;
    const dur = n.dur * spb;
    const inBar = n.beat % 4;
    const fallbackVol = inBar === 0 || inBar === 2 ? VOL_LEAD_STRONG : VOL_LEAD_WEAK;
    const vol = volumeFor(n, fallbackVol);
    const freq = midiFreq(n.midi);
    b.keyOn(CH_LEAD, voices.lead, vol, freq, t);
    if (n.ornament === 'shake' || (n.articulation !== 'staccato' && n.dur >= VIBRATO_MIN_BEATS)) {
      // F ナンバーの毎フレーム書き換えによる揺れ（当時のドライバの常套手段）
      const isShake = n.ornament === 'shake';
      const from = isShake ? t : t + dur * VIBRATO_DELAY_RATIO;
      const depth = isShake ? 32 : VIBRATO_DEPTH_CENTS;
      const hz = isShake ? 8.5 : VIBRATO_HZ;
      for (let vt = from; vt < t + dur; vt += isShake ? 0.018 : 0.025) {
        const cents = depth * Math.sin(2 * Math.PI * hz * (vt - from));
        b.pitch(CH_LEAD, freq * 2 ** (cents / 1200), vt);
      }
    }
    b.keyOff(CH_LEAD, t + dur);

    // エコーの出入りもA→Bの編成設計に従う。イントロは常にドライ。
    if (!sectionPlanAt(piece, n.beat)?.echo) continue;

    // チャンネルエコー: ループ境界を跨ぐ音はイントロではなくAの頭へ折り返す
    let echoT = t + echoDelay;
    if (echoT + dur > duration) {
      echoT = echoT >= duration ? loopStart + echoT - duration : echoT; // 開始が境界を越えたら折り返し
      if (echoT + dur > duration) {
        // 開始は境界内で終わりだけはみ出す音: 境界で切る（ループ先頭の音を邪魔しない）
        b.keyOn(CH_ECHO, voices.lead, Math.max(VOL_ECHO, vol + 3), freq, echoT);
        b.keyOff(CH_ECHO, duration - 0.005);
        continue;
      }
    }
    b.keyOn(CH_ECHO, voices.lead, Math.max(VOL_ECHO, vol + 3), freq, echoT);
    b.keyOff(CH_ECHO, echoT + dur);
  }

  // --- バッキング（ch3）: コード伴奏の隙間へ副旋律を差し込む ---
  const chordBacking: BackingNote[] = [];
  for (const c of piece.chords) {
    // compose側で声部進行済み。中央2声を保ったまま交互に鳴らす。
    const lowerVoice = c.midis[1] ?? c.midis[0]!;
    const upperVoice = c.midis[2] ?? lowerVoice;
    const sectionPlan = sectionPlanAt(piece, c.beat);
    const thin = sectionPlan === null || sectionPlan.backingDensity === 'sparse';
    const backingVolume = thin ? VOL_BACKING_THIN : VOL_BACKING;
    if (voices.backingPattern === 'offbeat') {
      // 裏打ち8分（スカ/ユーロの刻み）。滑らかにつないだ中央2声を交互に
      for (let beat = 0; beat < c.dur; beat++) {
        // イントロ/Aは半分だけ、Bでは毎拍鳴らして密度差を作る。
        if (thin && beat % 2 === 0) continue;
        chordBacking.push({
          beat: grooveBeat(c.beat + beat + 0.5, piece.grooveFeel),
          dur: 0.2,
          midi: beat % 2 === 0 ? lowerVoice : upperVoice,
          volume: backingVolume,
        });
      }
    } else {
      // 2 分音符サステイン（ロックの白玉）
      for (let beat = 0; beat < c.dur; beat += 2) {
        // Aは各コードの頭だけ。Bで2分音符の白玉を全面に戻す。
        if (thin && beat > 0) continue;
        const len = Math.min(2, c.dur - beat);
        chordBacking.push({ beat: c.beat + beat, dur: len * 0.75, midi: lowerVoice, volume: backingVolume });
      }
    }
  }
  const counter = piece.counterMelody ?? [];
  const backingNotes = [
    ...chordBacking.flatMap((note) => makeRoomForCounter(note, counter)),
    ...counter.map((note) => ({ ...note, volume: volumeFor(note, VOL_COUNTER) })),
  ].sort((a, b) => a.beat - b.beat);
  for (const n of backingNotes) {
    const t = n.beat * spb;
    b.keyOn(CH_BACKING, voices.backing, n.volume, midiFreq(n.midi), t);
    b.keyOff(CH_BACKING, t + n.dur * spb);
  }

  // --- ベース（ch4）: compose 済みのラインをそのまま ---
  for (const n of piece.bass) {
    const t = n.beat * spb;
    b.keyOn(CH_BASS, voices.bass, volumeFor(n, VOL_BASS), midiFreq(n.midi), t);
    b.keyOff(CH_BASS, t + n.dur * spb);
  }

  // --- リズム（ch6-8）: 同時刻の打点はビットを合成して 1 回で叩く ---
  initRhythmMode(b);
  const hits = new Map<number, number>();
  for (const d of piece.drums) {
    const t = d.beat * spb;
    hits.set(t, (hits.get(t) ?? 0) | (DRUM_BITS[d.inst] ?? 0));
  }
  for (const [t, bits] of hits) {
    // キービットの 0→1 遷移でリトリガーされるので、一度クリアしてから叩く
    b.raw(0x0e, 0x20, t);
    b.raw(0x0e, 0x20 | bits, t + 0.004);
  }

  return { bpm: piece.bpm, bars: piece.bars, loopStart, loopEnd: duration, duration, events: b.events };
}
