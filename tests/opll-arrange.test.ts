import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { variedChoiceFor } from '../src/core/music/harmony-plan.js';
import { PROGRESSIONS } from '../src/core/music/theory.js';
import { arrangePiece, defaultVoicesFor, kickMidiAt, legatoBass, OPLL_USER_PATCHES } from '../src/audio/opll-arrange.js';
import { freqToFnum } from '../src/audio/opll-core.js';
import { midiFreq } from '../src/audio/pitch.js';

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
    const echoPiece = compose({
      progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, bars: 4, seed: 256,
    });
    expect(echoPiece.arrangementPlan.sections[0]!.echo).toBe(true);
    expect(arrangePiece(echoPiece, 'eurobeat').voiceStats.parts.doubling.assigned).toBeGreaterThan(0);
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

describe('クラブ系様式のOPLLリズム(レジスタ領域の工夫。コンプ等の後段処理は入れない)', () => {
  const club = compose({
    progressionId: 'royal-pop', styleId: 'garage2step', keyRoot: 0, bpm: 132, bars: 4, seed: 11,
    grooveFeel: 'shuffle16', engineRev: 4,
  });
  const arranged = arrangePiece(club, 'garage2step');
  const spb132 = 60 / 132;
  const kicks = club.drums.filter((drum) => drum.inst === 'kick').sort((a, b) => a.beat - b.beat);

  it('BDは打点ごとにベースの根音(サブ帯E1〜D#2)へ調律され、5音の音量は様式のバランスで初期化される', () => {
    const bassAt = (beat: number) => club.bass.find((n) => n.beat <= beat && beat < n.beat + n.dur)
      ?? [...club.bass].filter((n) => n.beat <= beat).sort((a, b) => b.beat - a.beat)[0];
    const midis = kicks.map((kick) => kickMidiAt(club, kick.beat));
    expect(new Set(midis).size).toBeGreaterThan(1); // 進行に沿って動く
    kicks.forEach((kick, i) => {
      const midi = midis[i]!;
      expect(midi).toBeGreaterThanOrEqual(28);
      expect(midi).toBeLessThan(40);
      expect((bassAt(kick.beat)!.midi - midi) % 12).toBe(0); // ベースと同じ音名
      const { fnum, blk } = freqToFnum(midiFreq(midi));
      const at = kick.beat * spb132;
      const lo = arranged.events.filter((e) => e.reg === 0x16 && e.at <= at).sort((a, b) => a.at - b.at).at(-1)!.val;
      const hi = arranged.events.filter((e) => e.reg === 0x26 && e.at <= at).sort((a, b) => a.at - b.at).at(-1)!.val;
      expect(lo).toBe(fnum & 0xff);
      expect(hi).toBe((blk << 1) | ((fnum >> 8) & 1));
    });
    const init36 = arranged.events.filter((e) => e.at === 0 && e.reg === 0x36).map((e) => e.val);
    expect(init36.at(-1)).toBe(0); // kick は基準(最大)
    const init37 = arranged.events.filter((e) => e.at === 0 && e.reg === 0x37).map((e) => e.val);
    expect(init37.at(-1)).toBe((4 << 4) | 2); // hat -12dB(上位) / snare -6dB(下位)
  });

  it('ゴーストスネアは主打より3段(約-10dB)小さい音量レジスタでキーオンされる', () => {
    const snares = club.drums.filter((drum) => drum.inst === 'snare');
    const ghost = snares.find((drum) => (drum.velocity ?? 1) < 0.5);
    const main = snares.find((drum) => (drum.velocity ?? 1) >= 0.99);
    expect(ghost).toBeDefined();
    expect(main).toBeDefined();
    const snareLevelAt = (beat: number): number => {
      const at = beat * spb132;
      const writes = arranged.events.filter((e) => e.reg === 0x37 && e.at <= at).sort((a, b) => a.at - b.at);
      return writes.at(-1)!.val & 0x0f;
    };
    expect(snareLevelAt(main!.beat)).toBe(2);
    expect(snareLevelAt(ghost!.beat)).toBe(5);
  });

  it('サブキックは旋律chで音色14をBDと同じ音高の2オクターブ上からスイープさせ、主旋律とベースを落とさない', () => {
    expect(arranged.voiceStats.parts.subKick.assigned).toBe(kicks.length);
    expect(arranged.voiceStats.parts.subKick.dropped).toBe(0);
    expect(arranged.voiceStats.parts.lead.dropped).toBe(0);
    expect(arranged.voiceStats.parts.bass.dropped).toBe(0);
    const at = kicks[0]!.beat * spb132;
    const keyOn = arranged.events.find((e) => e.at === at && e.reg >= 0x30 && e.reg <= 0x35 && e.val >> 4 === 14);
    expect(keyOn).toBeDefined();
    const ch = keyOn!.reg - 0x30;
    const pitches = arranged.events.filter((e) => e.reg === 0x10 + ch && e.at >= at && e.at <= at + 0.045);
    expect(pitches.length).toBeGreaterThanOrEqual(8); // 5ms 刻み × 40ms
    // 着地点は BD と同じ音高(fnum 下位 8bit が一致)
    const { fnum } = freqToFnum(midiFreq(kickMidiAt(club, kicks[0]!.beat)));
    expect(pitches.at(-1)!.val).toBe(fnum & 0xff);
  });

  it('ベースは次の低音打点の直前まで伸び、譜面より短くならない', () => {
    const legato = legatoBass(club.bass, club.beats);
    const sorted = [...club.bass].sort((a, b) => a.beat - b.beat);
    expect(legato.length).toBe(sorted.length);
    legato.forEach((note, index) => {
      expect(note.dur).toBeGreaterThanOrEqual(sorted[index]!.dur);
      const next = sorted[index + 1]?.beat ?? club.beats;
      expect(note.beat + note.dur).toBeLessThanOrEqual(next + 1e-9);
    });
    expect(legato.some((note, index) => note.dur > sorted[index]!.dur)).toBe(true);
  });

  it('rhythm を宣言しない様式は従来どおり: 音量レジスタは t=0 の固定値だけで、サブキックも鳴らない', () => {
    const levelWrites = def.events.filter((e) => e.reg >= 0x36 && e.reg <= 0x38);
    expect(levelWrites.every((e) => e.at === 0)).toBe(true);
    expect(levelWrites.map((e) => e.val)).toEqual([0x04, 0x24, 0x24]);
    expect(def.events.filter((e) => e.at === 0 && e.reg === 0x26).map((e) => e.val)).toEqual([0x05]);
    expect(def.voiceStats.parts.subKick.assigned).toBe(0);
  });
});
