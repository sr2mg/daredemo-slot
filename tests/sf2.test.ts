import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { parseSf2, renderSf2 } from '../src/ui/sf2.js';
import { arrangeSf2Notes, renderSf2Bgm, SF2_SAMPLE_RATE } from '../src/ui/pcm-arrange.js';

/**
 * SF2パーサ+オフラインレンダラの検証。
 * 単体はコード内で組み立てた最小SoundFont(440Hz正弦・rootKey69)で行い、
 * 統合は同梱のGeneralUser GS実ファイルで「実フォントが鳴る」ことを確かめる。
 */

const SAMPLE_RATE_IN = 32000;
const SAMPLE_COUNT = 3200;

function buildMinimalSf2(): ArrayBuffer {
  const textEncoder = new TextEncoder();
  const chunks: { id: string; body: Uint8Array }[] = [];
  const record = (size: number, write: (view: DataView) => void): Uint8Array => {
    const bytes = new Uint8Array(size);
    write(new DataView(bytes.buffer));
    return bytes;
  };
  const name20 = (view: DataView, at: number, name: string): void => {
    const encoded = textEncoder.encode(name);
    for (let i = 0; i < Math.min(19, encoded.length); i++) view.setUint8(at + i, encoded[i]!);
  };

  // 440Hz正弦(32kHz)。rootKey69なのでキー69で440Hzになる。
  const smpl = new Int16Array(SAMPLE_COUNT + 46); // 末尾ゼロ余白(スペック推奨)
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    smpl[i] = Math.round(Math.sin(2 * Math.PI * 440 * (i / SAMPLE_RATE_IN)) * 20000);
  }
  chunks.push({ id: 'smpl', body: new Uint8Array(smpl.buffer) });

  const shdr = new Uint8Array(46 * 2);
  {
    const view = new DataView(shdr.buffer);
    name20(view, 0, 'sine440');
    view.setUint32(20, 0, true); // start
    view.setUint32(24, SAMPLE_COUNT, true); // end
    view.setUint32(28, 100, true); // loopStart
    view.setUint32(32, 3100, true); // loopEnd
    view.setUint32(36, SAMPLE_RATE_IN, true);
    view.setUint8(40, 69); // originalKey = A4
    name20(view, 46, 'EOS');
  }

  const inst = new Uint8Array(22 * 2);
  {
    const view = new DataView(inst.buffer);
    name20(view, 0, 'sineInst');
    view.setUint16(20, 0, true); // bagNdx
    name20(view, 22, 'EOI');
    view.setUint16(42, 1, true);
  }
  const ibag = record(4 * 2, (view) => {
    view.setUint16(0, 0, true); // zone0: gen 0..
    view.setUint16(4, 3, true); // terminal
  });
  const igen = record(4 * 3, (view) => {
    view.setUint16(0, 43, true); view.setUint16(2, 0 | (127 << 8), true); // keyRange 0..127
    view.setUint16(4, 54, true); view.setInt16(6, 1, true); // sampleModes: loop
    view.setUint16(8, 53, true); view.setInt16(10, 0, true); // sampleID(末尾)
  });

  // プリセット2つ: bank0 prog0(メロディ) と bank128 prog0(パーカッション扱いの確認)
  const phdr = new Uint8Array(38 * 3);
  {
    const view = new DataView(phdr.buffer);
    name20(view, 0, 'sinePreset');
    view.setUint16(20, 0, true); // program
    view.setUint16(22, 0, true); // bank
    view.setUint16(24, 0, true); // bagNdx
    name20(view, 38, 'sineDrum');
    view.setUint16(58, 0, true);
    view.setUint16(60, 128, true);
    view.setUint16(62, 1, true);
    name20(view, 76, 'EOP');
    view.setUint16(100, 2, true);
  }
  const pbag = record(4 * 3, (view) => {
    view.setUint16(0, 0, true);
    view.setUint16(4, 1, true);
    view.setUint16(8, 2, true);
  });
  const pgen = record(4 * 2, (view) => {
    view.setUint16(0, 41, true); view.setInt16(2, 0, true); // instrument 0
    view.setUint16(4, 41, true); view.setInt16(6, 0, true);
  });

  const pdtaChunks: [string, Uint8Array][] = [
    ['phdr', phdr], ['pbag', pbag], ['pmod', new Uint8Array(10)], ['pgen', pgen],
    ['inst', inst], ['ibag', ibag], ['imod', new Uint8Array(10)], ['igen', igen],
    ['shdr', shdr],
  ];

  const sub = (id: string, body: Uint8Array): Uint8Array => {
    const padded = body.length % 2 === 1 ? body.length + 1 : body.length;
    const out = new Uint8Array(8 + padded);
    out.set(textEncoder.encode(id), 0);
    new DataView(out.buffer).setUint32(4, body.length, true);
    out.set(body, 8);
    return out;
  };
  const list = (type: string, items: Uint8Array[]): Uint8Array => {
    const bodyLength = 4 + items.reduce((sum, item) => sum + item.length, 0);
    const out = new Uint8Array(8 + bodyLength);
    out.set(textEncoder.encode('LIST'), 0);
    new DataView(out.buffer).setUint32(4, bodyLength, true);
    out.set(textEncoder.encode(type), 8);
    let at = 12;
    for (const item of items) { out.set(item, at); at += item.length; }
    return out;
  };

  const info = list('INFO', [sub('ifil', new Uint8Array([2, 0, 1, 0]))]);
  const sdta = list('sdta', [sub('smpl', chunks[0]!.body)]);
  const pdta = list('pdta', pdtaChunks.map(([id, body]) => sub(id, body)));
  const total = 4 + info.length + sdta.length + pdta.length;
  const out = new Uint8Array(8 + total);
  out.set(textEncoder.encode('RIFF'), 0);
  new DataView(out.buffer).setUint32(4, total, true);
  out.set(textEncoder.encode('sfbk'), 8);
  out.set(info, 12);
  out.set(sdta, 12 + info.length);
  out.set(pdta, 12 + info.length + sdta.length);
  return out.buffer;
}

