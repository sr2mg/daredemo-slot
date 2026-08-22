/**
 * 作曲エンジンのデータモデル（単一の型定義置き場）。
 *
 * ここには「曲とは何か」を表す型・語彙・表示ラベルだけを置き、生成ロジックは持たない。
 * 依存は葉モジュール（composition-strategy / groove / sound-capabilities）への type import
 * のみに限定する。各生成器（compose / song-plan / arrangement / 各装置）はここへ一方向に
 * 依存する。逆向き（types → 生成器）の import を足すと型循環が再発するので禁止。
 */

import type {
  CompositionPolicy,
  CompositionPremise,
  CompositionStrategy,
} from './composition-strategy.js';
import type { GrooveFeel } from './groove.js';
import type { SoundBackendId } from './sound-capabilities.js';

// ---------------------------------------------------------------------------
// 語彙（ユニオン型）
// ---------------------------------------------------------------------------

export type ComposeBars = 4 | 8 | 16 | 40;
export type Tonality = 'major' | 'minor';
export type MelodicLanguage = 'standard' | 'japanese' | 'pentatonic';
/** @deprecated v1保存曲の互換入力。新規コードはtonalityとmelodicLanguageを使う。 */
export type MelodyMode = 'major' | 'minor' | 'japanese';
export type JapaneseScale = 'ritsu' | 'minyo' | 'miyakobushi';
export type JapaneseScaleChoice = 'auto' | JapaneseScale;
export type OrnamentType = 'grace' | 'turn' | 'shake';
export type TupletDivision = 5 | 6 | 7;
export type TupletOverlayChoice = 'off' | 'auto' | TupletDivision;
export type PhraseFunction = 'statement' | 'restatement' | 'departure' | 'conclusion';
export type IntroRole = 'motif' | 'groove' | 'fanfare' | 'runup';
export type CadenceType = 'open' | 'half' | 'closed' | 'turnaround';
export type ArrangementArc = 'build' | 'contrast' | 'terrace' | 'compact' | 'hookFirst';
export type CounterRole = 'response' | 'counterline' | 'guideline';
export type TextureStrategy = 'classic' | 'arpDrive' | 'counterDrive' | 'bassDrive' | 'hybrid';
export type BassRole = 'rootMotion' | 'pedal';
export type PhraseSection = 'A' | 'B' | 'C' | 'D' | 'E';
export type NoteArticulation = 'normal' | 'staccato' | 'tenuto' | 'accent' | 'ornament';
export type HarmonicFunction = 'tonic' | 'predominant' | 'dominant' | 'colour';

// 装置ポリシーの語彙。実装は各装置モジュール（tension / diminution / duet / glide /
// bassline）が持つが、型は ComposeOptions と StyleDef の両方が参照するためここに置く
// （装置モジュール ⇄ types の型循環を避ける）。
export type TensionPolicy = 'off' | 'soft' | 'lush';
export type DiminutionPolicy = 'off' | 'light' | 'rich';
export type DuetPolicy = 'off' | 'on';
export type GlidePolicy = 'off' | 'on';
export type BassLinePolicy = 'off' | 'on';

// ---------------------------------------------------------------------------
// 表示ラベル
// ---------------------------------------------------------------------------

export const INTRO_ROLE_LABELS: Record<IntroRole, string> = {
  motif: '主題予告型',
  groove: 'グルーヴ提示型',
  fanfare: 'ファンファーレ型',
  runup: '駆け上がり型',
};

export const ARRANGEMENT_ARC_LABELS: Record<ArrangementArc, string> = {
  build: '積み上げ型',
  contrast: '対比型',
  terrace: '段丘型',
  compact: 'コンパクト型',
  hookFirst: 'フック先行BIG型',
};

export const COUNTER_ROLE_LABELS: Record<CounterRole, string> = {
  response: '短い応答',
  counterline: '独立対旋律',
  guideline: '保続ガイドライン',
};

export const TEXTURE_STRATEGY_LABELS: Record<TextureStrategy, string> = {
  classic: '標準編成',
  arpDrive: '分散和音主導',
  counterDrive: '対旋律主導',
  bassDrive: '低音主導',
  hybrid: '交替型',
};

