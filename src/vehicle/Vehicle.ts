// Raycast-wheel arcade vehicle on a Rapier rigid body.
// The tyre model is impulse based: each wheel cancels its lateral contact velocity,
// limited by a grip budget that depends on load, surface, weather and slip angle.
import * as THREE from 'three';
import { RAPIER, Physics, G_CAR, G_WORLD, G_TRAFFIC, G_DEBRIS, G_BREAKABLE, groups } from '../core/Physics';
import type { Controls } from '../core/Input';
import { clamp, lerp, smoothstep } from '../core/rng';
import { Surface } from '../world/types';
import type { CarSpec } from './VehicleDefs';

export interface SurfaceProps {
  mu: number;
  slide: number; // multiplier on slide plateau
  roll: number; // rolling resistance (m/s^2 at full)
  bump: number; // suspension noise amplitude
  dust: [number, number, number] | null; // particle colour
}

export const SURFACES: SurfaceProps[] = [];
SURFACES[Surface.Asphalt] = { mu: 1.0, slide: 1.0, roll: 0.15, bump: 0, dust: null };
SURFACES[Surface.Dirt] = { mu: 0.74, slide: 1.12, roll: 0.5, bump: 0.012, dust: [0.55, 0.42, 0.3] };
SURFACES[Surface.Grass] = { mu: 0.66, slide: 1.1, roll: 0.9, bump: 0.018, dust: [0.35, 0.42, 0.22] };
SURFACES[Surface.Sand] = { mu: 0.62, slide: 1.1, roll: 1.8, bump: 0.01, dust: [0.85, 0.68, 0.45] };
SURFACES[Surface.Snow] = { mu: 0.46, slide: 1.15, roll: 0.9, bump: 0.008, dust: [0.95, 0.97, 1.0] };
SURFACES[Surface.Rock] = { mu: 0.8, slide: 1.0, roll: 0.4, bump: 0.02, dust: [0.5, 0.48, 0.45] };
SURFACES[Surface.Ice] = { mu: 0.2, slide: 1.2, roll: 0.05, bump: 0, dust: null };
SURFACES[Surface.Concrete] = { mu: 0.95, slide: 1.0, roll: 0.2, bump: 0, dust: null };

export interface Wheel {
  local: THREE.Vector3; // mount point in body space
  front: boolean;
  left: boolean;
  driven: boolean;
  radius: number;
  comp: number;
  prevComp: number;
  grounded: boolean;
  contact: THREE.Vector3;
  normal: THREE.Vector3;
  surface: Surface;
  slipLat: number; // m/s lateral slide
  slipAngle: number;
  spin: number; // wheelspin amount 0..1
  lock: number;
  angle: number; // rotation angle for visuals
  steer: number; // current steer angle
  load: number;
  hitCollider: number; // handle
  vlong: number;
}

export interface Env {
  weatherGrip: number; // multiplier
  iceRoads: number; // 0..1 chance-ish factor (snow storm)
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _f = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

export class Vehicle {
  spec: CarSpec;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  wheels: Wheel[] = [];
  private k: number; // spring rate per wheel
  private c: number; // damper per wheel
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  // drivetrain
  rpm = 900;
  gear = 1; // -1 reverse, 0 neutral, 1..n
  shiftTimer = 0;
  private reverseTimer = 0;
  throttle = 0;
  brakeInput = 0;
  steerInput = 0;
  handbrake = false;
  // state
  boost: number;
  boosting = false;
  health = 100;
  groundedCount = 0;
  airTime = 0;
  speed = 0; // m/s signed forward
  speedAbs = 0;
  slipAngleBody = 0; // beta
  drifting = false;
  driftMode = false;
  private latchPitch = false;
  private latchSteer = false;
  private driftExitTimer = 0;
  driftTime = 0;
  wheelspin = 0;
  upsideTimer = 0;
  limiter = false;
  tune = { gripMul: 1, powerMul: 1, assistMul: 1, airMul: 1, springMul: 1, slideMul: 1 };
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly fwd = new THREE.Vector3(0, 0, 1);
  readonly right = new THREE.Vector3(-1, 0, 0);
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  readonly vel = new THREE.Vector3();
  readonly angVel = new THREE.Vector3();
  prevVel = new THREE.Vector3();
  frozen = false;

