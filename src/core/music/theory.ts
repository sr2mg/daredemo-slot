/**
 * サウンドテスト用の最小音楽理論データ層。
 * - コードは「キー主音からの相対ピッチクラス集合」で持つ（キー変更 = 平行移動のみ）
 * - 進行は固定列ではなく「小節スロット + 選択肢」で持つ。同じ機能の代理和音を
 *   選択制にすることで、1 エントリから破綻しない進行を組み合わせ的に生成できる
 * - メロディ検証はローマ数字表ではなく実コードの音集合で行う（セカンダリー
 *   ドミナント等のキー外の音も「正解」にするため。III7 の G# など）
 */

import { DRUM_GHOST } from './drum-articulation.js';
import type { GrooveFeel } from './groove.js';
import type {
  BassLinePolicy,
  DuetPolicy,
  GlidePolicy,
  HarmonicFunction,
} from './types.js';

/**
 * コード品質。文字列は chordName() の表示接尾辞であり、同時に tones の導出キー。
 */
export type ChordQuality = '' | 'm' | 'dim' | '7' | 'm7' | 'M7' | '6' | 'sus4' | 'add9';

/**
 * 品質 → ルートからの相対音程（半音）。tones は root とこの表から導出する。
 * 並びは3度堆積順（add9 の 9th は最後）。ChordEvent.pcs はこの並びを引き継ぎ
 * ボイシングの基準順になるため、既存トークンの並びは変えないこと。
 */
const QUALITY_INTERVALS: Record<ChordQuality, readonly number[]> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  dim: [0, 3, 6],
  '7': [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  M7: [0, 4, 7, 11],
  '6': [0, 4, 7, 9],
  sus4: [0, 5, 7],
  add9: [0, 4, 7, 2],
};

export interface ChordDef {
  /** キー主音からの相対ルート（半音）。変位度数（♭III=3, ♭VII=10 等）もこの値で表す。 */
  root: number;
  /** クオリティ（表示接尾辞 = tones の導出キー） */
  quality: ChordQuality;
  /** キー主音からの相対ピッチクラス集合（root + QUALITY_INTERVALS から導出） */
  tones: readonly number[];
  /**
   * 機能和声上の大まかな役割（リーマン流 T/S/D + 機能進行に属さない colour）。
   * 進行スロット設計・2コード小節の変化位置・イントロの接近和音が参照する。
   */
  function: HarmonicFunction;
}

const chord = (
  root: number,
  quality: ChordQuality,
  harmonicFunction: HarmonicFunction,
): ChordDef => ({
  root,
  quality,
  tones: QUALITY_INTERVALS[quality].map((interval) => (root + interval) % 12),
  function: harmonicFunction,
});

export const CHORDS: Record<string, ChordDef> = {
  I: chord(0, '', 'tonic'),
  ii: chord(2, 'm', 'predominant'),
  iii: chord(4, 'm', 'tonic'),
  IV: chord(5, '', 'predominant'),
  V: chord(7, '', 'dominant'),
  vi: chord(9, 'm', 'tonic'),
  IVM7: chord(5, 'M7', 'predominant'),
  III7: chord(4, '7', 'dominant'),
  ii7: chord(2, 'm7', 'predominant'),
  iii7: chord(4, 'm7', 'tonic'),
  vi7: chord(9, 'm7', 'tonic'),
  v7: chord(7, 'm7', 'dominant'),
  I7: chord(0, '7', 'dominant'),
  // 短調。大文字/小文字は主音から見た機能を明示し、keyRoot は常に主音として扱う。
  i: chord(0, 'm', 'tonic'),
  i7: chord(0, 'm7', 'tonic'),
  iiDim: chord(2, 'dim', 'predominant'),
  III: chord(3, '', 'tonic'),
  III7m: chord(3, '7', 'dominant'),
  iv: chord(5, 'm', 'predominant'),
  iv7: chord(5, 'm7', 'predominant'),
  /** ドリアンの♮6を3度に持つIV7（短調のF7）。iv系と選択制で使う。 */
  IV7m: chord(5, '7', 'predominant'),
  v: chord(7, 'm', 'dominant'),
  V7m: chord(7, '7', 'dominant'),
  VI: chord(8, '', 'predominant'),
  VImaj7: chord(8, 'M7', 'predominant'),
  VII: chord(10, '', 'dominant'),
  VIIm7: chord(10, 'm7', 'predominant'),
  // --- カラーコード（M7/6th/add9/sus4）と借用和音。7thチェーン・順次ベース様式の語彙。 ---
  // 借用元は列挙せず chordOriginsFor() が旋法照合で導出する。既存進行カタログは
  // まだ使わないため追加しても音は変わらない（進行への供給はステップ3の生成器から）。
  IM7: chord(0, 'M7', 'tonic'),
  I6: chord(0, '6', 'tonic'),
  Iadd9: chord(0, 'add9', 'tonic'),
  IVadd9: chord(5, 'add9', 'predominant'),
  /** 4-3掛留。第3音を持たないため長短両調で使える。 */
  Vsus4: chord(7, 'sus4', 'dominant'),
  /** 長調では♭VIIM7（ミクソリディア借用のバックドア）、短調ではドリアの♮6を含むVIIM7。 */
  VIIM7: chord(10, 'M7', 'dominant'),
  /** 短調のダイアトニックIII△7。長調では♭IIIM7（同主短調からの借用）。 */
  IIIM7: chord(3, 'M7', 'tonic'),
  /** ♭VIIm（フリギア借用）。機能進行に属さない旋法的色彩。 */
  vii: chord(10, 'm', 'colour'),
};

