// Global instanced rendering of all props in loaded chunks (near set casts shadows).
import * as THREE from 'three';
import { Prop, PROP_COUNT, PROP_STRIDE } from './types';
import { PROP_GEOMS, lampBulbGeometry } from './PropGeometry';
import { worldUniforms } from './Materials';
import type { Chunk } from './ChunkManager';

const ROCK_TINT = [
  new THREE.Color(0.75, 0.42, 0.28), // desert
  new THREE.Color(0.5, 0.5, 0.52), // alpine
  new THREE.Color(0.35, 0.35, 0.4), // city
  new THREE.Color(0.62, 0.58, 0.5), // coast
];
const BUSH_TINT = [
  new THREE.Color(0.45, 0.42, 0.22),
  new THREE.Color(0.18, 0.35, 0.15),
  new THREE.Color(0.2, 0.3, 0.2),
  new THREE.Color(0.3, 0.5, 0.2),
];

function buildingMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.2 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, worldUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aVariant;\nvarying vec3 vLocal;\nvarying vec3 vObjN;\nvarying float vVar;\nvarying vec3 vSize;',
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vLocal = position * vSize;
        vObjN = normal;
        vVar = aVariant;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vLocal; varying vec3 vObjN; varying float vVar; varying vec3 vSize;
        uniform float uNight; uniform float uTime;
        float bh(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
        vec3 hue(float h){ return clamp(abs(mod(h*6.0+vec3(0,4,2),6.0)-3.0)-1.0, 0.0, 1.0); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float side = step(abs(vObjN.y), 0.5);
        float uu = abs(vObjN.x) > 0.5 ? vLocal.z : vLocal.x;
        float vv = vLocal.y;
        vec2 cell = floor(vec2(uu/3.0, vv/3.6));
        vec2 f = fract(vec2(uu/3.0, vv/3.6));
        float win = side * step(0.18, f.x) * step(f.x, 0.82) * step(0.25, f.y) * step(f.y, 0.8) * step(4.0, vv);
        vec3 baseC = mix(vec3(0.12,0.12,0.15), vec3(0.32,0.3,0.34), fract(vVar*7.0));
        diffuseColor.rgb = mix(baseC, vec3(0.05,0.08,0.12), win);
        float lit = step(0.5, bh(cell + vVar*91.0 + vObjN.xz*13.0));
        vec3 winCol = mix(vec3(1.0,0.75,0.45), vec3(0.6,0.85,1.0), step(0.6, bh(cell.yx + vVar)));
        vec3 neon = hue(fract(vVar*3.7));
        float topBand = side * smoothstep(0.35, 0.0, abs(vv - (vSize.y - 1.2)));
        float shop = side * step(vv, 3.6) * step(0.6, vv) * step(0.3, fract(uu/9.0));
        float pulse = 0.75 + 0.25*sin(uTime*2.0 + vVar*30.0);
        vec3 em = win * lit * winCol * 1.6 + topBand * neon * 5.0 * pulse + shop * neon * 1.8;
        float nightK = 0.12 + uNight * 0.88;
        `,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += em * nightK;`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.85, 0.15, win);');
  };
  return m;
}

function billboardMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...worldUniforms, ...THREE.UniformsLib.fog },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute float aVariant; varying vec2 vUv; varying float vVar;
      #include <common>
      #include <fog_pars_vertex>
      void main(){ vUv = uv; vVar = aVariant; vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position,1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; varying vec2 vUv; varying float vVar;
      #include <common>
      #include <fog_pars_fragment>
      vec3 hue(float h){ return clamp(abs(mod(h*6.0+vec3(0,4,2),6.0)-3.0)-1.0, 0.0, 1.0); }
      void main(){
        vec3 a = hue(fract(vVar*5.3)); vec3 b = hue(fract(vVar*5.3+0.4));
        float frame = step(0.04, vUv.x)*step(vUv.x,0.96)*step(0.08,vUv.y)*step(vUv.y,0.92);
        float stripes = step(0.5, fract(vUv.x*6.0 - uTime*0.5 + vUv.y*2.0));
        float blocks = step(0.35, fract(sin(floor(vUv.x*14.0 + floor(uTime*1.5 + vVar*10.0))*37.1)*411.3));
        vec3 c = mix(a, b, stripes) * (0.4 + 0.6*blocks*step(0.3, vUv.y)*step(vUv.y,0.7));
        c = mix(a*2.5, c*1.6, frame);
        gl_FragColor = vec4(c*2.2, 1.0);
        #include <fog_fragment>
      }`,
    fog: true,
  });
}

interface Slot {
  mesh: THREE.InstancedMesh;
  variant?: THREE.InstancedBufferAttribute;
  capacity: number;
}

export class PropRenderer {
  private geoms: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private sets: Slot[][] = [[], []]; // [near, far]
  private bulbs: Slot;
  private bulbMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.85, 0.6).multiplyScalar(3) });
  private poolMat: THREE.ShaderMaterial;
  private pools: Slot;
  private poolGeo: THREE.BufferGeometry;
  private scene: THREE.Scene;
  nightLights = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const natural = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
    const tinted = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
    const shiny = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.1 });
    const bmat = buildingMaterial();
    const bb = billboardMaterial();
    for (let t = 0; t < PROP_COUNT; t++) {
      this.geoms[t] = PROP_GEOMS[t]();
      this.mats[t] =
        t === Prop.Building ? bmat : t === Prop.Billboard ? bb : t === Prop.Rock || t === Prop.Bush ? tinted : t >= Prop.Lamp ? shiny : natural;
    }
    for (let s = 0; s < 2; s++) for (let t = 0; t < PROP_COUNT; t++) this.sets[s][t] = this.makeSlot(t, 64, s === 0);
    this.bulbs = this.makeSlotRaw(lampBulbGeometry(), this.bulbMat, 64, false);
    // light pool cone: apex at bulb, base on ground
    const cone = new THREE.ConeGeometry(4.2, 7.6, 16, 1, true);
    cone.translate(0, 7.6 / 2, 0);
    cone.translate(0, 0.05, 2.2);
    this.poolGeo = cone;
    this.poolMat = new THREE.ShaderMaterial({
      uniforms: { uNight: worldUniforms.uNight },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying float vH; varying vec3 vN; varying vec3 vV;
        void main(){ vH = position.y / 7.6; vec4 wp = modelMatrix * instanceMatrix * vec4(position,1.0);
          vN = normalize(mat3(modelMatrix * instanceMatrix) * normal); vV = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: /* glsl */ `
        uniform float uNight; varying float vH; varying vec3 vN; varying vec3 vV;
        void main(){ float edge = pow(1.0 - abs(dot(vN, vV)), 1.5);
          float a = (1.0 - edge) * mix(0.02, 0.16, vH) * uNight;
          gl_FragColor = vec4(vec3(1.0,0.8,0.55)*a, 1.0); }`,
    });
    this.pools = this.makeSlotRaw(this.poolGeo, this.poolMat, 64, false);
    this.pools.mesh.renderOrder = 10;
  }

  private makeSlot(t: number, cap: number, shadows: boolean): Slot {
    const s = this.makeSlotRaw(this.geoms[t], this.mats[t], cap, shadows && t !== Prop.Billboard);
    if (t === Prop.Rock || t === Prop.Bush) {
      s.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    }
    return s;
  }

  private makeSlotRaw(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, shadows: boolean): Slot {
    const g = geo.clone();
    const variant = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    g.setAttribute('aVariant', variant);
    const mesh = new THREE.InstancedMesh(g, mat, cap);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return { mesh, variant, capacity: cap };
  }

  private ensure(slot: Slot, need: number, rebuild: (cap: number) => Slot): Slot {
    if (need <= slot.capacity) return slot;
    let cap = slot.capacity;
    while (cap < need) cap *= 2;
    this.scene.remove(slot.mesh);
    slot.mesh.geometry.dispose();
    slot.mesh.dispose();
    return rebuild(cap);
  }

  rebuild(chunks: Iterable<Chunk>, cx: number, cz: number) {
    const list = Array.from(chunks);
    // count
    const counts = [new Int32Array(PROP_COUNT), new Int32Array(PROP_COUNT)];
    let lamps = 0;
    for (const c of list) {
      const near = Math.max(Math.abs(c.cx - cx), Math.abs(c.cz - cz)) <= 1 ? 0 : 1;
      const p = c.data.props;
      const n = p.length / PROP_STRIDE;
      for (let i = 0; i < n; i++) {
        if (!c.alive[i]) continue;
        counts[near][p[i * PROP_STRIDE]]++;
        if (p[i * PROP_STRIDE] === Prop.Lamp) lamps++;
      }
    }
    for (let s = 0; s < 2; s++)
      for (let t = 0; t < PROP_COUNT; t++)
        this.sets[s][t] = this.ensure(this.sets[s][t], counts[s][t], (cap) => this.makeSlot(t, cap, s === 0));
    this.bulbs = this.ensure(this.bulbs, lamps, (cap) => this.makeSlotRaw(lampBulbGeometry(), this.bulbMat, cap, false));
    this.pools = this.ensure(this.pools, lamps, (cap) => {
      const s = this.makeSlotRaw(this.poolGeo, this.poolMat, cap, false);
      s.mesh.renderOrder = 10;
      return s;
    });

    const fill = [new Int32Array(PROP_COUNT), new Int32Array(PROP_COUNT)];
    let lampFill = 0;
    const tmpC = new THREE.Color();
    for (const c of list) {
      const near = Math.max(Math.abs(c.cx - cx), Math.abs(c.cz - cz)) <= 1 ? 0 : 1;
      const p = c.data.props;
      const m = c.propMatrices!;
      const n = p.length / PROP_STRIDE;
      for (let i = 0; i < n; i++) {
        if (!c.alive[i]) continue;
        const t = p[i * PROP_STRIDE];
        const slot = this.sets[near][t];
        const k = fill[near][t]++;
        (slot.mesh.instanceMatrix.array as Float32Array).set(m.subarray(i * 16, i * 16 + 16), k * 16);
        const v = p[i * PROP_STRIDE + 8];
        slot.variant!.array[k] = v;
        if (slot.mesh.instanceColor) {
          const b = Math.min(3, Math.floor(v));
          tmpC.copy(t === Prop.Rock ? ROCK_TINT[b] : BUSH_TINT[b]);
          tmpC.multiplyScalar(0.85 + (v % 1) * 0.3);
          slot.mesh.instanceColor.setXYZ(k, tmpC.r, tmpC.g, tmpC.b);
        }
        if (t === Prop.Lamp) {
          (this.bulbs.mesh.instanceMatrix.array as Float32Array).set(m.subarray(i * 16, i * 16 + 16), lampFill * 16);
          (this.pools.mesh.instanceMatrix.array as Float32Array).set(m.subarray(i * 16, i * 16 + 16), lampFill * 16);
          lampFill++;
        }
      }
    }
    for (let s = 0; s < 2; s++)
      for (let t = 0; t < PROP_COUNT; t++) {
        const slot = this.sets[s][t];
        slot.mesh.count = fill[s][t];
        slot.mesh.instanceMatrix.needsUpdate = true;
        slot.variant!.needsUpdate = true;
        if (slot.mesh.instanceColor) slot.mesh.instanceColor.needsUpdate = true;
      }
    this.bulbs.mesh.count = lampFill;
    this.bulbs.mesh.instanceMatrix.needsUpdate = true;
    this.pools.mesh.count = lampFill;
    this.pools.mesh.instanceMatrix.needsUpdate = true;
  }

  setNight(n: number) {
    this.pools.mesh.visible = n > 0.05;
    this.bulbMat.color.setRGB(1, 0.85, 0.6).multiplyScalar(0.6 + n * 3);
  }

  geometry(t: Prop) {
    return this.geoms[t];
  }
  material(t: Prop) {
    return this.mats[t];
  }
}
