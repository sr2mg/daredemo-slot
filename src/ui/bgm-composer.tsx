import { useEffect, useMemo, useState } from 'react';
import { compose, defaultChoiceFor, validatePiece } from '../core/music/compose.js';
import type { ComposeOptions, Piece } from '../core/music/compose.js';
import { KEYS, PROGRESSIONS, STYLES, chordName, noteName } from '../core/music/theory.js';
import {
  DEFAULT_ASSIGN,
  loadAssign,
  loadBgmVolume,
  loadSongs,
  PRESET_SONGS,
  saveAssign,
  saveBgmVolume,
  saveSongs,
} from './bgm-library.js';
import type { BgmAssign, SavedSong } from './bgm-library.js';
import { arrangePiece } from './opll-arrange.js';
import type { SfxPlayer } from './sfx-player.js';

/**
 * BGM 作成（作曲）パネル。既製曲を試聴する SoundTestPanel（sound-test.tsx）とは別物で、
 * こちらはコード進行カタログからオリジナル曲を生成する。
 * 決定順序を UI にそのまま並べる: 用途(尺) → BPM/キー → スタイル → コード進行(スロット選択) → 作曲。
 * コード進行は「小節スロット + 選択肢」方式なので、選ぶだけで破綻しない進行が組める。
 * メロディはシード付きで決定論生成し、強拍コードトーン検証を通した結果を表示する。
 *
 * 再生は内蔵曲と同じ OPLL（emu2413）: Piece を opll-arrange.ts で編曲してレンダリングする。
 * レンダリングはほぼ実時間かかるため進捗を表示し、結果はキャッシュされる。
 * 作った曲は名前を付けてリストに保存でき（実体は ComposeOptions のみ）、
 * BB/RB のゲーム中 BGM に割り当てられる（App.tsx がボーナス開始時に読む）。
 */

const newSeed = (): number => (Math.random() * 0xffff_ffff) >>> 0;

const newSongId = (): string => `s${Date.now().toString(36)}${newSeed().toString(36)}`;

/** 保存曲の一覧表示用サマリ（例: BB風8小節 / 田中・真部進行 / キーC / BPM170） */
function songSummary(options: ComposeOptions): string {
  const prog = PROGRESSIONS.find((p) => p.id === options.progressionId)?.name ?? options.progressionId;
  const key = KEYS.find((k) => k.root === options.keyRoot)?.label ?? '?';
  return `${options.bars === 8 ? 'BB風8小節' : 'RB風4小節'} / ${prog} / キー${key} / BPM${options.bpm}`;
}