/** ローマ数字トークンの和声機能。カタログのメタデータを引く（未知トークンは colour）。 */
export function harmonicFunctionForToken(token: string): HarmonicFunction {
  return CHORDS[token]?.function ?? 'colour';
}

/** 同主音上の音組織（教会旋法 + 和声的短音階）。借用判定の導出元。 */
export type ModalSource =
  | 'ionian' | 'dorian' | 'phrygian' | 'lydian' | 'mixolydian' | 'aeolian' | 'harmonicMinor';

const MODAL_SCALES: Record<ModalSource, readonly number[]> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
};

/**
 * トークンの出自解釈。同じ和音が複数の導出を持ちうる（例: 短調のIV7mは
 * ドリアン借用ともV/VIIとも読める）ため、単一ラベルに丸めず候補を全て返し、
 * どの解釈を採るかは文脈（進行・解決先）を知る呼び出し側に委ねる。
 */
export interface ChordOrigins {
  /**
   * 全構成音がその調性のダイアトニック音階（長調=長音階、短調=自然短音階）に収まる。
   * 注意: 短調の主要ドミナントV7mは和声的短音階由来なので false になるが借用ではない
   * （modes に harmonicMinor が入ることで判別できる）。false を即「借用」と読まないこと。
   */
  diatonic: boolean;
  /**
   * ドミナント7thとして五度下のダイアトニック度数 x へ解決しうる場合、その x の root。
   * 主和音への解決（x=0）は主要ドミナントでありセカンダリーとは呼ばないため除く。
   */
  secondaryDominantOf: number | null;
  /** 同主音の旋法・和声的短音階のうち全構成音を含むもの（旋法的借用の候補）。 */
  modes: readonly ModalSource[];
}

export function chordOriginsFor(
  token: string,
  tonality: ProgressionTonality,
): ChordOrigins | null {
  const def = CHORDS[token];
  if (!def) return null;
  const scale: readonly number[] = tonality === 'minor' ? NATURAL_MINOR_SCALE : MAJOR_SCALE;
  const diatonic = def.tones.every((pc) => scale.includes(pc));
  const target = (def.root + 5) % 12;
  const secondaryDominantOf = def.quality === '7' && !diatonic && target !== 0 && scale.includes(target)
    ? target
    : null;
  const modes = (Object.keys(MODAL_SCALES) as ModalSource[])
    .filter((mode) => def.tones.every((pc) => MODAL_SCALES[mode].includes(pc)));
  return { diatonic, secondaryDominantOf, modes };
}

/** 1 スロット選択肢 = その小節で鳴らすコード列（2 つなら半小節ずつ） */
export type SlotOption = readonly string[];

export type ProgressionTonality = 'major' | 'minor';

export interface ProgressionRealization {
  /** slots[小節] = 選択肢の配列 */
  slots: readonly (readonly SlotOption[])[];
  /** 定番の選び方（各小節のスロット index） */
  defaultChoice: readonly number[];
  /** ボタン・自動変化で抽選する、音楽的に確認済みの進行レシピ */
  variations: readonly (readonly number[])[];
}

export type ProgressionRealizationOverride = Pick<ProgressionRealization, 'slots'>
  & Partial<Pick<ProgressionRealization, 'defaultChoice' | 'variations'>>;

export interface ProgressionDef extends ProgressionRealization {
  /**
   * 恒久凍結ID。compose が旋律シードへハッシュ化して混ぜ(音が変わる)、保存曲の
   * ComposeOptions が参照し、未知IDは throw する。リネーム・削除・再利用は保存曲を
   * 壊すため禁止。用途ラベル等のクライアント文脈の表示語彙は core に置かず、
   * このIDをキーにクライアント側(bgm-composer の表引き)が持つ。
   */
  id: string;
  name: string;
  feel: string;
  /** 基準となる調性。和風五音は major カタログを開放五度化して共有する。 */
  tonality: ProgressionTonality;
  /** 同じ進行原理を別の調性で鳴らすための、ローマ数字による実体。 */
  realizations?: Partial<Record<ProgressionTonality, ProgressionRealizationOverride>>;
}

