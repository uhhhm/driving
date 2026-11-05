// Procedural car meshes with cheap soft-body-ish deformation and detachable parts.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CarSpec, BodyStyle } from './VehicleDefs';

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
    tumble: 0.04,
    noseTaper: 0.06,
    width: 2.1,
    length: 5.0,
  },
};

export interface DetachPart {
  name: string;
  mesh: THREE.Mesh;
  health: number;
  anchor: THREE.Vector3; // local
  attached: boolean;
}

export class CarModel {
  root = new THREE.Group();
  bodyGroup = new THREE.Group();
  body: THREE.Mesh;
  wheels: THREE.Group[] = [];
  parts: DetachPart[] = [];
  paint: THREE.MeshStandardMaterial;
  private basePos: Float32Array;
  private deform: Float32Array;
  private glassMask: Uint8Array;
  headlights: THREE.Mesh[] = [];
  taillights: THREE.MeshBasicMaterial;
  headMat: THREE.MeshBasicMaterial;
  exhausts: THREE.Vector3[] = [];
  flames: THREE.Mesh[] = [];
  beacon: THREE.Group | null = null;
  spec: CarSpec;
  plateCanvas: HTMLCanvasElement | null = null;

  constructor(spec: CarSpec, opts: { paint?: number; accent?: number; plate?: string; police?: boolean; simple?: boolean } = {}) {
    this.spec = spec;
    const prof = PROFILES[spec.style];
    this.paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.35 });
    const geo = this.buildBody(prof, opts.simple ? 4 : 8);
    this.basePos = (geo.attributes.position.array as Float32Array).slice();
    this.deform = new Float32Array(this.basePos.length);
    this.glassMask = new Uint8Array(geo.attributes.position.count);
    this.body = new THREE.Mesh(geo, this.paint);
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.bodyGroup.add(this.body);
    this.root.add(this.bodyGroup);
    this.setPaint(opts.paint ?? spec.color, opts.accent ?? spec.accent);

    // lights
    this.headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.97, 0.85).multiplyScalar(2.5) });
    this.taillights = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.05, 0.02).multiplyScalar(1.5) });
    const L = prof.length / 2;
    const W = prof.width / 2;
    if (spec.style !== 'couch') {
      const hy = prof.top(0.98) - 0.18;
      for (const s of [-1, 1]) {
        const hl = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.12, 0.05), this.headMat);
        hl.position.set(s * (W - 0.32 - prof.noseTaper * 0.5), Math.max(prof.bottom + 0.2, hy), L - 0.01);
        this.bodyGroup.add(hl);
        this.headlights.push(hl);
        const tl = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.1, 0.05), this.taillights);
        tl.position.set(s * (W - 0.3), prof.top(-0.98) - 0.15, -L + 0.01);
        this.bodyGroup.add(tl);
      }
    }
    this.addStyleExtras(spec, prof, opts);
    // wheels
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
    const rimMat = new THREE.MeshStandardMaterial({ color: spec.style === 'muscle' ? 0xc0c0c0 : 0x2a2a2e, roughness: 0.3, metalness: 0.8 });
    const tg = new THREE.CylinderGeometry(spec.wheelR, spec.wheelR, spec.wheelW, opts.simple ? 10 : 18).rotateZ(Math.PI / 2);
    const rg = new THREE.CylinderGeometry(spec.wheelR * 0.62, spec.wheelR * 0.62, spec.wheelW + 0.02, opts.simple ? 6 : 10).rotateZ(Math.PI / 2);
    const spoke = new THREE.BoxGeometry(spec.wheelW + 0.03, spec.wheelR * 1.1, 0.06);
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      const spin = new THREE.Group();
      const t = new THREE.Mesh(tg, tireMat);
      t.castShadow = true;
      spin.add(t);
      spin.add(new THREE.Mesh(rg, rimMat));
      spin.add(new THREE.Mesh(spoke, rimMat));
      const sp2 = new THREE.Mesh(spoke, rimMat);
      sp2.rotation.x = Math.PI / 2;
      spin.add(sp2);
      g.add(spin);
      this.wheels.push(g);
      this.root.add(g);
    }
    if (opts.police) this.addPolice(prof);
  }

  private buildBody(p: Profile, seg: number): THREE.BufferGeometry {
    const box = new THREE.BoxGeometry(1, 1, 1, seg, Math.max(3, seg / 2), seg * 2);
    const pos = box.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const nx = pos.getX(i) * 2; // -1..1
      const ny = pos.getY(i) + 0.5; // 0..1
      const nz = pos.getZ(i) * 2; // -1..1
      const top = p.top(nz);
      let y = p.bottom + ny * (top - p.bottom);
      // round the nose/tail
      const ends = Math.pow(Math.abs(nz), 6);
      y = Math.min(y, top - ends * 0.12);
      let w = p.width / 2;
      // taper nose and tail in plan
      w *= 1 - p.noseTaper * Math.max(0, nz) ** 2 - 0.05 * Math.max(0, -nz) ** 3;
      // tumblehome above beltline
      if (y > p.beltline) w *= 1 - p.tumble * Math.min(1, (y - p.beltline) / 0.45);
      // soften vertical edges
      const edge = Math.abs(nx);
      const x = nx * w * (1 - 0.06 * Math.pow(ny, 2) * edge);
      let z = (nz * p.length) / 2;
      // slope the bottom up at the ends a bit
      if (ny < 0.1) y += ends * 0.12;
      pos.setXYZ(i, x, y, z);
    }
    let g: THREE.BufferGeometry = box.toNonIndexed();
    g.deleteAttribute('uv');
    g.computeVertexNormals();
    // per-face colour regions: paint / glass / trim
    const n = g.attributes.position.count;
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('region', new THREE.BufferAttribute(new Uint8Array(n), 1));
    const P = g.attributes.position;
    const N = g.attributes.normal;
    const R = g.attributes.region as THREE.BufferAttribute;
    for (let f = 0; f < n; f += 3) {
      let cy = 0, cz = 0, ny = 0;
      for (let k = 0; k < 3; k++) {
        cy += P.getY(f + k) / 3;
        cz += P.getZ(f + k) / 3;
        ny += N.getY(f + k) / 3;
      }
      const zn = cz / (p.length / 2);
      let region = 0; // paint
      if (cy > p.beltline + 0.04 && zn > p.cabinZ[0] && zn < p.cabinZ[1] && ny < 0.92) region = 1; // glass
      if (cy < p.bottom + 0.14) region = 2; // trim
      for (let k = 0; k < 3; k++) R.setX(f + k, region);
    }
    return g;
  }

  setPaint(paint: number, accent: number) {
    const g = this.body.geometry;
    const C = g.attributes.color as THREE.BufferAttribute;
    const R = g.attributes.region as THREE.BufferAttribute;
    const P = g.attributes.position;
    const pc = new THREE.Color(paint);
    const ac = new THREE.Color(accent);
    const glass = new THREE.Color(0.04, 0.05, 0.07);
    const trim = new THREE.Color(0.06, 0.06, 0.06);
    const stripes = this.spec.style === 'muscle' || this.spec.style === 'coupe' || this.spec.style === 'wedge';
    for (let i = 0; i < C.count; i++) {
      const r = R.getX(i);
      let c = r === 1 ? glass : r === 2 ? trim : pc;
      if (r === 0 && stripes && Math.abs(P.getX(i)) < 0.22 && Math.abs(P.getX(i)) > 0.08) c = ac;
      if (r === 0 && this.spec.style === 'van' && P.getY(i) > 1.0 && P.getY(i) < 1.3) c = ac;
      C.setXYZ(i, c.r, c.g, c.b);
    }
    C.needsUpdate = true;
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
      addPart('front bumper', new THREE.BoxGeometry(p.width * 0.98, 0.22, 0.25), dark, 0, p.bottom + 0.12, L + 0.05, 35);
      addPart('rear bumper', new THREE.BoxGeometry(p.width * 0.98, 0.22, 0.25), dark, 0, p.bottom + 0.12, -L - 0.05, 35);
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
        for (const s of [-1, 1]) addPart('armrest', new THREE.BoxGeometry(0.25, 0.4, 1.6), this.paint, s * 1.05, 1.12, 0, 40);
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
        // giant taco on the roof
        const shell = new THREE.Mesh(
          new THREE.CylinderGeometry(0.9, 0.9, 1.6, 20, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2),
          new THREE.MeshStandardMaterial({ color: 0xe8b84a, roughness: 0.8 }),
        );
        shell.rotation.x = Math.PI;
        const taco = new THREE.Group();
        taco.add(shell);
        const filling = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.25, 0.3), new THREE.MeshStandardMaterial({ color: 0x3fa63a }));
        filling.position.y = 0.05;
        taco.add(filling);
        taco.position.set(0, 2.6, -0.4);
        taco.scale.setScalar(0.8);
        this.bodyGroup.add(taco);
        this.parts.push({ name: 'TACO', mesh: shell, health: 50, anchor: new THREE.Vector3(0, 2.6, -0.4), attached: true });
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
    this.body.geometry.computeVertexNormals();
    const detached: DetachPart[] = [];
    for (const p of this.parts) {
      if (!p.attached) continue;
      const d = p.anchor.distanceTo(localPoint);
      if (d < radius + 0.6) {
        p.health -= strength * (1.6 - d / (radius + 0.6)) * 3;
        // dangle a bit
        p.mesh.rotation.z += (Math.random() - 0.5) * 0.1 * strength * 0.1;
        p.mesh.position.y -= 0.01 * strength;
        if (p.health <= 0) {
          p.attached = false;
          detached.push(p);
        }
      }
    }
    return detached;
  }

  repair() {
    const pos = this.body.geometry.attributes.position as THREE.BufferAttribute;
    (pos.array as Float32Array).set(this.basePos);
    this.deform.fill(0);
    pos.needsUpdate = true;
    this.body.geometry.computeVertexNormals();
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
  }

  setBrake(on: boolean, reverse: boolean) {
    this.taillights.color.setRGB(1, reverse ? 0.9 : 0.05, reverse ? 0.9 : 0.02).multiplyScalar(on ? 4 : 1.2);
  }

  setHeadlights(intensity: number) {
    this.headMat.color.setRGB(1, 0.97, 0.85).multiplyScalar(0.8 + intensity * 3);
  }

  dispose() {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
  }
}