export function BgmComposerPanel({ player }: { player: SfxPlayer }) {
  const [bars, setBars] = useState<4 | 8>(4);
  const [progId, setProgId] = useState('royal-pop');
  const [styleId, setStyleId] = useState('eurobeat');
  const [keyRoot, setKeyRoot] = useState(0);
  const [bpm, setBpm] = useState(170);
  const [choice, setChoice] = useState<number[]>(() => defaultChoiceFor(PROGRESSIONS[0]!, 4));
  const [seed, setSeed] = useState(newSeed);
  const [loop, setLoop] = useState(true);
  const [piece, setPiece] = useState<Piece | null>(null);
  /** 最後に compose した正確なオプション（保存はこれを使う。UI をいじっただけでは変わらない） */
  const [lastOpts, setLastOpts] = useState<ComposeOptions | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const [volume, setVolume] = useState(loadBgmVolume);
  const [songs, setSongs] = useState<SavedSong[]>(loadSongs);
  const [assign, setAssign] = useState<BgmAssign>(loadAssign);
  const [songName, setSongName] = useState('');
  /** OPLL レンダリングの進捗（0..1）。null = レンダリング中でない */
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    player.setBgmVolume(volume / 100);
    saveBgmVolume(volume);
  }, [player, volume]);

  // 尺に収まる進行だけ選ばせる（8 小節進行は BB 専用）
  const progs = useMemo(() => PROGRESSIONS.filter((p) => p.slots.length <= bars), [bars]);
  const prog = progs.find((p) => p.id === progId) ?? progs[0]!;

  const resetChoice = (nextProgId: string, nextBars: 4 | 8) => {
    const p = PROGRESSIONS.find((q) => q.id === nextProgId)!;
    setChoice(defaultChoiceFor(p, nextBars));
  };

  const selectBars = (next: 4 | 8) => {
    const nextProgId = PROGRESSIONS.find((p) => p.id === prog.id && p.slots.length <= next)
      ? prog.id
      : PROGRESSIONS.filter((p) => p.slots.length <= next)[0]!.id;
    setBars(next);
    setProgId(nextProgId);
    resetChoice(nextProgId, next);
  };

  const selectProg = (id: string) => {
    setProgId(id);
    resetChoice(id, bars);
  };

  const stop = () => {
    player.stopBgm();
    setPlaying(false);
  };

  const playOptions = async (opts: ComposeOptions) => {
    try {
      const p = compose(opts);
      setError(player.enabled ? '' : '「効果音（OPLL）」が OFF のため音は鳴りません（このタブ上部で ON にできます）');
      setSeed(opts.seed);
      setPiece(p);
      setLastOpts(opts);
      setPlaying(false);
      if (!player.enabled) return;
      const def = arrangePiece(p, opts.styleId);
      setProgress(0);
      const result = await player.playComposedBgm(JSON.stringify(opts), def, 0, {
        loop,
        onProgress: setProgress,
      });
      setProgress(null);
      setPlaying(result === 'played');
    } catch (e) {
      setProgress(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const composeAndPlay = (nextSeed: number) => {
    void playOptions({
      progressionId: prog.id,
      styleId,
      keyRoot,
      bpm,
      bars,
      seed: nextSeed,
      choice: [...choice],
    });
  };

  const saveSong = () => {
    if (!lastOpts) return;
    const name = songName.trim() || songSummary(lastOpts);
    const next = [...songs, { id: newSongId(), name, options: lastOpts }];
    setSongs(next);
    saveSongs(next);
    setSongName('');
  };

  const deleteSong = (id: string) => {
    const next = songs.filter((s) => s.id !== id);
    setSongs(next);
    saveSongs(next);
    // 割り当て中の曲を消したらデフォルトのプリセットに戻す
    const fixed: BgmAssign = {
      bb: assign.bb === `song:${id}` ? DEFAULT_ASSIGN.bb : assign.bb,
      rb: assign.rb === `song:${id}` ? DEFAULT_ASSIGN.rb : assign.rb,
    };
    if (fixed.bb !== assign.bb || fixed.rb !== assign.rb) {
      setAssign(fixed);
      saveAssign(fixed);
    }
  };

  const updateAssign = (slot: 'bb' | 'rb', value: string) => {
    const next = { ...assign, [slot]: value };
    setAssign(next);
    saveAssign(next);
    // 割り当てた曲は先にレンダリングしておく（ボーナス開始時に待たせない）
    const song = value.startsWith('song:')
      ? songs.find((s) => `song:${s.id}` === value)
      : PRESET_SONGS.find((p) => `preset:${p.id}` === value);
    if (song) {
      try {
        const p = compose(song.options);
        void player.ensureComposedBgm(JSON.stringify(song.options), arrangePiece(p, song.options.styleId));
      } catch {
        // 壊れた保存データはボーナス開始時にプリセットへフォールバックされる
      }
    }
  };

  const violations = piece ? validatePiece(piece) : [];

  const assignSelect = (slot: 'bb' | 'rb') => (
    <label className="assign-item">
      <span className="slot-label">{slot.toUpperCase()} 中の BGM</span>
      <select
        value={assign[slot]}
        onChange={(e) => updateAssign(slot, e.target.value)}
        data-testid={`st-assign-${slot}`}
      >
        {PRESET_SONGS.map((p) => (
          <option key={p.id} value={`preset:${p.id}`}>
            {p.name}
          </option>
        ))}
        {songs.map((s) => (
          <option key={s.id} value={`song:${s.id}`}>
            ★ {s.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <details className="panel">
      <summary>BGM 作成（コード進行から作曲）</summary>
      <div className="panel-body">
        <div className="panel-controls">
          <select
            value={bars}
            onChange={(e) => selectBars(Number(e.target.value) as 4 | 8)}
            data-testid="st-bars"
            title="用途 = 尺。RB はループ回数が多いので単純に、BB は A+A' で展開"
          >
            <option value={4}>RB 風（4小節ループ）</option>
            <option value={8}>BB 風（8小節ループ）</option>
          </select>
          <select value={keyRoot} onChange={(e) => setKeyRoot(Number(e.target.value))} data-testid="st-key">
            {KEYS.map((k) => (
              <option key={k.root} value={k.root}>
                キー: {k.label}
              </option>
            ))}
          </select>
          <label className="st-bpm">
            BPM
            <input
              type="number"
              min={80}
              max={220}
              value={bpm}
              onChange={(e) => setBpm(Number(e.target.value))}
              data-testid="st-bpm"
            />
          </label>
          <select value={styleId} onChange={(e) => setStyleId(e.target.value)} data-testid="st-style">
            {STYLES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}（{s.feel}）
              </option>
            ))}
          </select>
        </div>

        <div className="panel-controls">
          <select value={prog.id} onChange={(e) => selectProg(e.target.value)} data-testid="st-prog">
            {progs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.feel} / {p.usage}
              </option>
            ))}
          </select>
        </div>

        {/* コード進行のスロット選択: 選択肢が 1 つの小節は固定表示 */}
        <div className="slot-row" data-testid="st-slots">
          {Array.from({ length: bars }, (_, bar) => {
            const slot = prog.slots[bar % prog.slots.length]!;
            const idx = Math.min(choice[bar] ?? 0, slot.length - 1);
            return (
              <div key={bar} className="slot-item">
                <span className="slot-label">{bar + 1}小節</span>
                {slot.length === 1 ? (
                  <span className="slot-fixed">{slot[0]!.map((t) => chordName(t, keyRoot)).join(' ')}</span>
                ) : (
                  <select
                    value={idx}
                    onChange={(e) => {
                      const next = [...choice];
                      next[bar] = Number(e.target.value);
                      setChoice(next);
                    }}
                  >
                    {slot.map((opt, i) => (
                      <option key={i} value={i}>
                        {opt.map((t) => chordName(t, keyRoot)).join(' ')}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </div>

        <div className="panel-controls">
          <button onClick={() => composeAndPlay(newSeed())} disabled={progress !== null} data-testid="st-compose">
            🎲 作曲して再生
          </button>
          <button onClick={() => composeAndPlay(seed)} disabled={!piece || progress !== null} data-testid="st-replay">
            ▶ 同じメロディで再生
          </button>
          <button onClick={stop} disabled={!playing} data-testid="st-stop">
            ■ 停止
          </button>
          <label className="st-loop">
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
            ループ
          </label>
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

        {progress !== null && (
          <p className="panel-note" data-testid="st-progress">
            🎛 OPLL（YM2413）で演奏を仕込んでいます… {Math.round(progress * 100)}%
          </p>
        )}
        {error && <p className="badge-ng">{error}</p>}
        {piece && (
          <div data-testid="st-result">
            <div className="chord-line">| {piece.barChordNames.join(' | ')} |</div>
            <div className="melody-line">{piece.melody.map((n) => noteName(n.midi)).join(' ')}</div>
            <p className="panel-note">
              シード {seed} ／ 強拍コードトーン検証:{' '}
              {violations.length === 0 ? (
                <span className="badge-ok">OK</span>
              ) : (
                <span className="badge-ng">NG {violations.length} 件</span>
              )}
              （同じシード + 同じ設定なら同じ曲になります）
            </p>
            <div className="panel-controls">
              <input
                type="text"
                className="song-name-input"
                placeholder={lastOpts ? songSummary(lastOpts) : '曲名'}
                value={songName}
                onChange={(e) => setSongName(e.target.value)}
                data-testid="st-song-name"
              />
              <button onClick={saveSong} disabled={!lastOpts} data-testid="st-save">
                💾 リストに保存
              </button>
            </div>
          </div>
        )}

        <div className="song-list" data-testid="st-song-list">
          {PRESET_SONGS.map((p) => (
            <div key={p.id} className="song-row">
              <span className="song-name">{p.name}</span>
              <span className="song-summary">{songSummary(p.options)}</span>
              <button
                className="form-mini-btn"
                onClick={() => void playOptions(p.options)}
                disabled={progress !== null}
                data-testid={`st-song-play-${p.id}`}
              >
                ▶ 試聴
              </button>
            </div>
          ))}
          {songs.map((s) => (
              <div key={s.id} className="song-row">
                <span className="song-name">★ {s.name}</span>
                <span className="song-summary">{songSummary(s.options)}</span>
                <button
                  className="form-mini-btn"
                  onClick={() => void playOptions(s.options)}
                  disabled={progress !== null}
                  data-testid={`st-song-play-${s.id}`}
                >
                  ▶ 試聴
                </button>
                <button
                  className="form-mini-btn song-delete"
                  onClick={() => deleteSong(s.id)}
                  data-testid={`st-song-delete-${s.id}`}
                >
                  🗑 削除
                </button>
              </div>
            ))}
        </div>

        <div className="panel-controls">
          {assignSelect('bb')}
          {assignSelect('rb')}
        </div>
        <p className="panel-note">
          再生は OPLL（YM2413）音源。アクセント・チャンネルエコー・ビブラートも当時のレジスタ操作
          だけで掛けています。🔊 は BGM 全体の音量。デフォルト BGM も同じ作曲エンジンの
          プリセット曲（固定シード）で、BB/RB への割り当てはボーナス開始のファンファーレ後に流れます。
          コードは小節ごとの選択制（同じ機能の代理和音）なので、どれを選んでも破綻しません。
        </p>
      </div>
    </details>
  );
}
