import { useEffect, useMemo, useState } from 'react';
import {
  compose,
  ARRANGEMENT_ARC_LABELS,
  COUNTER_ROLE_LABELS,
  GROOVE_FEEL_LABELS,
  JAPANESE_SCALE_LABELS,
  ORNAMENT_LABELS,
  PHRASE_FUNCTION_LABELS,
  defaultChoiceFor,
  diagnosePiece,
  hasVariedChoiceFor,
  INTRO_ROLE_LABELS,
  suggestCompositionRepair,
  variedChoiceFor,
} from '../core/music/compose.js';
import type {
  ComposeBars,
  CompositionRepair,
  ComposeOptions,
  DiagnosticCategory,
  GrooveFeel,
  JapaneseScaleChoice,
  MelodyMode,
  NesVoiceOptions,
  Piece,
  VoiceOverride,
} from '../core/music/compose.js';
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
import { arrangeComposedBgm } from './bgm-audio.js';
import { NES_DUTIES } from './nes-apu.js';
import { defaultVoicesFor } from './opll-arrange.js';
import { OPLL_VOICES } from './opll-core.js';
import { loadStored, saveStored } from './persist.js';
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

const DIAGNOSTIC_LABELS: Record<DiagnosticCategory, string> = {
  harmony: '和声',
  melody: '旋律',
  voiceLeading: '声部進行',
  rhythm: 'リズム',
  counterpoint: '副旋律',
  form: 'フォーム',
  loop: 'ループ',
};

/** 音色を上書きできるパート（リズムは OPLL リズムモード固定、エコーはリード追従） */
const VOICE_PARTS: readonly { part: keyof VoiceOverride; label: string }[] = [
  { part: 'lead', label: 'リード' },
  { part: 'backing', label: 'バッキング' },
  { part: 'bass', label: 'ベース' },
];

const voiceLabel = (id: number): string =>
  OPLL_VOICES.find((v) => v.id === id)?.label.split('（')[0] ?? String(id);

/** 保存曲の一覧表示用サマリ（例: BB風8小節 / 田中・真部進行 / キーC / BPM170） */
function songSummary(options: ComposeOptions): string {
  const prog = PROGRESSIONS.find((p) => p.id === options.progressionId)?.name ?? options.progressionId;
  const key = KEYS.find((k) => k.root === options.keyRoot)?.label ?? '?';
  const chip = options.soundChip === 'nes2a03' ? 'ファミコン2A03' : 'OPLL';
  const form = options.bars === 16 ? 'ゲームBGM風16小節' : options.bars === 8 ? 'BB風8小節' : 'RB風4小節';
  const intro = options.bars === 16 && options.intro === false ? ' / イントロなし' : '';
  const melody = options.melodyMode === 'japanese'
    ? ` / 和風五音(${JAPANESE_SCALE_LABELS[options.japaneseScale ?? 'auto']})`
    : '';
  const groove = options.grooveFeel && options.grooveFeel !== 'straight'
    ? ` / ${GROOVE_FEEL_LABELS[options.grooveFeel]}`
    : '';
  const edits = options.melodyEdits?.length ? ` / 局所修正${options.melodyEdits.length}` : '';
  const base = `${chip} / ${form}${intro}${melody}${groove}${edits} / ${prog} / キー${key} / BPM${options.bpm}`;
  if (options.soundChip === 'nes2a03') return base;
  const overridden = VOICE_PARTS.filter(({ part }) => options.voices?.[part] !== undefined);
  if (overridden.length === 0) return base;
  return `${base} / ${overridden.map(({ part, label }) => `${label}=${voiceLabel(options.voices![part]!)}`).join('・')}`;
}

/** 作曲フォームの永続化（曲リストとは別に、作業中の設定そのものを覚える） */
const FORM_KEY = 'daredemo.bgmComposer.form.v1';

interface ComposerForm {
  bars: ComposeBars;
  progId: string;
  styleId: string;
  melodyMode: MelodyMode;
  japaneseScale: JapaneseScaleChoice;
  grooveFeel: GrooveFeel;
  keyRoot: number;
  bpm: number;
  soundChip: 'opll' | 'nes2a03';
  voices: VoiceOverride;
  nes: NesVoiceOptions;
  choice: number[];
  autoVary: boolean;
  intro: boolean;
  seed: number;
  loop: boolean;
}

