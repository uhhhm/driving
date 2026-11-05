// Procedural low-poly prop meshes with baked vertex colours.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Prop, PROP_COUNT } from './types';

function colored(g: THREE.BufferGeometry, c: THREE.ColorRepresentation, jitter = 0): THREE.BufferGeometry {
  g = g.index ? g.toNonIndexed() : g;
  const col = new THREE.Color(c);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const j = 1 + (Math.random() - 0.5) * jitter;
    arr[i * 3] = col.r * j;
    arr[i * 3 + 1] = col.g * j;
    arr[i * 3 + 2] = col.b * j;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  g.computeBoundingSphere();
  return g;
}

export function pineGeometry(): THREE.BufferGeometry {
  const parts = [colored(new THREE.CylinderGeometry(0.22, 0.32, 3, 6).translate(0, 1.5, 0), 0x4a3020)];
  const tiers = 4;
  for (let i = 0; i < tiers; i++) {
    const r = 2.6 - i * 0.55;
    const h = 3.2 - i * 0.4;
    const y = 2.2 + i * 1.75;
    parts.push(colored(new THREE.ConeGeometry(r, h, 7).translate(0, y + h / 2, 0), i % 2 ? 0x1d4a2a : 0x183f24, 0.25));
  }
  return merge(parts);
}

export function cactusGeometry(): THREE.BufferGeometry {
  const c = 0x3f7a3a;
  const parts = [colored(new THREE.CylinderGeometry(0.35, 0.4, 5, 7).translate(0, 2.5, 0), c, 0.15)];
  parts.push(colored(new THREE.SphereGeometry(0.35, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 5, 0), c));
  const arm = (side: number, y: number, h: number) => {
    parts.push(colored(new THREE.CylinderGeometry(0.22, 0.22, 1.1, 6).rotateZ(Math.PI / 2).translate(side * 0.75, y, 0), c));
    parts.push(colored(new THREE.CylinderGeometry(0.22, 0.24, h, 6).translate(side * 1.25, y + h / 2 - 0.1, 0), c, 0.15));
    parts.push(colored(new THREE.SphereGeometry(0.22, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2).translate(side * 1.25, y + h - 0.1, 0), c));
  };
  arm(1, 2.2, 1.8);
  arm(-1, 2.9, 1.3);
  return merge(parts);
}

export function palmGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < 6; i++) {
    const seg = new THREE.CylinderGeometry(0.2 - i * 0.012, 0.28 - i * 0.012, 1.45, 6);
    seg.rotateZ(-0.05 - i * 0.04);
    seg.translate(x, y + 0.7, 0);
    parts.push(colored(seg, i % 2 ? 0x7a5a38 : 0x6a4a2c));
    x += 0.08 + i * 0.05;
    y += 1.4;
  }
  for (let k = 0; k < 7; k++) {
    const leaf = new THREE.ConeGeometry(0.5, 3.6, 4, 1);
    leaf.scale(1, 1, 0.15);
    leaf.rotateZ(-Math.PI / 2 - 0.5);
    leaf.translate(1.6, -0.6, 0);
    leaf.rotateY((k / 7) * Math.PI * 2);
    leaf.translate(x, y, 0);
    parts.push(colored(leaf, k % 2 ? 0x2f7a2c : 0x3d8f34, 0.2));
  }
  return merge(parts);
}

export function rockGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(p, i);
    const n = 0.75 + 0.35 * Math.sin(v.x * 3.1 + v.y * 1.7) * Math.cos(v.z * 2.3);
    v.multiplyScalar(n);
    v.y *= 0.7;
    p.setXYZ(i, v.x, v.y + 0.3, v.z);
  }
  const ng = g.toNonIndexed();
  ng.computeVertexNormals();
  return merge([colored(ng, 0xffffff, 0.15)]);
}

export function bushGeometry(): THREE.BufferGeometry {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const s = new THREE.IcosahedronGeometry(0.8 - i * 0.15, 0).translate(i * 0.5 - 0.5, 0.6, (i % 2) * 0.4);
    parts.push(colored(s, 0xffffff, 0.3));
  }
  return merge(parts);
}

export function lampGeometry(): THREE.BufferGeometry {
  const m = 0x3a3d44;
  return merge([
    colored(new THREE.CylinderGeometry(0.1, 0.16, 8, 6).translate(0, 4, 0), m),
    colored(new THREE.BoxGeometry(0.12, 0.12, 2.4).translate(0, 7.9, 1.1), m),
    colored(new THREE.BoxGeometry(0.5, 0.18, 0.8).translate(0, 7.8, 2.2), 0x222222),
  ]);
}

