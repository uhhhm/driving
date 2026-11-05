// Procedural car meshes with cheap soft-body-ish deformation and detachable parts.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry as RoundedBox } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { CarSpec, BodyStyle } from './VehicleDefs';
import { worldUniforms } from '../world/Materials';

// Body colour regions (per grid quad). Paint + accent share the vertex-coloured paint material.
const R_PAINT = 0;
const R_GLASS = 1;
const R_TRIM = 2;
const R_ACCENT = 3;

/**
 * For each vertex of a non-indexed mesh, the vertices at the same position whose face normal is
 * within `creaseDeg` of its own. Averaging face normals over that set gives smooth panels with
 * hard edges at creases (like BufferGeometryUtils.toCreasedNormals), and because the topology
 * never changes it can be reused every time the body is deformed.
 */
function buildCreaseShare(pos: ArrayLike<number>, creaseDeg: number) {
  const n = pos.length / 3;
  const fn = faceNormals(pos);
  for (let t = 0; t < fn.length; t += 3) {
    const l = Math.hypot(fn[t], fn[t + 1], fn[t + 2]) || 1;
    fn[t] /= l;
    fn[t + 1] /= l;
    fn[t + 2] /= l;
  }
  const cos = Math.cos((creaseDeg * Math.PI) / 180);
  const q = (v: number) => Math.round(v * 1e4);
  const keys: string[] = new Array(n);
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = (keys[i] = `${q(pos[i * 3])},${q(pos[i * 3 + 1])},${q(pos[i * 3 + 2])}`);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(i);
  }
  const start = new Int32Array(n + 1);
  const list: number[] = [];
  for (let i = 0; i < n; i++) {
    start[i] = list.length;
    const a = ((i / 3) | 0) * 3;
    for (const j of buckets.get(keys[i])!) {
      const c = ((j / 3) | 0) * 3;
      // always keep the vertex's own triangle, so slivers that are degenerate at rest still get a
      // normal once a crash stretches them open
      if (j === i || fn[a] * fn[c] + fn[a + 1] * fn[c + 1] + fn[a + 2] * fn[c + 2] >= cos) list.push(c / 3);
    }
  }
  start[n] = list.length;
  return { start, tris: Int32Array.from(list) };
}

type CreaseShare = ReturnType<typeof buildCreaseShare>;

/** Smooth-within-crease vertex normals from the current positions (see buildCreaseShare). */
function applyCreasedNormals(geo: THREE.BufferGeometry, share: CreaseShare) {
  const pos = geo.attributes.position.array as Float32Array;
  const nrm = geo.attributes.normal.array as Float32Array;
  const fn = faceNormals(pos);
  const n = pos.length / 3;
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0, z = 0;
    for (let k = share.start[i]; k < share.start[i + 1]; k++) {
      const t = share.tris[k] * 3;
      x += fn[t];
      y += fn[t + 1];
      z += fn[t + 2];
    }
    const l = Math.hypot(x, y, z) || 1;
    nrm[i * 3] = x / l;
    nrm[i * 3 + 1] = y / l;
    nrm[i * 3 + 2] = z / l;
  }
  geo.attributes.normal.needsUpdate = true;
}

function faceNormals(pos: ArrayLike<number>) {
  const t = pos.length / 9;
  const out = new Float32Array(t * 3);
  for (let f = 0; f < t; f++) {
    const o = f * 9;
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    // unnormalised cross product = area-weighted normal
    out[f * 3] = uy * vz - uz * vy;
    out[f * 3 + 1] = uz * vx - ux * vz;
    out[f * 3 + 2] = ux * vy - uy * vx;
  }
  return out;
}

interface Profile {
  // height (top of body) as a function of normalized z (-1 rear .. 1 front)
  top: (z: number) => number;
  bottom: number;
  beltline: number; // y where glass starts
  cabinZ: [number, number]; // glass region z range (normalized)
  tumble: number; // inward taper of cabin
  noseTaper: number;
  width: number;
  length: number;
  /** side glass limited to this normalized z range (and below yMax): a framed window instead of
   *  glass that follows a sloping roofline */
  sideWindow?: { z: [number, number]; yMax?: number };
}

const PROFILES: Record<BodyStyle, Profile> = {
  coupe: {
    top: (z) => (z > 0.32 ? 0.62 - (z - 0.32) * 0.35 : z > 0.05 ? 0.62 + ((0.32 - z) / 0.27) * 0.5 : z > -0.45 ? 1.12 : z > -0.78 ? 1.12 - ((-0.45 - z) / 0.33) * 0.42 : 0.7),
    bottom: 0.2,
    beltline: 0.68,
    cabinZ: [-0.78, 0.32],
    tumble: 0.22,
    noseTaper: 0.12,
    width: 1.84,
    length: 4.3,
  },
  muscle: {
    top: (z) => (z > 0.18 ? 0.78 + (z < 0.3 ? 0.05 : 0) : z > -0.05 ? 0.78 + ((0.18 - z) / 0.23) * 0.42 : z > -0.45 ? 1.2 : z > -0.62 ? 1.2 - ((-0.45 - z) / 0.17) * 0.42 : 0.8),
    bottom: 0.22,
    beltline: 0.82,
    cabinZ: [-0.62, 0.18],
    tumble: 0.18,
    noseTaper: 0.05,
    width: 2.0,
    length: 4.9,
  },
  truck: {
    top: (z) => (z > 0.38 ? 1.25 : z > 0.2 ? 1.25 + ((0.38 - z) / 0.18) * 0.6 : z > -0.15 ? 1.85 : 1.15),
    bottom: 0.55,
    beltline: 1.3,
    cabinZ: [-0.15, 0.38],
    tumble: 0.08,
    noseTaper: 0.04,
    width: 2.1,
    length: 4.8,
  },
  couch: {
    top: (z) => (z < -0.55 ? 1.55 : 0.95),
    bottom: 0.45,
    beltline: 9,
    cabinZ: [0, 0],
    tumble: 0,
    noseTaper: 0,
    width: 2.2,
    length: 1.8,
  },
  wedge: {
    top: (z) => (z > 0.1 ? 0.45 + (1 - z) * 0.32 : z > -0.4 ? 0.98 : z > -0.85 ? 0.98 - ((-0.4 - z) / 0.45) * 0.28 : 0.68),
    bottom: 0.18,
    beltline: 0.62,
    cabinZ: [-0.55, 0.32],
    tumble: 0.3,
    noseTaper: 0.2,
    width: 2.0,
    length: 4.6,
  },
  van: {
    top: (z) => (z > 0.75 ? 1.15 : z > 0.55 ? 1.15 + ((0.75 - z) / 0.2) * 1.15 : 2.3),
    bottom: 0.4,
    beltline: 1.35,
    cabinZ: [0.4, 0.75],
    sideWindow: { z: [0.3, 0.5], yMax: 2.05 }, // whole 1/8-length columns, clear of the windscreen slope
    tumble: 0.04,
    noseTaper: 0.06,
    width: 2.1,
    length: 5.0,
  },
};