const rmsOf = (wave: Float32Array, fromSec: number, toSec: number, rate: number): number => {
  const from = Math.floor(fromSec * rate);
  const to = Math.min(wave.length, Math.floor(toSec * rate));
  let sum = 0;
  for (let i = from; i < to; i++) sum += wave[i]! * wave[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
};

const zeroCrossings = (wave: Float32Array, fromSec: number, toSec: number, rate: number): number => {
  const from = Math.floor(fromSec * rate);
  const to = Math.min(wave.length, Math.floor(toSec * rate));
  let count = 0;
  for (let i = from + 1; i < to; i++) {
    if ((wave[i - 1]! < 0) !== (wave[i]! < 0)) count++;
  }
  return count;
};

describe('SF2パーサ(合成最小フォント)', () => {
  const font = parseSf2(buildMinimalSf2());

  it('プリセット・ゾーン・ルートキーを解決する', () => {
    expect(font.presets).toHaveLength(2);
    expect(font.presets[0]!.bank).toBe(0);
    expect(font.presets[1]!.bank).toBe(128);
    expect(font.presets[0]!.zones).toHaveLength(1);
    expect(font.presets[0]!.zones[0]!.rootKey).toBe(69);
    expect(font.presets[0]!.zones[0]!.sampleModes).toBe(1);
  });

  it('キー69は約440Hzで鳴り、リリース後は減衰する', () => {
    const rate = 44100;
    const wave = renderSf2(font, [
      { program: 0, bank: 0, midi: 69, velocity: 100, startSec: 0, durSec: 0.5, gain: 1 },
    ], rate, 1.0);
    expect(rmsOf(wave, 0.05, 0.45, rate)).toBeGreaterThan(0.01);
    expect(rmsOf(wave, 0.9, 1.0, rate)).toBeLessThan(0.003);
    const crossings = zeroCrossings(wave, 0.1, 0.4, rate);
    expect(crossings).toBeGreaterThan(440 * 2 * 0.3 * 0.85);
    expect(crossings).toBeLessThan(440 * 2 * 0.3 * 1.15);
  });

  it('+12キーでピッチが2倍になる(移調則)', () => {
    const rate = 44100;
    const wave = renderSf2(font, [
      { program: 0, bank: 0, midi: 81, velocity: 100, startSec: 0, durSec: 0.4, gain: 1 },
    ], rate, 0.6);
    const crossings = zeroCrossings(wave, 0.05, 0.35, rate);
    expect(crossings).toBeGreaterThan(880 * 2 * 0.3 * 0.85);
    expect(crossings).toBeLessThan(880 * 2 * 0.3 * 1.15);
  });
});

describe('PCM編曲(Piece→GMノート)', () => {
  const piece = compose({
    progressionId: 'relative-orbit', styleId: 'kmmo', keyRoot: 2, bpm: 100, bars: 4, seed: 8,
  });

  it('スタイル別プログラムとパーカッションバンクを割り当てる', () => {
    const notes = arrangeSf2Notes(piece);
    expect(notes.some((n) => n.program === 110 && n.bank === 0)).toBe(true); // kmmoリード=Fiddle
    expect(notes.some((n) => n.bank === 128)).toBe(true); // ドラム
    expect(notes.every((n) => n.durSec > 0)).toBe(true);
  });

  it('パート別上書きが主旋律のプリセットを差し替える(バンク指定込み)', () => {
    const notes = arrangeSf2Notes(piece, { lead: { bank: 8, program: 107 } });
    expect(notes.some((n) => n.bank === 8 && n.program === 107)).toBe(true);
    expect(notes.some((n) => n.program === 110 && n.bank === 0)).toBe(false); // 既定リードは消える
    // 他パート(伴奏=48)は既定のまま
    expect(notes.some((n) => n.program === 48 && n.bank === 0)).toBe(true);
  });

  it('同梱GeneralUser GSで実際に音が出る(統合)', () => {
    const buffer = readFileSync('public/soundfonts/GeneralUser-GS.sf2');
    const font = parseSf2(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    expect(font.presets.length).toBeGreaterThan(100);
    const def = renderSf2Bgm(piece, font);
    expect(def.sampleRate).toBe(SF2_SAMPLE_RATE);
    expect(def.loopEnd).toBeCloseTo(piece.beats * (60 / piece.bpm), 5);
    expect(rmsOf(def.wave, 0.5, Math.min(def.loopEnd, 5), SF2_SAMPLE_RATE)).toBeGreaterThan(0.01);
    expect(def.wave.some((value) => !Number.isFinite(value))).toBe(false);
    // ステレオ: 右チャンネルが存在し、同一長・有限で、舞台配置により左右が異なる
    expect(def.waveRight).toBeDefined();
    expect(def.waveRight!.length).toBe(def.wave.length);
    expect(def.waveRight!.some((value) => !Number.isFinite(value))).toBe(false);
    let differs = false;
    const from = Math.floor(0.5 * SF2_SAMPLE_RATE);
    const to = Math.floor(3 * SF2_SAMPLE_RATE);
    for (let i = from; i < to; i++) {
      if (Math.abs(def.wave[i]! - def.waveRight![i]!) > 1e-3) { differs = true; break; }
    }
    expect(differs).toBe(true);
  });
});
