/**
 * サウンドテスト用の最小音楽理論データ層。
 * - コードは「キー主音からの相対ピッチクラス集合」で持つ（キー変更 = 平行移動のみ）
 * - 進行は固定列ではなく「小節スロット + 選択肢」で持つ。同じ機能の代理和音を
 *   選択制にすることで、1 エントリから破綻しない進行を組み合わせ的に生成できる
 * - メロディ検証はローマ数字表ではなく実コードの音集合で行う（セカンダリー
 *   ドミナント等のキー外の音も「正解」にするため。III7 の G# など）
 */

export interface ChordDef {
  /** キー主音からの相対ルート（半音） */
  root: number;
  /** 表示用クオリティ（root=5, quality='M7', キー C → FM7） */
  quality: string;
  /** キー主音からの相対ピッチクラス集合 */
  tones: readonly number[];
}

export type HarmonicFunction = 'tonic' | 'predominant' | 'dominant' | 'colour';

export const CHORDS: Record<string, ChordDef> = {
  I: { root: 0, quality: '', tones: [0, 4, 7] },
  ii: { root: 2, quality: 'm', tones: [2, 5, 9] },
  iii: { root: 4, quality: 'm', tones: [4, 7, 11] },
  IV: { root: 5, quality: '', tones: [5, 9, 0] },
  V: { root: 7, quality: '', tones: [7, 11, 2] },
  vi: { root: 9, quality: 'm', tones: [9, 0, 4] },
  IVM7: { root: 5, quality: 'M7', tones: [5, 9, 0, 4] },
  III7: { root: 4, quality: '7', tones: [4, 8, 11, 2] },
  ii7: { root: 2, quality: 'm7', tones: [2, 5, 9, 0] },
  iii7: { root: 4, quality: 'm7', tones: [4, 7, 11, 2] },
  vi7: { root: 9, quality: 'm7', tones: [9, 0, 4, 7] },
  v7: { root: 7, quality: 'm7', tones: [7, 10, 2, 5] },
  I7: { root: 0, quality: '7', tones: [0, 4, 7, 10] },
  // 短調。大文字/小文字は主音から見た機能を明示し、keyRoot は常に主音として扱う。
  i: { root: 0, quality: 'm', tones: [0, 3, 7] },
  iiDim: { root: 2, quality: 'dim', tones: [2, 5, 8] },
  III: { root: 3, quality: '', tones: [3, 7, 10] },
  iv: { root: 5, quality: 'm', tones: [5, 8, 0] },
  v: { root: 7, quality: 'm', tones: [7, 10, 2] },
  V7m: { root: 7, quality: '7', tones: [7, 11, 2, 5] },
  VI: { root: 8, quality: '', tones: [8, 0, 3] },
  VII: { root: 10, quality: '', tones: [10, 2, 5] },
};

/** ローマ数字トークンを、フォーム設計で使う大まかな和声機能へ写す。 */
export function harmonicFunctionForToken(token: string): HarmonicFunction {
  if (['I', 'vi', 'vi7', 'iii', 'iii7', 'i', 'III'].includes(token)) return 'tonic';
  if (['IV', 'IVM7', 'ii', 'ii7', 'iv', 'iiDim', 'VI'].includes(token)) return 'predominant';
  if (['V', 'III7', 'I7', 'V7m', 'v', 'VII'].includes(token)) return 'dominant';
  return 'colour';
}

/** 1 スロット選択肢 = その小節で鳴らすコード列（2 つなら半小節ずつ） */
export type SlotOption = readonly string[];

export interface ProgressionDef {
  id: string;
  name: string;
  feel: string;
  usage: string;
  /** 選択できる調性。和風五音は major カタログを開放五度化して共有する。 */
  tonality: 'major' | 'minor';
  /** slots[小節] = 選択肢の配列 */
  slots: readonly (readonly SlotOption[])[];
  /** 定番の選び方（各小節のスロット index） */
  defaultChoice: readonly number[];
  /** ボタン・自動変化で抽選する、音楽的に確認済みの進行レシピ */
  variations: readonly (readonly number[])[];
}

export const PROGRESSIONS: ProgressionDef[] = [
  {
    id: 'royal-pop',
    name: '王道ポップ',
    feel: '明るく安定',
    usage: 'RB 向き',
    tonality: 'major',
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
    usage: '単発ジングル向き（末尾 I で着地）',
    tonality: 'major',
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
    usage: 'BB 向き',
    tonality: 'major',
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
    usage: 'BPM170 と相性◎',
    tonality: 'major',
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
    usage: 'BB(8小節) 専用',
    tonality: 'major',
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
    usage: 'AT 中/通常時向き',
    tonality: 'major',
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
    usage: '4号機BIG・ゲームボス向き',
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
    id: 'minor-drive',
    name: '短調ドライブ',
    feel: '暗い疾走・回帰感',
    usage: 'BIG・ゲームBGM向き',
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

export interface StyleDef {
  id: string;
  name: string;
  feel: string;
  /** 16 分グリッド（1 小節 16 ステップ）の発音フラグ */
  kick: readonly number[];
  snare: readonly number[];
  hat: readonly number[];
  /** 16 小節曲の B セクション用。バックビートは保ち、密度やシンコペーションだけを変える。 */
  sectionB: {
    kick: readonly number[];
    snare: readonly number[];
    hat: readonly number[];
  };
  bass: 'octave8' | 'root8' | 'rootFifth';
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
}

export const STYLES: StyleDef[] = [
  {
    id: 'eurobeat',
    name: 'ユーロビート',
    feel: '疾走・パチスロ王道',
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
    id: 'ska',
    name: 'スカ',
    feel: '陽気・コミカル',
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
];

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11] as const;
export const NATURAL_MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10] as const;
/** 陽旋法寄りの五音音階。強拍のコードトーンと組み合わせ、和風の節回しに使う。 */
export const YO_SCALE = [0, 2, 5, 7, 9] as const;

/** サウンドテストで選べるキー（明るいメジャーの定番どころ） */
export const KEYS: readonly { root: number; label: string }[] = [
  { root: 0, label: 'C' },
  { root: 2, label: 'D' },
  { root: 4, label: 'E' },
  { root: 5, label: 'F' },
  { root: 7, label: 'G' },
  { root: 9, label: 'A' },
  { root: 10, label: 'B♭' },
];

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
