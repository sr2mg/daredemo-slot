import type { SfxName } from './opll-core.js';
import type { SfxPlayer } from './sfx-player.js';

/**
 * サウンドテスト（レトロゲームのサウンドテストモード風）。
 * 効果音を単体で試聴できる。ボタンクリックはユーザー操作なので
 * AudioContext の自動再生制限もここで解除される。
 * BGM の試聴は「BGM 作成」パネルで（プリセット曲も自作曲もそちらに並ぶ）。
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

export function SoundTestPanel({ player }: { player: SfxPlayer }) {
  return (
    <details className="panel">
      <summary>サウンドテスト（OPLL）</summary>
      <div className="panel-body">
        <p className="panel-note">
          効果音を単体で試聴できます。「効果音（OPLL）」のチェックが OFF のときは鳴りません。
          ベット/レバーの音色は上のドロップダウンの選択が反映されます。BGM の試聴は下の
          「BGM 作成」パネルでどうぞ。
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
      </div>
    </details>
  );
}
