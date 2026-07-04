import { useEffect, useMemo, useRef, useState } from 'react';
import { compose, defaultChoiceFor, validatePiece } from '../core/music/compose.js';
import type { Piece } from '../core/music/compose.js';
import { MusicPlayer } from '../core/music/player.js';
import { KEYS, PROGRESSIONS, STYLES, chordName, noteName } from '../core/music/theory.js';

/**
 * BGM 作成（作曲）パネル。既製曲を試聴する SoundTestPanel（sound-test.tsx）とは別物で、
 * こちらはコード進行カタログからオリジナル曲を生成する。
 * 決定順序を UI にそのまま並べる: 用途(尺) → BPM/キー → スタイル → コード進行(スロット選択) → 作曲。
 * コード進行は「小節スロット + 選択肢」方式なので、選ぶだけで破綻しない進行が組める。
 * メロディはシード付きで決定論生成し、強拍コードトーン検証を通した結果を表示する。
 */

const newSeed = (): number => (Math.random() * 0xffff_ffff) >>> 0;

const VOLUME_KEY = 'daredemo.bgmComposer.volume.v1';

function loadVolume(): number {
  const raw = localStorage.getItem(VOLUME_KEY);
  const v = raw === null ? NaN : Number(raw);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 50;
}

export function BgmComposerPanel() {
  const [bars, setBars] = useState<4 | 8>(4);
  const [progId, setProgId] = useState('royal-pop');
  const [styleId, setStyleId] = useState('eurobeat');
  const [keyRoot, setKeyRoot] = useState(0);
  const [bpm, setBpm] = useState(170);
  const [choice, setChoice] = useState<number[]>(() => defaultChoiceFor(PROGRESSIONS[0]!, 4));
  const [seed, setSeed] = useState(newSeed);
  const [loop, setLoop] = useState(true);
  const [piece, setPiece] = useState<Piece | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const [volume, setVolume] = useState(loadVolume);

  const playerRef = useRef<MusicPlayer | null>(null);
  useEffect(() => {
    playerRef.current = new MusicPlayer();
    return () => playerRef.current?.dispose();
  }, []);
  useEffect(() => {
    playerRef.current?.setVolume(volume / 100);
    try {
      localStorage.setItem(VOLUME_KEY, String(volume));
    } catch {
      // 保存失敗しても鳴らせればよい
    }
  }, [volume]);

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
    playerRef.current?.stop();
    setPlaying(false);
  };

  const composeAndPlay = (nextSeed: number, nextChoice?: number[]) => {
    try {
      const p = compose({
        progressionId: prog.id,
        styleId,
        keyRoot,
        bpm,
        bars,
        seed: nextSeed,
        choice: nextChoice ?? choice,
      });
      setError('');
      setSeed(nextSeed);
      setPiece(p);
      playerRef.current?.play(p, loop, () => setPlaying(false));
      setPlaying(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const violations = piece ? validatePiece(piece) : [];

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
          <button onClick={() => composeAndPlay(newSeed())} data-testid="st-compose">
            🎲 作曲して再生
          </button>
          <button onClick={() => composeAndPlay(seed)} disabled={!piece} data-testid="st-replay">
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
          </div>
        )}
        <p className="panel-note">
          決定順は「尺 → キー/BPM → スタイル → コード進行 → メロディ」。コードは小節ごとの選択制
          （同じ機能の代理和音）なので、どれを選んでも破綻しません。
        </p>
      </div>
    </details>
  );
}
