// Streams terrain chunks around the player: worker generation, meshes, colliders, props.
import * as THREE from 'three';
import { RAPIER, Physics, G_WORLD, G_CAR, G_TRAFFIC, G_DEBRIS, groups } from '../core/Physics';
import { CHUNK, Prop, PROP_COUNT, PROP_STRIDE, Surface, type ChunkData, type MeshBuffers } from './types';
import { WorldGen } from './WorldGen';
import { makeConcreteMaterial, makeRoadMaterial, makeTerrainMaterial } from './Materials';
import { PropRenderer } from './PropRenderer';
import { PROP_PHYS } from './PropGeometry';
import type { SetPieces } from './SetPieces';

export interface BreakableRef {
  chunk: Chunk;
  index: number; // prop index
  collider: RAPIER.Collider | null;
  type: Prop;
}

export class Chunk {
  cx: number;
  cz: number;
  lod: number;
  data: ChunkData;
  group = new THREE.Group();
  colliders: RAPIER.Collider[] = [];
  hasPhysics = false;
  alive: Uint8Array; // per prop
  breakables: BreakableRef[] = [];
  propMatrices: Float32Array | null = null;
  setPieceObjs: { dispose(): void }[] = [];
  lastUsed = 0;
  constructor(d: ChunkData) {
    this.cx = d.cx;
    this.cz = d.cz;
    this.lod = d.lod;
    this.data = d;
    this.alive = new Uint8Array(d.props.length / PROP_STRIDE).fill(1);
  }
  surfaceAt(x: number, z: number): number {
    const s = this.data.surface;
    if (!s) return Surface.Grass;
    const res = this.data.res;
    const i = Math.min(res - 1, Math.max(0, Math.floor(((x - this.cx * CHUNK) / CHUNK) * res)));
    const j = Math.min(res - 1, Math.max(0, Math.floor(((z - this.cz * CHUNK) / CHUNK) * res)));
    return s[j * res + i];
  }
  heightAt(x: number, z: number): number {
    const d = this.data;
    const res = d.res;
    const R1 = res + 1;
    const fx = Math.min(res - 1e-4, Math.max(0, ((x - this.cx * CHUNK) / CHUNK) * res));
    const fz = Math.min(res - 1e-4, Math.max(0, ((z - this.cz * CHUNK) / CHUNK) * res));
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const h = d.heights;
    const a = h[j * R1 + i], b = h[j * R1 + i + 1], c = h[(j + 1) * R1 + i], e = h[(j + 1) * R1 + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + e * u) * v;
  }
}

const key = (cx: number, cz: number) => `${cx},${cz}`;

interface Pending {
  cx: number;
  cz: number;
  lod: number;
}

