/**
 * SoundFont2 の部分読み。目録(pdta)だけ先に読み、鳴らすプリセットの波形だけを後から取りに行く。
 *
 * 数百 MB のフォントでも、1 曲が使うのは数プリセット(数 MB)にすぎない。ファイル全体を
 * メモリへ載せる parseSf2 の代わりに、バイト列の取得口(Sf2ByteSource)越しに必要な範囲だけ読む。
 * 取得口の実体(HTTP の Range 要求・Blob.slice)は UI 層が与え、ここは DOM に依存しない。
 *
 * load() が返すのは通常の Sf2Font(選んだプリセットと、その波形だけを詰め直したもの)なので、
 * 合成側(renderSf2 / renderSf2Bgm)は部分読みを知らない。
 */

import { findSf2Preset, parseSf2Hydra, sf2TagAt, walkSf2Chunks } from './sf2.js';
import type { Sf2ChunkMap, Sf2Font, Sf2Preset, Sf2SampleHeader } from './sf2.js';

/** バイト列の取得口。read は [offset, offset+length) をちょうど返す。 */
export interface Sf2ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<ArrayBuffer>;
}

export interface LazySf2 {
  /** 目録。ゾーンのサンプル位置は元ファイル基準なので、合成には load() の戻り値を使う。 */
  readonly presets: readonly Sf2Preset[];
  /** 目録のプリセット(この LazySf2 の presets の要素)を、波形ごと合成可能なフォントにする。 */
  load(presets: readonly Sf2Preset[]): Promise<Sf2Font>;
}

/**
 * 近いサンプルは 1 回の読み取りにまとめる。すき間がこのサンプル数以下なら、すき間ごと読む
 * (256KB。往復 1 回の待ち時間より、これだけ余分に読むほうが速い)。
 */
const MERGE_GAP_SAMPLES = 131072;
/** サンプル末尾の余白。補間が 1 サンプル先を読むため、詰め直した波形の境界をまたがせない。 */
const TAIL_PAD_SAMPLES = 2;

export interface SampleRange { from: number; to: number }

/** 読み取り範囲を昇順に並べ、重なりと小さなすき間を 1 つにまとめる。 */
export function mergeSampleRanges(ranges: readonly SampleRange[], gap = MERGE_GAP_SAMPLES): SampleRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const merged: SampleRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.from - last.to <= gap) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