export function lampBulbGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(0.42, 0.06, 0.7).translate(0, 7.68, 2.2);
}

export function coneGeometry(): THREE.BufferGeometry {
  return merge([
    colored(new THREE.BoxGeometry(0.7, 0.06, 0.7).translate(0, 0.03, 0), 0xff5a10),
    colored(new THREE.ConeGeometry(0.28, 0.85, 8, 1, true).translate(0, 0.48, 0), 0xff5a10),
    colored(new THREE.CylinderGeometry(0.15, 0.2, 0.18, 8, 1, true).translate(0, 0.5, 0), 0xffffff),
  ]);
}

export function barrierGeometry(): THREE.BufferGeometry {
  const parts = [];
  parts.push(colored(new THREE.BoxGeometry(2.4, 0.35, 0.18).translate(0, 0.95, 0), 0xffffff));
  for (let i = 0; i < 4; i++)
    parts.push(colored(new THREE.BoxGeometry(0.3, 0.36, 0.2).translate(-0.9 + i * 0.6, 0.95, 0.001), 0xd02010));
  parts.push(colored(new THREE.BoxGeometry(0.1, 1.1, 0.1).translate(-1, 0.55, 0), 0x666666));
  parts.push(colored(new THREE.BoxGeometry(0.1, 1.1, 0.1).translate(1, 0.55, 0), 0x666666));
  parts.push(colored(new THREE.BoxGeometry(0.5, 0.08, 0.6).translate(-1, 0.04, 0), 0x333333));
  parts.push(colored(new THREE.BoxGeometry(0.5, 0.08, 0.6).translate(1, 0.04, 0), 0x333333));
  return merge(parts);
}

export function crateGeometry(): THREE.BufferGeometry {
  return merge([
    colored(new THREE.BoxGeometry(1.2, 1.2, 1.2).translate(0, 0.6, 0), 0x9a6a3a, 0.2),
    colored(new THREE.BoxGeometry(1.25, 0.15, 1.25).translate(0, 1.1, 0), 0x6a4422),
    colored(new THREE.BoxGeometry(1.25, 0.15, 1.25).translate(0, 0.1, 0), 0x6a4422),
  ]);
}

export function barrelGeometry(): THREE.BufferGeometry {
  return merge([
    colored(new THREE.CylinderGeometry(0.42, 0.42, 1.2, 10).translate(0, 0.6, 0), 0xc4161c),
    colored(new THREE.CylinderGeometry(0.44, 0.44, 0.08, 10).translate(0, 0.3, 0), 0x222222),
    colored(new THREE.CylinderGeometry(0.44, 0.44, 0.08, 10).translate(0, 0.9, 0), 0x222222),
    colored(new THREE.BoxGeometry(0.5, 0.3, 0.02).translate(0, 0.62, 0.42), 0xffd400),
  ]);
}

export function pumpGeometry(): THREE.BufferGeometry {
  return merge([
    colored(new THREE.BoxGeometry(0.9, 1.9, 0.6).translate(0, 0.95, 0), 0xe8e8e8),
    colored(new THREE.BoxGeometry(0.92, 0.5, 0.62).translate(0, 1.65, 0), 0xd01c1c),
    colored(new THREE.BoxGeometry(0.5, 0.35, 0.05).translate(0, 1.2, 0.31), 0x101820),
    colored(new THREE.BoxGeometry(1.4, 0.2, 1.0).translate(0, 0.1, 0), 0x555555),
  ]);
}

export function fenceGeometry(): THREE.BufferGeometry {
  const w = 0x7a5a3a;
  return merge([
    colored(new THREE.BoxGeometry(0.14, 1.2, 0.14).translate(0, 0.6, -1.5), w),
    colored(new THREE.BoxGeometry(0.08, 0.14, 3).translate(0, 0.95, 0), w, 0.2),
    colored(new THREE.BoxGeometry(0.08, 0.14, 3).translate(0, 0.5, 0), w, 0.2),
  ]);
}

export function buildingGeometry(): THREE.BufferGeometry {
  // unit box with base at y=0 (scaled per instance)
  const g = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  return g;
}

export function billboardGeometry(): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
}

