/**
 * 作曲フォームのモデル層: フォーム値の型・検証付きデシリアライズ・保存キー・
 * 保存曲の一覧サマリ。React状態そのものは作曲ワークスペース(composer/use-composer.ts)が持ち、
 * ここは純関数とデータだけを置く。
 */

import {
  FORM_PRESET_LABELS, formPresetIdOf, introDefaultFor, isFormPresetId, presetForBars, resolveForm, totalBars,
  validateForm,
} from '../core/music/form.js';
import { defaultChoiceFor, slotAtBar, variedChoiceFor } from '../core/music/harmony-plan.js';
import {
  DEFAULT_GROOVE_FEEL, GROOVE_FEEL_LABELS, isGrooveFeel,
} from '../core/music/groove.js';
import type { GrooveFeel } from '../core/music/groove.js';
import { BASS_LINE_POLICY_LABELS, DUET_POLICY_LABELS, GLIDE_POLICY_LABELS, resolveDevices } from '../core/music/devices.js';
import type { ResolvedDevices } from '../core/music/devices.js';
import { DIMINUTION_POLICY_LABELS } from '../core/music/diminution.js';
import { DEFAULT_MELODIC_LANGUAGE, idiomFor, isMelodicLanguage } from '../core/music/melodic-idiom.js';
import { capabilitiesFor } from '../core/music/sound-capabilities.js';
import type { SoundBackendId } from '../core/music/sound-capabilities.js';
import { resolveMelodicLanguage, resolveTonality } from '../core/music/song-plan.js';
import { TENSION_POLICY_LABELS } from '../core/music/tension.js';
import { KEYS, PROGRESSIONS, progressionForTonality, progressionsForTonality, STYLES } from '../core/music/theory.js';
import type { ProgressionDef } from '../core/music/theory.js';
import { normalizeComposeOptions } from '../core/music/options.js';
import type { CompositionStrategy } from '../core/music/composition-strategy.js';
import {
  JAPANESE_SCALE_LABELS,
  TUPLET_OVERLAY_LABELS,
} from '../core/music/types.js';
import type {
  BassLinePolicy,
  ComposeOptions,
  DiminutionPolicy,
  JapaneseScaleChoice,
  MelodicLanguage,
  MelodyEdit,
  NesVoiceOptions,
  OpllUserPatchId,
  PcmVoiceOverride,
  SongFormRef,
  SongFormSpec,
  TensionPolicy,
  Tonality,
  TupletOverlayChoice,
  VoiceOverride,
} from '../core/music/types.js';
import { OPLL_VOICES } from '../audio/opll-core.js';
import { loadStored } from './persist.js';

export const newSeed = (): number => (Math.random() * 0xffff_ffff) >>> 0;

export const newSongId = (): string => `s${Date.now().toString(36)}${newSeed().toString(36)}`;

/** 音色を上書きできる旋律パート（リズム5音は OPLL リズムモード固定） */
export const VOICE_PARTS: readonly { part: keyof VoiceOverride; label: string }[] = [
  { part: 'lead', label: 'リード' },
  { part: 'backing', label: 'バッキング' },
  { part: 'bass', label: 'ベース' },
  { part: 'counter', label: '副旋律' },
  { part: 'ostinato', label: '分散和音' },
];

export const voiceLabel = (id: number): string =>
  id === 0 ? 'ユーザー音色' : OPLL_VOICES.find((v) => v.id === id)?.label.split('（')[0] ?? String(id);

/** 選択肢の唯一の出所はLABELS。型・バリデータ・selectの選択肢がここから同期する。 */
export const TENSION_CHOICES = Object.keys(TENSION_POLICY_LABELS) as ('auto' | TensionPolicy)[];
export const DIMINUTION_CHOICES = Object.keys(DIMINUTION_POLICY_LABELS) as ('auto' | DiminutionPolicy)[];
export const DUET_CHOICES = Object.keys(DUET_POLICY_LABELS) as ('auto' | 'off' | 'on')[];
export const GLIDE_CHOICES = Object.keys(GLIDE_POLICY_LABELS) as ('auto' | 'off' | 'on')[];
export const BASS_LINE_CHOICES = Object.keys(BASS_LINE_POLICY_LABELS) as ('auto' | BassLinePolicy)[];
/**
 * 連符の選択肢(表示順)。ラベル表のキーは文字列で、JS は整数風キーを先頭へ並べ替えるため
 * Object.keys に頼らず明示する。ラベル表との網羅性はテストで固定する。
 */
