/**
 * 作曲ワークスペースの状態とロジック。
 *
 * 曲は「テイク」(編集フォームのスナップショット)の列で持つ。生成の操作(新しく作る・コード変化・
 * 区間の作り直し)は新しいテイクを積み、設定の変更(様式・キー・音色など)は現在のテイクを
 * その場で書き換える。compose() は決定論かつ同期なので、フォームが変わるたびに Piece を
 * 引き直してタイムラインへ即座に反映する(音声のレンダリングは再生時)。
 *
 * 保存曲・プリセットの試聴は編集フォームへ読み込まず、保存された ComposeOptions のまま
 * 鳴らす(audition)。エンジンのリビジョンを含めて保存時の音を忠実に再現するため。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { compose } from '../../core/music/compose.js';
import { generateForm } from '../../core/music/form-generator.js';
import {
  formPresetIdOf, introDefaultFor, resolveForm, sectionStartBars, totalBars, validateForm,
} from '../../core/music/form.js';
import { DEFAULT_GROOVE_FEEL } from '../../core/music/groove.js';
import { DEVICE_IDS, resolveDevices } from '../../core/music/devices.js';
import { checkPieceStructure, suggestCompositionRepair } from '../../core/music/diagnostics.js';
import type { CompositionRepair } from '../../core/music/diagnostics.js';
import { defaultChoiceFor, hasVariedChoiceFor, variedChoiceFor } from '../../core/music/harmony-plan.js';
import { DEFAULT_MELODIC_LANGUAGE } from '../../core/music/melodic-idiom.js';
import { beatToSeconds, secondsToBeat, tempoMapOf } from '../../core/music/tempo.js';
import { PROGRESSIONS, STYLES, progressionForTonality } from '../../core/music/theory.js';
import type { ComposeOptions, Piece, SectionSpec, SongFormRef, SongFormSpec, Tonality } from '../../core/music/types.js';
import { exportMp3 } from '../../audio/mp3-export.js';
import { OPLL_RATE } from '../../audio/opll-core.js';
import { bgmCacheKey, isPcmBgm, renderComposedBgm } from '../../audio/render.js';
import type { BgmMix, BgmPcmRenderer, ComposedBgmDef } from '../../audio/render.js';
import type { PcmVoiceOverride } from '../../audio/pcm-arrange.js';
import type { StageRole } from '../../audio/stage.js';
import {
  DEFAULT_ASSIGN, loadAssign, loadBgmVolume, loadSongs, PRESET_SONGS, saveAssign, saveBgmVolume, saveSongs,
} from '../bgm-library.js';
import type { BgmAssign, SavedSong } from '../bgm-library.js';
import {
  FORM_KEY, formFromOptions, loadComposerForm, newSeed, newSongId, optionsOfForm, progressionChoicesFor,
  progressionOf, songSummary,
} from '../composer-form.js';
import type { ComposerForm } from '../composer-form.js';
import { saveStored } from '../persist.js';
import type { SfxPlayer } from '../sfx-player.js';
import { BAR_BEATS, effectiveMuted, sectionBlocks, themeOriginId } from './piece-view.js';

/** テイクの上限。古いものから捨てる(現在のテイクは捨てない)。 */
const MAX_TAKES = 24;

export type TakeOrigin = 'initial' | 'new' | 'chords' | 'section' | 'style' | 'loaded';

export interface Take {
  id: string;
  form: ComposerForm;
  origin: TakeOrigin;
  /** 一覧に出す短い由来(「区間 B を作り直し」など)。 */
  note: string;
  createdAt: number;
}

export interface Audition {
  name: string;
  options: ComposeOptions;
}

const takeId = (): string => `t${Date.now().toString(36)}${newSeed().toString(36)}`;

const SOUND_OFF_MESSAGE = '「音」が OFF のため音は鳴りません（画面上部で ON にできます）';

/** 曲型生成の目標小節数の範囲(4 小節刻み)。 */
export const GENERATE_BARS = { min: 4, max: 160, fallback: 96 } as const;
export const clampGenerateBars = (value: number): number => (
  Number.isFinite(value)
    ? Math.max(GENERATE_BARS.min, Math.min(GENERATE_BARS.max, Math.round(value)))
    : GENERATE_BARS.fallback
);

