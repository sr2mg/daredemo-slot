import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { arrangePiece, defaultVoicesFor } from '../src/ui/opll-arrange.js';

const piece = compose({
  progressionId: 'royal-pop',
  styleId: 'eurobeat',
  keyRoot: 0,
  bpm: 170,
  bars: 4,
  seed: 42,
});
const def = arrangePiece(piece, 'eurobeat');
const spb = 60 / 170;

/** ch のキーオン（音色|音量レジスタ 0x30+ch への書き込み）を時刻順で返す */
const keyOns = (ch: number) => def.events.filter((e) => e.reg === 0x30 + ch).sort((a, b) => a.at - b.at);

describe('arrangePiece（Piece → OPLL レジスタ列）', () => {
  it('全スタイルの既定音色はリード=フルート、ベース=オルガン', () => {
    for (const styleId of ['eurobeat', 'rock', 'ska']) {
      expect(defaultVoicesFor(styleId).lead, styleId).toBe(4);
      expect(defaultVoicesFor(styleId).bass, styleId).toBe(8);
    }
  });

  it('ループ長は拍数どおり、全イベントが曲中に収まる', () => {
    expect(def.duration).toBeCloseTo(piece.beats * spb, 9);
    expect(def.bpm).toBe(170);
    expect(def.bars).toBe(4);
    for (const e of def.events) {
      expect(e.at).toBeGreaterThanOrEqual(0);
      expect(e.at).toBeLessThanOrEqual(def.duration);
    }
  });

  it('リード（ch2）はメロディと同数のキーオンで、作曲時の強弱を4bit音量へ反映する', () => {
    const lead = keyOns(2);
    expect(lead.length).toBe(piece.melody.length);
    for (let i = 0; i < lead.length; i++) {
      const inBar = piece.melody[i]!.beat % 4;
      const vol = lead[i]!.val & 15; // 下位ニブル（0=最大）
      const velocity = piece.melody[i]!.velocity;
      const expected = velocity === undefined
        ? (inBar === 0 || inBar === 2 ? 2 : 4)
        : Math.max(0, Math.min(15, Math.round(12 - velocity * 11)));
      expect(vol, `beat=${piece.melody[i]!.beat}`).toBe(expected);
    }
    const accents = piece.melody
      .map((note, index) => ({ note, volume: lead[index]!.val & 15 }))
      .filter(({ note }) => note.articulation === 'accent');
    const ordinary = piece.melody
      .map((note, index) => ({ note, volume: lead[index]!.val & 15 }))
      .filter(({ note }) => note.articulation === 'normal');
    expect(accents.length).toBeGreaterThan(0);
    expect(Math.min(...accents.map(({ volume }) => volume))).toBeLessThanOrEqual(
      Math.min(...ordinary.map(({ volume }) => volume)),
    );
  });

  it('チャンネルエコー（ch5）: 同数のキーオンが 8 分遅れ（ループ境界は頭に折り返し）', () => {
    const echo = keyOns(5);
    expect(echo.length).toBe(piece.melody.length);
    const expected = piece.melody
      .map((n) => (n.beat * spb + spb / 2) % def.duration)
      .sort((a, b) => a - b);
    const actual = echo.map((e) => e.at).sort((a, b) => a - b);
    for (let i = 0; i < expected.length; i++) {
      expect(actual[i]).toBeCloseTo(expected[i]!, 6);
    }
    // エコーはリードより小さい音量
    expect(echo[0]!.val & 15).toBeGreaterThan(2);
  });

  it('長い音符にはソフトウェアビブラート（F ナンバーの追加書き込み）が入る', () => {
    // keyOn 1 回につき 0x12 は 1 回書かれる。それを超えるぶんがビブラート
    const fnumWrites = def.events.filter((e) => e.reg === 0x12).length;
    expect(piece.melody.some((n) => n.dur >= 1)).toBe(true); // 前提: 長音がある
    expect(fnumWrites).toBeGreaterThan(piece.melody.length);
  });

  it('バッキング（ch3）とベース（ch4）が鳴る', () => {
    expect(keyOns(3).length).toBeGreaterThan(0);
    expect(keyOns(4).length).toBe(piece.bass.length);
  });

  it('16小節曲はイントロ後のAをループ開始点にし、AよりBの編成を厚くする', () => {
    const gamePiece = compose({
      progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, bars: 16, seed: 43,
    });
    const gameDef = arrangePiece(gamePiece, 'eurobeat');
    const startA = gameDef.loopStart;
    const startB = startA + 8 * 4 * spb;
    expect(gamePiece.introBars).toBe(2);
    expect(gameDef.loopStart).toBeCloseTo(gamePiece.loopStartBeat * spb, 9);
    expect(gameDef.loopEnd).toBeCloseTo(gameDef.duration, 9);

    const backingOns = gameDef.events.filter((event) => event.reg === 0x33);
    const inA = backingOns.filter((event) => event.at >= startA && event.at < startB);
    const inB = backingOns.filter((event) => event.at >= startB && event.at < gameDef.loopEnd);
    expect(inB.length).toBeGreaterThan(inA.length);

    const echoOns = gameDef.events.filter((event) => event.reg === 0x35);
    expect(echoOns.every((event) => event.at >= startB)).toBe(true);
    expect(echoOns.length).toBeGreaterThan(0);
  });

  it('副旋律はバッキングch3へ、コード伴奏より少し前へ出る音量で差し込む', () => {
    const counterOns = keyOns(3).filter((event) => (event.val & 15) === 5);
    expect(piece.counterMelody.length).toBeGreaterThan(0);
    expect(counterOns).toHaveLength(piece.counterMelody.length);
  });

  it('同時刻のドラムはビットを合成して 1 回で叩く（キック+スネアが 1 書き込み）', () => {
    // ユーロビートは 2 拍目（step4）にキックとスネアが重なる
    const merged = def.events.find((e) => e.reg === 0x0e && e.val === (0x20 | 0x10 | 0x08));
    expect(merged).toBeDefined();
  });

  it('未知のスタイルはユーロビートの音色にフォールバック', () => {
    const fallback = arrangePiece(piece, 'nazo-style');
    const lead = fallback.events.filter((e) => e.reg === 0x32);
    expect(lead.length).toBeGreaterThan(0);
    expect(lead[0]!.val >> 4).toBe(4); // リード音色 = フルート(4): 上位ニブル
  });

  it('音色上書き: 指定パートだけ差し替え、エコーはリードに追従、未指定はスタイル既定', () => {
    const custom = arrangePiece(piece, 'eurobeat', { lead: 7, bass: 14 });
    const voiceOf = (ch: number) => custom.events.find((e) => e.reg === 0x30 + ch)!.val >> 4;
    expect(voiceOf(2)).toBe(7); // リード = トランペット（上書き）
    expect(voiceOf(5)).toBe(7); // エコーもリードと同じ音色
    expect(voiceOf(4)).toBe(14); // ベース = アコベース（上書き）
    expect(voiceOf(3)).toBe(8); // バッキングはユーロビート既定のオルガンのまま
    // 上書きなしの列とはリード音色だけが違う（イベント数・タイミングは同一）
    expect(custom.events.length).toBe(def.events.length);
  });

  it('音色上書き: 範囲外・未指定はスタイル既定に落ちる', () => {
    const bad = arrangePiece(piece, 'eurobeat', { lead: 0, backing: 99 });
    const voiceOf = (ch: number) => bad.events.find((e) => e.reg === 0x30 + ch)!.val >> 4;
    expect(voiceOf(2)).toBe(4); // フルート
    expect(voiceOf(3)).toBe(8); // オルガン
    expect(voiceOf(4)).toBe(8); // オルガン
  });
});
