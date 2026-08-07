/**
 * 舞台モデル: ミックスをGibsonの3D(横=パン、縦=音域、奥=深度)として扱う。
 * 縦(音域)は編曲層の責務なので持たず、ここは横(pan)と奥(depth)と横幅(width)だけを持つ。
 *
 * 反パッチワーク原則: リバーブ送り量・プリディレイ・高域減衰・直接音の減衰は
 * 独立の係数として列挙せず、**深度から導出**する。「深いほど、遅れて届き、
 * こもって、直接音が減る」のは部屋の物理であって個別のツマミではない。
 * スタイルは「部屋(RoomModel)」を選ぶ: 部屋がRT60と導出則を決める。
 */

export interface StereoWave {
  left: Float32Array;
  right: Float32Array;
}

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
export const ROLE_STAGE: Record<string, StagePosition> = {
  lead: { pan: 0, depth: 0.35, width: 0.15 },
  duet: { pan: -0.18, depth: 0.42, width: 0.25 },
  counter: { pan: 0.42, depth: 0.45, width: 0.4 },
  ostinato: { pan: -0.42, depth: 0.3, width: 0.45 },
  backing: { pan: 0.12, depth: 0.75, width: 0.9 },
  bass: { pan: 0, depth: 0.08, width: 0 },
  drums: { pan: 0, depth: 0.22, width: 0 },
};

/**
 * 部屋モデル。スタイルごとの空間はこの導出則の束で、個別センドの列挙はしない。
 * kmmoは四千年の実測RT60≈2.85sに合わせたディープホール。
 */
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
  /** ピンポンディレイのフィードバック(harakami則: これがダイナミクスを決める)。 */
  delayFeedback: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * Math.max(0, Math.min(1, t));

function room(overrides: Partial<RoomModel> & Pick<RoomModel, 'rt60Sec'>): RoomModel {
  return {
    sendAt: (depth) => 0.55 * depth ** 1.4,
    preDelayMsAt: (depth) => lerp(38, 8, depth),
    dampHzAt: (depth) => lerp(11000, 3200, depth),
    dryAt: (depth) => lerp(1, 0.78, depth),
    duckAmount: 0.35,
    delayFeedback: 0.45,
    ...overrides,
  };
}

export const DEFAULT_ROOM: RoomModel = room({ rt60Sec: 1.3 });

export const STYLE_ROOMS: Record<string, RoomModel> = {
  // 実測(四千年: 曲中の切れ目20箇所のRT60中央値≈2.85s)のディープホール。
  // 送りは深め、ダッキングも深め=密集する16分では引っ込み、ロングトーンで開花する。
  kmmo: room({ rt60Sec: 2.85, sendAt: (depth) => 0.7 * depth ** 1.3, duckAmount: 0.45, delayFeedback: 0.5 }),
  rock: room({ rt60Sec: 0.9, sendAt: (depth) => 0.4 * depth ** 1.6, duckAmount: 0.25, delayFeedback: 0.35 }),
  eurobeat: room({ rt60Sec: 1.4 }),
  ska: room({ rt60Sec: 1.1 }),
};

export function roomFor(styleId: string): RoomModel {
  return STYLE_ROOMS[styleId] ?? DEFAULT_ROOM;
}

/** 等パワーパン。 */
export function panGains(pan: number): [number, number] {
  const angle = (Math.max(-1, Math.min(1, pan)) + 1) * (Math.PI / 4);
  return [Math.cos(angle), Math.sin(angle)];
}
