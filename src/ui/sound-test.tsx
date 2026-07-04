import type { BgmName } from './bgm.js';
import type { SfxName } from './opll-core.js';
import type { SfxPlayer } from './sfx-player.js';

/**
 * サウンドテスト（レトロゲームのサウンドテストモード風）。
 * 効果音と BGM を単体で試聴できる。ボタンクリックはユーザー操作なので
 * AudioContext の自動再生制限もここで解除される。
 */

const SFX_ITEMS: readonly { name: SfxName; label: string }[] = [
  { name: 'bet', label: 'ベット（G4+E5）' },
  { name: 'lever', label: 'レバーオン（C5+A5）' },
  { name: 'betLever', label: 'ベット→レバー連結' },
  { name: 'reelStop', label: 'リール停止' },
  { name: 'replay', label: 'リプレイ' },
  { name: 'payout', label: 'コイン払い出し' },
  { name: 'kyuin', label: 'キュイン（告知）' },
  { name: 'fanfare', label: 'ファンファーレ（ボーナス開始）' },
  { name: 'siren', label: 'サイレン（放出開始）' },
  { name: 'rush', label: 'ラッシュ（AT・CT突入）' },
];

const BGM_ITEMS: readonly { name: BgmName; label: string }[] = [
  { name: 'bb', label: 'BB中BGM（8小節ループ）' },
  { name: 'rb', label: 'RB中BGM（4小節ループ）' },
];

export function SoundTestPanel({ player }: { player: SfxPlayer }) {
  return (
    <details className="panel">
      <summary>サウンドテスト（OPLL）</summary>
      <div className="panel-body">
        <p className="panel-note">
          効果音と BGM を単体で試聴できます。「効果音（OPLL）」のチェックが OFF のときは鳴りません。
          ベット/レバーの音色は上のドロップダウンの選択が反映されます。
        </p>
        <div className="soundtest-grid">
          {SFX_ITEMS.map((item) => (
            <button
              key={item.name}
              className="form-mini-btn"
              onClick={() => player.play(item.name)}
              data-testid={`soundtest-${item.name}`}
            >
              ♪ {item.label}
            </button>
          ))}
        </div>
        <div className="panel-controls">
          {BGM_ITEMS.map((item) => (
            <button
              key={item.name}
              className="form-mini-btn"
              onClick={() => player.playBgm(item.name)}
              data-testid={`soundtest-bgm-${item.name}`}
            >
              ▶ {item.label}
            </button>
          ))}
          <button className="form-mini-btn" onClick={() => player.stopBgm()} data-testid="soundtest-bgm-stop">
            ■ BGM 停止
          </button>
        </div>
      </div>
    </details>
  );
}
