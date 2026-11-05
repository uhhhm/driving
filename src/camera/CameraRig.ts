// Camera: dynamic chase, hood, far chase, look-back, cinematic crash cam, photo free-cam.
import * as THREE from 'three';
import { Noise2D, clamp, damp, lerp } from '../core/rng';
import type { Vehicle } from '../vehicle/Vehicle';

export type CamMode = 'chase' | 'far' | 'hood' | 'cinematic';
const MODES: CamMode[] = ['chase', 'far', 'hood', 'cinematic'];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _t = new THREE.Vector3();

export class CameraRig {
  camera: THREE.PerspectiveCamera;
  mode: CamMode = 'chase';
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private heading = new THREE.Vector3(0, 0, 1);
  private trauma = 0;
  private noise = new Noise2D(99);
  private t = 0;
  fovBase = 68;
  private fov = 68;
  private fovKick = 0;
  // crash cam
  crash: { t: number; dur: number; pos: THREE.Vector3; target: THREE.Vector3; orbit: number } | null = null;
  photo = false;
  private photoYaw = 0;
  private photoPitch = 0;
  private cineIdx = 0;
  private cineTimer = 0;
  private cinePos = new THREE.Vector3();
  lookBack = false;
  speedFx = 0; // 0..1 for post fx
  groundAt: (x: number, z: number) => number = () => -1e9;
  /** returns distance along from→to to the first world hit, or null */
  occlusion: (from: THREE.Vector3, to: THREE.Vector3) => number | null = () => null;
  private unblock(target: THREE.Vector3, cam: THREE.Vector3) {
    const d = cam.distanceTo(target);
    const hit = this.occlusion(target, cam);
    if (hit !== null && hit < d) cam.lerpVectors(target, cam, Math.max(0.15, (hit - 0.4) / d));
  }

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(68, aspect, 0.1, 3000);
  }

  cycle() {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
  }

  addTrauma(t: number) {
    this.trauma = Math.min(1, this.trauma + t);
  }

  kickFov(v: number) {
    this.fovKick = Math.max(this.fovKick, v);
  }

  startCrashCam(at: THREE.Vector3, carVel: THREE.Vector3, dur = 1.8) {
    const side = _v.set(-carVel.z, 0, carVel.x).normalize();
    if (Math.random() < 0.5) side.negate();
    const pos = at.clone().addScaledVector(side, 7).add(new THREE.Vector3(0, 2.2, 0)).addScaledVector(carVel.clone().normalize(), 6);
    this.crash = { t: 0, dur, pos, target: at.clone(), orbit: Math.random() < 0.5 ? -1 : 1 };
  }

  snap(v: Vehicle) {
    this.heading.copy(v.fwd).setY(0).normalize();
    this.pos.copy(v.pos).addScaledVector(this.heading, -8).add(new THREE.Vector3(0, 3, 0));
    this.look.copy(v.pos);
  }

  enterPhoto() {
    this.photo = true;
    const d = _v.copy(this.look).sub(this.camera.position).normalize();
    this.photoYaw = Math.atan2(d.x, d.z);
    this.photoPitch = Math.asin(clamp(d.y, -1, 1));
  }

  updatePhoto(dt: number, keys: Set<string>, mouse: { dx: number; dy: number }) {
    const cam = this.camera;
    this.photoYaw -= mouse.dx * 0.003;
    this.photoPitch = clamp(this.photoPitch - mouse.dy * 0.003, -1.4, 1.4);
    if (keys.has('KeyJ')) this.photoYaw += dt * 1.2;
    if (keys.has('KeyL')) this.photoYaw -= dt * 1.2;
    if (keys.has('KeyI')) this.photoPitch = Math.min(1.4, this.photoPitch + dt);
    if (keys.has('KeyK')) this.photoPitch = Math.max(-1.4, this.photoPitch - dt);
    const fwd = _v.set(Math.sin(this.photoYaw) * Math.cos(this.photoPitch), Math.sin(this.photoPitch), Math.cos(this.photoYaw) * Math.cos(this.photoPitch));
    const right = _v2.set(-Math.cos(this.photoYaw), 0, Math.sin(this.photoYaw));
    const sp = (keys.has('ShiftLeft') ? 30 : 8) * dt;
    if (keys.has('KeyW') || keys.has('ArrowUp')) cam.position.addScaledVector(fwd, sp);
    if (keys.has('KeyS') || keys.has('ArrowDown')) cam.position.addScaledVector(fwd, -sp);
    if (keys.has('KeyD') || keys.has('ArrowRight')) cam.position.addScaledVector(right, sp);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) cam.position.addScaledVector(right, -sp);
    if (keys.has('KeyE')) cam.position.y += sp;
    if (keys.has('KeyQ')) cam.position.y -= sp;
    cam.lookAt(_t.copy(cam.position).add(fwd));
  }

  update(dt: number, realDt: number, v: Vehicle, boosting: boolean, groundY: number) {
    if (this.photo) return;
    this.t += realDt;
    const cam = this.camera;
    const speed = v.speedAbs;
    const sp01 = clamp(speed / 70, 0, 1);
    this.speedFx = damp(this.speedFx, clamp((speed - 15) / 60, 0, 1) + (boosting ? 0.4 : 0), 4, realDt);

    // ---- crash cam ----
    if (this.crash) {
      const c = this.crash;
      c.t += realDt;
      const k = c.t / c.dur;
      c.target.lerp(v.pos, 1 - Math.exp(-realDt * 6));
      const orbitAng = k * 0.9 * c.orbit;
      const off = _v.copy(c.pos).sub(c.target);
      off.applyAxisAngle(new THREE.Vector3(0, 1, 0), orbitAng * realDt * 1.5);
      c.pos.copy(c.target).add(off);
      cam.position.copy(c.pos);
      cam.position.y = Math.max(cam.position.y, this.groundAt(cam.position.x, cam.position.z) + 1.2, groundY);
      this.unblock(_t.copy(c.target).setY(c.target.y + 1), cam.position);
      cam.lookAt(c.target);
      cam.fov = lerp(55, 40, Math.min(1, k * 2));
      cam.updateProjectionMatrix();
      if (c.t > c.dur) {
        this.crash = null;
        this.snap(v);
      }
      return;
    }

    // heading follows velocity when moving (shows off drift angle), car forward otherwise
    const flatFwd = _v.copy(v.fwd).setY(0);
    if (flatFwd.lengthSq() < 0.01) flatFwd.set(0, 0, 1);
    flatFwd.normalize();
    const flatVel = _v2.copy(v.vel).setY(0);
    let desired = flatFwd;
    if (flatVel.length() > 4 && v.speed > -1) {
      flatVel.normalize();
      const k = clamp((v.speedAbs - 4) / 12, 0, 1) * 0.6;
      desired = flatFwd.lerp(flatVel, k).normalize();
    }
    if (v.speed < -2) desired = flatFwd; // reversing: keep behind
    const followRate = v.groundedCount === 0 ? 1.8 : 5.5;
    this.heading.lerp(desired, 1 - Math.exp(-realDt * followRate)).normalize();

    let dist: number;
    let height: number;
    if (this.mode === 'far') {
      dist = 10.5 + sp01 * 3;
      height = 3.8;
    } else {
      dist = 6.4 + sp01 * 2.4;
      height = 2.2 + sp01 * 0.3;
    }
    const sizeK = Math.max(1, v.spec.half[2] / 2.2, v.spec.half[1] / 0.45 * 0.75);
    dist *= sizeK;
    height *= sizeK;
    const hd = this.lookBack ? -1 : 1;

    if (this.mode === 'hood') {
      const p = _t.set(0, v.spec.colliderY + v.spec.half[1] + 0.25, v.spec.half[2] * 0.3).applyQuaternion(v.quat).add(v.pos);
      cam.position.copy(p);
      const fw = _v.copy(v.fwd).multiplyScalar(hd);
      cam.up.copy(v.up);
      cam.lookAt(p.add(fw.multiplyScalar(10)));
      cam.up.set(0, 1, 0);
    } else if (this.mode === 'cinematic') {
      // trackside cameras that leapfrog the car
      this.cineTimer -= realDt;
      if (this.cineTimer <= 0 || this.cinePos.distanceTo(v.pos) > 70) {
        const ahead = _v.copy(v.vel).setY(0);
        if (ahead.length() < 1) ahead.copy(v.fwd);
        ahead.normalize().multiplyScalar(30 + speed * 0.8);
        const side = _v2.set(-ahead.z, 0, ahead.x).normalize().multiplyScalar((this.cineIdx++ % 2 ? 1 : -1) * (8 + Math.random() * 6));
        this.cinePos.copy(v.pos).add(ahead).add(side);
        this.cinePos.y = Math.max(this.groundAt(this.cinePos.x, this.cinePos.z), groundY) + 1.5 + Math.random() * 4;
        this.cineTimer = 4.5;
      }
      cam.position.copy(this.cinePos);
      cam.lookAt(v.pos);
    } else {
      const target = _t.copy(v.pos).addScaledVector(this.heading, -dist * hd);
      target.y += height;
      // spring follow with velocity look-ahead
      const rate = this.mode === 'far' ? 6 : 9;
      this.pos.x = damp(this.pos.x, target.x, rate, realDt);
      this.pos.z = damp(this.pos.z, target.z, rate, realDt);
      this.pos.y = damp(this.pos.y, target.y, v.groundedCount ? 6 : 3, realDt);
      // keep the camera at least at a fixed distance (prevents lag at high speed)
      const off = _v.copy(this.pos).sub(v.pos);
      const flat = Math.hypot(off.x, off.z);
      const maxD = dist * 1.25;
      if (flat > maxD) {
        off.x *= maxD / flat;
        off.z *= maxD / flat;
        this.pos.x = v.pos.x + off.x;
        this.pos.z = v.pos.z + off.z;
      }
      this.pos.y = Math.max(this.pos.y, this.groundAt(this.pos.x, this.pos.z) + 0.8, groundY);
      cam.position.copy(this.pos);
      this.unblock(_t.copy(v.pos).setY(v.pos.y + 1.2), cam.position);
      this.look.copy(v.pos).addScaledVector(this.heading, 4 * hd);
      this.look.y += 1.1 * sizeK;
      cam.lookAt(this.look);
    }

    // ---- shake & fov ----
    this.trauma = Math.max(0, this.trauma - realDt * 1.4);
    const sh = this.trauma * this.trauma + (boosting ? 0.04 : 0) + sp01 * sp01 * 0.012;
    const n1 = this.noise.noise(this.t * 18, 0);
    const n2 = this.noise.noise(0, this.t * 18);
    const n3 = this.noise.noise(this.t * 18, 50);
    cam.rotateX(n1 * sh * 0.08);
    cam.rotateY(n2 * sh * 0.08);
    cam.rotateZ(n3 * sh * 0.1);

    this.fovKick = Math.max(0, this.fovKick - realDt * 1.2);
    const targetFov = this.fovBase + sp01 * 14 + (boosting ? 12 : 0) + this.fovKick * 10 + (this.mode === 'hood' ? 6 : 0);
    this.fov = damp(this.fov, targetFov, boosting ? 7 : 3, realDt);
    cam.fov = this.fov;
    cam.updateProjectionMatrix();
  }
}