// Civilian traffic bodies (built with the same body builder, lower detail, no deformation).
const TRAFFIC_PROFILES: Record<'sedan' | 'hatch', Profile> = {
  sedan: {
    top: (z) => (z > 0.32 ? 0.86 - (z - 0.32) * 0.12 : z > 0.06 ? 0.86 + ((0.32 - z) / 0.26) * 0.52 : z > -0.42 ? 1.38 : z > -0.7 ? 1.38 - ((-0.42 - z) / 0.28) * 0.44 : 0.94),
    bottom: 0.28,
    beltline: 0.9,
    cabinZ: [-0.72, 0.33],
    tumble: 0.2,
    noseTaper: 0.1,
    width: 1.8,
    length: 4.4,
  },
  hatch: {
    top: (z) => (z > 0.42 ? 0.86 - (z - 0.42) * 0.12 : z > 0.14 ? 0.86 + ((0.42 - z) / 0.28) * 0.56 : z > -0.78 ? 1.42 : 1.42 - ((-0.78 - z) / 0.22) * 0.4),
    bottom: 0.28,
    beltline: 0.92,
    cabinZ: [-0.97, 0.43],
    tumble: 0.18,
    noseTaper: 0.08,
    width: 1.76,
    length: 3.8,
  },
};

/**
 * Car paint: clear-coated, plus a faint fresnel rim that grows at night so a dark car still has a
 * readable silhouette against a dark road (the rim takes the paint's own hue, nudged toward the sky).
 */
