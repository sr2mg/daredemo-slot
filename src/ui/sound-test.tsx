import { SFX_TRIGGERS } from './sfx-library.js';
import type { SfxPlayer } from './sfx-player.js';

/**
 * サウンドテスト（レトロゲームのサウンドテストモード風）。
 * 効果音を単体で試聴できる。ボタンクリックはユーザー操作なので
 * AudioContext の自動再生制限もここで解除される。
 * 並びは契機表（SFX_TRIGGERS）そのもの = 強度段階の高い順。段階の相対差
 * （告知 > 予告 > 獲得 > 操作）を耳で確かめる用途を兼ねる。
 * BGM の試聴は「BGM 作成」パネルで（プリセット曲も自作曲もそちらに並ぶ）。
 */
export function SoundTestPanel({ player }: { player: SfxPlayer }) {
  return (
    <details className="panel">
      <summary>サウンドテスト（OPLL）</summary>
      <div className="panel-body">
        <p className="panel-note">
          効果音を単体で試聴できます。「効果音（OPLL）」のチェックが OFF のときは鳴りません。
          [int-N] は強度段階（1 = 操作音の基準 … 5 = 告知の最大値）で、契機に自作の音を
          割り当てても段階は変わりません。BGM の試聴は下の「BGM 作成」パネルでどうぞ。
        </p>
        <div className="soundtest-grid">
          {SFX_TRIGGERS.map((item) => (
            <button
              key={item.name}
              className="form-mini-btn"
              onClick={() => player.play(item.name)}
              data-testid={`soundtest-${item.name}`}
            >
              ♪ {item.label} [int-{item.tier}]
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}
