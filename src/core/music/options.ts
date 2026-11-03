/**
 * ComposeOptions の正規化（保存・キャッシュキーの正準形）。
 *
 * 曲の保存単位とキャッシュキーは ComposeOptions の JSON なので、「実際に音へ
 * 効かない値は入れない」「既定値は省く」という正準化規則がそのままキーの同一性を
 * 決める。以前はこの規則が UI(bgm-composer の optionsFor) にあり、エンジン内部の
 * 能力ゲート・語法ゲートと二重表現になっていた。ここ(core)へ一元化し、UI は
 * フォームの生値を渡すだけにする。
 *
 * 規則を変えると既存曲とのキー共有が壊れるため、フィールドの出力順・省略条件は
 * 保存互換の契約として扱うこと。
 */

import type { CompositionStrategy } from './composition-strategy.js';
import { deviceAvailable, resolveDevices } from './devices.js';
import { DEFAULT_GROOVE_FEEL } from './groove.js';
import type { GrooveFeel } from './groove.js';
import { DEFAULT_MELODIC_LANGUAGE, idiomFor } from './melodic-idiom.js';
import type { SoundBackendId } from './sound-capabilities.js';
import { STYLES } from './theory.js';
import { CURRENT_ENGINE_REV } from './types.js';
import { formPresetIdOf, introDefaultFor } from './form.js';
import type {
  BassLinePolicy,
  ComposeOptions,
  SectionSpec,
  SongFormRef,
  SongFormSpec,
  DiminutionPolicy,
  DuetPolicy,
  GlidePolicy,
  JapaneseScaleChoice,
  MelodicLanguage,
  NesVoiceOptions,
  OpllUserPatchId,
  PcmVoiceOverride,
  TensionPolicy,
  Tonality,
  TupletOverlayChoice,
  VoiceOverride,
} from './types.js';

/**
 * フォーム(UI)の生値。ComposeOptions と違い、全フィールドが「明示的な現在値」を
 * 持つ('auto' や既定値も含む)。正規化がどれを保存 JSON へ残すかを決める。
 */
export interface ComposeDraft {
  progressionId: string;
  styleId: string;
  keyRoot: number;
  bpm: number;
  /** 曲型(プリセットid か区間列)。 */
  form: SongFormRef;
  seed: number;
  choice: readonly number[];
  soundChip: SoundBackendId;
  intro: boolean;
  tonality: Tonality;
  melodicLanguage: MelodicLanguage;
  japaneseScale: JapaneseScaleChoice;
  grooveFeel: GrooveFeel;
  tupletOverlay: TupletOverlayChoice;
  tensionPolicy: 'auto' | TensionPolicy;
  diminution: 'auto' | DiminutionPolicy;
  duet: 'auto' | DuetPolicy;
  glide: 'auto' | GlidePolicy;
  bassLine: 'auto' | BassLinePolicy;
  /** パート別 OPLL 音色。undefined のパートは「スタイル既定のまま」。 */
  voices: VoiceOverride;
  opllUserPatch: OpllUserPatchId;
  pcmVoices?: PcmVoiceOverride | undefined;
  nes: NesVoiceOptions;
  compositionStrategy?: CompositionStrategy | undefined;
}

/**
 * 曲型の正準形。プリセットidはそのまま。明示の区間列はフィールド順を固定し、
 * undefined と「曲既定と等しい指定」(進行・調・literal 変形)を省いて、同じ曲が同じ JSON になるようにする。
 */
export function canonicalForm(
  form: SongFormRef,
  defaults: { progressionId: string; keyRoot: number; tonality: Tonality },
): SongFormRef {
  const presetId = formPresetIdOf(form);
  if (presetId !== null) return presetId;
  const sections: SectionSpec[] = (form as SongFormSpec).sections.map((section) => ({
    id: section.id,
    role: section.role,
    bars: section.bars,
    energy: section.energy,
    theme: section.theme,
    ...(section.transform !== undefined && section.transform !== 'literal' ? { transform: section.transform } : {}),
    ...(section.quote
      ? {
        quote: {
          from: section.quote.from,
          phrases: [...section.quote.phrases],
          ...(section.quote.transform !== undefined && section.quote.transform !== 'literal'
            ? { transform: section.quote.transform }
            : {}),
        },
      }
      : {}),
    ...(section.progressionId !== undefined && section.progressionId !== defaults.progressionId
      ? { progressionId: section.progressionId }
      : {}),
    ...(section.keyRoot !== undefined && section.keyRoot !== defaults.keyRoot ? { keyRoot: section.keyRoot } : {}),
    ...(section.tonality !== undefined && section.tonality !== defaults.tonality ? { tonality: section.tonality } : {}),
  }));
  return { sections, ending: (form as SongFormSpec).ending };
}

