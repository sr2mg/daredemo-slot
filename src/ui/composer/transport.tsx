/**
 * トランスポート(常に見える操作列): 生成・再生・位置・ループ・音量・表示・書き出し。
 * 設定を変えるたびにスクロールで往復しないよう、鳴らす操作はここへ集める。
 */

import { useEffect, useRef, useState } from 'react';
import { beatToSeconds, tempoMapOf } from '../../core/music/tempo.js';
import { capabilitiesFor } from '../../core/music/sound-capabilities.js';
import { STYLES } from '../../core/music/theory.js';
import { formatBarBeat, formatClock } from './piece-view.js';
import type { TimelineView } from './timeline.js';
import type { Composer } from './use-composer.js';

export const ZOOM_STEPS: readonly (number | 'fit')[] = ['fit', 24, 36, 48, 64, 96, 128];

/** 現在位置の表示。再生中だけ自前のタイマーで更新し、画面全体を再描画させない。 */
function PositionReadout({ composer }: { composer: Composer }) {
  const { piece, playing, cursorBeat, positionBeat } = composer;
  const [beat, setBeat] = useState(cursorBeat);
  useEffect(() => {
    setBeat(cursorBeat);
    if (!playing) return undefined;
    const timer = setInterval(() => setBeat(positionBeat() ?? cursorBeat), 100);
    return () => clearInterval(timer);
  }, [playing, cursorBeat, positionBeat]);
  if (!piece) return <span className="tp-position">—</span>;
  const tempo = tempoMapOf(piece);
  return (
    <span className="tp-position" data-testid="tp-position" title="小節.拍 / 総小節数 ・ 経過時間 / 曲の長さ">
      <b>{formatBarBeat(beat)}</b> / {piece.beats / 4}小節
      <span className="tp-clock">
        {formatClock(beatToSeconds(tempo, Math.min(beat, piece.beats)))} / {formatClock(beatToSeconds(tempo, piece.beats))}
      </span>
    </span>
  );
}

/** 様式から新しい曲を始めるダイアログ。カードを選ぶと、その様式の既定で 1 曲作って鳴らす。 */
function StylePicker({ composer, onClose }: { composer: Composer; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog ref={ref} className="ws-dialog" onClose={onClose} data-testid="ws-style-picker">
      <header>
        <h3>様式から新しく始める</h3>
        <button type="button" className="ws-quiet-btn" onClick={onClose}>✕</button>
      </header>
      <p className="panel-note">
        様式を選ぶと、テンポ・グルーヴ・旋律語法・推奨進行をその既定に合わせて 1 曲作ります。
        いまの曲はテイクに残るので、いつでも戻れます。曲型・キー・音源はいまの設定を引き継ぎます。
      </p>
      <div className="ws-style-grid">
        {STYLES.map((style) => (
          <button
            key={style.id}
            type="button"
            className={`ws-style-card${style.id === composer.form.styleId ? ' current' : ''}`}
            onClick={() => {
              composer.startFromStyle(style.id);
              onClose();
            }}
            data-testid={`ws-style-${style.id}`}
          >
            <b>{style.name}</b>
            <span>{style.feel}</span>
            <small>BPM {style.defaults.bpm}</small>
          </button>
        ))}
      </div>
    </dialog>
  );
}

