import type { NesVoiceOptions, NoteEvent, Piece } from '../core/music/compose.js';
import { arrangementSectionFor, grooveBeat } from '../core/music/compose.js';

/** 日本版ファミコン（NTSC）の Ricoh 2A03 CPU クロック。 */
export const NES_CPU_CLOCK = 1_789_773;
/** OPLL と同じレートに揃え、既存プレイヤーのキャッシュ／AudioBuffer 経路を共有する。 */
export const NES_SAMPLE_RATE = 49_716;

export const NES_DUTIES = [
  { id: 0, label: '12.5%（細い）' },
  { id: 1, label: '25%（標準）' },
  { id: 2, label: '50%（矩形）' },
  { id: 3, label: '25%反転（太い）' },
] as const;

const DUTY_TABLE: readonly (readonly number[])[] = [
  [0, 1, 0, 0, 0, 0, 0, 0],
  [0, 1, 1, 0, 0, 0, 0, 0],
  [0, 1, 1, 1, 1, 0, 0, 0],
  [1, 0, 0, 1, 1, 1, 1, 1],
];

/** NTSC ノイズ・タイマーの16段階（CPUサイクル）。 */
export const NES_NOISE_PERIODS = [
  4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068,
] as const;

const midiFreq = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

export function pulseTimerForMidi(midi: number): number {
  return Math.max(8, Math.min(0x7ff, Math.round(NES_CPU_CLOCK / (16 * midiFreq(midi)) - 1)));
}

export function triangleTimerForMidi(midi: number): number {
  return Math.max(0, Math.min(0x7ff, Math.round(NES_CPU_CLOCK / (32 * midiFreq(midi)) - 1)));
}

export function pulseFrequencyForTimer(timer: number): number {
  return NES_CPU_CLOCK / (16 * (timer + 1));
}

export function triangleFrequencyForTimer(timer: number): number {
  return NES_CPU_CLOCK / (32 * (timer + 1));
}

type GateEvent = { sample: number; on: boolean; timer?: number; volume?: number; retrigger?: boolean };
type NoiseHit = { sample: number; period: number; mode: 0 | 1; volume: number; decayFrames: number };

interface PulseState {
  events: GateEvent[];
  eventIndex: number;
  enabled: boolean;
  timer: number;
  volume: number;
  step: number;
  phase: number;
  duty: 0 | 1 | 2 | 3;
}

interface TriangleState {
  events: GateEvent[];
  eventIndex: number;
  enabled: boolean;
  timer: number;
  step: number;
  phase: number;
}

const toSample = (seconds: number): number => Math.max(0, Math.round(seconds * NES_SAMPLE_RATE));

function addNoteEvents(events: GateEvent[], beat: number, dur: number, bpm: number, midi: number, volume = 15): void {
  const spb = 60 / bpm;
  events.push({ sample: toSample(beat * spb), on: true, timer: pulseTimerForMidi(midi), volume });
  events.push({ sample: toSample((beat + dur) * spb), on: false });
}

function addTriangleEvents(events: GateEvent[], beat: number, dur: number, bpm: number, midi: number): void {
  const spb = 60 / bpm;
  events.push({ sample: toSample(beat * spb), on: true, timer: triangleTimerForMidi(midi) });
  events.push({ sample: toSample((beat + dur) * spb), on: false });
}

function sortGateEvents(events: GateEvent[]): void {
  // 同時刻は key-off → key-on。次の音が前の音の終了に潰されないようにする。
  events.sort((a, b) => a.sample - b.sample || Number(a.on) - Number(b.on));
}

/** 2A03パルスのタイマーだけを細かく揺らし、再発音せず「揺り」を近似する。 */
function addShakeEvents(events: GateEvent[], note: NoteEvent, bpm: number): void {
  if (note.ornament !== 'shake') return;
  const spb = 60 / bpm;
  const baseTimer = pulseTimerForMidi(note.midi);
  let direction = 1;
  for (let offset = 0.08; offset < note.dur; offset += 0.08) {
    const cents = direction * 32;
    const timer = Math.max(8, Math.min(
      0x7ff,
      Math.round((baseTimer + 1) * 2 ** (-cents / 1200) - 1),
    ));
    events.push({
      sample: toSample((note.beat + offset) * spb), on: true, timer, retrigger: false,
    });
    direction *= -1;
  }
}

const notesOverlap = (a: NoteEvent, b: NoteEvent): boolean =>
  a.beat < b.beat + b.dur && b.beat < a.beat + a.dur;