export const JAPANESE_SCALE_LABELS: Record<JapaneseScaleChoice, string> = {
  auto: '自動',
  ritsu: '律・陽旋法系',
  minyo: '民謡音階系',
  miyakobushi: '都節系',
};

export const ORNAMENT_LABELS: Record<OrnamentType, string> = {
  grace: '前打音',
  turn: '回し',
  shake: '揺り',
};

export const TUPLET_OVERLAY_LABELS: Record<'off' | 'auto' | '5' | '6' | '7', string> = {
  off: 'なし',
  auto: '自動（区間ごと）',
  '5': '5連符（暗示×1.25）',
  '6': '6連符（暗示×1.5）',
  '7': '7連符（暗示×1.75）',
};

export const PHRASE_FUNCTION_LABELS: Record<PhraseFunction, string> = {
  statement: '提示',
  restatement: '変奏反復',
  departure: '展開',
  conclusion: '結論',
};

// ---------------------------------------------------------------------------
// モチーフ・局所編集・和風音組織
// ---------------------------------------------------------------------------

/** ジェスチャーの1ステップ。実音でなく「方向・順次/跳躍・跳躍幅」だけを持つ。 */
export interface MotifMove {
  direction: 1 | -1;
  stepwise: boolean;
  /** 跳躍時の目安半音数(3〜7)。五音・和風語法では各音組織の跳躍語彙へ読み替える。 */
  leap: number;
}

/**
 * 曲間で持ち運べる旋律モチーフ(2小節=8分16ステップのジェスチャー)。
 * 実音を持たないため、別のキー・調性・音組織・スタイル・和声の上でも同じ「動き方」
 * として再実現できる。モチーフの同一性を音高でなくジェスチャーに置くことで、
 * 一つの主題を語法を替えて複数曲へ流用する運用(ESTi系のモチーフ横断)を支える。
 */
export interface MelodicMotif {
  moves: readonly MotifMove[];
}

/** 決定論生成した主旋律へ後から再適用する、保存可能な局所編集。 */
export interface MelodyEdit {
  beat: number;
  fromMidi: number;
  toMidi: number;
}

export interface JapanesePlan {
  id: JapaneseScale;
  /** キー主音からの五音。西洋的な固定トニックではなく、核音配置を作る材料として使う。 */
  intervals: number[];
  /** 絶対ピッチクラス。 */
  scalePcs: number[];
  /** 4度枠を作る核音。終止とフレーズ開始で優先する。 */
  nuclearPcs: number[];
}

// ---------------------------------------------------------------------------
// ComposeOptions（エンジン入力 + レンダリング設定 = 曲の保存単位）
//
// 保存フォーマット・キャッシュキーは ComposeOptions の JSON。役割を型で分けて
// 明示する: ComposeInput は compose() が読む作曲パラメータ、RenderConfig は
// compose() が読まない編曲層のパラメータ(音色・チップ固有設定)。両者の合成が
// 「曲」の保存単位になる(同じ曲=同じ音色を JSON ひとつで保証するため)。
// ---------------------------------------------------------------------------

