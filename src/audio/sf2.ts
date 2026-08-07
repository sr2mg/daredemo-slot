/**
 * SoundFont2の最小パーサ+オフラインPCMレンダラ（外部依存なし）。
 *
 * 対応範囲は「00年代GM/GS音源風のBGMを鳴らす」ための実用サブセット:
 * - プリセット/インスツルメント/サンプルの解決（グローバルゾーン・レイヤ対応）
 * - キー/ベロシティレンジ、ルートキー、粗微調、スケールチューニング、ループ
 * - 音量エンベロープ（delay/attack/hold/decay/sustain/release）
 * - initialAttenuation（EMU互換の0.4倍則。GeneralUser GSはこの挙動前提で調整されている）
 * - exclusiveClass（ハイハットのチョーク等）
 * 非対応: モジュレータ、フィルタ、LFO、コーラス/リバーブ、ステレオ（モノ合成）。
 * 出力はSfxPlayerのPCM経路（Float32Array + loopStart/End）へそのまま渡せる。
 */

/* eslint-disable no-bitwise */

interface Sf2SampleHeader {
  name: string;
  start: number;
  end: number;
  loopStart: number;
  loopEnd: number;
  rate: number;
  originalKey: number;
  correction: number;
  type: number;
}

/** プリセット×インスツルメントを展開済みの発音ゾーン。 */
export interface Sf2Zone {
  keyLo: number;
  keyHi: number;
  velLo: number;
  velHi: number;
  sample: Sf2SampleHeader;
  rootKey: number;
  cents: number;
  scaleTuning: number;
  sampleModes: number;
  attenuationCb: number;
  exclusiveClass: number;
  delaySec: number;
  attackSec: number;
  holdSec: number;
  decaySec: number;
  sustainLevel: number;
  releaseSec: number;
}

export interface Sf2Preset {
  name: string;
  bank: number;
  program: number;
  zones: Sf2Zone[];
}

export interface Sf2Font {
  presets: Sf2Preset[];
  sampleData: Int16Array;
}

const GEN = {
  keyRange: 43,
  velRange: 44,
  initialAttenuation: 48,
  coarseTune: 51,
  fineTune: 52,
  sampleID: 53,
  sampleModes: 54,
  scaleTuning: 56,
  exclusiveClass: 57,
  overridingRootKey: 58,
  instrument: 41,
  delayVolEnv: 33,
  attackVolEnv: 34,
  holdVolEnv: 35,
  decayVolEnv: 36,
  sustainVolEnv: 37,
  releaseVolEnv: 38,
} as const;

/** タイムセント→秒。SF2の既定値-12000は1ms。 */
const timecentsToSec = (tc: number): number => Math.max(0.001, 2 ** (tc / 1200));

type GenMap = Map<number, number>;

interface RawZone {
  gens: GenMap;
}

function readZones(
  bagIndices: [number, number],
  bags: { genNdx: number }[],
  gens: { oper: number; amount: number }[],
  terminalOper: number,
): { global: GenMap | null; locals: RawZone[] } {
  const zones: RawZone[] = [];
  for (let bag = bagIndices[0]; bag < bagIndices[1]; bag++) {
    const genStart = bags[bag]!.genNdx;
    const genEnd = bags[bag + 1]!.genNdx;
    const map: GenMap = new Map();
    for (let g = genStart; g < genEnd; g++) map.set(gens[g]!.oper, gens[g]!.amount);
    zones.push({ gens: map });
  }
  // 最初のゾーンが終端ジェネレータ(instrument/sampleID)を持たなければグローバル。
  const first = zones[0];
  const isGlobal = first !== undefined && !first.gens.has(terminalOper) && zones.length > 1;
  return {
    global: isGlobal ? first.gens : null,
    locals: zones.filter((zone, index) => zone.gens.has(terminalOper) && (index > 0 || !isGlobal)),
  };
}

const rangeOf = (map: GenMap | null, oper: number): [number, number] | null => {
  const value = map?.get(oper);
  if (value === undefined) return null;
  return [value & 0xff, (value >> 8) & 0xff];
};

const valueOf = (
  local: GenMap, global: GenMap | null, oper: number, fallback: number,
): number => local.get(oper) ?? global?.get(oper) ?? fallback;

