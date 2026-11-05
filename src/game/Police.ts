// Police pursuit: physics cars with an AI driver, heat levels, ramming, busted / escape.
import * as THREE from 'three';
import type { Game } from '../core/Game';
import { Vehicle } from '../vehicle/Vehicle';
import { CarModel } from '../vehicle/CarModel';
import { CARS, type CarSpec } from '../vehicle/VehicleDefs';
import { G_TRAFFIC, G_WORLD, G_CAR, G_DEBRIS, groups } from '../core/Physics';
import type { Controls } from '../core/Input';
import { bus } from '../core/events';
import { audio } from '../audio/AudioEngine';
import type { Particles } from '../fx/Particles';

const COP_SPEC: CarSpec = {
  ...CARS[1],
  id: 'cop',
  name: 'INTERCEPTOR',
  mass: 1600,
  color: 0x111111,
  accent: 0xffffff,
  torque: 900,
  gripF: 1.15,
  gripR: 1.1,
  driftAssist: 0.3,
  boostForce: 0.5,
  toughness: 1.5,
};

interface Cop {
  v: Vehicle;
  m: CarModel;
  stuck: number;
  reverse: number;
  health: number;
  wrecked: boolean;
  wreckT: number;
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  parked: boolean;
  flip: number;
}

const _v = new THREE.Vector3();
const blank = (): Controls => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, lookBack: false, reset: false, camera: false, pause: false, photo: false, horn: false });

export class Police {
  cops: Cop[] = [];
  heat = 0;
  private heatTimer = 0;
  private bustTimer = 0;
  private escapeTimer = 0;
  private spawnTimer = 0;
  private trapTimer = 20;
  active = false;
  status = '';
  wanted = 0; // heat accumulated while not chasing (destruction)
  constructor(
    private game: Game,
    private particles: Particles,
  ) {
    bus.on('smash', () => (this.wanted += 1));
    bus.on('trick', (e) => {
      if (e.name.includes('TAKEDOWN')) this.wanted += 3;
    });
  }

  startChase(level = 1) {
    if (!this.active) {
      bus.emit('toast', { text: 'POLICE PURSUIT', sub: 'LOSE THEM', color: '#ff3b3b', big: true });
      this.game.hud.center('WANTED', 1.4, 'danger');
    }
    this.active = true;
    this.heat = Math.max(this.heat, level);
    this.heatTimer = 0;
    this.escapeTimer = 0;
    for (const c of this.cops) c.parked = false;
    bus.emit('police', { heat: this.heat });
  }

  endChase(escaped: boolean) {
    if (!this.active) return;
    this.active = false;
    const reward = this.heat * 2500;
    if (escaped) {
      bus.emit('trick', { name: `ESCAPED · HEAT ${this.heat}`, points: reward, color: '#7dff3d' });
      this.game.hud.center('ESCAPED', 1.5, 'good');
    }
    this.heat = 0;
    this.wanted = 0;
    for (const c of [...this.cops]) this.remove(c);
    bus.emit('police', { heat: 0 });
  }

  private spawnCop(behind: boolean, parkedAt?: { pos: THREE.Vector3; yaw: number }) {
    const g = this.game;
    const pv = g.player.vehicle;
    let pos: THREE.Vector3;
    let yaw: number;
    if (parkedAt) {
      pos = parkedAt.pos;
      yaw = parkedAt.yaw;
    } else {
      // find a road point behind / to the side of the player, out of view
      const back = _v.copy(pv.vel).setY(0);
      if (back.length() < 2) back.copy(pv.fwd);
      back.normalize().multiplyScalar(behind ? -110 : 140);
      const guess = pv.pos.clone().add(back);
      const near = g.chunks.gen.nearestRoad(guess.x, guess.z, 120);
      if (!near) return;
      const e = near.edge;
      const q = near.idx;
      pos = new THREE.Vector3(e.x[q], e.h[q] + 1.2, e.z[q]);
      yaw = Math.atan2(pv.pos.x - pos.x, pv.pos.z - pos.z);
      if (!g.chunks.ready(pos.x, pos.z)) g.chunks.ensureSync(pos.x, pos.z);
    }
    const spec = { ...COP_SPEC, torque: COP_SPEC.torque * (1 + this.heat * 0.08) };
    const v = new Vehicle(g.physics, spec, pos, yaw);
    v.collider.setCollisionGroups(groups(G_TRAFFIC, G_WORLD | G_CAR | G_DEBRIS | G_TRAFFIC));
    g.physics.tag(v.collider, { kind: 'police', ref: v });
    const m = new CarModel(spec, { paint: 0x111111, accent: 0xffffff, police: true, simple: true });
    // white doors
    g.scene.add(m.root);
    this.cops.push({ v, m, stuck: 0, reverse: 0, health: 100, wrecked: false, wreckT: 0, prevPos: v.pos.clone(), prevQuat: v.quat.clone(), parked: !!parkedAt, flip: 0 });
  }

