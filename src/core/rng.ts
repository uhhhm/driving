// Deterministic hashing, RNG and noise. Pure — safe to use in workers.

/** 32-bit integer hash of up to 4 ints (xxhash-like avalanche). */
export function hash4(a: number, b = 0, c = 0, d = 0): number {
  let h = 0x9e3779b1 ^ Math.imul(a | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= Math.imul(b | 0, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  h ^= Math.imul(c | 0, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 16), 0x165667b1);
  h ^= Math.imul(d | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca77);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash to [0,1). */
export function hashf(a: number, b = 0, c = 0, d = 0): number {
  return hash4(a, b, c, d) / 4294967296;
}

/** Turn any string seed into an int. */
export function seedFromString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small fast seeded PRNG (mulberry32). */
export class RNG {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ---------------------------------------------------------------------------
// 2D simplex noise, seeded via a permutation table.
// ---------------------------------------------------------------------------
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = new Float32Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1]);

export class Noise2D {
  private perm = new Uint8Array(512);
  constructor(seed: number) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    const r = new RNG(seed);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r.next() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  /** Returns roughly [-1, 1]. */
  noise(xin: number, yin: number): number {
    const perm = this.perm;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = (perm[ii + perm[jj]] & 7) * 2;
      t0 *= t0;
      n += t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = (perm[ii + i1 + perm[jj + j1]] & 7) * 2;
      t1 *= t1;
      n += t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = (perm[ii + 1 + perm[jj + 1]] & 7) * 2;
      t2 *= t2;
      n += t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2);
    }
    return 70 * n;
  }

  fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x, y);
      norm += amp;
      amp *= gain;
      x *= lacunarity;
      y *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal, returns [0,1]-ish with sharp ridges. */
  ridged(x: number, y: number, octaves: number): number {
    let amp = 0.5;
    let sum = 0;
    let prev = 1;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(this.noise(x, y));
      n *= n;
      sum += n * amp * prev;
      prev = n;
      amp *= 0.5;
      x *= 2.03;
      y *= 2.03;
    }
    return sum;
  }
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const damp = (a: number, b: number, lambda: number, dt: number) =>
  lerp(a, b, 1 - Math.exp(-lambda * dt));
