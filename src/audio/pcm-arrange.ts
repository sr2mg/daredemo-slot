/**
 * PieceをPCM(SoundFont)向けのGMノート列へ編曲し、舞台モデルで合成する。
 *
 * ミキサーの構造(パッチワーク防止の分解):
 * - パート=舞台位置(stage.ts: pan/depth/width)。リバーブ送り・プリディレイ・
 *   高域減衰・直接音の減衰は深度から**導出**する(係数の列挙をしない)
 * - スタイル=部屋(RoomModel)。RT60とダッキング量と導出則を決める
 * - 時間装置(time-layer.ts)はarrangement層のセクション計画(section.echo)が
 *   有効にした区間だけで鳴る。MIDI段エコーとオーディオ段ディレイの二重時間軸
 * - リバーブ送りは音価比例(時間マスキング則: 持続音はウェット、ランはドライ)
 * - ループ境界: 残響尾はループ区間へ巻き戻して合算し、継ぎ目を消す
 * - 主旋律の音色はセクションのleadColor(音色によるフォーム分節)でパレットから選ぶ
 */

import { arrangementSectionFor } from '../core/music/arrangement.js';
import { gridAtBeat } from '../core/music/form.js';
import { pulseBeats } from '../core/music/grid.js';
import { beatToSeconds, bpmAt, secondsToBeat, tempoMapOf } from '../core/music/tempo.js';
import type {
  LeadColorSlot,
  PcmPart,
  PcmPresetRef,
  PcmVoiceOverride,
  Piece,
} from '../core/music/types.js';
import { applyDrumBusFx } from './bus-fx.js';
import type { DrumBusFx } from './bus-fx.js';
import { duckWet, onePoleLowpass, pingPongDelay, stereoChorus, stereoReverb } from './effects.js';
import type { PcmBgmDef } from './pcm-types.js';
import { renderSf2Stems } from './sf2.js';
import type { Sf2FontStack, Sf2Note } from './sf2.js';
import { panGains, ROLE_STAGE, roomFor } from './stage.js';
import { timbreFor } from './style-timbre.js';
import {
  AUDIO_STAGE_DELAY_BEATS,
  noteStageEchoFor,
  ROLE_DELAY_SEND,
  withEchoTracks,
} from './time-layer.js';

export const SF2_SAMPLE_RATE = 44100;

/**
 * PCM音色の型は曲の保存単位(ComposeOptions.pcmVoices)と共有するため core(compose.ts)が
 * 持つ。パート語彙(PcmPart)はミックスの役割語彙(stage.ts の StageRole)と同一で、
 * 一致はテスト(sound-backends)が型レベルで検証する。
 */
export type { LeadColorSlot, PcmPart, PcmPresetRef, PcmVoiceOverride } from '../core/music/types.js';

export const PCM_PART_LABELS: Record<PcmPart, string> = {
  lead: '主旋律',
  duet: 'ハモリ',
  counter: '副旋律',
  ostinato: '分散和音',
  backing: '伴奏',
  bass: 'ベース',
  drums: 'ドラム',
};

/**
 * スタイル別のGMプログラムとドラムバス処理(bus-fx.ts)は style-timbre.ts が持つ。
 * ドラムバスの宣言のないスタイルは素通しで、既存スタイルのレンダリング結果は1サンプルも変わらない。
 */
export function drumBusFxFor(styleId: string): DrumBusFx | null {
  return timbreFor(styleId).drumBus;
}

/** GMパーカッション(bank128)のキー。ハットはopen指示でクローズ42/オープン46を使い分ける。 */
const DRUM_KEYS: Record<string, { key: number; velocity: number }> = {
  kick: { key: 36, velocity: 105 },
  snare: { key: 38, velocity: 100 },
  hat: { key: 42, velocity: 78 },
  hatOpen: { key: 46, velocity: 84 },
  tom: { key: 47, velocity: 96 },
  cymbal: { key: 49, velocity: 100 },
};

const velocityOf = (value: number | undefined): number =>
  Math.max(1, Math.min(127, Math.round(30 + (value ?? 0.75) * 97)));

