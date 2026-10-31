/**
 * 様式の音色定義(1様式1レコード)。
 *
 * 以前は OPLL音色(opll-arrange の STYLE_VOICES)・GMプログラム(pcm-arrange の STYLE_PROGRAMS)・
 * ドラムバス(pcm-arrange の STYLE_DRUM_BUS)・部屋(stage の STYLE_ROOMS)の4表に分かれ、
 * 様式を1つ足すのに4ファイルを回る必要があった。ここへ同居させ、各レンダラは引く側になる。
 * Record<StyleId, …> で閉じるので、様式を足して音色を忘れるとコンパイルエラーになる。
 *
 * 部屋は RT60 という単一の物理量だけを持ち、送り量・ダッキング量・ディレイ帰還を含む全
 * パラメータは stage.ts の room() が導出する(スタイル別の係数・指数の列挙はしない)。
 * ドラムバスのパラメータの導出根拠は bus-fx.ts のモジュールコメントを参照。
 */

import { styleLookup } from '../core/music/theory.js';
import type { StyleId } from '../core/music/theory.js';
import type { DrumBusFx } from './bus-fx.js';

/** OPLL(YM2413)の内蔵音色割り当て(0〜15。0はユーザー音色)。 */
export interface StyleVoices {
  lead: number;
  backing: number;
  bass: number;
  counter: number;
  ostinato: number;
  /** バッキングの刻み: offbeat = 裏打ち 8 分 / half = 2 分音符サステイン */
  backingPattern: 'offbeat' | 'half';
  /**
   * 主旋律の音色パレット(セクションのleadColorが添字)。省略時は[lead]=全区間同色。
   * ユーザーが音色を上書きした場合はパレットより上書きが勝つ(全区間固定)。
   */
  leadPalette?: readonly number[];
}

/** PCM(SoundFont)のGMプログラム(0基点)。 */
export interface GmProgramMap {
  /** 主旋律の音色パレット。leadColor(セクションの受け渡し計画)が添字になる。 */
  leadPalette: readonly number[];
  counter: number;
  ostinato: number;
  backing: number;
  bass: number;
  /**
   * パーカッションバンク(bank128)のキットprogram。省略=0(スタンダードキット)。
   * GeneralUser GSの実装キット(8=Room/16=Power/24=Electronic/25=808909/26=Dance)から選ぶ。
   * 未指定フォントでもGM/GS準拠なら同系キットへ解決される。
   */
  drumKit?: number;
}

export interface StyleTimbre {
  opll: StyleVoices;
  pcm: GmProgramMap;
  /** PCMドラムバスの処理鎖(bus-fx.ts)。null は素通し(既存スタイルの音は1サンプルも変わらない)。 */
  drumBus: DrumBusFx | null;
  /** 部屋の大きさ(RT60秒)。 */
  roomRt60Sec: number;
}