/** 保存済みフォームをフィールド単位で検証して読む（壊れた項目だけ既定に落ちる） */
function loadComposerForm(): ComposerForm {
  const raw = loadStored<Record<string, unknown>>(
    FORM_KEY,
    {},
    (v): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v),
  );
  const bars: ComposeBars = raw.bars === 16 ? 16 : raw.bars === 8 ? 8 : 4;
  const progId =
    typeof raw.progId === 'string' && PROGRESSIONS.some((p) => p.id === raw.progId && p.slots.length <= bars)
      ? raw.progId
      : 'royal-pop';
  const voices: VoiceOverride = {};
  if (raw.voices !== null && typeof raw.voices === 'object') {
    for (const part of ['lead', 'backing', 'bass'] as const) {
      const v = (raw.voices as Record<string, unknown>)[part];
      if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 15) voices[part] = v;
    }
  }
  return {
    bars,
    progId,
    styleId: typeof raw.styleId === 'string' && STYLES.some((s) => s.id === raw.styleId) ? raw.styleId : 'eurobeat',
    melodyMode: raw.melodyMode === 'japanese' ? 'japanese' : 'major',
    japaneseScale: ['ritsu', 'minyo', 'miyakobushi'].includes(String(raw.japaneseScale))
      ? raw.japaneseScale as JapaneseScaleChoice
      : 'auto',
    grooveFeel: ['tripletOverlay', 'bounce'].includes(String(raw.grooveFeel))
      ? raw.grooveFeel as GrooveFeel
      : 'straight',
    keyRoot: KEYS.some((k) => k.root === raw.keyRoot) ? (raw.keyRoot as number) : 0,
    bpm: typeof raw.bpm === 'number' && raw.bpm >= 80 && raw.bpm <= 220 ? raw.bpm : 170,
    soundChip: raw.soundChip === 'nes2a03' ? 'nes2a03' : 'opll',
    voices,
    nes: {
      pulse1Duty: [0, 1, 2, 3].includes((raw.nes as NesVoiceOptions | undefined)?.pulse1Duty ?? -1)
        ? ((raw.nes as NesVoiceOptions).pulse1Duty as 0 | 1 | 2 | 3)
        : 1,
      pulse2Duty: [0, 1, 2, 3].includes((raw.nes as NesVoiceOptions | undefined)?.pulse2Duty ?? -1)
        ? ((raw.nes as NesVoiceOptions).pulse2Duty as 0 | 1 | 2 | 3)
        : 2,
    },
    choice:
      Array.isArray(raw.choice) && raw.choice.every((c) => Number.isInteger(c) && c >= 0)
        ? (raw.choice as number[])
        : defaultChoiceFor(PROGRESSIONS.find((p) => p.id === progId)!, bars),
    autoVary: raw.autoVary !== false,
    intro: raw.intro !== false,
    seed: typeof raw.seed === 'number' && Number.isInteger(raw.seed) && raw.seed >= 0 ? raw.seed : newSeed(),
    loop: raw.loop !== false,
  };
}

