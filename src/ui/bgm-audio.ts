import type { ComposeOptions, Piece } from '../core/music/compose.js';
import { renderNesPiece, NES_SAMPLE_RATE } from './nes-apu.js';
import { arrangePiece } from './opll-arrange.js';
import type { SfxDef } from './opll-core.js';

export interface PcmBgmDef {
  kind: 'pcm';
  wave: Float32Array;
  sampleRate: number;
  /** 初回は0秒から再生し、2周目以降はこの区間だけをループする。 */
  loopStart: number;
  loopEnd: number;
}

export type ComposedBgmDef = (SfxDef & { loopStart: number; loopEnd: number }) | PcmBgmDef;

export const isPcmBgm = (def: ComposedBgmDef): def is PcmBgmDef =>
  'kind' in def && def.kind === 'pcm';

/** 保存曲の音源指定を、既存プレイヤーが扱えるOPLL列またはPCMへ変換する単一入口。 */
export function arrangeComposedBgm(piece: Piece, options: ComposeOptions): ComposedBgmDef {
  if (options.soundChip === 'nes2a03') {
    const spb = 60 / piece.bpm;
    return {
      kind: 'pcm',
      wave: renderNesPiece(piece, options.nes),
      sampleRate: NES_SAMPLE_RATE,
      loopStart: piece.loopStartBeat * spb,
      loopEnd: piece.beats * spb,
    };
  }
  return arrangePiece(piece, options.styleId, options.voices, options.opllUserPatch);
}
