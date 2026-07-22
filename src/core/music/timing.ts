import type { GrooveFeel } from './compose.js';

/** 跳ねる8分だけを2:1へ遅らせる。三連オーバーレイはドラム層だけで扱う。 */
export function grooveBeat(beat: number, feel: GrooveFeel): number {
  if (feel !== 'bounce') return beat;
  const floor = Math.floor(beat);
  const fraction = beat - floor;
  return Math.abs(fraction - 0.5) < 0.001 ? floor + 2 / 3 : beat;
}