export const PROGRESSIONS: ProgressionDef[] = [
  {
    id: 'royal-pop',
    name: '王道ポップ',
    feel: '明るく安定',
    tonality: 'major',
    // 安定→陰り→助走→帰結という役割を i→VI→iv→V7 へ移す。
    realizations: {
      minor: {
        slots: [[['i']], [['VI'], ['V7m'], ['III']], [['iv'], ['VI'], ['iiDim']], [['V7m'], ['iv', 'V7m'], ['iv']]],
      },
    },
    slots: [[['I']], [['vi'], ['V'], ['iii']], [['IV'], ['vi'], ['ii']], [['V'], ['IV', 'V'], ['IV']]],
    defaultChoice: [0, 0, 0, 0],
    variations: [
      [0, 0, 0, 1], // I → vi → IV → IV・V
      [0, 1, 1, 2], // I → V → vi → IV
      [0, 2, 0, 0], // I → iii → IV → V
      [0, 0, 2, 0], // I → vi → ii → V
    ],
  },
  {
    id: 'fanfare',
    name: 'ファンファーレ',
    feel: '祝祭・完結感',
    tonality: 'major',
    // 短調でもファンファーレの明確な終止を失わないよう i→iv→V7→i とする。
    realizations: {
      minor: {
        slots: [[['i']], [['iv'], ['iiDim']], [['V7m'], ['iv', 'V7m']], [['i'], ['V7m']]],
      },
    },
    slots: [[['I']], [['IV'], ['ii']], [['V'], ['IV', 'V']], [['I'], ['V']]],
    defaultChoice: [0, 0, 0, 0],
    variations: [
      [0, 0, 0, 1], // I → IV → V → V（ループへ引っ張る）
      [0, 1, 0, 0], // I → ii → V → I
      [0, 0, 1, 0], // I → IV → IV・V → I
      [0, 1, 0, 1], // I → ii → V → V
    ],
  },
  {
    id: 'tanaka-manabe',
    name: '田中・真部進行',
    feel: 'アニソン的疾走感・切なさ',
    tonality: 'major',
    // C長調の IV→V→vi→I は、相対短調Aでは VI→VII→i→III として同じ引力を保つ。
    realizations: {
      minor: {
        slots: [
          [['VI'], ['iv']],
          [['VII'], ['v']],
          [['i']],
          [['III'], ['v'], ['VII'], ['i']],
        ],
      },
    },
    // 1 小節目 = サブドミナント枠、2 小節目 = ドミナント枠、3 小節目 = Am 固定、4 小節目 = 自由枠
    slots: [
      [['IV'], ['ii']],
      [['V'], ['iii']],
      [['vi']],
      [['I'], ['iii'], ['V'], ['vi']],
    ],
    defaultChoice: [0, 0, 0, 0], // 定番: F → G → Am → C（キー C の場合）
    variations: [
      [1, 0, 0, 0], // ii → V → vi → I
      [0, 1, 0, 0], // IV → iii → vi → I
      [0, 0, 0, 1], // IV → V → vi → iii
      [0, 0, 0, 2], // IV → V → vi → V
      [1, 0, 0, 2], // ii → V → vi → V
    ],
  },
  {
    id: 'komuro',
    name: '小室進行',
    feel: '疾走感・ドラマチック',
    tonality: 'major',
    // vi→IV→V→I を短調の i→VI→VII→III として解釈する。
    realizations: {
      minor: {
        slots: [[['i']], [['VI'], ['iv'], ['v']], [['VII'], ['VI', 'VII'], ['VI']], [['III'], ['VII']]],
      },
    },
    slots: [[['vi']], [['IV'], ['ii'], ['iii']], [['V'], ['IV', 'V'], ['IV']], [['I'], ['V']]],
    defaultChoice: [0, 0, 0, 0],
    variations: [
      [0, 0, 0, 1], // vi → IV → V → V
      [0, 1, 0, 0], // vi → ii → V → I
      [0, 0, 1, 0], // vi → IV → IV・V → I
      [0, 2, 2, 1], // vi → iii → IV → V
    ],
  },
  {
    id: 'canon',
    name: 'カノン風',
    feel: '壮大',
    tonality: 'major',
    // カノンの下降感と8小節の輪郭を、自然短調＋終端の和声的短音階で保つ。
    realizations: {
      minor: {
        slots: [
          [['i']],
          [['v']],
          [['VI']],
          [['III']],
          [['iv']],
          [['i'], ['VI']],
          [['iv'], ['iiDim']],
          [['V7m'], ['iv', 'V7m']],
        ],
      },
    },
    slots: [[['I']], [['V']], [['vi']], [['iii']], [['IV']], [['I'], ['vi']], [['IV'], ['ii']], [['V'], ['IV', 'V']]],
    defaultChoice: [0, 0, 0, 0, 0, 0, 0, 0],
    variations: [
      [0, 0, 0, 0, 0, 1, 0, 0], // 後半を vi へ寄せる
      [0, 0, 0, 0, 0, 0, 1, 0], // 終盤を ii → V
      [0, 0, 0, 0, 0, 0, 0, 1], // 最後を IV → V
      [0, 0, 0, 0, 0, 1, 1, 1], // vi → ii → IV・V
    ],
  },
  {
    id: 'jttou',
    name: 'Just the Two of Us 進行',
    feel: 'シティポップ・浮遊感',
    tonality: 'major',
    // 相対短調では VImaj7→V7→i7。末尾の借用ii–VはVImaj7へ戻る色彩として残す。
    realizations: {
      minor: {
        slots: [[['VImaj7'], ['iv7']], [['V7m'], ['v7']], [['i7']], [['VIIm7', 'III7m'], ['III7m']]],
      },
    },
    slots: [[['IVM7'], ['ii7']], [['III7'], ['iii7']], [['vi7']], [['v7', 'I7'], ['I7']]],
    defaultChoice: [0, 0, 0, 0],
    variations: [
      [1, 0, 0, 0], // ii7 → III7 → vi7 → v7・I7
      [0, 1, 0, 0], // IVM7 → iii7 → vi7 → v7・I7
      [0, 0, 0, 1], // 最後の I7 を長く鳴らす
      [1, 1, 0, 1], // ダイアトニック寄りに柔らかくする
    ],
  },
  {
    id: 'minor-pedal',
    name: '短調ペダル・リフ',
    feel: '主音を保ったままリフで押す',
    tonality: 'minor',
    slots: [
      [['i']],
      [['i'], ['VII']],
      [['i'], ['VI'], ['VI', 'VII']],
      [['i'], ['VII', 'i'], ['V7m'], ['iv', 'V7m']],
    ],
    // ペダルはベース声部で担い、和声まで全小節iへ固定しない。後半でVI→V7としてAへ戻す。
    defaultChoice: [0, 0, 1, 2],
    variations: [
      [0, 0, 0, 2], // V7 で次の i を強く呼ぶ（1小節1コード）
      [0, 1, 0, 2], // 一度だけ VII、末尾は V7
      [0, 0, 2, 2], // VI・VII だけを半小節化し、末尾は V7
      [0, 1, 2, 1], // 中盤の VI・VII と終止の VII・i で加速
      [0, 1, 1, 2], // VII と VI を使うが、和声リズムは拡大しない
    ],
  },
  {
    id: 'minor-incantation',
    name: '呪文ループ',
    feel: '妖しい浮遊感・半音下行',
    tonality: 'minor',
    // i7–V7–♭VII–IV7。上声部の最短連結が主音→導音→♭7→♮6の半音下行クリシェを描く。
    // 5度(V7/v7)と4度(IV7/iv7)を選択制にし、和声的短音階⇔自然短音階⇔ドリアンの
    // 陰影をスロットで切り替える。終端は意図してドミナントを持たずIVから頭のiへ回帰する。
    slots: [
      [['i7'], ['i']],
      [['V7m'], ['v7']],
      [['VII']],
      [['IV7m'], ['iv7']],
    ],
    defaultChoice: [0, 0, 0, 0],
    variations: [
      [0, 1, 0, 0], // 5度を自然短音階のv7へ（導音を外して陰らせる）
      [0, 0, 0, 1], // IVをiv7へ（ドリアンを解いて回帰を柔らげる）
      [1, 0, 0, 0], // 頭を三和音のiへ（リフ寄りの提示）
      [0, 1, 0, 1], // 全面的に自然短音階へ寄せる
    ],
  },
  {
    id: 'relative-orbit',
    name: 'vi軌道ループ',
    feel: '寂しげだが開ける・00年代ネトゲ',
    tonality: 'major',
    // 平行短調の主和音(vi)から出発し、長調の機能衛星(IV→I→V)を巡回して開ける。
    // 「短調ではなく、長調のviを第二の主音として往復する」のが寂しげ×開放感の正体
    // (ESTi系実測: 四千年はBm(vi)開始→Em→A→D(I)の衛星軌道)。
    realizations: {
      // 相対短調読みでは i を出発点にした i→VI→III→VII の巡回になる。
      minor: {
        slots: [
          [['i'], ['i7']],
          [['VI'], ['VImaj7'], ['iiDim']],
          [['III'], ['v7'], ['III', 'VII']],
          [['VII'], ['VI', 'VII'], ['V7m']],
        ],
      },
    },
    slots: [
      [['vi'], ['vi7']],
      [['IV'], ['IVM7'], ['ii7']],
      [['I'], ['iii7'], ['I', 'V']],
      [['V'], ['IV', 'V'], ['iii7', 'vi7']],
    ],
    defaultChoice: [0, 0, 0, 0],
    variations: [
      [1, 1, 0, 0], // vi7 → IVM7 → I → V（カラートーンで浮かせる）
      [0, 2, 1, 0], // vi → ii7 → iii7 → V（上行の衛星巡回）
      [1, 0, 2, 1], // vi7 → IV → I・V → IV・V（和声リズムで押す）
      [0, 1, 0, 2], // vi → IVM7 → I → iii7・vi7（viへ回帰して閉じる）
    ],
  },
  {
    id: 'minor-drive',
    name: '短調ドライブ',
    feel: '暗い疾走・回帰感',
    tonality: 'minor',
    slots: [
      [['i']],
      [['VI'], ['iv'], ['VI', 'VII']],
      [['III'], ['VII'], ['iv', 'V7m']],
      [['VII'], ['V7m'], ['v'], ['VII', 'V7m']],
    ],
    defaultChoice: [0, 0, 0, 0],
    variations: [
      [0, 1, 0, 0], // i → iv → III → VII
      [0, 0, 1, 3], // i → VI → VII → VII・V7
      [0, 0, 0, 1], // V7 で強く戻る
      [0, 1, 1, 2], // 教会旋法寄りの v
      [0, 2, 2, 3], // VI・VII → iv・V7 → VII・V7
    ],
  },
];

