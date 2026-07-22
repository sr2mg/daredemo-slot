import { describe, expect, it } from 'vitest';
import { compose, variedChoiceFor } from '../src/core/music/compose.js';
import { PROGRESSIONS } from '../src/core/music/theory.js';
import { arrangePiece, defaultVoicesFor, OPLL_USER_PATCHES } from '../src/ui/opll-arrange.js';

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

const melodicKeyOns = (events: typeof def.events) => events
  .filter((event) => event.reg >= 0x30 && event.reg <= 0x35)
  .sort((a, b) => a.at - b.at);

describe('arrangePiece（Piece → OPLL 6旋律ch + 5リズム音）', () => {
  it('既定音色はフルート主旋律・ピアノ副旋律・オルガン低音・フルート分散和音', () => {
    for (const styleId of ['eurobeat', 'rock', 'ska']) {
      expect(defaultVoicesFor(styleId).lead, styleId).toBe(4);
      expect(defaultVoicesFor(styleId).bass, styleId).toBe(8);
      expect(defaultVoicesFor(styleId).counter, styleId).toBe(3);
      expect(defaultVoicesFor(styleId).ostinato, styleId).toBe(4);
    }
    expect(defaultVoicesFor('eurobeat').backing).toBe(8);
    expect(defaultVoicesFor('ska').backing).toBe(8);
    expect(defaultVoicesFor('rock').backing).toBe(15);
  });

  it('ループ長は拍数どおり、全イベントが曲中に収まる', () => {
    expect(def.duration).toBeCloseTo(piece.beats * spb, 9);
    expect(def.bpm).toBe(170);
    expect(def.bars).toBe(4);
    for (const event of def.events) {
      expect(event.at).toBeGreaterThanOrEqual(0);
      expect(event.at).toBeLessThanOrEqual(def.duration);
    }
  });

  it('固定配線を使わずch0〜5へ割り当て、主旋律とベースを落とさない', () => {
    expect(melodicKeyOns(def.events).length).toBe(def.voiceStats.assigned);
    expect(def.voiceStats.maxConcurrent).toBeLessThanOrEqual(6);
    expect(def.voiceStats.parts.lead.assigned).toBe(piece.melody.length);
    expect(def.voiceStats.parts.lead.dropped).toBe(0);
    expect(def.voiceStats.parts.bass.assigned).toBe(piece.bass.length);
    expect(def.voiceStats.parts.bass.dropped).toBe(0);
    expect(new Set(melodicKeyOns(def.events).map((event) => event.reg - 0x30)).size).toBeGreaterThan(1);
  });

  it('7音以上が重なる瞬間は低優先度声部を落とし、6音以内を守る', () => {
    const crowded = {
      ...piece,
      counterMelody: Array.from({ length: 8 }, (_, index) => ({
        beat: 0,
        dur: 2,
        midi: 60 + index,
        velocity: 0.7,
        articulation: 'tenuto' as const,
        role: 'structural' as const,
      })),
    };
    const arranged = arrangePiece(crowded, 'eurobeat');
    expect(arranged.voiceStats.maxConcurrent).toBe(6);
    expect(arranged.voiceStats.parts.counter.dropped).toBeGreaterThan(0);
    expect(arranged.voiceStats.parts.lead.dropped).toBe(0);
    expect(arranged.voiceStats.parts.bass.dropped).toBe(0);
  });

  it('作曲時の強弱を4bit音量へ反映する', () => {
    const dryPiece = {
      ...piece,
      arrangementPlan: {
        ...piece.arrangementPlan,
        sectionA: { ...piece.arrangementPlan.sectionA, echo: false },
        sectionB: { ...piece.arrangementPlan.sectionB, echo: false },
        sections: piece.arrangementPlan.sections.map((section) => ({ ...section, echo: false })),
      },
    };
    const arranged = arrangePiece(dryPiece, 'eurobeat', { lead: 1 });
    const leadOns = melodicKeyOns(arranged.events).filter((event) => event.val >> 4 === 1);
    expect(leadOns).toHaveLength(piece.melody.length);
    expect(new Set(leadOns.map((event) => event.val & 15)).size).toBeGreaterThan(1);
  });

  it('長音のビブラートと和風の揺りを、割当先chのFナンバー更新で掛ける', () => {
    const fnumWrites = def.events.filter((event) => event.reg >= 0x10 && event.reg <= 0x15).length;
    expect(piece.melody.some((note) => note.dur >= 1)).toBe(true);
    expect(fnumWrites).toBeGreaterThan(def.voiceStats.assigned);

    const shakePiece = compose({
      progressionId: 'tanaka-manabe', styleId: 'eurobeat', keyRoot: 0,
      bpm: 170, bars: 4, seed: 1, melodyMode: 'japanese', japaneseScale: 'ritsu',
    });
    const shake = shakePiece.melody.find((note) => note.ornament === 'shake')!;
    const shakeDef = arrangePiece(shakePiece, 'eurobeat', { lead: 1 });
    const keyOn = melodicKeyOns(shakeDef.events).find((event) => (
      event.val >> 4 === 1 && Math.abs(event.at - shake.beat * spb) < 0.0001
    ))!;
    const ch = keyOn.reg - 0x30;
    const pitchWrites = shakeDef.events.filter((event) => (
      event.reg === 0x10 + ch
      && event.at >= shake.beat * spb
      && event.at < (shake.beat + shake.dur) * spb
    ));
    expect(pitchWrites.length).toBeGreaterThan(1);
  });

  it('選ばれた副旋律・分散和音・伴奏だけを6ch予算へ含める', () => {
    const prog = PROGRESSIONS.find((candidate) => candidate.id === 'minor-pedal')!;
    const bigPiece = compose({
      progressionId: prog.id,
      styleId: 'eurobeat',
      keyRoot: 0,
      bpm: 150,
      bars: 40,
      seed: 6,
      melodyMode: 'minor',
      choice: variedChoiceFor(prog, 40, 6),
    });
    const arranged = arrangePiece(bigPiece, 'eurobeat');
    expect(arranged.voiceStats.parts.counter.assigned).toBeGreaterThan(0);
    expect(arranged.voiceStats.parts.ostinato.assigned).toBeGreaterThan(0);
    expect(arranged.voiceStats.parts.backing.assigned).toBeGreaterThan(0);
    expect(arranged.voiceStats.parts.doubling.assigned).toBe(0);
    expect(def.voiceStats.parts.doubling.assigned).toBeGreaterThan(0);
    expect(arranged.voiceStats.maxConcurrent).toBeLessThanOrEqual(6);
    expect(arranged.loopStart).toBeCloseTo(bigPiece.loopStartBeat * 60 / bigPiece.bpm, 9);
    expect(arranged.loopEnd).toBeCloseTo(arranged.duration, 9);
  });

  it('5種のリズム音をYM2413の各ビットへ変換する', () => {
    const prog = PROGRESSIONS.find((candidate) => candidate.id === 'minor-drive')!;
    const bigPiece = compose({
      progressionId: prog.id, styleId: 'rock', keyRoot: 0, bpm: 150,
      bars: 40, seed: 43, melodyMode: 'minor', choice: variedChoiceFor(prog, 40, 43),
    });
    const arranged = arrangePiece(bigPiece, 'rock');
    const hits = arranged.events.filter((event) => event.reg === 0x0e && event.val !== 0x20);
    for (const bit of [0x10, 0x08, 0x04, 0x02, 0x01]) {
      expect(hits.some((event) => (event.val & bit) !== 0), `rhythm bit ${bit.toString(16)}`).toBe(true);
    }
  });

  it('同時刻のドラムはビットを合成して1回で叩く', () => {
    const merged = def.events.find((event) => event.reg === 0x0e && event.val === (0x20 | 0x10 | 0x08));
    expect(merged).toBeDefined();
  });

  it('音色上書きは5パートへ適用し、範囲外だけ既定へ戻す', () => {
    const prog = PROGRESSIONS.find((candidate) => candidate.id === 'minor-pedal')!;
    const bigPiece = compose({
      progressionId: prog.id, styleId: 'eurobeat', keyRoot: 0, bpm: 150,
      bars: 40, seed: 6, melodyMode: 'minor', choice: variedChoiceFor(prog, 40, 6),
    });
    const custom = arrangePiece(bigPiece, 'eurobeat', {
      lead: 1, backing: 3, bass: 13, counter: 6, ostinato: 11,
    });
    const usedVoices = new Set(melodicKeyOns(custom.events).map((event) => event.val >> 4));
    for (const voice of [1, 3, 13, 6, 11]) expect(usedVoices.has(voice), `voice ${voice}`).toBe(true);

    const fallback = arrangePiece(piece, 'nazo-style', { backing: 99 });
    const fallbackVoices = new Set(melodicKeyOns(fallback.events).map((event) => event.val >> 4));
    expect(fallbackVoices.has(4)).toBe(true);
    expect(fallbackVoices.has(8)).toBe(true);
  });

  it('音色0番へ選択したユーザー音色の8レジスタを書き込む', () => {
    const patch = OPLL_USER_PATCHES.find((candidate) => candidate.id === 'metalBell')!;
    const custom = arrangePiece(piece, 'eurobeat', { lead: 0 }, patch.id);
    patch.regs.forEach((value, reg) => {
      expect(custom.events.some((event) => event.at === 0 && event.reg === reg && event.val === value)).toBe(true);
    });
    expect(melodicKeyOns(custom.events).some((event) => event.val >> 4 === 0)).toBe(true);
  });
});
