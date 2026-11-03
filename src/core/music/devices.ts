/**
 * 装置(device)の解決規則。
 *
 * テンション・ディミニューション・ハモリ・スライド・ベースライン・連符レイヤーは
 * すべて同じ一本の規則で実効値が決まる:
 *   1. 語法が装置を抑制する(和風五音)なら off
 *   2. 音源の能力が担えない装置は off
 *   3. 明示指定があればそれ
 *   4. なければ様式の既定(StyleDef.devices / bass.line)
 *   5. それも無ければ off
 * compose() と UI は同じ関数を読む。UI は「様式既定(lush)」の解決値と、
 * 「無効: 2A03は伴奏が単声」のような理由をここから得て、規則を二重に持たない。
 * 保存 JSON のキー同一性(options.ts)も同じ可用性判定を使う。
 */

import { allowsTupletOverlay } from './groove.js';
import type { GrooveFeel } from './groove.js';
import { idiomFor } from './melodic-idiom.js';
import { capabilitiesFor } from './sound-capabilities.js';
import type { SoundBackendId } from './sound-capabilities.js';
import type { StyleDef } from './theory.js';
import type {
  BassLinePolicy,
  DiminutionPolicy,
  DuetPolicy,
  GlidePolicy,
  MelodicLanguage,
  TensionPolicy,
  TupletOverlayChoice,
  TupletOverlayPolicy,
} from './types.js';

export type DeviceId = 'tension' | 'diminution' | 'duet' | 'glide' | 'bassLine' | 'tupletOverlay';

export const DEVICE_IDS: readonly DeviceId[] = [
  'tension', 'diminution', 'duet', 'glide', 'bassLine', 'tupletOverlay',
];

export const DEVICE_LABELS: Record<DeviceId, string> = {
  tension: 'テンション',
  diminution: '細分',
  duet: 'ハモリ',
  glide: 'スライド',
  bassLine: 'ベースライン',
  tupletOverlay: '連符レイヤー',
};

export const BASS_LINE_POLICY_LABELS: Record<'auto' | BassLinePolicy, string> = {
  auto: 'スタイル既定',
  off: 'なし（ルート刻み）',
  on: 'あり（分数コード・順次ライン）',
};

export const DUET_POLICY_LABELS: Record<'auto' | DuetPolicy, string> = {
  auto: 'スタイル既定',
  off: 'なし',
  on: 'あり（下3度）',
};

export const GLIDE_POLICY_LABELS: Record<'auto' | GlidePolicy, string> = {
  auto: 'スタイル既定',
  off: 'なし',
  on: 'あり',
};

/** ひとつの装置の解決結果。 */
export interface DeviceState<T extends string | number> {
  /** 実際に効く値。 */
  value: T | 'off';
  /** 様式の既定(明示しなかったときに効く値)。 */
  styleDefault: T | 'off';
  /** どこから value が決まったか。 */
  source: 'explicit' | 'style' | 'unavailable';
  /** この曲の語法・音源・グルーヴの下で装置が使えない理由。null なら使える。 */
  unavailable: string | null;
}

export interface ResolvedDevices {
  tension: DeviceState<TensionPolicy>;
  diminution: DeviceState<DiminutionPolicy>;
  duet: DeviceState<DuetPolicy>;
  glide: DeviceState<GlidePolicy>;
  bassLine: DeviceState<BassLinePolicy>;
  tupletOverlay: DeviceState<TupletOverlayPolicy>;
}

/** 装置の解決に必要な入力(ComposeInput の該当部分 + 解決済みの様式)。 */
export interface DeviceContext {
  style: StyleDef;
  /** 解決済みの旋律語法(song-plan.ts の resolveMelodicLanguage)。 */
  melodicLanguage: MelodicLanguage;
  grooveFeel: GrooveFeel;
  soundChip: SoundBackendId | undefined;
  tensionPolicy?: 'auto' | TensionPolicy | undefined;
  diminution?: 'auto' | DiminutionPolicy | undefined;
  duet?: 'auto' | DuetPolicy | undefined;
  glide?: 'auto' | GlidePolicy | undefined;
  bassLine?: 'auto' | BassLinePolicy | undefined;
  tupletOverlay?: TupletOverlayChoice | undefined;
}

function resolveOne<T extends string | number>(
  choice: 'auto' | T | undefined,
  styleDefault: T | undefined,
  unavailable: string | null,
): DeviceState<T> {
  const fallback: T | 'off' = styleDefault ?? 'off';
  if (unavailable !== null) return { value: 'off', styleDefault: fallback, source: 'unavailable', unavailable };
  if (choice === undefined || choice === 'auto') {
    return { value: fallback, styleDefault: fallback, source: 'style', unavailable: null };
  }
  return { value: choice, styleDefault: fallback, source: 'explicit', unavailable: null };
}

/**
 * 全装置を解決する。compose() の実効値と、UI の「様式既定(…)」「無効: …」表示の唯一の出所。
 */
export function resolveDevices(ctx: DeviceContext): ResolvedDevices {
  const idiom = idiomFor(ctx.melodicLanguage);
  const caps = capabilitiesFor(ctx.soundChip);
  const suppressed = idiom.suppressesDevices
    ? `${idiom.label}の語法は装置を使わない（開放五度・間の美学と衝突する）`
    : null;
  const needs = (ok: boolean, reason: string): string | null => suppressed ?? (ok ? null : reason);
  const devices = ctx.style.devices;
  const tupletChoice: 'auto' | TupletOverlayPolicy | undefined = ctx.tupletOverlay;
  return {
    tension: resolveOne(
      ctx.tensionPolicy, devices?.tension,
      needs(caps.colorTones, `${caps.label}は伴奏が単声で、カラートーンが第3音を追い出すと和声が消える`),
    ),
    diminution: resolveOne(ctx.diminution, devices?.diminution, needs(true, '')),
    duet: resolveOne(
      ctx.duet, devices?.duet,
      needs(caps.duetLayer, `${caps.label}にはハモリ専用の声部予算がない`),
    ),
    glide: resolveOne(
      ctx.glide, devices?.glide,
      needs(caps.glide, `${caps.label}の編曲層はピッチスライドを未実装`),
    ),
    bassLine: resolveOne(ctx.bassLine, ctx.style.bass.line, needs(true, '')),
    tupletOverlay: resolveOne(
      tupletChoice, devices?.tuplet,
      needs(
        caps.independentArpeggio,
        `${caps.label}には担い手となる独立した分散和音声部の予算がない`,
      ) ?? needs(
        allowsTupletOverlay(ctx.grooveFeel),
        '三連オーバーレイとは細分の注意を取り合うため併用しない',
      ),
    ),
  };
}

/** 装置が「この曲で効く」か(保存 JSON へ明示指定を残すかの判定に使う)。 */
export function deviceAvailable(resolved: ResolvedDevices, id: DeviceId): boolean {
  return resolved[id].unavailable === null;
}
