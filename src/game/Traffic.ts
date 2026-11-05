// AI traffic: kinematic cars following the road graph; become dynamic wrecks when smashed.
import * as THREE from 'three';
import type { Game } from '../core/Game';
import { RAPIER, G_TRAFFIC, G_CAR, G_DEBRIS, G_WORLD, groups } from '../core/Physics';
import { RoadType, type RoadEdge } from '../world/types';
import { trafficGeometry } from '../vehicle/CarModel';
import { worldUniforms } from '../world/Materials';
import { bus } from '../core/events';
import { audio } from '../audio/AudioEngine';
import type { Impacts } from './Impacts';
import type { Particles } from '../fx/Particles';

type Kind = 'sedan' | 'truck' | 'bus' | 'hatch';
const KIND_DIMS: Record<Kind, [number, number, number, number]> = {
  // half x, half y, half z, centre y
  sedan: [0.9, 0.6, 2.2, 0.75],
  hatch: [0.9, 0.6, 1.9, 0.75],
  truck: [1.2, 1.6, 4.4, 1.7],
  bus: [1.25, 1.4, 5.0, 1.75],
};
const KIND_MASS: Record<Kind, number> = { sedan: 1300, hatch: 1000, truck: 9000, bus: 11000 };
const PAINTS = [0xc8c8c8, 0x1d3f8a, 0x8a1d1d, 0x222222, 0xe8e8e8, 0x2d6b3a, 0xd6a21e, 0x6a3fa0, 0x3fa0a0, 0xb05a2a];

