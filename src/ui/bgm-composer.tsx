import { useEffect, useMemo, useState } from 'react';
import {
  compose,
  COMPOSITION_STRATEGIES,
  compositionStrategyInfo,
  ARRANGEMENT_ARC_LABELS,
  COUNTER_ROLE_LABELS,
  TEXTURE_STRATEGY_LABELS,
  GROOVE_FEEL_LABELS,
  JAPANESE_SCALE_LABELS,
  ORNAMENT_LABELS,
  PHRASE_FUNCTION_LABELS,
  checkPieceStructure,
  defaultChoiceFor,
  hasVariedChoiceFor,
  INTRO_ROLE_LABELS,
  suggestCompositionRepair,
  variedChoiceFor,
  resolveMelodicLanguage,
  resolveTonality,
} from '../core/music/compose.js';
import type {
  ComposeBars,
  CompositionRepair,
  CompositionStrategy,
  ComposeOptions,
  DiagnosticCategory,
  GrooveFeel,
  JapaneseScaleChoice,
  MelodicLanguage,
  NesVoiceOptions,
  OpllUserPatchId,
  Piece,
  Tonality,
  VoiceOverride,
} from '../core/music/compose.js';
import {
  createBlindStudyTrial,
  summarizeBlindStudyVotes,
} from '../core/music/blind-study.js';
import type {
  BlindCandidateId,
  BlindStudyTrial,
  BlindStudyVote,
} from '../core/music/blind-study.js';
import {
  COMPOSITION_EXPERIMENTS,
  COMPOSITION_EXPERIMENT_STATUS_LABELS,
  COMPOSITION_HYPOTHESES,
  COMPOSITION_HYPOTHESIS_STATUS_LABELS,
} from '../core/music/composition-research.js';
import {
  KEYS,
  PROGRESSIONS,
  STYLES,
  chordName,
  noteName,
  progressionForTonality,
  progressionsForTonality,
} from '../core/music/theory.js';
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
import { defaultVoicesFor, OPLL_USER_PATCHES } from './opll-arrange.js';
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
  texture: '編成',
  form: 'フォーム',
  loop: 'ループ',
};

const STRUCTURAL_STATUS_LABELS = {
  pass: '問題なし',
  attention: '要確認',
  error: '要修正',
} as const;

const COMPOSITION_RESEARCH_COUNTS = {
  tested: COMPOSITION_HYPOTHESES.filter((hypothesis) => hypothesis.status === 'tested').length,
  partiallyTested: COMPOSITION_HYPOTHESES.filter((hypothesis) => hypothesis.status === 'partiallyTested').length,
  untested: COMPOSITION_HYPOTHESES.filter((hypothesis) => hypothesis.status === 'untested').length,
} as const;

/** 音色を上書きできる旋律パート（リズム5音は OPLL リズムモード固定） */
const VOICE_PARTS: readonly { part: keyof VoiceOverride; label: string }[] = [
  { part: 'lead', label: 'リード' },
  { part: 'backing', label: 'バッキング' },
  { part: 'bass', label: 'ベース' },
  { part: 'counter', label: '副旋律' },
  { part: 'ostinato', label: '分散和音' },
];

const voiceLabel = (id: number): string =>
  id === 0 ? 'ユーザー音色' : OPLL_VOICES.find((v) => v.id === id)?.label.split('（')[0] ?? String(id);

/** 保存曲の一覧表示用サマリ（例: BB風8小節 / 田中・真部進行 / キーC / BPM170） */
function songSummary(options: ComposeOptions): string {
  const prog = PROGRESSIONS.find((p) => p.id === options.progressionId)?.name ?? options.progressionId;
  const key = KEYS.find((k) => k.root === options.keyRoot)?.label ?? '?';
  const chip = options.soundChip === 'nes2a03' ? 'ファミコン2A03' : 'OPLL';
  const form = options.bars === 40
    ? 'OPLL BIG風40小節'
    : options.bars === 16 ? 'ゲームBGM風16小節' : options.bars === 8 ? 'BB風8小節' : 'RB風4小節';
  const intro = (options.bars === 16 || options.bars === 40) && options.intro === false ? ' / イントロなし' : '';
  const tonality = resolveTonality(options);
  const melodicLanguage = resolveMelodicLanguage(options);
  const tonalLabel = tonality === 'minor' ? ' / 短調' : '';
  const melody = melodicLanguage === 'japanese'
    ? ` / 和風五音(${JAPANESE_SCALE_LABELS[options.japaneseScale ?? 'auto']})`
    : '';
  const groove = options.grooveFeel && options.grooveFeel !== 'straight'
    ? ` / ${GROOVE_FEEL_LABELS[options.grooveFeel]}`
    : '';
  const edits = options.melodyEdits?.length ? ` / 局所修正${options.melodyEdits.length}` : '';
  const base = `${chip} / ${form}${intro}${tonalLabel}${melody}${groove}${edits} / ${prog} / キー${key} / BPM${options.bpm}`;
  if (options.soundChip === 'nes2a03') return base;
  const overridden = VOICE_PARTS.filter(({ part }) => options.voices?.[part] !== undefined);
  if (overridden.length === 0) return base;
  return `${base} / ${overridden.map(({ part, label }) => `${label}=${voiceLabel(options.voices![part]!)}`).join('・')}`;
}

