import type { SfxDesign, SfxEvent, ToneEvent } from '../core/music/sfx-design.js';
import { buildSfxEvents, sfxDuration } from '../core/music/sfx-design.js';
import { initRhythmMode } from './mml.js';
import { SeqBuilder } from './opll-core.js';
import type { SfxDef } from './opll-core.js';

/**
 * 効果音デザイン（レシピ生成のイベント列）を OPLL レジスタ列へ変換する。
 * BGM の opll-arrange.ts と対になる効果音版。
 * - 同時発音はチャンネル割り当てで解決（ch0〜5。リズムは ch6-8）
 * - 隣接する音はレガート結合: keyOff/keyOn せずピッチだけ動かし、
 *   エンベロープのリトリガーを避ける（サイレンの連続ベンドが 1 本の音になる）
 * - ピッチベンドは SeqBuilder.sweep（F ナンバーの毎フレーム書き換え）
 * - ノイズはリズムモードのハイハット/スネアで代用
 */

const midiFreq = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** gain（0..1）→ OPLL 音量（0=最大〜15=最小）。0.05 刻みの gain 差が 1 段になる粒度 */
const gainToVol = (gain: number): number => Math.max(0, Math.min(15, Math.round(9 - gain * 12)));

/** この間隔以内で隣接する同チャンネルの音はレガート結合する */
const LEGATO_EPS = 0.012;

const MAX_CH = 6; // ch0〜5（ch6-8 はリズムモード）

export function arrangeSfx(design: SfxDesign): SfxDef {
  const events = buildSfxEvents(design);
  const duration = sfxDuration(events) + 0.05;
  const b = new SeqBuilder();

  // --- トーン: チャンネル割り当て（レガート優先 → 空きチャンネル） ---
  const tones = events
    .filter((e): e is ToneEvent => e.kind === 'tone')
    .sort((a, c) => a.t - c.t || a.midi - c.midi);
  const chains: ToneEvent[][] = []; // chains[ch] = そのチャンネルで連続再生する音のリスト
  const lastEnd: number[] = [];
  for (const t of tones) {
    // レガート: 直前の音の終わりにぴったり続くチャンネルがあれば繋ぐ
    let ch = lastEnd.findIndex((end) => Math.abs(end - t.t) < LEGATO_EPS);
    if (ch < 0) ch = lastEnd.findIndex((end) => end <= t.t + 1e-9); // 空きチャンネル
    if (ch < 0) {
      if (lastEnd.length >= MAX_CH) continue; // 予算超過ぶんは間引く（音は演出）
      ch = lastEnd.length;
      chains.push([]);
      lastEnd.push(0);
    }
    chains[ch]!.push(t);
    lastEnd[ch] = t.t + t.dur;
  }

  chains.forEach((chain, ch) => {
    let keyedOn = false;
    let prevEnd = -1;
    let prevVol = -1;
    for (const t of chain) {
      const vol = gainToVol(t.gain);
      const legato = keyedOn && Math.abs(t.t - prevEnd) < LEGATO_EPS;
      if (!legato) {
        if (keyedOn) b.keyOff(ch, prevEnd);
        b.keyOn(ch, design.voice, vol, midiFreq(t.midi), t.t);
        keyedOn = true;
      } else {
        // キーオンのまま音量・ピッチだけ更新（エンベロープを切らない）
        if (vol !== prevVol) b.raw(0x30 + ch, ((design.voice & 15) << 4) | vol, t.t);
        b.pitch(ch, midiFreq(t.midi), t.t);
      }
      if (t.midiTo !== undefined) {
        b.sweep(ch, midiFreq(t.midi), midiFreq(t.midiTo), t.t, t.t + t.dur);
      }
      prevEnd = t.t + t.dur;
      prevVol = vol;
    }
    if (keyedOn) b.keyOff(ch, prevEnd);
  });

  // --- ノイズ: リズムモードで代用（低域 = バスドラ / 中域 = スネア / 高域 = ハイハット） ---
  const noises = events.filter((e) => e.kind === 'noise');
  if (noises.length > 0) {
    initRhythmMode(b);
    for (const n of noises) {
      const bit = n.freq < 500 ? 0x10 : n.freq >= 4000 ? 0x01 : 0x08;
      b.raw(0x0e, 0x20, n.t);
      b.raw(0x0e, 0x20 | bit, n.t + 0.004);
    }
  }

  return { duration, events: b.events };
}