  private remove(c: Cop) {
    c.v.dispose();
    this.game.scene.remove(c.m.root);
    c.m.dispose();
    const i = this.cops.indexOf(c);
    if (i >= 0) this.cops.splice(i, 1);
  }

  /** fixed-step: AI + physics for cops */
  fixedUpdate(dt: number) {
    const g = this.game;
    const pv = g.player.vehicle;
    for (const c of this.cops) {
      c.prevPos.copy(c.v.pos);
      c.prevQuat.copy(c.v.quat);
      const ready = g.chunks.ready(c.v.pos.x, c.v.pos.z);
      c.v.body.setEnabled(ready);
      if (!ready) continue;
      const ctl = blank();
      if (!c.wrecked && !c.parked) this.drive(c, ctl, pv, dt);
      else if (c.parked) ctl.brake = 1;
      c.v.step(dt, ctl, { weatherGrip: g.weatherGrip, iceRoads: g.iceRoads * 0.5 });
    }
  }

  private drive(c: Cop, ctl: Controls, pv: Vehicle, dt: number) {
    const v = c.v;
    const toP = _v.copy(pv.pos).addScaledVector(pv.vel, Math.min(1.2, v.pos.distanceTo(pv.pos) / 40)).sub(v.pos);
    const dist = toP.length();
    const fx = v.fwd.x, fz = v.fwd.z;
    const ang = Math.atan2(fx * toP.z - fz * toP.x, fx * toP.x + fz * toP.z);
    if (c.reverse > 0) {
      c.reverse -= dt;
      ctl.brake = 1;
      ctl.steer = ang > 0 ? 1 : -1;
      return;
    }
    ctl.steer = Math.max(-1, Math.min(1, ang * 2.2));
    const want = pv.speedAbs + 8 + this.heat * 3;
    ctl.throttle = v.speedAbs < want || dist > 30 ? 1 : 0.4;
    if (Math.abs(ang) > 1.6 && v.speedAbs > 15) {
      ctl.throttle = 0.3;
      ctl.handbrake = true;
    }
    ctl.boost = dist > 50 && Math.abs(ang) < 0.3 && this.heat >= 2;
    if (dist < 18 && Math.abs(ang) < 0.5) ctl.boost = this.heat >= 3; // ram!
    // stuck detection
    if (v.speedAbs < 2.5 && ctl.throttle > 0.5) c.stuck += dt;
    else c.stuck = Math.max(0, c.stuck - dt);
    if (c.stuck > 1.5) {
      c.stuck = 0;
      c.reverse = 1.1;
    }
  }

