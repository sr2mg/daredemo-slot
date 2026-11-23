/**
 * 作曲ワークスペース(bgm.html の本体)。
 *
 * 主役は設定フォームではなく曲のタイムライン。上にトランスポート、中央にタイムライン、
 * 左にテイクと保存曲、右に選択対象のインスペクタを置く。エンジンの評価(ブラインド比較・
 * 仮説の検証履歴)と理論の解説は、曲を作る動線から外して別タブへ分ける。
 */

import { useEffect, useRef, useState } from 'react';
import { FormSectionTable } from '../form-section-table.js';
import type { SfxPlayer } from '../sfx-player.js';
import { HelpPanel } from './help.js';
import { Inspector } from './inspector.js';
import { LabPanel } from './lab.js';
import { LibraryPanel } from './library.js';
import { Timeline } from './timeline.js';
import type { TimelineView } from './timeline.js';
import { Transport } from './transport.js';
import { useComposer } from './use-composer.js';
import type { SoundFontControls } from './use-soundfont.js';
import './workspace.css';

type Tab = 'compose' | 'lab' | 'help';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'compose', label: '作曲' },
  { id: 'lab', label: 'ラボ' },
  { id: 'help', label: 'ヘルプ' },
];

/** キー入力を受け取る要素にフォーカスがある間は、Space を再生/停止に使わない。 */
const isTypingTarget = (target: EventTarget | null): boolean => (
  target instanceof HTMLElement
  && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY', 'A'].includes(target.tagName))
);

export function ComposerWorkspace({ player, soundfont, soundOn, onSoundChange }: {
  player: SfxPlayer;
  soundfont: SoundFontControls;
  soundOn: boolean;
  onSoundChange: (on: boolean) => void;
}) {
  const composer = useComposer({
    player,
    pcmRenderer: soundfont.pcmRenderer,
    pcmVoices: soundfont.pcmVoices,
    onPcmNeededChange: soundfont.onPcmNeededChange,
  });
  const [tab, setTab] = useState<Tab>('compose');
  const [view, setView] = useState<TimelineView>('score');
  // 短いループは幅いっぱいに、長い曲はコード名が読める幅で開く(「全体」でいつでも俯瞰できる)。
  const [zoom, setZoom] = useState<number | 'fit'>(() => (composer.formBars <= 16 ? 'fit' : 48));

  // Space で再生/停止。ハンドラは毎レンダリングで変わるので、最新を ref 経由で呼ぶ。
  const toggleRef = useRef(composer.togglePlay);
  toggleRef.current = composer.togglePlay;
  useEffect(() => {
    if (tab !== 'compose') return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      toggleRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tab]);

  const switchTab = (next: Tab): void => {
    if (next === tab) return;
    // タブごとに別の曲を鳴らすので、移るときに止める(鳴りっぱなしの音の出どころが見えなくなる)。
    composer.stop();
    setTab(next);
  };

  return (
    <div className="ws" data-testid="ws">
      <header className="ws-header">
        <h1>作曲スタジオ</h1>
        <nav className="ws-tabs" aria-label="画面">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={tab === item.id ? 'on' : ''}
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => switchTab(item.id)}
              data-testid={`ws-tab-${item.id}`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <label className="ws-sound">
          <input
            type="checkbox"
            checked={soundOn}
            onChange={(e) => {
              if (!e.target.checked) composer.stop();
              onSoundChange(e.target.checked);
            }}
            data-testid="studio-sound-toggle"
          />
          音
        </label>
        <a className="ws-back" href="./">← スロット本体へ</a>
      </header>

      {tab === 'compose' && (
        <>
          <Transport composer={composer} view={view} onViewChange={setView} zoom={zoom} onZoomChange={setZoom} />
          <div className="ws-main">
            <LibraryPanel composer={composer} />
            <main className="ws-center">
              {composer.audition && (
                <div className="ws-banner" data-testid="ws-audition-banner">
                  <span>
                    保存曲「{composer.audition.name}」を試聴中です。編集中の曲は変わっていません。
                  </span>
                  <button
                    type="button"
                    onClick={() => composer.loadIntoEditor({ id: '', name: composer.audition!.name, options: composer.audition!.options })}
                  >
                    編集に読み込む
                  </button>
                  <button type="button" onClick={composer.exitAudition} data-testid="ws-audition-exit">
                    編集中の曲へ戻る
                  </button>
                </div>
              )}
              <Timeline composer={composer} view={view} zoom={zoom} />
              {!composer.readOnly && (
                <details className="ws-drawer" data-testid="st-form-table-toggle">
                  <summary>
                    区間の表（{composer.formSpec.sections.length}区間・すべての宣言を編集）
                    {composer.formPresetId !== null ? ' — 編集するとプリセットから区間列へ展開されます' : ''}
                  </summary>
                  <FormSectionTable
                    form={composer.formSpec}
                    defaults={{ progressionId: composer.prog.id, keyRoot: composer.form.keyRoot, tonality: composer.form.tonality }}
                    issues={composer.formIssues}
                    onChange={(next) => composer.setForm(next, { resetIntro: false })}
                  />
                </details>
              )}
              <p className="panel-note ws-hint">
                目盛りやレーンをクリックでその小節へ移動、<kbd>Space</kbd> で再生 / 停止。
                区間ブロックをクリックすると、右にその区間の操作（ここから再生・ループ・旋律の作り直し）が出ます。
              </p>
            </main>
            <Inspector composer={composer} soundfont={soundfont} />
          </div>
        </>
      )}
      {tab === 'lab' && (
        <>
          <div className="tp tp-status-only" aria-live="polite">
            {composer.progress !== null && <span>🎛 演奏を仕込み中… {Math.round(composer.progress * 100)}%</span>}
            {composer.error && <span className="badge-ng">{composer.error}</span>}
          </div>
          <LabPanel composer={composer} />
        </>
      )}
      {tab === 'help' && <HelpPanel />}

      <p className="panel-note credit-note ws-credit">
        音源コア:{' '}
        <a href="https://github.com/digital-sound-antiques/emu2413" target="_blank" rel="noreferrer">emu2413</a>{' '}
        © Mitsutaka Okazaki（MIT License）— YM2413（OPLL）互換実装。2A03 BGM は NES APU 公開仕様に基づく内蔵実装、
        PCM は SoundFont2 の内蔵サブセット実装です。同梱の{' '}
        <a href="https://github.com/mrbumpy409/GeneralUser-GS" target="_blank" rel="noreferrer">GeneralUser GS</a>{' '}
        © S. Christian Collins は同梱ライセンス（soundfonts/LICENSE.txt）に基づき再配布しています
      </p>
    </div>
  );
}
