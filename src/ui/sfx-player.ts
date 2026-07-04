import { buildBgmDefs } from './bgm.js';
import type { BgmName } from './bgm.js';
import type { OpllExports, SfxName } from './opll-core.js';
import {
  buildSfxDefs,
  DEFAULT_BEEP_VOICE,
  OPLL_CLOCK,
  OPLL_IMPORTS,
  OPLL_RATE,
  renderSequence,
} from './opll-core.js';

/**
 * 効果音 + BGM プレイヤー。
 * - 起動時に emu2413 の WASM を取得し、全効果音と BGM を Float32Array に事前レンダリング
 *   （AudioContext 不要なのでユーザー操作前にできる）
 * - AudioContext はブラウザの自動再生制限のため、最初の play()（= ユーザー操作起点）で生成
 * - BGM は AudioBufferSourceNode.loop でループ。効果音より少し下げてミックス
 * - ON/OFF・ビープ音色は localStorage に保存。音色変更時はビープだけ再レンダリング
 */

const STORAGE_KEY = 'daredemo.sfx.v1';
const VOICE_KEY = 'daredemo.sfxVoice.v1';
const MASTER_GAIN = 0.5;
const BGM_GAIN = 0.55; // マスターに対する BGM の相対音量

/** ビープ音色の影響を受ける効果音（音色変更時はこれだけ作り直す） */
const BEEP_NAMES: readonly SfxName[] = ['bet', 'lever', 'betLever'];

export class SfxPlayer {
  enabled: boolean;
  beepVoice: number;
  private waves: Partial<Record<SfxName, Float32Array>> = {};
  private buffers: Partial<Record<SfxName, AudioBuffer>> = {};
  private bgmWaves: Partial<Record<BgmName, Float32Array>> = {};
  private bgmBuffers: Partial<Record<BgmName, AudioBuffer>> = {};
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private bgmSource: AudioBufferSourceNode | null = null;
  private loading: Promise<void> | null = null;
  private exports: OpllExports | null = null;
  private opll = 0;

  constructor() {
    this.enabled = localStorage.getItem(STORAGE_KEY) !== 'off';
    const stored = Number(localStorage.getItem(VOICE_KEY));
    this.beepVoice = Number.isInteger(stored) && stored >= 1 && stored <= 15 ? stored : DEFAULT_BEEP_VOICE;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.stopBgm();
    try {
      localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch {
      // 保存できなくても再生には支障なし
    }
  }

  /** ビープ（ベット/レバー）の音色を変更し、対象の波形だけ作り直す */
  setBeepVoice(voice: number): void {
    this.beepVoice = voice;
    try {
      localStorage.setItem(VOICE_KEY, String(voice));
    } catch {
      // 保存できなくても再生には支障なし
    }
    if (!this.exports) return;
    const defs = buildSfxDefs({ beepVoice: this.beepVoice });
    for (const name of BEEP_NAMES) {
      this.waves[name] = renderSequence(this.exports, this.opll, defs[name]);
      delete this.buffers[name];
    }
  }

  private renderSfx(): void {
    if (!this.exports) return;
    const defs = buildSfxDefs({ beepVoice: this.beepVoice });
    for (const [name, def] of Object.entries(defs)) {
      this.waves[name as SfxName] = renderSequence(this.exports, this.opll, def);
    }
    this.buffers = {};
  }

  /**
   * BGM のレンダリング（1 曲 1〜2 秒かかるので、起動をブロックしないよう
   * 効果音のあとにバックグラウンドで 1 曲ずつ行う）
   */
  private async renderBgmInBackground(): Promise<void> {
    for (const [name, def] of Object.entries(buildBgmDefs())) {
      await new Promise((r) => setTimeout(r, 50));
      if (!this.exports) return;
      this.bgmWaves[name as BgmName] = renderSequence(this.exports, this.opll, def);
    }
    this.bgmBuffers = {};
  }

  /** WASM 取得 + 効果音の事前レンダリング（BGM は続けてバックグラウンドで） */
  preload(): Promise<void> {
    this.loading ??= (async () => {
      const url = new URL('./emu2413.wasm', import.meta.url);
      const bytes = await (await fetch(url)).arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, OPLL_IMPORTS);
      this.exports = instance.exports as unknown as OpllExports;
      this.opll = this.exports.OPLL_new(OPLL_CLOCK, OPLL_RATE);
      this.renderSfx();
      void this.renderBgmInBackground();
    })();
    return this.loading;
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = MASTER_GAIN;
      this.gain.connect(this.ctx.destination);
      this.bgmGain = this.ctx.createGain();
      this.bgmGain.gain.value = BGM_GAIN;
      this.bgmGain.connect(this.gain);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** BGM をループ再生（既に鳴っていれば差し替え）。delaySec でファンファーレ後に開始できる */
  playBgm(name: BgmName, delaySec = 0): void {
    if (!this.enabled) return;
    try {
      const wave = this.bgmWaves[name];
      if (!wave) return;
      const ctx = this.ensureCtx();
      this.stopBgm();
      let buffer = this.bgmBuffers[name];
      if (!buffer) {
        buffer = ctx.createBuffer(1, wave.length, OPLL_RATE);
        buffer.copyToChannel(wave as Float32Array<ArrayBuffer>, 0);
        this.bgmBuffers[name] = buffer;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(this.bgmGain!);
      source.start(ctx.currentTime + delaySec);
      this.bgmSource = source;
    } catch {
      // 音は演出。失敗してもゲームを止めない
    }
  }

  stopBgm(): void {
    try {
      this.bgmSource?.stop();
    } catch {
      // 未 start の source を stop した場合など。無視してよい
    }
    this.bgmSource = null;
  }

  /** 効果音を再生（未ロード・OFF・失敗時は黙って何もしない） */
  play(name: SfxName): void {
    if (!this.enabled) return;
    try {
      const wave = this.waves[name];
      if (!wave) {
        void this.preload();
        return;
      }
      const ctx = this.ensureCtx();
      let buffer = this.buffers[name];
      if (!buffer) {
        buffer = ctx.createBuffer(1, wave.length, OPLL_RATE);
        buffer.copyToChannel(wave as Float32Array<ArrayBuffer>, 0);
        this.buffers[name] = buffer;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain!);
      source.start();
    } catch {
      // 音は演出。失敗してもゲームを止めない
    }
  }
}
