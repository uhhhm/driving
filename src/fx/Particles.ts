// CPU-simulated, GPU-rendered particle pools (soft smoke/dust + additive sparks/fire) and debris chunks.
import * as THREE from 'three';

/** Shared by both pools: viewport height in px and the player car (kept see-through). */
const particleUniforms = {
  uViewH: { value: 720 },
  uFocus: { value: new THREE.Vector3() },
  uFocusR: { value: 0 },
};

interface PoolOpts {
  max: number;
  additive: boolean;
}

class Pool {
  max: number;
  pos: Float32Array;
  vel: Float32Array;
  col: Float32Array; // rgba
  size: Float32Array;
  life: Float32Array;
  maxLife: Float32Array;
  grow: Float32Array;
  drag: Float32Array;
  grav: Float32Array;
  head = 0;
  points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private aCol: THREE.BufferAttribute;
  private aSize: THREE.BufferAttribute;
  private aPos: THREE.BufferAttribute;
  alive = 0;

  constructor(o: PoolOpts) {
    this.max = o.max;
    const n = o.max;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.col = new Float32Array(n * 4);
    this.size = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n).fill(1);
    this.grow = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3);
    this.aCol = new THREE.BufferAttribute(new Float32Array(n * 4), 4);
    this.aSize = new THREE.BufferAttribute(new Float32Array(n), 1);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aCol.setUsage(THREE.DynamicDrawUsage);
    this.aSize.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.aPos);
    this.geo.setAttribute('aColor', this.aCol);
    this.geo.setAttribute('aSize', this.aSize);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsLib.fog, ...particleUniforms },
      transparent: true,
      depthWrite: false,
      blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
      // only soft smoke/dust thins out over the car; boost flames and sparks stay at full strength
      defines: o.additive ? {} : { FOCUS_FADE: '' },
      vertexShader: /* glsl */ `
        attribute vec4 aColor; attribute float aSize;
        uniform float uViewH; uniform vec3 uFocus; uniform float uFocusR;
        varying vec4 vC;
        #include <fog_pars_vertex>
        void main(){
          vC = aColor;
          vec4 mvPosition = modelViewMatrix * vec4(position,1.0);
          float depth = max(0.1, -mvPosition.z);
          // projected size in pixels (tracks the live FOV via the projection matrix)
          float px = aSize * projectionMatrix[1][1] * 0.5 * uViewH / depth;
          // never let one sprite cover a big chunk of the screen
          float maxPx = uViewH * 0.22;
          vC.a *= min(1.0, maxPx / max(px, 1.0));
          gl_PointSize = min(px, maxPx);
          // fade out as particles reach the camera instead of blooming into a full-screen blob
          vC.a *= smoothstep(1.2, 4.5, depth);
          #ifdef FOCUS_FADE
          // keep the player's car readable: thin out smoke/dust sitting between the camera and the car
          vec4 f = viewMatrix * vec4(uFocus, 1.0);
          float fd = max(0.1, -f.z);
          if (uFocusR > 0.0 && depth < fd - 0.3) {
            float sep = length(mvPosition.xy / depth - f.xy / fd) * fd; // distance in metres at the car's depth
            float cover = 1.0 - smoothstep(uFocusR, uFocusR * 2.2, sep + aSize * 0.25);
            vC.a *= 1.0 - 0.7 * cover;
          }
          #endif
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vC;
        #include <fog_pars_fragment>
        void main(){ vec2 p = gl_PointCoord - 0.5; float d = dot(p,p)*4.0; if (d > 1.0) discard;
          float a = (1.0 - d); a *= a;
          gl_FragColor = vec4(vC.rgb, vC.a * a);
          #include <fog_fragment>
        }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = o.additive ? 12 : 11;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, a: number, size: number, life: number, grow = 0, drag = 0.5, grav = 0) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.emitted = true;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.col[i * 4] = r;
    this.col[i * 4 + 1] = g;
    this.col[i * 4 + 2] = b;
    this.col[i * 4 + 3] = a;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grow[i] = grow;
    this.drag[i] = drag;
    this.grav[i] = grav;
  }

  private emitted = false;
  update(dt: number) {
    if (this.alive === 0 && !this.emitted) return;
    this.emitted = false;
    const c = this.aCol.array as Float32Array;
    const s = this.aSize.array as Float32Array;
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        if (s[i] !== 0) {
          s[i] = 0;
          c[i * 4 + 3] = 0;
        }
        continue;
      }
      alive++;
      this.life[i] -= dt;
      const k = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      const fadeIn = Math.min(1, (1 - t) * 8);
      c[i * 4] = this.col[i * 4];
      c[i * 4 + 1] = this.col[i * 4 + 1];
      c[i * 4 + 2] = this.col[i * 4 + 2];
      c[i * 4 + 3] = this.col[i * 4 + 3] * t * fadeIn;
      s[i] = this.size[i];
    }
    this.alive = alive;
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aSize.needsUpdate = true;
  }
}

interface Chunk3D {
  mesh: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
  ground: number;
}

export class Particles {
  soft: Pool;
  glow: Pool;
  private debris: Chunk3D[] = [];
  private debrisGeo = new THREE.BoxGeometry(0.25, 0.12, 0.3);
  private debrisMats = new Map<number, THREE.MeshStandardMaterial>();
  group = new THREE.Group();
  heightAt: (x: number, z: number) => number = () => 0;
  quality = 1;

  constructor(scene: THREE.Scene) {
    this.soft = new Pool({ max: 5000, additive: false });
    this.glow = new Pool({ max: 3000, additive: true });
    scene.add(this.soft.points, this.glow.points, this.group);
  }

  /** Viewport height in device pixels; sprite size follows the live camera FOV in the shader. */
  setScale(h: number) {
    particleUniforms.uViewH.value = h;
  }

  /** World position + radius of the object particles should never hide (the player's car). */
  setFocus(p: THREE.Vector3, radius: number) {
    particleUniforms.uFocus.value.copy(p);
    particleUniforms.uFocusR.value = radius;
  }

  smoke(p: THREE.Vector3, v: THREE.Vector3, amount: number, color: [number, number, number] = [0.85, 0.85, 0.88]) {
    if (Math.random() > this.quality) return;
    const r = () => (Math.random() - 0.5) * 2;
    this.soft.emit(p.x + r() * 0.2, p.y + 0.2, p.z + r() * 0.2, v.x * 0.3 + r() * 1.2, 0.8 + Math.random() * 1.2, v.z * 0.3 + r() * 1.2, color[0], color[1], color[2], 0.3 * amount + 0.08, 0.8, 1.4 + Math.random() * 1.2, 2.0, 1.2, -0.3);
  }

  dust(p: THREE.Vector3, v: THREE.Vector3, amount: number, color: [number, number, number]) {
    if (Math.random() > this.quality) return;
    const r = () => (Math.random() - 0.5) * 2;
    this.soft.emit(p.x + r() * 0.3, p.y + 0.15, p.z + r() * 0.3, v.x * 0.2 + r() * 1.5, 0.5 + Math.random() * 1.5, v.z * 0.2 + r() * 1.5, color[0], color[1], color[2], 0.32 * amount, 0.7, 1.0 + Math.random() * 0.8, 1.9, 1.0, 0.2);
  }

  sparks(p: THREE.Vector3, dir: THREE.Vector3, count: number, speed = 8) {
    for (let i = 0; i < count; i++) {
      const s = speed * (0.4 + Math.random());
      this.glow.emit(
        p.x, p.y, p.z,
        dir.x * s + (Math.random() - 0.5) * speed, dir.y * s + Math.random() * speed * 0.6, dir.z * s + (Math.random() - 0.5) * speed,
        3.0, 1.6 + Math.random(), 0.5, 1, 0.12 + Math.random() * 0.1, 0.3 + Math.random() * 0.5, -0.1, 0.8, 16,
      );
    }
  }

  fire(p: THREE.Vector3, v: THREE.Vector3, intensity: number) {
    const r = () => (Math.random() - 0.5) * 2;
    this.glow.emit(p.x + r() * 0.2, p.y, p.z + r() * 0.2, v.x + r(), v.y + 1 + Math.random() * 2, v.z + r(), 3, 1.0 + Math.random() * 0.6, 0.2, 0.8 * intensity, 0.5 + Math.random() * 0.5, 0.35 + Math.random() * 0.3, 1.5, 1.5, -2);
  }

  boostFlame(p: THREE.Vector3, back: THREE.Vector3, carVel: THREE.Vector3, big: boolean) {
    const s = big ? 2 : 1;
    for (let i = 0; i < 2; i++) {
      this.glow.emit(
        p.x, p.y, p.z,
        carVel.x + back.x * 12 * s + (Math.random() - 0.5) * 2, carVel.y + back.y * 12 + (Math.random() - 0.5), carVel.z + back.z * 12 * s + (Math.random() - 0.5) * 2,
        0.6, 1.0, 3.0, 0.9, 0.35 * s, 0.12 + Math.random() * 0.08, 2.5 * s, 3, 0,
      );
    }
  }

  explosion(p: THREE.Vector3, power: number) {
    const n = Math.floor(80 * power);
    for (let i = 0; i < n; i++) {
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize();
      const s = 6 + Math.random() * 14 * power;
      this.glow.emit(p.x, p.y + 0.5, p.z, d.x * s, d.y * s, d.z * s, 3, 1.1 + Math.random() * 0.8, 0.25, 1, 1.4 + Math.random() * 1.8 * power, 0.5 + Math.random() * 0.6, 3, 2.8, -1);
    }
    for (let i = 0; i < n * 0.8; i++) {
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random(), Math.random() - 0.5).normalize();
      const s = 3 + Math.random() * 8 * power;
      const g = 0.12 + Math.random() * 0.15;
      this.soft.emit(p.x, p.y + 1, p.z, d.x * s, d.y * s * 1.2, d.z * s, g, g, g, 0.7, 2 + Math.random() * 2 * power, 2.5 + Math.random() * 2.5, 2.5, 1.2, -0.6);
    }
    this.sparks(p, new THREE.Vector3(0, 1, 0), Math.floor(40 * power), 18);
  }

  splash(p: THREE.Vector3, amount: number) {
    for (let i = 0; i < amount; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 1 + Math.random() * 3;
      this.soft.emit(p.x, p.y, p.z, Math.cos(a) * s, 2 + Math.random() * 5, Math.sin(a) * s, 0.8, 0.88, 0.95, 0.5, 0.3 + Math.random() * 0.4, 0.6 + Math.random() * 0.5, 0.6, 0.6, 12);
    }
  }

  leaves(p: THREE.Vector3, v: THREE.Vector3, color: [number, number, number], n = 25) {
    for (let i = 0; i < n; i++) {
      const r = () => (Math.random() - 0.5) * 2;
      this.soft.emit(p.x + r(), p.y + 1 + Math.random() * 2, p.z + r(), v.x * 0.4 + r() * 4, 2 + Math.random() * 4, v.z * 0.4 + r() * 4, color[0], color[1], color[2], 0.9, 0.18, 1.5 + Math.random() * 1.5, 0, 1.5, 4);
    }
  }

  debrisBurst(p: THREE.Vector3, v: THREE.Vector3, color: number, n: number) {
    let mat = this.debrisMats.get(color);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2 });
      this.debrisMats.set(color, mat);
    }
    for (let i = 0; i < n; i++) {
      if (this.debris.length > 140) {
        const old = this.debris.shift()!;
        this.group.remove(old.mesh);
      }
      const m = new THREE.Mesh(this.debrisGeo, mat);
      m.position.copy(p);
      m.scale.setScalar(0.5 + Math.random() * 1.2);
      m.castShadow = false;
      this.group.add(m);
      this.debris.push({
        mesh: m,
        vel: new THREE.Vector3(v.x * 0.6 + (Math.random() - 0.5) * 9, 3 + Math.random() * 7, v.z * 0.6 + (Math.random() - 0.5) * 9),
        spin: new THREE.Vector3(Math.random() * 15, Math.random() * 15, Math.random() * 15),
        life: 4 + Math.random() * 3,
        ground: this.heightAt(p.x, p.z),
      });
    }
  }

  update(dt: number) {
    this.soft.update(dt);
    this.glow.update(dt);
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      if (d.life <= 0) {
        this.group.remove(d.mesh);
        this.debris.splice(i, 1);
        continue;
      }
      d.vel.y -= 18 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      if (d.mesh.position.y < d.ground + 0.08) {
        d.mesh.position.y = d.ground + 0.08;
        d.vel.y *= -0.3;
        d.vel.x *= 0.6;
        d.vel.z *= 0.6;
        d.spin.multiplyScalar(0.6);
        d.ground = this.heightAt(d.mesh.position.x, d.mesh.position.z);
      }
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      if (d.life < 1) d.mesh.scale.multiplyScalar(1 - dt * 2);
    }
  }
}
