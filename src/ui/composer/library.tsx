/**
 * 左パネル: テイク(この作業中に生成した案)・保存曲・プリセット・BB/RB への割り当て。
 * テイクはタブを閉じるまでの作業履歴で、残したい曲は名前を付けて保存する
 * (保存の実体は ComposeOptions。compose() が決定論なのでそれだけで同じ曲が再現できる)。
 */

import { useState } from 'react';
import { KEYS } from '../../core/music/theory.js';
import { PRESET_SONGS } from '../bgm-library.js';
import type { SavedSong } from '../bgm-library.js';
import { formSummary, songSummary } from '../composer-form.js';
import type { ComposerForm } from '../composer-form.js';
import type { Composer, Take } from './use-composer.js';

const takeSummary = (form: ComposerForm): string => {
  const key = KEYS.find((item) => item.root === form.keyRoot)?.label ?? '?';
  return `${formSummary(form.form)} / ${key}${form.tonality === 'minor' ? 'm' : ''} / BPM${form.bpm}`;
};

const clockOf = (at: number): string => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

function TakeRow({ take, current, composer }: { take: Take; current: boolean; composer: Composer }) {
  return (
    <button
      type="button"
      className={`lib-take${current && !composer.readOnly ? ' current' : ''}`}
      onClick={() => composer.selectTake(take.id)}
      title={`シード ${take.form.seed}`}
      data-testid={`lib-take-${take.id}`}
    >
      <span className="lib-take-note">{take.note}</span>
      <span className="lib-take-time">{clockOf(take.createdAt)}</span>
      <span className="lib-take-summary">{takeSummary(take.form)}</span>
    </button>
  );
}

function SongRow({ song, saved, composer }: { song: SavedSong; saved: boolean; composer: Composer }) {
  const auditioning = composer.audition?.options === song.options;
  return (
    <div className={`lib-song${auditioning ? ' current' : ''}`} data-testid={`lib-song-${song.id}`}>
      <div className="lib-song-name" title={songSummary(song.options)}>{saved ? '★ ' : ''}{song.name}</div>
      <div className="lib-song-actions">
        <button
          type="button"
          onClick={() => composer.auditionSong(song)}
          disabled={composer.progress !== null}
          title="保存された設定のまま試聴します（編集中の曲は変わりません）"
          data-testid={`st-song-play-${song.id}`}
        >
          ▶ 試聴
        </button>
        <button
          type="button"
          onClick={() => composer.loadIntoEditor(song)}
          title="この曲を編集中の曲として読み込みます（いまの曲はテイクに残ります）"
          data-testid={`lib-song-edit-${song.id}`}
        >
          編集
        </button>
        {saved && (
          <button
            type="button"
            className="lib-danger"
            onClick={() => {
              if (window.confirm(`「${song.name}」を削除しますか？ 元に戻せません。`)) composer.deleteSong(song.id);
            }}
            title="保存曲を削除"
            data-testid={`st-song-delete-${song.id}`}
          >
            🗑
          </button>
        )}
      </div>
    </div>
  );
}

export function LibraryPanel({ composer }: { composer: Composer }) {
  const [songName, setSongName] = useState('');
  const { songs, assign, viewOptions } = composer;

  const assignSelect = (slot: 'bb' | 'rb') => (
    <label className="lib-assign">
      <span>{slot.toUpperCase()} 中</span>
      <select
        value={assign[slot]}
        onChange={(e) => composer.updateAssign(slot, e.target.value)}
        data-testid={`st-assign-${slot}`}
      >
        {PRESET_SONGS.map((preset) => <option key={preset.id} value={`preset:${preset.id}`}>{preset.name}</option>)}
        {songs.map((song) => <option key={song.id} value={`song:${song.id}`}>★ {song.name}</option>)}
      </select>
    </label>
  );

  return (
    <aside className="ws-library" data-testid="ws-library">
      <section>
        <h3>テイク</h3>
        <div className="lib-list" data-testid="lib-takes">
          {composer.takes.map((take) => (
            <TakeRow key={take.id} take={take} current={take.id === composer.currentId} composer={composer} />
          ))}
        </div>
        <p className="panel-note">生成するたびに積まれます。クリックで前の案へ戻れます。</p>
      </section>

      <section>
        <h3>保存</h3>
        <div className="lib-save">
          <input
            type="text"
            placeholder={viewOptions ? songSummary(viewOptions) : '曲名'}
            value={songName}
            onChange={(e) => setSongName(e.target.value)}
            data-testid="st-song-name"
          />
          <button
            type="button"
            onClick={() => {
              composer.saveSong(songName);
              setSongName('');
            }}
            disabled={!composer.piece || composer.readOnly}
            data-testid="st-save"
          >
            💾 保存
          </button>
        </div>
        <div className="lib-list" data-testid="st-song-list">
          {songs.map((song) => <SongRow key={song.id} song={song} saved composer={composer} />)}
          {PRESET_SONGS.map((song) => <SongRow key={song.id} song={song} saved={false} composer={composer} />)}
        </div>
      </section>

      <section>
        <h3>スロットのボーナス BGM</h3>
        {assignSelect('bb')}
        {assignSelect('rb')}
        <p className="panel-note">保存した音源設定のまま、スロット本体の BB / RB 中に鳴ります（PCM の曲は OPLL 編曲で代替）。</p>
      </section>
    </aside>
  );
}
