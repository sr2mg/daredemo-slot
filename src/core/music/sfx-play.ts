/**
 * 自作効果音（sfx-design.ts のイベント列）の Web Audio 再生。
 * 効果音は短く重なってもよいので、BGM 用 MusicPlayer と違い stop の概念を持たない
 * （鳴らしっぱなしで各ノードが勝手に終わる）。AudioContext は 1 個を使い回す。
 */

import type { SfxEvent } from './sfx-design.js';

const midiFreq = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

export class SfxDesignPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  play(events: SfxEvent[], wave: OscillatorType): void {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      const start = this.ctx.currentTime + 0.02;
      for (const e of events) {
        if (e.kind === 'tone') this.tone(wave, e.midi, e.midiTo, start + e.t, e.dur, e.gain);
        else this.noise(start + e.t, e.dur, e.freq, e.gain);
      }
    } catch {
      // 音は演出。失敗してもゲームを止めない
    }
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
  }

  private tone(
    wave: OscillatorType,
    midi: number,
    midiTo: number | undefined,
    t: number,
    dur: number,
    gain: number,
  ): void {
    if (!this.ctx || !this.master) return;
    const osc = this.ctx.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(midiFreq(midi), t);
    if (midiTo !== undefined) osc.frequency.linearRampToValueAtTime(midiFreq(midiTo), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain * 0.35, t + 0.005);
    g.gain.setTargetAtTime(0, t + Math.max(0.01, dur - 0.02), 0.02);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.15);
  }

  private noise(t: number, dur: number, freq: number, gain: number): void {
    if (!this.ctx || !this.master) return;
    if (!this.noiseBuf) {
      const len = this.ctx.sampleRate;
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
