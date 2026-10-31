/**
 * 旋律語法(MelodicLanguage)の戦略オブジェクト。
 *
 * 語法は「音組織」だけでなく、強拍の着地規則・終止目標・開放五度ボイシング・装置の抑制・
 * 「間」や弱起の有無・ベース終止の作法・イントロの間合いなど、多数の判断を伴う。以前は
 * これらが `melodicLanguage === 'japanese'` 型の文字列比較として compose / phrase-plan /
 * intro / bass-voice / song-plan / options に36箇所散らばり、六音語法の追加で同じ規則
 * (「和音∩語法が2音以上なら語法内へ」)が compose と phrase-plan に二重実装された。
 *
 * ここでは各語法を宣言(フラグ)と小さな関数の束として1箇所に置き、各分岐はこの
 * オブジェクトのフィールドを参照するだけにする。保存JSON・UIの識別子は従来どおり
 * MelodicLanguage の文字列で、`idiomFor()` が引く。
 *
 * 既存曲の互換: 各フィールドの値は置き換え前の分岐と1対1に対応し、生成結果は不変。
 */

import { japanesePlanFor } from './japanese.js';
import { maxAdjacentScaleInterval } from './pitch.js';
import {
  MAJOR_HEXATONIC_SCALE, MAJOR_PENTATONIC_SCALE, MAJOR_SCALE, MINOR_HEXATONIC_SCALE,
  MINOR_PENTATONIC_SCALE, NATURAL_MINOR_SCALE, YO_SCALE,
} from './theory.js';
import type {
  JapanesePlan, JapaneseScaleChoice, MelodicLanguage, MelodyMode, Tonality,
} from './types.js';

export interface MelodicIdiom {
  id: MelodicLanguage;
  /** UI・保存曲一覧の表示名。 */
  label: string;
  /**
   * 調性ごとの音組織(主音からの半音)。文化様式の計画(culturalPlan)を持つ語法では
   * その scalePcs が優先され、ここは参照されない。
   */
  scaleIntervals(tonality: Tonality): readonly number[];
  /**
   * 核音・間の体系を持つ文化様式の計画。和風だけが非nullを返し、音組織はシードから
   * 3様式を選ぶ(japaneseScale が 'auto' のとき)。
   */
  culturalPlan(keyRoot: number, scaleChoice: JapaneseScaleChoice | undefined, seed: number): JapanesePlan | null;
  /** 文化様式の音組織の選択肢(japaneseScale)を持つか。保存JSONの正規化とUIが参照する。 */
  hasScaleChoice: boolean;
  /**
   * 弱拍・経過音の音組織を小節のコードスケール(変位音でキーの音階を上書きした音組織)に
   * 追従させるか。五音系・和風は旋律語彙が固定で、変位和音への追従は強拍規則が担う。
   */
  followsChordScale: boolean;
  /**
   * 強拍の着地候補・終止の目標音(compose の melodyPcsForChord と phrase-plan の終止目標が
   * 共有する単一の規則)。和音構成音のうち語法内にある音(modal)をどこまで優先するか:
   * 標準・五音は和音全体、和風は共通音が1音でもあれば共通音、六音は2音以上残るときだけ
   * 共通音(1音まで痩せると旋律線が止まる)。
   */
  landingPcs(chordPcs: readonly number[], scalePcs: readonly number[]): readonly number[];
  /** 伴奏ボイシングから3度・7度を抜き、根音-五度-根音の開いた配置にする(和風)。 */
  openFifthsVoicing: boolean;
  /** テンション・ディミニューション・ハモリ・スライド・ベースラインの装置を常にoffへ落とす。 */
  suppressesDevices: boolean;
  /** 装飾計画: dense=4小節ごと(grace/shake/turn)、sparse=16小節に0〜1個(grace/turn)。 */
  ornamentDensity: 'sparse' | 'dense';
  /** 答句に意図した空白「間」を置く。 */
  usesMa: boolean;
  /** 強拍倚音を許す(和風は核音・間の体系と衝突するため不可)。 */
  allowsAppoggiatura: boolean;
  /** 弱起(アウフタクト)を許す(和風は「間」の候補 step7 と衝突するため不可)。 */
  allowsAnacrusis: boolean;
  /** ベース終止で様式の作法(半音接近・和声音接近)を使う。不可なら全音階の経過音へ落ちる。 */
  allowsStyledBassCadence: boolean;
  /** 音組織上の「隣」とみなす最大半音数。 */
  scaleStepMax(scalePcs: readonly number[]): number;
  /** イントロ役割の候補に主題予告型(motif)を常に含める。 */
  introPrefersMotif: boolean;
  /** 主題予告型イントロが末尾に空ける拍数(息の長い「間」を取る語法は長い)。 */
  motifIntroBreakBeats: number;
  /** Pieceの旧フィールド melodyMode への互換写像。null は調性名をそのまま使う。 */
  legacyMelodyMode: MelodyMode | null;
}