/** compose() が読む作曲パラメータ。 */
export interface ComposeInput {
  progressionId: string;
  styleId: string;
  /** キー主音のピッチクラス（0 = C） */
  keyRoot: number;
  bpm: number;
  /** 4 = RB / 8 = BB / 16 = ゲーム BGM / 40 = BIG本編（通常は2小節導入込みで42小節）。 */
  bars: ComposeBars;
  /** 16/40小節曲の先頭へ、初回だけ鳴る2小節イントロを付ける。省略時は有効。 */
  intro?: boolean;
  /** 和声と進行カタログの調性。省略時はmajor。 */
  tonality?: Tonality;
  /**
   * 調性とは独立した旋律語法。japaneseは五音・核音・間・装飾を連動させる文化様式。
   * pentatonicは音組織だけを無半音五音に絞り、テンション・ディミニューション等の
   * 装置は通常どおり使える汎用語彙(00年代ネトゲBGM系の「五音旋律×カラートーン和声」)。
   */
  melodicLanguage?: MelodicLanguage;
  /** @deprecated v1保存曲との互換入力。 */
  melodyMode?: MelodyMode;
  /** 和風モードの音組織。省略時はシードから3様式を選ぶ。 */
  japaneseScale?: JapaneseScaleChoice;
  /** 和風様式とは独立したゲーム向けのリズム層。 */
  grooveFeel?: GrooveFeel;
  /**
   * 分散和音を基準グリッドから外し、1小節をdiv等分した連符に乗せるレイヤー。
   * div個の打点が暗示テンポ（bpm×div/4）の4分音符として機能し、不動の基準面
   * （他声部）との摩擦でテンポが変わったように聴かせる。OPLL専用で、
   * 三連オーバーレイとは併用しない（該当時は無効化される）。省略時はoff。
   */
  tupletOverlay?: TupletOverlayChoice;
  /**
   * 伴奏ボイシングへ足すカラートーンの方針(アヴェイラブル・テンション導出)。
   * 和声機能(pcs)は変えず声部だけ色づける。省略/autoはスタイル既定(通常off)。
   * 和風五音は開放五度の美学と衝突するため常にoff。
   */
  tensionPolicy?: 'auto' | TensionPolicy;
  /**
   * 主旋律のディミニューション(8分骨格の間へ16分経過音を挿入)。骨格は不変。
   * 省略/autoはスタイル既定(通常off)。和風五音は装飾体系が別なので常にoff。
   */
  diminution?: 'auto' | DiminutionPolicy;
  /**
   * ハモリ(主旋律への平行下3度、duet.ts)。声部予算のあるバックエンド(duetLayer)のみ。
   * 省略/autoはスタイル既定。和風五音は常にoff。
   */
  duet?: 'auto' | DuetPolicy;
  /**
   * ベースライン生成(bassline.ts)。'on' は和声計画へ分数コード(bassDegrees)を書き、
   * ベース声部を転回・半音経過込みの順次ラインにする。省略/autoはスタイル既定。
   * 和風五音は揺り・間の体系と衝突するため常にoff(他デバイスと同じ家内規約)。
   */
  bassLine?: 'auto' | BassLinePolicy;
  /**
   * スライド(ポルタメント)指示の付与(glide.ts)。表現できるバックエンド(glide)のみ。
   * 省略/autoはスタイル既定。和風五音は常にoff(揺り・間の体系と衝突)。
   */
  glide?: 'auto' | GlidePolicy;
  /**
   * 別の曲から持ち込む主題ジェスチャー。指定すると主題区間(A)の音程ジェスチャーを
   * これで置き換える(乱数消費は変えないので、他の区間・声部はそのまま)。
   * 曲のPiece.motifを保存し、キー・調性・語法・スタイルを替えた別曲へ渡すことで、
   * 同一モチーフの語法横断流用ができる。
   */
  externalMotif?: MelodicMotif;
  /** 診断の局所修正。シード生成後に一致する音だけへ再適用する。 */
  melodyEdits?: readonly MelodyEdit[];
  /**
   * この曲を生成したエンジンのリビジョン。音を変える生成器変更はこの値でゲートし、
   * 旧リビジョンの保存曲は旧挙動のまま再現する(一点式バージョニング)。
   * 省略 = 0(engineRev導入前の全保存曲)。UIは保存時に CURRENT_ENGINE_REV を焼く。
   */
  engineRev?: number;
  seed: number;
  /** 全小節ぶんのスロット選択。省略時は8小節以上で区間変化、4小節で定番形を選ぶ。 */
  choice?: readonly number[];
  /** ブラインド比較用の上位戦略。省略時は既存と同じ current。 */
  compositionStrategy?: CompositionStrategy;
  /**
   * 作曲対象のバックエンド。省略時は従来どおり OPLL(保存済み v1 曲との後方互換)。
   * 'pcm' は制約の少ない作曲対象(広い編成・テンション等)で、チップでの再生時は
   * 各編曲層が能力に応じて劣化させる(sound-capabilities.ts)。
   */
  soundChip?: SoundBackendId;
}

