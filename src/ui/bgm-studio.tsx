import { useRef, useState } from 'react';
import { BgmComposerPanel } from './bgm-composer.js';
import { SfxPlayer } from './sfx-player.js';

/**
 * 作曲特化の単独エントリ（bgm.html）。
 *
 * スロット本体（index.html）と分離することで、
 * - ゲーム側バンドルへ作曲専用機能の重量を乗せない
 * - 今後のPCMレンダラ・SoundFont読み込みなど「作曲ページ限定の重い足し算」の置き場を作る
 * 保存曲・音色設定はlocalStorage経由で本体のサウンドテストと共有される。
 */
export function BgmStudio() {
  const playerRef = useRef<SfxPlayer | null>(null);
  if (playerRef.current === null) playerRef.current = new SfxPlayer();
  const [soundOn, setSoundOn] = useState(() => playerRef.current!.enabled);

  return (
    <div className="app bgm-studio">
      <header className="studio-header">
        <h1>作曲スタジオ</h1>
        <label>
          <input
            type="checkbox"
            checked={soundOn}
            onChange={(e) => {
              setSoundOn(e.target.checked);
              playerRef.current?.setEnabled(e.target.checked);
            }}
            data-testid="studio-sound-toggle"
          />
          音（OPLL / 2A03）
        </label>
        <a className="panel-note" href="./">← スロット本体へ</a>
      </header>
      <BgmComposerPanel player={playerRef.current!} />
      <p className="panel-note credit-note">
        音源コア:{' '}
        <a href="https://github.com/digital-sound-antiques/emu2413" target="_blank" rel="noreferrer">
          emu2413
        </a>{' '}
        © Mitsutaka Okazaki（MIT License）— YM2413（OPLL）互換実装。2A03 BGM は NES APU 公開仕様に基づく内蔵実装です
      </p>
    </div>
  );
}
