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

import { arrangementSectionFor } from '../core/music/compose.js';
import type {
  LeadColorSlot,
  PcmPart,
  PcmPresetRef,
  PcmVoiceOverride,
  Piece,
} from '../core/music/compose.js';
import { duckWet, onePoleLowpass, pingPongDelay, stereoChorus, stereoReverb } from './effects.js';
import type { PcmBgmDef } from './pcm-types.js';
import { renderSf2Stems } from './sf2.js';
import type { Sf2FontStack, Sf2Note } from './sf2.js';
import { panGains, ROLE_STAGE, roomFor } from './stage.js';
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
export type { LeadColorSlot, PcmPart, PcmPresetRef, PcmVoiceOverride } from '../core/music/compose.js';

export const PCM_PART_LABELS: Record<PcmPart, string> = {
  lead: '主旋律',
  duet: 'ハモリ',
  counter: '副旋律',
  ostinato: '分散和音',
  backing: '伴奏',
  bass: 'ベース',
  drums: 'ドラム',
};

interface GmProgramMap {
  /** 主旋律の音色パレット。leadColor(セクションの受け渡し計画)が添字になる。 */
  leadPalette: readonly number[];
  counter: number;
  ostinato: number;
  backing: number;
  bass: number;
}

/** スタイル別GMプログラム(0基点)。kmmoのパレットは四千年型の受け渡し(二胡系→笛→弦)。 */
const STYLE_PROGRAMS: Record<string, GmProgramMap> = {
  kmmo: { leadPalette: [110, 73, 48], counter: 73, ostinato: 46, backing: 48, bass: 33 },
  eurobeat: { leadPalette: [81, 80], counter: 80, ostinato: 4, backing: 50, bass: 38 },
  rock: { leadPalette: [30, 29], counter: 29, ostinato: 27, backing: 17, bass: 33 },
  ska: { leadPalette: [56, 66], counter: 66, ostinato: 26, backing: 16, bass: 33 },
};
const DEFAULT_PROGRAMS: GmProgramMap = {
  leadPalette: [0], counter: 73, ostinato: 46, backing: 48, bass: 33,
};

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
  const programs = STYLE_PROGRAMS[piece.styleId] ?? DEFAULT_PROGRAMS;
  const refFor = (part: Exclude<PcmPart, 'drums' | 'duet' | 'lead'>): PcmPresetRef =>
    overrides[part] ?? { bank: 0, program: programs[part] };
  const drumRef = overrides.drums ?? { bank: 128, program: 0 };
  const spb = 60 / piece.bpm;
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
    startSec: event.beat * spb,
    durSec: Math.max(0.03, event.dur * spb),
    gain,
    ...(event.glideFrom !== undefined ? { glideFromMidi: event.glideFrom } : {}),
  });
  const partFor = (
    events: readonly { beat: number; dur: number; midi: number; velocity?: number; glideFrom?: number }[],
    ref: PcmPresetRef,
    gain: number,
  ): Sf2Note[] => events.map((event) => noteFor(event, ref, gain));

  const backing = refFor('backing');
  const backingNotes: Sf2Note[] = piece.chords.flatMap((chord) => chord.midis.map((midi) => ({
    program: backing.program,
    bank: backing.bank,
    midi,
    velocity: 68,
    startSec: chord.beat * spb,
    durSec: Math.max(0.05, chord.dur * spb * 0.97),
    gain: PART_GAINS.backing,
  })));
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
      startSec: drum.beat * spb,
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
function echoGateFor(piece: Piece, length: number, sampleRate: number, spb: number): Float32Array {
  // セクションは拍単位でしか変わらないので、拍ごとに1回だけ引いてキャッシュする。
  const beatCount = Math.ceil(length / sampleRate / spb) + 1;
  const echoAtBeat = new Uint8Array(beatCount);
  for (let beat = 0; beat < beatCount; beat++) {
    const at = Math.min(beat + 0.01, Math.max(0, piece.beats - 0.001));
    echoAtBeat[beat] = arrangementSectionFor(piece, at).echo ? 1 : 0;
  }
  const gate = new Float32Array(length);
  const samplesPerBeat = sampleRate * spb;
  const ramp = Math.max(1, Math.round(0.01 * sampleRate));
  let state = echoAtBeat[0]!;
  for (let i = 0; i < length; i++) {
    const target = echoAtBeat[Math.min(beatCount - 1, Math.floor(i / samplesPerBeat))]!;
    state += (target - state) / ramp;
    gate[i] = state;
  }
  return gate;
}

/**
 * PieceをSoundFontで合成し、既存プレイヤーのPCM BGM形式(ステレオ)で返す。
 * fontに配列を渡すと重ねになり、先頭に無いプリセットは後続フォントが補完する
 * (sf2.tsのSf2FontStack。部分フォント+フルGMの2台構成が典型)。
 */
export function renderSf2Bgm(
  piece: Piece,
  font: Sf2FontStack,
  overrides: PcmVoiceOverride = {},
): PcmBgmDef {
  const spb = 60 / piece.bpm;
  const room = roomFor(piece.styleId);
  const loopEndSec = piece.beats * spb;
  const loopStartSec = piece.loopStartBeat * spb;
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
  const echoGate = echoGateFor(piece, length, SF2_SAMPLE_RATE, spb);

  const parts = arrangeSf2Parts(piece, overrides);
  const echoSpec = noteStageEchoFor(piece.grooveFeel);
  for (const [part, baseNotes] of Object.entries(parts) as [PcmPart, Sf2Note[]][]) {
    if (baseNotes.length === 0) continue;
    const stage = ROLE_STAGE[part];
    // MIDI段エコー: セクション計画が有効にした区間のリードだけ。タップはループへ巻き戻す。
    const notes = part === 'lead'
      ? [
        ...baseNotes.filter((note) => !arrangementSectionFor(piece, note.startSec / spb).echo),
        ...withEchoTracks(
          baseNotes.filter((note) => arrangementSectionFor(piece, note.startSec / spb).echo),
          echoSpec,
          spb,
          { startSec: loopStartSec, endSec: loopEndSec },
        ),
      ]
      : baseNotes;
    // リバーブ送りは音価比例(拍長=フル、16分≈1/4)×深度導出の送り量。
    const baseSend = room.sendAt(stage.depth);
    const stems = renderSf2Stems(
      font, notes, SF2_SAMPLE_RATE, totalSec,
      baseSend > 0
        ? (note) => baseSend * Math.max(0.25, Math.min(1, note.durSec / spb))
        : undefined,
    );
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
  return {
    kind: 'pcm',
    wave: left,
    waveRight: right,
    sampleRate: SF2_SAMPLE_RATE,
    loopStart: loopStartSec,
    loopEnd: loopEndSec,
  };
}