/** compose() が読まない編曲層のパラメータ。曲へ音色を焼き込むための保存項目。 */
export interface RenderConfig {
  /**
   * OPLL 音色の上書き（0=ユーザー音色、1〜15=内蔵音色）。省略時はスタイル既定。
   * compose() 自体は使わない編曲層のパラメータだが、曲の保存単位・BGM キャッシュの
   * キーが ComposeOptions の JSON なので、ここに持たせて「同じ曲 = 同じ音色」を保証する
   */
  voices?: VoiceOverride;
  /** OPLLの音色0番へ書き込む1曲1個のユーザー音色。 */
  opllUserPatch?: OpllUserPatchId;
  /**
   * パート別のPCM音色上書き。compose() 自体は使わないPCM編曲層のパラメータだが、
   * voices と同じ理由（曲の保存単位・キャッシュキー = ComposeOptions の JSON）で
   * ここに持たせ、pcm の曲が ComposeOptions だけで完全再現できるようにする。
   * 未指定の旧保存曲は再生環境のグローバル設定で鳴る（従来挙動）。
   */
  pcmVoices?: PcmVoiceOverride;
  /** ファミコン 2A03 モード固有の音色パラメータ。 */
  nes?: NesVoiceOptions;
}

/** 曲の保存単位 = 作曲入力 + レンダリング設定。JSON がそのままキャッシュキーになる。 */
export interface ComposeOptions extends ComposeInput, RenderConfig {}

/**
 * 現行エンジンのリビジョン。音を変える生成器変更を入れるたびに +1 し、compose() 内の
 * 該当分岐を `engineRevOf(opts) >= N` でゲートする。
 * リビジョン間の挙動差は必ず分岐箇所のコメントで「何がどう変わるか」を残すこと。
 *
 * - rev1: ベースのアンカー音を「ルートpcの固定写像(E2..D#3帯、pc上隣接するE→D#が
 *   11半音跳ぶ不連続)」から「直前アンカーへの最短連結」へ変更(ベース生成部を参照)。
 * - rev2: 主題ジェスチャーの抽選を主系列rngから区間ごとの独立ストリームへ分離
 *   (compose.tsを参照)。rev1以前は「PhrasePlanの主系列消費量が変わるとジェスチャーが
 *   連動して変わる」暗黙結合があり、フレーズ計画の将来変更が主題まで壊す構造だった。
 */
export const CURRENT_ENGINE_REV = 2;

/**
 * この生成で実際に適用するリビジョン。未指定=0(導入前の全保存曲)。
 * 未来のリビジョン(新しいビルドで保存された曲)は再現不能なので現行へクランプして
 * ベストエフォートで鳴らす。非整数は壊れたデータとして 0 扱い。
 */
export function engineRevOf(opts: Pick<ComposeOptions, 'engineRev'>): number {
  const raw = opts.engineRev ?? 0;
  return Number.isInteger(raw) ? Math.max(0, Math.min(CURRENT_ENGINE_REV, raw)) : 0;
}

export interface NesVoiceOptions {
  /** パルス 1（主旋律）のデューティ。0=12.5%, 1=25%, 2=50%, 3=25%反転。 */
  pulse1Duty?: 0 | 1 | 2 | 3;
  /** パルス 2（伴奏）のデューティ。 */
  pulse2Duty?: 0 | 1 | 2 | 3;
}

/** パート別の OPLL 音色上書き。未指定のパートはスタイル既定（opll-arrange.ts） */
export interface VoiceOverride {
  lead?: number;
  backing?: number;
  bass?: number;
  counter?: number;
  ostinato?: number;
}

/**
 * PCMのパート語彙。編曲層の役割語彙(audio/stage.ts の StageRole)と同一で、
 * pcm-arrange.ts が両者の一致をコンパイル時に検証する。
 */
export type PcmPart = 'lead' | 'duet' | 'counter' | 'ostinato' | 'backing' | 'bass' | 'drums';

/** SoundFontのプリセット参照(GMバンク/プログラム)。 */
export interface PcmPresetRef {
  bank: number;
  program: number;
}

/** 主旋律の受け渡し色(arrangement.tsのleadColor)。0=看板(hook) 1=展開(development) 2=緩急(relief)。 */
export type LeadColorSlot = 0 | 1 | 2;

