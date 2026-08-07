import type { ComposeOptions, Piece } from '../core/music/compose.js';
import { renderNesPiece, NES_SAMPLE_RATE } from '../audio/nes-apu.js';
import type { PcmBgmDef } from '../audio/pcm-types.js';
import { arrangePiece } from './opll-arrange.js';
import type { SfxDef } from './opll-core.js';

// 型の所有はaudio層(audio→uiの逆依存を作らない)。既存の参照先として再エクスポート。
export type { PcmBgmDef } from '../audio/pcm-types.js';

export type ComposedBgmDef = (SfxDef & { loopStart: number; loopEnd: number }) | PcmBgmDef;

export const isPcmBgm = (def: ComposedBgmDef): def is PcmBgmDef =>
  'kind' in def && def.kind === 'pcm';

/**
 * チップ音源の代わりに使う外部レンダラ(作曲スタジオのPCM/SoundFont等)。
 * idはレンダリングキャッシュのキーへ混ぜるので、音が変わる要因(フォント差替え)を必ず含める。
 */
export interface BgmPcmRenderer {
  id: string;
  render(piece: Piece, options: ComposeOptions): Promise<ComposedBgmDef>;
}

/**
 * 保存曲の音源指定を、既存プレイヤーが扱えるOPLL列またはPCMへ変換する単一入口。
 * soundChip='pcm'(作曲対象がPCM)の曲は、SoundFont環境が無い文脈(ゲーム本体)では
 * OPLL編曲へ品位よく劣化させる。スタジオではpcmRendererオーバーライドが優先される。
 */
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
