/**
 * シード指定可能な決定論的 PRNG（xoshiro128**）。
 * メイン基板用とナビ層用で別インスタンスを持つ（docs/design/02-lottery.md）。
 * 状態はシリアライズ可能で、セーブデータに保存すると同一の未来が再現される。
 */

export interface RngState {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

export interface Rng {
  /** 0..0xFFFFFFFF の一様乱数 */
  nextUint32(): number;
  /** 0..65535（16bit。実機風の抽選値域） */
  draw16(): number;
  /** 0..bound-1 */
  nextInt(bound: number): number;
  getState(): RngState;
}

function splitmix32(seed: number): () => number {
  let h = seed >>> 0;
  return () => {
    h = (h + 0x9e3779b9) >>> 0;
    let z = h;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

export class Xoshiro128 implements Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number | RngState) {
    if (typeof seed === 'number') {
      const mix = splitmix32(seed);
      this.s0 = mix();
      this.s1 = mix();
      this.s2 = mix();
      this.s3 = mix();
      // 全ゼロ状態は不動点なので回避
      if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
    } else {
      this.s0 = seed.s0 >>> 0;
      this.s1 = seed.s1 >>> 0;
      this.s2 = seed.s2 >>> 0;
      this.s3 = seed.s3 >>> 0;
    }
  }

  nextUint32(): number {
    const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;
    const result = (Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9)) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  draw16(): number {
    return this.nextUint32() >>> 16;
  }

  nextInt(bound: number): number {
    return Math.floor((this.nextUint32() / 0x1_0000_0000) * bound);
  }

  getState(): RngState {
    return { s0: this.s0, s1: this.s1, s2: this.s2, s3: this.s3 };
  }
}