/**
 * パート別のPCM音色上書き。未指定パートはスタイル既定のGMプログラム。
 * 主旋律はleadColorVoicesで受け渡し色ごとに上書きできる(A=ピアノ、B=ギター等)。
 * 優先順: leadColorVoices[色] > lead(全区間固定) > スタイル既定パレット。
 */
export interface PcmVoiceOverride extends Partial<Record<PcmPart, PcmPresetRef>> {
  leadColorVoices?: Partial<Record<LeadColorSlot, PcmPresetRef>>;
}

export type OpllUserPatchId = 'brightLead' | 'metalBell' | 'punchBass';

// ---------------------------------------------------------------------------
// 音イベント（Piece の声部要素）
// ---------------------------------------------------------------------------

export interface NoteEvent {
  beat: number;
  dur: number;
  midi: number;
  /** 0..1。編曲層がチップ固有の音量段階へ変換する。 */
  velocity?: number;
  articulation?: NoteArticulation;
  ornament?: OrnamentType;
  /** 装飾音はPhrasePlanの骨格リズム検証から除外する。 */
  role?: 'structural' | 'ornament';
  /**
   * この音の頭で、指定MIDIノートから目標音高へ滑らせる(ポルタメント)。
   * 表現できないバックエンドは無視してよい(sound-capabilities.glide)。
   */
  glideFrom?: number;
}

export interface ChordEvent {
  beat: number;
  dur: number;
  token: string;
  name: string;
  function: HarmonicFunction;
  /** 絶対ピッチクラス集合（検証用） */
  pcs: number[];
  /** 直前のコードから最短距離で接続した、低音から高音順の伴奏ボイシング。 */
  midis: number[];
  /** テンション方針で声部へ足したカラートーン(絶対pc)。機能はpcsのまま。 */
  colorPcs?: number[];
  /**
   * 分数コードのベース音(絶対pc)。省略=ルートポジション=ベース声部がrootを弾く
   * (伴奏ボイシングmidisは従来どおり転回を許す密集配置で、このフィールドと無関係)。
   * HarmonyBarPlan.bassDegrees から確定する。コードトーン外の経過ベースも許す。
   */
  bassPc?: number;
}

export interface DrumEvent {
  beat: number;
  inst: 'kick' | 'snare' | 'hat' | 'tom' | 'cymbal';
  /**
   * ハットのオープン指示(drum-articulation.tsが譜面の間隙から導出)。
   * GMドラム(PCM)だけが鳴らし分け、チップ5音ドラムは無視して劣化する。
   */
  open?: boolean;
  /** 拍節アクセント(0..1、省略=1)。同じく能力のないバックエンドは無視する。 */
  velocity?: number;
}

// ---------------------------------------------------------------------------
// フレーズ設計図（PhrasePlan）
// ---------------------------------------------------------------------------

export interface PhraseBarPlan {
  bar: number;
  section: PhraseSection;
  role: 'statement' | 'answer' | 'continuation' | 'cadence';
  /** 8分グリッド上の主旋律発音位置。 */
  rhythm: boolean[];
  /** 主旋律と同時に確保した、副旋律専用の8分グリッド位置。 */
  counterSteps: number[];
  /** 16分グリッド上の短い装飾音位置。 */
  ornamentSteps: number[];
  /** 装飾を入れる小節だけ種類を持つ。 */
  ornamentType: OrnamentType | null;
  /** 意図して空けた8分グリッド位置。 */
  maSteps: number[];
  /** 8小節を提示→変奏反復→展開→結論として捉えたフレーズ機能。 */
  phraseFunction: PhraseFunction;
  /** この小節が輪郭を受け継ぐ元小節。提示小節は自分自身。 */
  motifSourceBar: number;
  cadence: CadenceType | null;
  /** フレーズが到達する音のピッチクラス。 */
  targetPc: number | null;
  targetStep: number | null;
  /** 0..5。音域・編成の起伏に使う。 */
  energy: number;
  /** 0..1。小節内の基準ダイナミクス。 */
  dynamic: number;
  /** 主旋律の1拍目を意図して空ける小節（呼吸・弱起）。伴奏とベースは拍頭を保つ。 */
  restStart: boolean;
  /** 前小節のロングトーンが1拍目を覆うため、主旋律の頭打ちを省いた小節。 */
  sustainedEntry: boolean;
  /** このstepの音を次小節の最初の発音まで保続する（2拍以上のロングトーン）。 */
  longToneStep: number | null;
  /**
   * 3拍目の再打鍵を省き、直前の8分の発音をアンカー越しに保続する小節（食い/先取音）。
   * 保続音は跨いだ先(3拍目時点)の和音の構成音へ吸着させる（先取音の定義）。
   */
  anchorTie: boolean;
  /** step7 に置く、次フレーズ頭への弱起（アウフタクト）。音高は次フレーズアンカーの2度下。 */
  anacrusis: boolean;
  /** 強拍倚音を許可するステップ（現状は3拍目=step4のみ）。実現は2度解決できる場合に限る。 */
  appoggiaturaStep: number | null;
  /** セクション別テッシトゥーラ変位（半音）。旋律の目標高さへ加算する。 */
  registerOffset: number;
}