export const TUPLET_CHOICES: readonly TupletOverlayChoice[] = ['auto', 'off', 'bySection', 5, 6, 7];

/**
 * 保存曲・プリセットの options から実効の装置を解く(表示用)。compose() と同じ規則
 * (devices.ts)なので、「この曲で実際に効いている装置」をそのまま示せる。
 */
export function effectiveDevices(options: ComposeOptions): ResolvedDevices | null {
  const style = STYLES.find((s) => s.id === options.styleId);
  if (!style) return null;
  return resolveDevices({
    style,
    melodicLanguage: resolveMelodicLanguage(options),
    grooveFeel: options.grooveFeel ?? DEFAULT_GROOVE_FEEL,
    soundChip: options.soundChip,
    tensionPolicy: options.tensionPolicy,
    diminution: options.diminution,
    duet: options.duet,
    glide: options.glide,
    bassLine: options.bassLine,
    tupletOverlay: options.tupletOverlay,
  });
}
/** 曲型の表示名。プリセットはラベル表、明示の区間列は小節数と区間数。 */
export function formSummary(form: SongFormRef): string {
  const presetId = formPresetIdOf(form);
  if (presetId) return FORM_PRESET_LABELS[presetId];
  const spec = resolveForm(form);
  return `カスタム${totalBars(spec)}小節(${spec.sections.length}区間${spec.ending === 'loop' ? '' : '・終止'})`;
}

/** 保存曲の一覧表示用サマリ（例: BB風8小節 / 4-5-6 進行 / キーC / BPM170） */
export function songSummary(options: ComposeOptions): string {
  const prog = PROGRESSIONS.find((p) => p.id === options.progressionId)?.name ?? options.progressionId;
  const key = KEYS.find((k) => k.root === options.keyRoot)?.label ?? '?';
  const chip = capabilitiesFor(options.soundChip).label;
  const form = formSummary(options.form);
  const introDefault = introDefaultFor(options.form);
  const intro = options.intro === false && introDefault
    ? ' / イントロなし'
    : options.intro === true && !introDefault ? ' / イントロあり' : '';
  const tonality = resolveTonality(options);
  const melodicLanguage = resolveMelodicLanguage(options);
  const tonalLabel = tonality === 'minor' ? ' / 短調' : '';
  const idiom = idiomFor(melodicLanguage);
  const melody = melodicLanguage === DEFAULT_MELODIC_LANGUAGE
    ? ''
    : ` / ${idiom.label}${idiom.hasScaleChoice ? `(${JAPANESE_SCALE_LABELS[options.japaneseScale ?? 'auto']})` : ''}`;
  const groove = options.grooveFeel && options.grooveFeel !== DEFAULT_GROOVE_FEEL
    ? ` / ${GROOVE_FEEL_LABELS[options.grooveFeel]}`
    : '';
  const tuplet = options.tupletOverlay !== undefined && options.tupletOverlay !== 'auto'
    ? ` / 連符:${TUPLET_OVERLAY_LABELS[String(options.tupletOverlay) as keyof typeof TUPLET_OVERLAY_LABELS]}`
    : '';
  const tension = options.tensionPolicy && options.tensionPolicy !== 'auto'
    ? ` / テンション:${TENSION_POLICY_LABELS[options.tensionPolicy]}`
    : '';
  const diminution = options.diminution && options.diminution !== 'auto'
    ? ` / 細分:${DIMINUTION_POLICY_LABELS[options.diminution]}`
    : '';
  const bassLine = options.bassLine && options.bassLine !== 'auto'
    ? ` / ベースライン:${BASS_LINE_POLICY_LABELS[options.bassLine]}`
    : '';
  const edits = options.melodyEdits?.length ? ` / 局所修正${options.melodyEdits.length}` : '';
  const base = `${chip} / ${form}${intro}${tonalLabel}${melody}${groove}${tuplet}${tension}${diminution}${bassLine}${edits} / ${prog} / キー${key} / BPM${options.bpm}`;
  if (options.soundChip && options.soundChip !== 'opll') return base;
  const overridden = VOICE_PARTS.filter(({ part }) => options.voices?.[part] !== undefined);
  if (overridden.length === 0) return base;
  return `${base} / ${overridden.map(({ part, label }) => `${label}=${voiceLabel(options.voices![part]!)}`).join('・')}`;
}

