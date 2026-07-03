import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GameSession, initialState } from '../core/game.js';
import { NavLayer } from '../core/nav.js';
import type { NavDisplay } from '../core/nav.js';
import { Xoshiro128 } from '../core/rng.js';
import type { EngineState, GameEvent, MachineDef } from '../core/types.js';
import { machines } from '../machines/index.js';
import { EditorPanel } from './editor.js';
import { guides } from './guides.js';
import { CompliancePanel, LayoutPanel, SpecPanel } from './panels.js';

/**
 * プレイヤー画面（docs/design/05-config-schema.md WebUI 構成）。
 * リール回転は一定速でフレームを進め、押下時点の上段コマ番号を pushPosition として
 * コアの GameSession に渡す（押下時刻→コマ番号の決定論的量子化。docs/design/03）。
 * 操作: Space = レバー / J・K・L = 左・中・右停止（ボタンクリックも可）
 */

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
  bell_L: 'ベル 8枚',
  bell_C: 'ベル 8枚',
  bell_R: 'ベル 8枚',
  bell_weak: 'こぼしベル 1枚',
  cherry: 'チェリー 2枚',
  melon: 'スイカ 15枚',
  bb_red: 'BIG BONUS',
  rb: 'REGULAR BONUS',
  sb_kin: 'シングル 15枚',
};

/** 強制フラグ選択の特殊値（教材モード用） */
const FORCE_PURE_MISS = 'PURE_MISS';

/** カスタム機種の localStorage キー */
const CUSTOM_KEY = 'daredemo.customMachines.v1';

function loadCustoms(): MachineDef[] {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]') as MachineDef[];
  } catch {
    return [];
  }
}

type Phase = 'ready' | 'spinning';

interface ReelView {
  /** 上段のコマ番号 */
  top: number;
  stopped: boolean;
}

const freshReels = (machine: MachineDef): ReelView[] =>
  machine.strips.map(() => ({ top: 0, stopped: true }));