  constructor(
    private physics: Physics,
    spec: CarSpec,
    pos: THREE.Vector3,
    yaw: number,
  ) {
    this.spec = spec;
    const w = physics.world;
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body = w.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
        .setCcdEnabled(true)
        .setLinearDamping(0.02)
        .setAngularDamping(0.3)
        .setCanSleep(false),
    );
    const [hx, hy, hz] = spec.half;
    const desc = RAPIER.ColliderDesc.roundCuboid(hx - 0.1, hy - 0.1, hz - 0.1, 0.1)
      .setTranslation(0, spec.colliderY, 0)
      .setFriction(0.35)
      .setRestitution(0.1)
      .setCollisionGroups(groups(G_CAR, G_WORLD | G_TRAFFIC | G_DEBRIS | G_BREAKABLE))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
      .setDensity(0);
    this.collider = w.createCollider(desc, this.body);
    physics.tag(this.collider, { kind: 'car', ref: this });
    // mass properties: box inertia scaled by personality multipliers
    const m = spec.mass;
    const ix = (m / 12) * (4 * hy * hy + 4 * hz * hz) * spec.inertia[0];
    const iy = (m / 12) * (4 * hx * hx + 4 * hz * hz) * spec.inertia[1];
    const iz = (m / 12) * (4 * hx * hx + 4 * hy * hy) * spec.inertia[2];
    this.body.setAdditionalMassProperties(m, { x: 0, y: spec.comY, z: 0 }, { x: ix, y: iy, z: iz }, { x: 0, y: 0, z: 0, w: 1 }, true);

    const mw = m / 4;
    const omega = 2 * Math.PI * spec.freq;
    this.k = mw * omega * omega;
    this.c = 2 * spec.zeta * Math.sqrt(this.k * mw);
    const mk = (x: number, z: number, front: boolean, left: boolean): Wheel => ({
      local: new THREE.Vector3(x, spec.wheelY, z),
      front,
      left,
      driven: spec.drive === 'AWD' || (spec.drive === 'RWD' ? !front : front),
      radius: spec.wheelR,
      comp: 0,
      prevComp: 0,
      grounded: false,
      contact: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      surface: Surface.Asphalt,
      slipLat: 0,
      slipAngle: 0,
      spin: 0,
      lock: 0,
      angle: 0,
      steer: 0,
      load: 0,
      hitCollider: -1,
      vlong: 0,
    });
    this.wheels = [
      mk(spec.wheelX, spec.wheelZf, true, true),
      mk(-spec.wheelX, spec.wheelZf, true, false),
      mk(spec.wheelX, spec.wheelZr, false, true),
      mk(-spec.wheelX, spec.wheelZr, false, false),
    ];
    this.boost = spec.boostCapacity * 0.5;
    this.syncState();
  }

  dispose() {
    this.physics.removeBody(this.body);
  }

  syncState() {
    const t = this.body.translation();
    const r = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();
    this.pos.set(t.x, t.y, t.z);
    this.quat.set(r.x, r.y, r.z, r.w);
    this.vel.set(lv.x, lv.y, lv.z);
    this.angVel.set(av.x, av.y, av.z);
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    this.fwd.set(0, 0, 1).applyQuaternion(this.quat);
    this.right.set(-1, 0, 0).applyQuaternion(this.quat);
  }

  surfaceOf(colliderHandle: number, x: number, z: number): Surface {
    const info = this.physics.info.get(colliderHandle);
    if (!info) return Surface.Concrete;
    if (info.kind === 'road') {
      const s = info.chunk?.surfaceAt(x, z) ?? Surface.Asphalt;
      return s === Surface.Dirt ? Surface.Dirt : Surface.Asphalt;
    }
    if (info.kind === 'terrain') {
      const s = info.chunk?.surfaceAt(x, z) ?? Surface.Grass;
      return s === Surface.Asphalt ? Surface.Dirt : s;
    }
    if (info.kind === 'traffic') return Surface.Concrete;
    return Surface.Concrete;
  }

