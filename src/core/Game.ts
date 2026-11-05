// Orchestrates all systems: fixed-step physics, streaming world, rendering, gameplay.
import * as THREE from 'three';
import { Physics, RAPIER, groups, G_CAR, G_WORLD } from './Physics';
import { Input, type Controls } from './Input';
import { bus } from './events';
import { clamp, damp } from './rng';
import { ChunkManager } from '../world/ChunkManager';
import { Sky } from '../world/Sky';
import { Weather } from '../world/Weather';
import { SetPieces } from '../world/SetPieces';
import { Water } from '../world/Water';
import { worldUniforms } from '../world/Materials';
import { BIOME_NAMES } from '../world/types';
import type { Tunables } from '../world/WorldGen';
import { Vehicle } from '../vehicle/Vehicle';
import { CarModel } from '../vehicle/CarModel';
import { carById, applyUpgrades, type CarSpec } from '../vehicle/VehicleDefs';
import { CameraRig } from '../camera/CameraRig';
import { HUD } from '../ui/HUD';
import { PostFX, EnvBaker } from '../fx/PostFX';
import { Particles } from '../fx/Particles';
import { SkidMarks } from '../fx/SkidMarks';
import { VehicleFX } from '../fx/VehicleFX';
import { Headlights } from '../fx/Headlights';
import { Birds } from '../fx/Birds';
import { audio } from '../audio/AudioEngine';
import { radio } from '../audio/Radio';
import { Impacts } from '../game/Impacts';
import { Traffic } from '../game/Traffic';
import { Score } from '../game/Score';
import { Events } from '../game/Events';
import { Police } from '../game/Police';
import { Ghost } from '../game/Ghost';
import { PhotoMode } from '../game/PhotoMode';
import { Save } from '../game/Save';
import { paintColor } from '../ui/Menu';

export interface PlayerCar {
  vehicle: Vehicle;
  model: CarModel;
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  paint: number;
}

export class Game {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  physics = new Physics();
  input = new Input();
  chunks!: ChunkManager;
  sky!: Sky;
  weather!: Weather;
  water!: Water;
  setPieces!: SetPieces;
  rig: CameraRig;
  hud!: HUD;
  postfx!: PostFX;
  env!: EnvBaker;
  particles!: Particles;
  skids!: SkidMarks;
  vfx!: VehicleFX;
  headlights!: Headlights;
  birds!: Birds;
  impacts!: Impacts;
  traffic!: Traffic;
  score!: Score;
  events!: Events;
  police!: Police;
  ghost!: Ghost;
  photo!: PhotoMode;
  save: Save;
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
  prof: Record<string, number> = {};
  profMax: Record<string, number> = {};
  stats = { fps: 60, frameMs: 0, physMs: 0, renderMs: 0 };
  private fpsAcc = 0;
  private fpsFrames = 0;
  weatherGrip = 1;
  weatherWet = 0;
  iceRoads = 0;
  sirenLevel = 0;
  sirenDist = 1e9;
  quality = 1;
  private slowMoTimer = 0;
  currentBiome = -1;
  biomeWeights = new Float32Array([1, 0, 0, 0]);
  private wreckTimer = 0;
  private waterTimer = 0;
  onPause: (() => void) | null = null;
  started = false;