export interface PhrasePlan {
  climaxBar: number;
  /** 一度だけ許す9半音超の署名跳躍を置く小節（頭拍）。null なら無し。 */
  signatureLeapBar: number | null;
  /** 5つのリズム変奏族（[問い, 答え]×5）。実音テーマの構築が提示リズムとして参照する。 */
  rhythmFamilies: ReadonlyArray<readonly [readonly boolean[], readonly boolean[]]>;
  bars: PhraseBarPlan[];
}

// ---------------------------------------------------------------------------
// 編成設計図（ArrangementPlan）
// ---------------------------------------------------------------------------

export interface ArrangementSectionPlan {
  backingDensity: 'sparse' | 'full';
  echo: boolean;
  drum: 'base' | 'sectionB' | 'breakdown';
  /** セクション頭の合図。エネルギー上昇時も毎回同じシンバルにはしない。 */
  entrance: 'none' | 'cymbal';
  /** 次区間へのフィル。境界ごとに同じフィルを貼らない。 */
  exitFill: 'none' | 'light' | 'full';
  counterDensity: 0 | 1 | 2;
  /** 独立した分散和音の密度。0=休止、1=8分、2=16分主体。 */
  ostinatoDensity: 0 | 1 | 2;
  /** 16分へ加速するフレーズ位置。区間ごとに同じ場所へ固定しない。 */
  ostinatoPeak: PhraseFunction | null;
  /** 連符レイヤーの分割数。nullは基準グリッド。密度1=1小節div等分、密度2=半小節div等分。 */
  ostinatoTuplet: TupletDivision | null;
  /**
   * 主旋律の音色パレット番号(0=看板)。音色でフォームを分節する管弦楽法の基本:
   * 新しいセクション=新しい色。実音色は各レンダラのパレットが解決する。
   */
  leadColor: number;
}

export interface ArrangementPlan {
  arc: ArrangementArc;
  counterRole: CounterRole;
  /** 曲全体で何を推進力にするか。各奏法を常時重ねず、区間ごとに出し引きする。 */
  textureStrategy: TextureStrategy;
  /** ペダル低音も常設せず、低音主導の戦略でだけ選べる道具として扱う。 */
  bassRole: BassRole;
  sectionA: ArrangementSectionPlan;
  sectionB: ArrangementSectionPlan;
  /** 4/8小節=1区間、16小節=2区間、40小節=5区間。 */
  sections: readonly ArrangementSectionPlan[];
}

// ---------------------------------------------------------------------------
// 曲全体の設計図（SongPlan）
// ---------------------------------------------------------------------------

export type HarmonicGoal = 'establish' | 'continue' | 'depart' | 'resolve' | 'turnaround';
export type SectionRole = 'hook' | 'development' | 'relief' | 'return' | 'finale';
/**
 * literal は「移調も反転もしない帰還」。実現側はアンカー（フレーズ頭・終止音）だけを
 * その場の和声へ合わせ、内部の音程・リズムを保存する（フックのリテラル再現）。
 */
export type MotifTransform = 'original' | 'transpose' | 'invert' | 'contrast' | 'literal';
export type RhythmVariant = 0 | 1 | 2 | 3 | 4;
export type IntroLeadGesture =
  | 'motifFragment'
  | 'motifAnswer'
  | 'rest'
  | 'pickup'
  | 'fanfareCall'
  | 'fanfareAnswer'
  | 'heldCall'
  | 'scaleRun';
