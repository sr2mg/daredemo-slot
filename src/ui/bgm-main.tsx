import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BgmComposerPanel } from './bgm-composer.js';
import { SfxPlayer } from './sfx-player.js';
import './styles.css';

/**
 * BGMスタジオ（bgm.html）。スロット本体からBGM作成だけを切り出した独立ページで、
 * 本体には無いハミング声部（klattschフォルマント合成）のミックスが使える。
 * 保存曲・割り当て・音量は localStorage 経由で本体ページと共有される。
 */
function BgmStudio() {
  const playerRef = useRef<SfxPlayer | null>(null);
  if (playerRef.current === null) playerRef.current = new SfxPlayer();
  const player = playerRef.current;
  const [soundOn, setSoundOn] = useState(() => player.enabled);
  return (
    <div className="app">
      <header className="header">
        <h1>BGMスタジオ</h1>
        <label>
          <input
            type="checkbox"
            checked={soundOn}
            onChange={(e) => {
              player.setEnabled(e.target.checked);
              setSoundOn(e.target.checked);
            }}
          />
          音
        </label>
        <a href="./index.html">← スロット本体へ</a>
      </header>
      <BgmComposerPanel player={player} vocal />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BgmStudio />
  </StrictMode>,
);