const majorMinor = (major: readonly number[], minor: readonly number[]) =>
  (tonality: Tonality): readonly number[] => (tonality === 'minor' ? minor : major);

const chordTones = (chordPcs: readonly number[]): readonly number[] => chordPcs;

/** 和音構成音のうち語法内の音。minModal 音以上残るときだけ絞り、足りなければ和音全体。 */
const modalLanding = (minModal: number) =>
  (chordPcs: readonly number[], scalePcs: readonly number[]): readonly number[] => {
    const modal = chordPcs.filter((pc) => scalePcs.includes(pc));
    return modal.length >= minModal ? modal : chordPcs;
  };

/** 語法に依存しない既定(標準語法の値)。各語法は違う所だけ上書きする。 */
const DEFAULTS: Omit<MelodicIdiom, 'id' | 'label' | 'scaleIntervals'> = {
  culturalPlan: () => null,
  hasScaleChoice: false,
  followsChordScale: false,
  landingPcs: chordTones,
  openFifthsVoicing: false,
  suppressesDevices: false,
  ornamentDensity: 'sparse',
  usesMa: false,
  allowsAppoggiatura: true,
  allowsAnacrusis: true,
  allowsStyledBassCadence: true,
  // 五音系は隣接音級の最大間隔から導出する(無半音五音=3)。
  scaleStepMax: maxAdjacentScaleInterval,
  introPrefersMotif: false,
  motifIntroBreakBeats: 0.5,
  legacyMelodyMode: null,
};

export const MELODIC_IDIOMS: Record<MelodicLanguage, MelodicIdiom> = {
  standard: {
    ...DEFAULTS,
    id: 'standard',
    label: '標準',
    scaleIntervals: majorMinor(MAJOR_SCALE, NATURAL_MINOR_SCALE),
    followsChordScale: true,
    // 標準=2(全音)。音組織が全音階なので導出でなく固定。
    scaleStepMax: () => 2,
  },
  japanese: {
    ...DEFAULTS,
    id: 'japanese',
    label: '和風五音',
    scaleIntervals: () => YO_SCALE,
    culturalPlan: (keyRoot, scaleChoice, seed) => japanesePlanFor(keyRoot, scaleChoice ?? 'auto', seed),
    hasScaleChoice: true,
    landingPcs: modalLanding(1),
    openFifthsVoicing: true,
    suppressesDevices: true,
    ornamentDensity: 'dense',
    usesMa: true,
    allowsAppoggiatura: false,
    allowsAnacrusis: false,
    allowsStyledBassCadence: false,
    // 既存挙動の4を保存(都節の1↔5枠を跨ぐ揺りを順次扱いにしてきた歴史的経緯)。
    scaleStepMax: () => 4,
    introPrefersMotif: true,
    motifIntroBreakBeats: 1.5,
    legacyMelodyMode: 'japanese',
  },
  pentatonic: {
    ...DEFAULTS,
    id: 'pentatonic',
    label: '五音ペンタ',
    scaleIntervals: majorMinor(MAJOR_PENTATONIC_SCALE, MINOR_PENTATONIC_SCALE),
    // 保存曲の互換のため従来どおり和音全体へ着地する。
  },
  hexatonic: {
    ...DEFAULTS,
    id: 'hexatonic',
    label: '六音(五音+導音)',
    scaleIntervals: majorMinor(MAJOR_HEXATONIC_SCALE, MINOR_HEXATONIC_SCALE),
    // 語法の外にある和音構成音(長調なら IV 系の根音=第4音)を強拍の着地候補から外す。
    landingPcs: modalLanding(2),
  },
};

export const MELODIC_LANGUAGES = Object.keys(MELODIC_IDIOMS) as readonly MelodicLanguage[];

/** 省略時・保存JSONで省かれる語法。UIの初期値と保存の正規化(options.ts)が参照する。 */
export const DEFAULT_MELODIC_LANGUAGE: MelodicLanguage = 'standard';

export const isMelodicLanguage = (value: unknown): value is MelodicLanguage =>
  typeof value === 'string' && value in MELODIC_IDIOMS;

export function idiomFor(language: MelodicLanguage): MelodicIdiom {
  return MELODIC_IDIOMS[language];
}