export type IntroBassGesture = 'pedal' | 'groove' | 'stopForLead' | 'hits' | 'pickup';
export type IntroDrumGesture = 'none' | 'groove' | 'accents' | 'fill' | 'countIn';

export interface IntroBarPlan {
  bar: 0 | 1;
  goal: 'identity' | 'transition';
  tokens: readonly string[];
  /** 合計が4拍未満なら、残りはAを迎える全パート共通のブレイク。 */
  durations: readonly number[];
  leadGesture: IntroLeadGesture;
  bassGesture: IntroBassGesture;
  drumGesture: IntroDrumGesture;
  energy: number;
}

/** 本編を生成する前に確定する、初回専用の2小節トランジション。 */
export interface SongIntroPlan {
  enabled: boolean;
  bars: 0 | 2;
  role: IntroRole | null;
  /** イントロが最終的に受け渡すA冒頭のコード。 */
  entryToken: string;
  entryFunction: HarmonicFunction;
  /** A直前に全声部を止める長さ。役割ごとに0〜1.5拍を使い分ける。 */
  breakBeats: number;
  barPlans: readonly IntroBarPlan[];
}

export interface SongSectionPlan {
  index: number;
  id: PhraseSection;
  startBar: number;
  bars: number;
  role: SectionRole;
  /** 1..5。編成密度ではなく、曲として目指す相対エネルギー。 */
  energy: number;
  /** 0..4。同じリズム型を全セクションへ貼らないためのモチーフ変奏族。 */
  rhythmVariant: RhythmVariant;
  /** 提示・変奏反復・展開・結論ごとのリズム族。区間内も同じ2小節を貼り続けない。 */
  phraseRhythmVariants: readonly [RhythmVariant, RhythmVariant, RhythmVariant, RhythmVariant];
  /** 各フレーズが参照する同区間／参照先区間のフレーズ番号。 */
  motifSourcePhrases: readonly [0 | 1 | 2 | 3, 0 | 1 | 2 | 3, 0 | 1 | 2 | 3, 0 | 1 | 2 | 3];
  /** 外部区間から借りるフレーズ。1要素=2小節だけに絞り、区間全体の複製を避ける。 */
  externalMotifPhrases: readonly (0 | 1 | 2 | 3)[];
  /** externalMotifPhrasesが参照する区間。nullなら全フレーズを区間内で展開する。 */
  motifSourceSection: PhraseSection | null;
  /** 参照モチーフをそのまま複製せず、区間の役割に応じて変形する。 */
  motifTransform: MotifTransform;
  /**
   * 提示・変奏反復・展開・結論の各応答小節が到達する目標「音組織上の度数」
   * （7音音階では 0=1̂, 1=2̂, 2=3̂, 4=5̂。五音音階では同じ添字がその音組織の対応音度
   * になり、例えば長ペンタの4は6̂＝ヨナ抜きの常套終止色）。フレーズ終止が毎回
   * ルートへ落ちる単調さを避け、段階的に主音へ収束する「終止音度の物語」を作る
   * （旋法的終止階層とシェンカー的下行の折衷。実際の到達音はその小節の和声音から
   * 目標に円環距離が最も近いものを選ぶ）。
   */
  cadenceDegrees: readonly [number, number, number, number];
}

export interface HarmonyBarPlan {
  bar: number;
  section: PhraseSection;
  phraseFunction: PhraseFunction;
  harmonicGoal: HarmonicGoal;
  /** ユーザーが選んだ進行レシピを、フォーム上の役割と一緒に確定したもの。 */
  tokens: readonly string[];
  /** tokens と同じ順。コード変化位置はフレーズ目的とコード機能から決める。 */
  durations: readonly number[];
  /**
   * tokens と同じ順の分数コード指定（キー主音からの相対半音）。null はルートポジション。
   * コードトーン外の音も許す（半音経過ベース）。省略 = 全てルートポジション。
   * ベースライン生成器（ステップ2）が書き、ベース声部と ChordEvent.bassPc が読む。
   */
  bassDegrees?: readonly (number | null)[];
  /** 上位戦略がこの小節の和声選択へ与えた意味。 */
  strategyRole: 'base' | 'absence' | 'return';
  entryFunction: HarmonicFunction;
  exitFunction: HarmonicFunction;
  cadence: CadenceType | null;
  energy: number;
}