export function useComposer({ player, pcmRenderer, pcmVoices, onPcmNeededChange }: {
  player: SfxPlayer;
  /** 曲の音源設定が pcm のときだけ使う外部レンダラ(SoundFont)。null ならチップ編曲へ劣化する。 */
  pcmRenderer: BgmPcmRenderer | null;
  /** スタジオの PCM 音色設定。曲へ焼き込む。 */
  pcmVoices: PcmVoiceOverride | undefined;
  onPcmNeededChange?: ((needed: boolean) => void) | undefined;
}) {
  const [takes, setTakes] = useState<Take[]>(() => [{
    id: takeId(), form: loadComposerForm(), origin: 'initial', note: '前回の続き', createdAt: Date.now(),
  }]);
  const [currentId, setCurrentId] = useState(() => takes[0]!.id);
  const current = takes.find((take) => take.id === currentId) ?? takes[0]!;
  const form = current.form;

  const [audition, setAudition] = useState<Audition | null>(null);
  const [selectedSection, setSelectedSection] = useState<string | null>(null);
  const [muted, setMuted] = useState<StageRole[]>([]);
  const [solo, setSolo] = useState<StageRole | null>(null);
  const [sectionLoop, setSectionLoop] = useState(false);
  const [cursorBeat, setCursorBeat] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** いま鳴っている波形のキー。現在の表示と違えば「変更が未反映」。 */
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [exporting, setExporting] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [volume, setVolume] = useState(loadBgmVolume);
  const [songs, setSongs] = useState<SavedSong[]>(loadSongs);
  const [assign, setAssign] = useState<BgmAssign>(loadAssign);
  const [exportLoops, setExportLoops] = useState(2);
  const [exportFade, setExportFade] = useState(true);

  // ---- 導出値(フォーム → 曲型・進行・様式・装置) ----
  const formSpec = useMemo(() => resolveForm(form.form), [form.form]);
  const formPresetId = formPresetIdOf(form.form);
  const formBars = totalBars(formSpec);
  const formStarts = useMemo(() => sectionStartBars(formSpec), [formSpec]);
  const progs = useMemo(() => progressionChoicesFor(form), [form.form, form.tonality]); // eslint-disable-line react-hooks/exhaustive-deps
  const prog = progressionOf(form);
  const styleDef = STYLES.find((s) => s.id === form.styleId) ?? STYLES[0]!;
  const styleGroove = styleDef.defaults.groove ?? DEFAULT_GROOVE_FEEL;
  const styleMelodicLanguage = styleDef.defaults.melodicLanguage ?? DEFAULT_MELODIC_LANGUAGE;
  const devices = useMemo(() => resolveDevices({
    style: styleDef,
    melodicLanguage: form.melodicLanguage,
    grooveFeel: form.grooveFeel,
    soundChip: form.soundChip,
    tensionPolicy: form.tensionPolicy,
    diminution: form.diminution,
    duet: form.duet,
    glide: form.glide,
    bassLine: form.bassLine,
    tupletOverlay: form.tupletOverlay,
  }), [
    styleDef, form.melodicLanguage, form.grooveFeel, form.soundChip, form.tensionPolicy, form.diminution,
    form.duet, form.glide, form.bassLine, form.tupletOverlay,
  ]);
  const overrideCount = DEVICE_IDS.filter((id) => devices[id].source === 'explicit').length
    + Number(form.melodicLanguage !== styleMelodicLanguage)
    + Number(form.grooveFeel !== styleGroove);
  const formIssues = useMemo(
    () => validateForm(formSpec, { tonality: form.tonality, progressionId: prog.id }),
    [formSpec, form.tonality, prog.id],
  );
  const canVaryChords = useMemo(
    () => hasVariedChoiceFor(prog, form.form, form.choice),
    [prog, form.form, form.choice],
  );

  // ---- 表示中の曲(試聴中の保存曲、無ければ編集中のフォーム) ----
  const draftOptions = useMemo(() => {
    try {
      return optionsOfForm(form, pcmVoices);
    } catch {
      return null;
    }
  }, [form, pcmVoices]);
  const viewOptions = audition?.options ?? draftOptions;
  const composed = useMemo((): { piece: Piece | null; error: string } => {
    if (!viewOptions) return { piece: null, error: '設定から曲を組めません' };
    try {
      return { piece: compose(viewOptions), error: '' };
    } catch (e) {
      return { piece: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [viewOptions]);
  const piece = composed.piece;
  const blocks = useMemo(() => (piece ? sectionBlocks(piece) : []), [piece]);
  const mix = useMemo<BgmMix | undefined>(() => {
    const list = effectiveMuted(muted, solo);
    return list.length > 0 ? { muted: list } : undefined;
  }, [muted, solo]);
  const viewKey = viewOptions ? bgmCacheKey(viewOptions, pcmRenderer, mix) : null;
  const stale = playing && playingKey !== null && playingKey !== viewKey;

  const diagnosis = useMemo(() => (piece ? checkPieceStructure(piece) : null), [piece]);
  const diagnosisItems = useMemo(
    () => (piece && diagnosis
      ? diagnosis.issues
        .map((issue, originalIndex) => ({ issue, originalIndex, repair: suggestCompositionRepair(piece, issue) }))
        .sort((a, b) => Number(b.repair !== null) - Number(a.repair !== null) || a.originalIndex - b.originalIndex)
        .slice(0, 8)
      : []),
    [diagnosis, piece],
  );

  // ---- 副作用: 音量・PCM 通知・フォームの保存 ----
  useEffect(() => {
    player.setBgmVolume(volume / 100);
    saveBgmVolume(volume);
  }, [player, volume]);

  const viewChip = viewOptions?.soundChip ?? 'opll';
  useEffect(() => {
    onPcmNeededChange?.(viewChip === 'pcm');
  }, [viewChip, onPcmNeededChange]);

  useEffect(() => {
    saveStored(FORM_KEY, form);
  }, [form]);

  // ---- テイクの操作 ----
  const patch = useCallback((changes: Partial<ComposerForm>) => {
    setTakes((list) => list.map((take) => (take.id === currentId ? { ...take, form: { ...take.form, ...changes } } : take)));
  }, [currentId]);

  const pushTake = (nextForm: ComposerForm, origin: TakeOrigin, note: string): void => {
    const take: Take = { id: takeId(), form: nextForm, origin, note, createdAt: Date.now() };
    setTakes((list) => [take, ...list].slice(0, MAX_TAKES));
    setCurrentId(take.id);
    setAudition(null);
  };

  // ---- 再生 ----
  /** 再生中の曲のテンポ写像と長さ。再生ヘッドが秒→拍へ写すために持つ。 */
  const clockRef = useRef<{ piece: Piece } | null>(null);

  const stop = useCallback(() => {
    player.stopBgm();
    clockRef.current = null;
    setPlaying(false);
    setPlayingKey(null);
  }, [player]);

  const renderDef = async (
    p: Piece, opts: ComposeOptions, key: string, audition_mix: BgmMix | undefined,
  ): Promise<ComposedBgmDef> => (
    // レンダリング済みの PCM(SoundFont・2A03)はキャッシュから取り、合成を丸ごと省く。
    player.getCachedPcmBgm(key) ?? await renderComposedBgm(p, opts, pcmRenderer, undefined, audition_mix)
  );

  /**
   * 曲を fromBeat から鳴らす。range を渡すとその拍区間をループする(区間ループ)。
   * 波形はまずループ指定なしの def でキャッシュへ入れ、区間ループの指定は再生の瞬間だけ重ねる
   * (キャッシュには曲本来のループ区間が残る)。
   */
  const playPiece = async (
    p: Piece,
    opts: ComposeOptions,
    fromBeat: number,
    settings: { loop: boolean; range: { startBeat: number; endBeat: number } | null; mix: BgmMix | undefined },
  ): Promise<void> => {
    try {
      setError(player.enabled ? '' : SOUND_OFF_MESSAGE);
      if (!player.enabled) return;
      if (opts.soundChip === 'pcm') onPcmNeededChange?.(true);
      const key = bgmCacheKey(opts, pcmRenderer, settings.mix);
      setProgress(0);
      const def = await renderDef(p, opts, key, settings.mix);
      await player.ensureComposedBgm(key, def, setProgress);
      const tempo = tempoMapOf(p);
      const range = settings.range;
      const startBeat = range
        ? Math.min(Math.max(fromBeat, range.startBeat), Math.max(range.startBeat, range.endBeat - 0.01))
        : Math.min(Math.max(0, fromBeat), Math.max(0, p.beats - 0.01));
      const playDef: ComposedBgmDef = range
        ? { ...def, loopStart: beatToSeconds(tempo, range.startBeat), loopEnd: beatToSeconds(tempo, range.endBeat) }
        : def;
      const result = await player.playComposedBgm(key, playDef, 0, {
        // 終止で閉じる曲は巻き戻さない(ループ指定があっても終止のあと止まる)。区間ループは常に回す。
        loop: range ? true : settings.loop && p.ending === 'loop',
        startAtSec: beatToSeconds(tempo, startBeat),
      });
      setProgress(null);
      if (result === 'played') {
        clockRef.current = { piece: p };
        setPlaying(true);
        setPlayingKey(key);
      } else if (result === 'failed') {
        setPlaying(false);
        setPlayingKey(null);
      }
    } catch (e) {
      setProgress(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const selectedBlock = blocks.find((block) => block.id === selectedSection && !block.isIntro) ?? null;
  const loopRangeFor = (enabled: boolean): { startBeat: number; endBeat: number } | null => (
    enabled && selectedBlock ? { startBeat: selectedBlock.startBeat, endBeat: selectedBlock.endBeat } : null
  );

  /** 表示中の曲を鳴らす(現在の設定を反映して鳴らし直す)。 */
  const play = (fromBeat: number = cursorBeat): void => {
    if (!piece || !viewOptions) return;
    void playPiece(piece, viewOptions, fromBeat, { loop: form.loop, range: loopRangeFor(sectionLoop), mix });
  };

  /** 再生中の曲内位置(拍)。鳴っていなければ null。 */
  const positionBeat = useCallback((): number | null => {
    const clock = clockRef.current;
    const seconds = player.bgmPositionSec();
    if (!clock || seconds === null) return null;
    return secondsToBeat(tempoMapOf(clock.piece), seconds);
  }, [player]);

  // ループしない再生が終端まで行ったら、停止状態へ戻す。
  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => {
      if (player.bgmPositionSec() === null) {
        clockRef.current = null;
        setPlaying(false);
        setPlayingKey(null);
      }
    }, 250);
    return () => clearInterval(timer);
  }, [player, playing]);

  const togglePlay = (): void => {
    if (playing && !stale) stop();
    else play(stale ? positionBeat() ?? cursorBeat : cursorBeat);
  };

  /** タイムライン上の位置へ移る。再生中はその位置から鳴らし直す。 */
  const seek = (beat: number): void => {
    setCursorBeat(beat);
    if (playing) play(beat);
  };

  // ミュート/ソロ・区間ループの切替は、再生中ならいまの位置から鳴らし直して即座に反映する。
  const mixKey = mix ? mix.muted.join(',') : '';
  const loopKey = sectionLoop && selectedBlock ? selectedBlock.id : '';
  const liveRef = useRef({ mixKey, loopKey });
  useEffect(() => {
    const previous = liveRef.current;
    liveRef.current = { mixKey, loopKey };
    if (previous.mixKey === mixKey && previous.loopKey === loopKey) return;
    if (playing) play(positionBeat() ?? cursorBeat);
    // 再生の関数は毎レンダリングで作り直すので依存へ入れない(切替の瞬間だけ反応する)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mixKey, loopKey]);

  // ---- 生成の操作(新しいテイクを積んで鳴らす) ----
  const playForm = (nextForm: ComposerForm, fromBeat = 0): void => {
    try {
      const opts = optionsOfForm(nextForm, pcmVoices);
      const p = compose(opts);
      setCursorBeat(fromBeat);
      void playPiece(p, opts, fromBeat, { loop: nextForm.loop, range: null, mix });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 新しいシードで曲全体を作り直す。区間の作り直しと局所修正は持ち越さない。 */
  const composeNew = (): void => {
    const seed = newSeed();
    const choice = form.autoVary ? variedChoiceFor(prog, form.form, seed) : [...form.choice];
    const next: ComposerForm = { ...form, seed, choice, sectionSeeds: {}, melodyEdits: [] };
    setSectionLoop(false);
    pushTake(next, 'new', '新しく作った');
    playForm(next);
  };

  /** 現在とは違うコード変化レシピを引き、メロディも作り直す。 */
  const varyChords = (): void => {
    const seed = newSeed();
    const choice = variedChoiceFor(prog, form.form, seed, { chancePercent: 100, currentChoice: form.choice });
    const next: ComposerForm = { ...form, seed, choice, sectionSeeds: {}, melodyEdits: [] };
    setSectionLoop(false);
    pushTake(next, 'chords', 'コード変化');
    playForm(next);
  };

  /**
   * 区間の旋律だけを作り直す。引き直すのは主題の初出区間で、同じ主題の再登場区間も一緒に変わる
   * (フックの一致を保つ)。他の主題の区間と、ベース・ドラムなどの声部は曲のシードのまま。
   */
  const regenerateSection = (sectionId: string): void => {
    const origin = themeOriginId(formSpec, sectionId);
    const next: ComposerForm = {
      ...form,
      sectionSeeds: { ...form.sectionSeeds, [origin]: newSeed() },
      // 局所修正は「拍と元の音高」で当てるので、旋律が変わった区間には当たらなくなる(無害)。
    };
    pushTake(next, 'section', `区間 ${origin} を作り直し`);
    const index = formSpec.sections.findIndex((section) => section.id === sectionId);
    const introBeats = piece ? piece.loopStartBeat : 0;
    playForm(next, index >= 0 ? introBeats + formStarts[index]! * BAR_BEATS : 0);
  };

  /** 様式を選んで、その既定(テンポ・グルーヴ・語法・進行)で新しい曲を始める。 */
  const startFromStyle = (styleId: string): void => {
    const style = STYLES.find((s) => s.id === styleId);
    if (!style) return;
    const base = withStyleDefaults({ ...form, styleId }, style.id);
    const seed = newSeed();
    const nextProg = progressionOf(base);
    const next: ComposerForm = {
      ...base,
      seed,
      choice: variedChoiceFor(nextProg, base.form, seed),
      autoVary: true,
      sectionSeeds: {},
      melodyEdits: [],
    };
    setSectionLoop(false);
    pushTake(next, 'style', `${style.name} で開始`);
    playForm(next);
  };

  const selectTake = (id: string): void => {
    const take = takes.find((candidate) => candidate.id === id);
    if (!take) return;
    setAudition(null);
    setCurrentId(id);
    if (playing) playForm(take.form, 0);
  };

  // ---- 設定の操作(現在のテイクを書き換える) ----
  /** 進行を替えたらコード選択を定番形へ戻し、作曲時の自動変化を有効に戻す。 */
  const choiceResetFor = (progId: string, nextForm: SongFormRef, tonality: Tonality): Partial<ComposerForm> => {
    const source = PROGRESSIONS.find((candidate) => candidate.id === progId)!;
    const realized = progressionForTonality(source, tonality)!;
    return { choice: defaultChoiceFor(realized, nextForm), autoVary: true };
  };

  function withStyleDefaults(base: ComposerForm, styleId: string): ComposerForm {
    const style = STYLES.find((s) => s.id === styleId);
    if (!style) return base;
    const next: ComposerForm = {
      ...base,
      styleId,
      bpm: style.defaults.bpm,
      grooveFeel: style.defaults.groove ?? DEFAULT_GROOVE_FEEL,
      melodicLanguage: style.defaults.melodicLanguage ?? DEFAULT_MELODIC_LANGUAGE,
    };
    const available = progressionChoicesFor(next);
    const preferred = style.defaults.progressionIds?.find((id) => available.some((p) => p.id === id));
    if (preferred === undefined || preferred === progressionOf(next).id) return next;
    return { ...next, progId: preferred, ...choiceResetFor(preferred, next.form, next.tonality) };
  }

  /** 様式の切替は既定(テンポ・グルーヴ・語法・推奨進行)へ追従する。その後の手動変更は自由。 */
  const setStyle = (styleId: string): void => {
    patch(withStyleDefaults(form, styleId));
  };

  const setProgression = (progId: string): void => {
    patch({ progId, ...choiceResetFor(progId, form.form, form.tonality) });
  };

  const setTonality = (tonality: Tonality): void => {
    const available = progressionChoicesFor({ form: form.form, tonality });
    const next = available.find((p) => p.id === prog.id) ?? available[0]!;
    patch({ tonality, progId: next.id, ...choiceResetFor(next.id, form.form, tonality) });
  };

  const setForm = (nextForm: SongFormRef, options: { resetIntro: boolean } = { resetIntro: true }): void => {
    const available = progressionChoicesFor({ form: nextForm, tonality: form.tonality });
    const nextProgId = available.some((p) => p.id === prog.id) ? prog.id : available[0]!.id;
    patch({
      form: nextForm,
      progId: nextProgId,
      ...(options.resetIntro ? { intro: introDefaultFor(nextForm) } : {}),
      ...choiceResetFor(nextProgId, nextForm, form.tonality),
    });
    // 消えた区間を選んだままにしない。
    if (selectedSection && !resolveForm(nextForm).sections.some((section) => section.id === selectedSection)) {
      setSelectedSection(null);
      setSectionLoop(false);
    }
  };

  /** 様式・新しいシード・目標小節数から曲型(区間列)を生成する。 */
  const generateNewForm = (targetBars: number): void => {
    setForm(generateForm({
      style: styleDef,
      seed: newSeed(),
      targetBars: clampGenerateBars(targetBars),
      defaults: { tonality: form.tonality, progressionId: prog.id, keyRoot: form.keyRoot },
    }));
  };

  /** 区間の宣言を書き換える。プリセットの曲型は、この時点で明示の区間列へ展開する。 */
  const updateSection = (index: number, changes: { [K in keyof SectionSpec]?: SectionSpec[K] | undefined }): void => {
    const sections = formSpec.sections.map((section, i) => {
      if (i !== index) return { ...section };
      const next = { ...section } as Record<string, unknown>;
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      return next as unknown as SectionSpec;
    });
    setForm({ ...formSpec, sections } satisfies SongFormSpec, { resetIntro: false });
  };

  const setChordChoice = (bar: number, index: number): void => {
    const choice = [...form.choice];
    choice[bar] = index;
    patch({ choice, autoVary: false });
  };

  /** 2層(語法・グルーヴ・装置)の上書きをすべて解き、様式の既定へ戻す。 */
  const resetOverrides = (): void => {
    patch({
      melodicLanguage: styleMelodicLanguage,
      japaneseScale: 'auto',
      grooveFeel: styleGroove,
      tupletOverlay: 'auto',
      tensionPolicy: 'auto',
      diminution: 'auto',
      duet: 'auto',
      glide: 'auto',
      bassLine: 'auto',
    });
  };

  // ---- 診断の局所修正 ----
  const applyRepair = (repair: CompositionRepair): void => {
    const next: ComposerForm = { ...form, melodyEdits: [...form.melodyEdits, repair.edit] };
    patch({ melodyEdits: next.melodyEdits });
    if (playing) playForm(next, positionBeat() ?? 0);
  };

  const undoRepair = (): void => {
    if (form.melodyEdits.length === 0) return;
    const next: ComposerForm = { ...form, melodyEdits: form.melodyEdits.slice(0, -1) };
    patch({ melodyEdits: next.melodyEdits });
    if (playing) playForm(next, positionBeat() ?? 0);
  };

  // ---- ミュート / ソロ ----
  const toggleMute = (role: StageRole): void => {
    setMuted((list) => (list.includes(role) ? list.filter((item) => item !== role) : [...list, role]));
  };
  const toggleSolo = (role: StageRole): void => {
    setSolo((currentSolo) => (currentSolo === role ? null : role));
  };

  // ---- 保存曲・プリセット ----
  /** 保存曲・プリセットを、保存された設定のまま鳴らして表示する(編集フォームは触らない)。 */
  const auditionSong = (song: SavedSong): void => {
    try {
      const p = compose(song.options);
      setAudition({ name: song.name, options: song.options });
      setSelectedSection(null);
      setSectionLoop(false);
      setCursorBeat(0);
      void playPiece(p, song.options, 0, { loop: form.loop, range: null, mix });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const exitAudition = (): void => {
    if (playing) stop();
    setAudition(null);
  };

  /** 保存曲・プリセットを編集フォームへ読み込む(新しいテイクとして積む)。 */
  const loadIntoEditor = (song: SavedSong): void => {
    if (playing) stop();
    setSelectedSection(null);
    setSectionLoop(false);
    pushTake({ ...formFromOptions(song.options), loop: form.loop }, 'loaded', `${song.name} を読み込み`);
  };

  const saveSong = (name: string): void => {
    if (!viewOptions) return;
    const next = [...songs, { id: newSongId(), name: name.trim() || songSummary(viewOptions), options: viewOptions }];
    setSongs(next);
    saveSongs(next);
  };

  const deleteSong = (id: string): void => {
    const next = songs.filter((song) => song.id !== id);
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

  const updateAssign = (slot: 'bb' | 'rb', value: string): void => {
    const next = { ...assign, [slot]: value };
    setAssign(next);
    saveAssign(next);
    // 割り当てた曲は先にレンダリングしておく（ボーナス開始時に待たせない）
    const song = value.startsWith('song:')
      ? songs.find((s) => `song:${s.id}` === value)
      : PRESET_SONGS.find((p) => `preset:${p.id}` === value);
    if (!song) return;
    void (async () => {
      try {
        // ボーナス割当の先行レンダリングは常にチップ音源(ゲーム側の再生経路と一致させる)。
        await player.ensureComposedBgm(
          bgmCacheKey(song.options),
          await renderComposedBgm(compose(song.options), song.options),
        );
      } catch {
        // 壊れた保存データはボーナス開始時にプリセットへフォールバックされる
      }
    })();
  };

  // ---- 書き出し ----
  const download = (blob: Blob, name: string): void => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  /** 表示中の曲を「イントロ+ループ本体×N周(+フェード)」へ展開して MP3 保存する。ミュートは反映しない。 */
  const exportMp3File = async (): Promise<void> => {
    if (!piece || !viewOptions || exporting !== null) return;
    try {
      setError('');
      setExporting(0);
      const key = bgmCacheKey(viewOptions, pcmRenderer);
      const def = await renderDef(piece, viewOptions, key, undefined);
      // レンダリングを進捗の前半4割、エンコードを後半6割に配分する。
      const wave = await player.ensureComposedBgm(key, def, (ratio) => setExporting(ratio * 0.4));
      const blob = await exportMp3(
        {
          wave,
          ...(isPcmBgm(def) && def.waveRight && def.waveRight.length === wave.length ? { waveRight: def.waveRight } : {}),
          sampleRate: isPcmBgm(def) ? def.sampleRate : OPLL_RATE,
          loopStartSec: def.loopStart,
          loopEndSec: def.loopEnd,
        },
        // 終止で閉じる曲はループ本体を展開せず 1 周で書き出す(フェードも不要)。
        piece.ending === 'loop' ? { loopCount: exportLoops, fade: exportFade } : { loopCount: 1, fade: false },
        (ratio) => setExporting(0.4 + ratio * 0.6),
      );
      download(blob, `bgm-${viewOptions.styleId}-seed${viewOptions.seed}-x${exportLoops}.mp3`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(null);
    }
  };

  /** 表示中の曲を GM 準拠の SMF(format 1)で保存する。 */
  const exportMidiFile = async (): Promise<void> => {
    if (!piece || !viewOptions) return;
    try {
      setError('');
      const { pieceToSmf } = await import('../../audio/midi-export.js');
      // 音色上書きは PCM の試聴にだけ効く設定なので、pcm 曲のときだけ反映する。
      const data = pieceToSmf(piece, viewOptions.soundChip === 'pcm' ? viewOptions.pcmVoices ?? pcmVoices ?? {} : {});
      download(
        new Blob([data.buffer as ArrayBuffer], { type: 'audio/midi' }),
        `bgm-${viewOptions.styleId}-seed${viewOptions.seed}.mid`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return {
    // 曲と表示
    form, patch, piece, blocks, viewOptions, composeError: composed.error, audition, readOnly: audition !== null,
    formSpec, formPresetId, formBars, formStarts, formIssues, progs, prog, styleDef, styleGroove, styleMelodicLanguage,
    devices, overrideCount, canVaryChords, diagnosis, diagnosisItems,
    // テイク
    takes, currentId, selectTake,
    // 生成
    composeNew, varyChords, regenerateSection, startFromStyle,
    // 設定
    setStyle, setProgression, setTonality, setForm, generateNewForm, updateSection, setChordChoice, resetOverrides,
    applyRepair, undoRepair,
    // 再生
    playing, stale, progress, play, stop, togglePlay, seek, positionBeat, cursorBeat,
    selectedSection, setSelectedSection, selectedBlock, sectionLoop, setSectionLoop,
    muted, solo, toggleMute, toggleSolo, volume, setVolume,
    // ライブラリ
    songs, assign, auditionSong, exitAudition, loadIntoEditor, saveSong, deleteSong, updateAssign,
    // 書き出し
    exporting, exportLoops, setExportLoops, exportFade, setExportFade, exportMp3File, exportMidiFile,
    // 状態表示
    error, setError, setProgress,
    // ラボ(ブラインド比較)が同じ再生経路を使うための縫い目
    player, pcmRenderer, pcmVoices,
  };
}

export type Composer = ReturnType<typeof useComposer>;
