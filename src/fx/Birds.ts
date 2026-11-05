// Flocks of birds that sit by the road and scatter when you blast past (or honk).
import * as THREE from 'three';
import type { Game } from '../core/Game';
import { audio } from '../audio/AudioEngine';

interface Bird {
  p: THREE.Vector3;
  v: THREE.Vector3;
  phase: number;
}
interface Flock {
  birds: Bird[];
  centre: THREE.Vector3;
  flying: boolean;
  t: number;
}

const MAX = 160;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

export class Birds {
  private mesh: THREE.InstancedMesh;
  private flocks: Flock[] = [];
  private timer = 3;

  constructor(private game: Game) {
    // a little V-shaped bird
    const g = new THREE.BufferGeometry();
    const v = new Float32Array([
      0, 0, 0.25, -0.55, 0.08, -0.05, 0, 0, -0.15,
      0, 0, 0.25, 0, 0, -0.15, 0.55, 0.08, -0.05,
      0, 0.02, 0.3, 0, -0.05, -0.25, 0, 0.06, -0.2,
    ]);
    g.setAttribute('position', new THREE.BufferAttribute(v, 3));
    g.computeVertexNormals();
    this.mesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: 0x15151a, side: THREE.DoubleSide, fog: true }), MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    game.scene.add(this.mesh);
  }

  private spawn() {
    const g = this.game;
    const v = g.player.vehicle;
    const w = g.biomeWeights;
    if (w[2] > 0.5 || g.sky.state.night > 0.7 || g.weather.rain > 0.5) return;
    const dir = v.vel.clone().setY(0);
    if (dir.length() < 5) return;
    dir.normalize();
    const ahead = v.pos.clone().addScaledVector(dir, 90 + Math.random() * 70);
    const near = g.chunks.gen.nearestRoad(ahead.x, ahead.z, 60);
    if (!near) return;
    const e = near.edge;
    const q = near.idx;
    const side = Math.random() < 0.5 ? 1 : -1;
    const lat = side * (e.halfW + 4 + Math.random() * 10);
    const c = new THREE.Vector3(e.x[q] - e.tz[q] * lat, 0, e.z[q] + e.tx[q] * lat);
    c.y = g.chunks.heightAt(c.x, c.z);
    const n = 10 + Math.floor(Math.random() * 14);
    const birds: Bird[] = [];
    for (let i = 0; i < n; i++) {
      const p = c.clone().add(new THREE.Vector3((Math.random() - 0.5) * 9, 0, (Math.random() - 0.5) * 9));
      p.y = g.chunks.heightAt(p.x, p.z) + 0.1;
      birds.push({ p, v: new THREE.Vector3(), phase: Math.random() * 10 });
    }
    this.flocks.push({ birds, centre: c, flying: false, t: 0 });
  }

  scatter(f: Flock, from: THREE.Vector3) {
    f.flying = true;
    audio.flap();
    for (const b of f.birds) {
      const away = b.p.clone().sub(from).setY(0).normalize();
      b.v.set(away.x * (6 + Math.random() * 6), 5 + Math.random() * 6, away.z * (6 + Math.random() * 6));
    }
  }

  update(dt: number) {
    const g = this.game;
    const v = g.player.vehicle;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 5 + Math.random() * 6;
      if (this.flocks.length < 4) this.spawn();
    }
    const honk = g.controls?.horn;
    let k = 0;
    for (let fi = this.flocks.length - 1; fi >= 0; fi--) {
      const f = this.flocks[fi];
      const d = f.centre.distanceTo(v.pos);
      if (!f.flying && ((d < 35 && v.speedAbs > 8) || (honk && d < 70))) this.scatter(f, v.pos);
      if (f.flying) f.t += dt;
      if (d > 400 || f.t > 12) {
        this.flocks.splice(fi, 1);
        continue;
      }
      for (const b of f.birds) {
        if (k >= MAX) break;
        b.phase += dt * (f.flying ? 18 : 2);
        let flap = 1;
        if (f.flying) {
          b.v.y += (1.5 - b.v.y * 0.2) * dt;
          b.v.x += (Math.random() - 0.5) * 8 * dt;
          b.v.z += (Math.random() - 0.5) * 8 * dt;
          b.p.addScaledVector(b.v, dt);
          flap = 0.35 + 0.65 * Math.abs(Math.sin(b.phase));
          _e.set(-Math.atan2(b.v.y, Math.hypot(b.v.x, b.v.z)) * 0.5, Math.atan2(b.v.x, b.v.z), 0);
        } else {
          // pecking about
          _e.set(Math.sin(b.phase) > 0.8 ? 0.4 : 0, b.phase * 0.1, 0);
          flap = 0.4;
        }
        _q.setFromEuler(_e);
        _s.set(flap * 1.2, 1, 1);
        _m.compose(b.p, _q, _s);
        this.mesh.setMatrixAt(k++, _m);
      }
    }
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
