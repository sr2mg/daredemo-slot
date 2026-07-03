import type { OpllExports, SfxName } from './opll-core.js';
import { buildSfxDefs, OPLL_CLOCK, OPLL_IMPORTS, OPLL_RATE, renderSequence } from './opll-core.js';

/**
 * 効果音プレイヤー。
 * - 起動時に emu2413 の WASM を取得し、全効果音を Float32Array に事前レンダリング
 *   （AudioContext 不要なのでユーザー操作前にできる）
 * - AudioContext はブラウザの自動再生制限のため、最初の play()（= ユーザー操作起点）で生成
 * - ON/OFF は localStorage に保存
 */

const STORAGE_KEY = 'daredemo.sfx.v1';
const MASTER_GAIN = 0.5;

export class SfxPlayer {
  enabled: boolean;
  private waves: Partial<Record<SfxName, Float32Array>> = {};
  private buffers: Partial<Record<SfxName, AudioBuffer>> = {};
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private loading: Promise<void> | null = null;

  constructor() {
    this.enabled = localStorage.getItem(STORAGE_KEY) !== 'off';
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch {
      // 保存できなくても再生には支障なし
    }
  }

  /** WASM 取得 + 全効果音の事前レンダリング（ユーザー操作前に呼んでよい） */
  preload(): Promise<void> {
    this.loading ??= (async () => {
      const url = new URL('./emu2413.wasm', import.meta.url);
      const bytes = await (await fetch(url)).arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, OPLL_IMPORTS);
      const exports = instance.exports as unknown as OpllExports;
      const opll = exports.OPLL_new(OPLL_CLOCK, OPLL_RATE);
      const defs = buildSfxDefs();
      for (const [name, def] of Object.entries(defs)) {
        this.waves[name as SfxName] = renderSequence(exports, opll, def);
      }
    })();
    return this.loading;
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
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.gain = this.ctx.createGain();
        this.gain.gain.value = MASTER_GAIN;
        this.gain.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      let buffer = this.buffers[name];
      if (!buffer) {
        buffer = this.ctx.createBuffer(1, wave.length, OPLL_RATE);
        buffer.copyToChannel(wave as Float32Array<ArrayBuffer>, 0);
        this.buffers[name] = buffer;
      }
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain!);
      source.start();
    } catch {
      // 音は演出。失敗してもゲームを止めない
    }
  }
}
