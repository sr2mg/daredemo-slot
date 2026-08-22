import type { ComposeOptions, Piece } from '../core/music/types.js';
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
 * idForはレンダリングキャッシュのキーへ混ぜるので、その曲の波形を変えるレンダラ側の
 * 要因(フォント差替え・実効音色)を必ず含める。曲別(options)に受けるのは、グローバル
 * 音色設定が「焼き込みの無い曲」にだけ効くため — 実効値で組むことで、音色を焼き込み
 * 済みの曲のキャッシュをグローバル設定の変更で無駄に割らない。
 */
export interface BgmPcmRenderer {
  idFor(options: ComposeOptions): string;
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