/**
 * パート別の音量ヒエラルキー(ミックスの縦)。空間は stage.ts、時間は time-layer.ts。
 * ハモリのバランスはここが単独所有する(velocityは主旋律のフレージングの継承であって
 * バランス調整には使わない)。
 */
const PART_GAINS: Record<PcmPart, number> = {
  lead: 1.0,
  duet: 0.45,
  counter: 0.65,
  ostinato: 0.6,
  backing: 0.5,
  bass: 0.9,
  drums: 0.9,
};

/** パート別のノート列。音色・音量まで確定し、空間・時間処理はミキサーが担う。 */
export function arrangeSf2Parts(
  piece: Piece,
  overrides: PcmVoiceOverride = {},
): Record<PcmPart, Sf2Note[]> {
  const programs = timbreFor(piece.styleId).pcm;
  const refFor = (part: Exclude<PcmPart, 'drums' | 'duet' | 'lead'>): PcmPresetRef =>
    overrides[part] ?? { bank: 0, program: programs[part] };
  const drumRef = overrides.drums ?? { bank: 128, program: programs.drumKit ?? 0 };
  const tempo = tempoMapOf(piece);
  const toSec = (beat: number): number => beatToSeconds(tempo, beat);
  // 主旋律の音色はセクションのleadColorでパレットから選ぶ(受け渡し)。
  // 上書きは色別(leadColorVoices)が最優先で、次に全区間固定(lead)。
  const leadRefAt = (beat: number): PcmPresetRef => {
    const color = (arrangementSectionFor(piece, beat).leadColor ?? 0) as LeadColorSlot;
    return overrides.leadColorVoices?.[color]
      ?? overrides.lead
      ?? { bank: 0, program: programs.leadPalette[color % programs.leadPalette.length]! };
  };
  const noteFor = (
    event: { beat: number; dur: number; midi: number; velocity?: number; glideFrom?: number },
    ref: PcmPresetRef,
    gain: number,
  ): Sf2Note => ({
    program: ref.program,
    bank: ref.bank,
    midi: event.midi,
    velocity: velocityOf(event.velocity),
    startSec: toSec(event.beat),
    durSec: Math.max(0.03, toSec(event.beat + event.dur) - toSec(event.beat)),
    gain,
    ...(event.glideFrom !== undefined ? { glideFromMidi: event.glideFrom } : {}),
  });
  const partFor = (
    events: readonly { beat: number; dur: number; midi: number; velocity?: number; glideFrom?: number }[],
    ref: PcmPresetRef,
    gain: number,
  ): Sf2Note[] => events.map((event) => noteFor(event, ref, gain));

  const backing = refFor('backing');
  const backingNoteAt = (midi: number, beat: number, dur: number, velocity = 68): Sf2Note => ({
    program: backing.program,
    bank: backing.bank,
    midi,
    velocity,
    startSec: toSec(beat),
    durSec: Math.max(0.05, (toSec(beat + dur) - toSec(beat)) * 0.97),
    gain: PART_GAINS.backing,
  });
  const backingNotes: Sf2Note[] = [];
  // sustain テクスチャ: 同じボイシングが続く間は再打鍵せず、直前の和音の音を延ばす。
  let sustained: { startBeat: number; endBeat: number; midis: string; notes: Sf2Note[] } | null = null;
  for (const chord of piece.chords) {
    const section = arrangementSectionFor(piece, chord.beat);
    const rhythm = chord.beat >= piece.loopStartBeat ? section.backingRhythm : 'normal';
    if (rhythm === 'beat') {
      // 伴奏型 chords: 和音内の各拍頭でブロックコードを打ち、次の拍頭(和音末尾)まで鳴らす。
      const grid = gridAtBeat(piece.songPlan.form, piece.loopStartBeat, chord.beat);
      const barStart = Math.floor(chord.beat / 4) * 4;
      const pulses = pulseBeats(grid)
        .map((pulse) => barStart + pulse)
        .filter((beat) => beat >= chord.beat - 1e-6 && beat < chord.beat + chord.dur - 1e-6);
      pulses.forEach((pulse, index) => {
        const end = pulses[index + 1] ?? chord.beat + chord.dur;
        for (const midi of chord.midis) backingNotes.push(backingNoteAt(midi, pulse, end - pulse, 76));
      });
      sustained = null;
      continue;
    }
    if (rhythm === 'stab') {
      const grid = gridAtBeat(piece.songPlan.form, piece.loopStartBeat, chord.beat);
      const count = Math.round(chord.dur / grid.stepBeats);
      for (let step = 0; step < count; step++) {
        for (const midi of chord.midis) backingNotes.push(backingNoteAt(midi, chord.beat + step * grid.stepBeats, grid.stepBeats * 0.6, 84));
      }
      sustained = null;
      continue;
    }
    const midisKey = chord.midis.join(',');
    if (rhythm === 'sustain' && sustained && Math.abs(sustained.endBeat - chord.beat) < 1e-6 && sustained.midis === midisKey) {
      sustained.endBeat = chord.beat + chord.dur;
      for (const note of sustained.notes) {
        note.durSec = Math.max(0.05, (toSec(sustained.endBeat) - toSec(sustained.startBeat)) * 0.97);
      }
      continue;
    }
    const notes = chord.midis.map((midi) => backingNoteAt(midi, chord.beat, chord.dur));
    backingNotes.push(...notes);
    sustained = rhythm === 'sustain' ? { startBeat: chord.beat, endBeat: chord.beat + chord.dur, midis: midisKey, notes } : null;
  }
  const drumNotes: Sf2Note[] = [];
  for (const drum of piece.drums) {
    const open = drum.inst === 'hat' && drum.open === true;
    const mapped = open ? DRUM_KEYS['hatOpen']! : DRUM_KEYS[drum.inst];
    if (!mapped) continue;
    drumNotes.push({
      program: drumRef.program,
      bank: drumRef.bank,
      midi: mapped.key,
      // 拍節アクセント(drum-articulation.ts)はベースベロシティへの乗算で反映する。
      velocity: Math.max(1, Math.min(127, Math.round(mapped.velocity * (drum.velocity ?? 1)))),
      startSec: toSec(drum.beat),
      // オープンは鳴り残す(次のハットのexclusiveClassチョーク(sf2.ts)が裁ち落とす)。
      durSec: open ? 0.7 : 0.2,
      gain: PART_GAINS.drums,
    });
  }
  return {
    lead: piece.melody.map((event) => noteFor(event, leadRefAt(event.beat), PART_GAINS.lead)),
    // ハモリはその区間のリードと同じ音色(「連れ」は同種の音、という様式仮説)。
    duet: piece.duet.map((event) => noteFor(
      event, overrides.duet ?? leadRefAt(event.beat), PART_GAINS.duet,
    )),
    counter: partFor(piece.counterMelody, refFor('counter'), PART_GAINS.counter),
    ostinato: partFor(piece.ostinato, refFor('ostinato'), PART_GAINS.ostinato),
    backing: backingNotes,
    bass: partFor(piece.bass, refFor('bass'), PART_GAINS.bass),
    drums: drumNotes,
  };
}