export function parseSf2(buffer: ArrayBuffer): Sf2Font {
  const view = new DataView(buffer);
  const tag = (at: number): string => String.fromCharCode(
    view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3),
  );
  if (tag(0) !== 'RIFF' || tag(8) !== 'sfbk') throw new Error('SF2ではないファイルです');

  let sampleData: Int16Array | null = null;
  const chunks = new Map<string, { at: number; size: number }>();
  const walkList = (at: number, end: number): void => {
    while (at + 8 <= end) {
      const id = tag(at);
      const size = view.getUint32(at + 4, true);
      if (id === 'LIST') {
        walkList(at + 12, at + 8 + size);
      } else {
        chunks.set(id, { at: at + 8, size });
      }
      at += 8 + size + (size & 1);
    }
  };
  walkList(12, 8 + view.getUint32(4, true));

  const smpl = chunks.get('smpl');
  if (!smpl) throw new Error('サンプルデータ(smpl)がありません');
  sampleData = new Int16Array(buffer, smpl.at, smpl.size / 2);

  const readName = (at: number): string => {
    let name = '';
    for (let i = 0; i < 20; i++) {
      const code = view.getUint8(at + i);
      if (code === 0) break;
      name += String.fromCharCode(code);
    }
    return name;
  };
  const readRecords = <T>(id: string, stride: number, read: (at: number) => T): T[] => {
    const chunk = chunks.get(id);
    if (!chunk) throw new Error(`${id} がありません`);
    const out: T[] = [];
    for (let at = chunk.at; at + stride <= chunk.at + chunk.size; at += stride) out.push(read(at));
    return out;
  };

  const shdr = readRecords('shdr', 46, (at): Sf2SampleHeader => ({
    name: readName(at),
    start: view.getUint32(at + 20, true),
    end: view.getUint32(at + 24, true),
    loopStart: view.getUint32(at + 28, true),
    loopEnd: view.getUint32(at + 32, true),
    rate: view.getUint32(at + 36, true),
    originalKey: view.getUint8(at + 40),
    correction: view.getInt8(at + 41),
    type: view.getUint16(at + 44, true),
  }));
  const phdr = readRecords('phdr', 38, (at) => ({
    name: readName(at),
    program: view.getUint16(at + 20, true),
    bank: view.getUint16(at + 22, true),
    bagNdx: view.getUint16(at + 24, true),
  }));
  const pbag = readRecords('pbag', 4, (at) => ({ genNdx: view.getUint16(at, true) }));
  const pgen = readRecords('pgen', 4, (at) => ({
    oper: view.getUint16(at, true),
    amount: view.getInt16(at + 2, true),
  }));
  const inst = readRecords('inst', 22, (at) => ({
    name: readName(at),
    bagNdx: view.getUint16(at + 20, true),
  }));
  const ibag = readRecords('ibag', 4, (at) => ({ genNdx: view.getUint16(at, true) }));
  const igen = readRecords('igen', 4, (at) => ({
    oper: view.getUint16(at, true),
    amount: view.getInt16(at + 2, true),
  }));

  // レンジ系ジェネレータは符号なしで読む必要がある(lo/hiバイト対)。
  const unsignedAmount = (records: { oper: number; amount: number }[]): void => {
    for (const record of records) {
      if (record.oper === GEN.keyRange || record.oper === GEN.velRange) {
        record.amount = record.amount & 0xffff;
      }
    }
  };
  unsignedAmount(pgen);
  unsignedAmount(igen);

  const presets: Sf2Preset[] = [];
  for (let p = 0; p + 1 < phdr.length; p++) { // 末尾はEOP終端
    const header = phdr[p]!;
    const { global: pGlobal, locals: pLocals } = readZones(
      [header.bagNdx, phdr[p + 1]!.bagNdx], pbag, pgen, GEN.instrument,
    );
    const zones: Sf2Zone[] = [];
    for (const pz of pLocals) {
      const instIndex = pz.gens.get(GEN.instrument)!;
      if (instIndex === undefined || instIndex + 1 >= inst.length + 1) continue;
      const instDef = inst[instIndex];
      if (!instDef) continue;
      const instEnd = inst[instIndex + 1]?.bagNdx ?? ibag.length - 1;
      const { global: iGlobal, locals: iLocals } = readZones(
        [instDef.bagNdx, instEnd], ibag, igen, GEN.sampleID,
      );
      const pKey = rangeOf(pz.gens, GEN.keyRange) ?? rangeOf(pGlobal, GEN.keyRange) ?? [0, 127];
      const pVel = rangeOf(pz.gens, GEN.velRange) ?? rangeOf(pGlobal, GEN.velRange) ?? [0, 127];
      // プリセット層の値ジェネレータはインスツルメント層への相対加算。
      const pAdd = (oper: number): number =>
        (pz.gens.get(oper) ?? pGlobal?.get(oper) ?? 0);
      for (const iz of iLocals) {
        const sample = shdr[iz.gens.get(GEN.sampleID)!];
        if (!sample || sample.type & 0x8000) continue; // ROMサンプルは対象外
        const iKey = rangeOf(iz.gens, GEN.keyRange) ?? rangeOf(iGlobal, GEN.keyRange) ?? [0, 127];
        const iVel = rangeOf(iz.gens, GEN.velRange) ?? rangeOf(iGlobal, GEN.velRange) ?? [0, 127];
        const keyLo = Math.max(pKey[0], iKey[0]);
        const keyHi = Math.min(pKey[1], iKey[1]);
        const velLo = Math.max(pVel[0], iVel[0]);
        const velHi = Math.min(pVel[1], iVel[1]);
        if (keyLo > keyHi || velLo > velHi) continue;
        const iv = (oper: number, fallback: number): number => valueOf(iz.gens, iGlobal, oper, fallback);
        zones.push({
          keyLo, keyHi, velLo, velHi, sample,
          rootKey: (() => {
            const override = iv(GEN.overridingRootKey, -1);
            return override >= 0 ? override : sample.originalKey <= 127 ? sample.originalKey : 60;
          })(),
          cents: (iv(GEN.coarseTune, 0) + pAdd(GEN.coarseTune)) * 100
            + iv(GEN.fineTune, 0) + pAdd(GEN.fineTune) + sample.correction,
          scaleTuning: iv(GEN.scaleTuning, 100),
          sampleModes: iv(GEN.sampleModes, 0),
          attenuationCb: Math.max(0, iv(GEN.initialAttenuation, 0) + pAdd(GEN.initialAttenuation)),
          exclusiveClass: iv(GEN.exclusiveClass, 0),
          delaySec: timecentsToSec(iv(GEN.delayVolEnv, -12000) + pAdd(GEN.delayVolEnv)),
          attackSec: timecentsToSec(iv(GEN.attackVolEnv, -12000) + pAdd(GEN.attackVolEnv)),
          holdSec: timecentsToSec(iv(GEN.holdVolEnv, -12000) + pAdd(GEN.holdVolEnv)),
          decaySec: timecentsToSec(iv(GEN.decayVolEnv, -12000) + pAdd(GEN.decayVolEnv)),
          sustainLevel: 10 ** (-Math.min(1440, Math.max(0, iv(GEN.sustainVolEnv, 0) + pAdd(GEN.sustainVolEnv))) / 200),
          releaseSec: timecentsToSec(iv(GEN.releaseVolEnv, -12000) + pAdd(GEN.releaseVolEnv)),
        });
      }
    }
    presets.push({ name: header.name, bank: header.bank, program: header.program, zones });
  }
  return { presets, sampleData };
}

