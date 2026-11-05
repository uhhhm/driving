// Pure, deterministic world generation. Runs in both the worker and the main thread.
// Everything here is a function of (seed, coordinates) only.

import { Noise2D, hash4, hashf, clamp, lerp, smoothstep, RNG } from '../core/rng';
import {
  CHUNK,
  CELL,
  BIOME_CELL,
  SAMPLE_DS,
  Biome,
  BIOME_COUNT,
  RoadType,
  RoadFlag,
  Surface,
  Prop,
  PROP_STRIDE,
  type RoadEdge,
  type ChunkData,
  type MeshBuffers,
  type SetPiece,
  type SetPieceKind,
} from './types';

export interface Tunables {
  heightScale: number;
  crestHeight: number;
  bankStrength: number;
  propDensity: number;
  wiggle: number;
}

export const DEFAULT_TUNABLES: Tunables = {
  heightScale: 1,
  crestHeight: 1,
  bankStrength: 1,
  propDensity: 1,
  wiggle: 1,
};

const ROAD_HALF_W = [7.5, 5.5, 4.6, 9]; // by RoadType
const SURFACE_OF_ROAD = [Surface.Asphalt, Surface.Asphalt, Surface.Dirt, Surface.Asphalt];

// ---- palettes (linear-ish rgb) ----
type RGB = [number, number, number];
const PAL: Record<number, { base: RGB; alt: RGB; rock: RGB; top: RGB }> = {
  [Biome.Desert]: { base: [0.82, 0.55, 0.32], alt: [0.72, 0.4, 0.22], rock: [0.58, 0.28, 0.16], top: [0.9, 0.7, 0.45] },
  [Biome.Alpine]: { base: [0.2, 0.36, 0.16], alt: [0.14, 0.27, 0.12], rock: [0.42, 0.42, 0.44], top: [0.93, 0.95, 1.0] },
  [Biome.City]: { base: [0.16, 0.15, 0.2], alt: [0.22, 0.2, 0.26], rock: [0.3, 0.28, 0.33], top: [0.2, 0.18, 0.24] },
  [Biome.Coast]: { base: [0.3, 0.5, 0.2], alt: [0.42, 0.56, 0.24], rock: [0.55, 0.5, 0.44], top: [0.88, 0.8, 0.58] },
};

export class WorldGen {
  readonly seed: number;
  t: Tunables;
  private nTerrain: Noise2D;
  private nDetail: Noise2D;
  private nBiome: Noise2D;
  private nWarp: Noise2D;
  private edgeCache = new Map<string, RoadEdge | null>();
  // scratch for sample()
  readonly w = new Float32Array(BIOME_COUNT);

  constructor(seed: number, tunables: Tunables = DEFAULT_TUNABLES) {
    this.seed = seed >>> 0;
    this.t = { ...tunables };
    this.nTerrain = new Noise2D(hash4(seed, 1));
    this.nDetail = new Noise2D(hash4(seed, 2));
    this.nBiome = new Noise2D(hash4(seed, 3));
    this.nWarp = new Noise2D(hash4(seed, 4));
  }

  // ---------------------------------------------------------------------------
  // Biomes
  // ---------------------------------------------------------------------------
  biomeOfCell(i: number, j: number): Biome {
    // first region around spawn is always the canyon for a great first impression
    const h = hash4(this.seed, i, j, 77);
    return (h % BIOME_COUNT) as Biome;
  }

  biomeCellPoint(i: number, j: number, out: number[]) {
    out[0] = (i + 0.2 + 0.6 * hashf(this.seed, i, j, 11)) * BIOME_CELL;
    out[1] = (j + 0.2 + 0.6 * hashf(this.seed, i, j, 12)) * BIOME_CELL;
  }