const progressionRealizationCache = new WeakMap<
  ProgressionDef,
  Map<ProgressionTonality, ProgressionDef>
>();

/** 進行IDを保ったまま、指定調性用のローマ数字実体へ解決する。 */
export function progressionForTonality(
  progression: ProgressionDef,
  tonality: ProgressionTonality,
): ProgressionDef | null {
  if (progression.tonality === tonality) return progression;
  const override = progression.realizations?.[tonality];
  if (!override) return null;

  let byTonality = progressionRealizationCache.get(progression);
  if (!byTonality) {
    byTonality = new Map();
    progressionRealizationCache.set(progression, byTonality);
  }
  const cached = byTonality.get(tonality);
  if (cached) return cached;

  const realized: ProgressionDef = {
    ...progression,
    tonality,
    slots: override.slots,
    defaultChoice: override.defaultChoice ?? progression.defaultChoice,
    variations: override.variations ?? progression.variations,
  };
  byTonality.set(tonality, realized);
  return realized;
}

export function progressionsForTonality(tonality: ProgressionTonality): ProgressionDef[] {
  return PROGRESSIONS.flatMap((progression) => {
    const realized = progressionForTonality(progression, tonality);
    return realized ? [realized] : [];
  });
}

/**
 * コードスケール（一般法則）: キーの音階を、鳴っているコードの変位音で局所的に
 * 上書きした音組織。変位音が押しのけた音階音（コード構成上の同じ度数に当たる隣接音）を
 * 特定して置換する。例: 短調のV7の導音は♭7を、IV7のドリアン♮6は♭6を置き換える。
 * これにより弱拍の経過音がその小節のコードトーンと短9度でぶつからない。
 */