  constructor(public container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);
    this.rig = new CameraRig(window.innerWidth / window.innerHeight);
    this.save = new Save();
    window.addEventListener('resize', () => this.onResize());
  }

  onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.postfx?.setSize(w, h);
    this.rig.camera.aspect = w / h;
    this.rig.camera.updateProjectionMatrix();
    this.particles?.setScale(h * this.renderer.getPixelRatio(), this.rig.camera.fov);
  }

  async init(seedText: string, carId: string, paint: number) {
    await this.physics.init();
    this.seedText = seedText;
    this.seed = hashSeed(seedText);
    radio.configure(this.seed);
    radio.enabled = this.save.data.settings.music;
    this.chunks = new ChunkManager(this.seed, this.physics, this.scene);
    this.setPieces = new SetPieces(this.physics, this.scene);
    this.chunks.setPieces = this.setPieces;
    this.sky = new Sky(this.scene);
    this.water = new Water(this.scene);
    this.postfx = new PostFX(this.renderer, this.scene, this.rig.camera);
    this.env = new EnvBaker(this.renderer, this.scene, this.sky.mesh);
    this.particles = new Particles(this.scene);
    this.particles.heightAt = (x, z) => this.chunks.heightAt(x, z);
    this.rig.groundAt = (x, z) => Math.max(this.chunks.heightAt(x, z), this.water.level);
    const camRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    const camFilter = groups(G_CAR, G_WORLD);
    this.rig.occlusion = (from, to) => {
      const d = to.clone().sub(from);
      const len = d.length();
      if (len < 0.01) return null;
      d.divideScalar(len);
      camRay.origin = { x: from.x, y: from.y, z: from.z };
      camRay.dir = { x: d.x, y: d.y, z: d.z };
      const hit = this.physics.world.castRay(camRay, len, true, undefined, camFilter, undefined, this.player.vehicle.body);
      return hit ? hit.timeOfImpact : null;
    };
    this.skids = new SkidMarks(this.scene);
    this.hud = new HUD(this);
    this.vfx = new VehicleFX(this, this.particles, this.skids);
    this.headlights = new Headlights(this.scene);
    this.birds = new Birds(this);
    this.impacts = new Impacts(this, this.particles);
    this.traffic = new Traffic(this, this.impacts, this.particles);
    this.score = new Score(this);
    this.events = new Events(this);
    this.score.onTrick = (name, pts, color) => {
      this.hud.popTrick(`${name} +${pts.toLocaleString()}`, color);
      this.events.onTrick(name, pts);
    };
    this.score.onBank = (pts) => this.save.addCredits(pts);
    this.police = new Police(this, this.particles);
    this.weather = new Weather(this);
    this.photo = new PhotoMode(this);
    this.setQuality(this.save.data.settings.quality);
    this.impacts.crashCamEnabled = this.save.data.settings.crashCam;
    audio.setVolume(this.save.data.settings.volume);

    const spawn = this.findSpawn();
    this.chunks.warmup(spawn.pos.x, spawn.pos.z);
    this.spawnPlayer(carById(carId), spawn.pos, spawn.yaw, paint);
    this.ghost = new Ghost(this);
    this.rig.snap(this.player.vehicle);
    this.onResize();
    this.env.update(0, true);
    this.chunks.update(spawn.pos.x, spawn.pos.z, 0, 0, true);

    bus.on('wrecked', () => {
      if (this.wreckTimer > 0) return;
      this.wreckTimer = 2.6;
      this.hud.center('WRECKED', 2.2, 'danger');
      this.slowMo(0.3, 1.5);
      this.impacts.explode(this.player.vehicle.pos.clone(), 0.5);
    });
    bus.on('crash', (e) => {
      if (e.impulse > 10) this.input.rumble(1, 1, 300);
    });
  }

  setQuality(q: number) {
    this.quality = q;
    const dpr = window.devicePixelRatio || 1;
    this.basePixelRatio = q === 0 ? Math.min(dpr, 0.75) : q === 1 ? Math.min(dpr, 1) : Math.min(dpr, 1.5);
    this.renderer.setPixelRatio(this.basePixelRatio * this.resScale);
    this.renderer.shadowMap.enabled = q > 0;
    this.sky.sun.castShadow = q > 0;
    this.sky.sun.shadow.mapSize.set(q === 2 ? 2048 : 1024, q === 2 ? 2048 : 1024);
    this.sky.sun.shadow.map?.dispose();
    this.sky.sun.shadow.map = null;
    this.chunks.viewRadius = q === 0 ? 4 : q === 1 ? 5 : 6;
    this.chunks.lod1Radius = q === 0 ? 2 : q === 1 ? 3 : 4;
    this.particles.quality = q === 0 ? 0.4 : q === 1 ? 0.75 : 1;
    this.traffic.maxCars = q === 0 ? 20 : q === 1 ? 28 : 34;
    this.onResize();
  }

  regenerateWorld(t: Tunables) {
    const v = this.player.vehicle;
    this.traffic.clear();
    this.police.clear();
    this.impacts.clear();
    this.chunks.setTunables(t);
    this.chunks.reset();
    this.chunks.ensureSync(v.pos.x, v.pos.z);
    this.resetToRoad();
  }

  findSpawn(): { pos: THREE.Vector3; yaw: number } {
    const gen = this.chunks.gen;
    for (let r = 0; r < 6; r++)
      for (let j = -r; j <= r; j++)
        for (let i = -r; i <= r; i++) {
          for (const d of [0, 1]) {
            const e = gen.edge(i, j, d);
            if (!e || e.n < 40 || e.noTraffic) continue;
            const q = 18;
            if (e.flags[q] & 3) continue;
            const yaw = Math.atan2(e.tx[q], e.tz[q]);
            const lat = e.halfW * 0.4; // right-hand lane
            return { pos: new THREE.Vector3(e.x[q] - e.tz[q] * lat, e.h[q] + 0.9, e.z[q] + e.tx[q] * lat), yaw };
          }
        }
    return { pos: new THREE.Vector3(0, gen.baseHeight(0, 0) + 2, 0), yaw: 0 };
  }

  spawnPlayer(base: CarSpec, pos: THREE.Vector3, yaw: number, paint = 0) {
    if (this.player) {
      this.player.vehicle.dispose();
      this.scene.remove(this.player.model.root);
      this.player.model.dispose();
    }
    const spec = applyUpgrades({ ...base }, this.save.upgrades(base.id));
    const vehicle = new Vehicle(this.physics, spec, pos, yaw);
    vehicle.tune.assistMul = this.save.data.settings.assists;
    const model = new CarModel(spec, { paint: paintColor(base, paint), plate: this.seedText });
    this.scene.add(model.root);
    this.player = { vehicle, model, prevPos: vehicle.pos.clone(), prevQuat: vehicle.quat.clone(), paint };
    vehicle.onShift = (gear, up) => bus.emit('shift', { gear, up });
    vehicle.onBoost = (on) => bus.emit(on ? 'boostStart' : 'boostEnd', {});
    audio.setCar(spec.cylinders, spec.enginePitch);
    this.headlights?.attach(model);
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
    let dir = 1;
    if (v.fwd.x * e.tx[q] + v.fwd.z * e.tz[q] < 0) {
      yaw += Math.PI;
      dir = -1;
    }
    const lat = e.halfW * 0.4 * dir;
    const pos = new THREE.Vector3(e.x[q] - e.tz[q] * lat, e.h[q] + 1.0, e.z[q] + e.tx[q] * lat);
    if (!this.chunks.ready(pos.x, pos.z)) this.chunks.ensureSync(pos.x, pos.z);
    v.teleport(pos, yaw, keepSpeed ? Math.min(25, v.speedAbs) : 0);
    v.health = 100;
    this.player.model.repair();
    this.player.prevPos.copy(v.pos);
    this.player.prevQuat.copy(v.quat);
    this.rig.crash = null;
    this.rig.snap(v);
    this.impacts.invulnerable = 1.5;
    bus.emit('reset', {});
  }

  slowMo(scale: number, seconds: number) {
    if (scale > this.targetTimeScale && this.slowMoTimer > 0) return; // keep the stronger slow-mo
    this.targetTimeScale = scale;
    this.timeScale = Math.min(this.timeScale, scale);
    this.slowMoTimer = seconds;
  }

  start() {
    this.started = true;
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
      this.adaptResolution();
    }
    if (this.slowMoTimer > 0) {
      this.slowMoTimer -= realDt;
      if (this.slowMoTimer <= 0) this.targetTimeScale = 1;
    }
    this.timeScale = damp(this.timeScale, this.targetTimeScale, 6, realDt);
    const dt = this.paused ? 0 : realDt * this.timeScale;

    const v = this.player.vehicle;
    this.controls = this.input.poll(realDt, v.kmh);
    const ctl = this.controls;
    if (ctl.pause && !this.photo.active) this.onPause?.();
    if (ctl.photo) this.photo.toggle();
    if (!this.paused) {
      if (ctl.camera) this.rig.cycle();
      if (ctl.reset) this.resetToRoad();
      if (ctl.horn && !this.hornHeld) audio.horn();
      if (this.input.consume('music')) {
        radio.setEnabled(!radio.enabled);
        this.save.data.settings.music = radio.enabled;
        this.save.write();
        bus.emit('toast', { text: radio.enabled ? '♪ SEED FM ON' : 'RADIO OFF', color: '#ff3df2' });
      }
      this.hornHeld = ctl.horn;
    }
    this.hud.minimap.markers.length = 0;

    const tp = performance.now();
    const fdt = this.physics.fixedDt;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= fdt && steps < 6) {
      this.player.prevPos.copy(v.pos);
      this.player.prevQuat.copy(v.quat);
      this.fixedStep(fdt);
      this.acc -= fdt;
      steps++;
    }
    if (steps === 6) this.acc = 0;
    this.stats.physMs = performance.now() - tp;
    v.syncState();
    const alpha = this.acc / fdt;

    const m = this.player.model;
    m.root.position.lerpVectors(this.player.prevPos, v.pos, alpha);
    m.root.quaternion.slerpQuaternions(this.player.prevQuat, v.quat, alpha);
    this.updateWheels();

    let tq = performance.now();
    const mark = (k: string) => {
      const n = performance.now();
      this.prof[k] = (this.prof[k] ?? 0) * 0.95 + (n - tq) * 0.05;
      this.profMax[k] = Math.max(this.profMax[k] ?? 0, n - tq);
      tq = n;
    };
    this.chunks.update(v.pos.x, v.pos.z, v.vel.x, v.vel.z);
    mark('chunks');
    this.simTime += dt;
    worldUniforms.uTime.value = this.simTime;
    this.updateBiome(realDt);
    if (!this.photo.active) this.sky.update(dt, v.pos);
    const night = this.sky.state.night;
    this.scene.environmentIntensity = 1 - night * 0.65;
    this.chunks.props.setNight(night);
    this.water.update(this.simTime, v.pos, this.sky.state.fogColor, this.sky.state.sunDir, night);
    mark('sky');
    if (dt > 0) {
      this.weather.update(dt);
      mark('weather');
      this.traffic.update(dt);
      mark('traffic');
      this.police.update(dt);
      this.score.update(dt);
      this.events.update(dt);
      this.ghost.update(dt);
      mark('gameplay');
      this.vfx.update(dt, realDt);
      mark('vfx');
      this.particles.update(dt);
      this.birds.update(dt);
      mark('particles');
      this.impacts.update(dt);
      this.checkHazards(dt);
    }
    this.headlights.update(night, this.weather.fog, this.player.model, v);
    radio.update(realDt, v.kmh, this.score.mult, this.police.active);
    this.env.update(realDt);
    mark('env');

    const camPos = this.rig.camera.position;
    const ground = this.chunks.heightAt(camPos.x, camPos.z);
    this.rig.lookBack = !!ctl.lookBack;
    if (this.photo.active) this.photo.update(realDt);
    else this.rig.update(dt, realDt, v, v.boosting, this.water.level + 0.3);
    void ground;
    mark('camera');
    this.hud.update(realDt);
    mark('hud');
    this.postfx.update(realDt, {
      speed: this.rig.speedFx * (this.photo.active ? 0 : 1),
      biome: this.biomeWeights,
      night,
      damage: clamp((60 - v.health) / 60, 0, 1),
      time: this.simTime,
      letterbox: this.rig.crash ? 0.09 : 0,
    });
    const tr = performance.now();
    this.renderer.info.reset();
    this.postfx.render(realDt);
    this.stats.renderMs = performance.now() - tr;
    this.stats.frameMs = performance.now() - now;
  }
  private hornHeld = false;
  /** Dynamic resolution: trade pixels for frame rate on weaker GPUs. */
  autoRes = true;
  resScale = 1;
  private lowFps = 0;
  private highFps = 0;
  private adaptResolution() {
    if (!this.autoRes || !this.started || document.hidden) return;
    const fps = this.stats.fps;
    if (fps < 52) {
      this.lowFps++;
      this.highFps = 0;
    } else if (fps > 59) {
      this.highFps++;
      this.lowFps = 0;
    } else {
      this.lowFps = this.highFps = 0;
    }
    let changed = false;
    if (this.lowFps >= 3 && this.resScale > 0.55) {
      this.resScale = Math.max(0.55, this.resScale - 0.1);
      this.lowFps = 0;
      changed = true;
    } else if (this.highFps >= 8 && this.resScale < 1) {
      this.resScale = Math.min(1, this.resScale + 0.05);
      this.highFps = 0;
      changed = true;
    }
    if (changed) {
      this.renderer.setPixelRatio(this.basePixelRatio * this.resScale);
      this.onResize();
    }
  }
  private basePixelRatio = 1;

  private checkHazards(dt: number) {
    const v = this.player.vehicle;
    if (this.wreckTimer > 0) {
      this.wreckTimer -= dt / Math.max(0.3, this.timeScale);
      if (this.wreckTimer <= 0) this.resetToRoad();
    }
    if (v.pos.y < this.water.level - 0.6) {
      if (this.waterTimer === 0) {
        this.particles.splash(v.pos.clone().setY(this.water.level), 60);
        audio.crash(0.5);
        this.hud.center('SPLASH', 1.2);
        this.score.lose();
      }
      this.waterTimer += dt;
      v.body.setLinearDamping(3);
      if (this.waterTimer > 1.6) {
        v.body.setLinearDamping(0.02);
        this.waterTimer = 0;
        this.resetToRoad();
      }
    } else if (this.waterTimer > 0) {
      this.waterTimer = 0;
      v.body.setLinearDamping(0.02);
    }
    if (v.pos.y < -80) this.resetToRoad();
  }

  fixedStep(dt: number) {
    const v = this.player.vehicle;
    v.step(dt, this.controls!, { weatherGrip: this.weatherGrip, iceRoads: this.iceRoads });
    this.traffic.fixedUpdate(dt);
    this.police.fixedUpdate(dt);
    this.impacts.preStep();
    this.physics.world.step(this.physics.events);
    this.impacts.postStep(dt);
  }

  /** Deterministic headless simulation for tests/tuning. */
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
      if (i % 12 === 0) {
        this.score.update(fdt * 12);
        this.chunks.update(v.pos.x, v.pos.z, v.vel.x, v.vel.z);
      }
      if (sample && t >= nextSample) {
        sample(t, v);
        nextSample += every;
      }
    }
  }

  private updateWheels() {
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

  private _w = new Float32Array(4);
  private updateBiome(dt: number) {
    const v = this.player.vehicle;
    const gen = this.chunks.gen;
    const w = this._w;
    const cellId = gen.biomeWeights(v.pos.x, v.pos.z, w);
    for (let b = 0; b < 4; b++) this.biomeWeights[b] = damp(this.biomeWeights[b], w[b], 1.5, dt);
    this.sky.cityAmount = damp(this.sky.cityAmount, w[2] > 0.5 ? 1 : w[2] * 1.4, 1.2, dt);
    let best = 0;
    for (let b = 1; b < 4; b++) if (w[b] > w[best]) best = b;
    if (cellId !== this.currentBiome && w[best] > 0.75) {
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