export function arrangeSf2Notes(piece: Piece, overrides: PcmVoiceOverride = {}): Sf2Note[] {
  return Object.values(arrangeSf2Parts(piece, overrides)).flat();
}

/** セクション計画のsection.echoから、サンプル単位のゲート(0/1、10msスムージング)を作る。 */
function echoGateFor(piece: Piece, length: number, sampleRate: number): Float32Array {
  // セクションは拍単位でしか変わらないので、拍ごとに1回だけ引き、拍境界はテンポ写像で秒へ写す。
  const tempo = tempoMapOf(piece);
  const beatCount = Math.max(1, Math.ceil(secondsToBeat(tempo, length / sampleRate))) + 1;
  const gate = new Float32Array(length);
  const ramp = Math.max(1, Math.round(0.01 * sampleRate));
  let state = arrangementSectionFor(piece, 0.01).echo ? 1 : 0;
  let index = 0;
  for (let beat = 0; beat < beatCount && index < length; beat++) {
    const at = Math.min(beat + 0.01, Math.max(0, piece.beats - 0.001));
    const target = arrangementSectionFor(piece, at).echo ? 1 : 0;
    const end = Math.min(length, Math.round(beatToSeconds(tempo, beat + 1) * sampleRate));
    for (; index < end; index++) {
      state += (target - state) / ramp;
      gate[index] = state;
    }
  }
  for (; index < length; index++) gate[index] = state;
  return gate;
}

