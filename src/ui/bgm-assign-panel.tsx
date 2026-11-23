import { useEffect, useState } from 'react';
import { compose } from '../core/music/compose.js';
import { bgmCacheKey, renderComposedBgm } from '../audio/render.js';
import {
  loadAssign, loadBgmVolume, loadSongs, PRESET_SONGS, saveAssign, saveBgmVolume,
} from './bgm-library.js';
import type { BgmAssign, SavedSong } from './bgm-library.js';
import { songSummary } from './composer-form.js';
import type { SfxPlayer } from './sfx-player.js';

/**
 * スロット本体のボーナス BGM パネル: プリセットと保存曲を試聴し、BB / RB へ割り当てる。
 *
 * 曲を作る画面は作曲スタジオ(bgm.html)へ一本化した。ここは「作った曲をゲームで使う」
 * 入口だけを持ち、保存曲は localStorage 経由でスタジオと共有する。再生は常にチップ音源
 * (PCM の曲は OPLL 編曲へ劣化)で、ボーナス中に鳴る音と同じ経路を通す。
 */
export function BgmAssignPanel({ player }: { player: SfxPlayer }) {
  const [songs, setSongs] = useState<SavedSong[]>(loadSongs);
  const [assign, setAssign] = useState<BgmAssign>(loadAssign);
  const [volume, setVolume] = useState(loadBgmVolume);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    player.setBgmVolume(volume / 100);
    saveBgmVolume(volume);
  }, [player, volume]);

  const stop = (): void => {
    player.stopBgm();
    setPlayingId(null);
  };

  const play = async (song: SavedSong): Promise<void> => {
    try {
      setError(player.enabled ? '' : '「音」が OFF のため音は鳴りません');
      if (!player.enabled) return;
      const piece = compose(song.options);
      const def = await renderComposedBgm(piece, song.options);
      setProgress(0);
      const result = await player.playComposedBgm(bgmCacheKey(song.options), def, 0, {
        loop: piece.ending === 'loop',
        onProgress: setProgress,
      });
      setProgress(null);
      setPlayingId(result === 'played' ? song.id : null);
    } catch (e) {
      setProgress(null);
      setPlayingId(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const updateAssign = (slot: 'bb' | 'rb', value: string): void => {
    const next = { ...assign, [slot]: value };
    setAssign(next);
    saveAssign(next);
    // 割り当てた曲は先にレンダリングしておく（ボーナス開始時に待たせない）
    const song = [...PRESET_SONGS, ...songs].find((item) => (
      value === `preset:${item.id}` || value === `song:${item.id}`
    ));
    if (!song) return;
    void (async () => {
      try {
        await player.ensureComposedBgm(
          bgmCacheKey(song.options),
          await renderComposedBgm(compose(song.options), song.options),
        );
      } catch {
        // 壊れた保存データはボーナス開始時にプリセットへフォールバックされる
      }
    })();
  };

  const assignSelect = (slot: 'bb' | 'rb') => (
    <label className="assign-item">
      <span className="slot-label">{slot.toUpperCase()} 中の BGM</span>
      <select value={assign[slot]} onChange={(e) => updateAssign(slot, e.target.value)} data-testid={`st-assign-${slot}`}>
        {PRESET_SONGS.map((preset) => <option key={preset.id} value={`preset:${preset.id}`}>{preset.name}</option>)}
        {songs.map((song) => <option key={song.id} value={`song:${song.id}`}>★ {song.name}</option>)}
      </select>
    </label>
  );

  const row = (song: SavedSong, saved: boolean) => (
    <div key={song.id} className="song-row">
      <span className="song-name">{saved ? '★ ' : ''}{song.name}</span>
      <span className="song-summary">{songSummary(song.options)}</span>
      <button
        className="form-mini-btn"
        onClick={() => (playingId === song.id ? stop() : void play(song))}
        disabled={progress !== null}
        data-testid={`st-song-play-${song.id}`}
      >
        {playingId === song.id ? '■ 停止' : '▶ 試聴'}
      </button>
    </div>
  );

  return (
    <details
      className="panel"
      // スタジオで保存した曲を、パネルを開いたときに読み直す(別タブで作ってから戻る使い方)。
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) setSongs(loadSongs());
      }}
    >
      <summary>ボーナス BGM（試聴と BB / RB への割り当て）</summary>
      <div className="panel-body">
        <div className="panel-controls">
          <a className="repo-link" href="./bgm.html" data-testid="st-open-studio">🎼 作曲スタジオで曲を作る →</a>
          <label className="st-volume">
            🔊
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              data-testid="st-volume"
            />
            {volume}
          </label>
        </div>
        <div className="song-list" data-testid="st-song-list">
          {PRESET_SONGS.map((song) => row(song, false))}
          {songs.map((song) => row(song, true))}
        </div>
        <div className="panel-controls">
          {assignSelect('bb')}
          {assignSelect('rb')}
        </div>
        {progress !== null && (
          <p className="panel-note" data-testid="st-progress">🎛 演奏を仕込み中… {Math.round(progress * 100)}%</p>
        )}
        {error && <p className="badge-ng">{error}</p>}
        <p className="panel-note">
          曲の作成・保存・削除は作曲スタジオで行います。保存した曲はここに並び、音源設定のままボーナス中に鳴ります
          （PCM の曲は OPLL 編曲で代替）。🔊は BGM 全体の音量です。
        </p>
      </div>
    </details>
  );
}