export function chordScalePcs(
  scalePcs: readonly number[],
  chordPcs: readonly number[],
  chordRootPc: number,
): number[] {
  // コード構成音としての度数ファミリー。変位音は同じファミリーの音階音を置換する。
  const memberFamily = (interval: number): number => {
    if (interval === 0) return 0;
    if (interval <= 2) return 1; // 2度・9度
    if (interval <= 4) return 2; // 3度
    if (interval === 5) return 3; // 4度・11度
    if (interval <= 8) return 4; // 減5度・完全5度・増5度
    return 5; // 6度・7度
  };
  const intervalFromRoot = (pc: number): number => ((pc - chordRootPc) % 12 + 12) % 12;
  const result = new Set(scalePcs);
  for (const tone of chordPcs) {
    if (result.has(tone)) continue;
    const family = memberFamily(intervalFromRoot(tone));
    const candidates = [(tone + 1) % 12, (tone + 11) % 12]
      .filter((pc) => scalePcs.includes(pc) && !chordPcs.includes(pc));
    const displaced = candidates.find((pc) => memberFamily(intervalFromRoot(pc)) === family)
      ?? candidates[0];
    if (displaced !== undefined) result.delete(displaced);
    result.add(tone);
  }
  return [...result].sort((a, b) => a - b);
}