  private _bp = [0, 0];
  private _bd = new Float32Array(9);
  private _bb = new Int8Array(9);
  /** Fills this.w with normalised biome weights. Returns the dominant biome cell id (i,j packed). */
  biomeWeights(x: number, z: number, out: Float32Array = this.w): number {
    // domain warp so borders aren't straight lines
    const wx = x + this.nWarp.noise(x * 0.0007, z * 0.0007) * 260;
    const wz = z + this.nWarp.noise(z * 0.0007 + 31.7, x * 0.0007 - 12.3) * 260;
    const ci = Math.floor(wx / BIOME_CELL);
    const cj = Math.floor(wz / BIOME_CELL);
    let dmin = 1e9;
    let best = 0;
    let k = 0;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        this.biomeCellPoint(ci + di, cj + dj, this._bp);
        const dx = wx - this._bp[0];
        const dz = wz - this._bp[1];
        const d = Math.sqrt(dx * dx + dz * dz);
        this._bd[k] = d;
        this._bb[k] = this.biomeOfCell(ci + di, cj + dj);
        if (d < dmin) {
          dmin = d;
          best = k;
        }
        k++;
      }
    out.fill(0);
    const B = 220;
    let sum = 0;
    for (let q = 0; q < 9; q++) {
      const f = 1 - (this._bd[q] - dmin) / B;
      if (f > 0) {
        const ww = f * f * (3 - 2 * f);
        out[this._bb[q]] += ww;
        sum += ww;
      }
    }
    for (let b = 0; b < BIOME_COUNT; b++) out[b] /= sum;
    const bi = ci + (best % 3) - 1;
    const bj = cj + Math.floor(best / 3) - 1;
    return ((bi & 0xffff) << 16) | (bj & 0xffff);
  }

  // ---------------------------------------------------------------------------
  // Terrain base height (no roads)
  // ---------------------------------------------------------------------------
  private biomeHeight(b: number, x: number, z: number): number {
    const n = this.nTerrain;
    const d = this.nDetail;
    switch (b) {
      case Biome.Desert: {
        // rolling sand + terraced mesas + dry washes
        const base = 14 + n.fbm(x * 0.0012, z * 0.0012, 3) * 10;
        const m = n.fbm(x * 0.0016 + 40, z * 0.0016 - 17, 4);
        const mesa = smoothstep(0.12, 0.2, m) * 34 + smoothstep(0.38, 0.44, m) * 22;
        const terr = mesa + Math.max(0, m) * 6;
        const wash = Math.pow(1 - Math.abs(n.noise(x * 0.001 + 9, z * 0.001 + 4)), 10) * 9;
        const dune = d.noise(x * 0.025, z * 0.018) * 0.7;
        return base + terr - wash + dune;
      }
      case Biome.Alpine: {
        const r = n.ridged(x * 0.0011 + 100, z * 0.0011 - 50, 5);
        const base = 26 + n.fbm(x * 0.002, z * 0.002, 3) * 14;
        return base + r * r * 150 + d.noise(x * 0.03, z * 0.03) * 0.5;
      }
      case Biome.City: {
        return 9 + n.fbm(x * 0.0006, z * 0.0006, 2) * 5;
      }
      case Biome.Coast: {
        const s = n.fbm(x * 0.0011 - 70, z * 0.0011 + 220, 4);
        const land = 18 + n.fbm(x * 0.003, z * 0.003, 3) * 9;
        const cliff = smoothstep(-0.12, -0.06, s);
        const beach = smoothstep(-0.2, -0.12, s);
        const sea = -22 + beach * 18;
        return lerp(sea, land, cliff) + d.noise(x * 0.04, z * 0.04) * 0.4;
      }
    }
    return 0;
  }

  /** Base terrain height at (x,z), leaving biome weights in this.w. */
  baseHeight(x: number, z: number): number {
    this.biomeWeights(x, z, this.w);
    let h = 0;
    for (let b = 0; b < BIOME_COUNT; b++) {
      const wb = this.w[b];
      if (wb > 0.001) h += wb * this.biomeHeight(b, x, z);
    }
    return h * this.t.heightScale;
  }

  // ---------------------------------------------------------------------------
  // Road graph
  // ---------------------------------------------------------------------------
  private _w2 = new Float32Array(BIOME_COUNT);
  dominantBiome(x: number, z: number): Biome {
    this.biomeWeights(x, z, this._w2);
    let best = 0;
    for (let b = 1; b < BIOME_COUNT; b++) if (this._w2[b] > this._w2[best]) best = b;
    return best as Biome;
  }

  node(i: number, j: number, out: number[]): void {
    const city = this.dominantBiome((i + 0.5) * CELL, (j + 0.5) * CELL) === Biome.City;
    const jit = city ? 0.06 : 0.5;
    out[0] = (i + 0.5 + (hashf(this.seed, i, j, 21) - 0.5) * jit) * CELL;
    out[1] = (j + 0.5 + (hashf(this.seed, i, j, 22) - 0.5) * jit) * CELL;
  }

  nodeHeight(i: number, j: number): number {
    const p = [0, 0];
    this.node(i, j, p);
    let h = 0;
    const r = 14;
    h += this.baseHeight(p[0], p[1]) * 2;
    h += this.baseHeight(p[0] + r, p[1]);
    h += this.baseHeight(p[0] - r, p[1]);
    h += this.baseHeight(p[0], p[1] + r);
    h += this.baseHeight(p[0], p[1] - r);
    return Math.max(h / 6, 5);
  }

  /** dir 0 = east (i,j)->(i+1,j), dir 1 = north (i,j)->(i,j+1) */
  edgeExists(i: number, j: number, dir: number): boolean {
    const p = [0, 0];
    this.node(i, j, p);
    const q = [0, 0];
    if (dir === 0) this.node(i + 1, j, q);
    else this.node(i, j + 1, q);
    const b = this.dominantBiome((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    const pr = b === Biome.City ? 1 : b === Biome.Alpine ? 0.72 : 0.82;
    // guarantee every node at least one connection
    if (dir === 0 && hash4(this.seed, i, j, 5) % 7 === 0) return true;
    return hashf(this.seed, i, j, 30 + dir) < pr;
  }

  edge(i: number, j: number, dir: number): RoadEdge | null {
    const key = `${dir}:${i}:${j}`;
    const c = this.edgeCache.get(key);
    if (c !== undefined) return c;
    const e = this.edgeExists(i, j, dir) ? this.buildEdge(i, j, dir, key) : null;
    if (this.edgeCache.size > 600) {
      // crude LRU: drop oldest quarter
      let k = 0;
      for (const kk of this.edgeCache.keys()) {
        this.edgeCache.delete(kk);
        if (++k > 150) break;
      }
    }
    this.edgeCache.set(key, e);
    return e;
  }

  /** All edges connected to node (i,j). */
  nodeEdges(i: number, j: number): RoadEdge[] {
    const res: RoadEdge[] = [];
    const a = this.edge(i, j, 0);
    if (a) res.push(a);
    const b = this.edge(i - 1, j, 0);
    if (b) res.push(b);
    const c = this.edge(i, j, 1);
    if (c) res.push(c);
    const d = this.edge(i, j - 1, 1);
    if (d) res.push(d);
    return res;
  }

  edgesNear(minX: number, minZ: number, maxX: number, maxZ: number): RoadEdge[] {
    const pad = 160;
    const i0 = Math.floor((minX - pad) / CELL) - 1;
    const i1 = Math.floor((maxX + pad) / CELL);
    const j0 = Math.floor((minZ - pad) / CELL) - 1;
    const j1 = Math.floor((maxZ + pad) / CELL);
    const out: RoadEdge[] = [];
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++)
        for (let d = 0; d < 2; d++) {
          const e = this.edge(i, j, d);
          if (!e) continue;
          if (e.maxX + e.halfW < minX || e.minX - e.halfW > maxX || e.maxZ + e.halfW < minZ || e.minZ - e.halfW > maxZ)
            continue;
          out.push(e);
        }
    return out;
  }

  private buildEdge(i: number, j: number, dir: number, key: string): RoadEdge {
    const A = [0, 0];
    const B = [0, 0];
    this.node(i, j, A);
    const bi = dir === 0 ? i + 1 : i;
    const bj = dir === 0 ? j : j + 1;
    this.node(bi, bj, B);
    const midx = (A[0] + B[0]) / 2;
    const midz = (A[1] + B[1]) / 2;
    const biome = this.dominantBiome(midx, midz);
    const rng = new RNG(hash4(this.seed, i, j, 100 + dir));

    let type: RoadType;
    const highwayRow = dir === 0 ? ((j % 4) + 4) % 4 === 0 : ((i % 5) + 5) % 5 === 0;
    if (biome === Biome.City) type = RoadType.Avenue;
    else if (highwayRow) type = RoadType.Highway;
    else if (biome === Biome.Alpine) type = rng.chance(0.25) ? RoadType.Dirt : RoadType.Mountain;
    else if (biome === Biome.Desert) type = rng.chance(0.45) ? RoadType.Dirt : RoadType.Highway;
    else type = rng.chance(0.2) ? RoadType.Dirt : RoadType.Highway;

    // --- control points ---
    const dx = B[0] - A[0];
    const dz = B[1] - A[1];
    const L = Math.hypot(dx, dz);
    const px = -dz / L;
    const pz = dx / L;
    const pts: number[] = [A[0], A[1]];
    const wig = this.t.wiggle;
    if (type === RoadType.Avenue) {
      // straight
    } else if (type === RoadType.Mountain && rng.chance(0.55)) {
      // switchbacks: zig-zag across the slope
      const k = 5;
      const amp = rng.range(45, 70) * wig;
      for (let q = 1; q <= k; q++) {
        const t = q / (k + 1);
        const off = (q % 2 ? 1 : -1) * amp * Math.sin(Math.PI * t) ** 0.4;
        pts.push(A[0] + dx * t + px * off, A[1] + dz * t + pz * off);
      }
    } else {
      const k = type === RoadType.Highway ? 2 : 3;
      const amp = (type === RoadType.Highway ? 28 : type === RoadType.Dirt ? 48 : 55) * wig;
      for (let q = 1; q <= k; q++) {
        const t = q / (k + 1) + rng.range(-0.05, 0.05);
        const off = rng.range(-amp, amp);
        pts.push(A[0] + dx * t + px * off, A[1] + dz * t + pz * off);
      }
    }
    pts.push(B[0], B[1]);
    // straight stubs at both junctions so edges fan out cleanly from a node (no overlapping ribbons)
    {
      const stub = Math.min(30, L * 0.12);
      const ux = dx / L;
      const uz = dz / L;
      pts.splice(2, 0, A[0] + ux * stub, A[1] + uz * stub);
      pts.splice(pts.length - 2, 0, B[0] - ux * stub, B[1] - uz * stub);
    }

    // --- dense centripetal Catmull-Rom sampling ---
    const dense: number[] = [];
    const np = pts.length / 2;
    const P = (q: number, o: 0 | 1) => {
      if (q < 0) return 2 * pts[o] - pts[2 + o];
      if (q >= np) return 2 * pts[(np - 1) * 2 + o] - pts[(np - 2) * 2 + o];
      return pts[q * 2 + o];
    };
    for (let s = 0; s < np - 1; s++) {
      const p0x = P(s - 1, 0), p0z = P(s - 1, 1);
      const p1x = P(s, 0), p1z = P(s, 1);
      const p2x = P(s + 1, 0), p2z = P(s + 1, 1);
      const p3x = P(s + 2, 0), p3z = P(s + 2, 1);
      const t0 = 0;
      const t1 = t0 + Math.pow(Math.hypot(p1x - p0x, p1z - p0z), 0.5) + 1e-4;
      const t2 = t1 + Math.pow(Math.hypot(p2x - p1x, p2z - p1z), 0.5) + 1e-4;
      const t3 = t2 + Math.pow(Math.hypot(p3x - p2x, p3z - p2z), 0.5) + 1e-4;
      const steps = 40;
      for (let q = 0; q < steps; q++) {
        const t = t1 + ((t2 - t1) * q) / steps;
        const a1x = ((t1 - t) / (t1 - t0)) * p0x + ((t - t0) / (t1 - t0)) * p1x;
        const a1z = ((t1 - t) / (t1 - t0)) * p0z + ((t - t0) / (t1 - t0)) * p1z;
        const a2x = ((t2 - t) / (t2 - t1)) * p1x + ((t - t1) / (t2 - t1)) * p2x;
        const a2z = ((t2 - t) / (t2 - t1)) * p1z + ((t - t1) / (t2 - t1)) * p2z;
        const a3x = ((t3 - t) / (t3 - t2)) * p2x + ((t - t2) / (t3 - t2)) * p3x;
        const a3z = ((t3 - t) / (t3 - t2)) * p2z + ((t - t2) / (t3 - t2)) * p3z;
        const b1x = ((t2 - t) / (t2 - t0)) * a1x + ((t - t0) / (t2 - t0)) * a2x;
        const b1z = ((t2 - t) / (t2 - t0)) * a1z + ((t - t0) / (t2 - t0)) * a2z;
        const b2x = ((t3 - t) / (t3 - t1)) * a2x + ((t - t1) / (t3 - t1)) * a3x;
        const b2z = ((t3 - t) / (t3 - t1)) * a2z + ((t - t1) / (t3 - t1)) * a3z;
        dense.push(((t2 - t) / (t2 - t1)) * b1x + ((t - t1) / (t2 - t1)) * b2x);
        dense.push(((t2 - t) / (t2 - t1)) * b1z + ((t - t1) / (t2 - t1)) * b2z);
      }
    }
    dense.push(B[0], B[1]);

    // --- resample at uniform arc length ---
    const nd = dense.length / 2;
    const cum = new Float32Array(nd);
    for (let q = 1; q < nd; q++)
      cum[q] = cum[q - 1] + Math.hypot(dense[q * 2] - dense[q * 2 - 2], dense[q * 2 + 1] - dense[q * 2 - 1]);
    const len = cum[nd - 1];
    const n = Math.max(4, Math.round(len / SAMPLE_DS) + 1);
    const ds = len / (n - 1);
    const X = new Float32Array(n);
    const Z = new Float32Array(n);
    let seg = 0;
    for (let q = 0; q < n; q++) {
      const s = q * ds;
      while (seg < nd - 2 && cum[seg + 1] < s) seg++;
      const f = clamp((s - cum[seg]) / Math.max(1e-6, cum[seg + 1] - cum[seg]), 0, 1);
      X[q] = lerp(dense[seg * 2], dense[seg * 2 + 2], f);
      Z[q] = lerp(dense[seg * 2 + 1], dense[seg * 2 + 3], f);
    }
    const TX = new Float32Array(n);
    const TZ = new Float32Array(n);
    const S = new Float32Array(n);
    for (let q = 0; q < n; q++) {
      const a = Math.max(0, q - 1);
      const b = Math.min(n - 1, q + 1);
      const tx = X[b] - X[a];
      const tz = Z[b] - Z[a];
      const tl = Math.hypot(tx, tz) || 1;
      TX[q] = tx / tl;
      TZ[q] = tz / tl;
      S[q] = q * ds;
    }

    // --- elevation profile ---
    const raw = new Float32Array(n);
    for (let q = 0; q < n; q++) raw[q] = this.baseHeight(X[q], Z[q]);
    let H = Float32Array.from(raw);
    const R = type === RoadType.Mountain ? 6 : type === RoadType.Dirt ? 5 : 10;
    const tmp = new Float32Array(n);
    for (let pass = 0; pass < 3; pass++) {
      for (let q = 0; q < n; q++) {
        let acc = 0;
        let c = 0;
        for (let o = -R; o <= R; o++) {
          const idx = clamp(q + o, 0, n - 1);
          acc += H[idx];
          c++;
        }
        tmp[q] = acc / c;
      }
      H.set(tmp);
    }
    // anchor ends to node heights
    const hA = this.nodeHeight(i, j);
    const hB = this.nodeHeight(bi, bj);
    const dA = hA - H[0];
    const dB = hB - H[n - 1];
    const fade = Math.min(30, Math.floor(n / 2));
    for (let q = 0; q < n; q++) {
      const fa = 1 - smoothstep(0, fade, q);
      const fb = 1 - smoothstep(0, fade, n - 1 - q);
      H[q] += dA * fa + dB * fb;
      H[q] = Math.max(H[q], 5);
    }
    // --- bank from curvature ---
    const bank = new Float32Array(n);
    const K = 14 * this.t.bankStrength;
    for (let q = 1; q < n - 1; q++) {
      const rx = -TZ[q];
      const rz = TX[q];
      const k = ((TX[q + 1] - TX[q - 1]) * rx + (TZ[q + 1] - TZ[q - 1]) * rz) / (2 * ds);
      bank[q] = clamp(-k * K, -0.26, 0.26);
    }
    // smooth & fade ends
    for (let pass = 0; pass < 2; pass++) {
      for (let q = 0; q < n; q++) {
        let acc = 0;
        let c = 0;
        for (let o = -5; o <= 5; o++) {
          acc += bank[clamp(q + o, 0, n - 1)];
          c++;
        }
        tmp[q] = acc / c;
      }
      bank.set(tmp);
    }
    for (let q = 0; q < n; q++) {
      bank[q] *= smoothstep(4, 14, q) * smoothstep(4, 14, n - 1 - q);
      if (type === RoadType.Avenue) bank[q] = 0;
    }

    const flags = new Uint8Array(n);
    const setPieces: SetPiece[] = [];
    let noTraffic = false;
    const halfW = ROAD_HALF_W[type];

    // --- set pieces ---
    const sp = rng.next();
    const straightAt = (q0: number, q1: number) => {
      // find the index in [q0,q1] with lowest local curvature
      let best = q0;
      let bv = 1e9;
      for (let q = q0; q <= q1; q++) {
        let v = 0;
        for (let o = -8; o <= 8; o++) {
          const a = clamp(q + o, 1, n - 2);
          v += Math.abs(bank[a]);
        }
        // prefer flat ground too (loops & ramps need a level run-up)
        for (let o = -20; o <= 20; o += 4) v += Math.abs(H[clamp(q + o, 0, n - 1)] - H[q]) * 0.08;
        if (v < bv) {
          bv = v;
          best = q;
        }
      }
      return best;
    };
    const addPiece = (kind: SetPieceKind, q: number, side = 0) => {
      setPieces.push({
        kind,
        edgeKey: key,
        idx: q,
        x: X[q],
        y: H[q],
        z: Z[q],
        yaw: Math.atan2(TX[q], TZ[q]),
        side,
        halfW: ROAD_HALF_W[type],
        param: rng.next(),
      });
    };
    const flatten = (q: number, r: number) => {
      const h0 = H[q];
      for (let o = -r; o <= r; o++) {
        const a = clamp(q + o, 0, n - 1);
        const f = 1 - smoothstep(r * 0.6, r, Math.abs(o));
        H[a] = lerp(H[a], h0, f);
        bank[a] *= 1 - f;
      }
    };
    if (n > 60) {
      if ((type === RoadType.Highway || type === RoadType.Avenue) && sp < 0.14) {
        const q = straightAt(Math.floor(n * 0.35), Math.floor(n * 0.65));
        flatten(q, 30);
        addPiece('loop', q);
        noTraffic = true;
        for (let o = -30; o <= 30; o++) flags[clamp(q + o, 0, n - 1)] |= RoadFlag.Stunt;
      } else if (type !== RoadType.Avenue && sp < 0.32) {
        const q = straightAt(Math.floor(n * 0.3), Math.floor(n * 0.7));
        flatten(q, 14);
        addPiece('ramp', q);
        noTraffic = true;
        for (let o = -10; o <= 10; o++) flags[clamp(q + o, 0, n - 1)] |= RoadFlag.Stunt;
      } else if (sp < 0.52) {
        const q = straightAt(Math.floor(n * 0.25), Math.floor(n * 0.75));
        addPiece('gas', q, rng.chance(0.5) ? 1 : -1);
      } else if (sp < 0.64) {
        const q = straightAt(Math.floor(n * 0.25), Math.floor(n * 0.75));
        addPiece('construction', q, rng.chance(0.5) ? 1 : -1);
      } else if (type === RoadType.Highway && sp < 0.74) {
        addPiece('jam', Math.floor(n * rng.range(0.3, 0.6)));
      } else if ((biome === Biome.Desert || biome === Biome.Coast) && sp < 0.84) {
        const q = straightAt(Math.floor(n * 0.3), Math.floor(n * 0.7));
        addPiece('halfpipe', q, rng.chance(0.5) ? 1 : -1);
      }
    }

    // grade limit (relax towards neighbours where too steep)
    const maxGrade = type === RoadType.Highway ? 0.09 : type === RoadType.Avenue ? 0.06 : 0.16;
    for (let it = 0; it < 4; it++) {
      for (let q = 1; q < n; q++) {
        const lim = maxGrade * ds;
        if (H[q] - H[q - 1] > lim) H[q] = H[q - 1] + lim;
        else if (H[q - 1] - H[q] > lim) H[q] = H[q - 1] - lim;
      }
      // re-anchor end B by backwards pass
      H[n - 1] = hB;
      for (let q = n - 2; q >= 0; q--) {
        const lim = maxGrade * ds;
        if (H[q] - H[q + 1] > lim) H[q] = H[q + 1] + lim;
        else if (H[q + 1] - H[q] > lim) H[q] = H[q + 1] - lim;
      }
      H[0] = hA;
    }

    // stunt pieces need an exactly level run-up: enforce after grade limiting
    for (const p of setPieces) {
      if (p.kind === 'loop' || p.kind === 'ramp') {
        const h0 = H[p.idx];
        const flat = p.kind === 'loop' ? 26 : 10;
        const blend = 12;
        for (let o = -flat - blend; o <= flat + blend; o++) {
          const a = p.idx + o;
          if (a < 0 || a >= n) continue;
          const f = 1 - smoothstep(flat, flat + blend, Math.abs(o));
          H[a] = lerp(H[a], h0, f);
          bank[a] *= 1 - f;
        }
      }
      p.y = H[p.idx];
    }

    // --- crests (jumps!) ---
    if (type !== RoadType.Avenue) {
      const count = type === RoadType.Mountain ? rng.int(0, 1) : rng.int(1, 2);
      for (let c = 0; c < count; c++) {
        let q0 = -1;
        for (let tries = 0; tries < 5 && q0 < 0; tries++) {
          const cand = Math.floor(n * rng.range(0.2, 0.8));
          let clash = false;
          for (let o = -30; o <= 30; o++) {
            const a = clamp(cand + o, 0, n - 1);
            if (flags[a] & (RoadFlag.Stunt | RoadFlag.Crest) || Math.abs(raw[a] - H[a]) > 5) clash = true; // no jumps into cuts / off bridges
          }
          if (!clash) q0 = cand;
        }
        if (q0 < 0) continue;
        const A2 = rng.range(2.2, 4.0) * this.t.crestHeight;
        const Lc = rng.range(40, 60);
        const half = Lc / 2 / ds;
        for (let o = -Math.ceil(half); o <= Math.ceil(half); o++) {
          const a = q0 + o;
          if (a < 2 || a > n - 3) continue;
          const u = o / half;
          if (Math.abs(u) > 1) continue;
          // asymmetric: gentle approach, sharp lip, then fall away
          const shape = u < 0 ? 0.5 * (1 + Math.cos(Math.PI * u)) : Math.pow(1 - u, 1.6);
          H[a] += A2 * shape;
          flags[a] |= RoadFlag.Crest;
        }
      }
    }

    // --- bridges & tunnels ---
    for (let q = 0; q < n; q++) {
      const diff = H[q] - raw[q];
      if (diff > 7.5 && !(flags[q] & RoadFlag.Crest)) flags[q] |= RoadFlag.Bridge;
      else if (diff < -10 && type !== RoadType.Avenue && q > 20 && q < n - 21) {
        // only a tunnel if the hill rises on both sides (otherwise it's a cliff-side cut)
        const off = halfW + 9;
        const l = this.baseHeight(X[q] + TZ[q] * off, Z[q] - TX[q] * off);
        const r = this.baseHeight(X[q] - TZ[q] * off, Z[q] + TX[q] * off);
        if (l > H[q] + 7 && r > H[q] + 7) flags[q] |= RoadFlag.Tunnel;
      }
    }
    // remove short runs
    for (const f of [RoadFlag.Bridge, RoadFlag.Tunnel]) {
      let q = 0;
      while (q < n) {
        if (flags[q] & f) {
          let e = q;
          while (e < n && flags[e] & f) e++;
          if (e - q < 7) for (let r = q; r < e; r++) flags[r] &= ~f;
          q = e;
        } else q++;
      }
    }

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let q = 0; q < n; q++) {
      minX = Math.min(minX, X[q]);
      maxX = Math.max(maxX, X[q]);
      minZ = Math.min(minZ, Z[q]);
      maxZ = Math.max(maxZ, Z[q]);
    }
    return {
      key, ai: i, aj: j, bi, bj, type, biome, halfW, n, len,
      x: X, z: Z, h: H, raw, bank, tx: TX, tz: TZ, s: S, flags,
      minX, maxX, minZ, maxZ, setPieces, noTraffic,
    };
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------
  /** Find nearest road point. Returns null if none within maxDist. */
  nearestRoad(x: number, z: number, maxDist = 60): { edge: RoadEdge; idx: number; t: number; lateral: number; dist: number; y: number } | null {
    const edges = this.edgesNear(x - maxDist, z - maxDist, x + maxDist, z + maxDist);
    let best: { edge: RoadEdge; idx: number; t: number; lateral: number; dist: number; y: number } | null = null;
    for (const e of edges) {
      for (let q = 0; q < e.n - 1; q++) {
        const ax = e.x[q], az = e.z[q];
        const bx = e.x[q + 1], bz = e.z[q + 1];
        const vx = bx - ax, vz = bz - az;
        const l2 = vx * vx + vz * vz;
        let t = ((x - ax) * vx + (z - az) * vz) / l2;
        t = clamp(t, 0, 1);
        const cx = ax + vx * t, cz = az + vz * t;
        const d = Math.hypot(x - cx, z - cz);
        if (d < maxDist && (!best || d < best.dist)) {
          const rx = -e.tz[q], rz = e.tx[q];
          const lat = (x - cx) * rx + (z - cz) * rz;
          const y = lerp(e.h[q], e.h[q + 1], t) + lat * Math.tan(lerp(e.bank[q], e.bank[q + 1], t));
          best = { edge: e, idx: q, t, lateral: lat, dist: d, y };
        }
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Chunk generation
  // ---------------------------------------------------------------------------
  generateChunk(cx: number, cz: number, lod: number): ChunkData {
    const t0 = performance.now();
    const res = lod === 0 ? 64 : lod === 1 ? 32 : 16;
    const step = CHUNK / res;
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    const R1 = res + 1;
    const RB = res + 3; // with 1-vertex border for normals
    const margin = 60;
    const edges = this.edgesNear(x0 - margin, z0 - margin, x0 + CHUNK + margin, z0 + CHUNK + margin);

    // --- segment spatial grid ---
    const GC = 16;
    const gx0 = x0 - step;
    const gz0 = z0 - step;
    const GN = Math.ceil((CHUNK + 2 * step) / GC) + 1;
    const grid: number[][] = new Array(GN * GN);
    for (let g = 0; g < grid.length; g++) grid[g] = [];
    const segE: RoadEdge[] = [];
    const segQ: number[] = [];
    const INF = 52;
    for (const e of edges) {
      for (let q = 0; q < e.n - 1; q++) {
        const ax = e.x[q], az = e.z[q], bx = e.x[q + 1], bz = e.z[q + 1];
        const mnx = Math.min(ax, bx) - INF, mxx = Math.max(ax, bx) + INF;
        const mnz = Math.min(az, bz) - INF, mxz = Math.max(az, bz) + INF;
        const i0 = Math.max(0, Math.floor((mnx - gx0) / GC));
        const i1 = Math.min(GN - 1, Math.floor((mxx - gx0) / GC));
        const j0 = Math.max(0, Math.floor((mnz - gz0) / GC));
        const j1 = Math.min(GN - 1, Math.floor((mxz - gz0) / GC));
        if (i0 > i1 || j0 > j1) continue;
        const id = segE.length;
        segE.push(e);
        segQ.push(q);
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) grid[j * GN + i].push(id);
      }
    }

    // --- heights with border ---
    const hb = new Float32Array(RB * RB);
    const wts = new Float32Array(R1 * R1 * 4);
    const roadW = new Float32Array(R1 * R1); // road proximity for colouring
    const roadSurf = new Uint8Array(R1 * R1);
    const rawB = new Float32Array(RB * RB);
    for (let j = 0; j < RB; j++) {
      for (let i = 0; i < RB; i++) {
        const x = x0 + (i - 1) * step;
        const z = z0 + (j - 1) * step;
        const raw = this.baseHeight(x, z);
        rawB[j * RB + i] = raw;
        let h = raw;
        // nearest road influence
        const gi = Math.floor((x - gx0) / GC);
        const gj = Math.floor((z - gz0) / GC);
        let bestW = 0;
        let bestH = 0;
        let bestD = 1e9;
        let bestType = -1;
        if (gi >= 0 && gj >= 0 && gi < GN && gj < GN) {
          const cell = grid[gj * GN + gi];
          for (let c = 0; c < cell.length; c++) {
            const e = segE[cell[c]];
            const q = segQ[cell[c]];
            const ax = e.x[q], az = e.z[q];
            const vx = e.x[q + 1] - ax, vz = e.z[q + 1] - az;
            const l2 = vx * vx + vz * vz;
            const t = clamp(((x - ax) * vx + (z - az) * vz) / l2, 0, 1);
            const px = ax + vx * t, pz = az + vz * t;
            const ddx = x - px, ddz = z - pz;
            const d = Math.sqrt(ddx * ddx + ddz * ddz);
            const rh = lerp(e.h[q], e.h[q + 1], t);
            const rawc = lerp(e.raw[q], e.raw[q + 1], t);
            const diff = Math.abs(raw - rh);
            const shoulder = Math.min(42, 5 + diff * 1.25);
            const inner = e.halfW + 1.2;
            if (d > inner + shoulder) continue;
            const rx = -e.tz[q], rz = e.tx[q];
            let lat = ddx * rx + ddz * rz;
            const bk = lerp(e.bank[q], e.bank[q + 1], t);
            const latC = clamp(lat, -e.halfW, e.halfW);
            const target = rh + latC * Math.tan(bk) - 0.35;
            const w = 1 - smoothstep(inner, inner + shoulder, d);
            const isBridge = (e.flags[q] & RoadFlag.Bridge) !== 0 && rawc < rh - 3;
            if (isBridge && raw < target) {
              // under a bridge: keep the valley
              if (d < bestD) {
                bestD = d;
                bestType = -1;
              }
              continue;
            }
            if (w > bestW || (w === bestW && d < bestD)) {
              bestW = w;
              bestH = target;
              bestD = d;
              bestType = e.type;
            }
          }
        }
        if (bestW > 0) h = lerp(raw, bestH, bestW);
        hb[j * RB + i] = h;
        if (i >= 1 && j >= 1 && i <= R1 && j <= R1) {
          const vi = (j - 1) * R1 + (i - 1);
          wts.set(this.w, vi * 4); // weights from baseHeight call above
          roadW[vi] = bestD < 1e8 ? 1 - smoothstep(4, 14, bestD - (bestType >= 0 ? ROAD_HALF_W[bestType] : 6)) : 0;
          roadSurf[vi] = bestType === RoadType.Dirt ? 1 : 0;
        }
      }
    }

    // --- outputs ---
    const heights = new Float32Array(R1 * R1);
    const normals = new Float32Array(R1 * R1 * 3);
    const colors = new Float32Array(R1 * R1 * 3);
    let minH = Infinity;
    let maxH = -Infinity;
    for (let j = 0; j < R1; j++) {
      for (let i = 0; i < R1; i++) {
        const v = j * R1 + i;
        const h = hb[(j + 1) * RB + (i + 1)];
        heights[v] = h;
        minH = Math.min(minH, h);
        maxH = Math.max(maxH, h);
        const hl = hb[(j + 1) * RB + i];
        const hr = hb[(j + 1) * RB + i + 2];
        const hd = hb[j * RB + i + 1];
        const hu = hb[(j + 2) * RB + i + 1];
        let nx = hl - hr;
        let ny = 2 * step;
        let nz = hd - hu;
        const nl = Math.hypot(nx, ny, nz);
        nx /= nl;
        ny /= nl;
        nz /= nl;
        normals[v * 3] = nx;
        normals[v * 3 + 1] = ny;
        normals[v * 3 + 2] = nz;
        // curvature-based AO
        const lap = (hl + hr + hd + hu - 4 * h) / (step * step);
        const ao = clamp(1 - lap * 0.6, 0.55, 1.15);
        const x = x0 + i * step;
        const z = z0 + j * step;
        const c = this.terrainColor(x, z, h, ny, wts, v * 4, roadW[v], roadSurf[v]);
        colors[v * 3] = c[0] * ao;
        colors[v * 3 + 1] = c[1] * ao;
        colors[v * 3 + 2] = c[2] * ao;
      }
    }

    // --- surface grid (physics) ---
    let surface: Uint8Array | null = null;
    if (lod === 0) {
      surface = new Uint8Array(res * res);
      for (let j = 0; j < res; j++)
        for (let i = 0; i < res; i++) {
          const v = j * R1 + i;
          const ny = normals[v * 3 + 1];
          let best = 0;
          for (let b = 1; b < 4; b++) if (wts[v * 4 + b] > wts[v * 4 + best]) best = b;
          let s: Surface;
          if (ny < 0.8) s = Surface.Rock;
          else if (best === Biome.Desert) s = Surface.Sand;
          else if (best === Biome.Alpine) s = heights[v] > 120 ? Surface.Snow : Surface.Grass;
          else if (best === Biome.City) s = Surface.Concrete;
          else s = heights[v] < 3 ? Surface.Sand : Surface.Grass;
          if (roadW[v] > 0.8) s = roadSurf[v] ? Surface.Dirt : s === Surface.Sand ? Surface.Sand : Surface.Dirt;
          surface[j * res + i] = s;
        }
    }

    const biomeMix = new Float32Array(4);
    for (let v = 0; v < R1 * R1; v++) for (let b = 0; b < 4; b++) biomeMix[b] += wts[v * 4 + b] / (R1 * R1);

    // --- props ---
    const props = this.generateProps(cx, cz, lod, edges, heights, normals, wts, res);

    // --- road meshes ---
    const roadMeshes = this.generateRoadMeshes(cx, cz, lod, edges);

    // set pieces anchored in this chunk
    const setPieces: SetPiece[] = [];
    for (const e of edges)
      for (const p of e.setPieces)
        if (p.x >= x0 && p.x < x0 + CHUNK && p.z >= z0 && p.z < z0 + CHUNK) setPieces.push(p);

    return {
      cx, cz, lod, res, heights, normals, colors, surface, minH, maxH, props,
      road: roadMeshes.road,
      structure: roadMeshes.structure,
      rock: roadMeshes.rock,
      roadCollider: roadMeshes.collider,
      tunnelLights: roadMeshes.lights,
      setPieces, biomeMix,
      genMs: performance.now() - t0,
    };
  }

  private _col: RGB = [0, 0, 0];
  private terrainColor(x: number, z: number, h: number, ny: number, w: Float32Array, wo: number, road: number, dirtRoad: number): RGB {
    const c = this._col;
    c[0] = c[1] = c[2] = 0;
    const n1 = this.nDetail.noise(x * 0.02, z * 0.02) * 0.5 + 0.5;
    const n2 = this.nDetail.noise(x * 0.11 + 7, z * 0.11) * 0.5 + 0.5;
    const slope = 1 - ny;
    for (let b = 0; b < 4; b++) {
      const wb = w[wo + b];
      if (wb < 0.001) continue;
      const p = PAL[b];
      let r = lerp(p.base[0], p.alt[0], n1);
      let g = lerp(p.base[1], p.alt[1], n1);
      let bl = lerp(p.base[2], p.alt[2], n1);
      let rock = smoothstep(0.18, 0.4, slope);
      if (b === Biome.Desert) {
        // canyon strata
        const band = 0.5 + 0.5 * Math.sin(h * 0.9 + n1 * 2);
        const sr = lerp(p.rock[0], p.top[0], band * 0.6);
        const sg = lerp(p.rock[1], p.top[1], band * 0.6);
        const sb = lerp(p.rock[2], p.top[2], band * 0.6);
        rock = smoothstep(0.1, 0.3, slope);
        r = lerp(r, sr, rock);
        g = lerp(g, sg, rock);
        bl = lerp(bl, sb, rock);
      } else {
        r = lerp(r, p.rock[0], rock);
        g = lerp(g, p.rock[1], rock);
        bl = lerp(bl, p.rock[2], rock);
      }
      if (b === Biome.Alpine) {
        const snow = smoothstep(95, 125, h + n1 * 20) * smoothstep(0.45, 0.25, slope);
        r = lerp(r, p.top[0], snow);
        g = lerp(g, p.top[1], snow);
        bl = lerp(bl, p.top[2], snow);
      }
      if (b === Biome.Coast) {
        const beach = smoothstep(4, 1.5, h);
        r = lerp(r, p.top[0], beach);
        g = lerp(g, p.top[1], beach);
        bl = lerp(bl, p.top[2], beach);
      }
      if (b === Biome.City) {
        // grid of lighter pavement
        const gx = Math.abs(((x % 24) + 24) % 24 - 12) < 0.6 || Math.abs(((z % 24) + 24) % 24 - 12) < 0.6;
        if (gx) {
          r += 0.05;
          g += 0.05;
          bl += 0.07;
        }
      }
      c[0] += r * wb;
      c[1] += g * wb;
      c[2] += bl * wb;
    }
    // road shoulders: dusty
    if (road > 0) {
      const dr = dirtRoad ? 0.55 : 0.42, dg = dirtRoad ? 0.42 : 0.38, db = dirtRoad ? 0.3 : 0.34;
      const f = road * 0.7;
      c[0] = lerp(c[0], dr, f);
      c[1] = lerp(c[1], dg, f);
      c[2] = lerp(c[2], db, f);
    }
    const v = 0.9 + n2 * 0.2;
    c[0] *= v;
    c[1] *= v;
    c[2] *= v;
    return c;
  }

  private generateProps(
    cx: number, cz: number, lod: number, edges: RoadEdge[],
    heights: Float32Array, normals: Float32Array, wts: Float32Array, res: number,
  ): Float32Array {
    const out: number[] = [];
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    const R1 = res + 1;
    const step = CHUNK / res;
    const rng = new RNG(hash4(this.seed, cx, cz, 900));
    const dens = this.t.propDensity;

    const sampleH = (x: number, z: number) => {
      const fx = clamp((x - x0) / step, 0, res - 0.001);
      const fz = clamp((z - z0) / step, 0, res - 0.001);
      const i = Math.floor(fx), j = Math.floor(fz);
      const u = fx - i, v = fz - j;
      const a = heights[j * R1 + i], b = heights[j * R1 + i + 1];
      const c = heights[(j + 1) * R1 + i], d = heights[(j + 1) * R1 + i + 1];
      return lerp(lerp(a, b, u), lerp(c, d, u), v);
    };
    const vIdx = (x: number, z: number) => {
      const i = clamp(Math.round((x - x0) / step), 0, res);
      const j = clamp(Math.round((z - z0) / step), 0, res);
      return j * R1 + i;
    };
    // distance to nearest road edge (centreline minus halfW)
    const roadClear = (x: number, z: number, need: number) => {
      for (const e of edges) {
        if (x < e.minX - need - e.halfW || x > e.maxX + need + e.halfW || z < e.minZ - need - e.halfW || z > e.maxZ + need + e.halfW)
          continue;
        for (let q = 0; q < e.n; q += 2) {
          const dx = x - e.x[q], dz = z - e.z[q];
          const lim = e.halfW + need + 3;
          if (dx * dx + dz * dz < lim * lim) return false;
        }
      }
      return true;
    };
    const push = (type: Prop, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, variant = rng.next()) => {
      out.push(type, x, y, z, yaw, sx, sy, sz, variant);
    };

    // ---- natural scatter on a jittered grid ----
    const big = lod === 2;
    const cs = lod === 0 ? 7 : lod === 1 ? 9 : 14;
    const n = Math.floor(CHUNK / cs);
    for (let gj = 0; gj < n; gj++)
      for (let gi = 0; gi < n; gi++) {
        const x = x0 + (gi + rng.next()) * cs;
        const z = z0 + (gj + rng.next()) * cs;
        const r0 = rng.next();
        const vi = vIdx(x, z);
        const ny = normals[vi * 3 + 1];
        const y = sampleH(x, z);
        if (y < 1.2) continue;
        let b = 0;
        for (let k = 1; k < 4; k++) if (wts[vi * 4 + k] > wts[vi * 4 + b]) b = k;
        // forest clumping
        const clump = this.nDetail.noise(x * 0.006 + 50, z * 0.006) * 0.5 + 0.5;
        let type = -1;
        let s = 1;
        if (b === Biome.Alpine) {
          if (ny > 0.78 && y < 135 && r0 < (0.12 + clump * 0.55) * dens) {
            type = Prop.Pine;
            s = 0.7 + rng.next() * 0.8;
          } else if (r0 > 0.985) {
            type = Prop.Rock;
            s = 0.8 + rng.next() * 2.2;
          }
        } else if (b === Biome.Desert) {
          if (ny > 0.85 && r0 < 0.035 * dens) {
            type = Prop.Cactus;
            s = 0.7 + rng.next() * 0.7;
          } else if (r0 > 0.975) {
            type = Prop.Rock;
            s = 1 + rng.next() * 3;
          } else if (r0 > 0.94 && !big) {
            type = Prop.Bush;
            s = 0.5 + rng.next() * 0.6;
          }
        } else if (b === Biome.Coast) {
          if (ny > 0.85 && y < 30 && r0 < (0.03 + clump * 0.1) * dens) {
            type = Prop.Palm;
            s = 0.8 + rng.next() * 0.5;
          } else if (r0 > 0.97) {
            type = Prop.Rock;
            s = 0.8 + rng.next() * 2.5;
          } else if (r0 > 0.9 && !big) {
            type = Prop.Bush;
            s = 0.6 + rng.next() * 0.6;
          }
        }
        if (type < 0) continue;
        if (big && type !== Prop.Pine && type !== Prop.Rock && type !== Prop.Palm) continue;
        if (!roadClear(x, z, type === Prop.Rock ? 3 * s : 3)) continue;
        push(type, x, y - 0.15, z, rng.next() * Math.PI * 2, s, s * (0.85 + rng.next() * 0.3), s, b + rng.next() * 0.99);
      }

    // ---- city blocks ----
    {
      const bs = 34;
      const bi0 = Math.floor(x0 / bs), bj0 = Math.floor(z0 / bs);
      for (let bj = bj0; bj < bj0 + Math.ceil(CHUNK / bs) + 1; bj++)
        for (let bi = bi0; bi < bi0 + Math.ceil(CHUNK / bs) + 1; bi++) {
          const r = new RNG(hash4(this.seed, bi, bj, 4242));
          const x = (bi + 0.5) * bs + r.range(-3, 3);
          const z = (bj + 0.5) * bs + r.range(-3, 3);
          if (x < x0 || x >= x0 + CHUNK || z < z0 || z >= z0 + CHUNK) continue;
          const vi = vIdx(x, z);
          const city = wts[vi * 4 + Biome.City];
          if (city < 0.55) continue;
          if (r.next() > 0.85 * dens) continue;
          const w = r.range(14, 26);
          const d = r.range(14, 26);
          const centre = this.nBiome.noise(x * 0.002, z * 0.002) * 0.5 + 0.5;
          const hgt = (14 + Math.pow(r.next(), 2.2) * 110 * (0.4 + centre)) * (0.4 + 0.6 * city);
          if (!roadClear(x, z, Math.max(w, d) * 0.62 + 2)) continue;
          const y = Math.min(sampleH(x - w / 2, z - d / 2), sampleH(x + w / 2, z + d / 2), sampleH(x, z)) - 1;
          out.push(Prop.Building, x, y, z, 0, w, hgt, d, r.next());
          if (lod < 2 && hgt > 40 && r.next() < 0.35) {
            // rooftop billboard
            out.push(Prop.Billboard, x, y + hgt, z, r.next() < 0.5 ? 0 : Math.PI / 2, w * 0.8, 6, 1, r.next());
          }
        }
    }

    // ---- roadside props (lamps, fences, cones) ----
    if (lod < 2) {
      for (const e of edges) {
        const city = e.type === RoadType.Avenue;
        const hw = e.type === RoadType.Highway;
        if (!city && !hw) {
          // fences along some dirt / mountain roads
          if (lod === 0 && hashf(this.seed, e.ai, e.aj, 61) < 0.3) {
            for (let q = 6; q < e.n - 6; q += 3) {
              const x = e.x[q], z = e.z[q];
              if (x < x0 || x >= x0 + CHUNK || z < z0 || z >= z0 + CHUNK) continue;
              if (e.flags[q] & (RoadFlag.Bridge | RoadFlag.Tunnel)) continue;
              const side = hashf(this.seed, e.ai, e.aj, 62) < 0.5 ? 1 : -1;
              const off = e.halfW + 2.2;
              const px = x - e.tz[q] * off * side, pz = z + e.tx[q] * off * side;
              push(Prop.Fence, px, sampleH(px, pz), pz, Math.atan2(e.tx[q], e.tz[q]), 1, 1, 1);
            }
          }
          continue;
        }
        const spacing = city ? 10 : 14;
        for (let q = 4; q < e.n - 4; q += spacing) {
          const x = e.x[q], z = e.z[q];
          if (x < x0 || x >= x0 + CHUNK || z < z0 || z >= z0 + CHUNK) continue;
          if (e.flags[q] & (RoadFlag.Tunnel | RoadFlag.Stunt)) continue;
          const side = ((q / spacing) | 0) % 2 === 0 ? 1 : -1;
          const off = e.halfW + 1.6;
          const px = x - e.tz[q] * off * side;
          const pz = z + e.tx[q] * off * side;
          const bridge = (e.flags[q] & RoadFlag.Bridge) !== 0;
          const y = bridge ? e.h[q] + side * -off * 0 : sampleH(px, pz);
          push(Prop.Lamp, px, bridge ? e.h[q] : y, pz, Math.atan2(e.tx[q], e.tz[q]) + (side > 0 ? Math.PI / 2 : -Math.PI / 2), 1, 1, 1);
        }
      }
    }
    // ---- set-piece props (smashables live in the normal prop pipeline) ----
    for (const e of edges)
      for (const sp of e.setPieces) {
        if (sp.x < x0 || sp.x >= x0 + CHUNK || sp.z < z0 || sp.z >= z0 + CHUNK) continue;
        if (lod === 2) continue;
        const fx = Math.sin(sp.yaw), fz = Math.cos(sp.yaw);
        const rx = -fz, rz = fx;
        const at = (f: number, r: number, type: Prop, yaw = sp.yaw, s = 1, y = sp.y + 0.12) =>
          push(type, sp.x + fx * f + rx * r, y, sp.z + fz * f + rz * r, yaw, s, s, s);
        const r2 = new RNG(hash4(this.seed, Math.floor(sp.x), Math.floor(sp.z), 31));
        if (sp.kind === 'gas') {
          const off = sp.side * (e.halfW + 15);
          for (const df of [-5, 5]) for (const dr of [-3.5, 3.5]) at(df, off + dr, Prop.Pump, sp.yaw + Math.PI / 2);
          for (let k = 0; k < 6; k++) at(-11 + r2.range(-1, 1), off + sp.side * (6 + k * 0.9), Prop.Barrel, r2.next() * 6);
          for (let k = 0; k < 4; k++) at(10 + r2.range(-1, 1), off + sp.side * (5 + k * 1.3), Prop.Crate, r2.next() * 6);
        } else if (sp.kind === 'construction') {
          // close one lane with cones, barriers in the shoulder, junk everywhere
          const lane = sp.side * e.halfW * 0.5;
          for (let k = -9; k <= 9; k++) at(k * 3, lane - sp.side * (e.halfW * 0.45) + (Math.abs(k) > 7 ? (Math.abs(k) - 7) * sp.side * 1.6 : 0), Prop.Cone, r2.next() * 6);
          for (let k = -2; k <= 2; k++) at(k * 2.6, lane, Prop.Barrier);
          for (let k = 0; k < 5; k++) at(r2.range(-14, 14), sp.side * (e.halfW + 4 + r2.range(0, 6)), Prop.Crate, r2.next() * 6, 1, sampleH(sp.x, sp.z));
          for (let k = 0; k < 3; k++) at(r2.range(-14, 14), sp.side * (e.halfW + 3 + r2.range(0, 5)), Prop.Barrel, r2.next() * 6, 1, sampleH(sp.x, sp.z));
        } else if (sp.kind === 'ramp') {
          // cones funnel into the ramp lane (right-hand lane)
          for (const s2 of [0.05, 0.95]) for (let k = 0; k < 3; k++) at(-14 - k * 4, e.halfW * s2, Prop.Cone, 0);
        } else if (sp.kind === 'loop') {
          for (const s2 of [-1, 1]) for (let k = 0; k < 4; k++) at(-30 - k * 5, s2 * (e.halfW - 0.8), Prop.Cone, 0);
        }
      }
    return new Float32Array(out);
  }

  private generateRoadMeshes(cx: number, cz: number, lod: number, edges: RoadEdge[]) {
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    const inChunk = (x: number, z: number) => x >= x0 && x < x0 + CHUNK && z >= z0 && z < z0 + CHUNK;

    const road = new MeshBuilder(true);
    const struct = new MeshBuilder(false);
    const rock = new MeshBuilder(true);
    const col = new MeshBuilder(false);
    const lights: number[] = [];
    const stepQ = lod === 2 ? 3 : 1;

    for (const e of edges) {
      // find runs of samples whose segment midpoint is in this chunk
      for (let q = 0; q < e.n - 1; q += stepQ) {
        const q2 = Math.min(q + stepQ, e.n - 1);
        const mx = (e.x[q] + e.x[q2]) / 2;
        const mz = (e.z[q] + e.z[q2]) / 2;
        if (!inChunk(mx, mz)) continue;
        this.emitRoadSegment(e, q, q2, road, struct, rock, lod === 0 ? col : null, lights);
      }
    }
    // junction pads for nodes in this chunk
    const i0 = Math.floor(x0 / CELL) - 1, i1 = Math.floor((x0 + CHUNK) / CELL) + 1;
    const j0 = Math.floor(z0 / CELL) - 1, j1 = Math.floor((z0 + CHUNK) / CELL) + 1;
    const p = [0, 0];
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        this.node(i, j, p);
        if (!inChunk(p[0], p[1])) continue;
        const es = this.nodeEdges(i, j);
        if (es.length === 0) continue;
        let r = 0;
        let isDirt = true;
        for (const e of es) {
          r = Math.max(r, e.halfW);
          if (e.type !== RoadType.Dirt) isDirt = false;
        }
        const h = this.nodeHeight(i, j);
        const segs = lod === 2 ? 8 : 20;
        const rr = r + 1.5;
        const base = road.vcount;
        road.vert(p[0], h + 0.06, p[1], 0, 1, 0, 0.5, 0, isDirt ? 1 : 0.5, 0, 0);
        for (let k = 0; k <= segs; k++) {
          const a = (k / segs) * Math.PI * 2;
          road.vert(p[0] + Math.cos(a) * rr, h + 0.06, p[1] + Math.sin(a) * rr, 0, 1, 0, 0.5, 0, isDirt ? 1 : 0.5, 0, 0);
        }
        for (let k = 0; k < segs; k++) road.tri(base, base + 2 + k, base + 1 + k);
        if (lod === 0) {
          const cb = col.vcount;
          col.vert(p[0], h + 0.06, p[1], 0, 1, 0);
          for (let k = 0; k <= segs; k++) {
            const a = (k / segs) * Math.PI * 2;
            col.vert(p[0] + Math.cos(a) * rr, h + 0.06, p[1] + Math.sin(a) * rr, 0, 1, 0);
          }
          for (let k = 0; k < segs; k++) col.tri(cb, cb + 2 + k, cb + 1 + k);
        }
      }

    return {
      road: road.build(),
      structure: struct.build(),
      rock: rock.build(),
      collider: lod === 0 ? col.build() : null,
      lights: new Float32Array(lights),
    };
  }

  private emitRoadSegment(e: RoadEdge, q0: number, q1: number, road: MeshBuilder, struct: MeshBuilder, rock: MeshBuilder, col: MeshBuilder | null, lights: number[]) {
    const hw = e.halfW;
    const typeCode = e.type === RoadType.Dirt ? 1 : e.type === RoadType.Avenue ? 0.75 : e.type === RoadType.Mountain ? 0.25 : 0.5;
    const cross = (q: number, lat: number, out: number[]) => {
      const rx = -e.tz[q], rz = e.tx[q];
      out[0] = e.x[q] + rx * lat;
      out[2] = e.z[q] + rz * lat;
      out[1] = e.h[q] + lat * Math.tan(e.bank[q]);
    };
    const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0], D = [0, 0, 0];
    const lats = [-hw - 0.7, -hw, hw, hw + 0.7];
    // road surface: 3 strips (shoulder, lane area, shoulder)
    const base = road.vcount;
    for (const q of [q0, q1]) {
      const nx = -Math.sin(e.bank[q]) * -e.tz[q];
      const nz = -Math.sin(e.bank[q]) * e.tx[q];
      const ny = Math.cos(e.bank[q]);
      for (let k = 0; k < 4; k++) {
        cross(q, lats[k], A);
        const u = (lats[k] + hw) / (2 * hw);
        road.vert(A[0], A[1] + 0.02, A[2], nx, ny, nz, u, e.s[q] / (2 * hw), typeCode, hw, e.flags[q] & RoadFlag.Bridge ? 1 : 0);
      }
    }
    for (let k = 0; k < 3; k++) road.quad(base + k, base + k + 1, base + 4 + k + 1, base + 4 + k);
    if (col) {
      const cb = col.vcount;
      for (const q of [q0, q1])
        for (let k = 0; k < 4; k++) {
          cross(q, lats[k], A);
          col.vert(A[0], A[1] + 0.02, A[2], 0, 1, 0);
        }
      for (let k = 0; k < 3; k++) col.quad(cb + k, cb + k + 1, cb + 4 + k + 1, cb + 4 + k);
    }

    const f0 = e.flags[q0], f1 = e.flags[q1];
    // ---- bridge deck + rails + pillars ----
    if ((f0 | f1) & RoadFlag.Bridge) {
      const lw = hw + 0.7;
      for (const side of [-1, 1]) {
        // rail: low concrete wall
        cross(q0, side * lw, A);
        cross(q1, side * lw, B);
        struct.box4(A, B, 0.5, 1.1, side, e, q0);
        if (col) {
          const cb = col.vcount;
          col.vert(A[0], A[1], A[2], 0, 1, 0);
          col.vert(B[0], B[1], B[2], 0, 1, 0);
          col.vert(B[0], B[1] + 1.1, B[2], 0, 1, 0);
          col.vert(A[0], A[1] + 1.1, A[2], 0, 1, 0);
          col.quad(cb, cb + 1, cb + 2, cb + 3);
          col.quad(cb + 3, cb + 2, cb + 1, cb);
        }
      }
      // underside slab
      cross(q0, -lw, A);
      cross(q0, lw, B);
      cross(q1, lw, C);
      cross(q1, -lw, D);
      const sb = struct.vcount;
      struct.vert(A[0], A[1] - 1.2, A[2], 0, -1, 0);
      struct.vert(B[0], B[1] - 1.2, B[2], 0, -1, 0);
      struct.vert(C[0], C[1] - 1.2, C[2], 0, -1, 0);
      struct.vert(D[0], D[1] - 1.2, D[2], 0, -1, 0);
      struct.quad(sb, sb + 1, sb + 2, sb + 3);
      for (const side of [-1, 1]) {
        const a = side < 0 ? A : B;
        const c = side < 0 ? D : C;
        const s2 = struct.vcount;
        const nx = -e.tz[q0] * side, nz = e.tx[q0] * side;
        struct.vert(a[0], a[1], a[2], nx, 0, nz);
        struct.vert(c[0], c[1], c[2], nx, 0, nz);
        struct.vert(c[0], c[1] - 1.2, c[2], nx, 0, nz);
        struct.vert(a[0], a[1] - 1.2, a[2], nx, 0, nz);
        if (side > 0) struct.quad(s2, s2 + 1, s2 + 2, s2 + 3);
        else struct.quad(s2 + 3, s2 + 2, s2 + 1, s2);
      }
      // pillars
      if (f0 & RoadFlag.Bridge && q0 % 9 === 0) {
        for (const side of [-0.55, 0.55]) {
          cross(q0, side * hw, A);
          const ground = Math.min(e.raw[q0], A[1] - 2) - 6;
          struct.column(A[0], ground, A[2], A[1] - 1.2, 0.9);
        }
      }
    }

    // ---- tunnel shell ----
    if (f0 & RoadFlag.Tunnel && f1 & RoadFlag.Tunnel) {
      const segs = 10;
      const r = hw + 1.6;
      const sb = struct.vcount;
      for (const q of [q0, q1]) {
        const rx = -e.tz[q], rz = e.tx[q];
        for (let k = 0; k <= segs; k++) {
          const a = (k / segs) * Math.PI;
          const lx = Math.cos(a) * r;
          const ly = Math.sin(a) * (r * 0.75) ;
          const px = e.x[q] + rx * lx, pz = e.z[q] + rz * lx;
          const py = e.h[q] + ly - 0.5;
          // inward normal
          struct.vert(px, py, pz, -rx * Math.cos(a), -Math.sin(a), -rz * Math.cos(a));
        }
      }
      // outer rock skin so the tunnel reads as part of the hillside
      for (let k = 0; k < segs; k++) struct.quad(sb + k, sb + segs + 1 + k, sb + segs + 2 + k, sb + k + 1);
      const pal = PAL[e.biome] ?? PAL[0];
      const ob = rock.vcount;
      for (const q of [q0, q1]) {
        const rx = -e.tz[q], rz = e.tx[q];
        for (let k = 0; k <= segs; k++) {
          const a = (k / segs) * Math.PI;
          const bump = 1 + 0.18 * Math.sin(q * 1.7 + k * 2.3) * Math.sin(k * 1.1 + q * 0.6);
          const rr = (r + 4.5) * bump;
          const lx = Math.cos(a) * rr * 1.25;
          const ly = Math.sin(a) * rr * 0.9;
          const shade = 0.75 + 0.25 * Math.sin(q * 3.1 + k);
          rock.vert(e.x[q] + rx * lx, e.h[q] + ly - 1.2, e.z[q] + rz * lx, rx * Math.cos(a), Math.sin(a), rz * Math.cos(a), 0, 0, pal.rock[0] * shade, pal.rock[1] * shade, pal.rock[2] * shade);
        }
      }
      for (let k = 0; k < segs; k++) rock.quad(ob + k + 1, ob + segs + 2 + k, ob + segs + 1 + k, ob + k);
      if (col) {
        const cb = col.vcount;
        for (const q of [q0, q1]) {
          const rx = -e.tz[q], rz = e.tx[q];
          for (let k = 0; k <= segs; k++) {
            const a = (k / segs) * Math.PI;
            const lx = Math.cos(a) * r;
            const ly = Math.sin(a) * (r * 0.75);
            col.vert(e.x[q] + rx * lx, e.h[q] + ly - 0.5, e.z[q] + rz * lx, 0, 1, 0);
          }
        }
        for (let k = 0; k < segs; k++) {
          col.quad(cb + k, cb + segs + 1 + k, cb + segs + 2 + k, cb + k + 1);
        }
      }
      if (q0 % 6 === 0) lights.push(e.x[q0], e.h[q0] + r * 0.75 - 0.9, e.z[q0]);
    }
  }
}