export function App() {
  const [customs, setCustoms] = useState<MachineDef[]>(loadCustoms);
  const [machine, setMachine] = useState<MachineDef>(machines[0]!);
  const [engine, setEngine] = useState<EngineState>(() => initialState(machines[0]!));
  const [credit, setCredit] = useState(INITIAL_CREDIT);
  const [phase, setPhase] = useState<Phase>('ready');
  const [reels, setReels] = useState<ReelView[]>(() => freshReels(machines[0]!));
  const [lastEvent, setLastEvent] = useState<GameEvent | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [debug, setDebug] = useState(false);
  const [guideOpen, setGuideOpen] = useState(true);
  const [forceSel, setForceSel] = useState('');
  const [navDisplay, setNavDisplay] = useState<NavDisplay | null>(null);
  const [atRemaining, setAtRemaining] = useState<number | null>(null);
  /** 'random' = 設定を隠してランダムに座る（設定推測の遊び。教材モードで正体が見える） */
  const [settingSel, setSettingSel] = useState<'random' | number>('random');

  /** ビルトイン + カスタム（同名カスタムはビルトインを上書き） */
  const allMachines = useMemo(() => {
    const customNames = new Set(customs.map((c) => c.name));
    return [...machines.filter((m) => !customNames.has(m.name)), ...customs];
  }, [customs]);

  const rngRef = useRef(new Xoshiro128(Date.now() >>> 0));
  const sessionRef = useRef<GameSession | null>(null);
  const navRef = useRef<NavLayer | null>(machines[0]!.nav ? new NavLayer(machines[0]!, Date.now() >>> 0) : null);
  const machineRef = useRef(machine);
  machineRef.current = machine;
  const reelsRef = useRef(reels);
  reelsRef.current = reels;
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const creditRef = useRef(credit);
  creditRef.current = credit;
  const forceSelRef = useRef(forceSel);
  forceSelRef.current = forceSel;
  const settingSelRef = useRef(settingSel);
  settingSelRef.current = settingSel;

  // リール回転: 一定速でフレームを進める
  useEffect(() => {
    if (phase !== 'spinning') return;
    const frames = machine.frames;
    const timer = setInterval(() => {
      setReels((prev) =>
        prev.map((reel) => (reel.stopped ? reel : { ...reel, top: (reel.top + 1) % frames })),
      );
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [phase, machine]);

  const pushLog = useCallback((line: string) => {
    setLog((prev) => [line, ...prev].slice(0, 10));
  }, []);

  const applyMachine = useCallback((next: MachineDef, sel?: 'random' | number) => {
    const settings = next.lottery.settings ?? 1;
    const choice = sel ?? settingSelRef.current;
    const setting = choice === 'random' ? 1 + Math.floor(Math.random() * settings) : choice;
    sessionRef.current = null;
    navRef.current = next.nav ? new NavLayer(next, Date.now() >>> 0) : null;
    setMachine(next);
    setEngine(initialState(next, setting));
    setCredit(INITIAL_CREDIT);
    setPhase('ready');
    setReels(freshReels(next));
    setLastEvent(null);
    setLog([]);
    setForceSel('');
    setNavDisplay(null);
    setAtRemaining(null);
  }, []);

  const allMachinesRef = useRef(allMachines);
  allMachinesRef.current = allMachines;

  const selectMachine = useCallback(
    (name: string) => {
      const next = allMachinesRef.current.find((m) => m.name === name);
      if (next) applyMachine(next);
    },
    [applyMachine],
  );

  /** エディタからの保存: カスタム機種として永続化し、そのままプレイ */
  const saveCustom = useCallback(
    (def: MachineDef) => {
      setCustoms((prev) => {
        const next = [...prev.filter((c) => c.name !== def.name), def];
        try {
          localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
        } catch {
          // 容量超過等は保存失敗しても遊べるようにする
        }
        return next;
      });
      applyMachine(def);
    },
    [applyMachine],
  );

  const pullLever = useCallback(() => {
    if (phaseRef.current !== 'ready') return;
    // 強制フラグ（教材モード）: 次の 1 ゲームだけ抽選を上書き
    const sel = forceSelRef.current;
    const forceFlags = sel === '' ? undefined : sel === FORCE_PURE_MISS ? [] : sel.split('+');
    const session = new GameSession(machineRef.current, engineRef.current, rngRef.current, undefined, forceFlags);
    if (session.bet > creditRef.current) return; // クレジット不足
    if (sel !== '') setForceSel('');
    sessionRef.current = session;
    // ナビ層: 成立フラグを購読して正解を開示（AT 中のみ）
    setNavDisplay(navRef.current?.navFor(session.flags) ?? null);
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
        const { state, event } = session.finish(rngRef.current);
        sessionRef.current = null;
        setEngine(state);
        setCredit((c) => c + event.payout);
        setLastEvent(event);
        setPhase('ready');
        setNavDisplay(null);
        const navNotes = navRef.current?.onEvent(event) ?? [];
        setAtRemaining(navRef.current?.atRemainingGames ?? null);
        const parts: string[] = [...navNotes];
        if (event.wins.length > 0) parts.push(event.wins.map((w) => ROLE_LABEL[w] ?? w).join(' / '));
        if (event.lidReleased) parts.push('🔓 放出開始！');
        // SB（普通役物）は地味さが本体なので開始・終了を騒がない（実機も告知しない）
        const kindOf = (id: string) => machineRef.current.bonuses.find((b) => b.id === id)?.kind;
        if (event.bonusStarted && kindOf(event.bonusStarted) !== 'sb') {
          parts.push(`▶ ${ROLE_LABEL[event.bonusStarted] ?? event.bonusStarted} 開始！`);
        }
        if (event.bonusEnded && kindOf(event.bonusEnded) !== 'sb') parts.push(`■ ボーナス終了`);
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
  if (atRemaining !== null) statusChips.push(`AT中 残り${atRemaining}G`);
  if (debug) {
    if (engine.queue.length > 0) {
      statusChips.push(`内部中 ストック${engine.queue.length}個${engine.lid ? ` 蓋on(残${engine.lidReleaseIn ?? '?'}G)` : ' 放出可'}`);
    }
    if (engine.mode !== null) statusChips.push(`モード: ${engine.mode}`);
  }

  return (
    <div className="app">
      <div className="machine-select-row">
        <select
          className="machine-select"
          value={machine.name}
          onChange={(e) => selectMachine(e.target.value)}
          disabled={phase !== 'ready'}
          data-testid="machine-select"
        >
          {allMachines.map((m) => (
            <option key={m.name} value={m.name}>
              {customs.some((c) => c.name === m.name) ? `★ ${m.name}` : m.name}
            </option>
          ))}
        </select>
        {(machine.lottery.settings ?? 1) > 1 && (
          <select
            className="setting-select"
            value={String(settingSel)}
            onChange={(e) => {
              const v = e.target.value === 'random' ? ('random' as const) : Number(e.target.value);
              setSettingSel(v);
              applyMachine(machineRef.current, v); // 設定変更 = リセット（実機同様）
            }}
            disabled={phase !== 'ready'}
            data-testid="setting-select"
            title="設定（ホール側の操作）。ランダムなら教材モードで正体を確認できる"
          >
            <option value="random">設定?（ランダム）</option>
            {Array.from({ length: machine.lottery.settings ?? 1 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                設定{n}
              </option>
            ))}
          </select>
        )}
      </div>

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
        {navDisplay && (
          <div className="nav-banner" data-testid="nav-banner">
            ナビ: {['左', '中', '右'][navDisplay.correctFirst]}から押せ！
          </div>
        )}
        <div className="reels">
          {machine.strips.map((strip, reel) => (
            <div key={reel} className={`reel ${reels[reel]!.stopped ? '' : 'reel-spinning'}`}>
              {[0, 1, 2].map((row) => {
                const symbol = strip[(reels[reel]!.top + row) % machine.frames]!;
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

      {guides[machine.name] && (
        <details
          className="panel"
          open={guideOpen}
          onToggle={(e) => setGuideOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>この機種の遊び方</summary>
          <div className="panel-body">
            <p className="guide-summary">{guides[machine.name]!.summary}</p>
            <ul className="guide-list">
              {guides[machine.name]!.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
            <p className="panel-note">操作: Space = レバー / J・K・L = 左・中・右停止</p>
          </div>
        </details>
      )}

      <SpecPanel key={`spec-${machine.name}`} machine={machine} />
      <LayoutPanel key={`layout-${machine.name}`} machine={machine} />
      <CompliancePanel key={`comp-${machine.name}`} machine={machine} />
      <EditorPanel key={`edit-${machine.name}`} machine={machine} onSave={saveCustom} />

      <label className="debug-toggle">
        <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} />
        成立フラグを見る（ネタバレ・教材モード）
      </label>
      {debug && (
        <div className="force-row">
          <label htmlFor="force-select">強制フラグ:</label>
          <select
            id="force-select"
            value={forceSel}
            onChange={(e) => setForceSel(e.target.value)}
            data-testid="force-select"
          >
            <option value="">なし（通常抽選）</option>
            <option value={FORCE_PURE_MISS}>純ハズレ</option>
            {machine.lottery.base.map((entry) => {
              const value = entry.roles.join('+');
              return (
                <option key={value} value={value}>
                  {entry.roles.map((r) => ROLE_LABEL[r] ?? r).join(' + ')}
                </option>
              );
            })}
          </select>
          {forceSel !== '' && <span className="force-armed">次のレバーONで適用</span>}
        </div>
      )}
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