export interface StyleDef {
  id: string;
  name: string;
  feel: string;
  /**
   * スタイル既定のテンポ(BPM)。ジャンルはパターン単体でなく「パターン×テンポ×
   * グルーヴ」の結合で成立するため、UIのスタイル切替はこの値へ追従する。
   * compose自体は常にopts.bpmを使うので、保存済みの曲には影響しない。
   */
  defaultBpm: number;
  /** スタイル既定のグルーヴ。省略=straight。UIのスタイル切替が追従する。 */
  defaultGroove?: GrooveFeel;
  /**
   * 16 分グリッドの発音強度。値は 0=休符 / 1=通常打 / 中間値=ゴースト(DRUM_GHOST、
   * ベロシティとして鳴る)。長さは 16 の倍数: 16=1小節ループ、32=2小節フレーズ
   * (ブレイクビーツ系の小節間変化)。声部ごとに長さが違ってよく、小節をまたぐ参照は
   * drumPatternStep() が折り返す。
   */
  kick: readonly number[];
  snare: readonly number[];
  hat: readonly number[];
  /** 16 小節曲の B セクション用。バックビート(強度1のスネア位置)は保ち、密度やシンコペーションだけを変える。 */
  sectionB: {
    kick: readonly number[];
    snare: readonly number[];
    hat: readonly number[];
  };
  /**
   * ベースの様式軸(compose.tsのベース生成が分岐する):
   * - octave8 / root8 / rootFifth: 8分・4分の刻み系(従来)。
   * - sustain: コードイベントごとの持続低音。倍速ドラムに対する低音の持続
   *   (速度対比)が様式の核であるブレイクビーツ系(DnB)用。
   * - kickSync: その小節で実際に鳴るキック骨格(A/B/ブレイクダウン)に同置し、
   *   各キックの8分裏で応答するシンコペ。低域でキックとベースが一体化する
   *   UKガラージ系用。実音列は列挙せず、キック譜から毎回導出する。
   */
  bass: 'octave8' | 'root8' | 'rootFifth' | 'sustain' | 'kickSync';
  /** 主旋律の8分グリッド上の語彙。拍節の違いを音色だけでなく作曲へ反映する。 */
  melody: {
    /** step 0..7 の発音しやすさ。0・4は生成側で必ず強拍として残す。 */
    onsetWeights: readonly number[];
    /** 1小節の音数範囲。 */
    density: readonly [number, number];
    /** 音価に対するゲート比。短いほど歯切れがよい。 */
    gate: number;
    /** 弱拍で順次進行を選ぶ確率。 */
    stepwisePercent: number;
  };
  /** フレーズ終端で次コードへ接続するベースの作法。 */
  bassCadence: 'chromatic' | 'chordTone' | 'diatonicPickup';
  /** スタイル既定のテンション方針(tension.ts)。省略はoff=素の和音。 */
  tension?: 'soft' | 'lush';
  /** スタイル既定のディミニューション密度(diminution.ts)。省略はoff。 */
  diminution?: 'light' | 'rich';
  /** スタイル既定のハモリ(平行下3度、duet.ts)。省略はoff。 */
  duet?: DuetPolicy;
  /** スタイル既定のスライド(ポルタメント)指示(glide.ts)。省略はoff。 */
  glide?: GlidePolicy;
  /** スタイル既定のベースライン生成(bassline.ts、分数コード)。省略はoff。 */
  bassLine?: BassLinePolicy;
}

