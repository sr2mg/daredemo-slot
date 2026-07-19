import type { ComposeOptions, Piece } from '../core/music/compose.js';
import { renderNesPiece, NES_SAMPLE_RATE } from './nes-apu.js';
import { arrangePiece } from './opll-arrange.js';
import type { SfxDef } from './opll-core.js';

export interface PcmBgmDef {
  kind: 'pcm';
  wave: Float32Array;
  sampleRate: number;
}

export type ComposedBgmDef = SfxDef | PcmBgmDef;

export const isPcmBgm = (def: ComposedBgmDef): def is PcmBgmDef =>
  'kind' in def && def.kind === 'pcm';

/** 保存曲の音源指定を、既存プレイヤーが扱えるOPLL列またはPCMへ変換する単一入口。 */
export function arrangeComposedBgm(piece: Piece, options: ComposeOptions): ComposedBgmDef {
  if (options.soundChip === 'nes2a03') {
    return { kind: 'pcm', wave: renderNesPiece(piece, options.nes), sampleRate: NES_SAMPLE_RATE };
  }
  return arrangePiece(piece, options.styleId, options.voices);
}