// Simple merged mesh used for traffic (cheap, non-deforming)
export function trafficGeometry(kind: 'sedan' | 'truck' | 'bus' | 'hatch'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, region: number) => {
    const ng = g.toNonIndexed();
    ng.deleteAttribute('uv');
    const n = ng.attributes.position.count;
    ng.setAttribute('region', new THREE.BufferAttribute(new Float32Array(n).fill(region), 1));
    parts.push(ng);
  };
  // region: 0 paint, 1 glass, 2 dark, 3 headlight, 4 taillight
  if (kind === 'sedan' || kind === 'hatch') {
    const len = kind === 'sedan' ? 4.4 : 3.8;
    add(new THREE.BoxGeometry(1.8, 0.62, len).translate(0, 0.55, 0), 0);
    add(new THREE.BoxGeometry(1.6, 0.5, len * 0.5).translate(0, 1.1, kind === 'sedan' ? -0.15 : -0.35), 1);
    add(new THREE.BoxGeometry(1.62, 0.06, len * 0.46).translate(0, 1.37, kind === 'sedan' ? -0.15 : -0.35), 0);
    add(new THREE.BoxGeometry(0.35, 0.12, 0.05).translate(0.6, 0.65, len / 2), 3);
    add(new THREE.BoxGeometry(0.35, 0.12, 0.05).translate(-0.6, 0.65, len / 2), 3);
    add(new THREE.BoxGeometry(0.35, 0.12, 0.05).translate(0.6, 0.7, -len / 2), 4);
    add(new THREE.BoxGeometry(0.35, 0.12, 0.05).translate(-0.6, 0.7, -len / 2), 4);
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
    for (const s of [-1, 1]) add(new THREE.CylinderGeometry(wr, wr, 0.3, 10).rotateZ(Math.PI / 2).translate(s * wx, wr, z), 2);
  const g = mergeGeometries(parts)!;
  g.computeVertexNormals();
  return g;
}
