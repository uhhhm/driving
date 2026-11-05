// Ghost replays: records the run (10 Hz) and plays back the best run on this seed.
import * as THREE from 'three';
import type { Game } from '../core/Game';
import { CarModel } from '../vehicle/CarModel';
import { carById } from '../vehicle/VehicleDefs';

interface GhostRun {
  car: string;
  score: number;
  dt: number;
  frames: number[]; // x,y,z,qx,qy,qz,qw per frame (quantised)
  scores: number[]; // score every second
}

const RATE = 0.1;
const MAX_FRAMES = 3600; // 6 minutes
const key = (seed: string) => `seedrunner.ghost.${seed.toUpperCase()}`;

export class Ghost {
  private rec: number[] = [];
  private recScores: number[] = [];
  private acc = 0;
  private t = 0;
  best: GhostRun | null = null;
  private model: CarModel | null = null;
  private label: HTMLDivElement;
  enabled = true;
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();

  constructor(private game: Game) {
    try {
      const s = localStorage.getItem(key(game.seedText));
      if (s) this.best = JSON.parse(s);
    } catch {
      this.best = null;
    }
    this.label = document.createElement('div');
    this.label.style.cssText = 'position:fixed;z-index:4;pointer-events:none;font:700 12px Chakra Petch,sans-serif;color:#7ff;text-shadow:0 0 6px #0ff;letter-spacing:.1em;display:none;transform:translate(-50%,-100%)';
    document.body.appendChild(this.label);
    if (this.best) this.makeModel();
  }

  private makeModel() {
    if (!this.best) return;
    if (this.model) this.game.scene.remove(this.model.root);
    const m = new CarModel(carById(this.best.car), { simple: true });
    const mat = new THREE.MeshBasicMaterial({ color: 0x55ffff, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending });
    m.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.material = mat;
        mesh.castShadow = false;
      }
    });
    this.model = m;
    this.game.scene.add(m.root);
  }

  restart() {
    this.rec = [];
    this.recScores = [];
    this.t = 0;
    this.acc = 0;
  }

  update(dt: number) {
    if (dt <= 0) return;
    const g = this.game;
    const v = g.player.vehicle;
    this.t += dt;
    this.acc += dt;
    if (this.acc >= RATE && this.rec.length / 7 < MAX_FRAMES) {
      this.acc -= RATE;
      const q = v.quat;
      this.rec.push(+v.pos.x.toFixed(2), +v.pos.y.toFixed(2), +v.pos.z.toFixed(2), +q.x.toFixed(3), +q.y.toFixed(3), +q.z.toFixed(3), +q.w.toFixed(3));
      if (this.rec.length / 7 % 10 === 0) this.recScores.push(g.score.total);
    }
    // playback
    const b = this.best;
    if (!b || !this.model || !this.enabled) {
      if (this.model) this.model.root.visible = false;
      this.label.style.display = 'none';
      return;
    }
    const n = b.frames.length / 7;
    const f = this.t / b.dt;
    const i = Math.floor(f);
    if (i >= n - 1) {
      this.model.root.visible = false;
      this.label.style.display = 'none';
      return;
    }
    const u = f - i;
    const F = b.frames;
    const o = i * 7;
    const p = o + 7;
    this.model.root.visible = true;
    this.model.root.position.set(F[o] + (F[p] - F[o]) * u, F[o + 1] + (F[p + 1] - F[o + 1]) * u, F[o + 2] + (F[p + 2] - F[o + 2]) * u);
    this.qa.set(F[o + 3], F[o + 4], F[o + 5], F[o + 6]).normalize();
    this.qb.set(F[p + 3], F[p + 4], F[p + 5], F[p + 6]).normalize();
    this.model.root.quaternion.slerpQuaternions(this.qa, this.qb, u);
    // label
    const sp = this.model.root.position.clone().add(new THREE.Vector3(0, 2.6, 0)).project(g.rig.camera);
    const d = this.model.root.position.distanceTo(v.pos);
    if (sp.z < 1 && d < 250 && d > 3) {
      this.label.style.display = 'block';
      this.label.style.left = `${(sp.x * 0.5 + 0.5) * innerWidth}px`;
      this.label.style.top = `${(-sp.y * 0.5 + 0.5) * innerHeight}px`;
      const gs = b.scores[Math.min(b.scores.length - 1, Math.floor(this.t))] ?? 0;
      this.label.textContent = `GHOST · ${Math.round(gs).toLocaleString()}`;
    } else this.label.style.display = 'none';
  }

  /** Save the current run if it beats the best. Returns true if saved. */
  commit(): boolean {
    const score = this.game.score.total;
    if (this.rec.length < 70 || score <= (this.best?.score ?? 0)) return false;
    const run: GhostRun = { car: this.game.player.vehicle.spec.id, score, dt: RATE, frames: this.rec.slice(), scores: this.recScores.slice() };
    try {
      localStorage.setItem(key(this.game.seedText), JSON.stringify(run));
    } catch {
      return false;
    }
    return true;
  }
}