export interface TrafficCar {
  id: number;
  kind: Kind;
  mesh: THREE.Mesh;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  edge: RoadEdge;
  s: number;
  dir: 1 | -1;
  lane: number; // lateral offset target
  laneCur: number;
  speed: number;
  target: number;
  wrecked: boolean;
  wreckT: number;
  parked: boolean;
  weaver: boolean;
  prevRelZ: number;
  nearMissCd: number;
  honkCd: number;
  hitCd: number;
  police?: boolean;
  pos: THREE.Vector3;
  yaw: number;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

function trafficMaterial(paint: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.4 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uPaint = { value: new THREE.Color(paint) };
    shader.uniforms.uNight = worldUniforms.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float region;\nvarying float vRegion;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRegion = region;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uPaint;\nuniform float uNight;\nvarying float vRegion;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 em = vec3(0.0);
        if (vRegion < 0.5) diffuseColor.rgb = uPaint;
        else if (vRegion < 1.5) diffuseColor.rgb = vec3(0.04,0.05,0.07);
        else if (vRegion < 2.5) diffuseColor.rgb = vec3(0.08);
        else if (vRegion < 3.5) { diffuseColor.rgb = vec3(1.0); em = vec3(1.0,0.95,0.8) * (0.3 + uNight*4.0); }
        else { diffuseColor.rgb = vec3(0.6,0.0,0.0); em = vec3(1.0,0.05,0.02) * (0.4 + uNight*2.5); }`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += em;');
  };
  m.customProgramCacheKey = () => 'traffic';
  return m;
}

export class Traffic {
  cars: TrafficCar[] = [];
  private geos: Record<Kind, THREE.BufferGeometry>;
  private mats: THREE.MeshStandardMaterial[];
  private nextId = 1;
  density = 1;
  maxCars = 34;
  private spawnTimer = 0;
  private rng = Math.random;
  private jamsSpawned = new Set<string>();
  enabled = true;

  constructor(
    private game: Game,
    private impacts: Impacts,
    private particles: Particles,
  ) {
    this.geos = { sedan: trafficGeometry('sedan'), hatch: trafficGeometry('hatch'), truck: trafficGeometry('truck'), bus: trafficGeometry('bus') };
    this.mats = PAINTS.map(trafficMaterial);
    impacts.addPairHandler((carH, other) => this.onCarHit(other));
  }

  private posOnEdge(e: RoadEdge, s: number, lat: number, out: THREE.Vector3): number {
    const ds = e.len / (e.n - 1);
    const f = Math.max(0, Math.min(e.n - 1.001, s / ds));
    const q = Math.floor(f);
    const t = f - q;
    const tx = e.tx[q] + (e.tx[q + 1] - e.tx[q]) * t;
    const tz = e.tz[q] + (e.tz[q + 1] - e.tz[q]) * t;
    const x = e.x[q] + (e.x[q + 1] - e.x[q]) * t;
    const z = e.z[q] + (e.z[q + 1] - e.z[q]) * t;
    const h = e.h[q] + (e.h[q + 1] - e.h[q]) * t;
    const bank = e.bank[q] + (e.bank[q + 1] - e.bank[q]) * t;
    out.set(x - tz * lat, h + lat * Math.tan(bank) + 0.02, z + tx * lat);
    return Math.atan2(tx, tz);
  }

  spawn(e: RoadEdge, s: number, dir: 1 | -1, opts: { parked?: boolean; kind?: Kind; police?: boolean; lane?: number } = {}): TrafficCar | null {
    if (this.cars.length >= this.maxCars + 12) return null;
    const r = this.rng();
    const kind: Kind = opts.kind ?? (e.type === RoadType.Highway && r < 0.18 ? 'truck' : e.type === RoadType.Avenue && r < 0.12 ? 'bus' : r < 0.55 ? 'sedan' : 'hatch');
    const lanes = e.halfW > 6 ? 2 : 1;
    const laneIdx = Math.floor(this.rng() * lanes);
    const laneW = e.halfW / lanes;
    const lane = opts.lane ?? dir * (laneW * (laneIdx + 0.5));
    const [hx, hy, hz, cy] = KIND_DIMS[kind];
    const pos = new THREE.Vector3();
    const yawRoad = this.posOnEdge(e, s, lane, pos);
    const yaw = dir > 0 ? yawRoad : yawRoad + Math.PI;
    const w = this.game.physics.world;
    const body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z));
    const col = w.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy * 0.85, hz)
        .setTranslation(0, cy, 0)
        .setMass(KIND_MASS[kind])
        .setFriction(0.5)
        .setCollisionGroups(groups(G_TRAFFIC, G_CAR | G_DEBRIS | G_TRAFFIC))
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body,
    );
    const mesh = new THREE.Mesh(this.geos[kind], this.mats[Math.floor(this.rng() * this.mats.length)]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.game.scene.add(mesh);
    const base = e.type === RoadType.Highway ? 26 : e.type === RoadType.Avenue ? 17 : e.type === RoadType.Mountain ? 16 : 12;
    const target = opts.parked ? 0 : base * (0.75 + this.rng() * 0.4) * (kind === 'truck' || kind === 'bus' ? 0.82 : 1);
    const tc: TrafficCar = {
      id: this.nextId++, kind, mesh, body, collider: col, edge: e, s, dir, lane, laneCur: lane,
      speed: target, target, wrecked: false, wreckT: 0, parked: !!opts.parked, weaver: !opts.parked && this.rng() < 0.08,
      prevRelZ: 0, nearMissCd: 0, honkCd: 0, hitCd: 0, police: opts.police, pos, yaw,
    };
    this.game.physics.tag(col, { kind: 'traffic', ref: tc });
    this.cars.push(tc);
    this.place(tc, 0);
    return tc;
  }

  private place(c: TrafficCar, dt: number) {
    const yawRoad = this.posOnEdge(c.edge, c.s, c.laneCur, c.pos);
    c.yaw = c.dir > 0 ? yawRoad : yawRoad + Math.PI;
    _q.setFromAxisAngle(UP, c.yaw);
    if (dt > 0) c.body.setNextKinematicTranslation(c.pos);
    else c.body.setTranslation(c.pos, true);
    if (dt > 0) c.body.setNextKinematicRotation(_q);
    else c.body.setRotation(_q, true);
  }

  private onCarHit(other: number): boolean {
    const info = this.game.physics.info.get(other);
    if (!info || info.kind !== 'traffic') return false;
    const c = info.ref as TrafficCar;
    if (c.wrecked) return false; // plain physics
    this.wreck(c, true);
    return true;
  }

  wreck(c: TrafficCar, byPlayer: boolean) {
    const g = this.game;
    const v = g.player.vehicle;
    c.wrecked = true;
    c.wreckT = 0;
    const travel = new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw)).multiplyScalar(c.speed);
    c.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    c.collider.setCollisionGroups(groups(G_TRAFFIC, G_CAR | G_DEBRIS | G_TRAFFIC | G_WORLD));
    c.body.setLinvel(travel, true);
    if (byPlayer) {
      const rel = v.vel.clone().sub(travel);
      const mag = rel.length();
      const pm = v.spec.mass;
      const tm = KIND_MASS[c.kind];
      const share = pm / (pm + tm);
      // knock the traffic car flying, more for light cars
      const imp = rel.clone().multiplyScalar(share * 1.6 * tm);
      imp.y += tm * Math.min(8, mag * 0.25) * share;
      const hitPoint = c.pos.clone().add(new THREE.Vector3(0, KIND_DIMS[c.kind][3], 0));
      c.body.applyImpulseAtPoint(imp, v.pos.clone().lerp(hitPoint, 0.6).setY(hitPoint.y + 0.3), true);
      // player keeps momentum depending on mass ratio
      const keep = Math.max(0.25, 1 - (tm / (pm + tm)) * 1.2);
      v.body.setLinvel(v.vel.clone().multiplyScalar(keep), true);
      const p = v.pos.clone().lerp(hitPoint, 0.5);
      this.impacts.bigHit(p, mag * (1 - keep) + 4, true);
      if (mag > 8) bus.emit('trick', { name: c.police ? 'COP TAKEDOWN' : c.kind === 'bus' || c.kind === 'truck' ? 'BIG RIG TAKEDOWN' : 'TAKEDOWN', points: c.police ? 3000 : c.kind === 'bus' || c.kind === 'truck' ? 1500 : 800, color: '#ff4d2e' });
    }
  }

  removeCar(c: TrafficCar) {
    this.game.physics.removeBody(c.body);
    this.game.scene.remove(c.mesh);
    const i = this.cars.indexOf(c);
    if (i >= 0) this.cars.splice(i, 1);
  }

  clear() {
    while (this.cars.length) this.removeCar(this.cars[0]);
    this.jamsSpawned.clear();
  }

  /** Called before physics step: move kinematic cars. */
  fixedUpdate(dt: number) {
    const v = this.game.player.vehicle;
    for (const c of this.cars) {
      if (c.wrecked) continue;
      // car-following: look for cars ahead in the same lane & direction
      let gap = 1e9;
      for (const o of this.cars) {
        if (o === c || o.edge !== c.edge || o.dir !== c.dir) continue;
        if (Math.abs(o.laneCur - c.laneCur) > 2) continue;
        const d = (o.s - c.s) * c.dir;
        if (d > 0 && d < gap) gap = d;
      }
      // the player in front of us?
      _v.copy(v.pos).sub(c.pos);
      const fwdX = Math.sin(c.yaw), fwdZ = Math.cos(c.yaw);
      const along = _v.x * fwdX + _v.z * fwdZ;
      const side = Math.abs(_v.x * fwdZ - _v.z * fwdX);
      if (along > 0 && along < 30 && side < 2.2 && v.speedAbs < c.speed) gap = Math.min(gap, along);
      let want = c.target;
      if (c.parked) want = 0;
      else if (gap < 40) want = Math.min(want, Math.max(0, (gap - 9) * 0.8));
      c.speed += Math.max(-9 * dt, Math.min(4 * dt, want - c.speed));
      if (c.weaver && !c.parked) {
        const lanes = c.edge.halfW > 6 ? 2 : 1;
        const lw = c.edge.halfW / lanes;
        c.lane = c.dir * lw * (0.5 + (lanes - 1) * (0.5 + 0.5 * Math.sin(this.game.simTime * 0.7 + c.id)));
      }
      c.laneCur += Math.max(-1.5 * dt, Math.min(1.5 * dt, c.lane - c.laneCur));
      c.s += c.speed * c.dir * dt;
      if (c.s < 0 || c.s > c.edge.len) {
        if (!this.nextEdge(c)) {
          c.dir = -c.dir as 1 | -1;
          c.s = Math.max(0, Math.min(c.edge.len, c.s));
          c.lane = -c.lane;
          c.laneCur = c.lane;
        }
      }
      this.place(c, dt);
    }
  }

  private nextEdge(c: TrafficCar): boolean {
    const gen = this.game.chunks.gen;
    const e = c.edge;
    const ni = c.dir > 0 ? e.bi : e.ai;
    const nj = c.dir > 0 ? e.bj : e.aj;
    const opts = gen.nodeEdges(ni, nj).filter((x) => x !== e && !x.noTraffic);
    if (!opts.length) return false;
    const ne = opts[Math.floor(this.rng() * opts.length)];
    const fromA = ne.ai === ni && ne.aj === nj;
    c.edge = ne;
    c.dir = fromA ? 1 : -1;
    c.s = fromA ? 0.5 : ne.len - 0.5;
    const lanes = ne.halfW > 6 ? 2 : 1;
    const lw = ne.halfW / lanes;
    c.lane = c.dir * lw * (Math.floor(this.rng() * lanes) + 0.5);
    c.laneCur = c.lane;
    return true;
  }

  update(dt: number) {
    const g = this.game;
    const v = g.player.vehicle;
    if (!this.enabled) return;
    // spawn / despawn
    this.spawnTimer -= dt;
    const want = Math.round(this.maxCars * this.density);
    const active = this.cars.filter((c) => !c.parked && !c.wrecked).length;
    if (this.spawnTimer <= 0 && active < want) {
      this.spawnTimer = 0.15;
      this.trySpawn();
    }
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      if (c.wrecked) {
        c.wreckT += dt;
        const t = c.body.translation();
        const r = c.body.rotation();
        c.pos.set(t.x, t.y, t.z);
        c.mesh.position.copy(c.pos);
        c.mesh.quaternion.set(r.x, r.y, r.z, r.w);
        if (c.wreckT < 3 && Math.random() < 0.3) this.particles.smoke(c.pos, new THREE.Vector3(), 0.6, [0.3, 0.3, 0.3]);
        if (!g.chunks.ready(t.x, t.z)) c.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      } else {
        c.mesh.position.copy(c.pos);
        c.mesh.quaternion.setFromAxisAngle(UP, c.yaw);
        c.mesh.rotateZ(-(c.laneCur - c.lane) * 0.05);
      }
      const d = Math.hypot(c.pos.x - v.pos.x, c.pos.z - v.pos.z);
      if (d > 480 || (c.wrecked && c.wreckT > 25 && d > 60) || c.pos.y < -50) {
        this.removeCar(c);
        continue;
      }
      // near misses + honks
      if (!c.wrecked) this.checkNearMiss(c, dt);
    }
    // traffic jams from set pieces
    for (const ch of g.chunks.chunks.values()) {
      if (ch.lod > 1) continue;
      for (const sp of ch.data.setPieces) {
        if (sp.kind !== 'jam') continue;
        const k = sp.edgeKey + ':' + sp.idx;
        if (this.jamsSpawned.has(k)) continue;
        const d = Math.hypot(sp.x - v.pos.x, sp.z - v.pos.z);
        if (d > 300 || d < 80) continue;
        this.jamsSpawned.add(k);
        const [dir, i, j] = sp.edgeKey.split(':').map(Number);
        const e = g.chunks.gen.edge(i, j, dir);
        if (!e) continue;
        const ds = e.len / (e.n - 1);
        for (let r = 0; r < 7; r++)
          for (const dd of [1, -1] as const) {
            for (let ln = 0; ln < 2; ln++) {
              const s = sp.idx * ds + (r * 7 + this.rng() * 2) * dd;
              if (s < 5 || s > e.len - 5) continue;
              const lw = e.halfW / 2;
              this.spawn(e, s, dd, { parked: true, lane: dd * lw * (ln + 0.5), kind: this.rng() < 0.15 ? 'truck' : 'sedan' });
            }
          }
      }
    }
  }

  private trySpawn() {
    const g = this.game;
    const v = g.player.vehicle;
    const R = 340;
    const edges = g.chunks.gen.edgesNear(v.pos.x - R, v.pos.z - R, v.pos.x + R, v.pos.z + R).filter((e) => !e.noTraffic);
    if (!edges.length) return;
    for (let attempt = 0; attempt < 6; attempt++) {
      const e = edges[Math.floor(this.rng() * edges.length)];
      const s = this.rng() * e.len;
      const p = new THREE.Vector3();
      this.posOnEdge(e, s, 0, p);
      const d = Math.hypot(p.x - v.pos.x, p.z - v.pos.z);
      if (d < 110 || d > R) continue;
      if (!g.chunks.chunkAt(p.x, p.z)) continue;
      // avoid spawning on top of another car
      if (this.cars.some((c) => c.edge === e && Math.abs(c.s - s) < 20)) continue;
      this.spawn(e, s, this.rng() < 0.5 ? 1 : -1);
      return;
    }
  }

  private checkNearMiss(c: TrafficCar, dt: number) {
    const v = this.game.player.vehicle;
    c.nearMissCd -= dt;
    c.honkCd -= dt;
    c.hitCd -= dt;
    _v.copy(c.pos).sub(v.pos);
    const relZ = _v.dot(v.fwd);
    const relX = Math.abs(_v.dot(v.right));
    const dy = Math.abs(_v.y);
    const [hx, , hz] = KIND_DIMS[c.kind];
    const myHalf = v.spec.half[0];
    const gap = relX - hx - myHalf;
    const relSpeed = Math.abs(v.vel.dot(v.fwd) - c.speed * (Math.sin(c.yaw) * v.fwd.x + Math.cos(c.yaw) * v.fwd.z));
    if (c.prevRelZ > 0 && relZ <= 0 && gap < 1.5 && gap > -0.1 && dy < 3 && relSpeed > 10 && v.speedAbs > 12 && c.nearMissCd <= 0 && c.hitCd <= 0) {
      c.nearMissCd = 3;
      bus.emit('nearMiss', { dist: Math.max(0.05, gap), speed: relSpeed });
      audio.whoosh(Math.min(1, relSpeed / 40));
      if (c.honkCd <= 0 && Math.random() < 0.6) {
        c.honkCd = 5;
        setTimeout(() => audio.trafficHonk(Math.max(5, v.pos.distanceTo(c.pos))), 120);
      }
    }
    if (Math.abs(relZ) > hz + 30) c.prevRelZ = relZ;
    else c.prevRelZ = relZ;
  }
}