  step(dt: number, ctl: Controls, env: Env) {
    if (this.frozen) return;
    const spec = this.spec;
    const body = this.body;
    const world = this.physics.world;
    this.syncState();
    this.prevVel.copy(this.vel);
    const m = spec.mass;
    const up = _up.copy(this.up);
    const fwd = _fwd.copy(this.fwd);
    const right = _right.copy(this.right);

    _qi.copy(this.quat).invert();
    const vLocal = _v.copy(this.vel).applyQuaternion(_qi);
    this.speed = vLocal.z;
    this.speedAbs = this.vel.length();
    const horiz = Math.hypot(vLocal.x, vLocal.z);
    this.slipAngleBody = horiz > 3 ? Math.atan2(vLocal.x, Math.abs(vLocal.z)) : 0;

    // ---- inputs / gear logic ----
    let throttle = ctl.throttle;
    let brake = ctl.brake;
    this.handbrake = ctl.handbrake;
    this.steerInput = ctl.steer;
    if (this.gear === -1) {
      if (ctl.throttle > 0.1 && this.speed > -2) this.gear = 1;
      else {
        throttle = ctl.brake;
        brake = ctl.throttle;
      }
    } else if (ctl.brake > 0.5 && ctl.throttle < 0.1 && this.speed < 1.2) {
      this.reverseTimer += dt;
      if (this.reverseTimer > 0.25) {
        this.gear = -1;
        this.reverseTimer = 0;
      }
    } else this.reverseTimer = 0;
    this.throttle = throttle;
    this.brakeInput = brake;

    const gearRatio = this.gear === -1 ? -3.2 : spec.gears[Math.max(0, this.gear - 1)];
    const totalRatio = gearRatio * spec.finalDrive;

    // ---- suspension raycasts ----
    let grounded = 0;
    const filter = groups(G_CAR, G_WORLD | G_TRAFFIC);
    for (const w of this.wheels) {
      const mount = _v2.copy(w.local).applyQuaternion(this.quat).add(this.pos);
      this.ray.origin = { x: mount.x, y: mount.y, z: mount.z };
      this.ray.dir = { x: -up.x, y: -up.y, z: -up.z };
      const maxLen = spec.restLen + w.radius;
      const hit = world.castRayAndGetNormal(this.ray, maxLen, true, undefined, filter, undefined, body);
      w.prevComp = w.comp;
      if (hit) {
        const toi = hit.timeOfImpact;
        w.grounded = true;
        w.comp = clamp(spec.restLen - (toi - w.radius), 0, spec.restLen);
        w.contact.set(mount.x - up.x * toi, mount.y - up.y * toi, mount.z - up.z * toi);
        w.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        if (w.normal.dot(up) < 0) w.normal.negate();
        w.hitCollider = hit.collider.handle;
        w.surface = this.surfaceOf(hit.collider.handle, w.contact.x, w.contact.z);
        grounded++;
      } else {
        w.grounded = false;
        w.comp = Math.max(0, w.comp - dt * 3); // extend
        w.load = 0;
        w.hitCollider = -1;
      }
    }
    // takeoff stabilisation: kill most of the pitch/roll kick the suspension gives you off a lip
    if (grounded === 0 && this.groundedCount > 0) {
      _qi.copy(this.quat).invert();
      const la = _v2.copy(this.angVel).applyQuaternion(_qi);
      la.x *= 0.3;
      la.z *= 0.45;
      la.applyQuaternion(this.quat);
      body.setAngvel({ x: la.x, y: la.y, z: la.z }, true);
      this.angVel.copy(la);
      this.onTakeoff?.();
      this.latchPitch = Math.abs(ctl.throttle - ctl.brake) > 0.1;
      this.latchSteer = Math.abs(ctl.steer) > 0.1;
    }
    this.groundedCount = grounded;

    // ---- engine ----
    let drivenSpeed = 0;
    let nDriven = 0;
    for (const w of this.wheels)
      if (w.driven) {
        drivenSpeed += w.grounded ? w.vlong : this.speed;
        nDriven++;
      }
    drivenSpeed /= nDriven;
    const wheelOmega = drivenSpeed / spec.wheelR;
    let targetRpm = Math.abs(wheelOmega * totalRatio) * (60 / (2 * Math.PI));
    const slipping = this.wheelspin > 0.3 || grounded === 0;
    if (slipping || this.shiftTimer > 0) {
      // free-revving in the air / spinning wheels
      const free = spec.idleRpm + (spec.redline - spec.idleRpm) * throttle * (this.shiftTimer > 0 ? 0.6 : 1);
      targetRpm = Math.max(targetRpm, free * (grounded === 0 ? 1 : 0.85));
    }
    targetRpm = Math.max(spec.idleRpm, targetRpm);
    this.rpm = lerp(this.rpm, targetRpm, 1 - Math.exp(-dt * (grounded ? 18 : 6)));
    this.limiter = false;
    if (this.rpm > spec.redline) {
      this.rpm = spec.redline + 50 * Math.sin(performance.now() * 0.08);
      this.limiter = true;
    }
    // auto gearbox
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    else if (this.gear >= 1 && grounded > 0) {
      const up = spec.redline * 0.93;
      if (this.rpm > up && this.gear < spec.gears.length && this.wheelspin < 0.5) {
        this.gear++;
        this.shiftTimer = spec.shiftTime;
        this.onShift?.(this.gear, true);
      } else if (this.gear > 1) {
        const lower = spec.gears[this.gear - 2] * spec.finalDrive;
        const rpmLower = Math.abs(wheelOmega * lower) * (60 / (2 * Math.PI));
        if (rpmLower < spec.redline * 0.72 && this.rpm < spec.redline * 0.5) {
          this.gear--;
          this.shiftTimer = spec.shiftTime * 0.6;
          this.onShift?.(this.gear, false);
        }
      }
    }
    // torque curve (normalised), peak around 70% redline
    const r = this.rpm / spec.redline;
    const curve = r < 0.7 ? 0.62 + 0.38 * Math.sin((r / 0.7) * Math.PI * 0.5) : 1 - (r - 0.7) * 0.8;
    let engineTorque = spec.torque * this.tune.powerMul * curve * throttle;
    if (this.limiter || this.shiftTimer > 0) engineTorque *= 0.05;
    const driveForceTotal = (engineTorque * totalRatio * 0.92) / spec.wheelR;

    // ---- steering ----
    const sp = Math.abs(this.speed);
    const steerLimit = 1 / (1 + Math.max(0, sp - 8) * 0.02 * spec.steerSpeedFalloff * 2);
    const assist = spec.driftAssist * this.tune.assistMul;
    let counter = 0;
    if (horiz > 5 && this.speed > 0) counter = clamp(this.slipAngleBody, -0.6, 0.6) * assist * 0.9;
    const steerAngle = clamp(-ctl.steer * spec.maxSteer * steerLimit + counter, -spec.maxSteer * 1.2, spec.maxSteer * 1.2);

    // ---- drift state machine: grippy until you ask for a slide ----
    const absBeta = Math.abs(this.slipAngleBody);
    const enter =
      (this.handbrake && sp > 8 && Math.abs(ctl.steer) > 0.2) ||
      (brake > 0.4 && throttle > 0.4 && Math.abs(ctl.steer) > 0.5 && sp > 14) || // brake-tap / left-foot
      (absBeta > 0.32 && sp > 12 && throttle > 0.3);
    if (!this.driftMode && enter && grounded >= 3) {
      this.driftMode = true;
      this.driftExitTimer = 0;
    }
    if (this.driftMode) {
      if ((absBeta < 0.1 && !this.handbrake) || sp < 5 || grounded < 2) this.driftExitTimer += dt;
      else this.driftExitTimer = 0;
      if (this.driftExitTimer > 0.3) this.driftMode = false;
    }

    // ---- per wheel forces ----
    const mEff = m * 0.25;
    let spinAcc = 0;
    for (const w of this.wheels) {
      w.steer = w.front ? steerAngle : 0;
      if (!w.grounded) {
        w.spin = lerp(w.spin, throttle > 0.5 && w.driven ? 1 : 0, dt * 4);
        w.vlong = lerp(w.vlong, w.driven ? this.speed + throttle * 30 : this.speed, dt * 2);
        w.angle += (w.vlong / w.radius) * dt;
        continue;
      }
      const sProps = SURFACES[w.surface];
      // suspension
      const compVel = (w.comp - w.prevComp) / dt;
      const k = this.k * this.tune.springMul;
      let Fs = k * w.comp + this.c * compVel * (compVel > 0 ? 1 : 1.4);
      if (w.comp > spec.travel) Fs += k * 6 * (w.comp - spec.travel); // bump stop
      // surface bumpiness
      if (sProps.bump > 0 && sp > 2) Fs += k * sProps.bump * Math.sin(performance.now() * 0.05 + w.local.z * 9) * Math.min(1, sp / 15);
      Fs = Math.max(0, Fs);
      w.load = Fs;

      // wheel axes on contact plane
      const n = w.normal;
      _f.copy(fwd);
      if (w.steer !== 0) _f.applyAxisAngle(up, w.steer);
      _f.addScaledVector(n, -_f.dot(n)).normalize();
      _s.crossVectors(n, _f).normalize(); // points to car's left
      const vc = body.velocityAtPoint({ x: w.contact.x, y: w.contact.y, z: w.contact.z });
      const vl = vc.x * _f.x + vc.y * _f.y + vc.z * _f.z;
      const vs = vc.x * _s.x + vc.y * _s.y + vc.z * _s.z;
      w.vlong = vl;

      let mu = (w.front ? spec.gripF : spec.gripR) * sProps.mu * env.weatherGrip * this.tune.gripMul;
      if (w.surface !== Surface.Asphalt && w.surface !== Surface.Concrete) mu = lerp(mu, Math.max(mu, 0.95 * (w.front ? spec.gripF : spec.gripR)), spec.offroad * 0.6);
      if (env.iceRoads > 0 && (w.surface === Surface.Asphalt || w.surface === Surface.Concrete)) mu *= 1 - env.iceRoads * 0.35;
      const maxF = mu * Fs;

      // longitudinal
      let Fx = 0;
      if (w.driven) {
        Fx += driveForceTotal / nDriven;
        // arcade traction control: a little wheelspin for flavour, not a spin-out
        const tc = this.driftMode || this.handbrake ? 1.6 : 1.12;
        if (Math.abs(Fx) > maxF * tc) Fx = Math.sign(Fx) * maxF * tc;
      }
      // rolling resistance
      Fx -= Math.sign(vl) * Math.min(Math.abs(vl) * 4, 1) * sProps.roll * mEff * (1 - spec.offroad * 0.5);
      // brakes
      let brakeF = brake * spec.brake * (w.front ? 0.62 : 0.38) * 0.5;
      if (this.handbrake && !w.front) brakeF += spec.brake * 0.35;
      if (brakeF > 0) {
        const maxStop = (Math.abs(vl) * mEff) / dt;
        Fx -= Math.sign(vl) * Math.min(brakeF, maxStop);
      }
      let Jlong = Fx * dt;
      const JmaxTotal = maxF * dt;
      w.spin = 0;
      w.lock = 0;
      if (Math.abs(Jlong) > JmaxTotal) {
        const excess = Math.abs(Jlong) / JmaxTotal - 1;
        if (Fx * vl < 0 || (brakeF > 0 && !w.driven)) w.lock = clamp(excess, 0, 1);
        else w.spin = clamp(excess * 0.7, 0, 1);
        Jlong = Math.sign(Jlong) * JmaxTotal;
      }
      if (this.handbrake && !w.front && sp > 3) w.lock = Math.max(w.lock, 0.8);
      spinAcc += w.driven ? w.spin : 0;

      // lateral (impulse that cancels sideways velocity, limited by the grip budget)
      const alpha = Math.atan2(Math.abs(vs), Math.abs(vl) + 0.6);
      w.slipAngle = alpha;
      w.slipLat = vs;
      const peak = spec.peakSlip;
      const slideK = clamp(spec.slide * sProps.slide * this.tune.slideMul, 0.2, 1);
      // outside of a drift the rear stays planted (high plateau); in a drift it settles on the car's slide plateau
      const plateau = w.front ? Math.max(slideK, 0.9) : this.driftMode ? slideK : lerp(slideK, 1, 0.75);
      let gcurve = alpha < peak ? 1 : lerp(1, plateau, smoothstep(peak, peak * 3.5, alpha));
      if (this.handbrake && !w.front) gcurve *= 0.38;
      if (w.spin > 0) gcurve *= 1 - w.spin * (this.driftMode ? 0.5 : 0.2); // power-oversteer
      const JlatMax0 = maxF * dt * gcurve;
      const couple = this.driftMode ? 0.7 : 0.45;
      const JlatMax = Math.sqrt(Math.max(0, JlatMax0 * JlatMax0 - (Jlong * couple) * (Jlong * couple)));
      const Jlat = clamp(-vs * mEff * 0.9, -JlatMax, JlatMax);

      const ix = n.x * Fs * dt + _f.x * Jlong + _s.x * Jlat;
      const iy = n.y * Fs * dt + _f.y * Jlong + _s.y * Jlat;
      const iz = n.z * Fs * dt + _f.z * Jlong + _s.z * Jlat;
      // suspension along body up, tyre forces at contact
      body.applyImpulseAtPoint({ x: ix, y: iy, z: iz }, { x: w.contact.x, y: w.contact.y, z: w.contact.z }, true);

      // apply equal and opposite to dynamic things we're driving on (car roofs!)
      w.angle += ((vl / w.radius) * (1 + w.spin * 2.5) * (1 - w.lock)) * dt;
    }
    this.wheelspin = spinAcc / nDriven;

    // ---- anti-roll bars ----
    const ar = spec.antiRoll * this.k;
    for (const [a, b] of [
      [0, 1],
      [2, 3],
    ]) {
      const wa = this.wheels[a];
      const wb = this.wheels[b];
      if (!wa.grounded && !wb.grounded) continue;
      const diff = wa.comp - wb.comp;
      const F = diff * ar * dt;
      if (wa.grounded) body.applyImpulseAtPoint({ x: up.x * F, y: up.y * F, z: up.z * F }, wa.contact, true);
      if (wb.grounded) body.applyImpulseAtPoint({ x: -up.x * F, y: -up.y * F, z: -up.z * F }, wb.contact, true);
    }

    // ---- body-level forces ----
    const v2 = this.speedAbs * this.speedAbs;
    // aero drag
    const drag = spec.drag * v2 * dt;
    if (this.speedAbs > 0.1) {
      body.applyImpulse({ x: (-this.vel.x / this.speedAbs) * drag, y: (-this.vel.y / this.speedAbs) * drag, z: (-this.vel.z / this.speedAbs) * drag }, true);
    }
    const av = this.angVel;
    const yawRate = av.dot(up);
    const torque = (x: number, y: number, z: number) => body.applyTorqueImpulse({ x: x * dt, y: y * dt, z: z * dt }, true);

    if (grounded > 0) {
      // downforce + loop assist (keeps you glued in loops & half-pipes)
      let df = spec.downforce * v2;
      let stunt = 0;
      for (const w of this.wheels) {
        if (!w.grounded) continue;
        const k = this.physics.info.get(w.hitCollider)?.kind;
        if (k === 'setpiece' || k === 'road') stunt++;
      }
      if (up.y < 0.7 && grounded >= 2 && stunt >= 2) df += m * (9.81 * 1.6) * (1.1 - up.y) * 1.2 + v2 * 8;
      body.applyImpulse({ x: -up.x * df * dt, y: -up.y * df * dt, z: -up.z * df * dt }, true);

      const beta = this.slipAngleBody;
      this.drifting = this.driftMode && grounded >= 3 && Math.abs(beta) > 0.18 && horiz > 8;
      if (this.drifting) this.driftTime += dt;
      else this.driftTime = Math.max(0, this.driftTime - dt * 4);

      const Iy = (m / 12) * (4 * spec.half[0] ** 2 + 4 * spec.half[2] ** 2) * spec.inertia[1];
      if (!this.driftMode && sp > 3) {
        // yaw limiter: never rotate much faster than the bicycle model says the steering asks for
        const wb = spec.wheelZf - spec.wheelZr;
        const target = (this.speed * Math.tan(-ctl.steer * spec.maxSteer * steerLimit)) / wb;
        const lim = Math.abs(target) * 1.15 + 0.25;
        if (Math.abs(yawRate) > lim) {
          const excess = yawRate - Math.sign(yawRate) * lim;
          const k2 = -excess * Iy * 12 * spec.stability;
          torque(up.x * k2, up.y * k2, up.z * k2);
        }
      }
      if (this.drifting) {
        // steering controls rotation directly in a slide; throttle keeps the slide flowing
        torque(up.x * -ctl.steer * Iy * 2.2 * assist, up.y * -ctl.steer * Iy * 2.2 * assist, up.z * -ctl.steer * Iy * 2.2 * assist);
        const push = m * 4.2 * throttle * assist * Math.min(1, Math.abs(beta) * 2);
        const vdir = _v.copy(this.vel).normalize();
        body.applyImpulse({ x: vdir.x * push * dt, y: 0, z: vdir.z * push * dt }, true);
        // anti-spin: past ~65° pull the nose back toward the velocity unless handbraking
        if (Math.abs(beta) > 1.1 && !this.handbrake) {
          const k2 = (Math.abs(beta) - 1.1) * Iy * 10 * Math.sign(beta);
          torque(up.x * k2, up.y * k2, up.z * k2);
        }
      } else if (Math.abs(ctl.steer) < 0.05 && sp > 4) {
        // straight-line stability
        const k2 = -yawRate * Iy * spec.stability * 3.5;
        torque(up.x * k2, up.y * k2, up.z * k2);
      }
      // handbrake initiates rotation
      if (this.handbrake && sp > 6) {
        const k2 = -ctl.steer * Iy * 1.6;
        torque(up.x * k2, up.y * k2, up.z * k2);
      }
      this.airTime = 0;
    } else {
      this.drifting = false;
      this.airTime += dt;
      // ---- air control ----
      const ac = spec.airControl * this.tune.airMul;
      const rate = 7 * ac;
      // inputs held through takeoff are ignored until released (no accidental flips off crests)
      if (this.latchPitch && Math.abs(ctl.throttle - ctl.brake) < 0.1) this.latchPitch = false;
      if (this.latchSteer && Math.abs(ctl.steer) < 0.1) this.latchSteer = false;
      const pitchIn = this.latchPitch ? 0 : ctl.throttle - ctl.brake;
      const steerIn = this.latchSteer ? 0 : ctl.steer;
      const lr = _v.copy(this.angVel).applyQuaternion(_qi); // local angular velocity
      const maxRate = 5.5;
      let dPitch = 0;
      let dRoll = 0;
      let dYaw = 0;
      if (this.handbrake) dYaw = -steerIn * rate;
      else dRoll = steerIn * rate;
      dPitch = pitchIn * rate;
      // local axes: x = pitch (nose down for +), z = roll, y = yaw
      lr.x = clamp(lr.x + dPitch * dt, -maxRate, maxRate);
      lr.z = clamp(lr.z + dRoll * dt, -maxRate, maxRate);
      lr.y = clamp(lr.y + dYaw * dt, -maxRate, maxRate);
      // gentle self-levelling when no input (makes landings friendlier)
      if (Math.abs(pitchIn) < 0.1 && Math.abs(steerIn) < 0.1 && this.airTime > 0.25) {
        const lvl = 1.4 * ac * dt;
        lr.x *= 1 - lvl * 0.5;
        lr.z *= 1 - lvl * 0.5;
      }
      lr.applyQuaternion(this.quat);
      body.setAngvel({ x: lr.x, y: lr.y, z: lr.z }, true);
    }

    // ---- boost ----
    const wantBoost = ctl.boost && this.boost > 0;
    if (wantBoost && !this.boosting) this.onBoost?.(true);
    if (!wantBoost && this.boosting) this.onBoost?.(false);
    this.boosting = wantBoost;
    if (wantBoost) {
      this.boost = Math.max(0, this.boost - dt);
      const F = spec.boostForce * m * 9.81 * dt;
      body.applyImpulse({ x: fwd.x * F, y: fwd.y * F, z: fwd.z * F }, true);
    }

    // ---- upside-down recovery ----
    if (up.y < 0.25 && this.speedAbs < 4) {
      this.upsideTimer += dt;
      if (this.upsideTimer > 1.6) {
        // arcade flip: hop and roll upright
        const yaw = Math.atan2(fwd.x, fwd.z);
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
        body.setTranslation({ x: this.pos.x, y: this.pos.y + 1.5, z: this.pos.z }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        body.setLinvel({ x: 0, y: 3, z: 0 }, true);
        this.upsideTimer = 0;
      }
    } else this.upsideTimer = 0;
  }

  onShift?: (gear: number, up: boolean) => void;
  onTakeoff?: () => void;
  onBoost?: (on: boolean) => void;

  teleport(pos: THREE.Vector3, yaw: number, speed = 0) {
    const q = _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: Math.sin(yaw) * speed, y: 0, z: Math.cos(yaw) * speed }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    for (const w of this.wheels) {
      w.comp = w.prevComp = 0;
    }
    this.gear = 1;
    this.rpm = this.spec.idleRpm;
    this.syncState();
  }

  get kmh() {
    return this.speedAbs * 3.6;
  }
}
