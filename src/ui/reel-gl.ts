/**
 * リール 1 本の WebGL 描画（three.js）。
 *
 * 構造は CSS 3D 版と同じで、動きの状態をここには持たない:
 * - 親（App の ReelColumn）がモーターモデル（reel-motor.ts）の軌道を毎フレーム標本化し、
 *   コマ位置を setKoma() で渡す。このモジュールは「そのコマ位置の見た目」を描くだけ。
 * - 停止音や精算のタイミングは App 側の arrivalAt 計算に依存し、描画は関与しない。
 *
 * 見た目のモデル:
 * - リール帯は正 n 角柱（n = コマ数）。各面が 1 コマで、図柄アトラス（印刷層）を貼る。
 *   1 コマの高さを 1 単位とし、カメラは CSS 版の perspective と同じ距離（24 コマ）に置く。
 * - バックライトは実機どおりリール基体に固定された上・中・下段の 3 灯。円筒の内側に点光源として
 *   置き（帯と一緒には回らない）、帯の裏面に届く光量をフラグメントごとに距離とコサインで計算し、
 *   反射凹部の仕切りで段の外へ漏れないよう窓関数を掛ける。半透明の帯はその光を
 *   「紙の弱い拡散透過 + 透光性カラーインクの色付き透過」として前面へ通す。
 *   emissive マップ + UnrealBloomPass は試算の段階で見送った（PR 本文に理由を記す）。
 * - 段ごとの光量は setLamps() で外から変えられる（入賞ライン強調などの演出口）。
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  NoColorSpace,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
} from 'three';
import { SYMBOL_IMAGES } from './symbol-assets.js';

/** 画面に見える段数（上・中・下） */
export const VISIBLE_ROWS = 3;
/** カメラから円筒軸までの距離 [コマ]。CSS 版の perspective: calc(var(--cell-h) * 24) と同じ */
export const CAMERA_DISTANCE = 24;
/** 3 灯の深さ: 帯の内面からどれだけ奥に光源を置くか [コマ] */
export const LAMP_DEPTH = 1.2;
/** 点光源の減衰の基準距離 [コマ]（強度 ∝ 1 / (1 + (d / range)^2)） */
export const LAMP_RANGE = 1.0;
/** 段ごとの光量（上・中・下）。1 が通常点灯 */
export type LampLevels = readonly [number, number, number];
export const LAMPS_ALL_ON: LampLevels = [1, 1, 1];

/**
 * 図柄ごとの透光性（CSS 版の --symbol-transmission を移植）。
 * 白色拡散インクの紙は別途弱く透け、ここは色付きインク部分が自分の色で透ける割合。
 */
export const SYMBOL_TRANSMISSION: Record<string, number> = {
  seven_red: 0.24,
  bar: 0.24,
  bell: 0.18,
  cherry: 0.16,
  melon: 0.15,
  replay: 0.12,
  blank: 0,
};
const DEFAULT_TRANSMISSION = 0.12;

export function symbolTransmission(symbol: string): number {
  return SYMBOL_TRANSMISSION[symbol] ?? DEFAULT_TRANSMISSION;
}

// ---------------------------------------------------------------------------
// 純関数: 円筒の幾何

/** 1 面の角度 [rad] */
export function faceStep(frames: number): number {
  return (2 * Math.PI) / frames;
}

/** 正 n 角柱の外接半径（辺長 = 1 コマ） */
export function drumRadius(frames: number): number {
  return 1 / (2 * Math.sin(Math.PI / frames));
}

/** 正 n 角柱の内接半径（面の中心までの距離。CSS 版の translateZ と同じ量） */
export function drumApothem(frames: number): number {
  return 1 / (2 * Math.tan(Math.PI / frames));
}

/**
 * 面 i の中心角。i が大きい面ほど円筒の上側（+y）に置く。
 * 実機準拠の下流れ: コマ番号が進むと大きい番号の面が上から正面へ降りてくる。
 */
export function faceAngle(face: number, frames: number): number {
  return face * faceStep(frames);
}