export const STYLES: StyleDef[] = [
  {
    id: 'eurobeat',
    name: 'ユーロビート',
    feel: '疾走・パチスロ王道',
    defaultBpm: 170, // 従来のUI既定を継承(パチスロの疾走文脈)。
    kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
    sectionB: {
      kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0],
      snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
      hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    },
    bass: 'octave8',
    melody: {
      onsetWeights: [100, 72, 38, 76, 100, 68, 42, 78],
      density: [5, 6],
      gate: 0.78,
      stepwisePercent: 72,
    },
    bassCadence: 'chromatic',
  },
  {
    id: 'rock',
    name: 'ロックファンファーレ',
    feel: '熱い・獣王系',
    defaultBpm: 170, // 従来のUI既定を継承(未実測)。
    kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    sectionB: {
      kick: [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0],
      snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
      hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    },
    bass: 'root8',
    melody: {
      onsetWeights: [100, 24, 82, 28, 100, 22, 78, 34],
      density: [4, 5],
      gate: 0.9,
      stepwisePercent: 62,
    },
    bassCadence: 'chordTone',
  },
  {
    id: 'kmmo',
    name: '韓国MMO風',
    feel: '寂しげ×疾走・00年代ネトゲ',
    defaultBpm: 100, // ESTi系実測BPM96-103(下のコメント)の中央値。
    // 中庸テンポの8ビート+16分ハットの推進。疾走感はBPMでなく細分密度で作る
    // (ESTi系実測: BPM96-103で音符の6割超が16分)。
    kick: [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1],
    sectionB: {
      kick: [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0],
      snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
      hat: [1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0],
    },
    bass: 'root8',
    melody: {
      // 表裏の重みを平滑にし、ラン(ディミニューション)が均等に流れる下地を作る。
      onsetWeights: [100, 64, 58, 70, 100, 62, 60, 74],
      density: [5, 6],
      gate: 0.7,
      // 実測の旋律語彙は+2/+3セルの順次優勢(P4/P5は彩り)。
      stepwisePercent: 80,
    },
    bassCadence: 'diatonicPickup',
    tension: 'lush',
    diminution: 'rich',
    // 様式仮説(未検証): 四千年系の3度ハモリ+スライド。測定物のコミットを経るまで
    // 「実測由来」とは呼ばない(duet.ts / glide.ts の注記を参照)。
    duet: 'on',
    glide: 'on',
  },
  {
    id: 'ska',
    name: 'スカ',
    feel: '陽気・コミカル',
    defaultBpm: 170, // 従来のUI既定を継承(未実測)。
    kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
    sectionB: {
      kick: [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0],
      snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
      hat: [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1],
    },
    bass: 'rootFifth',
    melody: {
      onsetWeights: [100, 82, 30, 88, 100, 84, 34, 90],
      density: [5, 6],
      gate: 0.58,
      stepwisePercent: 78,
    },
    bassCadence: 'diatonicPickup',
  },
  {
    id: 'garage2step',
    name: '2ステップ',
    feel: '跳ねる16分・UKガラージ',
    // UKガラージの常用域(130-135)の中央。シャッフルした16分は様式の核なので
    // 既定グルーヴで有効にする(スナップショット検証も同じ組で行う)。
    defaultBpm: 132,
    defaultGroove: 'shuffle16',
    // 2小節フレーズ(32ステップ)。骨格は「4つ打ちから3拍目のキックを抜く」変則:
    // 1小節目=1拍目+3拍裏、2小節目=1拍目+3拍目直前の16分押し込み(s7)。
    // シャッフル16分グルーヴと合わせると16分位置(s7・ゴースト)だけが跳ねる。
    kick: [
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0,
      1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0,
    ],
    // バックビート(2・4拍=強度1)は2小節とも不変、ゴーストの位置だけが小節間で変わる。
    snare: [
      0, 0, 0, 0, 1, 0, 0, 0, 0, 0, DRUM_GHOST, 0, 1, 0, 0, 0,
      0, 0, 0, 0, 1, 0, 0, DRUM_GHOST, 0, 0, 0, 0, 1, 0, 0, DRUM_GHOST,
    ],
    // 裏打ち8分+拍4裏の16分足し。16分(s7,s15)がシャッフルの跳ねを聴かせる。
    hat: [0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1],
    sectionB: {
      // Bは4つ打ちへ寄せて持ち上げる(ガラージのハウス的側面)。スネアはAと同一。
      kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      snare: [
        0, 0, 0, 0, 1, 0, 0, 0, 0, 0, DRUM_GHOST, 0, 1, 0, 0, 0,
        0, 0, 0, 0, 1, 0, 0, DRUM_GHOST, 0, 0, 0, 0, 1, 0, 0, DRUM_GHOST,
      ],
      hat: [0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0],
    },
    // ベースはキック骨格と同置+8分裏の応答(kickSync)。低域の一体化が様式。
    bass: 'kickSync',
    melody: {
      // 裏拍(2拍裏・4拍裏)を押すシンコペーション優位の語彙。
      onsetWeights: [100, 55, 40, 90, 100, 50, 45, 92],
      density: [4, 6],
      gate: 0.6,
      stepwisePercent: 68,
    },
    bassCadence: 'chordTone',
    // UKガラージの7th/9thボイシングをソフトテンションで近似する。
    tension: 'soft',
  },
  {
    id: 'dnb',
    name: 'ドラムンベース',
    feel: '疾走ブレイクビーツ(BPM170前後)',
    // DnBの常用域(170-178)の代表値(スナップショット検証も同値)。
    defaultBpm: 174,
    // ツーステップ・ブレイクの骨格: キックは1拍目+3拍裏の1小節ループ。
    kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
    // 主打(2・4拍=強度1)は不変のまま、ゴーストの位置が2小節で入れ替わり
    // ブレイクビーツの転がる感じを作る(32ステップ)。
    snare: [
      0, 0, 0, 0, 1, 0, 0, DRUM_GHOST, 0, 0, 0, 0, 1, 0, 0, 0,
      0, 0, 0, 0, 1, 0, 0, 0, 0, DRUM_GHOST, 0, 0, 1, 0, 0, DRUM_GHOST,
    ],
    // 拍頭に16分ペアを置くチョップ気味の刻み。
    hat: [1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0],
    sectionB: {
      // Bは2小節目にキックの追い打ちを足して前進させる。スネアはAと同一。
      kick: [
        1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0,
        1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0,
      ],
      snare: [
        0, 0, 0, 0, 1, 0, 0, DRUM_GHOST, 0, 0, 0, 0, 1, 0, 0, 0,
        0, 0, 0, 0, 1, 0, 0, 0, 0, DRUM_GHOST, 0, 0, 1, 0, 0, DRUM_GHOST,
      ],
      hat: [1, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1, 0, 1, 0, 1, 1],
    },
    // 倍速ドラムの下で低音は持続(sustain)。melodyの速度対比と同じ原則をベースへも適用。
    bass: 'sustain',
    melody: {
      // 速いテンポの上に長い音価で歌うパッド/リード型(ドラムとの速度対比が様式)。
      onsetWeights: [100, 30, 55, 45, 100, 35, 60, 50],
      density: [3, 5],
      gate: 0.92,
      stepwisePercent: 60,
    },
    bassCadence: 'chordTone',
    // アトモスフェリックなカラートーン和声(リキッド系)をlushで近似する。
    tension: 'lush',
  },
];

