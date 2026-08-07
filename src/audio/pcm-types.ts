/**
 * オーディオ層の出力形式。UIプレイヤー(sfx-player)がそのまま再生できる
 * モノラル/ステレオPCM+ループ区間。audio層はuiへ依存しないため、型はここが所有し、
 * ui/bgm-audio.tsは互換のため再エクスポートする。
 */
export interface PcmBgmDef {
  kind: 'pcm';
  /** モノラル、またはステレオの左チャンネル。 */
  wave: Float32Array;
  /** ステレオの右チャンネル。省略時はモノラル再生(2A03等)。waveと同一長であること。 */
  waveRight?: Float32Array;
  sampleRate: number;
  /** 初回は0秒から再生し、2周目以降はこの区間だけをループする。 */
  loopStart: number;
  loopEnd: number;
}