// ---------------------------------------------------------------------------
class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  vcount = 0;
  constructor(private withUV: boolean) {}
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0, r = 0, g = 0, b = 0) {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    if (this.withUV) {
      this.uv.push(u, v);
      this.col.push(r, g, b);
    }
    return this.vcount++;
  }
  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }
  /** wall segment between A and B (on the deck), thickness t, height h */
  box4(A: number[], B: number[], t: number, h: number, side: number, e: RoadEdge, q: number) {
    const rx = -e.tz[q] * side, rz = e.tx[q] * side;
    const pts = [
      [A[0], A[1], A[2]], [B[0], B[1], B[2]],
      [B[0] + rx * t, B[1], B[2] + rz * t], [A[0] + rx * t, A[1], A[2] + rz * t],
    ];
    // inner face
    let b = this.vcount;
    this.vert(pts[0][0], pts[0][1], pts[0][2], -rx, 0, -rz);
    this.vert(pts[1][0], pts[1][1], pts[1][2], -rx, 0, -rz);
    this.vert(pts[1][0], pts[1][1] + h, pts[1][2], -rx, 0, -rz);
    this.vert(pts[0][0], pts[0][1] + h, pts[0][2], -rx, 0, -rz);
    if (side > 0) this.quad(b, b + 1, b + 2, b + 3);
    else this.quad(b + 3, b + 2, b + 1, b);
    // outer face
    b = this.vcount;
    this.vert(pts[3][0], pts[3][1] - 1.2, pts[3][2], rx, 0, rz);
    this.vert(pts[2][0], pts[2][1] - 1.2, pts[2][2], rx, 0, rz);
    this.vert(pts[2][0], pts[2][1] + h, pts[2][2], rx, 0, rz);
    this.vert(pts[3][0], pts[3][1] + h, pts[3][2], rx, 0, rz);
    if (side > 0) this.quad(b + 3, b + 2, b + 1, b);
    else this.quad(b, b + 1, b + 2, b + 3);
    // top
    b = this.vcount;
    this.vert(pts[0][0], pts[0][1] + h, pts[0][2], 0, 1, 0);
    this.vert(pts[1][0], pts[1][1] + h, pts[1][2], 0, 1, 0);
    this.vert(pts[2][0], pts[2][1] + h, pts[2][2], 0, 1, 0);
    this.vert(pts[3][0], pts[3][1] + h, pts[3][2], 0, 1, 0);
    if (side > 0) this.quad(b + 3, b + 2, b + 1, b);
    else this.quad(b, b + 1, b + 2, b + 3);
  }
  column(x: number, y0: number, z: number, y1: number, r: number) {
    const segs = 6;
    const b = this.vcount;
    for (let k = 0; k <= segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      const cx = Math.cos(a), sz = Math.sin(a);
      this.vert(x + cx * r, y0, z + sz * r, cx, 0, sz);
      this.vert(x + cx * r, y1, z + sz * r, cx, 0, sz);
    }
    for (let k = 0; k < segs; k++) this.quad(b + k * 2, b + k * 2 + 1, b + k * 2 + 3, b + k * 2 + 2);
  }
  build(): MeshBuffers | null {
    if (this.idx.length === 0) return null;
    return {
      position: new Float32Array(this.pos),
      normal: new Float32Array(this.nor),
      uv: this.withUV ? new Float32Array(this.uv) : undefined,
      color: this.withUV ? new Float32Array(this.col) : undefined,
      index: new Uint32Array(this.idx),
    };
  }
}
