import { useRef, useState } from 'react';
import { ComposerWorkspace } from './composer/workspace.js';
import { useSoundFont } from './composer/use-soundfont.js';
import { SfxPlayer } from './sfx-player.js';

/**
 * 作曲特化の単独エントリ（bgm.html）。
 *
 * スロット本体（index.html）と分離することで、
 * - ゲーム側バンドルへ作曲専用機能の重量を乗せない
 * - PCM(SoundFont)レンダラなど「作曲ページ限定の重い足し算」の置き場を作る
 * 保存曲・音色設定はlocalStorage経由で本体(ボーナスBGMの割り当て)と共有される。
 *
 * ここはプレイヤーと SoundFont の調達(use-soundfont.ts)を持つだけで、画面は
 * composer/workspace.tsx が組む。
 */
export function BgmStudio() {
  const playerRef = useRef<SfxPlayer | null>(null);
  if (playerRef.current === null) playerRef.current = new SfxPlayer();
  const [soundOn, setSoundOn] = useState(() => playerRef.current!.enabled);
  const soundfont = useSoundFont();

  return (
    <ComposerWorkspace
      player={playerRef.current}
      soundfont={soundfont}
      soundOn={soundOn}
      onSoundChange={(on) => {
        setSoundOn(on);
        playerRef.current?.setEnabled(on);
      }}
    />
  );
}
