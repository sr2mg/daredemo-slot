import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { GameSession, initialState } from '../core/game.js';
import { playPerfect } from '../core/sim.js';
import { NavLayer } from '../core/nav.js';
import type { NavDisplay } from '../core/nav.js';
import { Xoshiro128 } from '../core/rng.js';
import type { EngineState, GameEvent, MachineDef } from '../core/types.js';
import { machines } from '../machines/index.js';
import { checkLayout, validateMachine } from '../core/validate.js';
import { EditorPanel } from './editor.js';
import { compose } from '../core/music/compose.js';
import { BgmComposerPanel } from './bgm-composer.js';
import { loadBgmVolume, resolveAssign } from './bgm-library.js';
import { arrangePiece } from './opll-arrange.js';
import { SfxDesignerPanel } from './sfx-designer.js';
import { CompliancePanel, GuidePanel, LayoutPanel, SpecPanel } from './panels.js';
import type { SfxName } from './opll-core.js';
import { decodeMachine, parseShareHash } from './share.js';
import { SfxPlayer } from './sfx-player.js';
import { PANEL_IMAGE, SYMBOL_IMAGES } from './symbol-assets.js';
import { SoundTestPanel } from './sound-test.js';

/**
 * プレイヤー画面（docs/design/05-config-schema.md WebUI 構成）。
 * リールは連続位置（コマ単位の小数）で回し、押下時刻に「次に上段へ整列するコマ」へ
 * 切り上げたものを pushPosition としてコアの GameSession に渡す
 * （押下時刻→コマ番号の決定論的量子化。docs/design/03）。
 * 操作: Space = レバー / J・K・L = 左・中・右停止（ボタンクリックも可）
 */

/** リール 1 周の時間。20 コマ ÷ 750ms ≒ 80rpm（規格上限相当） */
const REV_MS = 750;
/** 窓に見えるコマ数（上段・中段・下段） */
const VISIBLE_ROWS = 3;
/** 停止時のバウンド（行き過ぎて戻る量と時間。「ガチッ」の感触） */
const BOUNCE_KOMA = 0.16;
const BOUNCE_MS = 110;
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

/** ツールタブ。遊ぶ場所（筐体）は常時表示で、道具だけを役割別に分ける */
type TabId = 'play' | 'sound' | 'build' | 'lab';
const TAB_KEY = 'daredemo.activeTab.v1';
const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'play', label: '🎮 あそぶ' },
  { id: 'sound', label: '🎵 サウンド' },
  { id: 'build', label: '🔧 機種づくり' },
  { id: 'lab', label: '🔬 検定・実測' },
];

function loadTab(): TabId {
  const v = localStorage.getItem(TAB_KEY);
  return TABS.some((t) => t.id === v) ? (v as TabId) : 'play';
}

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

interface ReelColumnProps {
  strip: readonly string[];
  /** 停止時の上段コマ番号 */
  top: number;
  spinning: boolean;
  /** 親と共有する連続コマ位置（押下位置の量子化・停止音のタイミングに使う） */
  positions: MutableRefObject<number[]>;
  index: number;
}

/**
 * リール 1 本の見た目。全コマを縦 1 列に並べたストリップ（末尾に先頭 3 コマを複製）を
 * transform で連続スクロールし、実機のリールのように回す。
 * アニメーションは rAF で DOM に直接書き、React の再レンダリングを毎フレーム走らせない。
 * - 回転は約 80rpm の等速
 * - 停止は押下の続き位置から等速のまま滑り込み（滑り 0〜4 コマ + 整列で最大 5 コマ弱 ≒ 190ms。
 *   実機の停止許容時間と同じオーダー）、微バウンドして着地
 * - 初期化・機種切り替え・即入賞（回転を経ない停止）は即座に合わせる
 */