export const PROP_GEOMS: (() => THREE.BufferGeometry)[] = new Array(PROP_COUNT);
PROP_GEOMS[Prop.Pine] = pineGeometry;
PROP_GEOMS[Prop.Cactus] = cactusGeometry;
PROP_GEOMS[Prop.Palm] = palmGeometry;
PROP_GEOMS[Prop.Rock] = rockGeometry;
PROP_GEOMS[Prop.Building] = buildingGeometry;
PROP_GEOMS[Prop.Lamp] = lampGeometry;
PROP_GEOMS[Prop.Cone] = coneGeometry;
PROP_GEOMS[Prop.Barrier] = barrierGeometry;
PROP_GEOMS[Prop.Crate] = crateGeometry;
PROP_GEOMS[Prop.Bush] = bushGeometry;
PROP_GEOMS[Prop.Barrel] = barrelGeometry;
PROP_GEOMS[Prop.Pump] = pumpGeometry;
PROP_GEOMS[Prop.Billboard] = billboardGeometry;
PROP_GEOMS[Prop.Fence] = fenceGeometry;

/** Physics description for each prop type: collider half extents (in unit scale) + break threshold (m/s). */
export interface PropPhys {
  shape: 'cyl' | 'box' | 'ball' | 'none';
  hx: number;
  hy: number;
  hz: number;
  oy: number; // centre offset y
  breakSpeed: number; // Infinity = solid
  mass: number;
  points: number;
  explode?: boolean;
  name: string;
}

export const PROP_PHYS: PropPhys[] = [];
PROP_PHYS[Prop.Pine] = { shape: 'cyl', hx: 0.35, hy: 4, hz: 0.35, oy: 4, breakSpeed: 9, mass: 300, points: 150, name: 'TIMBER!' };
PROP_PHYS[Prop.Cactus] = { shape: 'cyl', hx: 0.4, hy: 2.5, hz: 0.4, oy: 2.5, breakSpeed: 3, mass: 80, points: 80, name: 'CACTUS' };
PROP_PHYS[Prop.Palm] = { shape: 'cyl', hx: 0.3, hy: 4, hz: 0.3, oy: 4, breakSpeed: 9, mass: 200, points: 120, name: 'PALM' };
PROP_PHYS[Prop.Rock] = { shape: 'ball', hx: 0.85, hy: 0.85, hz: 0.85, oy: 0.3, breakSpeed: Infinity, mass: 0, points: 0, name: 'rock' };
PROP_PHYS[Prop.Building] = { shape: 'box', hx: 0.5, hy: 0.5, hz: 0.5, oy: 0.5, breakSpeed: Infinity, mass: 0, points: 0, name: 'building' };
PROP_PHYS[Prop.Lamp] = { shape: 'cyl', hx: 0.15, hy: 4, hz: 0.15, oy: 4, breakSpeed: 4, mass: 120, points: 100, name: 'LAMP POST' };
PROP_PHYS[Prop.Cone] = { shape: 'cyl', hx: 0.3, hy: 0.45, hz: 0.3, oy: 0.45, breakSpeed: 0, mass: 4, points: 25, name: 'CONE' };
PROP_PHYS[Prop.Barrier] = { shape: 'box', hx: 1.2, hy: 0.6, hz: 0.2, oy: 0.6, breakSpeed: 0, mass: 25, points: 40, name: 'BARRIER' };
PROP_PHYS[Prop.Crate] = { shape: 'box', hx: 0.6, hy: 0.6, hz: 0.6, oy: 0.6, breakSpeed: 0, mass: 30, points: 40, name: 'CRATE' };
PROP_PHYS[Prop.Bush] = { shape: 'none', hx: 0.8, hy: 0.6, hz: 0.8, oy: 0.6, breakSpeed: 0, mass: 0, points: 0, name: 'bush' };
PROP_PHYS[Prop.Barrel] = { shape: 'cyl', hx: 0.42, hy: 0.6, hz: 0.42, oy: 0.6, breakSpeed: 0, mass: 40, points: 120, explode: true, name: 'KABOOM' };
PROP_PHYS[Prop.Pump] = { shape: 'box', hx: 0.45, hy: 0.95, hz: 0.3, oy: 0.95, breakSpeed: 0, mass: 200, points: 300, explode: true, name: 'GAS PUMP' };
PROP_PHYS[Prop.Billboard] = { shape: 'none', hx: 0, hy: 0, hz: 0, oy: 0, breakSpeed: Infinity, mass: 0, points: 0, name: 'billboard' };
PROP_PHYS[Prop.Fence] = { shape: 'box', hx: 0.1, hy: 0.6, hz: 1.5, oy: 0.6, breakSpeed: 0, mass: 15, points: 20, name: 'FENCE' };
