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
import { allowsTupletOverlay, DEFAULT_GROOVE_FEEL } from './groove.js';
import type { GrooveFeel } from './groove.js';
import { capabilitiesFor } from './sound-capabilities.js';
import type { SoundBackendId } from './sound-capabilities.js';
import { CURRENT_ENGINE_REV } from './types.js';
import type {
  ComposeBars,
  ComposeOptions,
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
  bars: ComposeBars;
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
  /** パート別 OPLL 音色。undefined のパートは「スタイル既定のまま」。 */
  voices: VoiceOverride;
  opllUserPatch: OpllUserPatchId;
  pcmVoices?: PcmVoiceOverride | undefined;
  nes: NesVoiceOptions;
  compositionStrategy?: CompositionStrategy | undefined;
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
  const caps = capabilitiesFor(draft.soundChip);
  const japanese = draft.melodicLanguage === 'japanese';
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
    bars: draft.bars,
    seed: draft.seed,
    choice: [...draft.choice],
    // rev0 の間は入れない(欠落=0 なのでキャッシュキー同一性を保つ)。最初の
    // rev ゲート分岐が入って CURRENT が上がった時点から焼き始める。旧曲を編集して
    // 再保存すると現行へ引き上がるが、試聴も同じ options なので聴いた音=保存される音。
    ...(CURRENT_ENGINE_REV > 0 ? { engineRev: CURRENT_ENGINE_REV } : {}),
    soundChip: draft.soundChip,
    ...(draft.intro ? {} : { intro: false }),
    ...(draft.tonality === 'minor' ? { tonality: draft.tonality } : {}),
    ...(japanese ? {
      melodicLanguage: draft.melodicLanguage,
      ...(draft.japaneseScale !== 'auto' ? { japaneseScale: draft.japaneseScale } : {}),
    } : draft.melodicLanguage === 'pentatonic' ? { melodicLanguage: draft.melodicLanguage } : {}),
    ...(draft.grooveFeel === DEFAULT_GROOVE_FEEL ? {} : { grooveFeel: draft.grooveFeel }),
    // 実際に効かない組合せでは保存JSONへ入れず、キャッシュ同一性を保つ(能力参照)
    ...(caps.independentArpeggio && allowsTupletOverlay(draft.grooveFeel) && draft.tupletOverlay !== 'off'
      ? { tupletOverlay: draft.tupletOverlay }
      : {}),
    // autoはスタイル既定に委譲するのでJSONへ入れない(既存保存曲と同一キーを保つ)
    ...(draft.tensionPolicy !== 'auto' && !japanese && caps.colorTones
      ? { tensionPolicy: draft.tensionPolicy }
      : {}),
    ...(draft.diminution !== 'auto' && !japanese ? { diminution: draft.diminution } : {}),
    ...(draft.duet !== 'auto' && !japanese && caps.duetLayer ? { duet: draft.duet } : {}),
    ...(draft.glide !== 'auto' && !japanese && caps.glide ? { glide: draft.glide } : {}),
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