function ReelColumn({ strip, top, spinning, positions, index }: ReelColumnProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const wasSpinningRef = useRef(false);
  const frames = strip.length;

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const total = frames + VISIBLE_ROWS;
    const setPos = (p: number) => {
      positions.current[index] = p;
    };
    // 末尾の複製コマのおかげで、正規化すれば境界を跨いでも絵は連続する
    const apply = (p: number) => {
      const wrapped = ((p % frames) + frames) % frames;
      el.style.transform = `translateY(${(-100 * wrapped) / total}%)`;
    };
    let raf = 0;

    if (spinning) {
      wasSpinningRef.current = true;
      let last = performance.now();
      const tick = (now: number) => {
        const next = (positions.current[index]! + (now - last) * (frames / REV_MS)) % frames;
        last = now;
        setPos(next);
        apply(next);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }

    // 停止。回転からの停止だけ滑り込み + バウンドの演出を挟む
    const fromSpin = wasSpinningRef.current;
    wasSpinningRef.current = false;
    if (!fromSpin) {
      setPos(top);
      apply(top);
      return;
    }
    const from = positions.current[index] ?? top;
    const dist = (((top - from) % frames) + frames) % frames;
    const slideMs = dist * (REV_MS / frames);
    const start = performance.now();
    const tick = (now: number) => {
      const t = now - start;
      if (t < slideMs) {
        apply(from + dist * (t / slideMs)); // 等速のまま滑る（実機は減速せず止まる）
        raf = requestAnimationFrame(tick);
        return;
      }
      const bt = t - slideMs;
      if (bt < BOUNCE_MS) {
        const k = bt / BOUNCE_MS;
        apply(top + BOUNCE_KOMA * Math.sin(Math.PI * k) * (1 - k)); // 減衰 1 往復
        raf = requestAnimationFrame(tick);
        return;
      }
      setPos(top);
      apply(top);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      // 途中で次のゲームが始まったら最終位置に確定させてから回す
      cancelAnimationFrame(raf);
      setPos(top);
      apply(top);
    };
  }, [spinning, top, strip, frames, positions, index]);

  return (
    <div className={`reel ${spinning ? 'reel-spinning' : ''}`}>
      <div className="reel-strip" ref={stripRef}>
        {[...strip, ...strip.slice(0, VISIBLE_ROWS)].map((symbol, i) => {
          const view = SYMBOL_VIEW[symbol] ?? { text: symbol, className: '' };
          const img = SYMBOL_IMAGES[symbol];
          return (
            <div key={i} className={`cell ${view.className}`}>
              {img ? <img className="cell-img" src={img} alt={view.text} /> : view.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}

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
  const [forceSel, setForceSel] = useState('');
  /** 即入賞（教材モード）の対象ボーナス */
  const [instantSel, setInstantSel] = useState(() => machines[0]!.bonuses[0]?.id ?? '');
  /** 告知演出: なし（リーチ目を自力で探す）/ フラグ成立で点灯 / 放出可能で点灯 */
  const [noticeMode, setNoticeMode] = useState<'none' | 'flag' | 'release'>('none');
  /** ボーナス開始フラッシュのトリガー（インクリメントで再生） */
  const [flashKey, setFlashKey] = useState(0);
  /** 効果音（OPLL/YM2413 実装 = emu2413）。AudioContext は初回操作時に生成 */
  const sfxRef = useRef<SfxPlayer | null>(null);
  if (sfxRef.current === null) sfxRef.current = new SfxPlayer();
  const [sfxOn, setSfxOn] = useState(() => sfxRef.current!.enabled);
  /** BET 済みか（演出用。クレジットの投入自体はレバー ON 時に行われる） */
  const [betDone, setBetDone] = useState(false);
  const betDoneRef = useRef(betDone);
  betDoneRef.current = betDone;
  const [navDisplay, setNavDisplay] = useState<NavDisplay | null>(null);
  const [atRemaining, setAtRemaining] = useState<number | null>(null);
  /** サブ基板モード（教材モードの覗き見用） */
  const [atMode, setAtMode] = useState<string | null>(null);
  /** 'random' = 設定を隠してランダムに座る（設定推測の遊び。教材モードで正体が見える） */
  const [settingSel, setSettingSel] = useState<'random' | number>('random');
  const [tab, setTab] = useState<TabId>(loadTab);

  const selectTab = useCallback((next: TabId) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // 保存できなくても切り替えには支障なし
    }
  }, []);

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
  const noticeModeRef = useRef(noticeMode);
  noticeModeRef.current = noticeMode;

  /** リールの連続コマ位置（ReelColumn が毎フレーム更新。押下位置の量子化に使う） */
  const reelPositionsRef = useRef<number[]>([0, 0, 0]);

  const pushLog = useCallback((line: string) => {
    setLog((prev) => [line, ...prev].slice(0, 10));
  }, []);

  /**
   * 効果音の再生入口。割り当て（自作 or プリセット）の解決とレンダリングは
   * SfxPlayer が起動時・割り当て変更時に済ませているので、ここは鳴らすだけ
   */
  const playSfx = useCallback((name: SfxName) => {
    sfxRef.current?.play(name);
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
    setInstantSel(next.bonuses[0]?.id ?? '');
    setNavDisplay(null);
    setAtRemaining(null);
    setAtMode(next.nav ? (navRef.current?.atMode ?? null) : null);
    setBetDone(false);
    sfxRef.current?.stopBgm();
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

  /** MAX BET（演出）。ベット音「ミ」を鳴らして BET 済み表示にする */
  const pressBet = useCallback(() => {
    if (phaseRef.current !== 'ready' || betDoneRef.current) return;
    if (engineRef.current.pendingRebet) return; // 再遊技は自動ベット
    playSfx('bet');
    setBetDone(true);
  }, [playSfx]);

  const pullLever = useCallback(() => {
    if (phaseRef.current !== 'ready') return;
    // 強制フラグ（教材モード）: 次の 1 ゲームだけ抽選を上書き
    const sel = forceSelRef.current;
    const forceFlags = sel === '' ? undefined : sel === FORCE_PURE_MISS ? [] : sel.split('+');
    const session = new GameSession(machineRef.current, engineRef.current, rngRef.current, undefined, forceFlags);
    if (session.bet > creditRef.current) return; // クレジット不足
    if (sel !== '') setForceSel('');
    sessionRef.current = session;
    // ベット済み・再遊技は「ラ」だけ、未ベットなら「ミ→ラ」を実機のリズムで
    playSfx(betDoneRef.current || session.bet === 0 ? 'lever' : 'betLever');
    setBetDone(false);
    // ナビ層: 成立フラグを購読して正解を開示（AT 中のみ）
    setNavDisplay(navRef.current?.navFor(session.flags) ?? null);
    setCredit((c) => c - session.bet);
    setLastEvent(null);
    setReels((prev) => prev.map((reel) => ({ ...reel, stopped: false })));
    setPhase('spinning');
  }, [playSfx]);

  /** 全リール停止後の精算と演出。通常プレイ（stopReel）と即入賞（教材モード）で共用 */
  const settleSession = useCallback(
    (session: GameSession): { state: EngineState; event: GameEvent } => {
      const { state, event } = session.finish(rngRef.current);
      sessionRef.current = null;
      setEngine(state);
      setCredit((c) => c + event.payout);
      setLastEvent(event);
      setPhase('ready');
      setNavDisplay(null);
      const navNotes = navRef.current?.onEvent(event) ?? [];
      setAtRemaining(navRef.current?.atRemainingGames ?? null);
      setAtMode(navRef.current?.atMode ?? null);
      const parts: string[] = [...navNotes];
      if (event.wins.length > 0) parts.push(event.wins.map((w) => ROLE_LABEL[w] ?? w).join(' / '));
      if (event.lidReleased) parts.push('🔓 放出開始！');
      if (event.ctEntered) parts.push('⚡ CT 突入！目押しで取り切れ！');
      if (event.ctExited) parts.push('CT 終了');
      // SB（普通役物）は地味さが本体なので開始・終了を騒がない（実機も告知しない）
      const kindOf = (id: string) => machineRef.current.bonuses.find((b) => b.id === id)?.kind;
      if (event.bonusStarted && kindOf(event.bonusStarted) !== 'sb') {
        parts.push(`▶ ${ROLE_LABEL[event.bonusStarted] ?? event.bonusStarted} 開始！`);
        setFlashKey((k) => k + 1); // ボーナス確定フラッシュ
      }

      // --- 効果音（OPLL）。優先度: ファンファーレ > 払い出し ---
      const sfx = sfxRef.current;
      if (event.bonusStarted && kindOf(event.bonusStarted) !== 'sb') {
        playSfx('fanfare');
        // ファンファーレが鳴り終わる頃に BGM イン。BGM 作成パネルの割り当て
        //（自作曲 or プリセット曲）を OPLL（emu2413）で鳴らす。通常はキャッシュ済みだが、
        // 未レンダリングならレンダリング完了後にインする（ボーナスは数十秒続くので間に合う）
        if (sfx?.enabled) {
          const slot = kindOf(event.bonusStarted) === 'rb' ? 'rb' : 'bb';
          const song = resolveAssign(slot);
          try {
            const piece = compose(song.options);
            const def = arrangePiece(piece, song.options.styleId, song.options.voices);
            void sfx.playComposedBgm(JSON.stringify(song.options), def, 1.05);
          } catch {
            // 保存データ破損等。音は演出なので無音で続行する
          }
        }
      } else if (event.replayWon) playSfx('replay');
      else if (event.payout > 0) playSfx('payout');
      if (event.bonusEnded && kindOf(event.bonusEnded) !== 'sb') sfx?.stopBgm();
      if (event.queuedBonus && kindOf(event.queuedBonus) !== 'sb' && noticeModeRef.current === 'flag') {
        playSfx('kyuin');
      }
      if (event.lidReleased) playSfx('siren');
      if (event.ctEntered || navNotes.some((n) => n.includes('AT 突入'))) playSfx('rush');
      if (event.bonusEnded && kindOf(event.bonusEnded) !== 'sb') parts.push(`■ ボーナス終了`);
      if (event.rtEntered) parts.push(`RT 突入`);
      if (event.rtExited) parts.push(`RT 終了`);
      if (parts.length > 0) pushLog(parts.join(' '));
      return { state, event };
    },
    [pushLog, playSfx],
  );

  const stopReel = useCallback(
    (reel: number) => {
      const session = sessionRef.current;
      if (phaseRef.current !== 'spinning' || !session) return;
      if (reelsRef.current[reel]!.stopped) return;
      const frames = machineRef.current.frames;
      const pos = reelPositionsRef.current[reel] ?? 0;
      // 押下時刻の量子化: 次に上段へ整列するコマ = 押下位置（ここから前進 0〜4 コマに滑る）
      const push = Math.ceil(pos) % frames;
      const stopEvent = session.stopReel(reel, push);
      // 停止音は見た目の停止（滑り込みの着地）に合わせる。最大 5 コマ弱 ≒ 190ms
      const dist = (((stopEvent.stopPosition - pos) % frames) + frames) % frames;
      window.setTimeout(() => playSfx('reelStop'), dist * (REV_MS / frames));
      setReels((prev) =>
        prev.map((r, i) => (i === reel ? { top: stopEvent.stopPosition, stopped: true } : r)),
      );
      if (session.isComplete) settleSession(session);
    },
    [playSfx, settleSession],
  );

  /**
   * 即入賞（教材モード）: 対象ボーナスを強制成立させ、完全打ち（playPerfect）で
   * 目押しを省略して揃える。抽選・制御・精算は通常プレイと同じ経路。
   * ストック機は 1 ゲーム目で貯留に入るだけなので、蓋を強制開放して 2 ゲーム目で揃える。
   * BB 中の挙動や BGM をすぐ確認したいとき用
   */
  const instantWin = useCallback(
    (bonusId: string) => {
      if (phaseRef.current !== 'ready') return;
      const playOnce = (engine: EngineState, forceFlags: string[]) => {
        const session = new GameSession(machineRef.current, engine, rngRef.current, undefined, forceFlags);
        if (session.bet > creditRef.current) return null; // クレジット不足
        sessionRef.current = session;
        setBetDone(false);
        setCredit((c) => c - session.bet);
        playPerfect(session);
        // stopped は押し順（打ち分けあり）なのでリール番号で引き直す
        setReels(
          machineRef.current.strips.map((_, reel) => {
            const stop = session.stopped.find((s) => s.reel === reel)!;
            return { top: stop.stopPosition, stopped: true };
          }),
        );
        return settleSession(session);
      };

      // 貯留済みで蓋が閉まっていたら強制開放（教材モード。放出条件の学習は蓋を見ればできる）
      let engine = engineRef.current;
      if (engine.queue.includes(bonusId) && engine.lid) {
        engine = { ...engine, lid: false, lidReleaseIn: null };
        setEngine(engine);
      }
      let result = playOnce(engine, engine.queue.includes(bonusId) ? [] : [bonusId]);
      if (result && result.event.bonusStarted !== bonusId && result.state.queue.includes(bonusId)) {
        // ストック機: 1 ゲーム目は貯留入りしただけ。蓋を開けて純ハズレの 2 ゲーム目で揃える
        const opened = { ...result.state, lid: false, lidReleaseIn: null };
        setEngine(opened);
        result = playOnce(opened, []);
      }
      if (result === null) return;
      if (result.event.bonusStarted === bonusId) {
        pushLog('⚡ 即入賞（教材モード・目押し省略）');
      } else {
        pushLog(`⚠ 即入賞できず（${ROLE_LABEL[bonusId] ?? bonusId} を揃えられる状態ではないかも）`);
      }
    },
    [settleSession, pushLog],
  );

  // 効果音の事前レンダリング（WASM 取得含む。AudioContext はまだ作らない）。
  // BB/RB に割り当て済みの自作 BGM も先に OPLL レンダリングしておく
  useEffect(() => {
    const sfx = sfxRef.current;
    if (!sfx) return;
    sfx.setBgmVolume(loadBgmVolume() / 100);
    void (async () => {
      await sfx.preload();
      for (const slot of ['bb', 'rb'] as const) {
        const song = resolveAssign(slot);
        try {
          const piece = compose(song.options);
          const def = arrangePiece(piece, song.options.styleId, song.options.voices);
          void sfx.ensureComposedBgm(JSON.stringify(song.options), def);
        } catch {
          // 壊れた保存データはボーナス開始時にプリセットへフォールバックされる
        }
      }
    })();
  }, []);

  // 共有リンク（#m=...）からの機種読み込み
  useEffect(() => {
    const payload = parseShareHash(location.hash);
    if (!payload) return;
    void decodeMachine(payload)
      .then((def) => {
        const { errors } = validateMachine(def);
        if (errors.length > 0 || !checkLayout(def).ok) throw new Error('invalid shared machine');
        // 同名の別内容カスタムがあるときは上書きせず別名にする
        const existing = loadCustoms().find((c) => c.name === def.name);
        if (existing && JSON.stringify(existing) !== JSON.stringify(def)) {
          def = { ...def, name: `${def.name}（共有）` };
        }
        saveCustom(def);
        pushLog(`🔗 共有された機種「${def.name}」を読み込みました`);
      })
      .catch(() => pushLog('共有リンクの機種を読み込めませんでした（リンクが壊れています）'))
      .finally(() => history.replaceState(null, '', location.pathname + location.search));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      else if (e.key === 'b') pressBet();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pullLever, stopReel, pressBet]);

  // 告知ランプ: SB 以外のボーナスがキューにあるとき、モードに応じて点灯
  const bonusKinds = new Map(machine.bonuses.map((b) => [b.id, b.kind]));
  const pendingBonus = engine.queue.some((id) => bonusKinds.get(id) !== 'sb');
  const lampOn =
    noticeMode === 'flag' ? pendingBonus : noticeMode === 'release' ? pendingBonus && !engine.lid : false;

  const statusChips: string[] = [];
  if (engine.base.type === 'bonus') {
    const run = engine.base.run;
    statusChips.push(`${ROLE_LABEL[run.bonusId] ?? run.bonusId} 消化中 ${run.gamesPlayed}G / 獲得 ${run.totalPayout}枚`);
  }
  if (engine.rt !== null) statusChips.push(`RT中 ${engine.rtGames}G`);
  if (engine.ct !== null) statusChips.push(`CT中 ${engine.ctGames}G / 獲得${engine.ctPayout}枚`);
  if (atRemaining !== null) statusChips.push(`AT中 残り${atRemaining}G`);
  if (debug) {
    if (engine.queue.length > 0) {
      statusChips.push(`内部中 ストック${engine.queue.length}個${engine.lid ? ` 蓋on(残${engine.lidReleaseIn ?? '?'}G)` : ' 放出可'}`);
    }
    if (engine.mode !== null) statusChips.push(`モード: ${engine.mode}`);
    if (atMode !== null) statusChips.push(`ATモード: ${atMode}`);
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
        {flashKey > 0 && <div key={flashKey} className="bonus-flash" aria-hidden />}
        {PANEL_IMAGE && <img className="panel-art" src={PANEL_IMAGE} alt="" />}
        <div className="lamp-row">
          <span className={`notice-lamp ${lampOn ? 'lamp-on' : ''}`} data-testid="notice-lamp" title="告知ランプ" />
        </div>
        {navDisplay && (
          <div className="nav-banner" data-testid="nav-banner">
            ナビ: {['左', '中', '右'][navDisplay.correctFirst]}から押せ！
          </div>
        )}
        <div className="reels">
          {machine.strips.map((strip, reel) => (
            <ReelColumn
              key={reel}
              strip={strip}
              top={reels[reel]!.top}
              spinning={!reels[reel]!.stopped}
              positions={reelPositionsRef}
              index={reel}
            />
          ))}
        </div>

        <div className="controls">
          <button
            className="bet-btn"
            onClick={pressBet}
            disabled={phase !== 'ready' || betDone || engine.pendingRebet}
            data-testid="bet"
            title={engine.pendingRebet ? '再遊技（自動ベット）' : 'MAX BET'}
          >
            {betDone ? 'BET済' : engine.pendingRebet ? '再遊技' : 'BET (B)'}
          </button>
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

      {/* ツールタブ: 遊ぶ場所（上の筐体）は常時表示、道具は役割別に分ける。
          切り替えは hidden で行い、アンマウントしない（実測結果や再生状態を保つ） */}
      <div className="tab-bar" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab-btn ${tab === t.id ? 'tab-btn-active' : ''}`}
            onClick={() => selectTab(t.id)}
            data-testid={`tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="tab-content" hidden={tab !== 'play'}>
        <div className="force-row">
          <label htmlFor="notice-select">告知演出:</label>
          <select
            id="notice-select"
            value={noticeMode}
            onChange={(e) => setNoticeMode(e.target.value as typeof noticeMode)}
          >
            <option value="none">なし（出目から自力で察知）</option>
            <option value="flag">完全告知（ボーナス成立で点灯）</option>
            <option value="release">放出告知（揃えられる状態で点灯）</option>
          </select>
          <label className="debug-inline">
            <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} />
            成立フラグを見る（ネタバレ・教材モード）
          </label>
        </div>
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
        {debug && machine.bonuses.length > 0 && (
          <div className="force-row">
            <label htmlFor="instant-select">即入賞:</label>
            <select
              id="instant-select"
              value={instantSel}
              onChange={(e) => setInstantSel(e.target.value)}
              data-testid="instant-select"
            >
              {machine.bonuses.map((b) => (
                <option key={b.id} value={b.id}>
                  {ROLE_LABEL[b.id] ?? b.id}
                </option>
              ))}
            </select>
            <button
              className="form-mini-btn"
              onClick={() => instantWin(instantSel)}
              disabled={phase !== 'ready' || instantSel === ''}
              data-testid="instant-win"
              title="対象ボーナスを強制成立させ、完全打ちで目押しを省略して 1 ゲームで揃える"
            >
              ⚡ 揃える（目押し省略）
            </button>
          </div>
        )}
        <GuidePanel key={`guide-${machine.name}`} machine={machine} />
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

      <div className="tab-content" hidden={tab !== 'sound'}>
        <div className="force-row">
          <label>
            <input
              type="checkbox"
              checked={sfxOn}
              onChange={(e) => {
                setSfxOn(e.target.checked);
                sfxRef.current?.setEnabled(e.target.checked); // 自作 BGM も同じ経路なので一緒に止まる
              }}
              data-testid="sfx-toggle"
            />
            効果音（OPLL）
          </label>
          <span className="panel-note">
            ベット/レバー等の音色変更は「効果音作成」パネルで（レシピ・音色を選んで契機に割り当て）
          </span>
        </div>
        <SoundTestPanel player={sfxRef.current!} />
        <BgmComposerPanel player={sfxRef.current!} />
        <SfxDesignerPanel player={sfxRef.current!} />
        <p className="panel-note credit-note">
          音源コア:{' '}
          <a href="https://github.com/digital-sound-antiques/emu2413" target="_blank" rel="noreferrer">
            emu2413
          </a>{' '}
          © Mitsutaka Okazaki（MIT License）— YM2413（OPLL）互換のソフトウェア実装です
        </p>
      </div>

      <div className="tab-content" hidden={tab !== 'build'}>
        <EditorPanel
          key={`edit-${machine.name}`}
          machine={machine}
          onSave={saveCustom}
          defaultTier={customs.length === 0 ? 'easy' : 'normal'}
        />
      </div>

      <div className="tab-content" hidden={tab !== 'lab'}>
        <SpecPanel key={`spec-${machine.name}`} machine={machine} />
        <LayoutPanel key={`layout-${machine.name}`} machine={machine} />
        <CompliancePanel key={`comp-${machine.name}`} machine={machine} />
      </div>
    </div>
  );
}