/** 目録だけを読んでフォントを開く。波形はまだ読まない。 */
export async function openSf2(source: Sf2ByteSource): Promise<LazySf2> {
  if (source.size < 12) throw new Error('SF2ではないファイルです');
  const head = new DataView(await source.read(0, 12));
  if (sf2TagAt(head, 0) !== 'RIFF' || sf2TagAt(head, 8) !== 'sfbk') throw new Error('SF2ではないファイルです');
  const end = Math.min(source.size, 8 + head.getUint32(4, true));

  let smpl: { at: number; size: number } | null = null;
  let pdta: ArrayBuffer | null = null;
  for (let at = 12; at + 12 <= end;) {
    const header = new DataView(await source.read(at, 12));
    const size = header.getUint32(4, true);
    if (sf2TagAt(header, 0) === 'LIST') {
      const type = sf2TagAt(header, 8);
      if (type === 'sdta') {
        // 波形の位置だけ控える(smpl の後ろに 24bit 拡張の sm24 が続くことがある)。
        const listEnd = Math.min(end, at + 8 + size);
        for (let sub = at + 12; sub + 8 <= listEnd;) {
          const subHeader = new DataView(await source.read(sub, 8));
          const subSize = subHeader.getUint32(4, true);
          if (sf2TagAt(subHeader, 0) === 'smpl') {
            smpl = { at: sub + 8, size: Math.min(subSize, source.size - (sub + 8)) };
            break;
          }
          sub += 8 + subSize + (subSize & 1);
        }
      } else if (type === 'pdta') {
        pdta = await source.read(at + 12, Math.min(size - 4, source.size - (at + 12)));
      }
    }
    at += 8 + size + (size & 1);
  }
  if (!smpl) throw new Error('サンプルデータ(smpl)がありません');
  if (!pdta) throw new Error('目録(pdta)がありません');
  const sampleBase = smpl.at;
  const totalSamples = Math.floor(smpl.size / 2);

  const view = new DataView(pdta);
  const chunks: Sf2ChunkMap = new Map();
  walkSf2Chunks(view, 0, pdta.byteLength, chunks);
  const presets = parseSf2Hydra(view, chunks);
  const indexOf = new Map(presets.map((preset, index) => [preset, index]));

  // 読み込み済み(または読み込み中)の波形。同じサンプルを二度取りに行かない。
  const loaded = new Map<Sf2SampleHeader, Promise<Int16Array>>();
  const built = new Map<string, Promise<Sf2Font>>();

  const fetchSamples = (headers: readonly Sf2SampleHeader[]): void => {
    const missing = headers.filter((header) => !loaded.has(header));
    if (missing.length === 0) return;
    const spanOf = (header: Sf2SampleHeader): SampleRange => ({
      from: Math.min(header.start, totalSamples),
      to: Math.min(Math.max(header.end, header.start), totalSamples),
    });
    for (const range of mergeSampleRanges(missing.map(spanOf))) {
      const block = source
        .read(sampleBase + range.from * 2, (range.to - range.from) * 2)
        .then((buffer) => new Int16Array(buffer));
      for (const header of missing) {
        const span = spanOf(header);
        if (span.from < range.from || span.to > range.to) continue;
        const data = block.then((samples) => samples.subarray(span.from - range.from, span.to - range.from));
        loaded.set(header, data);
        // 失敗した読み取りを覚えない(次の load で取り直す)。
        data.catch(() => loaded.delete(header));
      }
    }
  };

  const build = async (wanted: readonly Sf2Preset[]): Promise<Sf2Font> => {
    const headers = [...new Set(wanted.flatMap((preset) => preset.zones.map((zone) => zone.sample)))];
    fetchSamples(headers);
    const waves = await Promise.all(headers.map((header) => loaded.get(header)!));
    // 使う波形だけを 1 本に詰め直し、サンプル位置を詰め直し後の位置へ写す。
    const total = waves.reduce((sum, wave) => sum + wave.length + TAIL_PAD_SAMPLES, 0);
    const sampleData = new Int16Array(total);
    const moved = new Map<Sf2SampleHeader, Sf2SampleHeader>();
    let base = 0;
    headers.forEach((header, index) => {
      const wave = waves[index]!;
      sampleData.set(wave, base);
      const shift = base - header.start;
      moved.set(header, {
        ...header,
        start: base,
        end: base + wave.length,
        loopStart: header.loopStart + shift,
        loopEnd: header.loopEnd + shift,
      });
      base += wave.length + TAIL_PAD_SAMPLES;
    });
    return {
      presets: wanted.map((preset) => ({
        ...preset,
        zones: preset.zones.map((zone) => ({ ...zone, sample: moved.get(zone.sample)! })),
      })),
      sampleData,
    };
  };

  return {
    presets,
    load(wanted) {
      // 目録の順に揃える(合成側の「最初に見つかったキット」等の代替規則が元フォントと同じ順で働く)。
      const ordered = [...new Set(wanted)]
        .filter((preset) => indexOf.has(preset))
        .sort((a, b) => indexOf.get(a)! - indexOf.get(b)!);
      const key = ordered.map((preset) => indexOf.get(preset)!).join(',');
      const cached = built.get(key);
      if (cached) return cached;
      const font = build(ordered);
      built.set(key, font);
      font.catch(() => built.delete(key));
      return font;
    },
  };
}

/**
 * フォントの重ね(先頭が主、後続が補完)から、指定の (bank, program) を鳴らすのに必要な
 * プリセットだけを読み込む。解決規則は合成側と同じ findSf2Preset(無ければ代替)を目録に対して使う。
 * 戻り値は重ねと同じ順の Sf2Font 列で、そのまま renderSf2 / renderSf2Bgm へ渡せる。
 */
export async function loadSf2Stack(
  fonts: readonly LazySf2[],
  refs: readonly { bank: number; program: number }[],
): Promise<Sf2Font[]> {
  const wanted = fonts.map(() => new Set<Sf2Preset>());
  for (const ref of refs) {
    const hit = findSf2Preset(fonts, ref.bank, ref.program);
    if (hit) wanted[fonts.indexOf(hit.font)]!.add(hit.preset);
  }
  return Promise.all(fonts.map((font, index) => font.load([...wanted[index]!])));
}
