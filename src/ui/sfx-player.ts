import type { SfxDesign } from '../core/sfx/sfx-design.js';
import { transposeDesign } from '../core/sfx/sfx-design.js';
import { isPcmBgm } from '../audio/render.js';
import type { ComposedBgmDef, PcmBgmDef } from '../audio/render.js';
import type { OpllExports, SfxDef } from '../audio/opll-core.js';
import type { SfxName } from './sfx-names.js';
import { OPLL_CLOCK, OPLL_IMPORTS, OPLL_RATE, renderSequence, renderSequenceAsync } from '../audio/opll-core.js';
import { arrangeSfx } from '../audio/sfx-arrange.js';
import { ASSIGNABLE_SFX, PRESET_SFX, applyTier, planSfxBatch, resolveSfxAssign, sfxTrigger } from './sfx-library.js';

/**
 * 効果音 + BGM プレイヤー。音源はすべて OPLL（emu2413）。
 * - 効果音は「割り当て解決（sfx-library）→ レシピ生成 → OPLL 変換（sfx-arrange）→
 *   レンダリング」の単一経路。起動時に全契機ぶんを事前レンダリングする
 *   （AudioContext 不要なのでユーザー操作前にできる）
 * - BGM は作曲エンジン + OPLL 編曲（opll-arrange.ts）のシーケンスを
 *   ensureComposedBgm でレンダリングして鳴らす（プリセット曲も自作曲も同じ経路）
 * - AudioContext はブラウザの自動再生制限のため、最初の play()（= ユーザー操作起点）で生成
 * - BGM は AudioBufferSourceNode.loop でループ。イントロ付き曲は初回だけ先頭から鳴らし、
 *   2周目以降は指定されたAの頭へ戻る。効果音より少し下げてミックス
 */

const STORAGE_KEY = 'daredemo.sfx.v1';
const MASTER_GAIN = 0.5;
const BGM_GAIN = 0.55; // マスターに対する BGM の相対音量（bgmVolume=0.5 のときの値）
/** 自作 BGM 波形キャッシュの上限（1 曲 ≒ 1〜2.4MB） */
const CUSTOM_BGM_CACHE_MAX = 6;
/** 効果音試聴の波形キャッシュ上限（短いので軽い） */
const PREVIEW_CACHE_MAX = 16;
/** 効果音の基準正規化ピーク（design.level = 契機の強度段階 × 微調整 がこれに乗算される） */
const SFX_PEAK = 0.65;
/** 直列化した効果音の継ぎ目に置く小さな間（秒） */
const BATCH_GAP = 0.06;

export class SfxPlayer {
  enabled: boolean;
  private waves: Partial<Record<SfxName, Float32Array>> = {};
  private buffers: Partial<Record<SfxName, AudioBuffer>> = {};
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private bgmSource: AudioBufferSourceNode | null = null;
  /** PCM化後も効果音を前へ出すための、OPLL実機のBGMボイス退避に相当する短いダック。 */
  private sfxDuckUntil = 0;
  private sfxDuckTimer: ReturnType<typeof setTimeout> | null = null;
  private loading: Promise<void> | null = null;
  private exports: OpllExports | null = null;
  private opll = 0;
  /** 自作 BGM（OPLL レンダリング済み波形）のキャッシュ。キーは ComposeOptions の JSON */
  private customBgm = new Map<string, Float32Array>();
  /**
   * PCM(SoundFont)のレンダリング済みdef。波形キャッシュと同じキー・同じ上限で管理し、
   * 再生前の照会(getCachedPcmBgm)で高価なSF2レンダリング自体を省略させる。
   * 右チャンネルぶん保持は増えるが、SoundFontを積む作曲スタジオ限定なので許容する。
   */
  private pcmDefs = new Map<string, PcmBgmDef>();
  /** BGM の世代。stopBgm で進み、レンダリング待ちの再生を無効化する */
  private bgmGen = 0;
  /** BGM 音量 0..1（0.5 = 従来の内蔵 BGM 音量）。localStorage への永続化は呼び出し側 */
  private bgmVolume = 0.5;
  /** 効果音デザイン試聴の波形キャッシュ。キーは SfxDesign の JSON */
  private previewCache = new Map<string, Float32Array>();
  /**
   * 効果音を合わせる BGM のキー（0 = C … 11 = B）。BGM 再生中はその曲のキーへ追従し、
   * 停止で C（プリセットの設計キー）に戻る。波形はキーごとに作り直す
   */
  private keyRoot = 0;
  /** waves が作られたときのキー。keyRoot と違えば作り直しが必要 */
  private wavesKeyRoot = 0;
  /** OPLL インスタンスは共有・ステートフルなので、レンダリングはこのキューで直列化する */
  private renderJobs: { run: () => Promise<void>; priority: boolean }[] = [];
  private pumping = false;

