// Post-physics collision handling: smashing props, damage, deformation, sparks, crash cam, debris.
import * as THREE from 'three';
import type { Game } from '../core/Game';
import { RAPIER, G_DEBRIS, G_WORLD, G_CAR, G_TRAFFIC, groups } from '../core/Physics';
import { bus } from '../core/events';
import { audio } from '../audio/AudioEngine';
import { Prop, PROP_STRIDE } from '../world/types';
import { PROP_PHYS } from '../world/PropGeometry';
import type { BreakableRef } from '../world/ChunkManager';
import type { Particles } from '../fx/Particles';
import type { DetachPart } from '../vehicle/CarModel';

interface Debris {
  body: RAPIER.RigidBody;
  obj: THREE.Object3D;
  life: number;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const G = new THREE.Vector3(0, -9.81 * 1.6, 0);

const SMASH_SOUND: Record<number, string> = {
  [Prop.Pine]: 'wood', [Prop.Palm]: 'wood', [Prop.Cactus]: 'wood', [Prop.Fence]: 'wood', [Prop.Crate]: 'wood',
  [Prop.Cone]: 'plastic', [Prop.Barrier]: 'plastic', [Prop.Lamp]: 'metal', [Prop.Barrel]: 'metal', [Prop.Pump]: 'metal',
};

export class Impacts {
  private vPre = new THREE.Vector3();
  private wPre = new THREE.Vector3();
  private debris: Debris[] = [];
  private pendingBreaks: BreakableRef[] = [];
  private pendingHandlers: ((h1: number, h2: number) => boolean)[] = [];
  private cooldown = 0;
  invulnerable = 0;
  maxDebris = 40;
  crashCamEnabled = true;
  lastCrashT = -10;

  constructor(
    private game: Game,
    private particles: Particles,
  ) {}

  /** Other systems (traffic) can claim collision pairs. Return true if handled. */
  addPairHandler(fn: (carHandle: number, other: number) => boolean) {
    this.pendingHandlers.push(fn);
  }

  preStep() {
    const v = this.game.player.vehicle;
    const lv = v.body.linvel();
    const av = v.body.angvel();
    this.vPre.set(lv.x, lv.y, lv.z);
    this.wPre.set(av.x, av.y, av.z);
  }

  postStep(dt: number) {
    const g = this.game;
    const v = g.player.vehicle;
    const ph = g.physics;
    const carH = v.collider.handle;
    let restored = false;
    this.cooldown -= dt;
    this.invulnerable -= dt;

    ph.events.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const other = h1 === carH ? h2 : h2 === carH ? h1 : -1;
      if (other < 0) return;
      const info = ph.info.get(other);
      if (!info) return;
      if (info.kind === 'breakable') {
        const ref = info.ref as BreakableRef;
        const phys = PROP_PHYS[ref.type];
        if (this.vPre.length() >= phys.breakSpeed && ref.collider) {
          this.pendingBreaks.push(ref);
        }
      } else {
        for (const fn of this.pendingHandlers) if (fn(carH, other)) {
          restored = true;
          break;
        }
      }
    });

    for (const ref of this.pendingBreaks) {
      if (!ref.collider) continue;
      this.breakProp(ref, this.vPre);
      restored = true;
    }
    this.pendingBreaks.length = 0;

    const lv = v.body.linvel();
    const after = _v.set(lv.x, lv.y, lv.z);
    if (restored) {
      // smashing through: keep most of the speed
      after.copy(this.vPre).multiplyScalar(0.94);
      v.body.setLinvel(after, true);
      v.body.setAngvel(this.wPre, true);
      return;
    }