/**
 * フォームの生値から正準の ComposeOptions を組む。
 * - 既定値('auto'・straight グルーヴ・イントロ有効など)は JSON へ入れない
 *   (旧保存曲と同一キーを保つ)
 * - バックエンド能力・旋律語法の下で効かない装置指定も入れない
 *   (エンジン内の能力ゲートと同じ規則。二重に見えるが、こちらは「キーの同一性」、
 *   エンジン側は「入っていても無害化する防衛」で役割が違う)
 */
export function normalizeComposeOptions(draft: ComposeDraft): ComposeOptions {
  const idiom = idiomFor(draft.melodicLanguage);
  // 装置の可用性(語法の抑制・音源の能力・グルーヴとの併用可否)は devices.ts の規則を
  // そのまま使う。効かない装置の明示指定は保存JSONへ入れず、キャッシュ同一性を保つ。
  const style = STYLES.find((s) => s.id === draft.styleId);
  if (!style) throw new Error(`未知のスタイル: ${draft.styleId}`);
  const devices = resolveDevices({
    style,
    melodicLanguage: draft.melodicLanguage,
    grooveFeel: draft.grooveFeel,
    soundChip: draft.soundChip,
  });
  // voices は上書きがあるときだけ入れる（既定のままなら旧保存曲と同一 JSON = キャッシュも共有）
  const picked = Object.fromEntries(
    (Object.entries(draft.voices) as [keyof VoiceOverride, number | undefined][])
      .filter(([, voice]) => voice !== undefined),
  ) as VoiceOverride;
  return {
    progressionId: draft.progressionId,
    styleId: draft.styleId,
    keyRoot: draft.keyRoot,
    bpm: draft.bpm,
    form: canonicalForm(draft.form, { progressionId: draft.progressionId, keyRoot: draft.keyRoot, tonality: draft.tonality }),
    seed: draft.seed,
    choice: [...draft.choice],
    // 生成したエンジンのリビジョンを焼く。旧曲を編集して再保存すると現行へ引き上がるが、
    // 試聴も同じ options なので聴いた音=保存される音。
    engineRev: CURRENT_ENGINE_REV,
    soundChip: draft.soundChip,
    // イントロは曲型の既定と違うときだけ焼く(既定どおりなら省く)。
    ...(draft.intro === introDefaultFor(draft.form) ? {} : { intro: draft.intro }),
    ...(draft.tonality === 'minor' ? { tonality: draft.tonality } : {}),
    // 標準語法は省く(旧保存曲と同一キー)。音組織の選択肢を持つ語法は auto 以外の選択も焼く。
    ...(draft.melodicLanguage !== DEFAULT_MELODIC_LANGUAGE ? { melodicLanguage: draft.melodicLanguage } : {}),
    ...(idiom.hasScaleChoice && draft.japaneseScale !== 'auto' ? { japaneseScale: draft.japaneseScale } : {}),
    ...(draft.grooveFeel === DEFAULT_GROOVE_FEEL ? {} : { grooveFeel: draft.grooveFeel }),
    // autoはスタイル既定に委譲するのでJSONへ入れない(既存保存曲と同一キーを保つ)。
    // 効かない装置(語法の抑制・能力不足・グルーヴ併用不可)の明示指定も入れない。
    ...(draft.tupletOverlay !== 'auto' && deviceAvailable(devices, 'tupletOverlay')
      ? { tupletOverlay: draft.tupletOverlay }
      : {}),
    ...(draft.tensionPolicy !== 'auto' && deviceAvailable(devices, 'tension')
      ? { tensionPolicy: draft.tensionPolicy }
      : {}),
    ...(draft.diminution !== 'auto' && deviceAvailable(devices, 'diminution')
      ? { diminution: draft.diminution }
      : {}),
    ...(draft.duet !== 'auto' && deviceAvailable(devices, 'duet') ? { duet: draft.duet } : {}),
    ...(draft.glide !== 'auto' && deviceAvailable(devices, 'glide') ? { glide: draft.glide } : {}),
    ...(draft.bassLine !== 'auto' && deviceAvailable(devices, 'bassLine') ? { bassLine: draft.bassLine } : {}),
    ...(draft.soundChip === 'opll' && Object.keys(picked).length > 0 ? { voices: picked } : {}),
    ...(draft.soundChip === 'opll' && Object.values(picked).includes(0)
      ? { opllUserPatch: draft.opllUserPatch }
      : {}),
    // PCM音色上書きも曲へ焼く(voicesと同じ理由: ComposeOptionsだけで音が完全再現
    // できる保存単位にする)。上書きが無ければ入れず、既存保存曲とキーを共有する。
    ...(draft.soundChip === 'pcm' && draft.pcmVoices && Object.keys(draft.pcmVoices).length > 0
      ? { pcmVoices: draft.pcmVoices }
      : {}),
    ...(draft.soundChip === 'nes2a03' ? { nes: { ...draft.nes } } : {}),
    ...(draft.compositionStrategy ? { compositionStrategy: draft.compositionStrategy } : {}),
  };
}