/** 作曲フォームの永続化（曲リストとは別に、作業中の設定そのものを覚える） */
export const FORM_KEY = 'daredemo.bgmComposer.form.v2';

export interface ComposerForm {
  /** 曲型(プリセットid か区間列)。 */
  form: SongFormRef;
  progId: string;
  styleId: string;
  tonality: Tonality;
  melodicLanguage: MelodicLanguage;
  japaneseScale: JapaneseScaleChoice;
  grooveFeel: GrooveFeel;
  tupletOverlay: TupletOverlayChoice;
  tensionPolicy: 'auto' | TensionPolicy;
  diminution: 'auto' | DiminutionPolicy;
  duet: 'auto' | 'off' | 'on';
  glide: 'auto' | 'off' | 'on';
  bassLine: 'auto' | BassLinePolicy;
  keyRoot: number;
  bpm: number;
  soundChip: SoundBackendId;
  voices: VoiceOverride;
  opllUserPatch: OpllUserPatchId;
  nes: NesVoiceOptions;
  choice: number[];
  autoVary: boolean;
  intro: boolean;
  seed: number;
  loop: boolean;
  /** 区間単位の作り直し(区間 id → 区間ストリームのシード)。新しいシードで作曲すると空へ戻る。 */
  sectionSeeds: Record<string, number>;
  /** 診断の局所修正。新しいシードで作曲すると空へ戻る。 */
  melodyEdits: MelodyEdit[];
}

