import { useCallback, useEffect, useRef, useState } from 'react';
import { GameSession, initialState } from '../core/game.js';
import { Xoshiro128 } from '../core/rng.js';
import type { EngineState, GameEvent, MachineDef } from '../core/types.js';
import { sampleAType } from '../machines/sample-a.js';
import { LayoutPanel, SpecPanel } from './panels.js';

/**
 * プレイヤー画面（docs/design/05-config-schema.md WebUI 構成）。
 * リール回転は一定速でフレームを進め、押下時点の上段コマ番号を pushPosition として
 * コアの GameSession に渡す（押下時刻→コマ番号の決定論的量子化。docs/design/03）。
 * 操作: Space = レバー / J・K・L = 左・中・右停止（ボタンクリックも可）
 */

const machine: MachineDef = sampleAType;
const N = machine.frames;
/** 約 80rpm 相当: 1 周 20 コマ ÷ 750ms ≒ 37.5ms/コマ */
const FRAME_MS = 37.5;
const INITIAL_CREDIT = 1000;

const SYMBOL_VIEW: Record<string, { text: string; className: string }> = {
  seven_red: { text: '７', className: 'sym-seven' },
  bar: { text: 'BAR', className: 'sym-bar' },
  bell: { text: '🔔', className: 'sym-bell' },
  replay: { text: '🔃', className: 'sym-replay' },
  cherry: { text: '🍒', className: 'sym-cherry' },
  melon: { text: '🍉', className: 'sym-melon' },
  // 純ブランクの伝統（獣王の木＝通称カリフラワー）に敬意を表して野菜
  blank: { text: '🥦', className: 'sym-blank' },
};

const ROLE_LABEL: Record<string, string> = {
  replay: 'リプレイ',
  bell: 'ベル 8枚',
  cherry: 'チェリー 2枚',
  melon: 'スイカ 15枚',
  bb_red: 'BIG BONUS',
  rb: 'REGULAR BONUS',
};

type Phase = 'ready' | 'spinning';

interface ReelView {
  /** 上段のコマ番号 */
  top: number;
  stopped: boolean;
}

