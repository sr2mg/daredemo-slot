/**
 * 作曲フォームのモデル層: フォーム値の型・検証付きデシリアライズ・保存キー・
 * 保存曲の一覧サマリ。React状態そのものは BgmComposerPanel が持ち、
 * ここは純関数とデータだけを置く。
 */

import { defaultChoiceFor } from '../core/music/harmony-plan.js';
import {
  DEFAULT_GROOVE_FEEL, GROOVE_FEEL_LABELS, isGrooveFeel,
} from '../core/music/groove.js';
import type { GrooveFeel } from '../core/music/groove.js';
import { DIMINUTION_POLICY_LABELS } from '../core/music/diminution.js';
import { capabilitiesFor } from '../core/music/sound-capabilities.js';
import type { SoundBackendId } from '../core/music/sound-capabilities.js';
import { resolveMelodicLanguage, resolveTonality } from '../core/music/song-plan.js';
import { TENSION_POLICY_LABELS } from '../core/music/tension.js';
import { KEYS, PROGRESSIONS, progressionsForTonality, STYLES } from '../core/music/theory.js';
import {
  JAPANESE_SCALE_LABELS,
  TUPLET_OVERLAY_LABELS,
} from '../core/music/types.js';
import type {
  ComposeBars,
  ComposeOptions,
  DiminutionPolicy,
  JapaneseScaleChoice,
  MelodicLanguage,
  NesVoiceOptions,
  OpllUserPatchId,
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
/** 保存曲の一覧表示用サマリ（例: BB風8小節 / 田中・真部進行 / キーC / BPM170） */
export function songSummary(options: ComposeOptions): string {
  const prog = PROGRESSIONS.find((p) => p.id === options.progressionId)?.name ?? options.progressionId;
  const key = KEYS.find((k) => k.root === options.keyRoot)?.label ?? '?';
  const chip = capabilitiesFor(options.soundChip).label;
  const form = options.bars === 40
    ? 'OPLL BIG風40小節'
    : options.bars === 16 ? 'ゲームBGM風16小節' : options.bars === 8 ? 'BB風8小節' : 'RB風4小節';
  const intro = (options.bars === 16 || options.bars === 40) && options.intro === false ? ' / イントロなし' : '';
  const tonality = resolveTonality(options);
  const melodicLanguage = resolveMelodicLanguage(options);
  const tonalLabel = tonality === 'minor' ? ' / 短調' : '';
  const melody = melodicLanguage === 'japanese'
    ? ` / 和風五音(${JAPANESE_SCALE_LABELS[options.japaneseScale ?? 'auto']})`
    : melodicLanguage === 'pentatonic' ? ' / 五音ペンタ' : '';
  const groove = options.grooveFeel && options.grooveFeel !== DEFAULT_GROOVE_FEEL
    ? ` / ${GROOVE_FEEL_LABELS[options.grooveFeel]}`
    : '';
  const tuplet = options.tupletOverlay && options.tupletOverlay !== 'off'
    ? ` / 連符${TUPLET_OVERLAY_LABELS[String(options.tupletOverlay) as keyof typeof TUPLET_OVERLAY_LABELS]}`
    : '';
  const tension = options.tensionPolicy && options.tensionPolicy !== 'auto'
    ? ` / テンション:${TENSION_POLICY_LABELS[options.tensionPolicy]}`
    : '';
  const diminution = options.diminution && options.diminution !== 'auto'
    ? ` / 細分:${DIMINUTION_POLICY_LABELS[options.diminution]}`
    : '';
  const edits = options.melodyEdits?.length ? ` / 局所修正${options.melodyEdits.length}` : '';
  const base = `${chip} / ${form}${intro}${tonalLabel}${melody}${groove}${tuplet}${tension}${diminution}${edits} / ${prog} / キー${key} / BPM${options.bpm}`;
  if (options.soundChip && options.soundChip !== 'opll') return base;
  const overridden = VOICE_PARTS.filter(({ part }) => options.voices?.[part] !== undefined);
  if (overridden.length === 0) return base;
  return `${base} / ${overridden.map(({ part, label }) => `${label}=${voiceLabel(options.voices![part]!)}`).join('・')}`;
}

/** 作曲フォームの永続化（曲リストとは別に、作業中の設定そのものを覚える） */
export const FORM_KEY = 'daredemo.bgmComposer.form.v1';

export interface ComposerForm {
  bars: ComposeBars;
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
}

/** 保存済みフォームをフィールド単位で検証して読む（壊れた項目だけ既定に落ちる） */
export function loadComposerForm(): ComposerForm {
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
    : raw.melodicLanguage === 'pentatonic'
      ? 'pentatonic'
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
    grooveFeel: isGrooveFeel(raw.grooveFeel) ? raw.grooveFeel : DEFAULT_GROOVE_FEEL,
    tupletOverlay: raw.tupletOverlay === 'auto' || [5, 6, 7].includes(raw.tupletOverlay as number)
      ? raw.tupletOverlay as TupletOverlayChoice
      : 'off',
    tensionPolicy: TENSION_CHOICES.includes(raw.tensionPolicy as 'auto' | TensionPolicy)
      ? raw.tensionPolicy as 'auto' | TensionPolicy
      : 'auto',
    diminution: DIMINUTION_CHOICES.includes(raw.diminution as 'auto' | DiminutionPolicy)
      ? raw.diminution as 'auto' | DiminutionPolicy
      : 'auto',
    duet: raw.duet === 'off' || raw.duet === 'on' ? raw.duet : 'auto',
    glide: raw.glide === 'off' || raw.glide === 'on' ? raw.glide : 'auto',
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