const nesVolumeFor = (note: NoteEvent, fallback: number): number => note.velocity === undefined
  ? fallback
  : Math.max(0, Math.min(15, Math.round(note.velocity * 15)));

function clockPulse(state: PulseState): number {
  const periodSamples = (state.timer + 1) * 2 * NES_SAMPLE_RATE / NES_CPU_CLOCK;
  state.phase += 1 / periodSamples;
  while (state.phase >= 1) {
    state.phase -= 1;
    state.step = (state.step + 1) & 7;
  }
  return state.enabled ? DUTY_TABLE[state.duty]![state.step]! * state.volume : 0;
}

function clockTriangle(state: TriangleState): number {
  const periodSamples = (state.timer + 1) * NES_SAMPLE_RATE / NES_CPU_CLOCK;
  state.phase += 1 / periodSamples;
  while (state.phase >= 1) {
    state.phase -= 1;
    state.step = (state.step + 1) & 31;
  }
  // 実機の32段・4bitシーケンス: 15..0, 0..15。音量レジスタは存在しない。
  return state.enabled ? (state.step < 16 ? 15 - state.step : state.step - 16) : 0;
}

class HighPass {
  private readonly alpha: number;
  private x = 0;
  private y = 0;
  constructor(cutoff: number) {
    const rc = 1 / (2 * Math.PI * cutoff);
    const dt = 1 / NES_SAMPLE_RATE;
    this.alpha = rc / (rc + dt);
  }
  step(x: number): number {
    this.y = this.alpha * (this.y + x - this.x);
    this.x = x;
    return this.y;
  }
}

class LowPass {
  private readonly alpha: number;
  private y = 0;
  constructor(cutoff: number) {
    const rc = 1 / (2 * Math.PI * cutoff);
    const dt = 1 / NES_SAMPLE_RATE;
    this.alpha = dt / (rc + dt);
  }
  step(x: number): number {
    this.y += this.alpha * (x - this.y);
    return this.y;
  }
}

function pulseOutput(p1: number, p2: number): number {
  const sum = p1 + p2;
  return sum === 0 ? 0 : 95.88 / (8128 / sum + 100);
}

function tndOutput(triangle: number, noise: number, dmc = 0): number {
  const input = triangle / 8227 + noise / 12241 + dmc / 22638;
  return input === 0 ? 0 : 159.79 / (1 / input + 100);
}

/**
 * Piece を標準2A03のチャンネル予算へ落としてPCM化する。
 * pulse1=主旋律 / pulse2=単音伴奏 / triangle=ベース / noise=ドラム。
 * DMCは初版では常に0（未使用）。拡張音源・リバーブ・任意波形は使わない。
 */