/** 保存済みフォームをフィールド単位で検証して読む（壊れた項目だけ既定に落ちる） */
export function loadComposerForm(): ComposerForm {
  const raw = loadStored<Record<string, unknown>>(
    FORM_KEY,
    {},
    (v): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v),
  );
  const tonality: Tonality = raw.tonality === 'minor' ? 'minor' : 'major';
  const melodicLanguage: MelodicLanguage = isMelodicLanguage(raw.melodicLanguage)
    ? raw.melodicLanguage
    : DEFAULT_MELODIC_LANGUAGE;
  // 曲型: プリセットid、検証を通る区間列、旧フォームの小節数(bars)の順に読む。
  const candidateForm: SongFormRef = isFormPresetId(raw.form)
    ? raw.form
    : raw.form !== null && typeof raw.form === 'object'
      ? raw.form as SongFormSpec
      : presetForBars(typeof raw.bars === 'number' ? raw.bars : 4);
  const minSectionBars = (ref: SongFormRef): number => Math.min(...resolveForm(ref).sections.map((s) => s.bars));
  const progressionsFor = (ref: SongFormRef) => progressionsForTonality(tonality)
    .filter((p) => p.slots.length <= minSectionBars(ref));
  const pickProgression = (ref: SongFormRef) => {
    const available = progressionsFor(ref);
    return typeof raw.progId === 'string'
      ? available.find((p) => p.id === raw.progId) ?? available[0]!
      : available[0]!;
  };
  let form = candidateForm;
  let initialProgression = pickProgression(form);
  if (validateForm(resolveForm(form), { tonality, progressionId: initialProgression.id })
    .some((issue) => issue.level === 'error')) {
    form = 'loop4';
    initialProgression = pickProgression(form);
  }
  const bars = totalBars(resolveForm(form));
  const progId = initialProgression.id;
  const voices: VoiceOverride = {};
  if (raw.voices !== null && typeof raw.voices === 'object') {
    for (const part of ['lead', 'backing', 'bass', 'counter', 'ostinato'] as const) {
      const v = (raw.voices as Record<string, unknown>)[part];
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 15) voices[part] = v;
    }
  }
  return {
    form,
    progId,
    styleId: typeof raw.styleId === 'string' && STYLES.some((s) => s.id === raw.styleId) ? raw.styleId : 'eurobeat',
    tonality,
    melodicLanguage,
    japaneseScale: ['ritsu', 'minyo', 'miyakobushi'].includes(String(raw.japaneseScale))
      ? raw.japaneseScale as JapaneseScaleChoice
      : 'auto',
    grooveFeel: isGrooveFeel(raw.grooveFeel) ? raw.grooveFeel : DEFAULT_GROOVE_FEEL,
    tupletOverlay: raw.tupletOverlay === 'auto' || raw.tupletOverlay === 'off' || raw.tupletOverlay === 'bySection'
      || [5, 6, 7].includes(raw.tupletOverlay as number)
      ? raw.tupletOverlay as TupletOverlayChoice
      : 'auto',
    tensionPolicy: TENSION_CHOICES.includes(raw.tensionPolicy as 'auto' | TensionPolicy)
      ? raw.tensionPolicy as 'auto' | TensionPolicy
      : 'auto',
    diminution: DIMINUTION_CHOICES.includes(raw.diminution as 'auto' | DiminutionPolicy)
      ? raw.diminution as 'auto' | DiminutionPolicy
      : 'auto',
    duet: raw.duet === 'off' || raw.duet === 'on' ? raw.duet : 'auto',
    glide: raw.glide === 'off' || raw.glide === 'on' ? raw.glide : 'auto',
    bassLine: raw.bassLine === 'off' || raw.bassLine === 'on' ? raw.bassLine : 'auto',
    keyRoot: KEYS.some((k) => k.root === raw.keyRoot) ? (raw.keyRoot as number) : 0,
    bpm: typeof raw.bpm === 'number' && raw.bpm >= 80 && raw.bpm <= 220 ? raw.bpm : 170,
    soundChip: raw.soundChip === 'nes2a03' || raw.soundChip === 'pcm'
      ? raw.soundChip as SoundBackendId
      : 'opll',
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
          // 区間が自分の進行を持つときはその進行のスロット数で検証する。
          && c < (bar < bars ? slotAtBar(initialProgression, form, bar).length : Number.POSITIVE_INFINITY)
        ))
        ? (raw.choice as number[])
        : defaultChoiceFor(initialProgression, form),
    autoVary: raw.autoVary !== false,
    intro: typeof raw.intro === 'boolean' ? raw.intro : introDefaultFor(form),
    seed: typeof raw.seed === 'number' && Number.isInteger(raw.seed) && raw.seed >= 0 ? raw.seed : newSeed(),
    loop: raw.loop !== false,
    sectionSeeds: raw.sectionSeeds !== null && typeof raw.sectionSeeds === 'object' && !Array.isArray(raw.sectionSeeds)
      ? Object.fromEntries(
        Object.entries(raw.sectionSeeds as Record<string, unknown>)
          .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
      )
      : {},
    melodyEdits: Array.isArray(raw.melodyEdits)
      ? (raw.melodyEdits as unknown[]).filter((edit): edit is MelodyEdit => (
        edit !== null && typeof edit === 'object'
        && (['beat', 'fromMidi', 'toMidi'] as const).every((key) => Number.isFinite((edit as Record<string, unknown>)[key]))
      ))
      : [],
  };
}

/** フォームの調性と区間の最短小節数で使える進行(スロット数が区間に収まるもの)。 */
export function progressionChoicesFor(form: Pick<ComposerForm, 'form' | 'tonality'>): ProgressionDef[] {
  const minSectionBars = Math.min(...resolveForm(form.form).sections.map((section) => section.bars));
  return progressionsForTonality(form.tonality).filter((p) => p.slots.length <= minSectionBars);
}

/** フォームが指す進行の実体。使えない id は先頭の候補へ落ちる(表示と作曲が同じ実体を見る)。 */
export function progressionOf(form: Pick<ComposerForm, 'form' | 'tonality' | 'progId'>): ProgressionDef {
  const choices = progressionChoicesFor(form);
  return choices.find((p) => p.id === form.progId) ?? choices[0]!;
}