  constructor() {
    this.enabled = localStorage.getItem(STORAGE_KEY) !== 'off';
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

  /**
   * design を波形にする（level = 正規化ピークへの相対出力 = 契機の強度段階 × 微調整）。
   * keyRoot を渡すと BGM のキーへ平行移動してから鳴らす（keyed: false のレシピはそのまま）
   */
  private renderDesign(design: SfxDesign, keyRoot = 0): Float32Array {
    const keyed = transposeDesign(design, keyRoot);
    return renderSequence(this.exports!, this.opll, arrangeSfx(keyed), SFX_PEAK * (design.level ?? 1));
  }

  /** 契機 1 つぶんの波形を現在の割り当て・キーで作る（不正データはプリセットで再試行） */
  private renderTrigger(name: SfxName): void {
    try {
      const design = resolveSfxAssign(name);
      if (design === null) {
        delete this.waves[name]; // 「なし」= 波形を持たない（play は無音で何もしない）
      } else {
        this.waves[name] = this.renderDesign(design, this.keyRoot);
      }
    } catch {
      // 壊れた保存データ等はプリセットで再試行（プリセットは常に有効なレシピ）
      this.waves[name] = this.renderDesign(applyTier(PRESET_SFX[name], name), this.keyRoot);
    }
    delete this.buffers[name];
  }

  /** 全契機の効果音を、現在の割り当て（自作/プリセット/なし）と BGM キーからレンダリングする */
  private renderSfx(): void {
    if (!this.exports) return;
    for (const { name } of ASSIGNABLE_SFX) this.renderTrigger(name);
    this.wavesKeyRoot = this.keyRoot;
    this.buffers = {};
  }

  /** 契機の割り当て変更後に、その効果音だけ作り直す（効果音作成パネルから呼ぶ） */
  refreshSfx(name: SfxName): void {
    void this.enqueueRender(async () => {
      await this.preload();
      if (!this.exports) return;
      this.renderTrigger(name);
    }, true);
  }

  /**
   * 効果音を合わせるキーを変える（BGM の開始・停止で呼ぶ）。キーが変わったら全契機を
   * 作り直す。作り直し中に鳴った効果音は旧キーの波形で鳴る（数十 ms の話なので許容）
   */
  setKeyRoot(keyRoot: number): void {
    const k = ((Math.round(keyRoot) % 12) + 12) % 12;
    if (k === this.keyRoot) return;
    this.keyRoot = k;
    void this.enqueueRender(async () => {
      await this.preload();
      if (!this.exports || this.wavesKeyRoot === this.keyRoot) return;
      this.renderSfx();
    }, true);
  }

  /** 契機の効果音が鳴り終わるまでの秒数（直前の間を含む）。未ロード・「なし」は 0 */
  sfxEndSec(name: SfxName): number {
    const wave = this.waves[name];
    if (!wave) return 0;
    return (sfxTrigger(name).preGapSec ?? 0) + wave.length / OPLL_RATE;
  }

  /** 効果音デザインの試聴（エディタ用なので ON/OFF トグルに関わらず鳴らす） */
  async previewDesign(design: SfxDesign): Promise<boolean> {
    const key = JSON.stringify(design);
    let wave = this.touchLru(this.previewCache, key);
    if (!wave) {
      try {
        wave = await this.enqueueRender(async () => {
          await this.preload();
          if (!this.exports) throw new Error('OPLL 未初期化');
          return this.renderDesign(design);
        }, true);
      } catch {
        return false;
      }
      this.previewCache.set(key, wave);
      while (this.previewCache.size > PREVIEW_CACHE_MAX) {
        this.previewCache.delete(this.previewCache.keys().next().value!);
      }
    }
    try {
      const ctx = this.ensureCtx();
      const buffer = ctx.createBuffer(1, wave.length, OPLL_RATE);
      buffer.copyToChannel(wave as Float32Array<ArrayBuffer>, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain!);
      source.start();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * レンダリングキュー。優先ジョブ（自作 BGM の試聴・ボーナス開始）は
   * 起動時の内蔵 BGM 一括レンダリングを追い越して先に実行される。
   */
  private enqueueRender<T>(work: () => Promise<T>, priority = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job = { priority, run: () => work().then(resolve, reject) };
      if (priority) {
        const i = this.renderJobs.findIndex((j) => !j.priority);
        if (i < 0) this.renderJobs.push(job);
        else this.renderJobs.splice(i, 0, job);
      } else {
        this.renderJobs.push(job);
      }
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    while (this.renderJobs.length > 0) {
      const job = this.renderJobs.shift()!;
      await job.run().catch(() => {
        // 失敗はジョブごとの Promise 経由で呼び出し側へ伝わる。キューは止めない
      });
    }
    this.pumping = false;
  }

  /** WASM 取得 + 効果音の事前レンダリング（BGM は割り当て曲を App 側が ensureComposedBgm で先行レンダリング） */
  preload(): Promise<void> {
    this.loading ??= (async () => {
      const url = new URL('./emu2413.wasm', import.meta.url);
      const bytes = await (await fetch(url)).arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, OPLL_IMPORTS);
      this.exports = instance.exports as unknown as OpllExports;
      this.opll = this.exports.OPLL_new(OPLL_CLOCK, OPLL_RATE);
      this.renderSfx();
    })();
    return this.loading;
  }

  /** BGM 音量（0..1。0.5 = 従来の内蔵 BGM 音量）。再生中でも即座に反映 */
  setBgmVolume(v: number): void {
    this.bgmVolume = Math.max(0, Math.min(1, v));
    if (this.bgmGain) {
      const ducked = this.ctx && this.ctx.currentTime < this.sfxDuckUntil;
      this.bgmGain.gain.value = this.effectiveBgmGain() * (ducked ? 0.58 : 1);
    }
  }

  private effectiveBgmGain(): number {
    return BGM_GAIN * (this.bgmVolume / 0.5);
  }

  /**
   * 現構成はBGM/SFXを別PCMへ事前レンダリングするため、再生中のYM2413チャンネルを直接奪えない。
   * 代わりにSFXの長さだけBGMを高速に下げ、実機ドライバの「低優先度BGM声部をSFXへ譲る」聞こえ方を再現する。
   */
  private duckBgmFor(duration: number): void {
    if (!this.ctx || !this.bgmGain || !this.bgmSource) return;
    const now = this.ctx.currentTime;
    this.sfxDuckUntil = Math.max(this.sfxDuckUntil, now + duration);
    const param = this.bgmGain.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(this.effectiveBgmGain() * 0.58, now + 0.008);
    if (this.sfxDuckTimer !== null) clearTimeout(this.sfxDuckTimer);
    this.sfxDuckTimer = setTimeout(() => {
      if (!this.ctx || !this.bgmGain) return;
      const restoreAt = this.ctx.currentTime;
      if (restoreAt + 0.01 < this.sfxDuckUntil) {
        this.duckBgmFor(this.sfxDuckUntil - restoreAt);
        return;
      }
      const gain = this.bgmGain.gain;
      gain.cancelScheduledValues(restoreAt);
      gain.setValueAtTime(gain.value, restoreAt);
      gain.linearRampToValueAtTime(this.effectiveBgmGain(), restoreAt + 0.04);
      this.sfxDuckTimer = null;
    }, Math.max(0, (this.sfxDuckUntil - now) * 1000));
  }

  /**
   * 自作 BGM（OPLL 編曲済みシーケンス）をレンダリングしてキャッシュする。
   * key は ComposeOptions の JSON（同じ曲は再レンダリングしない）
   */
  ensureComposedBgm(key: string, def: ComposedBgmDef, onProgress?: (ratio: number) => void): Promise<Float32Array> {
    const cached = this.touchLru(this.customBgm, key);
    if (cached) return Promise.resolve(cached);
    if (isPcmBgm(def)) {
      if (def.transient) {
        // 劣化レンダリング(キーが表す構成と波形が不一致)はキャッシュへ残さない。
        onProgress?.(1);
        return Promise.resolve(def.wave);
      }
      this.customBgm.set(key, def.wave);
      this.pcmDefs.set(key, def);
      onProgress?.(1);
      this.evictCustomBgm();
      return Promise.resolve(def.wave);
    }
    return this.enqueueRender(async () => {
      await this.preload();
      const again = this.touchLru(this.customBgm, key);
      if (again) return again;
      if (!this.exports) throw new Error('OPLL 未初期化');
      const wave = await renderSequenceAsync(this.exports, this.opll, def, onProgress);
      this.customBgm.set(key, wave);
      this.evictCustomBgm();
      return wave;
    }, true);
  }

  private evictCustomBgm(): void {
    while (this.customBgm.size > CUSTOM_BGM_CACHE_MAX) {
      const oldest = this.customBgm.keys().next().value!;
      this.customBgm.delete(oldest);
      this.pcmDefs.delete(oldest);
    }
  }

  /**
   * MapをLRUとして使う: ヒットしたキーを末尾へ再挿入する。Mapの反復順は挿入順
   * なので、追い出し(先頭削除)が「最も昔に参照された」ものになる。再挿入しないと
   * 挿入順=追い出し順のFIFOになり、よく聴く曲が古いという理由で落ちる。
   */
  private touchLru<V>(map: Map<string, V>, key: string): V | undefined {
    const value = map.get(key);
    if (value !== undefined) {
      map.delete(key);
      map.set(key, value);
    }
    return value;
  }

  /**
   * レンダリング済みPCM defのキャッシュ照会。再生・書き出しの前にこれを引き、
   * ヒットすればSF2レンダリング(BgmPcmRenderer.render)を丸ごと省略できる。
   * キーの規約は ensureComposedBgm と同じ(呼び出し側のbgmCacheKey)。
   */
  getCachedPcmBgm(key: string): PcmBgmDef | null {
    const def = this.touchLru(this.pcmDefs, key);
    // 波形と同じ曲を参照したことになるので、追い出し順を共有する波形側も触る。
    if (def) this.touchLru(this.customBgm, key);
    return def ?? null;
  }

  /**
   * 自作 BGM を（必要ならレンダリングしてから）ループ再生する。
   * delaySec はファンファーレ後のイン用で、レンダリング待ちが延びた場合は残り時間だけ待つ。
   * レンダリング完了前に stopBgm / playBgm / OFF が呼ばれたら鳴らさない（世代チェック）。
   * 戻り値: 'played' = 鳴らした / 'failed' = 鳴らせない（フォールバック可）/
   * 'superseded' = 待っている間に不要になった（フォールバックしてはいけない）
   */
  async playComposedBgm(
    key: string,
    def: ComposedBgmDef,
    delaySec = 0,
    opts: {
      loop?: boolean;
      onProgress?: (ratio: number) => void;
      /** 曲頭ではなくこの秒位置から再生する（ブラインド比較の差分区間試聴用）。 */
      startAtSec?: number;
      /** 再生開始からこの秒数で自動停止する。省略時は最後まで。 */
      stopAfterSec?: number;
      /** 曲のキー（0 = C … 11）。渡すと効果音をこのキーへ追従させる（BGM と効果音のキー合わせ） */
      keyRoot?: number;
    } = {},
  ): Promise<'played' | 'failed' | 'superseded'> {
    if (!this.enabled) return 'failed';
    this.stopBgm();
    if (opts.keyRoot !== undefined) this.setKeyRoot(opts.keyRoot);
    const gen = this.bgmGen;
    const requestedAt = performance.now();
    let wave: Float32Array;
    try {
      wave = await this.ensureComposedBgm(key, def, opts.onProgress);
    } catch {
      return this.bgmGen === gen ? 'failed' : 'superseded';
    }
    if (this.bgmGen !== gen || !this.enabled) return 'superseded';
    try {
      const ctx = this.ensureCtx();
      const sampleRate = isPcmBgm(def) ? def.sampleRate : OPLL_RATE;
      // PCM defが右チャンネルを持てばステレオ(SoundFontレンダラ)。チップ音源はモノ。
      const rightWave = isPcmBgm(def) && def.waveRight && def.waveRight.length === wave.length
        ? def.waveRight
        : null;
      const buffer = ctx.createBuffer(rightWave ? 2 : 1, wave.length, sampleRate);
      buffer.copyToChannel(wave as Float32Array<ArrayBuffer>, 0);
      if (rightWave) buffer.copyToChannel(rightWave as Float32Array<ArrayBuffer>, 1);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = opts.loop ?? true;
      if (source.loop) {
        // loopStart/End を設定しても初回の start() は0秒から始まるため、イントロは一度だけ鳴る。
        source.loopStart = Math.max(0, Math.min(def.loopStart, buffer.duration));
        source.loopEnd = Math.max(source.loopStart, Math.min(def.loopEnd, buffer.duration));
      }
      source.connect(this.bgmGain!);
      const remaining = Math.max(0, delaySec - (performance.now() - requestedAt) / 1000);
      const startAt = ctx.currentTime + remaining;
      const offset = Math.max(0, Math.min(opts.startAtSec ?? 0, buffer.duration));
      source.start(startAt, offset);
      if (opts.stopAfterSec !== undefined) source.stop(startAt + Math.max(0, opts.stopAfterSec));
      this.bgmSource = source;
      return 'played';
    } catch {
      return 'failed'; // 音は演出。失敗してもゲームを止めない
    }
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = MASTER_GAIN;
      this.gain.connect(this.ctx.destination);
      this.bgmGain = this.ctx.createGain();
      this.bgmGain.gain.value = this.effectiveBgmGain();
      this.bgmGain.connect(this.gain);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  stopBgm(): void {
    this.bgmGen++; // レンダリング待ちの自作 BGM 再生も無効化する
    try {
      this.bgmSource?.stop();
    } catch {
      // 未 start の source を stop した場合など。無視してよい
    }
    this.bgmSource = null;
    this.setKeyRoot(0); // 効果音はプリセットの設計キー（C）へ戻す
  }

  /**
   * 効果音を再生（未ロード・OFF・失敗時は黙って何もしない）。
   * 契機に間（preGapSec）があればその分遅らせて鳴らし、間の間も BGM を下げる
   * （「告知の直前の無音」）。戻り値は鳴り終わる時刻（AudioContext 時間）。
   * 鳴らせなかったときは null
   */
  play(name: SfxName, startAt?: number): number | null {
    if (!this.enabled) return null;
    try {
      const wave = this.waves[name];
      if (!wave) {
        void this.preload();
        return null;
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
      const gap = sfxTrigger(name).preGapSec ?? 0;
      const at = Math.max(ctx.currentTime, startAt ?? ctx.currentTime) + gap;
      this.duckBgmFor(at - ctx.currentTime + buffer.duration);
      source.start(at);
      return at + buffer.duration;
    } catch {
      return null; // 音は演出。失敗してもゲームを止めない
    }
  }

  /**
   * 同じ瞬間に立った複数の契機を、優先度順に直列化して鳴らす（planSfxBatch の規則）。
   * 発音数の限られた実機で「割り込みは優先度順に順番待ち」だった聞こえ方の再現で、
   * 告知と予告、ファンファーレと払い出しが重なって団子になるのを防ぐ。
   * 戻り値は最後の音が鳴り終わる秒数（今から。何も鳴らなければ 0）
   */
  playMany(names: readonly SfxName[]): number {
    if (!this.enabled) return 0;
    let cursor: number | undefined;
    let end = 0;
    for (const name of planSfxBatch(names)) {
      const finished = this.play(name, cursor);
      if (finished === null) continue;
      cursor = finished + BATCH_GAP;
      end = finished;
    }
    return end > 0 && this.ctx ? Math.max(0, end - this.ctx.currentTime) : 0;
  }
}
