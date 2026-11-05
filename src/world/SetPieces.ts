// Builds set-piece structures (loops, ramps, half-pipes, gas stations, construction kickers) per chunk.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RAPIER, Physics, G_WORLD, G_CAR, G_TRAFFIC, G_DEBRIS, groups } from '../core/Physics';
import type { Chunk } from './ChunkManager';
import type { SetPiece } from './types';
import { worldUniforms } from './Materials';

interface Built {
  group: THREE.Group;
  colliderSrc: { pos: Float32Array; idx: Uint32Array }[];
  boxes: { c: THREE.Vector3; h: THREE.Vector3; q: THREE.Quaternion }[];
  colliders: RAPIER.Collider[];
  rail?: THREE.Vector3[];
  railAxis?: THREE.Vector3;
}

/** Soft rail: given a position, returns the nearest centreline point and the local tangent. */
export interface Rail {
  nearest(p: THREE.Vector3, outPoint: THREE.Vector3, outTangent: THREE.Vector3): number;
  axis: THREE.Vector3;
}

function makeRail(pts: THREE.Vector3[], axis: THREE.Vector3): Rail {
  return {
    axis,
    nearest(p, outPoint, outTangent) {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = pts[i].distanceToSquared(p);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      outPoint.copy(pts[best]);
      const a = pts[Math.max(0, best - 1)];
      const b = pts[Math.min(pts.length - 1, best + 1)];
      outTangent.subVectors(b, a).normalize();
      return Math.sqrt(bd);
    },
  };
}

const neonMat = (c: number, k = 3) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k) });

function stripeMaterial(a: number, b: number, scale: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uA = { value: new THREE.Color(a) };
    sh.uniforms.uB = { value: new THREE.Color(b) };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvLP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uA; uniform vec3 uB; varying vec3 vLP;')
      .replace('#include <color_fragment>', `#include <color_fragment>\n diffuseColor.rgb = mix(uA, uB, step(0.5, fract((vLP.x + vLP.y + vLP.z) * ${scale.toFixed(2)})));`);
  };
  return m;
}

function loopMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = worldUniforms.uTime;
    sh.uniforms.uNight = worldUniforms.uNight;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aUV;\nvarying vec2 vUV2;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvUV2 = aUV;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uNight; varying vec2 vUV2;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float edge = step(0.92, abs(vUV2.x*2.0-1.0));
        float chevron = step(0.5, fract(vUV2.y*0.25 - abs(vUV2.x-0.5)*0.6 - uTime*0.6));
        diffuseColor.rgb = mix(vec3(0.12,0.12,0.15), vec3(0.18,0.16,0.22), chevron);
        vec3 em = edge * mix(vec3(1.0,0.2,0.9), vec3(0.2,0.9,1.0), step(0.5, fract(vUV2.y*0.05 + uTime*0.5))) * (1.5 + uNight*3.0);
        em += (1.0-edge) * chevron * vec3(0.05,0.3,0.4) * uNight;`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += em;');
  };
  return m;
}

export class SetPieces {
  private built = new Map<string, Built>();
  private byChunk = new Map<Chunk, string[]>();
  private mats = {
    ramp: stripeMaterial(0xffc21a, 0x111111, 0.5),
    concrete: new THREE.MeshStandardMaterial({ color: 0x9a9690, roughness: 0.9 }),
    loop: loopMaterial(),
    wood: new THREE.MeshStandardMaterial({ color: 0x8a6438, roughness: 0.85, side: THREE.DoubleSide }),
    pipe: new THREE.MeshStandardMaterial({ color: 0xb8c4cc, roughness: 0.35, metalness: 0.6, side: THREE.DoubleSide }),
    white: new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.5 }),
    red: new THREE.MeshStandardMaterial({ color: 0xc81e1e, roughness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x1a2a3a, roughness: 0.1, metalness: 0.5 }),
    neonPink: neonMat(0xff3df2),
    neonCyan: neonMat(0x2ef2ff),
  };
  private signTex: THREE.CanvasTexture;
  /** local z of each loop's entry (for tests / AI) */
  loopEntries = new Map<SetPiece, number>();

  constructor(
    private physics: Physics,
    private scene: THREE.Scene,
  ) {
    const cv = document.createElement('canvas');
    cv.width = 256;
    cv.height = 64;
    const c = cv.getContext('2d')!;
    c.fillStyle = '#c81e1e';
    c.fillRect(0, 0, 256, 64);
    c.fillStyle = '#fff';
    c.font = 'bold 44px sans-serif';
    c.textAlign = 'center';
    c.fillText('FUEL · 24H', 128, 48);
    this.signTex = new THREE.CanvasTexture(cv);
    this.signTex.colorSpace = THREE.SRGBColorSpace;
  }

  private key(sp: SetPiece) {
    return `${sp.edgeKey}#${sp.idx}#${sp.kind}`;
  }

  onChunkLoaded(c: Chunk) {
    if (c.lod > 1) return;
    const keys: string[] = [];
    for (const sp of c.data.setPieces) {
      const k = this.key(sp);
      keys.push(k);
      if (this.built.has(k)) continue;
      const b = this.build(sp);
      if (!b) continue;
      this.scene.add(b.group);
      this.built.set(k, b);
    }
    this.byChunk.set(c, keys);
  }

  onChunkUnloaded(c: Chunk, replacement?: Chunk) {
    const keys = this.byChunk.get(c);
    this.byChunk.delete(c);
    if (!keys) return;
    if (replacement && replacement.lod <= 1) return; // keep: the replacement re-registers same keys
    for (const k of keys) {
      const b = this.built.get(k);
      if (!b) continue;
      this.scene.remove(b.group);
      b.group.traverse((o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.dispose());
      for (const col of b.colliders) this.physics.removeCollider(col);
      this.built.delete(k);
    }
  }

  onChunkPhysics(c: Chunk, on: boolean) {
    const keys = this.byChunk.get(c) ?? c.data.setPieces.map((sp) => this.key(sp));
    for (const k of keys) {
      const b = this.built.get(k);
      if (!b) continue;
      if (on && b.colliders.length === 0) {
        const w = this.physics.world;
        const grp = groups(G_WORLD, G_CAR | G_TRAFFIC | G_DEBRIS);
        const rail = b.rail && b.railAxis ? makeRail(b.rail, b.railAxis) : undefined;
        for (const src of b.colliderSrc) {
          const col = w.createCollider(RAPIER.ColliderDesc.trimesh(src.pos, src.idx).setFriction(0.8).setCollisionGroups(grp));
          this.physics.tag(col, { kind: 'setpiece', ref: rail ? { rail } : undefined });
          b.colliders.push(col);
        }
        for (const bx of b.boxes) {
          const col = w.createCollider(
            RAPIER.ColliderDesc.cuboid(bx.h.x, bx.h.y, bx.h.z).setTranslation(bx.c.x, bx.c.y, bx.c.z).setRotation(bx.q).setCollisionGroups(grp),
          );
          this.physics.tag(col, { kind: 'setpiece' });
          b.colliders.push(col);
        }
      } else if (!on && b.colliders.length) {
        for (const col of b.colliders) this.physics.removeCollider(col);
        b.colliders = [];
      }
    }
  }

  /** all loops/ramps nearby for minimap & events */
  get pieces() {
    return this.built;
  }

  private build(sp: SetPiece): Built | null {
    const group = new THREE.Group();
    const b: Built = { group, colliderSrc: [], boxes: [], colliders: [] };
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), sp.yaw);
    const origin = new THREE.Vector3(sp.x, sp.y, sp.z);
    const toWorld = (g: THREE.BufferGeometry) => {
      const m = new THREE.Matrix4().compose(origin, q, new THREE.Vector3(1, 1, 1));
      const gg = g.clone().applyMatrix4(m);
      return gg;
    };
    const addMesh = (g: THREE.BufferGeometry, mat: THREE.Material, collide: boolean, shadow = true) => {
      const wg = toWorld(g);
      const mesh = new THREE.Mesh(wg, mat);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      group.add(mesh);
      if (collide) {
        const ng = wg.index ? wg : wg;
        const pos = new Float32Array(ng.attributes.position.array);
        const idx = ng.index ? new Uint32Array(ng.index.array) : new Uint32Array(pos.length / 3).map((_, i) => i);
        b.colliderSrc.push({ pos, idx });
      }
      return mesh;
    };
    const addBox = (lx: number, ly: number, lz: number, hx: number, hy: number, hz: number, mat: THREE.Material | null, collide = true) => {
      const local = new THREE.Vector3(lx, ly, lz);
      const c = local.clone().applyQuaternion(q).add(origin);
      if (mat) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mat);
        m.position.copy(c);
        m.quaternion.copy(q);
        m.castShadow = true;
        m.receiveShadow = true;
        group.add(m);
      }
      if (collide) b.boxes.push({ c, h: new THREE.Vector3(hx, hy, hz), q: q.clone() });
    };
    // local frame: +z along road, +x = left of travel (three.js convention), right = -x
    const side = -sp.side; // convert "right-positive" side to local x

    switch (sp.kind) {
      case 'ramp': {
        const L = 16 + sp.param * 6;
        const W = Math.min(7, sp.halfW * 0.95);
        const H = 3 + sp.param * 1.6;
        const lane = -sp.halfW * 0.5; // right-hand lane (local -x is right of travel)
        addMesh(kicker(L, W, H, 14, 0.5).translate(lane, 0, 0), this.mats.ramp, true);
        // floodlights on the lip
        addBox(lane + W / 2 + 0.3, H + 0.4, L / 2, 0.15, 0.4, 0.15, this.mats.neonCyan, false);
        addBox(lane - W / 2 - 0.3, H + 0.4, L / 2, 0.15, 0.4, 0.15, this.mats.neonCyan, false);
        break;
      }
      case 'loop': {
        const R = 12 + sp.param * 3;
        const g = loopGeometry(R, 5.8, 4.7);
        const bb = g.boundingBox!;
        const H = bb.max.y;
        // centre the loop on the piece
        const cz = (bb.min.z + bb.max.z) / 2;
        g.translate(0, 0, -cz);
        this.loopEntries.set(sp, -cz - 14);
        addMesh(g, this.mats.loop, true);
        b.rail = (g.userData.rail as THREE.Vector3[]).map((v) => v.clone().setZ(v.z - cz).applyQuaternion(q).add(origin));
        b.railAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
        // a pair of support towers and a neon gantry
        for (const s of [-1, 1]) addBox(s * 9, H / 2, 0, 0.5, H / 2, 0.5, this.mats.pipe, true);
        addBox(0, H + 1.2, 0, 9.5, 0.4, 0.5, this.mats.pipe, false);
        addBox(0, H + 2.2, 0, 6, 0.8, 0.1, this.mats.neonPink, false);
        break;
      }
      case 'halfpipe': {
        const off = side * 28;
        const g = halfpipeGeometry(50, 9, 7);
        g.translate(off, -0.2, 0);
        addMesh(g, this.mats.pipe, true);
        break;
      }
      case 'gas': {
        const off = side * (sp.halfW + 15);
        // pad
        addBox(off, -1.4, 0, 18, 1.5, 12, this.mats.concrete, true);
        // canopy
        for (const df of [-7, 7]) for (const dr of [-5, 5]) addBox(off + dr, 2.8, df, 0.25, 2.8, 0.25, this.mats.white, true);
        addBox(off, 5.8, 0, 7.5, 0.35, 10, this.mats.white, true);
        addBox(off, 5.8, 10.05, 7.5, 0.36, 0.05, this.mats.neonPink, false);
        addBox(off, 5.8, -10.05, 7.5, 0.36, 0.05, this.mats.neonPink, false);
        // shop
        const so = off + side * 12;
        addBox(so, 2.5, 0, 4, 2.5, 7, this.mats.white, true);
        addBox(so - side * 4.02, 1.6, 0, 0.05, 1, 5, this.mats.glass, false);
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(8, 2), new THREE.MeshBasicMaterial({ map: this.signTex, side: THREE.DoubleSide }));
        sign.position.copy(new THREE.Vector3(so - side * 4.1, 5.8, 0).applyQuaternion(q).add(origin));
        sign.quaternion.copy(q).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
        group.add(sign);
        // tall price pylon
        addBox(off + side * 10, 6, 14, 0.4, 6, 0.4, this.mats.red, true);
        addBox(off + side * 10, 12.5, 14, 1.8, 1.2, 0.3, this.mats.neonCyan, false);
        break;
      }
      case 'construction': {
        const lane = side * sp.halfW * 0.5;
        addMesh(kicker(7, 3.2, 1.5, 6, 0.6).translate(lane, 0, 14), this.mats.wood, true);
        // crane-ish tower off road
        const off = side * 18;
        addBox(off, 9, 0, 0.6, 9, 0.6, this.mats.ramp, true);
        addBox(off - side * 6, 18.2, 0, 8, 0.4, 0.4, this.mats.ramp, false);
        addBox(off - side * 12, 14, 0, 0.05, 4, 0.05, this.mats.pipe, false);
        addBox(off - side * 12, 9.5, 0, 1.2, 0.6, 1.2, this.mats.concrete, false);
        break;
      }
      default:
        return null;
    }
    return b;
  }
}

