// Orchestrates all systems: fixed-step physics, streaming world, rendering, gameplay.
import * as THREE from 'three';
import { Physics, RAPIER } from './Physics';
import { Input, type Controls } from './Input';
import { bus } from './events';
import { clamp, damp, lerp } from './rng';
import { ChunkManager } from '../world/ChunkManager';
import { Sky } from '../world/Sky';
import { worldUniforms } from '../world/Materials';
import { CHUNK, BIOME_NAMES } from '../world/types';
import { Vehicle } from '../vehicle/Vehicle';
import { CarModel } from '../vehicle/CarModel';
import { CARS, carById, applyUpgrades, type CarSpec } from '../vehicle/VehicleDefs';
import { CameraRig } from '../camera/CameraRig';
import { HUD } from '../ui/HUD';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

export interface PlayerCar {
  vehicle: Vehicle;
  model: CarModel;
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
}

export class Game {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  physics = new Physics();
  input = new Input();
  chunks!: ChunkManager;
  sky!: Sky;
  rig: CameraRig;
  hud!: HUD;
  player!: PlayerCar;
  seed = 1;
  seedText = 'SEEDRUNNER';
  timeScale = 1;
  private targetTimeScale = 1;
  private acc = 0;
  private last = performance.now();
  simTime = 0;
  paused = false;
  controls: Controls | null = null;
  stats = { fps: 60, frameMs: 0, physMs: 0, renderMs: 0 };
  private fpsAcc = 0;
  private fpsFrames = 0;
  weatherGrip = 1;
  iceRoads = 0;
  // hooks for systems added later
  systems: { update(dt: number, realDt: number): void }[] = [];
  fixedSystems: { fixedUpdate(dt: number): void }[] = [];
  render: (() => void) | null = null;
  private slowMoTimer = 0;
  currentBiome = -1;
  biomeWeights = new Float32Array(4);

  constructor(public container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.rig = new CameraRig(window.innerWidth / window.innerHeight);
    window.addEventListener('resize', () => this.onResize());
  }

  onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.rig.camera.aspect = w / h;
    this.rig.camera.updateProjectionMatrix();
    this.onResizeHook?.(w, h);
  }
  onResizeHook?: (w: number, h: number) => void;

  async init(seedText: string, carId: string) {
    await this.physics.init();
    this.seedText = seedText;
    this.seed = hashSeed(seedText);
    this.chunks = new ChunkManager(this.seed, this.physics, this.scene);
    this.sky = new Sky(this.scene);
    this.hud = new HUD(this);
    const spawn = this.findSpawn();
    this.chunks.warmup(spawn.pos.x, spawn.pos.z);
    this.spawnPlayer(carById(carId), spawn.pos, spawn.yaw);
    this.rig.snap(this.player.vehicle);
  }

  findSpawn(): { pos: THREE.Vector3; yaw: number } {
    const gen = this.chunks.gen;
    // search outward for a decent straight edge
    for (let r = 0; r < 6; r++)
      for (let j = -r; j <= r; j++)
        for (let i = -r; i <= r; i++) {
          for (const d of [0, 1]) {
            const e = gen.edge(i, j, d);
            if (!e || e.n < 40) continue;
            const q = 18;
            if (e.flags[q] & 3) continue;
            const yaw = Math.atan2(e.tx[q], e.tz[q]);
            const lat = e.halfW * 0.4; // right-hand lane
            return { pos: new THREE.Vector3(e.x[q] - e.tz[q] * lat, e.h[q] + 0.9, e.z[q] + e.tx[q] * lat), yaw };
          }
        }
    return { pos: new THREE.Vector3(0, gen.baseHeight(0, 0) + 2, 0), yaw: 0 };
  }

  spawnPlayer(spec: CarSpec, pos: THREE.Vector3, yaw: number, paint?: number) {
    if (this.player) {
      this.player.vehicle.dispose();
      this.scene.remove(this.player.model.root);
      this.player.model.dispose();
    }
    const vehicle = new Vehicle(this.physics, spec, pos, yaw);
    const model = new CarModel(spec, { paint, plate: this.seedText });
    this.scene.add(model.root);
    this.player = { vehicle, model, prevPos: vehicle.pos.clone(), prevQuat: vehicle.quat.clone() };
    vehicle.onShift = (gear, up) => bus.emit('shift', { gear, up });
    vehicle.onBoost = (on) => bus.emit(on ? 'boostStart' : 'boostEnd', {});
  }

  /** Put the car back on the nearest road. */
  resetToRoad(keepSpeed = false) {
    const v = this.player.vehicle;
    const near = this.chunks.gen.nearestRoad(v.pos.x, v.pos.z, 400);
    if (!near) {
      v.teleport(v.pos.clone().add(new THREE.Vector3(0, 3, 0)), Math.atan2(v.fwd.x, v.fwd.z));
      return;
    }
    const e = near.edge;
    const q = Math.min(e.n - 2, near.idx);
    let yaw = Math.atan2(e.tx[q], e.tz[q]);
    // keep travelling direction
    if (v.fwd.x * e.tx[q] + v.fwd.z * e.tz[q] < 0) yaw += Math.PI;
    const lat = clamp(near.lateral, -e.halfW * 0.6, e.halfW * 0.6);
    const pos = new THREE.Vector3(e.x[q] - e.tz[q] * lat, e.h[q] + 1.0, e.z[q] + e.tx[q] * lat);
    v.teleport(pos, yaw, keepSpeed ? Math.min(25, v.speedAbs) : 0);
    this.player.prevPos.copy(v.pos);
    this.player.prevQuat.copy(v.quat);
    this.rig.snap(v);
    bus.emit('reset', {});
  }

  slowMo(scale: number, seconds: number) {
    this.targetTimeScale = scale;
    this.timeScale = scale;
    this.slowMoTimer = seconds;
  }

  start() {
    this.last = performance.now();
    const loop = () => {
      requestAnimationFrame(loop);
      this.frame();
    };
    requestAnimationFrame(loop);
  }

  frame() {
    const now = performance.now();
    const realDt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.fpsAcc += realDt;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.stats.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }

    // time scale (slow-mo) recovers in real time
    if (this.slowMoTimer > 0) {
      this.slowMoTimer -= realDt;
      if (this.slowMoTimer <= 0) this.targetTimeScale = 1;
    }
    this.timeScale = damp(this.timeScale, this.targetTimeScale, 5, realDt);
    const dt = this.paused ? 0 : realDt * this.timeScale;

    const v = this.player.vehicle;
    this.controls = this.input.poll(realDt, v.kmh);
    const tp = performance.now();
    // fixed step physics
    const fdt = this.physics.fixedDt;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= fdt && steps < 8) {
      this.player.prevPos.copy(v.pos);
      this.player.prevQuat.copy(v.quat);
      this.fixedStep(fdt);
      this.acc -= fdt;
      steps++;
    }
    if (steps === 8) this.acc = 0;
    this.stats.physMs = performance.now() - tp;
    v.syncState();
    const alpha = this.acc / fdt;

    // render pose interpolation
    const m = this.player.model;
    m.root.position.lerpVectors(this.player.prevPos, v.pos, alpha);
    m.root.quaternion.slerpQuaternions(this.player.prevQuat, v.quat, alpha);
    this.updateWheels(realDt);

    // world streaming
    this.chunks.update(v.pos.x, v.pos.z, v.vel.x, v.vel.z);
    this.simTime += dt;
    worldUniforms.uTime.value = this.simTime;
    this.updateBiome(realDt);
    this.sky.update(dt, v.pos);
    this.chunks.props.setNight(this.sky.state.night);
    m.setHeadlights(this.sky.state.night);

    for (const s of this.systems) s.update(dt, realDt);

    const ground = this.chunks.heightAt(this.rig.camera.position.x, this.rig.camera.position.z);
    this.rig.lookBack = !!this.controls.lookBack;
    this.rig.update(dt, realDt, v, v.boosting, ground);
    this.hud.update(realDt);

    const tr = performance.now();
    if (this.render) this.render();
    else this.renderer.render(this.scene, this.rig.camera);
    this.stats.renderMs = performance.now() - tr;
    this.stats.frameMs = performance.now() - now;
  }

  /** Deterministic headless simulation for tests/tuning. ctl(t) returns the controls at sim time t. */
  simulate(seconds: number, ctl: (t: number, v: Vehicle) => Partial<Controls>, sample?: (t: number, v: Vehicle) => void, every = 0.25) {
    const fdt = this.physics.fixedDt;
    const v = this.player.vehicle;
    let nextSample = 0;
    const n = Math.round(seconds / fdt);
    for (let i = 0; i < n; i++) {
      const t = i * fdt;
      const c = ctl(t, v);
      this.controls = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, lookBack: false, reset: false, camera: false, pause: false, photo: false, horn: false, ...c };
      if (i % 30 === 0 && !this.chunks.ready(v.pos.x, v.pos.z)) this.chunks.ensureSync(v.pos.x, v.pos.z);
      this.player.prevPos.copy(v.pos);
      this.player.prevQuat.copy(v.quat);
      this.fixedStep(fdt);
      v.syncState();
      if (sample && t >= nextSample) {
        sample(t, v);
        nextSample += every;
      }
    }
  }

  fixedStep(dt: number) {
    const v = this.player.vehicle;
    const ctl = this.controls!;
    v.step(dt, ctl, { weatherGrip: this.weatherGrip, iceRoads: this.iceRoads });
    for (const s of this.fixedSystems) s.fixedUpdate(dt);
    this.physics.world.step(this.physics.events);
  }

  private updateWheels(dt: number) {
    const v = this.player.vehicle;
    const m = this.player.model;
    const spec = v.spec;
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      const g = m.wheels[i];
      const springLen = spec.restLen - w.comp;
      g.position.set(w.local.x, w.local.y - springLen, w.local.z);
      g.rotation.set(0, w.steer, 0);
      (g.children[0] as THREE.Object3D).rotation.x = w.angle;
    }
  }

  private updateBiome(dt: number) {
    const v = this.player.vehicle;
    const gen = this.chunks.gen;
    const cellId = gen.biomeWeights(v.pos.x, v.pos.z, this.biomeWeights);
    this.sky.cityAmount = damp(this.sky.cityAmount, this.biomeWeights[2] > 0.5 ? 1 : this.biomeWeights[2] * 1.4, 1.2, dt);
    let best = 0;
    for (let b = 1; b < 4; b++) if (this.biomeWeights[b] > this.biomeWeights[best]) best = b;
    if (cellId !== this.currentBiome && this.biomeWeights[best] > 0.75) {
      const first = this.currentBiome === -1;
      this.currentBiome = cellId;
      const name = regionName(this.seed, cellId, best);
      bus.emit('biome', { name, biome: best });
      if (!first) bus.emit('toast', { text: name, sub: BIOME_NAMES[best].toUpperCase(), big: true });
    }
  }
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  const t = s.trim().toUpperCase();
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const SYL = ['ka', 'ro', 'mi', 'zan', 'tor', 'vel', 'qua', 'nix', 'sol', 'ar', 'en', 'dra', 'lo', 'vey', 'shi', 'mon', 'tek', 'bel', 'ost', 'rin', 'ya', 'gor'];
const SUFFIX = [
  ['Canyon', 'Mesa', 'Flats', 'Gulch', 'Badlands', 'Wash'],
  ['Pass', 'Peaks', 'Ridge', 'Pines', 'Summit', 'Hollow'],
  ['City', 'Sprawl', 'District', 'Heights', 'Downtown', 'Grid'],
  ['Bay', 'Cliffs', 'Point', 'Coast', 'Shores', 'Head'],
];

export function regionName(seed: number, cellId: number, biome: number): string {
  let h = (seed ^ Math.imul(cellId, 2654435761)) >>> 0;
  const r = () => {
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  };
  const n = 2 + Math.floor(r() * 2);
  let s = '';
  for (let i = 0; i < n; i++) s += SYL[Math.floor(r() * SYL.length)];
  s = s.charAt(0).toUpperCase() + s.slice(1);
  const suf = SUFFIX[biome][Math.floor(r() * 6)];
  if (biome === 2 && r() < 0.4) return `Neo ${s}`;
  return `${s} ${suf}`;
}

