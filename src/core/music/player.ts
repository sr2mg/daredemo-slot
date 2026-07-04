/**
 * Web Audio による Piece 再生（依存ライブラリなし・チップチューン風音色）。
 * - メロディ = 矩形波 / ベース = 三角波 / パッド = 三角波の和音 / ドラム = ノイズ + サイン
 * - ループは先読みスケジューラで境界を跨いで予約する（setInterval の揺れの影響を受けない）
 * - AudioContext は 1 個を使い回し、停止はマスターゲインの切断で行う
 */

import type { Piece } from './compose.js';

const LOOKAHEAD_SEC = 0.3;
const TICK_MS = 100;

const midiFreq = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

export class MusicPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private volume = 0.5;

  get playing(): boolean {
    return this.timer !== null;
  }

  /** マスター音量 0..1。再生中でも即座に反映される */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  /**
   * piece を再生。loop=false のときは 1 周で自動停止し onEnd を呼ぶ。
   * delaySec はファンファーレ後に BGM をインさせる用途（SfxPlayer.playBgm と同じ意味）
   */
  play(piece: Piece, opts: { loop?: boolean; onEnd?: () => void; delaySec?: number } = {}): void {
    const { loop = false, onEnd, delaySec = 0 } = opts;
    this.stop();
    const ctx = (this.ctx ??= new AudioContext());
    void ctx.resume(); // ユーザー操作起点なら再開できる
    const master = ctx.createGain();
    master.gain.value = this.volume;
    master.connect(ctx.destination);
    this.master = master;

    const secPerBeat = 60 / piece.bpm;
    const durSec = piece.beats * secPerBeat;
    let nextStart = ctx.currentTime + 0.05 + delaySec;
    this.scheduleIteration(piece, nextStart, secPerBeat);
    nextStart += durSec;

    this.timer = setInterval(() => {
      if (!this.ctx) return;
      if (loop) {
        if (this.ctx.currentTime > nextStart - LOOKAHEAD_SEC) {
          this.scheduleIteration(piece, nextStart, secPerBeat);
          nextStart += durSec;
        }
      } else if (this.ctx.currentTime >= nextStart) {
        this.stop();
        onEnd?.();
      }
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.master && this.ctx) {
      // クリックノイズを避けて短くフェードアウトしてから切断
      const m = this.master;
      m.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
      setTimeout(() => m.disconnect(), 200);
      this.master = null;
    }
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }

  private scheduleIteration(piece: Piece, start: number, secPerBeat: number): void {
    for (const n of piece.melody) {
      this.tone('square', n.midi, start + n.beat * secPerBeat, n.dur * secPerBeat, 0.13);
    }
    for (const n of piece.bass) {
      this.tone('triangle', n.midi, start + n.beat * secPerBeat, n.dur * secPerBeat, 0.22);
    }
    for (const c of piece.chords) {
      for (const midi of c.midis) {
        this.tone('triangle', midi, start + c.beat * secPerBeat, c.dur * secPerBeat * 0.95, 0.05);
      }
    }
    for (const d of piece.drums) {
      const t = start + d.beat * secPerBeat;
      if (d.inst === 'kick') this.kick(t);
      else if (d.inst === 'snare') this.noise(t, 0.12, 1800, 0.25);
      else this.noise(t, 0.04, 7000, 0.12);
    }
  }

  private tone(type: OscillatorType, midi: number, t: number, dur: number, gain: number): void {
    if (!this.ctx || !this.master) return;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = midiFreq(midi);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.setTargetAtTime(0, t + Math.max(0.01, dur - 0.03), 0.02);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.15);
  }

  private kick(t: number): void {
    if (!this.ctx || !this.master) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.1);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.setTargetAtTime(0, t + 0.02, 0.05);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.25);
  }

  private noise(t: number, dur: number, freq: number, gain: number): void {
    if (!this.ctx || !this.master) return;
    if (!this.noiseBuf) {
      const len = this.ctx.sampleRate; // 1 秒ぶんを使い回す
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.setTargetAtTime(0, t, dur / 3);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }
}
