// Persistent tyre marks in a ring buffer of quads.
import * as THREE from 'three';

const MAX = 6000;

export class SkidMarks {
  mesh: THREE.Mesh;
  private pos: Float32Array;
  private alpha: Float32Array;
  private head = 0;
  private last: ({ l: THREE.Vector3; r: THREE.Vector3 } | null)[] = [null, null, null, null];
  private geo: THREE.BufferGeometry;

  constructor(scene: THREE.Scene) {
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX * 4 * 3);
    this.alpha = new Float32Array(MAX * 4);
    const idx = new Uint32Array(MAX * 6);
    for (let i = 0; i < MAX; i++) {
      const b = i * 4;
      idx.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], i * 6);
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      uniforms: { ...THREE.UniformsLib.fog },
      fog: true,
      vertexShader: /* glsl */ `attribute float aAlpha; varying float vA;
        #include <fog_pars_vertex>
        void main(){ vA = aAlpha; vec4 mvPosition = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mvPosition;
        #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `varying float vA;
        #include <fog_pars_fragment>
        void main(){ gl_FragColor = vec4(0.02,0.02,0.02, vA*0.75);
        #include <fog_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
  }

  /** wheel i is marking at contact p (normal n, side dir s, width w, intensity a). Pass a<=0 to lift. */
  add(i: number, p: THREE.Vector3, n: THREE.Vector3, side: THREE.Vector3, w: number, a: number) {
    if (a <= 0.02) {
      this.last[i] = null;
      return;
    }
    const lift = 0.03;
    const l = new THREE.Vector3().copy(p).addScaledVector(side, w / 2).addScaledVector(n, lift);
    const r = new THREE.Vector3().copy(p).addScaledVector(side, -w / 2).addScaledVector(n, lift);
    const prev = this.last[i];
    if (prev && prev.l.distanceToSquared(l) < 0.09) return; // segment length >= 0.3m
    if (prev && prev.l.distanceToSquared(l) < 9) {
      const k = this.head;
      this.head = (this.head + 1) % MAX;
      const o = k * 12;
      this.pos.set([prev.l.x, prev.l.y, prev.l.z, prev.r.x, prev.r.y, prev.r.z, l.x, l.y, l.z, r.x, r.y, r.z], o);
      this.alpha.set([a, a, a, a], k * 4);
      const pa = this.geo.attributes.position as THREE.BufferAttribute;
      const aa = this.geo.attributes.aAlpha as THREE.BufferAttribute;
      pa.addUpdateRange(o, 12);
      aa.addUpdateRange(k * 4, 4);
      pa.needsUpdate = true;
      aa.needsUpdate = true;
    }
    this.last[i] = { l, r };
  }

  clear() {
    this.alpha.fill(0);
    (this.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
    this.last = [null, null, null, null];
  }
}
