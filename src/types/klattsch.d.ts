/**
 * klattsch（MIT, https://github.com/tgies/klattsch）の最小型シム。
 * 本体は型定義を同梱しないため、このプロジェクトで使う表面だけを宣言する。
 */
declare module 'klattsch' {
  export interface KlattschScheduleEvent {
    atMs: number;
    target: Record<string, number>;
    transitionMs?: number;
  }

  export class FormantSynth {
    constructor(options: {
      sampleRate: number;
      schedule?: readonly KlattschScheduleEvent[];
      initialTarget?: Record<string, number>;
    });
    process(out: Float32Array): void;
    setTarget(target: Record<string, number>, transitionMs?: number): void;
    reset(initialTarget?: Record<string, number>): void;
  }

  export function renderToBuffer(options: {
    sampleRate?: number;
    schedule: readonly KlattschScheduleEvent[];
    totalMs?: number;
    initialTarget?: Record<string, number>;
  }): Float32Array;

  export function encodeWav(
    samples: Float32Array,
    sampleRate: number,
  ): { bytes: Uint8Array };
}