/** 作曲フォームの永続化（曲リストとは別に、作業中の設定そのものを覚える） */
const FORM_KEY = 'daredemo.bgmComposer.form.v1';
const BLIND_VOTES_KEY = 'daredemo.bgmComposer.blindStudy.v1';

function isBlindStudyVote(value: unknown): value is BlindStudyVote {
  if (value === null || typeof value !== 'object') return false;
  const vote = value as Record<string, unknown>;
  return typeof vote.trialId === 'string'
    && ['current', 'memoryArc', 'premiseArc'].includes(String(vote.selected))
    && typeof vote.createdAt === 'number';
}

function loadBlindStudyVotes(): BlindStudyVote[] {
  return loadStored<BlindStudyVote[]>(
    BLIND_VOTES_KEY,
    [],
    (value): value is BlindStudyVote[] => Array.isArray(value) && value.every(isBlindStudyVote),
  );
}

interface ComposerForm {
  bars: ComposeBars;
  progId: string;
  styleId: string;
  tonality: Tonality;
  melodicLanguage: MelodicLanguage;
  japaneseScale: JapaneseScaleChoice;
  grooveFeel: GrooveFeel;
  keyRoot: number;
  bpm: number;
  soundChip: 'opll' | 'nes2a03';
  voices: VoiceOverride;
  opllUserPatch: OpllUserPatchId;
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
  const bars: ComposeBars = raw.bars === 40 ? 40 : raw.bars === 16 ? 16 : raw.bars === 8 ? 8 : 4;
  const legacyMode = raw.melodyMode === 'japanese'
    ? 'japanese'
    : raw.melodyMode === 'minor' ? 'minor' : 'major';
  const tonality: Tonality = raw.tonality === 'minor'
    ? 'minor'
    : raw.tonality === 'major' ? 'major' : legacyMode === 'minor' ? 'minor' : 'major';
  const melodicLanguage: MelodicLanguage = raw.melodicLanguage === 'japanese'
    ? 'japanese'
    : raw.melodicLanguage === 'standard' ? 'standard' : legacyMode === 'japanese' ? 'japanese' : 'standard';
  const availableProgressions = progressionsForTonality(tonality).filter((p) => p.slots.length <= bars);
  const initialProgression = typeof raw.progId === 'string'
    ? availableProgressions.find((p) => p.id === raw.progId) ?? availableProgressions[0]!
    : availableProgressions[0]!;
  const progId = initialProgression.id;
  const voices: VoiceOverride = {};
  if (raw.voices !== null && typeof raw.voices === 'object') {
    for (const part of ['lead', 'backing', 'bass', 'counter', 'ostinato'] as const) {
      const v = (raw.voices as Record<string, unknown>)[part];
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 15) voices[part] = v;
    }
  }
  return {
    bars,
    progId,
    styleId: typeof raw.styleId === 'string' && STYLES.some((s) => s.id === raw.styleId) ? raw.styleId : 'eurobeat',
    tonality,
    melodicLanguage,
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
    opllUserPatch: ['brightLead', 'metalBell', 'punchBass'].includes(String(raw.opllUserPatch))
      ? raw.opllUserPatch as OpllUserPatchId
      : 'brightLead',
    nes: {
      pulse1Duty: [0, 1, 2, 3].includes((raw.nes as NesVoiceOptions | undefined)?.pulse1Duty ?? -1)
        ? ((raw.nes as NesVoiceOptions).pulse1Duty as 0 | 1 | 2 | 3)
        : 1,
      pulse2Duty: [0, 1, 2, 3].includes((raw.nes as NesVoiceOptions | undefined)?.pulse2Duty ?? -1)
        ? ((raw.nes as NesVoiceOptions).pulse2Duty as 0 | 1 | 2 | 3)
        : 2,
    },
    choice:
      Array.isArray(raw.choice)
        && raw.choice.length >= bars
        && raw.choice.every((c, bar) => (
          Number.isInteger(c)
          && c >= 0
          && c < initialProgression.slots[bar % initialProgression.slots.length]!.length
        ))
        ? (raw.choice as number[])
        : defaultChoiceFor(initialProgression, bars),
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
  const [tonality, setTonality] = useState<Tonality>(initial.tonality);
  const [melodicLanguage, setMelodicLanguage] = useState<MelodicLanguage>(initial.melodicLanguage);
  const [japaneseScale, setJapaneseScale] = useState<JapaneseScaleChoice>(initial.japaneseScale);
  const [grooveFeel, setGrooveFeel] = useState<GrooveFeel>(initial.grooveFeel);
  const [keyRoot, setKeyRoot] = useState(initial.keyRoot);
  const [bpm, setBpm] = useState(initial.bpm);
  const [soundChip, setSoundChip] = useState<'opll' | 'nes2a03'>(initial.soundChip);
  /** パート別音色の上書き。未指定パートはスタイル既定（選ばない限り保存データにも入らない） */
  const [voices, setVoices] = useState<VoiceOverride>(initial.voices);
  const [opllUserPatch, setOpllUserPatch] = useState<OpllUserPatchId>(initial.opllUserPatch);
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
  const [blindTrial, setBlindTrial] = useState<BlindStudyTrial | null>(null);
  const [blindListened, setBlindListened] = useState<BlindCandidateId[]>([]);
  const [blindSelection, setBlindSelection] = useState<BlindCandidateId | null>(null);
  const [blindRevealed, setBlindRevealed] = useState(false);
  const [blindPlaying, setBlindPlaying] = useState<BlindCandidateId | null>(null);
  const [blindVotes, setBlindVotes] = useState<BlindStudyVote[]>(loadBlindStudyVotes);
  const blindVoteSummary = useMemo(() => summarizeBlindStudyVotes(blindVotes), [blindVotes]);

  useEffect(() => {
    player.setBgmVolume(volume / 100);
    saveBgmVolume(volume);
  }, [player, volume]);

  // 作業中のフォーム設定を保存（リロードしても続きから作曲できる）
  useEffect(() => {
    saveStored(FORM_KEY, {
      bars, progId, styleId, tonality, melodicLanguage, japaneseScale, grooveFeel,
      keyRoot, bpm, soundChip, voices, opllUserPatch, nes, choice, autoVary, intro, seed, loop,
    });
  }, [
    bars, progId, styleId, tonality, melodicLanguage, japaneseScale, grooveFeel,
    keyRoot, bpm, soundChip, voices, opllUserPatch, nes, choice, autoVary, intro, seed, loop,
  ]);

  // 尺と調性に合う進行実体を選ばせる。同じ進行IDに短調版があれば名前を消さず保持する。
  const progs = useMemo(
    () => progressionsForTonality(tonality).filter((p) => p.slots.length <= bars),
    [bars, tonality],
  );
  const prog = progs.find((p) => p.id === progId) ?? progs[0]!;
  const canVaryChords = useMemo(() => hasVariedChoiceFor(prog, bars, choice), [bars, choice, prog]);

  const resetChoice = (nextProgId: string, nextBars: ComposeBars, nextTonality = tonality) => {
    const source = PROGRESSIONS.find((q) => q.id === nextProgId)!;
    const p = progressionForTonality(source, nextTonality)!;
    setChoice(defaultChoiceFor(p, nextBars));
    setAutoVary(true);
  };

  const selectBars = (next: ComposeBars) => {
    const available = progressionsForTonality(tonality).filter((p) => p.slots.length <= next);
    const nextProgId = available.some((p) => p.id === prog.id) ? prog.id : available[0]!.id;
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
    setBlindPlaying(null);
  };

  const optionsFor = (
    nextSeed: number,
    targetBars: ComposeBars,
    targetChoice: readonly number[],
    compositionStrategy?: CompositionStrategy,
  ): ComposeOptions => {
    // voices は上書きがあるときだけ入れる（既定のままなら旧保存曲と同一 JSON = キャッシュも共有）
    const picked = Object.fromEntries(
      VOICE_PARTS.filter(({ part }) => voices[part] !== undefined).map(({ part }) => [part, voices[part]]),
    ) as VoiceOverride;
    return {
      progressionId: prog.id,
      styleId,
      keyRoot,
      bpm,
      bars: targetBars,
      seed: nextSeed,
      choice: [...targetChoice],
      soundChip,
      ...(intro ? {} : { intro: false }),
      ...(tonality === 'minor' ? { tonality } : {}),
      ...(melodicLanguage === 'japanese' ? {
        melodicLanguage,
        ...(japaneseScale !== 'auto' ? { japaneseScale } : {}),
      } : {}),
      ...(grooveFeel === 'straight' ? {} : { grooveFeel }),
      ...(soundChip === 'opll' && Object.keys(picked).length > 0 ? { voices: picked } : {}),
      ...(soundChip === 'opll' && Object.values(picked).includes(0) ? { opllUserPatch } : {}),
      ...(soundChip === 'nes2a03' ? { nes: { ...nes } } : {}),
      ...(compositionStrategy ? { compositionStrategy } : {}),
    };
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
      setBlindPlaying(null);
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
    const nextChoice = forceChordVariation
      ? variedChoiceFor(prog, bars, nextSeed, { chancePercent: 100, currentChoice: choice })
      : autoVary
        ? variedChoiceFor(prog, bars, nextSeed)
        : [...choice];
    if (forceChordVariation || autoVary) setChoice(nextChoice);
    void playOptions(optionsFor(nextSeed, bars, nextChoice));
  };

  const startBlindStudy = () => {
    try {
      stop();
      const nextSeed = newSeed();
      const nextChoice = variedChoiceFor(prog, 40, nextSeed);
      const baseOptions = optionsFor(nextSeed, 40, nextChoice);
      const trial = createBlindStudyTrial(
        `t${Date.now().toString(36)}${nextSeed.toString(36)}`,
        baseOptions,
        nextSeed ^ 0x424c_494e,
      );
      // 音声レンダリング前に3条件とも構成可能か検証し、途中で一候補だけ失敗する状態を防ぐ。
      trial.candidates.forEach((candidate) => compose(candidate.options));
      setBlindTrial(trial);
      setBlindListened([]);
      setBlindSelection(null);
      setBlindRevealed(false);
      setBlindPlaying(null);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const playBlindCandidate = async (candidateId: BlindCandidateId) => {
    const candidate = blindTrial?.candidates.find((item) => item.id === candidateId);
    if (!candidate) return;
    try {
      setError(player.enabled ? '' : '「音」が OFF のため比較試聴できません（このタブ上部で ON にできます）');
      if (!player.enabled) return;
      setPlaying(false);
      setBlindPlaying(null);
      const candidatePiece = compose(candidate.options);
      const def = arrangeComposedBgm(candidatePiece, candidate.options);
      setProgress(0);
      const result = await player.playComposedBgm(JSON.stringify(candidate.options), def, 0, {
        loop: false,
        onProgress: setProgress,
      });
      setProgress(null);
      if (result === 'played') {
        setBlindPlaying(candidateId);
        setBlindListened((listened) => listened.includes(candidateId) ? listened : [...listened, candidateId]);
      }
    } catch (e) {
      setProgress(null);
      setBlindPlaying(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const revealBlindStudy = () => {
    if (!blindTrial || !blindSelection || blindListened.length < 3 || blindRevealed) return;
    const selected = blindTrial.candidates.find((candidate) => candidate.id === blindSelection);
    if (!selected) return;
    stop();
    const nextVotes = [
      ...blindVotes,
      { trialId: blindTrial.id, selected: selected.strategy, createdAt: Date.now() },
    ];
    setBlindVotes(nextVotes);
    saveStored(BLIND_VOTES_KEY, nextVotes);
    setBlindRevealed(true);
  };

  const saveSong = () => {
    if (!lastOpts) return;
    const name = songName.trim() || songSummary(lastOpts);
    const next = [...songs, { id: newSongId(), name, options: lastOpts }];
    setSongs(next);
    saveSongs(next);
    setSongName('');
  };

  const selectTonality = (nextTonality: Tonality) => {
    const available = progressionsForTonality(nextTonality).filter((p) => p.slots.length <= bars);
    const nextProg = available.find((p) => p.id === prog.id) ?? available[0]!;
    setTonality(nextTonality);
    setProgId(nextProg.id);
    resetChoice(nextProg.id, bars, nextTonality);
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

  const diagnosis = useMemo(() => piece ? checkPieceStructure(piece) : null, [piece]);
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

              <dt>4小節、8小節、16小節、OPLL BIG</dt>
              <dd>
                4小節は短く覚えやすいループです。8小節では確認済みレシピを2つ組み、前半も曲ごとに選びながらA–A&apos;を作り、
                最後をドミナントへ寄せて次のループへ戻りやすくします。16小節ではAを8小節、Bを8小節に分け、
                必要なら、その前に2小節のイントロを一度だけ鳴らします。イントロもSongPlanに含め、A冒頭のコード・主題・
                拍節から逆算して、主題予告・グルーヴ提示・ファンファーレ・駆け上がりの役割を選びます。A直前の間は
                全型一律にせず、役割に応じて0〜1.5拍を使い分けます。ループ時はイントロを飛ばしてAの頭へ戻ります。
                A→Bの展開は毎回同じ足し算にせず、
                後半を厚くする「積み上げ」、後半で引く「対比」、密度を段階的に切り替える「段丘」から決めます。
                4・8小節でも伴奏を一律の短い応答へ固定せず、主旋律の密度と音源に合わせて、対旋律・分散和音・低音主導・
                標準編成から一つを主役に選びます。
                40小節は8小節ずつのA–B–C–D–Eです。提示・展開・対照・回帰・フィナーレという役割は保ちますが、
                各区間のコード、モチーフ変形、密度、山の位置は単一の固定表から選びません。回帰も前区間の完全コピーではなく、
                同じ語彙を移調・反転・リズム変奏して再認識できる形にします。2小節イントロを付けた場合は全42小節です。
              </dd>

              <dt>ゲームBGMのイントロ</dt>
              <dd>
                イントロは曲本体の短縮版ではなく、「世界観を示す」「主題を予告する」「Aの開始位置を知らせる」ための
                初回専用トランジションです。1小節目で曲の正体を示し、2小節目は音数を必ず増やすのではなく、入口の和音へ
                向かう接続として設計します。主題予告はAの音程関係を保ち、グルーヴ型はリズム隊から主旋律へ、駆け上がり型は
                保持音から短いランへ楽器を受け渡します。イントロなしを選んだ場合は、ループ本体のAから直接始まります。
              </dd>

              <dt>コード変化レシピ</dt>
              <dd>
                各進行には3〜5個の確認済みレシピがあります。「コード変化して再生」は現在と同じ形を除外して抽選し、
                8小節では異なる2レシピを組み、16小節ではA・Bそれぞれへ異なる8小節形を割り当てます。
                自由なランダム置換はしません。選択した進行をSongPlanへ取り込み、先に各小節を提示・継続・展開・解決・
                ターンアラウンドへ割り当てます。基本は1小節1コードですが、展開で別機能へ早く移る場合は1拍＋3拍、
                終止直前のドミナントは3拍＋1拍、それ以外は2拍＋2拍にします。非対称な場合はコード名へ拍数を表示し、
                分散和音・ベース・主旋律も同じ変更点を参照します。40小節では確認済みレシピを区間ごとに組み替え、
                単純な巡回順ではなく役割付きの順列から選びます。A–Eの完全コピーと、各区間冒頭4小節の一律固定を避け、
                半小節変化も曲によって使わない選択を残します。
              </dd>

              <dt>メロディ</dt>
              <dd>
                先に各小節の役割、音域の起伏、終止の種類、到達音をPhrasePlanとして決めます。メロディは2小節を
                「提示＋応答」の基本アイデアとし、8小節の中で「提示→変奏反復→展開→結論」へ運びます。変奏反復では
                元のリズムと輪郭を保ちながら和声に合わせて移調し、展開では進行方向を変え、結論では冒頭を部分的に
                回帰させてから終止へ向かいます。応答の末尾では半終止・終止・ターンアラウンドの
                目標音へ実際に到達します。各小節の1・3拍目はその時点のコードトーンです。最高音は短形式では中盤〜終盤、
                複数区間では最もエネルギーが高い区間の後半候補から選び、毎曲まったく同じ位置には固定しません。最終小節の後半は音数を減らして
                ループ頭へ余白を渡します。調性はコード進行と標準旋律の長音階・短音階を決め、旋律語法とは独立しています。
                そのため短調の和声に和風五音の旋律を組み合わせることもできます。「和風五音」は旋律だけを差し替えるのでなく、
                律・民謡・都節系の音組織から選び、4度離れた核音をフレーズ開始・終止の柱にします。同音反復、
                4度/5度跳躍、開いた根音‐5度の伴奏配置、音階内のベース接続も連動します。さらに各応答小節へ
                意図した休符＝「間」を確保します。短調の標準語法では自然短音階を基礎に、主和音を保って押すペダル型と、
                i–VI–III–VII系のドライブ型を使います。
              </dd>

              <dt>モチーフの反復と変奏</dt>
              <dd>
                モチーフは短い音程・リズム・輪郭のまとまりです。同じ形を置くだけでなく、移調、音程幅の変更、装飾、
                和声変更を加えて「同じだと分かるが少し違う」反復にします。長い曲で前区間から借りるのは冒頭2小節の核だけで、
                残り6小節は各区間専用の音程ジェスチャーから展開します。同じ和声で移調量が0になる場合は、別コードトーンへの
                核音移動または輪郭反転へ切り替えます。診断も単音だけをコードと照合せず、
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

              <dt>裏メロ・16分アルペジオ・ベース</dt>
              <dd>
                副旋律を後から隙間へ差すのではなく、PhrasePlanで主旋律と同時に専用の発音位置を予約します。
                音程は主旋律に対する反行を優先します。展開型に応じてコードトーンで短く返答する型と、
                小節をまたいで継続的に動く独立対旋律を使い分けます。ベースのフレーズ終端は小節番号ではなく、
                半終止・終止・ループ接続と次コードを参照します。接続方法もユーロビートは半音接近、ロックはコードトーン、
                スカは音階内のピックアップというように作曲スタイルへ合わせます。編成方針はseedだけで決めず、スタイル、
                主旋律の密度、グルーヴ、区間のエネルギー、音源の同時発音能力から互換候補を絞ります。OPLLでは
                「分散和音主導・対旋律主導・低音主導・交替型」を使い分け、2A03では独立アルペジオを生成後に捨てず、
                2本のパルスと三角波で実現できる編成を最初から選びます。仕掛けは全区間へ貼らずに休止と再登場を作ります。
                裏メロを選んだ区間では、主旋律が休む半小節へ3音の短い応答句としてまとめ、中央音だけに
                次のコードトーンへ順次解決する経過音・刺繍音を許します。分散和音を選んだ区間では、
                8分を基準に、変奏反復・展開・結論のどこで16分へ加速するかを区間ごとに選び、
                8小節を同じ刻みで埋めません。
                各打点で現在のコードを引き直すため、半小節でコードが変わればアルペジオも同じ位置から構成音を切り替えます。
                BIGのベースは通常曲より約1オクターブ下げ、ペダル低音は低音主導を選んだ曲だけで使います。
              </dd>

              <dt>リズムとドラム</dt>
              <dd>
                主旋律のリズムもスタイルごとに異なります。ユーロビートは細かな推進、ロックは表拍寄りの長めの音、
                スカは裏拍と短い音を優先します。提示と応答には異なる8分音符単位のリズムを使い、Bでさらに変えます。
                ゲーム用グルーヴは旋律様式から独立しており、ストレート、主旋律とベースを均等分割のままハイハット譜を
                三連位置へ写す「三連オーバーレイ」、裏の8分を2:1へ遅らせる「跳ねる8分」から選べます。
                三連オーバーレイは1拍を常に3発で埋めず、元のスタイルにある打点だけを使います。
                セクション境界では前後のエネルギー差から、フィルなし・軽いフィル・フルフィルを選びます。その後は
                区間の役割に応じてB用グルーヴへ進むか、打点を引いたブレイクダウンへ切り替えます。
                最終小節の最後の1拍は空けてAへ戻します。
                自動生成時は最終コードもV（またはI7）へ寄せ、スタイル別のベース接続と合わせて次のAへ引っ張ります。
                ベースはコードのルートを基準に、スタイルごとにオクターブや5度を混ぜます。
              </dd>

              <dt>伴奏と構造チェック</dt>
              <dd>
                コード伴奏は構成音を固定オクターブへ置かず、転回形を含む候補から直前の声部に最も近い配置を選びます。
                音符には強弱とアクセント、スタッカート、テヌートを持たせ、FM音源と2A03それぞれの音量段階・音価へ反映します。
                生成後はコードをトニック・プレドミナント・ドミナント等の機能でも確認し、和声、旋律、声部進行、
                リズム、副旋律、編成、フォーム、ループ接続の構造的不整合を別々に検査します。これは曲の魅力を採点する
                機能ではないため総合点は表示せず、「問題なし・要確認・要修正」で示します。安全に局所修正できる注意には、
                非和声音を残して次音を解決する案を優先して提示します。候補は全曲を再診断し、新しい問題を増やさない
                場合だけ採用でき、修正後もUndoできます。区間同士が完全一致しなくても、複数の2小節フレーズでリズムと
                輪郭が似すぎる場合は「同じ話し方への収束」として検出します。
              </dd>

              <dt>OPLLの音数と音色</dt>
              <dd>
                リズムモード時は旋律6チャンネルと、バスドラム・スネア・タム・シンバル・ハイハットの5打楽器です。
                主旋律、ベース、裏メロ、分散和音、コード伴奏、薄いダブリングを優先度順に6音へ割り当て、
                超えた瞬間だけ低優先度の音から省きます。内蔵15音色に加え、音色0番へ曲ごとに1種類のユーザー音色を定義できます。
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
            title="用途 = 尺。40小節はOPLL BIG向けのA→B→C→D→Eフォーム"
          >
            <option value={4}>RB 風（4小節ループ）</option>
            <option value={8}>BB 風（8小節ループ）</option>
            <option value={16}>ゲームBGM風（16小節 A→B）</option>
            <option value={40}>OPLL BIG風（40小節 A→B→C→D→E）</option>
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
            value={tonality}
            onChange={(e) => selectTonality(e.target.value as Tonality)}
            data-testid="st-tonality"
            title="コード進行と基礎音階の調性を選びます"
          >
            <option value="major">調性: 長調</option>
            <option value="minor">調性: 短調</option>
          </select>
          <select
            value={melodicLanguage}
            onChange={(e) => setMelodicLanguage(e.target.value as MelodicLanguage)}
            data-testid="st-melodic-language"
            title="調性とは独立して、旋律の音使い・間・装飾を選びます"
          >
            <option value="standard">旋律語法: 標準</option>
            <option value="japanese">旋律語法: 和風五音</option>
          </select>
          {melodicLanguage === 'japanese' && (
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
                value={voices[part] ?? -1}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setVoices((prev) => {
                    const next = { ...prev };
                    if (v === -1) delete next[part];
                    else next[part] = v;
                    return next;
                  });
                }}
                data-testid={`st-voice-${part}`}
              >
                <option value={-1}>
                  {label}: スタイル既定（{voiceLabel(defaultVoicesFor(styleId)[part])}）
                </option>
                <option value={0}>{label}: ユーザー音色（曲ごとに1種）</option>
                {OPLL_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {label}: {v.label}
                  </option>
                ))}
              </select>
            ))}
            {Object.values(voices).includes(0) && (
              <select
                value={opllUserPatch}
                onChange={(e) => setOpllUserPatch(e.target.value as OpllUserPatchId)}
                data-testid="st-opll-user-patch"
                title="OPLLの音色0番は、1曲につき1種類だけレジスタ定義できます"
              >
                {OPLL_USER_PATCHES.map((patch) => (
                  <option key={patch.id} value={patch.id}>ユーザー音色: {patch.label}</option>
                ))}
              </select>
            )}
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
              40小節フォームも再生できますが、新しい独立声部の2A03専用間引きは次段階です。
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
          {(bars === 40
            ? ['A', 'B', 'C', 'D', 'E'].map((label, index) => ({ label, start: index * 8, end: index * 8 + 8 }))
            : bars === 16
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
            {bars === 40
              ? '作曲時、各8小節区間へコード変化レシピを展開する'
              : bars === 16
                ? '作曲時、A・Bへ異なるコード変化レシピを展開する'
                : bars === 8
                  ? '作曲時、異なる2つのコード変化レシピを組み合わせる'
                  : '作曲時、25%の確率でコード変化レシピを選ぶ'}
          </label>
          {(bars === 16 || bars === 40) && (
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

        <section className="blind-study" data-testid="blind-study">
          <div className="blind-study-head">
            <div>
              <h3>3条件ブラインド比較</h3>
              <p>
                現在の進行・スタイル・キー・BPM・音色から40小節を生成します。
                3候補はシードと進行語彙を共有し、フォーム・和声・旋律・編成を導く作曲戦略だけが異なります。
              </p>
            </div>
            <button
              type="button"
              onClick={startBlindStudy}
              disabled={progress !== null}
              data-testid="blind-start"
            >
              {blindTrial ? '↻ 新しい比較を作る' : '⚗ 比較を作る'}
            </button>
          </div>

          {blindTrial ? (
            <>
              <div className="blind-candidates">
                {blindTrial.candidates.map((candidate) => {
                  const listened = blindListened.includes(candidate.id);
                  const selected = blindSelection === candidate.id;
                  const strategy = compositionStrategyInfo(candidate.strategy);
                  return (
                    <article
                      key={candidate.id}
                      className={`blind-candidate${selected ? ' selected' : ''}${blindPlaying === candidate.id ? ' playing' : ''}`}
                      data-testid={`blind-candidate-${candidate.id}`}
                    >
                      <div className="blind-candidate-title">
                        <span>候補</span>
                        <strong>{candidate.id}</strong>
                        <small>{listened ? '試聴済み' : '未試聴'}</small>
                      </div>
                      <button
                        type="button"
                        onClick={() => void playBlindCandidate(candidate.id)}
                        disabled={progress !== null}
                        data-testid={`blind-play-${candidate.id}`}
                      >
                        {blindPlaying === candidate.id ? '▶ 再生中' : listened ? '▶ もう一度聴く' : '▶ 試聴する'}
                      </button>
                      <label className="blind-pick">
                        <input
                          type="radio"
                          name="blind-favorite"
                          value={candidate.id}
                          checked={selected}
                          disabled={blindRevealed}
                          onChange={() => setBlindSelection(candidate.id)}
                          data-testid={`blind-pick-${candidate.id}`}
                        />
                        これが一番よい
                      </label>
                      {blindRevealed && (
                        <div className="blind-reveal" data-testid={`blind-reveal-${candidate.id}`}>
                          <b>条件{strategy.condition}: {strategy.label}</b>
                          <span>{strategy.description}</span>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>

              <div className="blind-study-actions">
                <button
                  type="button"
                  onClick={revealBlindStudy}
                  disabled={blindRevealed || blindListened.length < 3 || blindSelection === null || progress !== null}
                  data-testid="blind-reveal"
                >
                  結果を見る
                </button>
                <button type="button" onClick={stop} disabled={blindPlaying === null}>
                  ■ 停止
                </button>
                {!blindRevealed && (
                  <span className="blind-progress-copy">
                    {blindListened.length}/3 試聴済み
                    {blindListened.length === 3 && blindSelection === null ? ' — 一番よい候補を選んでください' : ''}
                  </span>
                )}
              </div>

              {blindRevealed && blindSelection && (
                <div className="blind-result" data-testid="blind-result">
                  <p>
                    今回選んだのは <strong>候補{blindSelection}</strong> — {' '}
                    {(() => {
                      const selected = blindTrial.candidates.find((candidate) => candidate.id === blindSelection)!;
                      const strategy = compositionStrategyInfo(selected.strategy);
                      return `条件${strategy.condition}「${strategy.label}」`;
                    })()}
                  </p>
                  <div className="blind-totals" aria-label={`累計${blindVotes.length}試行`}>
                    <span className="blind-total-label">累計 {blindVotes.length} 試行</span>
                    {COMPOSITION_STRATEGIES.map((strategy) => (
                      <span key={strategy.id}>
                        条件{strategy.condition} {strategy.label}: <b>{blindVoteSummary[strategy.id]}</b>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="blind-empty">
              条件名と並び順は結果を見るまで表示されません。3候補をすべて聴くと投票できます。
            </p>
          )}

          <details className="composition-research" data-testid="composition-research">
            <summary>
              <span>作曲仮説と検証履歴</span>
              <small>
                検証済み {COMPOSITION_RESEARCH_COUNTS.tested} ／
                一部検証 {COMPOSITION_RESEARCH_COUNTS.partiallyTested} ／
                未検証 {COMPOSITION_RESEARCH_COUNTS.untested}
              </small>
            </summary>
            <div className="composition-research-body">
              <p className="composition-research-intro">
                比較で分かったことと、まだ比較できていない仮説を同じ研究ログで管理します。
                新しい条件は、ここに仮説と比較方法を書いてから追加します。
              </p>

              <section className="composition-experiment-history" aria-labelledby="composition-experiment-title">
                <h4 id="composition-experiment-title">今までに検証したことと結果</h4>
                {COMPOSITION_EXPERIMENTS.map((experiment, index) => (
                  <article key={experiment.id} className="composition-experiment" data-testid={`composition-experiment-${experiment.id}`}>
                    <header>
                      <div>
                        <small>{index === COMPOSITION_EXPERIMENTS.length - 1 ? '直近の検証' : experiment.id}</small>
                        <h5>{experiment.title}</h5>
                      </div>
                      <span className={`research-status experiment-${experiment.status}`}>
                        {COMPOSITION_EXPERIMENT_STATUS_LABELS[experiment.status]}
                      </span>
                    </header>
                    <p><b>問い:</b> {experiment.question}</p>
                    <div className="composition-condition-list" aria-label="比較条件">
                      {experiment.conditions.map((condition) => <span key={condition}>{condition}</span>)}
                    </div>
                    <p className="composition-experiment-result"><b>結果:</b> {experiment.result}</p>
                    <p><b>暫定結論:</b> {experiment.conclusion}</p>
                    <details className="composition-limitations">
                      <summary>この結果でまだ言えないこと</summary>
                      <ul>
                        {experiment.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
                      </ul>
                    </details>
                  </article>
                ))}
              </section>

              <section className="composition-hypothesis-section" aria-labelledby="composition-hypothesis-title">
                <h4 id="composition-hypothesis-title">仮説リスト</h4>
                <p>未検証のものを順次、同じ素材を使ったブラインド比較へ入れていきます。</p>
                <div className="composition-hypothesis-list">
                  {COMPOSITION_HYPOTHESES.map((hypothesis) => (
                    <details
                      key={hypothesis.id}
                      className={`composition-hypothesis hypothesis-${hypothesis.status}`}
                      data-testid={`composition-hypothesis-${hypothesis.id}`}
                    >
                      <summary>
                        <span>
                          <small>{hypothesis.id}</small>
                          {hypothesis.title}
                        </span>
                        <b className={`research-status hypothesis-${hypothesis.status}`}>
                          {COMPOSITION_HYPOTHESIS_STATUS_LABELS[hypothesis.status]}
                        </b>
                      </summary>
                      <div className="composition-hypothesis-detail">
                        <p><b>仮説:</b> {hypothesis.proposition}</p>
                        <p><b>現在の判断:</b> {hypothesis.assessment}</p>
                        {hypothesis.experimentIds.length > 0 && (
                          <p><b>根拠:</b> {hypothesis.experimentIds.join('、')}</p>
                        )}
                        <p><b>次の比較:</b> {hypothesis.nextComparison}</p>
                      </div>
                    </details>
                  ))}
                </div>
              </section>
            </div>
          </details>
        </section>

        {progress !== null && (
          <p className="panel-note" data-testid="st-progress">
            🎛 {soundChip === 'nes2a03' ? '2A03回路をエミュレーション' : 'OPLL（YM2413）で演奏を仕込み'}中… {Math.round(progress * 100)}%
          </p>
        )}
        {error && <p className="badge-ng">{error}</p>}
        {piece && (
          <div data-testid="st-result">
            <div className={`chord-line${piece.bars >= 16 ? ' chord-form' : ''}`}>
              {piece.bars >= 16 ? (
                <>
                  {piece.introBars > 0 && (
                    <span>
                      <b>
                        Intro（初回のみ・{piece.introBars}小節
                        {piece.introRole ? `・${INTRO_ROLE_LABELS[piece.introRole]}` : ''}）
                      </b> | {piece.introChordNames.join(' | ')} |
                    </span>
                  )}
                  {Array.from({ length: piece.bars / 8 }, (_, index) => (
                    <span key={index}>
                      <b>{String.fromCharCode(65 + index)}</b> | {piece.barChordNames.slice(index * 8, index * 8 + 8).join(' | ')} |
                    </span>
                  ))}
                </>
              ) : (
                <>| {piece.barChordNames.join(' | ')} |</>
              )}
            </div>
            <div className="melody-line">
              主旋律: {piece.melody.filter((n) => n.beat >= piece.loopStartBeat).map((n) => noteName(n.midi)).join(' ')}
            </div>
            <div className="melody-line">副旋律: {piece.counterMelody.map((n) => noteName(n.midi)).join(' ')}</div>
            {piece.ostinato.length > 0 && (
              <div className="melody-line">分散和音: {piece.ostinato.map((n) => noteName(n.midi)).join(' ')}</div>
            )}
            <p className="panel-note">
              展開: {ARRANGEMENT_ARC_LABELS[piece.arrangementPlan.arc]} ／
              編成: {TEXTURE_STRATEGY_LABELS[piece.arrangementPlan.textureStrategy]} ／
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
                  構造チェック: <span className={diagnosis.status === 'pass' ? 'badge-ok' : 'badge-ng'}>
                    {STRUCTURAL_STATUS_LABELS[diagnosis.status]}
                  </span>
                  {diagnosis.issues.length > 0 && ` ／ 指摘 ${diagnosis.issues.length}件`}
                </summary>
                <div className="diagnosis-grid">
                  {(Object.entries(diagnosis.categoryStatus) as [DiagnosticCategory, keyof typeof STRUCTURAL_STATUS_LABELS][])
                    .map(([category, status]) => (
                    <span key={category}>
                      {DIAGNOSTIC_LABELS[category]}{' '}
                      <b className={status === 'pass' ? 'badge-ok' : 'badge-ng'}>
                        {STRUCTURAL_STATUS_LABELS[status]}
                      </b>
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
              OPLLでは旋律6chを重要度順に動的配線し、リズム5音、アクセント、薄いダブリング、ビブラートも
              当時のレジスタ操作だけで掛けています。音色は内蔵15種と、曲ごとに1種のユーザー音色から選べます。
            </>
          )}{' '}
          🔊はBGM全体の音量。保存した音源設定はBB/RBへの割り当てにもそのまま使われます。
        </p>
      </div>
    </details>
  );
}