function makePaintMaterial(vertexColors: boolean): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({ vertexColors, roughness: 0.4, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.07 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = worldUniforms.uNight;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float rimF = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
        vec3 rimCol = mix(diffuseColor.rgb, vec3(0.55, 0.65, 1.0), 0.45) + 0.08;
        totalEmissiveRadiance += rimCol * rimF * (0.03 + uNight * 0.55);`,
      );
  };
  return m;
}

/** Tyre with a rounded sidewall (lathe), axis along X. */
function tyreGeometry(r: number, w: number, segs: number): THREE.BufferGeometry {
  const hw = w / 2;
  const rim = r * 0.66;
  const bulge = Math.min(0.05, r * 0.12);
  const pts = [
    new THREE.Vector2(rim, -hw + 0.01),
    new THREE.Vector2(r - bulge, -hw),
    new THREE.Vector2(r - bulge * 0.25, -hw + bulge * 0.6),
    new THREE.Vector2(r, -hw + bulge * 1.6),
    new THREE.Vector2(r, hw - bulge * 1.6),
    new THREE.Vector2(r - bulge * 0.25, hw - bulge * 0.6),
    new THREE.Vector2(r - bulge, hw),
    new THREE.Vector2(rim, hw - 0.01),
  ];
  return new THREE.LatheGeometry(pts, segs).rotateZ(-Math.PI / 2);
}

/** Five-spoke wheel (barrel, lip, spokes, hub), face outward along +X; mirrored for the other side. */
function rimGeometry(r: number, w: number, simple: boolean): THREE.BufferGeometry {
  const rr = r * 0.64;
  const parts: THREE.BufferGeometry[] = [];
  const x = w / 2 - 0.035;
  // barrel + outer lip
  parts.push(new THREE.CylinderGeometry(rr, rr, w * 0.8, simple ? 10 : 20, 1, true).rotateZ(Math.PI / 2));
  parts.push(new THREE.TorusGeometry(rr - 0.012, 0.016, 4, simple ? 10 : 20).rotateY(Math.PI / 2).translate(x, 0, 0));
  // spokes
  const spokes = 5;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    const sp = new THREE.BoxGeometry(0.05, rr * 0.82, rr * 0.2).translate(x - 0.02, rr * 0.5, 0);
    sp.rotateX(a);
    parts.push(sp);
  }
  // hub
  parts.push(new THREE.CylinderGeometry(rr * 0.24, rr * 0.28, 0.07, 8).rotateZ(Math.PI / 2).translate(x - 0.01, 0, 0));
  const norm = parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    n.deleteAttribute('uv');
    return n;
  });
  return mergeGeometries(norm)!;
}

export interface DetachPart {
  name: string;
  mesh: THREE.Mesh;
  health: number;
  anchor: THREE.Vector3; // local
  attached: boolean;
}

/** Where the wheels sit (body-local, at rest), so the body can wrap arches and fenders around them. */
interface ArchSpec {
  z: number[]; // axle positions
  cy: number; // wheel centre height at rest
  r: number; // tyre radius
  inner: number; // |x| of the tyre's inner face
  outer: number; // |x| of the tyre's outer face
}

const smooth01 = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;

/** Arch opening radius: tyre plus clearance for suspension travel. */
const archRadius = (a: ArchSpec) => a.r * 1.1 + 0.035;
/** Nearest axle offset and the arch-circle height there (-Infinity outside the opening). */
function archAt(a: ArchSpec, z: number) {
  let dz = Infinity;
  for (const az of a.z) if (Math.abs(z - az) < Math.abs(dz)) dz = z - az;
  const rA = archRadius(a);
  const circ = Math.abs(dz) < rA ? a.cy + Math.sqrt(rA * rA - dz * dz) : -Infinity;
  return { dz, circ, rA };
}

/**
 * Procedural body: a subdivided box warped to the profile, with paint/glass/trim/stripe regions per
 * quad. With `arches`, the outer columns are lifted into wheel-arch openings (the inner columns stay
 * down and become a dark wheel-well liner), low hoods grow fender bulges over the tyres, and the
 * lower body flares out so the tyres tuck under the bodywork.
 */
function buildBodyGeometry(p: Profile, seg: number, style: BodyStyle | 'traffic', arches?: ArchSpec): THREE.BufferGeometry {
  // twice the columns across the width so the twin stripes land on whole quads; five per unit of
  // seg along the length so the arches come out round
  const ySeg = Math.max(4, seg / 2 + 1);
  const zSeg = seg * 5;
  const box = new THREE.BoxGeometry(1, 1, 1, seg * 2, ySeg, zSeg);
  const pos = box.attributes.position;
  const halfW = p.width / 2;
  for (let i = 0; i < pos.count; i++) {
    const nx = pos.getX(i) * 2; // -1..1
    // bunch rows toward the bottom: a thin sill row and taller glass rows
    const ny = Math.pow(pos.getY(i) + 0.5, 1.6); // 0..1
    const nz = pos.getZ(i) * 2; // -1..1
    let top = p.top(nz);
    let y = p.bottom + ny * (top - p.bottom);
    let w = halfW;
    // taper nose and tail in plan
    w *= 1 - p.noseTaper * Math.max(0, nz) ** 2 - 0.05 * Math.max(0, -nz) ** 3;
    if (arches) {
      const zm = (nz * p.length) / 2;
      const { dz, circ, rA } = archAt(arches, zm);
      const ad = Math.abs(dz);
      const xn = Math.abs(nx);
      const innerN = (arches.inner - 0.06) / halfW;
      const lift = smooth01(innerN - 0.14, innerN, xn); // outer columns open up, inner ones form the well
      const near = smooth01(rA * 1.5, rA * 0.75, ad);
      const fenderTop = arches.cy + rA + 0.07;
      const ceil = Math.min(p.beltline, top);
      // a hood lower than the tyre grows a fender bulge over it (outer part of the width only)
      const ceil2 = ceil < fenderTop ? lerpN(ceil, fenderTop, near * smooth01(innerN - 0.4, innerN - 0.1, xn)) : ceil;
      const bottom2 = lerpN(p.bottom, Math.max(p.bottom, circ), lift);
      if (y <= ceil + 1e-6) y = bottom2 + ((y - p.bottom) * (ceil2 - bottom2)) / Math.max(1e-3, ceil - p.bottom);
      if (top <= ceil + 1e-6) top = ceil2;
      // flare the lower body so the tyre sits under it
      const flareW = arches.outer + 0.035;
      if (flareW > w) w = lerpN(w, flareW, near * smooth01(fenderTop + 0.22, fenderTop - 0.04, y));
    }
    // round the nose/tail
    const ends = Math.pow(Math.abs(nz), 6);
    y = Math.min(y, top - ends * 0.12);
    // tumblehome above beltline
    if (y > p.beltline) w *= 1 - p.tumble * Math.min(1, (y - p.beltline) / 0.45);
    // soften vertical edges
    const edge = Math.abs(nx);
    const x = nx * w * (1 - 0.06 * Math.pow(ny, 2) * edge);
    const z = (nz * p.length) / 2;
    // slope the bottom up at the ends a bit
    if (ny < 0.1) y += ends * 0.12;
    pos.setXYZ(i, x, y, z);
  }
  const flat = box.toNonIndexed();
  flat.deleteAttribute('uv');
  flat.deleteAttribute('normal');
  // Classify whole grid quads (BoxGeometry emits each cell as two consecutive triangles), so
  // region borders follow the grid instead of zig-zagging along triangle diagonals.
  const src = flat.attributes.position.array as Float32Array;
  const quads = src.length / 18;
  const fn = faceNormals(src);
  const stripes = style === 'muscle' || style === 'coupe' || style === 'wedge';
  const regionOf = new Uint8Array(quads);
  // B-pillar: one blacked-out column mid-way along long side windows
  const zStep = 2 / zSeg;
  const cabinLen = p.cabinZ[1] - p.cabinZ[0];
  const pillarZ = cabinLen >= 0.75 && style !== 'wedge' && !p.sideWindow ? (Math.floor((p.cabinZ[0] + cabinLen * 0.45) / zStep) + 0.5) * zStep : NaN;
  for (let qd = 0; qd < quads; qd++) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 6; k++) {
      const o = (qd * 6 + k) * 3;
      cx += src[o] / 6;
      cy += src[o + 1] / 6;
      cz += src[o + 2] / 6;
    }
    const fx = fn[qd * 6] + fn[qd * 6 + 3], fy = fn[qd * 6 + 1] + fn[qd * 6 + 4], fz = fn[qd * 6 + 2] + fn[qd * 6 + 5];
    const l = Math.hypot(fx, fy, fz) || 1;
    const nx = fx / l;
    const ny = fy / l;
    const zn = cz / (p.length / 2);
    let r = R_PAINT;
    const side = Math.abs(nx) > 0.5;
    const sw = side ? p.sideWindow : undefined;
    const inCabin = sw ? zn > sw.z[0] && zn < sw.z[1] && cy < (sw.yMax ?? Infinity) : zn > p.cabinZ[0] && zn < p.cabinZ[1];
    const well = arches ? archAt(arches, cz) : null;
    if (well && ny < 0.3 && Math.abs(well.dz) < well.rA && cy < well.circ + 0.03 && Math.abs(cx) < arches!.outer) r = R_TRIM; // wheel well liner (faces sideways/down; never the hood)
    else if (cy > p.beltline + 0.05 && inCabin && ny < 0.92) r = side && Math.abs(zn - pillarZ) < zStep * 0.5 ? R_TRIM : R_GLASS;
    else if (style === 'van' && fz / l < -0.9 && cy > p.beltline + 0.05 && cy < 2.0 && Math.abs(cx) > 0.1 && Math.abs(cx) < p.width / 2 - 0.2) r = R_GLASS; // rear-door windows
    else if (ny < -0.5 || (cy < p.bottom + 0.11 && Math.abs(nx) > 0.5)) r = R_TRIM; // underside + side sills
    else if (stripes && Math.abs(cx) > 0.08 && Math.abs(cx) < 0.24) r = R_ACCENT;
    else if (style === 'van' && cy > 0.95 && cy < 1.3 && ny < 0.5 && zn < p.cabinZ[0] + 0.1) r = R_ACCENT; // band on the box, not the sloped cab
    regionOf[qd] = r;
  }
  // Sort quads into material groups: paint+accent (vertex colours), glass, trim.
  const groupOf = (r: number) => (r === R_GLASS ? 1 : r === R_TRIM ? 2 : 0);
  const order = Array.from({ length: quads }, (_, i) => i).sort((a, b) => groupOf(regionOf[a]) - groupOf(regionOf[b]));
  const n = quads * 6;
  const outPos = new Float32Array(n * 3);
  const region = new Uint8Array(n);
  const counts = [0, 0, 0];
  order.forEach((qd, k) => {
    outPos.set(src.subarray(qd * 18, qd * 18 + 18), k * 18);
    region.fill(regionOf[qd], k * 6, k * 6 + 6);
    counts[groupOf(regionOf[qd])] += 6;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('region', new THREE.BufferAttribute(region, 1));
  g.addGroup(0, counts[0], 0);
  g.addGroup(counts[0], counts[1], 1);
  g.addGroup(counts[0] + counts[1], counts[2], 2);
  return g;
}

export class CarModel {
  root = new THREE.Group();
  bodyGroup = new THREE.Group();
  body: THREE.Mesh;
  wheels: THREE.Group[] = [];
  parts: DetachPart[] = [];
  paint: THREE.MeshPhysicalMaterial;
  /** same paint without vertex colours, for bolt-on body-colour parts (bumpers, armrests) */
  paintSolid: THREE.MeshPhysicalMaterial;
  private basePos: Float32Array;
  private deform: Float32Array;
  private crease: CreaseShare;
  /** lights, plate and bolt-on parts ride on the nearest body vertex so they move with dents */
  private followers: { obj: THREE.Object3D; anchor: THREE.Vector3; vi: number; part?: DetachPart; sag: number }[] = [];
  headlights: THREE.Mesh[] = [];
  taillights: THREE.MeshBasicMaterial;
  private tailStrip: THREE.MeshBasicMaterial;
  headMat: THREE.MeshBasicMaterial;
  exhausts: THREE.Vector3[] = [];
  flames: THREE.Mesh[] = [];
  beacon: THREE.Group | null = null;
  spec: CarSpec;
  plateCanvas: HTMLCanvasElement | null = null;

  constructor(spec: CarSpec, opts: { paint?: number; accent?: number; plate?: string; police?: boolean; simple?: boolean } = {}) {
    this.spec = spec;
    const prof = PROFILES[spec.style];
    this.paint = makePaintMaterial(true);
    this.paintSolid = makePaintMaterial(false);
    // tinted, sky-reflecting glass: dark enough to read as glass, light enough to show the cabin shape
    const glass = new THREE.MeshStandardMaterial({ color: 0x1e2a38, roughness: 0.05, metalness: 0.85, envMapIntensity: 1.7 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x121316, roughness: 0.8, metalness: 0.1 });
    // wheels at rest: mount height minus the spring's static extension (+ a little measured sag)
    const omega = 2 * Math.PI * spec.freq;
    const arches: ArchSpec | undefined =
      spec.style === 'couch'
        ? undefined
        : {
            z: [spec.wheelZf, spec.wheelZr],
            cy: spec.wheelY - spec.restLen + 9.81 / (omega * omega) + 0.03,
            r: spec.wheelR,
            inner: spec.wheelX - spec.wheelW / 2,
            outer: spec.wheelX + spec.wheelW / 2,
          };
    const geo = buildBodyGeometry(prof, opts.simple ? 4 : 8, spec.style, arches);
    this.basePos = (geo.attributes.position.array as Float32Array).slice();
    this.deform = new Float32Array(this.basePos.length);
    this.crease = buildCreaseShare(this.basePos, 32);
    applyCreasedNormals(geo, this.crease);
    this.body = new THREE.Mesh(geo, [this.paint, glass, trim]);
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.bodyGroup.add(this.body);
    this.root.add(this.bodyGroup);
    this.setPaint(opts.paint ?? spec.color, opts.accent ?? spec.accent);

    // lights: bright lens in a dark housing; a full-width strip joins the tail lights so the rear
    // reads as one graphic (and stays visible at night)
    this.headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.97, 0.85).multiplyScalar(2.5) });
    this.taillights = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.42, 0, 0) });
    this.tailStrip = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0, 0) });
    const housing = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.25, metalness: 0.6 });
    const L = prof.length / 2;
    const W = prof.width / 2;
    if (spec.style !== 'couch') {
      const hy = Math.max(prof.bottom + 0.2, prof.top(0.98) - 0.18);
      const ty = prof.top(-0.98) - 0.15;
      const hx = W - 0.32 - prof.noseTaper * 0.5;
      for (const s of [-1, 1]) {
        const hh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.05), housing);
        hh.position.set(s * hx, hy, L - 0.012);
        this.bodyGroup.add(hh);
        const hl = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.05), this.headMat);
        hl.position.set(s * hx, hy, L + 0.002);
        this.bodyGroup.add(hl);
        this.headlights.push(hl);
        const th = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.19, 0.05), housing);
        th.position.set(s * (W - 0.3), ty, -L + 0.012);
        this.bodyGroup.add(th);
        const tl = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.13, 0.05), this.taillights);
        tl.position.set(s * (W - 0.3), ty, -L - 0.002);
        this.bodyGroup.add(tl);
      }
      if (spec.style === 'coupe' || spec.style === 'wedge' || spec.style === 'muscle') {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(W * 2 - 1.15, 0.035, 0.04), this.tailStrip);
        strip.position.set(0, ty, -L - 0.002);
        this.bodyGroup.add(strip);
      }
      // grille between the headlights
      if (spec.style !== 'wedge') {
        const gw = Math.max(0.3, hx * 2 - 0.62);
        const grille = new THREE.Mesh(new THREE.BoxGeometry(gw, spec.style === 'truck' || spec.style === 'van' ? 0.3 : 0.16, 0.04), housing);
        grille.position.set(0, Math.max(prof.bottom + 0.2, hy - 0.04), L - 0.004);
        this.bodyGroup.add(grille);
      }
    }
    this.addStyleExtras(spec, prof, opts);
    if (opts.plate && spec.style !== 'couch') this.addPlate(opts.plate, prof);
    // wheels: rounded tyre, bright five-spoke rim (mirrored per side), accent-coloured brake caliper
    // that steers with the wheel but doesn't spin
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.92 });
    const rimColor = spec.style === 'muscle' ? 0xd8d8dc : spec.style === 'truck' ? 0x3a3c40 : spec.style === 'van' ? 0xe8e8e8 : 0xb9bcc4;
    const rimMat = new THREE.MeshStandardMaterial({ color: rimColor, roughness: 0.28, metalness: 0.85, side: THREE.DoubleSide });
    const wheelBack = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.7, metalness: 0.3 });
    const caliperMat = new THREE.MeshStandardMaterial({ color: spec.style === 'muscle' || spec.style === 'van' ? 0xd8321e : opts.accent ?? spec.accent, roughness: 0.4, metalness: 0.3 });
    const discMat = new THREE.MeshStandardMaterial({ color: 0x55575c, roughness: 0.35, metalness: 0.9 });
    const tg = tyreGeometry(spec.wheelR, spec.wheelW, opts.simple ? 12 : 22);
    const rg = rimGeometry(spec.wheelR, spec.wheelW, !!opts.simple);
    const rgL = rg.clone().scale(-1, 1, 1);
    // mirroring flips winding: fix the normals' facing by flipping the index-free triangles
    const pa = rgL.attributes.position.array as Float32Array;
    const na = rgL.attributes.normal.array as Float32Array;
    for (let t = 0; t < pa.length; t += 9)
      for (const arr of [pa, na])
        for (let k = 0; k < 3; k++) {
          const tmp = arr[t + 3 + k];
          arr[t + 3 + k] = arr[t + 6 + k];
          arr[t + 6 + k] = tmp;
        }
    const backG = new THREE.CylinderGeometry(spec.wheelR * 0.64, spec.wheelR * 0.64, 0.02, opts.simple ? 10 : 20).rotateZ(Math.PI / 2);
    const discG = new THREE.CylinderGeometry(spec.wheelR * 0.5, spec.wheelR * 0.5, 0.03, 16).rotateZ(Math.PI / 2);
    const caliperG = new THREE.BoxGeometry(0.06, spec.wheelR * 0.38, spec.wheelR * 0.42);
    for (let i = 0; i < 4; i++) {
      // wheel order matches Vehicle: front +x, front -x, rear +x, rear -x
      const side = i % 2 === 0 ? 1 : -1;
      const g = new THREE.Group();
      const spin = new THREE.Group();
      const t = new THREE.Mesh(tg, tireMat);
      t.castShadow = true;
      spin.add(t);
      spin.add(new THREE.Mesh(side > 0 ? rg : rgL, rimMat));
      const back = new THREE.Mesh(backG, wheelBack); // the wheel's inner face, seen between the spokes
      back.position.x = -side * 0.04;
      spin.add(back);
      if (!opts.simple) {
        const disc = new THREE.Mesh(discG, discMat);
        disc.position.x = side * (spec.wheelW / 2 - 0.13);
        spin.add(disc);
      }
      g.add(spin);
      if (!opts.simple) {
        const cal = new THREE.Mesh(caliperG, caliperMat);
        cal.position.set(side * (spec.wheelW / 2 - 0.1), spec.wheelR * 0.22, (i < 2 ? -1 : 1) * spec.wheelR * 0.18);
        g.add(cal);
      }
      this.wheels.push(g);
      this.root.add(g);
    }
    if (opts.police) this.addPolice(prof);
    // everything bolted to the body follows the dent under it
    for (const o of this.bodyGroup.children) {
      if (o === this.body || this.flames.includes(o as THREE.Mesh)) continue;
      this.followers.push({ obj: o, anchor: o.position.clone(), vi: this.nearestVertex(o.position), part: this.parts.find((p) => p.mesh === o), sag: 0 });
    }
  }

  private nearestVertex(p: THREE.Vector3) {
    const b = this.basePos;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < b.length; i += 3) {
      const d = (b[i] - p.x) ** 2 + (b[i + 1] - p.y) ** 2 + (b[i + 2] - p.z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  private placeFollowers() {
    const d = this.deform;
    for (const f of this.followers) {
      if (f.part && !f.part.attached) continue; // flying debris now
      f.obj.position.set(f.anchor.x + d[f.vi], f.anchor.y + d[f.vi + 1] - f.sag, f.anchor.z + d[f.vi + 2]);
    }
  }


  setPaint(paint: number, accent: number) {
    const g = this.body.geometry;
    const C = g.attributes.color as THREE.BufferAttribute;
    const R = g.attributes.region as THREE.BufferAttribute;
    const pc = new THREE.Color(paint);
    const ac = new THREE.Color(accent);
    for (let i = 0; i < C.count; i++) {
      const c = R.getX(i) === R_ACCENT ? ac : pc;
      C.setXYZ(i, c.r, c.g, c.b);
    }
    C.needsUpdate = true;
    this.paintSolid?.color.setHex(paint);
  }

  /** Rear licence plate showing the world seed. */
  private addPlate(text: string, p: Profile) {
    const cv = document.createElement('canvas');
    cv.width = 256;
    cv.height = 64;
    const c = cv.getContext('2d');
    if (!c) return;
    c.fillStyle = '#f1efe4';
    c.fillRect(0, 0, 256, 64);
    c.strokeStyle = '#1b1d24';
    c.lineWidth = 4;
    c.strokeRect(4, 4, 248, 56);
    c.fillStyle = '#1b1d24';
    const t = text.toUpperCase().slice(0, 12);
    c.font = `700 ${Math.min(40, Math.floor(400 / Math.max(6, t.length)))}px "Chakra Petch", monospace`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(t, 128, 34);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.13).rotateY(Math.PI), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 }));
    plate.position.set(0, p.bottom + 0.32, -p.length / 2 - 0.012);
    this.bodyGroup.add(plate);
    this.plateCanvas = cv;
  }

  private addStyleExtras(spec: CarSpec, p: Profile, opts: { accent?: number }) {
    const accentMat = new THREE.MeshStandardMaterial({ color: opts.accent ?? spec.accent, roughness: 0.4, metalness: 0.3 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.15, metalness: 1 });
    const L = p.length / 2;
    const W = p.width / 2;
    const addPart = (name: string, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, health = 40) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      this.bodyGroup.add(m);
      this.parts.push({ name, mesh: m, health, anchor: new THREE.Vector3(x, y, z), attached: true });
      return m;
    };
    // bumpers
    if (spec.style !== 'couch') {
      // body-colour bumpers with a dark splitter / diffuser lip, so the car reads as one shape
      const lipMat = new THREE.MeshStandardMaterial({ color: 0x1a1b1f, roughness: 0.6, metalness: 0.2 });
      const truckish = spec.style === 'truck' || spec.style === 'van';
      for (const end of [1, -1]) {
        const bw = p.width * (end > 0 ? 0.94 - p.noseTaper * 0.5 : 0.95);
        const bumperGeo = new RoundedBox(bw, 0.17, 0.17, 2, 0.05);
        const b = addPart(end > 0 ? 'front bumper' : 'rear bumper', bumperGeo, truckish ? lipMat : this.paintSolid, 0, p.bottom + 0.1, end * (L + 0.035), 35);
        const lip = new THREE.Mesh(new THREE.BoxGeometry(bw * 0.92, 0.04, 0.22), lipMat);
        lip.position.set(0, -0.09, end * 0.02);
        lip.castShadow = true;
        b.add(lip);
      }
      for (const s of [-1, 1]) {
        addPart('mirror', new THREE.BoxGeometry(0.2, 0.12, 0.16), accentMat, s * (W + 0.05), p.beltline + 0.05, L * (p.cabinZ[1] - 0.05), 10);
      }
    }
    // exhaust points
    this.exhausts = [new THREE.Vector3(0.45, p.bottom + 0.1, -L - 0.1), new THREE.Vector3(-0.45, p.bottom + 0.1, -L - 0.1)];
    switch (spec.style) {
      case 'coupe': {
        // big wing
        addPart('spoiler', new THREE.BoxGeometry(p.width * 0.9, 0.05, 0.38), accentMat, 0, 1.05, -L + 0.3, 30);
        for (const s of [-0.6, 0.6]) addPart('wing stand', new THREE.BoxGeometry(0.05, 0.3, 0.18), dark, s, 0.88, -L + 0.3, 30);
        break;
      }
      case 'muscle': {
        addPart('blower', new THREE.BoxGeometry(0.55, 0.28, 0.7), chrome, 0, 0.98, L * 0.55, 30);
        addPart('scoop', new THREE.BoxGeometry(0.5, 0.12, 0.3), dark, 0, 1.15, L * 0.6, 20);
        addPart('ducktail', new THREE.BoxGeometry(p.width * 0.85, 0.08, 0.25), dark, 0, 0.88, -L + 0.12, 25);
        this.exhausts = [new THREE.Vector3(W + 0.05, 0.35, L * 0.1), new THREE.Vector3(-W - 0.05, 0.35, L * 0.1)];
        for (const s of [-1, 1]) {
          const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.6, 8).rotateX(Math.PI / 2), chrome);
          pipe.position.set(s * (W + 0.02), 0.32, L * 0.1);
          this.bodyGroup.add(pipe);
        }
        break;
      }
      case 'truck': {
        // roll cage + light bar + bed
        const bar = new THREE.BoxGeometry(0.08, 0.08, 1.4);
        for (const s of [-1, 1]) addPart('roll bar', bar, dark, s * (W - 0.15), 2.0, -L * 0.45, 60);
        addPart('roll bar', new THREE.BoxGeometry(p.width - 0.2, 0.08, 0.08), dark, 0, 2.0, -L * 0.15, 60);
        const lb = addPart('light bar', new THREE.BoxGeometry(1.4, 0.14, 0.14), this.lightBarMat(), 0, 1.95, L * 0.2, 20);
        lb.castShadow = false;
        addPart('spare tire', new THREE.CylinderGeometry(0.42, 0.42, 0.3, 14).rotateX(Math.PI / 2), dark, 0, 1.45, -L - 0.12, 30);
        addPart('bull bar', new THREE.BoxGeometry(p.width * 0.8, 0.5, 0.12), dark, 0, 0.95, L + 0.2, 60);
        break;
      }
      case 'couch': {
        const cushion = new THREE.MeshStandardMaterial({ color: opts.accent ?? spec.accent, roughness: 0.95 });
        for (let i = -1; i <= 1; i++) addPart('cushion', new THREE.BoxGeometry(0.66, 0.2, 0.75), cushion, i * 0.68, 1.02, 0.1, 15);
        for (const s of [-1, 1]) addPart('armrest', new RoundedBox(0.25, 0.4, 1.6, 2, 0.08), this.paintSolid, s * 1.05, 1.12, 0, 40);
        // the jet engine
        const jet = new THREE.Group();
        const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 1.4, 16, 1, true).rotateX(Math.PI / 2), chrome);
        const core = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 12).rotateX(Math.PI / 2), dark);
        core.position.z = 0.6;
        jet.add(shell, core);
        jet.position.set(0, 1.35, -1.1);
        this.bodyGroup.add(jet);
        this.exhausts = [new THREE.Vector3(0, 1.35, -1.85)];
        // lamp on the side table, obviously
        const lamp = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.3, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0xffe6a0 }));
        lamp.position.set(1.05, 1.62, 0.5);
        this.bodyGroup.add(lamp);
        break;
      }
      case 'wedge': {
        addPart('wing', new THREE.BoxGeometry(p.width * 0.95, 0.04, 0.4), dark, 0, 0.98, -L + 0.2, 25);
        for (const s of [-1, 1]) addPart('side intake', new THREE.BoxGeometry(0.05, 0.25, 0.8), dark, s * (W - 0.02), 0.5, -L * 0.25, 25);
        break;
      }
      case 'van': {
        // giant taco on the roof: a bowl-shaped shell with fillings
        const taco = new THREE.Group();
        const shell = new THREE.Mesh(
          new THREE.SphereGeometry(1, 20, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).scale(1.3, 0.85, 0.32),
          new THREE.MeshStandardMaterial({ color: 0xe8b84a, roughness: 0.8, side: THREE.DoubleSide }),
        );
        taco.add(shell);
        const lettuce = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.22, 0.42), new THREE.MeshStandardMaterial({ color: 0x3fa63a, roughness: 0.9 }));
        lettuce.position.y = -0.05;
        const tomato = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.16, 0.36), new THREE.MeshStandardMaterial({ color: 0xd8321e, roughness: 0.7 }));
        tomato.position.y = 0.08;
        taco.add(lettuce, tomato);
        taco.position.set(0, 3.15, -0.6);
        taco.rotation.y = Math.PI / 2;
        this.bodyGroup.add(taco);
        break;
      }
    }
    // exhaust flames for boost
    const flameMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 0.7, 3), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    for (const e of this.exhausts) {
      const fl = new THREE.Mesh(new THREE.ConeGeometry(spec.style === 'couch' ? 0.35 : 0.12, spec.style === 'couch' ? 2.2 : 0.9, 10, 1, true).rotateX(-Math.PI / 2), flameMat);
      fl.position.copy(e);
      fl.position.z -= spec.style === 'couch' ? 1.1 : 0.45;
      if (spec.style === 'muscle') {
        fl.rotation.y = e.x > 0 ? -Math.PI / 2 : Math.PI / 2;
        fl.position.set(e.x + Math.sign(e.x) * 0.45, e.y, e.z);
      }
      fl.visible = false;
      this.bodyGroup.add(fl);
      this.flames.push(fl);
    }
  }

  private lightBarMat() {
    return new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 0.9).multiplyScalar(2) });
  }

  private addPolice(p: Profile) {
    const g = new THREE.Group();
    const red = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.1, 0.1) });
    const blue = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 0.3, 3) });
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.25), red);
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.25), blue);
    a.position.x = 0.3;
    b.position.x = -0.3;
    g.add(a, b);
    g.position.set(0, p.top(-0.2) + 0.07, -0.2);
    this.bodyGroup.add(g);
    this.beacon = g;
  }

  /** Deform body vertices near a local-space impact point. Returns true if a part detached. */
  applyImpact(localPoint: THREE.Vector3, localDir: THREE.Vector3, strength: number): DetachPart[] {
    const pos = this.body.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const base = this.basePos;
    const radius = 0.6 + Math.min(1.4, strength * 0.12);
    const amount = Math.min(0.35, strength * 0.03);
    const r2 = radius * radius;
    for (let i = 0; i < arr.length; i += 3) {
      const dx = base[i] - localPoint.x;
      const dy = base[i + 1] - localPoint.y;
      const dz = base[i + 2] - localPoint.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const f = 1 - Math.sqrt(d2) / radius;
      const k = f * f * amount;
      // crumple along impact direction plus some noise
      const nz = Math.sin(base[i] * 13.1 + base[i + 2] * 7.7) * 0.3;
      this.deform[i] = THREE.MathUtils.clamp(this.deform[i] + localDir.x * k * (1 + nz), -0.45, 0.45);
      this.deform[i + 1] = THREE.MathUtils.clamp(this.deform[i + 1] + localDir.y * k * (1 + nz) - k * 0.2, -0.35, 0.35);
      this.deform[i + 2] = THREE.MathUtils.clamp(this.deform[i + 2] + localDir.z * k * (1 + nz), -0.45, 0.45);
      arr[i] = base[i] + this.deform[i];
      arr[i + 1] = base[i + 1] + this.deform[i + 1];
      arr[i + 2] = base[i + 2] + this.deform[i + 2];
    }
    pos.needsUpdate = true;
    applyCreasedNormals(this.body.geometry, this.crease);
    const detached: DetachPart[] = [];
    for (const p of this.parts) {
      if (!p.attached) continue;
      const d = p.anchor.distanceTo(localPoint);
      if (d < radius + 0.6) {
        p.health -= strength * (1.6 - d / (radius + 0.6)) * 3;
        // dangle a bit
        p.mesh.rotation.z += (Math.random() - 0.5) * 0.1 * strength * 0.1;
        const fo = this.followers.find((f) => f.part === p);
        if (fo) fo.sag += 0.01 * strength;
        if (p.health <= 0) {
          p.attached = false;
          detached.push(p);
        }
      }
    }
    this.placeFollowers();
    return detached;
  }

  repair() {
    const pos = this.body.geometry.attributes.position as THREE.BufferAttribute;
    (pos.array as Float32Array).set(this.basePos);
    this.deform.fill(0);
    pos.needsUpdate = true;
    applyCreasedNormals(this.body.geometry, this.crease);
    for (const p of this.parts) {
      p.health = 40;
      p.mesh.position.copy(p.anchor);
      p.mesh.rotation.set(0, 0, 0);
      if (!p.attached) {
        p.attached = true;
        this.bodyGroup.add(p.mesh);
      }
      p.mesh.visible = true;
    }
    for (const f of this.followers) f.sag = 0;
    this.placeFollowers();
  }

  setBrake(on: boolean, reverse: boolean) {
    // keep green/blue near zero so tone mapping + bloom read red, not orange; reverse lights are white
    if (reverse) this.taillights.color.setRGB(1, 0.95, 0.9).multiplyScalar(on ? 2.5 : 1.2);
    else this.taillights.color.setRGB(on ? 1.3 : 0.42, 0.0, 0.0);
    this.tailStrip.color.setRGB(on && !reverse ? 0.75 : 0.2, 0.0, 0.0);
  }

  setHeadlights(intensity: number) {
    this.headMat.color.setRGB(1, 0.97, 0.85).multiplyScalar(0.8 + intensity * 3);
  }

  dispose() {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        (mat as THREE.MeshStandardMaterial).map?.dispose();
        mat.dispose();
      }
    });
  }
}

// Merged, non-deforming mesh for traffic. Sedans and hatches use the player-car body builder at low
// detail; trucks and buses stay boxy. Regions: 0 paint, 1 glass, 2 dark, 3 headlight, 4 taillight, 5 hubcap.
export function trafficGeometry(kind: 'sedan' | 'truck' | 'bus' | 'hatch'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, region: number) => {
    const ng = g.index ? g.toNonIndexed() : g;
    ng.deleteAttribute('uv');
    const n = ng.attributes.position.count;
    ng.setAttribute('region', new THREE.BufferAttribute(new Float32Array(n).fill(region), 1));
    parts.push(ng);
  };
  if (kind === 'sedan' || kind === 'hatch') {
    const p = TRAFFIC_PROFILES[kind];
    // wheels below: r 0.33 at y = r, x ±0.82 (0.26 wide), z 1.35 / -1.3
    const body = buildBodyGeometry(p, 4, 'traffic', { z: [1.35, -1.3], cy: 0.33, r: 0.33, inner: 0.69, outer: 0.95 });
    applyCreasedNormals(body, buildCreaseShare(body.attributes.position.array, 32));
    const src = body.attributes.region.array;
    const reg = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) reg[i] = src[i] === R_GLASS ? 1 : src[i] === R_TRIM ? 2 : 0;
    body.deleteAttribute('color');
    body.clearGroups();
    body.setAttribute('region', new THREE.BufferAttribute(reg, 1));
    parts.push(body);
    const L = p.length / 2;
    const W = p.width / 2;
    const hy = p.top(0.98) - 0.16;
    const ty = p.top(-0.98) - 0.14;
    for (const sx of [-1, 1]) {
      add(new THREE.BoxGeometry(0.38, 0.11, 0.05).translate(sx * (W - 0.3 - p.noseTaper * 0.5), hy, L - 0.005), 3);
      add(new THREE.BoxGeometry(0.42, 0.12, 0.05).translate(sx * (W - 0.28), ty, -L + 0.005), 4);
    }
    add(new THREE.BoxGeometry(p.width * 0.94, 0.14, 0.14).translate(0, p.bottom + 0.08, L + 0.03), 2);
    add(new THREE.BoxGeometry(p.width * 0.94, 0.14, 0.14).translate(0, p.bottom + 0.08, -L - 0.03), 2);
  } else if (kind === 'truck') {
    add(new THREE.BoxGeometry(2.3, 1.9, 2.0).translate(0, 1.5, 3.2), 0);
    add(new THREE.BoxGeometry(2.1, 0.7, 0.05).translate(0, 1.95, 4.21), 1);
    add(new THREE.BoxGeometry(2.4, 2.8, 6.5).translate(0, 2.0, -1.2), 2);
    add(new THREE.BoxGeometry(0.4, 0.15, 0.05).translate(0.8, 0.9, 4.21), 3);
    add(new THREE.BoxGeometry(0.4, 0.15, 0.05).translate(-0.8, 0.9, 4.21), 3);
    add(new THREE.BoxGeometry(0.3, 0.2, 0.05).translate(0.9, 0.8, -4.46), 4);
    add(new THREE.BoxGeometry(0.3, 0.2, 0.05).translate(-0.9, 0.8, -4.46), 4);
  } else {
    add(new THREE.BoxGeometry(2.5, 2.6, 10).translate(0, 1.75, 0), 0);
    for (let i = 0; i < 6; i++) {
      add(new THREE.BoxGeometry(2.52, 0.8, 1.2).translate(0, 2.2, -3.7 + i * 1.45), 1);
    }
    add(new THREE.BoxGeometry(2.3, 1.0, 0.05).translate(0, 2.1, 5.01), 1);
    add(new THREE.BoxGeometry(0.4, 0.15, 0.05).translate(0.9, 0.8, 5.01), 3);
    add(new THREE.BoxGeometry(0.4, 0.15, 0.05).translate(-0.9, 0.8, 5.01), 3);
    add(new THREE.BoxGeometry(0.3, 0.2, 0.05).translate(0.9, 0.8, -5.01), 4);
    add(new THREE.BoxGeometry(0.3, 0.2, 0.05).translate(-0.9, 0.8, -5.01), 4);
  }
  // wheels
  const wr = kind === 'bus' || kind === 'truck' ? 0.5 : 0.33;
  const wz = kind === 'bus' ? [3.5, -3.2] : kind === 'truck' ? [3.2, -2.5, -3.6] : [1.35, -1.3];
  const wx = kind === 'bus' || kind === 'truck' ? 1.05 : 0.82;
  for (const z of wz)
    for (const s of [-1, 1]) {
      add(new THREE.CylinderGeometry(wr, wr, 0.26, 14).rotateZ(Math.PI / 2).translate(s * wx, wr, z), 2);
      // pale hubcap so the wheels read against the dark tyre
      add(new THREE.CylinderGeometry(wr * 0.55, wr * 0.55, 0.02, 10).rotateZ(Math.PI / 2).translate(s * (wx + 0.13), wr, z), 5);
    }
  // every part already carries its own normals (the body's are creased), so no global recompute
  return mergeGeometries(parts)!;
}