export interface Sf2Note {
  /** GMプログラム番号(0基点)。ドラムはbank=128で叩く。 */
  program: number;
  bank: number;
  midi: number;
  /** 0..127 */
  velocity: number;
  startSec: number;
  durSec: number;
  /** パート別ミックス係数。 */
  gain: number;
  /** ポルタメント: このMIDIノートの音高から目標へ滑って入る。 */
  glideFromMidi?: number;
}

interface Voice {
  zone: Sf2Zone;
  note: Sf2Note;
  releaseStartSec: number;
  releaseSec: number;
}

function findPreset(font: Sf2Font, bank: number, program: number): Sf2Preset | null {
  return font.presets.find((p) => p.bank === bank && p.program === program)
    ?? (bank === 128
      ? font.presets.find((p) => p.bank === 128) ?? null
      : font.presets.find((p) => p.bank === 0 && p.program === program)
        ?? font.presets.find((p) => p.bank === 0 && p.program === 0)
        ?? null);
}

/** ノート列をモノラルPCMへオフライン合成する(単一ステム)。 */
export function renderSf2(
  font: Sf2Font,
  notes: readonly Sf2Note[],
  sampleRate: number,
  totalSec: number,
): Float32Array {
  return renderSf2Stems(font, notes, sampleRate, totalSec).main;
}

/**
 * 合成は加法なので、1パスで「本線」と「ノート別重み付き送り」の2ステムを出せる。
 * sendWeightは音価比例センド(時間マスキング則: 持続音はウェット、ランはドライ)の受け皿。
 */