export function renderNesPiece(piece: Piece, options: NesVoiceOptions = {}): Float32Array {
  const duration = piece.beats * 60 / piece.bpm;
  const length = Math.max(1, toSample(duration));
  const pulse1Events: GateEvent[] = [];
  const pulse2Events: GateEvent[] = [];
  const triangleEvents: GateEvent[] = [];
  const noiseHits: NoiseHit[] = [];

  for (const n of piece.melody) {
    const strong = n.beat % 4 === 0 || n.beat % 4 === 2;
    addNoteEvents(
      pulse1Events, n.beat, n.dur, piece.bpm, n.midi,
      nesVolumeFor(n, strong ? 15 : 11),
    );
    addShakeEvents(pulse1Events, n, piece.bpm);
  }
  const chordBacking: (NoteEvent & { volume: number })[] = [];
  for (const chord of piece.chords) {
    const third = chord.midis[1] ?? chord.midis[0]!;
    const fifth = chord.midis[2] ?? third;
    for (let beat = 0; beat + 0.5 < chord.dur - 0.001; beat++) {
      const absoluteBeat = grooveBeat(chord.beat + beat + 0.5, piece.grooveFeel);
      const sectionPlan = arrangementSectionFor(piece, absoluteBeat);
      const thin = absoluteBeat < piece.loopStartBeat || sectionPlan.backingDensity === 'sparse';
      // sparse区間はパルス2の裏打ちを半分にし、full区間では毎拍鳴らす。
      if (thin && beat % 2 === 0) continue;
      chordBacking.push({
        beat: absoluteBeat,
        dur: 0.2,
        midi: beat % 2 === 0 ? third : fifth,
        volume: thin ? 5 : 7,
      });
    }
  }
  const counter = piece.counterMelody ?? [];
  for (const n of chordBacking.filter((note) => !counter.some((response) => notesOverlap(note, response)))) {
    addNoteEvents(pulse2Events, n.beat, n.dur, piece.bpm, n.midi, n.volume);
  }
  for (const n of counter) {
    addNoteEvents(pulse2Events, n.beat, n.dur, piece.bpm, n.midi, nesVolumeFor(n, 11));
  }
  for (const n of piece.bass) addTriangleEvents(triangleEvents, n.beat, n.dur, piece.bpm, n.midi);
  sortGateEvents(pulse1Events);
  sortGateEvents(pulse2Events);
  sortGateEvents(triangleEvents);

  const spb = 60 / piece.bpm;
  for (const d of piece.drums) {
    const sample = toSample(d.beat * spb);
    if (d.inst === 'kick') noiseHits.push({ sample, period: 14, mode: 1, volume: 15, decayFrames: 3 });
    else if (d.inst === 'snare') noiseHits.push({ sample, period: 8, mode: 0, volume: 13, decayFrames: 2 });
    else if (d.inst === 'tom') noiseHits.push({ sample, period: 11, mode: 1, volume: 12, decayFrames: 3 });
    else if (d.inst === 'cymbal') noiseHits.push({ sample, period: 2, mode: 0, volume: 11, decayFrames: 4 });
    else noiseHits.push({ sample, period: 3, mode: 0, volume: 7, decayFrames: 1 });
  }
  noiseHits.sort((a, b) => a.sample - b.sample);

  const pulse1: PulseState = {
    events: pulse1Events, eventIndex: 0, enabled: false, timer: 0, volume: 0, step: 0, phase: 0,
    duty: options.pulse1Duty ?? 1,
  };
  const pulse2: PulseState = {
    events: pulse2Events, eventIndex: 0, enabled: false, timer: 0, volume: 0, step: 0, phase: 0,
    duty: options.pulse2Duty ?? 2,
  };
  const triangle: TriangleState = {
    events: triangleEvents, eventIndex: 0, enabled: false, timer: 0, step: 0, phase: 0,
  };

  let lfsr = 1;
  let noisePhase = 0;
  let noiseIndex = 0;
  let currentNoise: NoiseHit | null = null;
  const hp90 = new HighPass(90);
  const hp440 = new HighPass(440);
  const lp14k = new LowPass(14_000);
  const out = new Float32Array(length);

  const applyEvents = (state: PulseState | TriangleState, sample: number): void => {
    while (state.eventIndex < state.events.length && state.events[state.eventIndex]!.sample <= sample) {
      const event = state.events[state.eventIndex++]!;
      state.enabled = event.on;
      if (event.timer !== undefined) state.timer = event.timer;
      if ('volume' in state && event.volume !== undefined) state.volume = event.volume;
      if (event.on && event.retrigger !== false) {
        state.step = 0;
        state.phase = 0;
      }
    }
  };

  for (let i = 0; i < length; i++) {
    applyEvents(pulse1, i);
    applyEvents(pulse2, i);
    applyEvents(triangle, i);
    while (noiseIndex < noiseHits.length && noiseHits[noiseIndex]!.sample <= i) currentNoise = noiseHits[noiseIndex++]!;

    const p1 = clockPulse(pulse1);
    const p2 = clockPulse(pulse2);
    const tri = clockTriangle(triangle);
    let noise = 0;
    if (currentNoise) {
      const elapsed = i - currentNoise.sample;
      const envelopeStep = Math.floor(elapsed * 240 / NES_SAMPLE_RATE / currentNoise.decayFrames);
      const volume = Math.max(0, currentNoise.volume - envelopeStep);
      if (volume > 0) {
        noisePhase += NES_CPU_CLOCK / NES_NOISE_PERIODS[currentNoise.period]! / NES_SAMPLE_RATE;
        while (noisePhase >= 1) {
          noisePhase -= 1;
          const tap = currentNoise.mode === 1 ? 6 : 1;
          const feedback = (lfsr & 1) ^ ((lfsr >> tap) & 1);
          lfsr = (lfsr >> 1) | (feedback << 14);
        }
        noise = (lfsr & 1) === 0 ? volume : 0;
      }
    }

    const mixed = pulseOutput(p1, p2) + tndOutput(tri, noise);
    out[i] = Math.max(-1, Math.min(1, lp14k.step(hp440.step(hp90.step(mixed))) * 2.2));
  }
  return out;
}