    // impact detection from unexplained velocity change
    const dv = _v2.copy(after).sub(this.vPre).addScaledVector(G, -dt);
    // ignore the upward support from wheel-less ground contact being gentle
    const mag = dv.length();
    if (mag > 3.2 && this.cooldown <= 0) {
      this.onImpact(mag, dv, after);
      this.cooldown = 0.18;
    } else if (mag > 1.2) {
      // scraping
      const p = this.contactPoint();
      if (p && this.vPre.length() > 8) {
        this.particles.sparks(p, _v.copy(this.vPre).normalize().multiplyScalar(-0.3).add(new THREE.Vector3(0, 0.5, 0)), 2, 6);
      }
    }
  }

  private contactPoint(): THREE.Vector3 | null {
    const g = this.game;
    const v = g.player.vehicle;
    const w = g.physics.world;
    let best: THREE.Vector3 | null = null;
    let bestDepth = 1;
    w.contactPairsWith(v.collider, (other) => {
      w.contactPair(v.collider, other, (manifold, flipped) => {
        const n = manifold.numContacts();
        for (let i = 0; i < n; i++) {
          const d = manifold.contactDist(i);
          if (d < bestDepth) {
            bestDepth = d;
            const lp = flipped ? manifold.localContactPoint2(i) : manifold.localContactPoint1(i);
            if (lp) best = new THREE.Vector3(lp.x, lp.y + v.spec.colliderY, lp.z).applyQuaternion(v.quat).add(v.pos);
          }
        }
      });
    });
    return best;
  }

  private onImpact(mag: number, dv: THREE.Vector3, _after: THREE.Vector3) {
    const g = this.game;
    const v = g.player.vehicle;
    const p = this.contactPoint() ?? _v.copy(v.pos).addScaledVector(dv.clone().normalize(), -1.5);
    const strength = mag / v.spec.toughness;
    // deformation in local space: push inward, opposite to dv
    _q.copy(v.quat).invert();
    const local = p.clone().sub(v.pos).applyQuaternion(_q);
    const dir = dv.clone().normalize().applyQuaternion(_q);
    const detached = g.player.model.applyImpact(local, dir, strength);
    for (const part of detached) this.detachPart(part);
    if (this.invulnerable <= 0) v.health = Math.max(0, v.health - Math.max(0, strength - 2.5) * 2.2);
    // juice
    const k = Math.min(1, mag / 25);
    audio.crash(k * 1.2);
    g.rig.addTrauma(0.25 + k * 0.6);
    g.input.rumble(0.4 + k, 0.6, 250);
    this.particles.sparks(p, dv.clone().normalize(), Math.floor(10 + 40 * k), 10 + 10 * k);
    this.particles.debrisBurst(p, v.vel, Math.random() < 0.5 ? g.player.model.spec.color : 0x222222, Math.floor(2 + k * 8));
    g.postfx?.flashColor(0.25 * k, 0.05 * k, 0.02 * k);
    bus.emit('crash', { impulse: mag, x: p.x, y: p.y, z: p.z, withTraffic: false });
    if (mag > 17 && this.crashCamEnabled && g.simTime - this.lastCrashT > 4) {
      this.lastCrashT = g.simTime;
      g.rig.startCrashCam(p, this.vPre, 1.6);
      g.slowMo(0.22, 1.1);
    }
    if (v.health <= 0) bus.emit('wrecked', {});
  }

  /** Burnout-style takedown cam for hitting traffic etc. */
  bigHit(p: THREE.Vector3, mag: number, withTraffic: boolean) {
    const g = this.game;
    const k = Math.min(1, mag / 25);
    audio.crash(k * 1.3);
    g.rig.addTrauma(0.3 + k * 0.5);
    this.particles.sparks(p, new THREE.Vector3(0, 1, 0), Math.floor(20 + 40 * k), 12);
    this.particles.debrisBurst(p, g.player.vehicle.vel, 0x444444, Math.floor(4 + k * 8));
    bus.emit('crash', { impulse: mag, x: p.x, y: p.y, z: p.z, withTraffic });
    _q.copy(g.player.vehicle.quat).invert();
    const v = g.player.vehicle;
    const local = p.clone().sub(v.pos).applyQuaternion(_q);
    const dir = local.clone().normalize().negate();
    const detached = g.player.model.applyImpact(local, dir, mag * 0.5 / v.spec.toughness);
    for (const part of detached) this.detachPart(part);
    if (this.invulnerable <= 0) v.health = Math.max(0, v.health - mag * 0.6 / v.spec.toughness);
    if (mag > 14 && this.crashCamEnabled && g.simTime - this.lastCrashT > 3) {
      this.lastCrashT = g.simTime;
      g.rig.startCrashCam(p, this.vPre, 1.3);
      g.slowMo(0.25, 0.9);
    }
  }

  breakProp(ref: BreakableRef, carVel: THREE.Vector3) {
    const g = this.game;
    const c = ref.chunk;
    const o = ref.index * PROP_STRIDE;
    const p = c.data.props;
    const type = ref.type;
    const phys = PROP_PHYS[type];
    if (ref.collider) {
      g.physics.removeCollider(ref.collider);
      ref.collider = null;
    }
    g.chunks.killProp(c, ref.index);
    const pos = new THREE.Vector3(p[o + 1], p[o + 2], p[o + 3]);
    const sx = p[o + 5], sy = p[o + 6], sz = p[o + 7];
    // flying physics prop
    const geo = g.chunks.props.geometry(type);
    const mat = g.chunks.props.material(type);
    const mesh = new THREE.Mesh(geo, mat as THREE.Material);
    mesh.scale.set(sx, sy, sz);
    mesh.castShadow = true;
    const holder = new THREE.Group();
    mesh.position.y = -phys.oy * sy;
    holder.add(mesh);
    const yaw = p[o + 4];
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const sp = carVel.length();
    const fly = carVel.clone().multiplyScalar(1.05 + (phys.mass < 50 ? 0.25 : -0.3)).add(new THREE.Vector3(0, 2 + Math.min(10, sp * 0.18) * (phys.mass < 50 ? 1.2 : 0.5), 0));
    let cd: RAPIER.ColliderDesc;
    if (phys.shape === 'cyl') cd = RAPIER.ColliderDesc.cylinder(phys.hy * sy, Math.max(0.15, phys.hx * sx));
    else if (phys.shape === 'ball') cd = RAPIER.ColliderDesc.ball(phys.hx * sx);
    else cd = RAPIER.ColliderDesc.cuboid(Math.max(0.1, phys.hx * sx), phys.hy * sy, Math.max(0.1, phys.hz * sz));
    this.spawnDebris(holder, pos.clone().add(new THREE.Vector3(0, phys.oy * sy + 0.05, 0)), rot, fly, cd.setMass(phys.mass), 10);
    // juice
    const kind = SMASH_SOUND[type] ?? 'wood';
    audio.smash(kind);
    g.rig.addTrauma(Math.min(0.35, phys.mass / 600 + 0.08));
    if (type === Prop.Pine || type === Prop.Palm || type === Prop.Cactus) this.particles.leaves(pos, carVel, type === Prop.Cactus ? [0.3, 0.55, 0.25] : [0.15, 0.35, 0.15]);
    if (type === Prop.Lamp) this.particles.sparks(pos.clone().add(new THREE.Vector3(0, 7.5, 0)), new THREE.Vector3(0, -1, 0), 25, 6);
    this.particles.debrisBurst(pos.clone().add(new THREE.Vector3(0, 0.5, 0)), carVel, type === Prop.Cone ? 0xff5a10 : type === Prop.Lamp ? 0x444444 : 0x7a5a3a, 3);
    if (phys.explode) this.explode(pos, type === Prop.Pump ? 1.6 : 1);
    bus.emit('smash', { kind: phys.name, x: pos.x, y: pos.y, z: pos.z, points: phys.points });
  }

  explode(pos: THREE.Vector3, power: number) {
    const g = this.game;
    this.particles.explosion(pos, power);
    audio.explosion(Math.min(1, power));
    g.rig.addTrauma(0.6 * power);
    g.postfx?.flashColor(0.6 * power, 0.35 * power, 0.1 * power);
    const v = g.player.vehicle;
    const d = v.pos.distanceTo(pos);
    if (d < 14) {
      // launch the player (it's fun)
      const k = (1 - d / 14) * power;
      const dir = v.pos.clone().sub(pos).normalize();
      dir.y = Math.max(0.6, dir.y);
      v.body.applyImpulse({ x: dir.x * v.spec.mass * 9 * k, y: dir.y * v.spec.mass * 9 * k, z: dir.z * v.spec.mass * 9 * k }, true);
      v.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * v.spec.mass * 6 * k, y: 0, z: (Math.random() - 0.5) * v.spec.mass * 6 * k }, true);
    }
    // push nearby debris
    for (const db of this.debris) {
      const t = db.body.translation();
      const dd = Math.hypot(t.x - pos.x, t.y - pos.y, t.z - pos.z);
      if (dd < 15) {
        const k = (1 - dd / 15) * power * db.body.mass() * 12;
        db.body.applyImpulse({ x: (t.x - pos.x) / dd * k, y: k, z: (t.z - pos.z) / dd * k }, true);
      }
    }
    bus.emit('explode', { x: pos.x, y: pos.y, z: pos.z, power });
  }

  detachPart(part: DetachPart) {
    const g = this.game;
    const model = g.player.model;
    const v = g.player.vehicle;
    const mesh = part.mesh;
    const wp = new THREE.Vector3();
    const wq = new THREE.Quaternion();
    mesh.getWorldPosition(wp);
    mesh.getWorldQuaternion(wq);
    model.bodyGroup.remove(mesh);
    const clone = new THREE.Mesh(mesh.geometry, mesh.material);
    clone.castShadow = true;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!;
    const size = bb.getSize(new THREE.Vector3());
    const cd = RAPIER.ColliderDesc.cuboid(Math.max(0.05, size.x / 2), Math.max(0.05, size.y / 2), Math.max(0.05, size.z / 2)).setMass(15);
    const vel = v.vel.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, 3 + Math.random() * 3, (Math.random() - 0.5) * 4));
    this.spawnDebris(clone, wp, wq, vel, cd, 15);
    this.particles.sparks(wp, new THREE.Vector3(0, 1, 0), 15, 6);
    bus.emit('toast', { text: `${part.name.toUpperCase()} GONE`, color: '#ff8a3d' });
  }

  spawnDebris(obj: THREE.Object3D, pos: THREE.Vector3, rot: THREE.Quaternion, vel: THREE.Vector3, cd: RAPIER.ColliderDesc, life: number) {
    const g = this.game;
    while (this.debris.length >= this.maxDebris) this.removeDebris(0);
    const body = g.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
        .setLinvel(vel.x, vel.y, vel.z)
        .setAngvel({ x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 })
        .setLinearDamping(0.1)
        .setAngularDamping(0.2),
    );
    const col = g.physics.world.createCollider(cd.setCollisionGroups(groups(G_DEBRIS, G_WORLD | G_CAR | G_TRAFFIC | G_DEBRIS)).setFriction(0.6).setRestitution(0.2), body);
    g.physics.tag(col, { kind: 'debris' });
    obj.position.copy(pos);
    obj.quaternion.copy(rot);
    g.scene.add(obj);
    this.debris.push({ body, obj, life });
  }

  private removeDebris(i: number) {
    const d = this.debris[i];
    this.game.physics.removeBody(d.body);
    this.game.scene.remove(d.obj);
    this.debris.splice(i, 1);
  }

  /** sync debris meshes */
  update(dt: number) {
    const v = this.game.player.vehicle;
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      const t = d.body.translation();
      const r = d.body.rotation();
      d.obj.position.set(t.x, t.y, t.z);
      d.obj.quaternion.set(r.x, r.y, r.z, r.w);
      const far = Math.hypot(t.x - v.pos.x, t.z - v.pos.z) > 220;
      // freeze bodies that left loaded physics
      if (!this.game.chunks.ready(t.x, t.z) && !far) d.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      if (d.life <= 0 || far || t.y < -60) {
        if (d.life > -1 && !far) {
          d.obj.scale.multiplyScalar(1 - dt * 3);
          if (d.obj.scale.x > 0.05) continue;
        }
        this.removeDebris(i);
      }
    }
  }

  clear() {
    while (this.debris.length) this.removeDebris(0);
  }
}
