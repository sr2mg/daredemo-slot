/**
 * 舞台モデル: ミックスをGibsonの3D(横=パン、縦=音域、奥=深度)として扱う。
 * 縦(音域)は編曲層の責務なので持たず、ここは横(pan)と奥(depth)と横幅(width)だけを持つ。
 *
 * 反パッチワーク原則: 部屋はRT60という単一の物理量だけで指定し、送り量・ダッキング量・
 * ディレイ帰還を含む全パラメータをそこから導出する(room関数)。スタイル別の
 * 係数・指数の列挙はしない——スタイルが選ぶのは「部屋の大きさ」だけ。
 */

import { styleLookup } from '../core/music/theory.js';
import type { StyleId } from '../core/music/theory.js';

export interface StereoWave {
  left: Float32Array;
  right: Float32Array;
}

/**
 * ミックス上の役割語彙。舞台位置(ここ)・ディレイ送り(time-layer)・PCMパート
 * (pcm-arrange)・OPLL声部(opll-arrange)が全て同じ語彙を参照する。
 * 役割を増やすときは、この型が各テーブルの網羅を型エラーで強制する。
 */
export type StageRole = 'lead' | 'duet' | 'counter' | 'ostinato' | 'backing' | 'bass' | 'drums';

/** パートの役割ごとの舞台位置。楽器ではなく役割に紐づく(SC-88世代の定番配置)。 */
export interface StagePosition {
  /** 横: -1(左)..0(中央)..1(右)。 */
  pan: number;
  /** 奥: 0=最前(ドライ)..1=最奥。リバーブ系パラメータはここから導出される。 */
  depth: number;
  /** 横幅: 0=点音源..1=コーラス全開。ステレオの広がり(変調)の量。 */
  width: number;
}

/** リード中央・対旋律右・オスティナート左・パッド最奥・ベースとドラム最前の固定ステージ。 */
export const ROLE_STAGE: Record<StageRole, StagePosition> = {
  lead: { pan: 0, depth: 0.35, width: 0.15 },
  duet: { pan: -0.18, depth: 0.42, width: 0.25 },
  counter: { pan: 0.42, depth: 0.45, width: 0.4 },
  ostinato: { pan: -0.42, depth: 0.3, width: 0.45 },
  backing: { pan: 0.12, depth: 0.75, width: 0.9 },
  bass: { pan: 0, depth: 0.08, width: 0 },
  drums: { pan: 0, depth: 0.22, width: 0 },
};

/** 部屋モデル。全フィールドはroom(rt60Sec)がRT60から導出する。 */
export interface RoomModel {
  /** 残響時間(秒)。コムのフィードバックはこの物理量から導出する。 */
  rt60Sec: number;
  /** 深度→リバーブ送り量。 */
  sendAt(depth: number): number;
  /** 深度→プリディレイ(ms)。近い音ほど直接音と尾が分離して明瞭になる。 */
  preDelayMsAt(depth: number): number;
  /** 深度→送り経路の高域カットオフ(Hz)。遠いほどこもる。 */
  dampHzAt(depth: number): number;
  /** 深度→直接音の係数。奥の音は直接音が減る。 */
  dryAt(depth: number): number;
  /** ドライ活動時にウェットを沈める量(0=なし..1)。音の切れ目で尾が開花する。 */
  duckAmount: number;
  /** ピンポンディレイのフィードバック。 */
  delayFeedback: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * Math.max(0, Math.min(1, t));
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * RT60から部屋の全パラメータを導出する。
 * - 送り量: 拡散音場の残響エネルギーはRT60に比例(Sabineの残響理論)するので、
 *   振幅は√RT60に比例させる。係数0.42は旧チューニング(kmmo≈0.70 / rock≈0.40)を
 *   再現するアンカー。深度カーブd^1.4は「奥ほど急に濡れる」遠近の単一則。
 * - ダッキング量・ディレイ帰還: 残響が長い部屋ほど密集部のマスキングが強く、
 *   出し引きを深くする必要がある。RT60の単調写像(アンカー: kmmo≈0.45/0.50)。
 * - プリディレイ・高域減衰・直接音は深度のみの関数(部屋の大きさと独立の遠近則)。
 */
export function room(rt60Sec: number): RoomModel {
  return {
    rt60Sec,
    sendAt: (depth) => 0.42 * Math.sqrt(rt60Sec) * depth ** 1.4,
    preDelayMsAt: (depth) => lerp(38, 8, depth),
    dampHzAt: (depth) => lerp(11000, 3200, depth),
    dryAt: (depth) => lerp(1, 0.78, depth),
    duckAmount: clamp01(0.2 + 0.09 * rt60Sec),
    delayFeedback: clamp01(0.3 + 0.07 * rt60Sec),
  };
}

export const DEFAULT_ROOM: RoomModel = room(1.3);

/**
 * スタイル→部屋の大きさ(RT60秒)。
 * kmmoの2.85sは未検証の参照値: かつて「四千年の実測(切れ目20箇所の中央値)」を
 * 名乗っていたが、測定スクリプトも対象音源も本リポジトリに存在しない。
 * 一次資料での測定を成果物としてコミットするまで、実測とは呼ばない。
 */
export const STYLE_ROOMS: Record<StyleId, RoomModel> = {
  kmmo: room(2.85),
  rock: room(0.9),
  eurobeat: room(1.4),
  ska: room(1.1),
  // クラブ系はドラムの輪郭を立てたいので短め。DnBはパッドを泳がせる分だけ広く。
  garage2step: room(1.0),
  dnb: room(1.6),
};

export function roomFor(styleId: string): RoomModel {
  return styleLookup(STYLE_ROOMS, styleId, DEFAULT_ROOM);
}

/** 等パワーパン。 */
export function panGains(pan: number): [number, number] {
  const angle = (Math.max(-1, Math.min(1, pan)) + 1) * (Math.PI / 4);
  return [Math.cos(angle), Math.sin(angle)];
}