export class ChunkManager {
  readonly gen: WorldGen;
  chunks = new Map<string, Chunk>();
  private pending = new Map<string, Pending>();
  private workers: Worker[] = [];
  private busy: number[] = [];
  private reqId = 0;
  private callbacks = new Map<number, (d: ChunkData) => void>();
  private geoCache = new Map<number, THREE.BufferGeometry>();
  root = new THREE.Group();
  terrainMat = makeTerrainMaterial();
  roadMat = makeRoadMaterial();
  concreteMat = makeConcreteMaterial();
  rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
  tunnelLightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.8, 0.5).multiplyScalar(4) });
  props: PropRenderer;
  viewRadius = 6;
  lod0Radius = 2;
  lod1Radius = 4;
  physRadius = 1;
  centerCx = 1e9;
  centerCz = 1e9;
  private frame = 0;
  private propsDirty = true;
  setPieces: SetPieces | null = null;
  stats = { genMs: 0, built: 0, loaded: 0 };
  private tunnelLightGeo = new THREE.BoxGeometry(1.4, 0.15, 0.5);

  constructor(
    seed: number,
    private physics: Physics,
    scene: THREE.Scene,
  ) {
    this.gen = new WorldGen(seed);
    scene.add(this.root);
    this.props = new PropRenderer(scene);
    const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./worldgen.worker.ts', import.meta.url), { type: 'module' });
      w.postMessage({ type: 'init', seed, tunables: this.gen.t });
      w.onmessage = (ev) => {
        const { id, data } = ev.data as { id: number; data: ChunkData };
        this.busy[i]--;
        const cb = this.callbacks.get(id);
        this.callbacks.delete(id);
        cb?.(data);
      };
      this.workers.push(w);
      this.busy.push(0);
    }
  }

  /** Drop everything (used when world-gen tunables change). */
  reset() {
    for (const [k, c] of [...this.chunks]) this.unload(k, c);
    this.chunks.clear();
    this.pending.clear();
    this.queue = [];
    this.callbacks.clear();
    this.busy.fill(0);
    this.centerCx = 1e9;
  }

  setTunables(t: Partial<WorldGen['t']>) {
    Object.assign(this.gen.t, t);
    (this.gen as unknown as { edgeCache: Map<string, unknown> }).edgeCache.clear();
    for (const w of this.workers) w.postMessage({ type: 'init', seed: this.gen.seed, tunables: this.gen.t });
  }

  /** Synchronously generate the chunks around a point (used at spawn so physics exists immediately). */
  warmup(x: number, z: number) {
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const d = this.gen.generateChunk(cx + dx, cz + dz, 0);
        this.install(d);
      }
    this.update(x, z, 0, 0, true);
  }

  /** Make sure the chunks around (x,z) are loaded at lod 0 with physics, synchronously. */
  ensureSync(x: number, z: number) {
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.chunks.get(key(cx + dx, cz + dz));
        if (!c || c.lod !== 0) this.install(this.gen.generateChunk(cx + dx, cz + dz, 0));
      }
    this.centerCx = 1e9;
    this.update(x, z, 0, 0, true);
  }

  private desiredLod(dx: number, dz: number): number {
    const d = Math.max(Math.abs(dx), Math.abs(dz));
    if (d <= this.lod0Radius) return 0;
    if (d <= this.lod1Radius) return 1;
    return 2;
  }

  update(px: number, pz: number, vx: number, vz: number, force = false) {
    this.frame++;
    const cx = Math.floor(px / CHUNK);
    const cz = Math.floor(pz / CHUNK);
    const moved = cx !== this.centerCx || cz !== this.centerCz;
    this.centerCx = cx;
    this.centerCz = cz;

    if (moved || force || this.frame % 15 === 0) {
      // compute wanted set
      const want: { cx: number; cz: number; lod: number; pri: number }[] = [];
      const R = this.viewRadius;
      const sp = Math.hypot(vx, vz);
      const fx = sp > 1 ? vx / sp : 0;
      const fz = sp > 1 ? vz / sp : 0;
      for (let dz = -R; dz <= R; dz++)
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dz * dz > (R + 0.5) * (R + 0.5)) continue;
          const lod = this.desiredLod(dx, dz);
          const k = key(cx + dx, cz + dz);
          const c = this.chunks.get(k);
          const p = this.pending.get(k);
          if (c && c.lod === lod) continue;
          if (p && p.lod === lod) continue;
          const dist = Math.hypot(dx, dz) - (dx * fx + dz * fz) * 0.6;
          // missing chunks first, then upgrades
          const pri = dist + (c ? (c.lod > lod ? 2 : 6) : 0);
          want.push({ cx: cx + dx, cz: cz + dz, lod, pri });
        }
      want.sort((a, b) => a.pri - b.pri);
      this.queue = want;
      // unload far
      for (const [k, c] of this.chunks) {
        const d = Math.max(Math.abs(c.cx - cx), Math.abs(c.cz - cz));
        if (Math.hypot(c.cx - cx, c.cz - cz) > R + 1.5 || d > R + 1) this.unload(k, c);
      }
    }
    this.pump();

    // physics on/off
    for (const c of this.chunks.values()) {
      const d = Math.max(Math.abs(c.cx - cx), Math.abs(c.cz - cz));
      const needPhys = d <= this.physRadius && c.lod === 0;
      if (needPhys && !c.hasPhysics) this.addPhysics(c);
      else if (!needPhys && c.hasPhysics && d > this.physRadius + 1) this.removePhysics(c);
    }

    if (this.propsDirty || moved) {
      this.props.rebuild(this.chunks.values(), cx, cz);
      this.propsDirty = false;
    }
  }

  private queue: { cx: number; cz: number; lod: number; pri: number }[] = [];

  private pump() {
    while (this.queue.length) {
      // find least busy worker
      let wi = 0;
      for (let i = 1; i < this.workers.length; i++) if (this.busy[i] < this.busy[wi]) wi = i;
      if (this.busy[wi] >= 2) return;
      const r = this.queue.shift()!;
      const k = key(r.cx, r.cz);
      const ex = this.chunks.get(k);
      if (ex && ex.lod === r.lod) continue;
      const id = ++this.reqId;
      this.pending.set(k, { cx: r.cx, cz: r.cz, lod: r.lod });
      this.busy[wi]++;
      this.callbacks.set(id, (d) => {
        const p = this.pending.get(k);
        if (p && p.lod === d.lod) this.pending.delete(k);
        // ignore if out of range now
        if (Math.max(Math.abs(d.cx - this.centerCx), Math.abs(d.cz - this.centerCz)) > this.viewRadius + 1) return;
        this.install(d);
      });
      this.workers[wi].postMessage({ type: 'chunk', cx: r.cx, cz: r.cz, lod: r.lod, id });
    }
  }

  private gridIndex(res: number): THREE.BufferAttribute {
    const cached = this.geoCache.get(res);
    if (cached) return cached.index!;
    const R1 = res + 1;
    const idx: number[] = [];
    for (let j = 0; j < res; j++)
      for (let i = 0; i < res; i++) {
        const a = j * R1 + i, b = a + 1, c = a + R1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    // skirts: perimeter verts duplicated after the grid
    const base = R1 * R1;
    const per = this.perimeter(res);
    for (let k = 0; k < per.length; k++) {
      const a = per[k], b = per[(k + 1) % per.length];
      const sa = base + k, sb = base + ((k + 1) % per.length);
      idx.push(a, sa, b, b, sa, sb);
    }
    const g = new THREE.BufferGeometry();
    g.setIndex(idx);
    this.geoCache.set(res, g);
    return g.index!;
  }

  private perimCache = new Map<number, number[]>();
  private perimeter(res: number): number[] {
    let p = this.perimCache.get(res);
    if (p) return p;
    const R1 = res + 1;
    p = [];
    for (let i = 0; i < res; i++) p.push(i); // bottom row z=0, +x
    for (let j = 0; j < res; j++) p.push(j * R1 + res); // right col
    for (let i = res; i > 0; i--) p.push(res * R1 + i); // top row -x
    for (let j = res; j > 0; j--) p.push(j * R1); // left col
    this.perimCache.set(res, p);
    return p;
  }

  private meshFrom(b: MeshBuffers, mat: THREE.Material): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(b.normal, 3));
    if (b.uv) g.setAttribute('uv', new THREE.BufferAttribute(b.uv, 2));
    if (b.color) g.setAttribute('color', new THREE.BufferAttribute(b.color, 3));
    g.setIndex(new THREE.BufferAttribute(b.index, 1));
    g.computeBoundingSphere();
    return new THREE.Mesh(g, mat);
  }

  private install(d: ChunkData) {
    const k = key(d.cx, d.cz);
    const old = this.chunks.get(k);
    const c = new Chunk(d);
    this.stats.genMs = this.stats.genMs * 0.9 + d.genMs * 0.1;
    this.stats.built++;
    // carry over destroyed props if same lod & layout
    if (old && old.data.props.length === d.props.length) c.alive.set(old.alive);

    // terrain mesh
    const res = d.res;
    const R1 = res + 1;
    const step = CHUNK / res;
    const per = this.perimeter(res);
    const nv = R1 * R1 + per.length;
    const pos = new Float32Array(nv * 3);
    const nor = new Float32Array(nv * 3);
    const col = new Float32Array(nv * 3);
    for (let j = 0; j < R1; j++)
      for (let i = 0; i < R1; i++) {
        const v = j * R1 + i;
        pos[v * 3] = i * step;
        pos[v * 3 + 1] = d.heights[v];
        pos[v * 3 + 2] = j * step;
      }
    nor.set(d.normals);
    col.set(d.colors);
    for (let k2 = 0; k2 < per.length; k2++) {
      const v = per[k2];
      const s = R1 * R1 + k2;
      pos[s * 3] = pos[v * 3];
      pos[s * 3 + 1] = pos[v * 3 + 1] - 6;
      pos[s * 3 + 2] = pos[v * 3 + 2];
      nor[s * 3] = d.normals[v * 3];
      nor[s * 3 + 1] = d.normals[v * 3 + 1];
      nor[s * 3 + 2] = d.normals[v * 3 + 2];
      col[s * 3] = d.colors[v * 3];
      col[s * 3 + 1] = d.colors[v * 3 + 1];
      col[s * 3 + 2] = d.colors[v * 3 + 2];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(this.gridIndex(res));
    g.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(CHUNK / 2, (d.minH + d.maxH) / 2, CHUNK / 2),
      Math.hypot(CHUNK / 2, CHUNK / 2, (d.maxH - d.minH) / 2 + 6),
    );
    const terrain = new THREE.Mesh(g, this.terrainMat);
    terrain.position.set(d.cx * CHUNK, 0, d.cz * CHUNK);
    terrain.receiveShadow = true;
    terrain.castShadow = d.lod === 0;
    terrain.matrixAutoUpdate = false;
    terrain.updateMatrix();
    c.group.add(terrain);

    if (d.road) {
      const m = this.meshFrom(d.road, this.roadMat);
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      c.group.add(m);
    }
    if (d.structure) {
      const m = this.meshFrom(d.structure, this.concreteMat);
      m.receiveShadow = true;
      m.castShadow = d.lod === 0;
      m.matrixAutoUpdate = false;
      c.group.add(m);
    }
    if (d.rock) {
      const m = this.meshFrom(d.rock, this.rockMat);
      m.receiveShadow = true;
      m.castShadow = d.lod === 0;
      m.matrixAutoUpdate = false;
      c.group.add(m);
    }
    if (d.tunnelLights.length) {
      const n = d.tunnelLights.length / 3;
      const im = new THREE.InstancedMesh(this.tunnelLightGeo, this.tunnelLightMat, n);
      const mtx = new THREE.Matrix4();
      for (let i = 0; i < n; i++) {
        mtx.makeTranslation(d.tunnelLights[i * 3], d.tunnelLights[i * 3 + 1], d.tunnelLights[i * 3 + 2]);
        im.setMatrixAt(i, mtx);
      }
      im.computeBoundingSphere();
      c.group.add(im);
    }
    c.group.matrixAutoUpdate = false;

    if (old) this.unload(k, old, c);
    this.chunks.set(k, c);
    this.root.add(c.group);
    this.computePropMatrices(c);
    this.propsDirty = true;
    this.setPieces?.onChunkLoaded(c);
  }

  private computePropMatrices(c: Chunk) {
    const p = c.data.props;
    const n = p.length / PROP_STRIDE;
    const m = new Float32Array(n * 16);
    const mtx = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const t = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      const o = i * PROP_STRIDE;
      t.set(p[o + 1], p[o + 2], p[o + 3]);
      q.setFromAxisAngle(up, p[o + 4]);
      s.set(p[o + 5], p[o + 6], p[o + 7]);
      mtx.compose(t, q, s);
      mtx.toArray(m, i * 16);
    }
    c.propMatrices = m;
  }

  private unload(k: string, c: Chunk, replacement?: Chunk) {
    this.root.remove(c.group);
    c.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
    });
    if (c.hasPhysics) this.removePhysics(c);
    this.setPieces?.onChunkUnloaded(c, replacement);
    if (!replacement) this.chunks.delete(k);
    this.propsDirty = true;
  }

  private addPhysics(c: Chunk) {
    const d = c.data;
    const w = this.physics.world;
    const res = d.res;
    const R1 = res + 1;
    // transpose to column-major (x-major) for rapier
    const hf = new Float32Array(R1 * R1);
    for (let j = 0; j < R1; j++) for (let i = 0; i < R1; i++) hf[j + i * R1] = d.heights[j * R1 + i];
    const desc = RAPIER.ColliderDesc.heightfield(res, res, hf, { x: CHUNK, y: 1, z: CHUNK })
      .setTranslation(c.cx * CHUNK + CHUNK / 2, 0, c.cz * CHUNK + CHUNK / 2)
      .setFriction(0.6)
      .setCollisionGroups(groups(G_WORLD, G_CAR | G_TRAFFIC | G_DEBRIS));
    const col = w.createCollider(desc);
    this.physics.tag(col, { kind: 'terrain', chunk: c });
    c.colliders.push(col);

    if (d.roadCollider) {
      const rc = w.createCollider(
        RAPIER.ColliderDesc.trimesh(d.roadCollider.position, d.roadCollider.index)
          .setFriction(0.6)
          .setCollisionGroups(groups(G_WORLD, G_CAR | G_TRAFFIC | G_DEBRIS)),
      );
      this.physics.tag(rc, { kind: 'road', chunk: c });
      c.colliders.push(rc);
    }

    // props
    const p = d.props;
    const n = p.length / PROP_STRIDE;
    c.breakables = [];
    for (let i = 0; i < n; i++) {
      if (!c.alive[i]) continue;
      const o = i * PROP_STRIDE;
      const type = p[o] as Prop;
      const ph = PROP_PHYS[type];
      if (!ph || ph.shape === 'none') continue;
      const sx = p[o + 5], sy = p[o + 6], sz = p[o + 7];
      let cd: RAPIER.ColliderDesc;
      if (ph.shape === 'cyl') cd = RAPIER.ColliderDesc.cylinder(ph.hy * sy, ph.hx * sx);
      else if (ph.shape === 'ball') cd = RAPIER.ColliderDesc.ball(ph.hx * sx);
      else cd = RAPIER.ColliderDesc.cuboid(ph.hx * sx, ph.hy * sy, ph.hz * sz);
      const yaw = p[o + 4];
      cd.setTranslation(p[o + 1], p[o + 2] + ph.oy * sy, p[o + 3])
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
        .setCollisionGroups(groups(G_WORLD, G_CAR | G_TRAFFIC | G_DEBRIS));
      const breakable = ph.breakSpeed < Infinity;
      if (breakable) cd.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const col = w.createCollider(cd);
      if (breakable) {
        const ref: BreakableRef = { chunk: c, index: i, collider: col, type };
        c.breakables.push(ref);
        this.physics.tag(col, { kind: 'breakable', ref });
      } else this.physics.tag(col, { kind: 'static' });
      c.colliders.push(col);
    }
    c.hasPhysics = true;
    this.setPieces?.onChunkPhysics(c, true);
  }

  private removePhysics(c: Chunk) {
    for (const col of c.colliders) this.physics.removeCollider(col);
    c.colliders = [];
    for (const b of c.breakables) b.collider = null;
    c.breakables = [];
    c.hasPhysics = false;
    this.setPieces?.onChunkPhysics(c, false);
  }

  /** Remove a prop instance (smashed). */
  killProp(c: Chunk, index: number) {
    c.alive[index] = 0;
    if (c.propMatrices) {
      // zero scale
      for (let k = 0; k < 16; k++) c.propMatrices[index * 16 + k] = 0;
    }
    this.propsDirty = true;
  }

  chunkAt(x: number, z: number): Chunk | undefined {
    return this.chunks.get(key(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
  }

  /** Terrain height from loaded data (falls back to the generator). */
  heightAt(x: number, z: number): number {
    const c = this.chunkAt(x, z);
    if (c) return c.heightAt(x, z);
    return this.gen.baseHeight(x, z);
  }

  ready(x: number, z: number): boolean {
    const c = this.chunkAt(x, z);
    return !!c && c.hasPhysics;
  }

  dispose() {
    for (const w of this.workers) w.terminate();
  }

  get loadedCount() {
    return this.chunks.size;
  }
  get pendingCount() {
    return this.pending.size + this.queue.length;
  }
}

export { PROP_COUNT };