  update(dt: number) {
    const g = this.game;
    const pv = g.player.vehicle;
    if (dt <= 0) return;
    // render interpolation-free sync
    for (let i = this.cops.length - 1; i >= 0; i--) {
      const c = this.cops[i];
      c.v.syncState();
      c.m.root.position.copy(c.v.pos);
      c.m.root.quaternion.copy(c.v.quat);
      for (let k = 0; k < 4; k++) {
        const w = c.v.wheels[k];
        const wg = c.m.wheels[k];
        wg.position.set(w.local.x, w.local.y - (c.v.spec.restLen - w.comp), w.local.z);
        wg.rotation.set(0, w.steer, 0);
        wg.children[0].rotation.x = w.angle;
      }
      if (c.m.beacon) {
        const on = (this.active || c.parked) && !c.wrecked;
        const t = performance.now() / 120;
        (c.m.beacon.children[0] as THREE.Mesh).visible = on && Math.floor(t) % 2 === 0;
        (c.m.beacon.children[1] as THREE.Mesh).visible = on && Math.floor(t) % 2 === 1;
      }
      c.m.setHeadlights(g.sky.state.night);
      // damage: flipped or wrecked by impacts
      if (!c.wrecked) {
        if (c.v.up.y < 0.3) c.flip += dt;
        else c.flip = 0;
        const hitSpeed = c.v.prevVel.clone().sub(c.v.vel).length();
        if (hitSpeed > 9) {
          c.health -= hitSpeed * 4;
          this.particles.sparks(c.v.pos.clone().add(new THREE.Vector3(0, 1, 0)), new THREE.Vector3(0, 1, 0), 15, 8);
        }
        if (c.flip > 1.2 || c.health <= 0) {
          c.wrecked = true;
          c.wreckT = 0;
          bus.emit('trick', { name: 'COP TAKEDOWN', points: 3000 + this.heat * 1000, color: '#4d7dff' });
          audio.crash(1);
          g.impacts?.explode(c.v.pos.clone(), 0.6);
          g.rig.startCrashCam(c.v.pos.clone(), c.v.vel.clone(), 1.4);
          g.slowMo(0.25, 1);
          if (this.active) {
            this.heat = Math.min(5, this.heat + 1);
            bus.emit('police', { heat: this.heat });
          }
        }
      } else {
        c.wreckT += dt;
        if (Math.random() < 0.4) this.particles.smoke(c.v.pos, new THREE.Vector3(), 0.8, [0.2, 0.2, 0.2]);
        if (c.wreckT < 4 && Math.random() < 0.3) this.particles.fire(c.v.pos.clone().add(new THREE.Vector3(0, 1, 0)), new THREE.Vector3(), 1);
      }
      const d = c.v.pos.distanceTo(pv.pos);
      if ((c.wrecked && c.wreckT > 12) || d > 600 || c.v.pos.y < -40) this.remove(c);
      else if (c.parked && d > 400) this.remove(c);
    }

    // speed traps: a parked cop by the road every so often
    this.trapTimer -= dt;
    if (!this.active && this.trapTimer <= 0) {
      this.trapTimer = 45 + Math.random() * 40;
      const ahead = pv.pos.clone().addScaledVector(pv.vel.clone().setY(0).normalize(), 220);
      const near = g.chunks.gen.nearestRoad(ahead.x, ahead.z, 100);
      if (near && pv.speedAbs > 10) {
        const e = near.edge;
        const q = near.idx;
        const lat = e.halfW + 3;
        const pos = new THREE.Vector3(e.x[q] - e.tz[q] * lat, e.h[q] + 1, e.z[q] + e.tx[q] * lat);
        if (g.chunks.chunkAt(pos.x, pos.z)) {
          if (!g.chunks.ready(pos.x, pos.z)) g.chunks.ensureSync(pos.x, pos.z);
          this.spawnCop(false, { pos, yaw: Math.atan2(e.tx[q], e.tz[q]) + Math.PI / 2 });
        }
      }
    }
    for (const c of this.cops)
      if (c.parked && !this.active && c.v.pos.distanceTo(pv.pos) < 45 && pv.kmh > 150) {
        bus.emit('toast', { text: `SPEED TRAP · ${Math.round(pv.kmh)} KM/H`, color: '#ff3b3b' });
        this.startChase(1);
      }
    if (!this.active && this.wanted > 30) this.startChase(2);

    // siren audio from nearest active cop
    let nearest = 1e9;
    for (const c of this.cops) if (!c.wrecked && (this.active || c.parked)) nearest = Math.min(nearest, c.v.pos.distanceTo(pv.pos));
    g.sirenLevel = this.active ? 1 : nearest < 200 ? 0.5 : 0;
    g.sirenDist = nearest;

    if (!this.active) {
      g.hud.setHeat(0, '');
      return;
    }
    // heat escalation
    this.heatTimer += dt;
    if (this.heatTimer > 35 && this.heat < 5) {
      this.heatTimer = 0;
      this.heat++;
      bus.emit('toast', { text: `HEAT LEVEL ${this.heat}`, color: '#ff3b3b' });
      bus.emit('police', { heat: this.heat });
    }
    const want = Math.min(5, this.heat + 1);
    const alive = this.cops.filter((c) => !c.wrecked && !c.parked).length;
    this.spawnTimer -= dt;
    if (alive < want && this.spawnTimer <= 0) {
      this.spawnTimer = 4;
      this.spawnCop(Math.random() < 0.7);
    }
    // busted?
    let close = false;
    let anyNear = false;
    for (const c of this.cops) {
      if (c.wrecked) continue;
      const d = c.v.pos.distanceTo(pv.pos);
      if (d < 9) close = true;
      if (d < 260) anyNear = true;
    }
    if (close && pv.kmh < 20) this.bustTimer += dt;
    else this.bustTimer = Math.max(0, this.bustTimer - dt * 2);
    if (this.bustTimer > 2.6) {
      this.bustTimer = 0;
      g.hud.center('BUSTED', 2, 'danger');
      bus.emit('busted', {});
      audio.fail();
      g.score.lose();
      const fine = Math.min(g.save.data.credits, 1000 * this.heat);
      g.save.data.credits -= fine;
      g.save.write();
      bus.emit('toast', { text: `FINED ${fine} CR`, color: '#ff3b3b' });
      this.endChase(false);
      return;
    }
    if (!anyNear) this.escapeTimer += dt;
    else this.escapeTimer = 0;
    const status = this.bustTimer > 0.3 ? `BUSTING ${(2.6 - this.bustTimer).toFixed(1)}` : this.escapeTimer > 0 ? `EVADING ${(10 - this.escapeTimer).toFixed(0)}` : 'PURSUIT';
    g.hud.setHeat(this.heat, status);
    if (this.escapeTimer > 10) this.endChase(true);
    // minimap
    for (const c of this.cops) if (!c.wrecked) g.hud.minimap.markers.push({ x: c.v.pos.x, z: c.v.pos.z, color: 'police', size: 5 });
  }

  clear() {
    for (const c of [...this.cops]) this.remove(c);
    this.active = false;
    this.heat = 0;
  }
}