export function BgmComposerPanel({ player }: { player: SfxPlayer }) {
  const [initial] = useState(loadComposerForm);
  const [bars, setBars] = useState<ComposeBars>(initial.bars);
  const [progId, setProgId] = useState(initial.progId);
  const [styleId, setStyleId] = useState(initial.styleId);
  const [melodyMode, setMelodyMode] = useState<MelodyMode>(initial.melodyMode);
  const [japaneseScale, setJapaneseScale] = useState<JapaneseScaleChoice>(initial.japaneseScale);
  const [grooveFeel, setGrooveFeel] = useState<GrooveFeel>(initial.grooveFeel);
  const [keyRoot, setKeyRoot] = useState(initial.keyRoot);
  const [bpm, setBpm] = useState(initial.bpm);
  const [soundChip, setSoundChip] = useState<'opll' | 'nes2a03'>(initial.soundChip);
  /** パート別音色の上書き。未指定パートはスタイル既定（選ばない限り保存データにも入らない） */
  const [voices, setVoices] = useState<VoiceOverride>(initial.voices);
  const [nes, setNes] = useState<NesVoiceOptions>(initial.nes);
  const [choice, setChoice] = useState<number[]>(initial.choice);
  const [autoVary, setAutoVary] = useState(initial.autoVary);
  const [intro, setIntro] = useState(initial.intro);
  const [seed, setSeed] = useState(initial.seed);
  const [loop, setLoop] = useState(initial.loop);
  const [piece, setPiece] = useState<Piece | null>(null);
  /** 最後に compose した正確なオプション（保存はこれを使う。UI をいじっただけでは変わらない） */
  const [lastOpts, setLastOpts] = useState<ComposeOptions | null>(null);
  /** 局所修正前の設定を積み、再生成・再生・保存を含めてUndoできるようにする。 */
  const [repairHistory, setRepairHistory] = useState<ComposeOptions[]>([]);
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

  // 作業中のフォーム設定を保存（リロードしても続きから作曲できる）
  useEffect(() => {
    saveStored(FORM_KEY, {
      bars, progId, styleId, melodyMode, japaneseScale, grooveFeel,
      keyRoot, bpm, soundChip, voices, nes, choice, autoVary, intro, seed, loop,
    });
  }, [
    bars, progId, styleId, melodyMode, japaneseScale, grooveFeel,
    keyRoot, bpm, soundChip, voices, nes, choice, autoVary, intro, seed, loop,
  ]);

  // 尺に収まる進行だけ選ばせる（8 小節進行は BB 専用）
  const progs = useMemo(() => PROGRESSIONS.filter((p) => p.slots.length <= bars), [bars]);
  const prog = progs.find((p) => p.id === progId) ?? progs[0]!;
  const canVaryChords = useMemo(() => hasVariedChoiceFor(prog, bars, choice), [bars, choice, prog]);

  const resetChoice = (nextProgId: string, nextBars: ComposeBars) => {
    const p = PROGRESSIONS.find((q) => q.id === nextProgId)!;
    setChoice(defaultChoiceFor(p, nextBars));
    setAutoVary(true);
  };

  const selectBars = (next: ComposeBars) => {
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

  const playOptions = async (opts: ComposeOptions, preserveRepairHistory = false) => {
    try {
      const p = compose(opts);
      if (!preserveRepairHistory) setRepairHistory([]);
      setError(player.enabled ? '' : '「音」が OFF のため音は鳴りません（このタブ上部で ON にできます）');
      setSeed(opts.seed);
      setPiece(p);
      setLastOpts(opts);
      setPlaying(false);
      if (!player.enabled) return;
      const def = arrangeComposedBgm(p, opts);
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

  const composeAndPlay = (nextSeed: number, forceChordVariation = false) => {
    // voices は上書きがあるときだけ入れる（既定のままなら旧保存曲と同一 JSON = キャッシュも共有）
    const picked = Object.fromEntries(
      VOICE_PARTS.filter(({ part }) => voices[part] !== undefined).map(({ part }) => [part, voices[part]]),
    ) as VoiceOverride;
    const nextChoice = forceChordVariation
      ? variedChoiceFor(prog, bars, nextSeed, { chancePercent: 100, currentChoice: choice })
      : autoVary
        ? variedChoiceFor(prog, bars, nextSeed)
        : [...choice];
    if (forceChordVariation || autoVary) setChoice(nextChoice);
    void playOptions({
      progressionId: prog.id,
      styleId,
      keyRoot,
      bpm,
      bars,
      seed: nextSeed,
      choice: nextChoice,
      soundChip,
      ...(intro ? {} : { intro: false }),
      ...(melodyMode === 'japanese' ? {
        melodyMode,
        ...(japaneseScale === 'auto' ? {} : { japaneseScale }),
      } : {}),
      ...(grooveFeel === 'straight' ? {} : { grooveFeel }),
      ...(soundChip === 'opll' && Object.keys(picked).length > 0 ? { voices: picked } : {}),
      ...(soundChip === 'nes2a03' ? { nes: { ...nes } } : {}),
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

  const applyRepair = (repair: CompositionRepair) => {
    if (!lastOpts) return;
    const nextOptions: ComposeOptions = {
      ...lastOpts,
      melodyEdits: [...(lastOpts.melodyEdits ?? []), repair.edit],
    };
    setRepairHistory((history) => [...history, lastOpts]);
    void playOptions(nextOptions, true);
  };

  const undoRepair = () => {
    const previous = repairHistory.at(-1);
    if (!previous) return;
    setRepairHistory((history) => history.slice(0, -1));
    void playOptions(previous, true);
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
        void player.ensureComposedBgm(
          JSON.stringify(song.options),
          arrangeComposedBgm(p, song.options),
        );
      } catch {
        // 壊れた保存データはボーナス開始時にプリセットへフォールバックされる
      }
    }
  };

  const diagnosis = useMemo(() => piece ? diagnosePiece(piece) : null, [piece]);
  const displayedDiagnosisItems = useMemo(
    () => piece && diagnosis
      ? diagnosis.issues
        .map((issue, originalIndex) => ({
          issue,
          originalIndex,
          repair: suggestCompositionRepair(piece, issue),
        }))
        .sort((a, b) => Number(b.repair !== null) - Number(a.repair !== null) || a.originalIndex - b.originalIndex)
        .slice(0, 8)
      : [],
    [diagnosis, piece],
  );

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
        <details className="composer-theory" data-testid="st-theory">
          <summary>📖 作曲の仕組み・音楽理論</summary>
          <div className="composer-theory-body">
            <dl>
              <dt>キーとコード進行</dt>
              <dd>
                コードはキーを基準にしたローマ数字で管理します。たとえば <code>I–vi–IV–V</code> は、
                キーCなら <code>C–Am–F–G</code>、キーFなら <code>F–Dm–B♭–C</code>
                （画面ではB♭をA#と表示）へ平行移動します。
              </dd>

              <dt>4小節、8小節、16小節</dt>
              <dd>
                4小節は短く覚えやすいループです。8小節では前半を基本形A、後半を変化形A&apos;として扱い、
                最後をドミナントへ寄せて次のループへ戻りやすくします。16小節ではAを8小節、Bを8小節に分け、
                必要なら、その前に2小節のイントロを一度だけ鳴らします。イントロはAの冒頭モチーフとスタイルから派生し、
                主題予告・グルーヴ提示・ファンファーレ・駆け上がりのうち、曲調に合う役割を選びます。直前の1.5拍を
                空けてAを強調し、ループ時はイントロを飛ばしてAの頭へ戻ります。A→Bの展開は毎回同じ足し算にせず、
                後半を厚くする「積み上げ」、後半で引く「対比」、密度を段階的に切り替える「段丘」から決めます。
              </dd>

              <dt>ゲームBGMのイントロ</dt>
              <dd>
                イントロは曲本体の短縮版ではなく、「世界観を示す」「主題を予告する」「Aの開始位置を知らせる」ための
                初回専用トランジションです。この生成では先に役割を決め、Aのモチーフやスタイルのリズムを変形して内容を
                作り、拍単位のブレイクからAへ渡します。イントロなしを選んだ場合は、ループ本体のAから直接始まります。
              </dd>

              <dt>コード変化レシピ</dt>
              <dd>
                各進行には3〜5個の確認済みレシピがあります。「コード変化して再生」は現在と同じ形を除外して抽選し、
                8小節では前半を保ったまま後半だけを変化させます。16小節ではAを保ち、Bに変化レシピを展開します。
                自由なランダム置換はしません。
              </dd>

              <dt>メロディ</dt>
              <dd>
                先に各小節の役割、音域の起伏、終止の種類、到達音をPhrasePlanとして決めます。メロディは2小節を
                「提示＋応答」の基本アイデアとし、8小節の中で「提示→変奏反復→展開→結論」へ運びます。変奏反復では
                元のリズムと輪郭を保ちながら和声に合わせて移調し、展開では進行方向を変え、結論では冒頭を部分的に
                回帰させてから終止へ向かいます。応答の末尾では半終止・終止・ターンアラウンドの
                目標音へ実際に到達します。各小節の1・3拍目はその時点のコードトーンです。最高音はセクション後半の
                2候補からシードで選び、毎曲まったく同じ位置には固定しません。最終小節の後半は音数を減らして
                ループ頭へ余白を渡します。「王道メジャー」は7音音階です。「和風五音」は旋律だけを差し替えるのでなく、
                律・民謡・都節系の音組織から選び、4度離れた核音をフレーズ開始・終止の柱にします。同音反復、
                4度/5度跳躍、開いた根音‐5度の伴奏配置、音階内のベース接続も連動します。さらに各応答小節へ
                意図した休符＝「間」を確保します。
              </dd>

              <dt>モチーフの反復と変奏</dt>
              <dd>
                モチーフは短い音程・リズム・輪郭のまとまりです。同じ形を置くだけでなく、移調、音程幅の変更、装飾、
                和声変更を加えて「同じだと分かるが少し違う」反復にします。診断も単音だけをコードと照合せず、
                音階上の隣接進行、経過音・刺繍音・倚音・逸音・掛留・先取音と、別小節で反復される輪郭を確認します。
                反復文脈で特徴として成立する非和声音は減点せず、意図として表示します。
              </dd>

              <dt>和風の装飾</dt>
              <dd>
                装飾は和風モードの全応答へ機械的に足しません。4小節のまとまりごとに一度だけ場所を選び、
                短い前打音、上下を回る「回し」、音程を細かく揺らす「揺り」を使い分けます。装飾前には間を予約し、
                通常音・前打音・到達音が毎回16分で3連続するのを避けます。揺りはOPLLと2A03それぞれの
                ピッチ操作へ変換します。
              </dd>

              <dt>副旋律とベース</dt>
              <dd>
                副旋律を後から隙間へ差すのではなく、PhrasePlanで主旋律と同時に専用の発音位置を予約します。
                音程は主旋律に対する反行を優先します。展開型に応じてコードトーンで短く返答する型と、
                小節をまたいで継続的に動く独立対旋律を使い分けます。ベースのフレーズ終端は小節番号ではなく、
                半終止・終止・ループ接続と次コードを参照します。接続方法もユーロビートは半音接近、ロックはコードトーン、
                スカは音階内のピックアップというように作曲スタイルへ合わせます。各声部の密度は選ばれた展開型に従います。
              </dd>

              <dt>リズムとドラム</dt>
              <dd>
                主旋律のリズムもスタイルごとに異なります。ユーロビートは細かな推進、ロックは表拍寄りの長めの音、
                スカは裏拍と短い音を優先します。提示と応答には異なる8分音符単位のリズムを使い、Bでさらに変えます。
                ゲーム用グルーヴは旋律様式から独立しており、ストレート、主旋律とベースを均等分割のままハイハット譜を
                三連位置へ写す「三連オーバーレイ」、裏の8分を2:1へ遅らせる「跳ねる8分」から選べます。
                三連オーバーレイは1拍を常に3発で埋めず、元のスタイルにある打点だけを使います。
                8小節目の末尾には短いドラムフィルを置き、その後は展開型に応じてB用グルーヴへ進むか、
                打点を引いたブレイクダウンへ切り替えます。最終小節の最後の1拍は空けてAへ戻します。
                自動生成時は最終コードもV（またはI7）へ寄せ、スタイル別のベース接続と合わせて次のAへ引っ張ります。
                ベースはコードのルートを基準に、スタイルごとにオクターブや5度を混ぜます。
              </dd>

              <dt>伴奏と作曲診断</dt>
              <dd>
                コード伴奏は構成音を固定オクターブへ置かず、転回形を含む候補から直前の声部に最も近い配置を選びます。
                音符には強弱とアクセント、スタッカート、テヌートを持たせ、FM音源と2A03それぞれの音量段階・音価へ反映します。
                生成後はコードをトニック・プレドミナント・ドミナント等の機能でも評価し、和声、旋律、声部進行、
                リズム、副旋律、フォーム、ループ接続を別々に診断します。
                総合点だけでなく、気になる項目と具体的な位置も確認できます。安全に局所修正できる注意には、
                非和声音を残して次音を解決する案を優先して提示します。候補は全曲を再診断し、新しい問題を増やさない
                場合だけ採用でき、修正後もUndoできます。
              </dd>

              <dt>シードとBPM</dt>
              <dd>
                BPMは曲全体の再生速度で、音符やコードの並びそのものは変えません。同じシードと設定なら同じ曲を再現します。
                「作曲」「コード変化」は新しいシードでメロディも作り直し、「同じメロディで再生」は最後の曲をそのまま再現します。
              </dd>
            </dl>
          </div>
        </details>

        <div className="panel-controls">
          <select
            value={soundChip}
            onChange={(e) => setSoundChip(e.target.value as 'opll' | 'nes2a03')}
            data-testid="st-sound-chip"
            title="曲ごとに保存され、BB/RB中の再生にもそのまま使われます"
          >
            <option value="opll">OPLL（YM2413・FM音源）</option>
            <option value="nes2a03">ファミコン 2A03（標準5ch制約）</option>
          </select>
          <select
            value={bars}
            onChange={(e) => selectBars(Number(e.target.value) as ComposeBars)}
            data-testid="st-bars"
            title="用途 = 尺。RB は短いループ、BB は A+A'、16小節は A→B で展開"
          >
            <option value={4}>RB 風（4小節ループ）</option>
            <option value={8}>BB 風（8小節ループ）</option>
            <option value={16}>ゲームBGM風（16小節 A→B）</option>
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
          <select
            value={melodyMode}
            onChange={(e) => setMelodyMode(e.target.value as MelodyMode)}
            data-testid="st-melody-mode"
            title="和風では音組織・核音・間・装飾・伴奏配置をまとめて変更します"
          >
            <option value="major">旋律: 王道メジャー</option>
            <option value="japanese">旋律: 和風五音</option>
          </select>
          {melodyMode === 'japanese' && (
            <select
              value={japaneseScale}
              onChange={(e) => setJapaneseScale(e.target.value as JapaneseScaleChoice)}
              data-testid="st-japanese-scale"
              title="自動ではシードごとに律・民謡・都節の音組織を選びます"
            >
              {(['auto', 'ritsu', 'minyo', 'miyakobushi'] as const).map((id) => (
                <option key={id} value={id}>和風音組織: {JAPANESE_SCALE_LABELS[id]}</option>
              ))}
            </select>
          )}
          <select
            value={grooveFeel}
            onChange={(e) => setGrooveFeel(e.target.value as GrooveFeel)}
            data-testid="st-groove-feel"
            title="旋律様式とは独立。三連は元のハイハット譜を三連位置へ写し、跳ねる8分は裏拍の位置を変えます"
          >
            {(['straight', 'tripletOverlay', 'bounce'] as const).map((feel) => (
              <option key={feel} value={feel}>グルーヴ: {GROOVE_FEEL_LABELS[feel]}</option>
            ))}
          </select>
        </div>

        {soundChip === 'opll' ? (
          <div className="panel-controls">
            {VOICE_PARTS.map(({ part, label }) => (
              <select
                key={part}
                value={voices[part] ?? 0}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setVoices((prev) => {
                    const next = { ...prev };
                    if (v === 0) delete next[part];
                    else next[part] = v;
                    return next;
                  });
                }}
                data-testid={`st-voice-${part}`}
              >
                <option value={0}>
                  {label}: スタイル既定（{voiceLabel(defaultVoicesFor(styleId)[part])}）
                </option>
                {OPLL_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {label}: {v.label}
                  </option>
                ))}
              </select>
            ))}
          </div>
        ) : (
          <>
            <div className="panel-controls" data-testid="st-nes-controls">
              {([
                ['pulse1Duty', 'パルス1・主旋律'],
                ['pulse2Duty', 'パルス2・伴奏'],
              ] as const).map(([part, label]) => (
                <select
                  key={part}
                  value={nes[part] ?? (part === 'pulse1Duty' ? 1 : 2)}
                  onChange={(e) => {
                    const duty = Number(e.target.value) as 0 | 1 | 2 | 3;
                    setNes((prev) => ({ ...prev, [part]: duty }));
                  }}
                  data-testid={`st-nes-${part}`}
                >
                  {NES_DUTIES.map((duty) => (
                    <option key={duty.id} value={duty.id}>{label}: {duty.label}</option>
                  ))}
                </select>
              ))}
            </div>
            <p className="panel-note nes-budget" data-testid="st-nes-budget">
              2A03配線: パルス1=主旋律 / パルス2=伴奏 / 三角波=ベース（音量変更不可） /
              ノイズ=ドラム / DPCM=未使用。1チャンネル1音、整数タイマー音程、15段階音量です。
            </p>
          </>
        )}

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
        <div className="slot-sections" data-testid="st-slots">
          {(bars === 16
            ? [
                { label: 'A', start: 0, end: 8 },
                { label: 'B', start: 8, end: 16 },
              ]
            : [{ label: '', start: 0, end: bars }]
          ).map((section) => (
            <div key={section.label || 'all'} className="slot-section">
              {section.label && <div className="slot-section-title">{section.label} セクション</div>}
              <div className="slot-row">
                {Array.from({ length: section.end - section.start }, (_, offset) => section.start + offset).map((bar) => {
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
                            setAutoVary(false);
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
            </div>
          ))}
        </div>

        <div className="panel-controls">
          <label>
            <input type="checkbox" checked={autoVary} onChange={(e) => setAutoVary(e.target.checked)} />
            {bars === 16
              ? '作曲時、Bセクションへコード変化レシピを必ず展開する'
              : '作曲時、25%の確率でコード変化レシピを選ぶ（8小節は後半のみ）'}
          </label>
          {bars === 16 && (
            <label>
              <input
                type="checkbox"
                checked={intro}
                onChange={(e) => setIntro(e.target.checked)}
                data-testid="st-intro"
              />
              2小節イントロを付ける（初回のみ）
            </label>
          )}
        </div>

        <div className="panel-controls">
          <button onClick={() => composeAndPlay(newSeed())} disabled={progress !== null} data-testid="st-compose">
            🎲 作曲して再生
          </button>
          <button
            onClick={() => composeAndPlay(newSeed(), true)}
            disabled={progress !== null || !canVaryChords}
            data-testid="st-chord-variation"
            title="現在とは違う、安全なコード変化レシピを抽選します"
          >
            🎹 コード変化して再生
          </button>
          <button
            onClick={() => lastOpts && void playOptions(lastOpts, true)}
            disabled={!lastOpts || progress !== null}
            data-testid="st-replay"
          >
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
            🎛 {soundChip === 'nes2a03' ? '2A03回路をエミュレーション' : 'OPLL（YM2413）で演奏を仕込み'}中… {Math.round(progress * 100)}%
          </p>
        )}
        {error && <p className="badge-ng">{error}</p>}
        {piece && (
          <div data-testid="st-result">
            <div className={`chord-line${piece.bars === 16 ? ' chord-form' : ''}`}>
              {piece.bars === 16 ? (
                <>
                  {piece.introBars > 0 && (
                    <span>
                      <b>
                        Intro（初回のみ・{piece.introBars}小節
                        {piece.introRole ? `・${INTRO_ROLE_LABELS[piece.introRole]}` : ''}）
                      </b> | {piece.introChordNames.join(' | ')} |
                    </span>
                  )}
                  <span><b>A</b> | {piece.barChordNames.slice(0, 8).join(' | ')} |</span>
                  <span><b>B</b> | {piece.barChordNames.slice(8).join(' | ')} |</span>
                </>
              ) : (
                <>| {piece.barChordNames.join(' | ')} |</>
              )}
            </div>
            <div className="melody-line">
              主旋律: {piece.melody.filter((n) => n.beat >= piece.loopStartBeat).map((n) => noteName(n.midi)).join(' ')}
            </div>
            <div className="melody-line">副旋律: {piece.counterMelody.map((n) => noteName(n.midi)).join(' ')}</div>
            <p className="panel-note">
              展開: {ARRANGEMENT_ARC_LABELS[piece.arrangementPlan.arc]} ／
              副旋律: {COUNTER_ROLE_LABELS[piece.arrangementPlan.counterRole]} ／
              グルーヴ: {GROOVE_FEEL_LABELS[piece.grooveFeel]}
              {piece.japanesePlan && (
                <> ／ 和風音組織: {JAPANESE_SCALE_LABELS[piece.japanesePlan.id]}
                  {' ／ '}装飾: {[...new Set(piece.phrasePlan.bars
                    .flatMap((plan) => plan.ornamentType ? [plan.ornamentType] : []))]
                    .map((type) => ORNAMENT_LABELS[type]).join('・') || 'なし'}
                </>
              )}
              {' ／ '}モチーフ: {[...new Set(piece.phrasePlan.bars.map((plan) => plan.phraseFunction))]
                .map((phraseFunction) => PHRASE_FUNCTION_LABELS[phraseFunction]).join('→')}
            </p>
            {diagnosis && (
              <details className="composer-diagnosis" data-testid="st-diagnosis">
                <summary>
                  作曲診断: <span className={diagnosis.overall >= 90 ? 'badge-ok' : 'badge-ng'}>
                    総合 {diagnosis.overall}点
                  </span>
                  {diagnosis.issues.length > 0 && ` ／ 指摘 ${diagnosis.issues.length}件`}
                </summary>
                <div className="diagnosis-grid">
                  {(Object.entries(diagnosis.scores) as [DiagnosticCategory, number][]).map(([category, score]) => (
                    <span key={category}>
                      {DIAGNOSTIC_LABELS[category]} <b className={score >= 90 ? 'badge-ok' : 'badge-ng'}>{score}</b>
                    </span>
                  ))}
                </div>
                {diagnosis.observations.length > 0 && (
                  <div className="diagnosis-observations" data-testid="st-diagnosis-observations">
                    <p className="panel-note">
                      意図として許容: モチーフ反復
                      {diagnosis.observations.filter((item) => item.kind === 'motif').length}件・装飾進行
                      {diagnosis.observations.filter((item) => item.kind === 'embellishment').length}件
                    </p>
                    <ul>
                      {diagnosis.observations.slice(0, 4).map((observation, index) => (
                        <li key={`${observation.kind}-${observation.beat}-${index}`}>
                          {observation.beat.toFixed(2)}拍: {observation.description}
                          {observation.relatedBeats.length > 0
                            ? `（同型 ${observation.relatedBeats.map((beat) => beat.toFixed(2)).join('・')}拍）`
                            : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {diagnosis.issues.length > 0 && (
                  <ul className="diagnosis-issues">
                    {displayedDiagnosisItems.map(({ issue, originalIndex, repair }, index) => {
                      return (
                        <li key={`${issue.category}-${issue.beat}-${originalIndex}`}>
                          {issue.severity === 'error' ? '要修正' : '注意'}・{DIAGNOSTIC_LABELS[issue.category]}・
                          {issue.beat.toFixed(2)}拍: {issue.reason}
                          {repair && (
                            <button
                              className="form-mini-btn"
                              onClick={() => applyRepair(repair)}
                              disabled={progress !== null}
                              data-testid={`st-repair-${index}`}
                              title={`${noteName(repair.edit.fromMidi)}から${noteName(repair.edit.toMidi)}へ最小修正し、全曲を再診断します`}
                            >
                              修正して試聴（{noteName(repair.edit.fromMidi)}→{noteName(repair.edit.toMidi)}）
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {repairHistory.length > 0 && (
                  <button
                    className="form-mini-btn"
                    onClick={undoRepair}
                    disabled={progress !== null}
                    data-testid="st-repair-undo"
                  >
                    ↶ 直前の修正を戻して試聴
                  </button>
                )}
              </details>
            )}
            <p className="panel-note">
              シード {seed}（同じシード + 同じ設定なら同じ曲になります）
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
          {soundChip === 'nes2a03' ? (
            <>
              2A03は日本版ファミコンのクロックで音程を整数タイマーへ量子化し、パルス2声・32段三角波・
              LFSRノイズを非線形ミキサーと実機相当の90Hz/440Hz HPF・14kHz LPFへ通します。
              拡張音源、任意波形、リバーブ、チャンネルエコーは使いません。DPCMサンプル編集は次段階です。
            </>
          ) : (
            <>
              OPLLではアクセント・チャンネルエコー・ビブラートも当時のレジスタ操作だけで掛けています。
              音色はパートごとに内蔵15音色から選べます。
            </>
          )}{' '}
          🔊はBGM全体の音量。保存した音源設定はBB/RBへの割り当てにもそのまま使われます。
        </p>
      </div>
    </details>
  );
}