export function renderSf2Stems(
  font: Sf2Font,
  notes: readonly Sf2Note[],
  sampleRate: number,
  totalSec: number,
  sendWeight?: (note: Sf2Note) => number,
): { main: Float32Array; send: Float32Array } {
  const out = new Float32Array(Math.ceil(totalSec * sampleRate));
  const send = new Float32Array(sendWeight ? out.length : 0);
  const voices: Voice[] = [];
  const exclusiveActive = new Map<string, Voice>();
  const sorted = [...notes].sort((a, b) => a.startSec - b.startSec);
  for (const note of sorted) {
    const preset = findPreset(font, note.bank, note.program);
    if (!preset) continue;
    for (const zone of preset.zones) {
      if (note.midi < zone.keyLo || note.midi > zone.keyHi) continue;
      if (note.velocity < zone.velLo || note.velocity > zone.velHi) continue;
      const voice: Voice = {
        zone,
        note,
        releaseStartSec: note.startSec + note.durSec,
        releaseSec: zone.releaseSec,
      };
      if (zone.exclusiveClass > 0) {
        // 同一排他クラスの先行声部を即リリースへ落とす(ハイハットのチョーク)。
        const key = `${note.bank}:${zone.exclusiveClass}`;
        const previous = exclusiveActive.get(key);
        if (previous && previous.releaseStartSec > note.startSec) {
          previous.releaseStartSec = note.startSec;
          previous.releaseSec = 0.02;
        }
        exclusiveActive.set(key, voice);
      }
      voices.push(voice);
    }
  }

  const data = font.sampleData;
  for (const voice of voices) {
    const { zone, note } = voice;
    const noteSendWeight = sendWeight ? sendWeight(note) : 0;
    const ratio = (zone.sample.rate / sampleRate)
      * 2 ** (((note.midi - zone.rootKey) * zone.scaleTuning + zone.cents) / 1200);
    // ポルタメント: 開始時は前音の音高、durの半分(最大90ms)かけて目標へ等比で滑る。
    const glideCents = note.glideFromMidi !== undefined ? (note.glideFromMidi - note.midi) * 100 : 0;
    const glideSamples = glideCents !== 0
      ? Math.max(1, Math.floor(Math.min(0.09, note.durSec * 0.5) * sampleRate))
      : 0;
    let currentRatio = glideSamples > 0 ? ratio * 2 ** (glideCents / 1200) : ratio;
    // EMU互換: initialAttenuationは実測0.4倍で効く(fluidsynth互換。GeneralUser前提)。
    const baseAmp = 10 ** (-(zone.attenuationCb * 0.4) / 200)
      * (note.velocity / 127) ** 2
      * note.gain;
    const loops = zone.sampleModes === 1 || zone.sampleModes === 3;
    const startIndex = Math.floor(note.startSec * sampleRate);
    const releaseStartIndex = Math.floor(voice.releaseStartSec * sampleRate);
    const endIndex = Math.min(
      out.length,
      Math.floor((voice.releaseStartSec + voice.releaseSec + 0.05) * sampleRate),
    );
    let position = zone.sample.start;
    const loopStart = zone.sample.loopStart;
    const loopEnd = Math.min(zone.sample.loopEnd, zone.sample.end);
    const attackEnd = zone.delaySec + zone.attackSec;
    const holdEnd = attackEnd + zone.holdSec;
    const decayEnd = holdEnd + zone.decaySec;
    for (let i = startIndex; i < endIndex; i++) {
      if (position + 1 >= zone.sample.end) {
        if (loops && loopEnd > loopStart) position = loopStart + (position - loopEnd);
        else break;
      }
      if (loops && position >= loopEnd && loopEnd > loopStart) {
        position = loopStart + (position - loopEnd);
      }
      const t = (i - startIndex) / sampleRate;
      let env: number;
      if (t < zone.delaySec) env = 0;
      else if (t < attackEnd) env = (t - zone.delaySec) / zone.attackSec;
      else if (t < holdEnd) env = 1;
      else if (t < decayEnd) {
        // 線形dB(等比)でsustainへ降りる。
        env = Math.max(zone.sustainLevel, zone.sustainLevel ** ((t - holdEnd) / zone.decaySec));
      } else env = zone.sustainLevel;
      if (i >= releaseStartIndex) {
        const dtRelease = (i - releaseStartIndex) / sampleRate;
        env *= 0.0001 ** (dtRelease / Math.max(0.005, voice.releaseSec));
        if (env < 0.00005) break;
      }
      const floor = Math.floor(position);
      const frac = position - floor;
      const sample = (data[floor]! + frac * (data[floor + 1]! - data[floor]!)) / 32768;
      const value = sample * env * baseAmp * 0.25;
      out[i] = out[i]! + value;
      if (noteSendWeight > 0) send[i] = send[i]! + value * noteSendWeight;
      if (glideSamples > 0) {
        const elapsed = i - startIndex;
        if (elapsed >= glideSamples) {
          currentRatio = ratio;
        } else if ((elapsed & 31) === 0) {
          // 32サンプルごとの区分等比補間(サンプル毎のpowを避ける)。
          currentRatio = ratio * 2 ** ((glideCents * (1 - elapsed / glideSamples)) / 1200);
        }
      }
      position += currentRatio;
    }
  }
  // クリップはここでは掛けない。ミキサーがバス総和の一箇所でだけソフトクリップする
  // (センドがクリップ済み信号をタップしてミックスが非線形になるのを防ぐ)。
  return { main: out, send };
}