export function Transport({ composer, view, onViewChange, zoom, onZoomChange }: {
  composer: Composer;
  view: TimelineView;
  onViewChange: (view: TimelineView) => void;
  zoom: number | 'fit';
  onZoomChange: (zoom: number | 'fit') => void;
}) {
  const { form, patch, piece, playing, stale, progress, exporting, readOnly } = composer;
  const [picking, setPicking] = useState(false);
  const busy = progress !== null;
  const zoomIndex = ZOOM_STEPS.indexOf(zoom);
  const chipLabel = capabilitiesFor(composer.viewOptions?.soundChip ?? form.soundChip).label;
  const finalEnding = piece !== null && piece.ending !== 'loop';

  return (
    <div className="tp" data-testid="tp">
      <div className="tp-group">
        <button
          type="button"
          className="tp-primary"
          onClick={composer.composeNew}
          disabled={busy || readOnly}
          title="新しいシードで曲全体を作り直して再生します"
          data-testid="st-compose"
        >
          🎲 新しく作る
        </button>
        <button
          type="button"
          onClick={composer.varyChords}
          disabled={busy || readOnly || !composer.canVaryChords}
          title="現在とは違う、安全なコード変化レシピを抽選します"
          data-testid="st-chord-variation"
        >
          🎹 コード変化
        </button>
        <button type="button" onClick={() => setPicking(true)} disabled={readOnly} data-testid="ws-new-from-style">
          ＋ 様式から
        </button>
      </div>

      <div className="tp-group">
        <button
          type="button"
          className={`tp-play${playing && !stale ? ' playing' : ''}`}
          onClick={composer.togglePlay}
          disabled={!piece || busy}
          title={stale ? '変更を反映して、いまの位置から鳴らし直します (Space)' : playing ? '停止 (Space)' : '再生 (Space)'}
          data-testid="tp-play"
        >
          {stale ? '↻ 反映' : playing ? '■ 停止' : '▶ 再生'}
        </button>
        <button
          type="button"
          onClick={() => {
            composer.stop();
            composer.seek(0);
          }}
          disabled={!piece}
          title="曲の頭へ戻る"
          data-testid="tp-rewind"
        >
          ⏮
        </button>
        <PositionReadout composer={composer} />
      </div>

      <div className="tp-group">
        <label className="tp-toggle" title={finalEnding ? 'この曲型は終止で閉じるので、最後まで鳴って止まります' : '最終小節から頭へ戻って繰り返します'}>
          <input
            type="checkbox"
            checked={form.loop && !finalEnding}
            disabled={finalEnding}
            onChange={(e) => patch({ loop: e.target.checked })}
            data-testid="tp-loop"
          />
          ループ
        </label>
        <label className="tp-toggle" title="選択中の区間だけを繰り返します（区間ブロックをクリックして選ぶ）">
          <input
            type="checkbox"
            checked={composer.sectionLoop && composer.selectedBlock !== null}
            disabled={composer.selectedBlock === null}
            onChange={(e) => composer.setSectionLoop(e.target.checked)}
            data-testid="tp-section-loop"
          />
          区間ループ{composer.selectedBlock ? `（${composer.selectedBlock.id}）` : ''}
        </label>
        <label className="tp-volume">
          🔊
          <input
            type="range"
            min={0}
            max={100}
            value={composer.volume}
            onChange={(e) => composer.setVolume(Number(e.target.value))}
            data-testid="st-volume"
          />
          <span>{composer.volume}</span>
        </label>
      </div>

      <div className="tp-group">
        <div className="tp-segment" role="group" aria-label="表示">
          <button
            type="button"
            className={view === 'score' ? 'on' : ''}
            aria-pressed={view === 'score'}
            onClick={() => onViewChange('score')}
            title="役割ごとの譜面(ピアノロール)"
            data-testid="tp-view-score"
          >
            譜面
          </button>
          <button
            type="button"
            className={view === 'channels' ? 'on' : ''}
            aria-pressed={view === 'channels'}
            onClick={() => onViewChange('channels')}
            title={`${chipLabel} のチャンネルへ、どの音が割り当てられたか`}
            data-testid="tp-view-channels"
          >
            チャンネル
          </button>
        </div>
        <div className="tp-segment" role="group" aria-label="拡大">
          <button type="button" onClick={() => onZoomChange(ZOOM_STEPS[Math.max(0, zoomIndex - 1)]!)} disabled={zoomIndex <= 0} title="縮小">
            −
          </button>
          <button type="button" className={zoom === 'fit' ? 'on' : ''} onClick={() => onZoomChange('fit')} title="曲全体を幅に収める">
            全体
          </button>
          <button
            type="button"
            onClick={() => onZoomChange(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, zoomIndex + 1)]!)}
            disabled={zoomIndex >= ZOOM_STEPS.length - 1}
            title="拡大"
          >
            ＋
          </button>
        </div>
      </div>

      <details className="tp-export" data-testid="tp-export">
        <summary>書き出し ▾</summary>
        <div className="tp-export-menu">
          <label title="mp3はギャップレスループができないため、ループ本体を指定回数ぶん展開して書き出します">
            周回
            <select
              value={composer.exportLoops}
              onChange={(e) => composer.setExportLoops(Number(e.target.value))}
              disabled={finalEnding}
              data-testid="st-export-loops"
            >
              {[1, 2, 3, 4].map((count) => <option key={count} value={count}>{count}</option>)}
            </select>
          </label>
          <label title="最終周のあと、次のループ頭へ食い込みながら4秒でフェードアウトします">
            <input
              type="checkbox"
              checked={composer.exportFade && !finalEnding}
              disabled={finalEnding}
              onChange={(e) => composer.setExportFade(e.target.checked)}
            />
            フェードアウト
          </label>
          <button
            type="button"
            onClick={() => void composer.exportMp3File()}
            disabled={!piece || busy || exporting !== null}
            title="表示中の曲をMP3で保存します（ミュート/ソロは反映しません）"
            data-testid="st-export-mp3"
          >
            💾 MP3
          </button>
          <button
            type="button"
            onClick={() => void composer.exportMidiFile()}
            disabled={!piece || busy || exporting !== null}
            title="表示中の曲をGM準拠のMIDI(SMF)で保存します。音色・受け渡し・拍節アクセント・ループマーカー込み"
            data-testid="st-export-midi"
          >
            🎼 MIDI
          </button>
        </div>
      </details>

      <div className="tp-status" aria-live="polite">
        {progress !== null && (
          <span data-testid="st-progress">🎛 {chipLabel} で演奏を仕込み中… {Math.round(progress * 100)}%</span>
        )}
        {exporting !== null && (
          <span data-testid="st-export-progress">💾 MP3書き出し中… {Math.round(exporting * 100)}%</span>
        )}
        {composer.error && <span className="badge-ng" data-testid="st-error">{composer.error}</span>}
      </div>

      {picking && <StylePicker composer={composer} onClose={() => setPicking(false)} />}
    </div>
  );
}