export const STYLE_TIMBRES: Record<StyleId, StyleTimbre> = {
  eurobeat: {
    opll: { lead: 4, backing: 8, bass: 8, counter: 3, ostinato: 4, backingPattern: 'offbeat' },
    pcm: { leadPalette: [81, 80], counter: 80, ostinato: 4, backing: 50, bass: 38 },
    drumBus: null,
    roomRt60Sec: 1.4,
  },
  rock: {
    opll: { lead: 4, backing: 15, bass: 8, counter: 3, ostinato: 4, backingPattern: 'half' },
    pcm: { leadPalette: [30, 29], counter: 29, ostinato: 27, backing: 17, bass: 33 },
    drumBus: null,
    roomRt60Sec: 0.9,
  },
  kmmo: {
    // カラートーンを持続和音で聴かせたいので、裏打ちでなくハーフのパッド型。
    // 受け渡しパレット: 看板4(フルート系)→展開1(バイオリン系)→安息3(クラリネット系)。
    opll: {
      lead: 4, backing: 8, bass: 8, counter: 3, ostinato: 4, backingPattern: 'half',
      leadPalette: [4, 1, 3],
    },
    // パレットは四千年型の受け渡し(二胡系→笛→弦)。
    pcm: { leadPalette: [110, 73, 48], counter: 73, ostinato: 46, backing: 48, bass: 33 },
    drumBus: null,
    // 2.85sは未検証の参照値: かつて「四千年の実測(切れ目20箇所の中央値)」を名乗っていたが、
    // 測定スクリプトも対象音源も本リポジトリに存在しない。一次資料での測定を成果物として
    // コミットするまで、実測とは呼ばない。
    roomRt60Sec: 2.85,
  },
  ska: {
    opll: { lead: 4, backing: 8, bass: 8, counter: 3, ostinato: 4, backingPattern: 'offbeat' },
    pcm: { leadPalette: [56, 66], counter: 66, ostinato: 26, backing: 16, bass: 33 },
    drumBus: null,
    roomRt60Sec: 1.1,
  },
  // クラブ系2種: OPLLはリードにシンセ10、ベースにシンセベース13。ガラージはスタブ裏打ち、
  // DnBはパッド持続でドラムとの速度対比を出す。部屋はドラムの輪郭を立てたいので短め
  // (DnBはパッドを泳がせる分だけ広く)。
  garage2step: {
    opll: { lead: 10, backing: 8, bass: 13, counter: 3, ostinato: 4, backingPattern: 'offbeat' },
    // UKガラージ: ボイスリード+EP/オルガンスタブ+シンセベース。キットはハウス系譜のDance。
    pcm: { leadPalette: [85, 80], counter: 54, ostinato: 4, backing: 17, bass: 39, drumKit: 26 },
    // 軽めの3:1バスコンプ+薄いサチュレーション。クラッシュなし
    // (UKGはMPC/DAT世代でジャングルより録り音が綺麗)。
    drumBus: {
      drive: 1.5,
      comp: { thresholdDbBelowPeak: 9, ratio: 3, attackMs: 8, releaseBeats: 0.25 },
      crush: null,
    },
    roomRt60Sec: 1.0,
  },
  dnb: {
    opll: { lead: 10, backing: 8, bass: 13, counter: 3, ostinato: 4, backingPattern: 'half' },
    // ソウレフルなリード+ウォームパッド+サブ寄りシンセベース。
    // キットは加工前提のPower(処理鎖=drumBusでブレイクの質感へ潰す)。
    pcm: { leadPalette: [81, 85], counter: 54, ostinato: 45, backing: 89, bass: 38, drumKit: 16 },
    // 4:1で深く潰し、+6dBドライブ、Akai S950相当(12bit/26.04kHz)のサンプラー質感。
    drumBus: {
      drive: 2,
      comp: { thresholdDbBelowPeak: 9, ratio: 4, attackMs: 8, releaseBeats: 0.25 },
      crush: { bits: 12, sampleRate: 26040 },
    },
    roomRt60Sec: 1.6,
  },
  acoustic: {
    // 歌の代役はフルート4、分散和音と伴奏はギター2、低音はアコースティックベース14、
    // 副旋律はクラリネット5。伴奏は持続(half)で分散和音の邪魔をしない。
    // 受け渡しパレット: 看板4(フルート)→展開6(オーボエ)→安息1(バイオリン)。
    opll: {
      lead: 4, backing: 2, bass: 14, counter: 5, ostinato: 2, backingPattern: 'half',
      leadPalette: [4, 6, 1],
    },
    // 歌の代役は息の音色(パンフルート→フルート→コーラス)、分散和音と低音はナイロン弦ギター
    // (低音はギターの低弦の役)、薄い弦が背景。参照音源の実測ではギターが伴奏エネルギーの
    // ほぼ全て(41%)、弦・その他は6%。
    pcm: { leadPalette: [75, 73, 52], counter: 71, ostinato: 24, backing: 48, bass: 24 },
    // 打楽器なし。ドラムバスを通る音がない。
    drumBus: null,
    // 弾き語りは残響の長い室内(ホール寄り)。参照音源のRT60は未測定で、これは参照値。
    roomRt60Sec: 1.8,
  },
};

/** 保存曲の未知idで鳴らす既定の音色(従来の各表の既定値と同じ)。 */
export const DEFAULT_TIMBRE: StyleTimbre = {
  opll: STYLE_TIMBRES.eurobeat.opll,
  pcm: { leadPalette: [0], counter: 73, ostinato: 46, backing: 48, bass: 33 },
  drumBus: null,
  roomRt60Sec: 1.3,
};

/** スタイルの音色。保存曲の未知idは DEFAULT_TIMBRE。 */
export function timbreFor(styleId: string): StyleTimbre {
  return styleLookup(STYLE_TIMBRES, styleId, DEFAULT_TIMBRE);
}