/** A curved kicker ramp along +z, base at y=0, lip at z=+L/2. With backSlope, the back is a
 *  drivable slope (a launch from that side too) instead of a wall. */
function kicker(L: number, W: number, H: number, segs: number, backSlope = 0): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const prof = (t: number) => H * Math.pow(t, 1.7) - 0.12 * (1 - t) * (1 - t);
  const back = backSlope > 0 ? H / Math.tan(backSlope) : 0;
  // profile points (z, y)
  const P: [number, number][] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    P.push([-L / 2 + L * t, prof(t)]);
  }
  if (back > 0) {
    P.push([L / 2 + 0.6, H]); // short flat table
    P.push([L / 2 + 0.6 + back, -0.12]);
  }
  for (const [z, y] of P) pos.push(-W / 2, y, z, W / 2, y, z);
  for (let i = 0; i < P.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  // sides
  for (const sx of [-W / 2, W / 2]) {
    const sb = pos.length / 3;
    for (const [z, y] of P) pos.push(sx, y, z, sx, -0.1, z);
    for (let i = 0; i < P.length - 1; i++) {
      const a = sb + i * 2;
      if (sx > 0) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      else idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  if (back <= 0) {
    const bb = pos.length / 3;
    pos.push(-W / 2, 0, L / 2, W / 2, 0, L / 2, W / 2, H, L / 2, -W / 2, H, L / 2);
    idx.push(bb, bb + 2, bb + 1, bb, bb + 3, bb + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Clothoid ("teardrop") loop: curvature ramps in and out like a real coaster loop.
 *  Enters at z<0 on the ground at x=-off, exits at x=+off. Returns geometry + exit z. */
function loopGeometry(R: number, W: number, off: number): THREE.BufferGeometry {
  const kmax = 1 / R;
  const Le = 30; // easing length (m)
  const Lc = (2 * Math.PI) / kmax - Le;
  const total = 2 * Le + Lc;
  const lead = 14;
  // the whole ribbon is a helix: x drifts linearly with arc length (run-in, loop and run-out)
  const span = total + 2 * lead;
  const slope = (2 * off) / span;
  const pts: { c: THREE.Vector3; n: THREE.Vector3; s: number }[] = [];
  const steps = Math.ceil(total / 0.6);
  // run-in (with a sunken tip so there's no lip)
  for (let i = 0; i <= 6; i++) {
    const s = (lead * i) / 6;
    pts.push({ c: new THREE.Vector3(-off + slope * s, i === 0 ? -0.45 : 0.02, -lead + s), n: new THREE.Vector3(0, 1, 0), s });
  }
  let th = 0;
  let z = 0;
  let y = 0.02;
  const h = total / steps;
  for (let i = 1; i <= steps; i++) {
    const sMid = (i - 0.5) * h;
    const k = kmax * Math.min(1, sMid / Le, (total - sMid) / Le);
    th += k * h;
    z += Math.cos(th) * h;
    y += Math.sin(th) * h;
    const s = lead + i * h;
    pts.push({ c: new THREE.Vector3(-off + slope * s, y, z), n: new THREE.Vector3(0, Math.cos(th), -Math.sin(th)), s });
  }
  const zEnd = z;
  for (let i = 1; i <= 6; i++) {
    const s = lead + total + (lead * i) / 6;
    pts.push({ c: new THREE.Vector3(-off + slope * s, i === 6 ? -0.45 : 0.02, zEnd + (lead * i) / 6), n: new THREE.Vector3(0, 1, 0), s });
  }
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const p of pts) {
    pos.push(p.c.x - W / 2, p.c.y, p.c.z, p.c.x + W / 2, p.c.y, p.c.z);
    uv.push(0, p.s, 1, p.s);
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const ub = pos.length / 3;
  for (const p of pts) {
    const o = p.n.clone().multiplyScalar(-0.35);
    pos.push(p.c.x - W / 2 + o.x, p.c.y + o.y, p.c.z + o.z, p.c.x + W / 2 + o.x, p.c.y + o.y, p.c.z + o.z);
    uv.push(0.5, 0, 0.5, 0);
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = ub + i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aUV', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.userData.rail = pts.map((p) => p.c.clone());
  return g;
}

/** U-shaped half-pipe along z. */
function halfpipeGeometry(L: number, flat: number, R: number): THREE.BufferGeometry {
  const prof: [number, number][] = [];
  const segs = 10;
  prof.push([-flat / 2 - R - 2, R + 0.5]);
  for (let i = segs; i >= 0; i--) {
    const a = (i / segs) * (Math.PI / 2);
    prof.push([-flat / 2 - Math.sin(a) * R, R - Math.cos(a) * R]);
  }
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * (Math.PI / 2);
    prof.push([flat / 2 + Math.sin(a) * R, R - Math.cos(a) * R]);
  }
  prof.push([flat / 2 + R + 2, R + 0.5]);
  const pos: number[] = [];
  const idx: number[] = [];
  const zs = 8;
  for (let j = 0; j <= zs; j++) {
    const z = -L / 2 + (L * j) / zs;
    for (const [x, y] of prof) pos.push(x, y, z);
  }
  const n = prof.length;
  for (let j = 0; j < zs; j++)
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // add solid end walls under the lips so it reads as a structure
  const walls: THREE.BufferGeometry[] = [g];
  for (const sx of [-1, 1]) {
    const w = new THREE.BoxGeometry(2, R + 0.5 + 3, L).translate(sx * (flat / 2 + R + 1), (R + 0.5 - 3) / 2, 0);
    w.deleteAttribute('uv');
    walls.push(w.toNonIndexed());
  }
  const m = mergeGeometries([g.toNonIndexed(), ...walls.slice(1)])!;
  m.computeVertexNormals();
  return m;
}