export function App() {
  const [engine, setEngine] = useState<EngineState>(initialState);
  const [credit, setCredit] = useState(INITIAL_CREDIT);
  const [phase, setPhase] = useState<Phase>('ready');
  const [reels, setReels] = useState<ReelView[]>(() =>
    machine.strips.map(() => ({ top: 0, stopped: true })),
  );
  const [lastEvent, setLastEvent] = useState<GameEvent | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [debug, setDebug] = useState(false);

  const rngRef = useRef(new Xoshiro128(Date.now() >>> 0));
  const sessionRef = useRef<GameSession | null>(null);
  const reelsRef = useRef(reels);
  reelsRef.current = reels;
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const creditRef = useRef(credit);
  creditRef.current = credit;

  // リール回転: 一定速でフレームを進める
  useEffect(() => {
    if (phase !== 'spinning') return;
    const timer = setInterval(() => {
      setReels((prev) =>
        prev.map((reel) => (reel.stopped ? reel : { ...reel, top: (reel.top + 1) % N })),
      );
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [phase]);

  const pushLog = useCallback((line: string) => {
    setLog((prev) => [line, ...prev].slice(0, 10));
  }, []);

  const pullLever = useCallback(() => {
    if (phaseRef.current !== 'ready') return;
    const session = new GameSession(machine, engineRef.current, rngRef.current);
    if (session.bet > creditRef.current) return; // クレジット不足
    sessionRef.current = session;
    setCredit((c) => c - session.bet);
    setLastEvent(null);
    setReels((prev) => prev.map((reel) => ({ ...reel, stopped: false })));
    setPhase('spinning');
  }, []);

  const stopReel = useCallback(
    (reel: number) => {
      const session = sessionRef.current;
      if (phaseRef.current !== 'spinning' || !session) return;
      if (reelsRef.current[reel]!.stopped) return;
      const push = reelsRef.current[reel]!.top;
      const stopEvent = session.stopReel(reel, push);
      setReels((prev) =>
        prev.map((r, i) => (i === reel ? { top: stopEvent.stopPosition, stopped: true } : r)),
      );

      if (session.isComplete) {
        const { state, event } = session.finish();
        sessionRef.current = null;
        setEngine(state);
        setCredit((c) => c + event.payout);
        setLastEvent(event);
        setPhase('ready');
        const parts: string[] = [];
        if (event.wins.length > 0) parts.push(event.wins.map((w) => ROLE_LABEL[w] ?? w).join(' / '));
        if (event.bonusStarted) parts.push(`▶ ${ROLE_LABEL[event.bonusStarted] ?? event.bonusStarted} 開始！`);
        if (event.bonusEnded) parts.push(`■ ボーナス終了`);
        if (event.rtEntered) parts.push(`RT 突入`);
        if (event.rtExited) parts.push(`RT 終了`);
        if (parts.length > 0) pushLog(parts.join(' '));
      }
    },
    [pushLog],
  );

  // キーボード操作
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === 'Space') {
        e.preventDefault();
        pullLever();
      } else if (e.key === 'j') stopReel(0);
      else if (e.key === 'k') stopReel(1);
      else if (e.key === 'l') stopReel(2);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pullLever, stopReel]);

  const statusChips: string[] = [];
  if (engine.base.type === 'bonus') {
    const run = engine.base.run;
    statusChips.push(`${ROLE_LABEL[run.bonusId] ?? run.bonusId} 消化中 ${run.gamesPlayed}G / 獲得 ${run.totalPayout}枚`);
  }
  if (engine.rt !== null) statusChips.push(`RT中 ${engine.rtGames}G`);
  if (debug && engine.queue.length > 0) statusChips.push(`内部中 (${engine.queue.join(',')})${engine.lid ? ' 蓋on' : ''}`);

  return (
    <div className="app">
      <h1 className="title">{machine.name}</h1>

      <div className="status-row">
        {statusChips.length > 0 ? (
          statusChips.map((chip) => (
            <span key={chip} className="chip chip-active">{chip}</span>
          ))
        ) : (
          <span className="chip">通常</span>
        )}
      </div>

      <div className="cabinet">
        <div className="reels">
          {machine.strips.map((strip, reel) => (
            <div key={reel} className={`reel ${reels[reel]!.stopped ? '' : 'reel-spinning'}`}>
              {[0, 1, 2].map((row) => {
                const symbol = strip[(reels[reel]!.top + row) % N]!;
                const view = SYMBOL_VIEW[symbol] ?? { text: symbol, className: '' };
                return (
                  <div key={row} className={`cell ${view.className}`}>
                    {view.text}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="controls">
          <button
            className="lever"
            onClick={pullLever}
            disabled={phase !== 'ready'}
            data-testid="lever"
          >
            レバー (Space)
          </button>
          {[0, 1, 2].map((reel) => (
            <button
              key={reel}
              className="stop-btn"
              onClick={() => stopReel(reel)}
              disabled={phase !== 'spinning' || reels[reel]!.stopped}
              data-testid={`stop-${reel}`}
            >
              {['左 (J)', '中 (K)', '右 (L)'][reel]}
            </button>
          ))}
        </div>

        <div className="counter-row">
          <div className="counter">
            <span className="counter-label">CREDIT</span>
            <span className="counter-value" data-testid="credit">{credit}</span>
          </div>
          <div className="counter">
            <span className="counter-label">WIN</span>
            <span className="counter-value win-value">{lastEvent?.payout ?? 0}</span>
          </div>
        </div>

        {lastEvent && lastEvent.wins.length > 0 && (
          <div className="win-banner">{lastEvent.wins.map((w) => ROLE_LABEL[w] ?? w).join(' / ')}</div>
        )}
      </div>

      <div className="log">
        {log.map((line, i) => (
          <div key={`${i}-${line}`} className="log-line">{line}</div>
        ))}
      </div>

      <SpecPanel machine={machine} />
      <LayoutPanel machine={machine} />

      <label className="debug-toggle">
        <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} />
        成立フラグを見る（ネタバレ・教材モード）
      </label>
      {debug && (
        <pre className="debug-panel" data-testid="debug">
          {JSON.stringify(
            {
              成立フラグ: sessionRef.current?.flags ?? lastEvent?.flags ?? [],
              制御対象: sessionRef.current?.active ?? [],
              エンジン状態: engine,
            },
            null,
            2,
          )}
        </pre>
      )}
    </div>
  );
}