/**
 * ドラムパターン配列から「小節barのステップstep」の強度を取る。
 * 長さ16は毎小節同じ、32は2小節フレーズとして折り返す(声部ごとに長さが違ってよい)。
 */
export function drumPatternStep(pattern: readonly number[], bar: number, step: number): number {
  return pattern[(bar * 16 + step) % pattern.length] ?? 0;
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11] as const;
export const NATURAL_MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10] as const;
/** 陽旋法寄りの五音音階。強拍のコードトーンと組み合わせ、和風の節回しに使う。 */
export const YO_SCALE = [0, 2, 5, 7, 9] as const;
/**
 * 無半音五音音階(anhemitonic pentatonic)。完全五度を4回積む {0,7,2,9,4} が
 * 「半音間隔を一つも含まない最大の音集合」で、その長旋法回転が長五音、
 * 短三度始まりの回転(相対短)が短五音。文化圏固有の様式(和風の核音・間)とは
 * 独立した、機能和声の上でも使える旋律語彙として置く(ESTi系実測: 四千年の
 * 旋律pc上位5音=Dメジャーペンタで54%、隣接2/3半音セルの上行が最頻)。
 */
export const MAJOR_PENTATONIC_SCALE = [0, 2, 4, 7, 9] as const;
export const MINOR_PENTATONIC_SCALE = [0, 3, 5, 7, 10] as const;

/**
 * 選べるキー(全12)。表記はNOTE_NAMESから導出し、和音チップ・音名表示
 * (chordName/noteName)と必ず同じ綴りになるようにする。キーに応じた
 * 異名同音の選択(D♭ vs C#等)は表示側の将来課題。
 */
export const KEYS: readonly { root: number; label: string }[] =
  NOTE_NAMES.map((label, root) => ({ root, label }));

/**
 * 声部のテッシトゥーラ(単一ソース)。生成(compose)と検査(diagnostics)が同じ値を
 * 参照する。主旋律 C5..E6、副旋律はその1オクターブ下。
 */
export const MELODY_LO = 72;
export const MELODY_HI = 88;
export const COUNTER_LO = 60;
export const COUNTER_HI = 76;

/** トークン + キー → 表示名（例: 'IVM7', キー C → 'FM7'） */
export function chordName(token: string, keyRoot: number): string {
  const def = CHORDS[token];
  if (!def) return token;
  return NOTE_NAMES[(def.root + keyRoot) % 12]! + def.quality;
}

/** MIDI ノート番号 → 表示名（例: 76 → 'E5'） */
export function noteName(midi: number): string {
  return `${NOTE_NAMES[midi % 12]!}${Math.floor(midi / 12) - 1}`;
}