/**
 * PieceをSoundFontで合成し、既存プレイヤーのPCM BGM形式(ステレオ)で返す。
 * fontに配列を渡すと重ねになり、先頭に無いプリセットは後続フォントが補完する
 * (sf2.tsのSf2FontStack。部分フォント+フルGMの2台構成が典型)。
 * パート(声部)を1つ合成するごとに制御をイベントループへ返し、UIを固めない。
 */
export async function renderSf2Bgm(
  piece: Piece,
  font: Sf2FontStack,
  overrides: PcmVoiceOverride = {},
  onProgress?: (ratio: number) => void,
): Promise<PcmBgmDef> {
  // 名目 bpm の拍長は単一の遅延線(オーディオ段ディレイ・ドラムバス)だけに使う。発音位置は写像で写す。
  const spb = 60 / piece.bpm;
  const tempo = tempoMapOf(piece);
  const toSec = (beat: number): number => beatToSeconds(tempo, beat);
  const toBeat = (sec: number): number => secondsToBeat(tempo, sec);
  const room = roomFor(piece.styleId);
  const loopEndSec = toSec(piece.beats);
  const loopStartSec = toSec(piece.loopStartBeat);
  const tailSec = Math.min(3, room.rt60Sec + AUDIO_STAGE_DELAY_BEATS * spb * 2);
  const totalSec = loopEndSec + tailSec;
  const length = Math.ceil(totalSec * SF2_SAMPLE_RATE);
  const loopEndSample = Math.floor(loopEndSec * SF2_SAMPLE_RATE);
  const loopStartSample = Math.floor(loopStartSec * SF2_SAMPLE_RATE);

  const dryLeft = new Float32Array(length);
  const dryRight = new Float32Array(length);
  const dryMono = new Float32Array(length); // ダッキングの包絡源
  const reverbBus = new Float32Array(length);
  const chorusBus = new Float32Array(length);
  const delayBus = new Float32Array(length);
  const echoGate = echoGateFor(piece, length, SF2_SAMPLE_RATE);

  const parts = arrangeSf2Parts(piece, overrides);
  // タップ幅はその音の小節の格子から(区間ごとに割り方が違う曲型)。
  const echoSpecAt = (note: Sf2Note) => noteStageEchoFor(
    piece.grooveFeel,
    gridAtBeat(piece.songPlan.form, piece.loopStartBeat, toBeat(note.startSec)),
  );
  const partEntries = (Object.entries(parts) as [PcmPart, Sf2Note[]][])
    .filter(([, baseNotes]) => baseNotes.length > 0);
  let renderedParts = 0;
  for (const [part, baseNotes] of partEntries) {
    const stage = ROLE_STAGE[part];
    // MIDI段エコー: セクション計画が有効にした区間のリードだけ。タップはループへ巻き戻す。
    const notes = part === 'lead'
      ? [
        ...baseNotes.filter((note) => !arrangementSectionFor(piece, toBeat(note.startSec)).echo),
        ...withEchoTracks(
          baseNotes.filter((note) => arrangementSectionFor(piece, toBeat(note.startSec)).echo),
          echoSpecAt,
          { toSec, toBeat },
          { startSec: loopStartSec, endSec: loopEndSec },
        ),
      ]
      : baseNotes;
    // リバーブ送りは音価比例(拍長=フル、16分≈1/4)×深度導出の送り量。
    const baseSend = room.sendAt(stage.depth);
    const stems = renderSf2Stems(
      font, notes, SF2_SAMPLE_RATE, totalSec,
      baseSend > 0
        ? (note) => baseSend * Math.max(0.25, Math.min(1, note.durSec * bpmAt(tempo, toBeat(note.startSec)) / 60))
        : undefined,
    );
    // ドラムバスFX(スタイル宣言があるときだけ)。直接音のみ処理し、リバーブ送りは
    // クリーンなまま(潰した音を残響へ送るとローファイの粒が空間全体へ滲むため)。
    if (part === 'drums') {
      const busFx = drumBusFxFor(piece.styleId);
      if (busFx) applyDrumBusFx(stems.main, SF2_SAMPLE_RATE, spb, busFx);
    }
    const [gainLeft, gainRight] = panGains(stage.pan);
    const dryGain = room.dryAt(stage.depth);
    const chorusSend = stage.width * 0.5;
    const delaySend = ROLE_DELAY_SEND[part];
    // 深度由来の高域減衰を送り経路にだけ掛ける(直接音は明瞭なまま)。
    if (stems.send.length > 0) onePoleLowpass(stems.send, SF2_SAMPLE_RATE, room.dampHzAt(stage.depth));
    const preDelaySamples = Math.round((room.preDelayMsAt(stage.depth) / 1000) * SF2_SAMPLE_RATE);
    for (let i = 0; i < length; i++) {
      const sample = stems.main[i]!;
      dryLeft[i] = dryLeft[i]! + sample * gainLeft * dryGain;
      dryRight[i] = dryRight[i]! + sample * gainRight * dryGain;
      dryMono[i] = dryMono[i]! + sample;
      if (stems.send.length > 0 && i + preDelaySamples < length) {
        reverbBus[i + preDelaySamples] = reverbBus[i + preDelaySamples]! + stems.send[i]!;
      }
      if (chorusSend > 0) chorusBus[i] = chorusBus[i]! + sample * chorusSend;
      if (delaySend > 0) delayBus[i] = delayBus[i]! + sample * delaySend * echoGate[i]!;
    }
    renderedParts++;
    // 空間処理(リバーブ等)を残り1割として配分する。
    onProgress?.((renderedParts / partEntries.length) * 0.9);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const reverb = stereoReverb(reverbBus, SF2_SAMPLE_RATE, room.rt60Sec);
  duckWet(reverb, dryMono, SF2_SAMPLE_RATE, room.duckAmount);
  const chorus = stereoChorus(chorusBus, SF2_SAMPLE_RATE);
  const delay = pingPongDelay(delayBus, SF2_SAMPLE_RATE, AUDIO_STAGE_DELAY_BEATS * spb, room.delayFeedback);

  // 合算→ループ末尾の尾をループ区間へ巻き戻し→総和一箇所でソフトクリップ。
  // 巻き戻しの帰結として、初回再生でもループ入口で(まだ鳴っていない音の)残響尾が
  // 先に聞こえる。継ぎ目で尾が途切れるより知覚的害が小さい、意図した妥協。
  const sumLeft = new Float32Array(length);
  const sumRight = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    sumLeft[i] = dryLeft[i]! + reverb.left[i]! + chorus.left[i]! + delay.left[i]!;
    sumRight[i] = dryRight[i]! + reverb.right[i]! + chorus.right[i]! + delay.right[i]!;
  }
  for (let i = loopEndSample; i < length; i++) {
    const wrapped = loopStartSample + (i - loopEndSample);
    if (wrapped >= loopEndSample) break;
    sumLeft[wrapped] = sumLeft[wrapped]! + sumLeft[i]!;
    sumRight[wrapped] = sumRight[wrapped]! + sumRight[i]!;
  }
  const left = new Float32Array(loopEndSample);
  const right = new Float32Array(loopEndSample);
  for (let i = 0; i < loopEndSample; i++) {
    left[i] = Math.tanh(sumLeft[i]!);
    right[i] = Math.tanh(sumRight[i]!);
  }
  onProgress?.(1);
  return {
    kind: 'pcm',
    wave: left,
    waveRight: right,
    sampleRate: SF2_SAMPLE_RATE,
    loopStart: loopStartSec,
    loopEnd: loopEndSec,
  };
}