/**
 * フォームの生値から正準の ComposeOptions を組む(正準化規則は core の normalizeComposeOptions)。
 * overrides は曲型・シード・コード選択だけを差し替えた別案(ブラインド比較など)用。
 */
export function optionsOfForm(
  form: ComposerForm,
  pcmVoices?: PcmVoiceOverride,
  overrides: {
    seed?: number;
    form?: SongFormRef;
    choice?: readonly number[];
    compositionStrategy?: CompositionStrategy;
  } = {},
): ComposeOptions {
  const derived = overrides.form !== undefined || overrides.seed !== undefined;
  return normalizeComposeOptions({
    progressionId: progressionOf(form).id,
    styleId: form.styleId,
    keyRoot: form.keyRoot,
    bpm: form.bpm,
    form: overrides.form ?? form.form,
    seed: overrides.seed ?? form.seed,
    choice: overrides.choice ?? form.choice,
    soundChip: form.soundChip,
    intro: form.intro,
    tonality: form.tonality,
    melodicLanguage: form.melodicLanguage,
    japaneseScale: form.japaneseScale,
    grooveFeel: form.grooveFeel,
    tupletOverlay: form.tupletOverlay,
    tensionPolicy: form.tensionPolicy,
    diminution: form.diminution,
    duet: form.duet,
    glide: form.glide,
    bassLine: form.bassLine,
    voices: form.voices,
    opllUserPatch: form.opllUserPatch,
    pcmVoices,
    nes: form.nes,
    compositionStrategy: overrides.compositionStrategy,
    // 別のシード・曲型の案には、この曲の区間シードと局所修正を持ち込まない。
    sectionSeeds: derived ? undefined : form.sectionSeeds,
    melodyEdits: derived ? undefined : form.melodyEdits,
  });
}

/**
 * 保存曲・プリセットの ComposeOptions を編集フォームへ戻す(省略値を既定で埋める)。
 * コード選択が省略された曲は compose() と同じ規則で確定させ、読み込み直後の音が変わらないようにする。
 * エンジンのリビジョンは次の作曲で現行へ上がる(normalizeComposeOptions が焼く)。
 */
export function formFromOptions(options: ComposeOptions): ComposerForm {
  const tonality = resolveTonality(options);
  const source = PROGRESSIONS.find((p) => p.id === options.progressionId) ?? PROGRESSIONS[0]!;
  const prog = progressionForTonality(source, tonality) ?? progressionsForTonality(tonality)[0]!;
  const bars = totalBars(resolveForm(options.form));
  return {
    form: options.form,
    progId: prog.id,
    styleId: STYLES.some((s) => s.id === options.styleId) ? options.styleId : STYLES[0]!.id,
    tonality,
    melodicLanguage: resolveMelodicLanguage(options),
    japaneseScale: options.japaneseScale ?? 'auto',
    grooveFeel: options.grooveFeel ?? DEFAULT_GROOVE_FEEL,
    tupletOverlay: options.tupletOverlay ?? 'auto',
    tensionPolicy: options.tensionPolicy ?? 'auto',
    diminution: options.diminution ?? 'auto',
    duet: options.duet ?? 'auto',
    glide: options.glide ?? 'auto',
    bassLine: options.bassLine ?? 'auto',
    keyRoot: options.keyRoot,
    bpm: options.bpm,
    soundChip: options.soundChip ?? 'opll',
    voices: { ...(options.voices ?? {}) },
    opllUserPatch: options.opllUserPatch ?? 'brightLead',
    nes: { pulse1Duty: options.nes?.pulse1Duty ?? 1, pulse2Duty: options.nes?.pulse2Duty ?? 2 },
    choice: options.choice
      ? [...options.choice]
      : bars >= 8 ? variedChoiceFor(prog, options.form, options.seed) : defaultChoiceFor(prog, options.form),
    autoVary: false,
    intro: options.intro ?? introDefaultFor(options.form),
    seed: options.seed,
    loop: true,
    sectionSeeds: { ...(options.sectionSeeds ?? {}) },
    melodyEdits: [...(options.melodyEdits ?? [])],
  };
}
