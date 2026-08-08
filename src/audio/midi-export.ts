/**
 * PieceをGM準拠のSMF(format 1)へ書き出す。
 *
 * 音の決定はPCM編曲(pcm-arrange.tsのarrangeSf2Parts)へ委譲し、そこで確定した
 * プログラム(スタイル既定+受け渡しleadColor+上書き)・ベロシティ(拍節アクセント込み)・
 * ドラムキー(オープンハット=GM46)をそのままイベント化する。用途はDAWでの再編集と、
 * 様式実測(SMF計測)との自作曲照合。チップ(OPLL/2A03)の曲も同じGM写像で書き出す。
 *
 * - format 1 / PPQ 480 / トラック0=テンポ・拍子・ループマーカー
 * - パート=トラック。チャンネルはドラムのみ10ch(0基点9)、他はパート固定
 * - bank>0はCC0(MSB)+CC32(LSB=0)のGS流。bank128はドラムチャンネル自体で表現
 * - ミックスの縦(PART_GAINS)はCC7、舞台のパン(ROLE_STAGE)はCC10へ写す
 * - ループはmarkerメタ(loopStart/loopEnd)。SMF標準にループは無いため、これは
 *   DAWで見える慣習マーカーであって再生時の自動ループではない
 * - ランニングステータスは使わない(全イベントにステータスバイトを書く)。
 *   サイズより、テスト・外部ツールでのバイト列検査のしやすさを取る
 */
import type { Piece } from '../core/music/compose.js';
import { arrangeSf2Parts } from './pcm-arrange.js';
import type { PcmPart, PcmVoiceOverride } from './pcm-arrange.js';
import { ROLE_STAGE } from './stage.js';
import type { Sf2Note } from './sf2.js';

const PPQ = 480;

/** パート→MIDIチャンネル(0基点)。9はGM規約でパーカッション。 */
const PART_CHANNELS: Record<PcmPart, number> = {
  lead: 0,
  duet: 1,
  counter: 2,
  ostinato: 3,
  backing: 4,
  bass: 5,
  drums: 9,
};

const clamp7 = (value: number): number => Math.max(0, Math.min(127, Math.round(value)));

/** 可変長数量(VLQ)。SMFのデルタタイムとメタ長の共通表現。 */
function vlq(value: number): number[] {
  let rest = Math.max(0, Math.round(value));
  const bytes = [rest & 0x7f];
  while ((rest >>= 7) > 0) bytes.unshift((rest & 0x7f) | 0x80);
  return bytes;
}

/**
 * 同tickの順序: ノートオフ→CC/プログラム→ノートオン。
 * 同音再打鍵の消音と、発音前の音色確定を保証する。
 */
interface MidiEvent {
  tick: number;
  order: 0 | 1 | 2;
  bytes: readonly number[];
}

function trackChunk(events: MidiEvent[]): number[] {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let lastTick = 0;
  for (const event of sorted) {
    body.push(...vlq(event.tick - lastTick), ...event.bytes);
    lastTick = event.tick;
  }
  body.push(...vlq(0), 0xff, 0x2f, 0x00);
  return [
    0x4d, 0x54, 0x72, 0x6b, // 'MTrk'
    (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff,
    ...body,
  ];
}

const meta = (type: number, data: readonly number[]): number[] => [0xff, type, ...vlq(data.length), ...data];
const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0) & 0x7f);

function partTrack(part: PcmPart, notes: readonly Sf2Note[], spb: number): number[] {
  const channel = PART_CHANNELS[part];
  const events: MidiEvent[] = [
    { tick: 0, order: 1, bytes: meta(0x03, ascii(part)) },
    // ミックスの縦(gainはパート内で一定)と舞台のパンをCCへ写す。
    { tick: 0, order: 1, bytes: [0xb0 | channel, 7, clamp7((notes[0]!.gain ?? 1) * 127)] },
    { tick: 0, order: 1, bytes: [0xb0 | channel, 10, clamp7(64 + ROLE_STAGE[part].pan * 63)] },
  ];
  let lastBank = -1;
  let lastProgram = -1;
  const sorted = [...notes].sort((a, b) => a.startSec - b.startSec);
  for (const note of sorted) {
    const tick = Math.round((note.startSec / spb) * PPQ);
    const durTicks = Math.max(1, Math.round((note.durSec / spb) * PPQ));
    if (note.program !== lastProgram || note.bank !== lastBank) {
      // ドラム(bank128)はチャンネル自体が語彙なのでバンクセレクトを送らない。
      if (note.bank !== lastBank && note.bank < 128) {
        events.push({ tick, order: 1, bytes: [0xb0 | channel, 0, note.bank & 0x7f] });
        events.push({ tick, order: 1, bytes: [0xb0 | channel, 32, 0] });
      }
      events.push({ tick, order: 1, bytes: [0xc0 | channel, note.program & 0x7f] });
      lastBank = note.bank;
      lastProgram = note.program;
    }
    const key = clamp7(note.midi);
    events.push({ tick, order: 2, bytes: [0x90 | channel, key, clamp7(note.velocity)] });
    events.push({ tick: tick + durTicks, order: 0, bytes: [0x80 | channel, key, 0] });
  }
  return trackChunk(events);
}

/** PieceをSMF(format 1)のバイト列へ変換する。overridesは試聴と同じPCM音色上書き。 */
export function pieceToSmf(piece: Piece, overrides: PcmVoiceOverride = {}): Uint8Array {
  const spb = 60 / piece.bpm;
  const parts = arrangeSf2Parts(piece, overrides);
  const microsecondsPerQuarter = Math.round(60_000_000 / piece.bpm);
  const conductor = trackChunk([
    { tick: 0, order: 1, bytes: meta(0x03, ascii('daredemo-slot bgm')) },
    {
      tick: 0,
      order: 1,
      bytes: meta(0x51, [
        (microsecondsPerQuarter >>> 16) & 0xff,
        (microsecondsPerQuarter >>> 8) & 0xff,
        microsecondsPerQuarter & 0xff,
      ]),
    },
    { tick: 0, order: 1, bytes: meta(0x58, [4, 2, 24, 8]) }, // 4/4
    { tick: Math.round(piece.loopStartBeat * PPQ), order: 1, bytes: meta(0x06, ascii('loopStart')) },
    { tick: Math.round(piece.beats * PPQ), order: 1, bytes: meta(0x06, ascii('loopEnd')) },
  ]);
  const partTracks = (Object.entries(parts) as [PcmPart, Sf2Note[]][])
    .filter(([, notes]) => notes.length > 0)
    .map(([part, notes]) => partTrack(part, notes, spb));
  const trackCount = 1 + partTracks.length;
  const header = [
    0x4d, 0x54, 0x68, 0x64, // 'MThd'
    0, 0, 0, 6,
    0, 1, // format 1
    (trackCount >>> 8) & 0xff, trackCount & 0xff,
    (PPQ >>> 8) & 0xff, PPQ & 0xff,
  ];
  return Uint8Array.from([...header, ...conductor, ...partTracks.flat()]);
}