export interface SongFormPlan {
  sections: readonly SongSectionPlan[];
  climaxBar: number;
  loopCadence: 'turnaround';
}

/** 各声部を生成する前に確定する、曲全体の単一の設計図。 */
export interface SongPlan {
  /** ブラインド比較用の上位戦略。未指定の保存曲は current として計画する。 */
  compositionStrategy: CompositionStrategy;
  /** 戦略名を各層が再解釈しないための、曲全体で共有する実効ポリシー。 */
  compositionPolicy: CompositionPolicy;
  /** 条件3で各声部が共有する「前進する表層／帰りたがる内側」という命題。 */
  premise: CompositionPremise | null;
  tonality: Tonality;
  melodicLanguage: MelodicLanguage;
  grooveFeel: GrooveFeel;
  styleId: string;
  progressionId: string;
  /** 進行カタログ自体の長さ。4小節進行を長尺化した際の反復診断に使う。 */
  progressionBars: number;
  soundChip: SoundBackendId;
  intro: SongIntroPlan;
  form: SongFormPlan;
  harmony: readonly HarmonyBarPlan[];
  /** スタイル固有の主旋律音数。編成が旋律の混み具合を判断するために共有する。 */
  melodyDensity: number;
  /** 1小節に複数コードを置く小節の比率。 */
  harmonicActivity: number;
}

// ---------------------------------------------------------------------------
// Piece（compose() の出力スキーマ）
// ---------------------------------------------------------------------------

export interface Piece {
  bpm: number;
  styleId: string;
  tonality: Tonality;
  melodicLanguage: MelodicLanguage;
  /** @deprecated 表示・保存互換用。 */
  melodyMode: MelodyMode;
  japanesePlan: JapanesePlan | null;
  /**
   * 旋律語彙の絶対ピッチクラス(標準=ダイアトニック、和風=五音3様式、五音=無半音五音)。
   * 診断・修正提案はこれを「その曲の音組織」として参照し、語法別の分岐を持たない。
   */
  melodicScalePcs: number[];
  /**
   * 主題区間(A)の音程ジェスチャー。保存して別の曲のexternalMotifへ渡すと、
   * 同じモチーフを別のキー・語法・スタイルで再実現できる。
   */
  motif: MelodicMotif;
  grooveFeel: GrooveFeel;
  /** ループ本体の小節数。introBars は含めない。 */
  bars: number;
  /** 初回だけ鳴るイントロの小節数。16/40小節フォーム以外は0。 */
  introBars: number;
  /** イントロが担う役割。イントロなしの場合は null。 */
  introRole: IntroRole | null;
  /** イントロ後、ループ本体が始まる拍位置。 */
  loopStartBeat: number;
  /** イントロを含む総拍数。 */
  beats: number;
  keyRoot: number;
  chords: ChordEvent[];
  melody: NoteEvent[];
  /** PhrasePlanで主旋律と同時に場所を確保した短い副旋律。 */
  counterMelody: NoteEvent[];
  /** リフと別に推進力を担当する分散和音。チップ別編曲で優先度を付けて配線する。 */
  ostinato: NoteEvent[];
  /** 主旋律に下3度で並走するハモリ。声部予算のあるバックエンドだけが鳴らす。 */
  duet: NoteEvent[];
  bass: NoteEvent[];
  drums: DrumEvent[];
  /** 全声部が共有する、フレーズ・終止・起伏の設計図。 */
  phrasePlan: PhrasePlan;
  /** 和声・フォーム・エネルギーを、各声部より前に確定した曲全体の設計図。 */
  songPlan: SongPlan;
  /** 各セクションの密度・ダブリング・対旋律の役割を決める編成設計。 */
  arrangementPlan: ArrangementPlan;
  /** 表示用: イントロの小節ごとのコード名。 */
  introChordNames: string[];
  /** 表示用: 小節ごとのコード名（半小節は空白区切り） */
  barChordNames: string[];
}