/**
 * コマ位置 p のときの円筒の X 軸回転 [rad]。
 * コアの stopPosition は下段なので、正面（中段）には p + 1 の面を合わせる。
 * 回転 φ で面の角度は α - φ になるため、φ = α(p+1)。
 */
export function drumRotation(koma: number, frames: number): number {
  return faceAngle(koma + 1, frames);
}

/** 回転後の面 i の角度（-π..π に正規化。0 が正面、正が上） */
export function faceAngleAfterRotation(face: number, koma: number, frames: number): number {
  const a = faceAngle(face, frames) - drumRotation(koma, frames);
  const twoPi = 2 * Math.PI;
  return ((((a + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
}

// ---------------------------------------------------------------------------
// 純関数: 図柄アトラスの配置

/** アトラスの 1 セル寸法（元素材 640x400 をそのまま納める） */
export const ATLAS_CELL_W = 640;
export const ATLAS_CELL_H = 400;
export const ATLAS_COLS = 2;

export interface AtlasLayout {
  cols: number;
  rows: number;
  width: number;
  height: number;
}

export function atlasLayout(cellCount: number): AtlasLayout {
  const cols = Math.min(ATLAS_COLS, Math.max(1, cellCount));
  const rows = Math.max(1, Math.ceil(cellCount / cols));
  return { cols, rows, width: cols * ATLAS_CELL_W, height: rows * ATLAS_CELL_H };
}

export interface UvRect {
  u0: number;
  u1: number;
  /** 下端（three のテクスチャは v=0 が画像の下） */
  v0: number;
  /** 上端 */
  v1: number;
}

/** セル index の UV 矩形。行 0 がキャンバス上端 = v が最大 */
export function atlasCellUv(index: number, layout: AtlasLayout): UvRect {
  const col = index % layout.cols;
  const row = Math.floor(index / layout.cols);
  return {
    u0: col / layout.cols,
    u1: (col + 1) / layout.cols,
    v1: 1 - row / layout.rows,
    v0: 1 - (row + 1) / layout.rows,
  };
}

// ---------------------------------------------------------------------------
// 純関数: 面ごとの頂点データ

export interface DrumGeometryData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  transmission: Float32Array;
  indices: Uint16Array;
}

/**
 * 面 i を 4 頂点の平面（幅 1、弦長 1）として並べる。幅は mesh.scale.x で窓の縦横比に合わせる。
 * 頂点順: 左下・右下・右上・左上（面のローカルで「上」= 角度が大きい側）
 */
export function buildDrumGeometryData(
  frames: number,
  cellOf: (face: number) => UvRect,
  transmissionOf: (face: number) => number,
): DrumGeometryData {
  const R = drumRadius(frames);
  const half = faceStep(frames) / 2;
  const positions = new Float32Array(frames * 4 * 3);
  const normals = new Float32Array(frames * 4 * 3);
  const uvs = new Float32Array(frames * 4 * 2);
  const transmission = new Float32Array(frames * 4);
  const indices = new Uint16Array(frames * 6);
  for (let i = 0; i < frames; i++) {
    const a = faceAngle(i, frames);
    const lo = a - half;
    const hi = a + half;
    const yLo = R * Math.sin(lo);
    const zLo = R * Math.cos(lo);
    const yHi = R * Math.sin(hi);
    const zHi = R * Math.cos(hi);
    const ny = Math.sin(a);
    const nz = Math.cos(a);
    const uv = cellOf(i);
    const t = transmissionOf(i);
    const corners: [number, number, number, number, number][] = [
      [-0.5, yLo, zLo, uv.u0, uv.v0],
      [0.5, yLo, zLo, uv.u1, uv.v0],
      [0.5, yHi, zHi, uv.u1, uv.v1],
      [-0.5, yHi, zHi, uv.u0, uv.v1],
    ];
    corners.forEach(([x, y, z, u, v], c) => {
      const vi = i * 4 + c;
      positions.set([x, y, z], vi * 3);
      normals.set([0, ny, nz], vi * 3);
      uvs.set([u, v], vi * 2);
      transmission[vi] = t;
    });
    const b = i * 4;
    indices.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
  }
  return { positions, normals, uvs, transmission, indices };
}

/** 窓の中心（z = 0 平面）に 3 段がちょうど収まる垂直視野角 [deg] */
export function cameraFovDeg(): number {
  return (2 * Math.atan(VISIBLE_ROWS / 2 / CAMERA_DISTANCE) * 180) / Math.PI;
}

/** 段 k（0 = 上）の灯の位置。帯の内面から LAMP_DEPTH だけ奥、段の中心の高さ */
export function lampPosition(row: number, frames: number): Vector3 {
  const y = (1 - row) * Math.cos(Math.PI / frames); // 隣接面の中心高さ（= cos(π/n)）
  return new Vector3(0, y, drumApothem(frames) - LAMP_DEPTH);
}

/** 段の中心で露光 1 になる光源強度（距離 LAMP_DEPTH・正対で 1 / (1 + (d/range)^2) の逆数） */
export function lampPowerForUnitExposure(): number {
  return 1 + (LAMP_DEPTH / LAMP_RANGE) ** 2;
}

// ---------------------------------------------------------------------------
// 図柄アトラス（印刷層）。同じ図柄集合の 3 リールで 1 枚を共有する。

/** 面の中で画像が占める割合（CSS 版の .symbol-stack 94% 幅・contain と同じ） */
const SYMBOL_FIT_W = 0.94;
const SYMBOL_FIT_H = 0.93;

interface SymbolAtlas {
  texture: CanvasTexture;
  layout: AtlasLayout;
  cellIndex: Map<string, number>;
  /** 画像の読み込み完了で再描画したいビューの登録先 */
  listeners: Set<() => void>;
}

const atlasCache = new Map<string, SymbolAtlas>();

export interface SymbolLook {
  /** 画像が無いときの代替表示（絵文字や文字） */
  text: string;
  color: string;
}

function drawFallback(ctx: CanvasRenderingContext2D, x: number, y: number, look: SymbolLook) {
  ctx.save();
  ctx.fillStyle = look.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const long = look.text.length > 3;
  ctx.font = `bold ${long ? 96 : 220}px system-ui, sans-serif`;
  ctx.fillText(look.text, x + ATLAS_CELL_W / 2, y + ATLAS_CELL_H / 2, ATLAS_CELL_W * SYMBOL_FIT_W);
  ctx.restore();
}

function getSymbolAtlas(symbols: readonly string[], lookOf: (symbol: string) => SymbolLook): SymbolAtlas {
  const unique = Array.from(new Set(symbols)).sort();
  const key = unique.join('\u0000');
  const cached = atlasCache.get(key);
  if (cached) return cached;

  const layout = atlasLayout(unique.length);
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable for the symbol atlas');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = NoColorSpace; // CSS 合成と同じ表示空間で計算する（シェーダー側で変換しない）
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = 4;
  const atlas: SymbolAtlas = { texture, layout, cellIndex: new Map(), listeners: new Set() };

  unique.forEach((symbol, index) => {
    atlas.cellIndex.set(symbol, index);
    const col = index % layout.cols;
    const row = Math.floor(index / layout.cols);
    const x = col * ATLAS_CELL_W;
    const y = row * ATLAS_CELL_H;
    const url = SYMBOL_IMAGES[symbol];
    if (!url) {
      drawFallback(ctx, x, y, lookOf(symbol));
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      // contain フィット（素材は 640x400 なので実質 94% 幅）
      const scale = Math.min((ATLAS_CELL_W * SYMBOL_FIT_W) / img.width, (ATLAS_CELL_H * SYMBOL_FIT_H) / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.clearRect(x, y, ATLAS_CELL_W, ATLAS_CELL_H);
      ctx.drawImage(img, x + (ATLAS_CELL_W - w) / 2, y + (ATLAS_CELL_H - h) / 2, w, h);
      texture.needsUpdate = true;
      atlas.listeners.forEach((fn) => fn());
    };
    img.onerror = () => {
      drawFallback(ctx, x, y, lookOf(symbol));
      texture.needsUpdate = true;
      atlas.listeners.forEach((fn) => fn());
    };
    img.src = url;
  });
  texture.needsUpdate = true;
  atlasCache.set(key, atlas);
  return atlas;
}

// ---------------------------------------------------------------------------
// シェーダー

const VERTEX_SHADER = /* glsl */ `
attribute float aTransmission;
varying vec2 vUv;
varying float vTransmission;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
void main() {
  vUv = uv;
  vTransmission = aTransmission;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  // 法線は x 成分 0 なので scale.x の影響を受けない
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform vec3 uLampPos[3];
uniform float uLampPower[3];
uniform vec3 uLampColor;
uniform float uLampRange;
uniform vec3 uPaper;
uniform float uAmbient;
varying vec2 vUv;
varying float vTransmission;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;

void main() {
  vec4 ink = texture2D(uMap, vUv);
  vec3 albedo = mix(uPaper, ink.rgb, ink.a);

  // 前面からの室内光（やや上から）。面の傾きで僅かに陰る
  vec3 roomDir = normalize(vec3(0.0, 0.35, 1.0));
  float room = uAmbient * (0.82 + 0.18 * max(dot(vWorldNormal, roomDir), 0.0));

  // 背面の 3 灯。帯の内面に届く光 = 強度 × 入射コサイン × 距離減衰 × 反射凹部の窓
  float exposure = 0.0;
  for (int k = 0; k < 3; k++) {
    vec3 toLamp = uLampPos[k] - vWorldPos;
    float d2 = dot(toLamp, toLamp);
    vec3 l = toLamp * inversesqrt(d2);
    float facing = max(dot(-vWorldNormal, l), 0.0);
    float cavity = 1.0 - smoothstep(0.40, 0.60, abs(vWorldPos.y - uLampPos[k].y));
    exposure += uLampPower[k] * facing * cavity / (1.0 + d2 / (uLampRange * uLampRange));
  }

  // 透過: 白色拡散インクの紙は弱く暖色に、透光性カラーインクは自分の色で透ける
  vec3 paperT = vec3(1.0, 0.976, 0.863) * 0.14;
  float lum = dot(ink.rgb, vec3(0.299, 0.587, 0.114));
  vec3 inkBoost = clamp(mix(vec3(lum), ink.rgb, 1.12) * 1.04, 0.0, 1.0);
  vec3 transmitted = mix(paperT, inkBoost * vTransmission, ink.a) * exposure * uLampColor;

  gl_FragColor = vec4(clamp(albedo * room + transmitted, 0.0, 1.0), 1.0);
}
`;

// ---------------------------------------------------------------------------
// ビュー

export interface ReelGlView {
  /** 図柄帯を差し替える（機種切り替え）。コマ数が変われば円筒も作り直す */
  setStrip(strip: readonly string[]): void;
  /** コマ位置（連続値。基準段 = 下段）を描く */
  setKoma(koma: number): void;
  /** 上・中・下段の光量 */
  setLamps(levels: LampLevels): void;
  dispose(): void;
}

export interface ReelGlOptions {
  lookOf: (symbol: string) => SymbolLook;
  /** 端末の devicePixelRatio の上限（既定 3） */
  maxPixelRatio?: number;
}

/** 紙の地色（CSS 版の .cell 背景 rgba(229,226,217,0.92) を #d7d3c8 に重ねた値） */
const PAPER = [0.89, 0.878, 0.845] as const;

/**
 * host（.reel 要素）に canvas を足し、WebGL で円筒を描くビューを作る。
 * WebGL が使えない環境では WebGLRenderer のコンストラクタが投げるので、呼び出し側で捕まえて代替表示にする。
 */
export function createReelGlView(host: HTMLElement, options: ReelGlOptions): ReelGlView {
  const canvas = document.createElement('canvas');
  canvas.className = 'reel-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
  } catch (error) {
    canvas.remove();
    throw error;
  }
  renderer.setClearColor(0x1b1b1b, 1);
  const maxPixelRatio = options.maxPixelRatio ?? 3;

  const scene = new Scene();
  const camera = new PerspectiveCamera(cameraFovDeg(), 1, CAMERA_DISTANCE - 8, CAMERA_DISTANCE + 8);
  camera.position.set(0, 0, CAMERA_DISTANCE);
  camera.lookAt(0, 0, 0);

  const material = new ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uMap: { value: null },
      uLampPos: { value: [new Vector3(), new Vector3(), new Vector3()] },
      uLampPower: { value: [0, 0, 0] },
      uLampColor: { value: new Vector3(1, 0.97, 0.86) },
      uLampRange: { value: LAMP_RANGE },
      uPaper: { value: new Vector3(...PAPER) },
      uAmbient: { value: 1.0 },
    },
  });

  let mesh: Mesh | null = null;
  let atlas: SymbolAtlas | null = null;
  let frames = 0;
  let koma = 0;
  let lamps: LampLevels = LAMPS_ALL_ON;
  let disposed = false;
  let width = 0;
  let height = 0;

  const render = () => {
    if (disposed || !mesh || width === 0 || height === 0) return;
    renderer.render(scene, camera);
  };
  const onAtlasUpdate = () => render();

  const applyLamps = () => {
    const power = lampPowerForUnitExposure();
    const values = material.uniforms['uLampPower']!.value as number[];
    for (let k = 0; k < 3; k++) values[k] = power * Math.max(0, lamps[k] ?? 0);
    if (frames > 0) {
      const positions = material.uniforms['uLampPos']!.value as Vector3[];
      for (let k = 0; k < 3; k++) positions[k]!.copy(lampPosition(k, frames));
    }
  };

  const applyKoma = () => {
    if (!mesh) return;
    mesh.rotation.x = drumRotation(koma, frames);
  };

  const applySize = () => {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    // 面の幅は窓（z = 0 平面）の幅いっぱい（CSS 版の .cell width: 100% と同じ）
    if (mesh) mesh.scale.x = VISIBLE_ROWS * camera.aspect;
  };

  const resizeObserver = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect;
    if (!rect) return;
    width = rect.width;
    height = rect.height;
    if (width === 0 || height === 0) return;
    applySize();
    render();
  });
  resizeObserver.observe(host);

  const onContextLost = (event: Event) => event.preventDefault();
  const onContextRestored = () => render();
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  return {
    setStrip(strip) {
      if (disposed) return;
      atlas?.listeners.delete(onAtlasUpdate);
      atlas = getSymbolAtlas(strip, options.lookOf);
      atlas.listeners.add(onAtlasUpdate);
      material.uniforms['uMap']!.value = atlas.texture;
      frames = strip.length;
      const layout = atlas.layout;
      const cellIndex = atlas.cellIndex;
      const data = buildDrumGeometryData(
        frames,
        (face) => atlasCellUv(cellIndex.get(strip[face]!) ?? 0, layout),
        (face) => symbolTransmission(strip[face]!),
      );
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
      geometry.setAttribute('uv', new BufferAttribute(data.uvs, 2));
      geometry.setAttribute('aTransmission', new BufferAttribute(data.transmission, 1));
      geometry.setIndex(new BufferAttribute(data.indices, 1));
      if (mesh) {
        mesh.geometry.dispose();
        mesh.geometry = geometry;
      } else {
        mesh = new Mesh(geometry, material);
        mesh.frustumCulled = false;
        scene.add(mesh);
      }
      applyLamps();
      applyKoma();
      if (width > 0 && height > 0) applySize();
      render();
    },
    setKoma(next) {
      koma = next;
      applyKoma();
      render();
    },
    setLamps(levels) {
      lamps = levels;
      applyLamps();
      render();
    },
    dispose() {
      disposed = true;
      resizeObserver.disconnect();
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      atlas?.listeners.delete(onAtlasUpdate);
      mesh?.geometry.dispose();
      material.dispose();
      // StrictMode の二重マウントや機種切替で context を使い切らないよう明示的に手放す
      renderer.forceContextLoss();
      renderer.dispose();
      canvas.remove();
    },
  };
}
