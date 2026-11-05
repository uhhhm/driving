// Turns vehicle state into particles, skid marks, audio and camera feel.
import * as THREE from 'three';
import type { Game } from '../core/Game';
import type { Particles } from './Particles';
import type { SkidMarks } from './SkidMarks';
import { audio } from '../audio/AudioEngine';
import { SURFACES } from '../vehicle/Vehicle';
import { Surface } from '../world/types';
import { bus } from '../core/events';

const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

export class VehicleFX {
  private wasGrounded = true;
  private airPeakVel = 0;
  rain = 0;

  constructor(
    private game: Game,
    private particles: Particles,
    private skids: SkidMarks,
  ) {
    bus.on('shift', (e) => audio.shift(e.up));
    bus.on('boostStart', () => {
      audio.boostKick();
      game.rig.kickFov(1);
      game.rig.addTrauma(0.25);
    });
  }

  update(dt: number, realDt: number) {
    const g = this.game;
    const v = g.player.vehicle;
    const m = g.player.model;
    if (dt <= 0) return;
    let maxSlip = 0;
    let offroad = 0;
    let groundedN = 0;
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      if (!w.grounded) {
        this.skids.add(i, w.contact, w.normal, _s, 0, 0);
        continue;
      }
      groundedN++;
      const sp = SURFACES[w.surface];
      const latSlip = Math.abs(w.slipLat);
      const slip = Math.min(2, latSlip / 6 + w.spin * 1.2 + w.lock * Math.min(1, Math.abs(w.vlong) / 8));
      maxSlip = Math.max(maxSlip, slip);
      if (sp.dust) offroad += 0.25;
      // side vector for marks
      _s.set(-1, 0, 0).applyQuaternion(v.quat);
      const paved = w.surface === Surface.Asphalt || w.surface === Surface.Concrete;
      const markA = paved ? Math.min(1, (slip - 0.35) * 1.2) : Math.min(0.6, slip * 0.5 + (v.speedAbs > 3 ? 0.15 : 0));
      this.skids.add(i, w.contact, w.normal, _s, v.spec.wheelW * 0.9, markA);
      // particles
      const vel = v.vel;
      if (paved) {
        if (slip > 0.45) {
          const n = Math.min(3, Math.floor(slip * 2 * realDt * 60));
          for (let k = 0; k < n; k++) this.particles.smoke(w.contact, vel, Math.min(1, slip - 0.3), g.weatherWet > 0.3 ? [0.8, 0.82, 0.86] : [0.9, 0.9, 0.92]);
        }
        if (g.weatherWet > 0.3 && v.speedAbs > 12 && Math.random() < 0.5) this.particles.splash(w.contact, 1);
      } else if (sp.dust && (v.speedAbs > 6 || slip > 0.3)) {
        const amt = Math.min(1, v.speedAbs / 30 + slip * 0.5);
        if (Math.random() < amt) this.particles.dust(w.contact, vel, amt, w.surface === Surface.Snow ? [0.95, 0.96, 1] : sp.dust);
      }
    }

    // boost flames
    const back = _v.copy(v.fwd).negate();
    for (const fl of m.flames) {
      fl.visible = v.boosting;
      if (v.boosting) fl.scale.set(1, 1, 0.7 + Math.random() * 0.6);
    }
    if (v.boosting) {
      for (const e of m.exhausts) {
        _p.copy(e).applyQuaternion(v.quat).add(v.pos);
        this.particles.boostFlame(_p, back, v.vel, v.spec.style === 'couch');
      }
    }
    // exhaust pops on lift (visual)
    if (v.throttle < 0.1 && v.rpm > v.spec.redline * 0.6 && Math.random() < 0.06) {
      for (const e of m.exhausts) {
        _p.copy(e).applyQuaternion(v.quat).add(v.pos);
        this.particles.fire(_p, back.clone().multiplyScalar(3), 0.6);
      }
    }
    // damage smoke / fire
    if (v.health < 55) {
      _p.set(0, v.spec.colliderY + v.spec.half[1], v.spec.half[2] * 0.6).applyQuaternion(v.quat).add(v.pos);
      const k = (55 - v.health) / 55;
      if (Math.random() < k * 0.8) this.particles.smoke(_p, v.vel, k, v.health < 25 ? [0.15, 0.15, 0.15] : [0.6, 0.6, 0.62]);
      if (v.health < 20 && Math.random() < 0.4) this.particles.fire(_p, v.vel, 1);
    }

    // landing
    const grounded = groundedN > 0;
    if (!grounded) this.airPeakVel = Math.max(this.airPeakVel, -v.vel.y);
    if (grounded && !this.wasGrounded) {
      const impact = this.airPeakVel;
      if (impact > 4) {
        audio.landing(Math.min(1, impact / 20));
        g.rig.addTrauma(Math.min(0.6, impact / 30));
        for (const w of v.wheels) if (w.grounded) for (let k = 0; k < 4; k++) this.particles.dust(w.contact, v.vel, 0.8, [0.7, 0.68, 0.65]);
        g.input.rumble(Math.min(1, impact / 15), 0.3, 150);
      }
      this.airPeakVel = 0;
    }
    this.wasGrounded = grounded;
    // brake lights
    m.setBrake(v.brakeInput > 0.1 || v.handbrake, v.gear === -1);
    if (v.boosting) g.input.rumble(0.2, 0.5, 60);

    audio.update({
      rpm: v.rpm,
      redline: v.spec.redline,
      throttle: v.throttle,
      speed: v.speedAbs,
      slip: maxSlip,
      offroad: Math.min(1, offroad),
      boosting: v.boosting,
      grounded,
      timeScale: g.timeScale,
      rain: this.rain,
      biome: g.biomeWeights,
      night: g.sky.state.night,
      siren: g.sirenLevel,
      sirenDist: g.sirenDist,
      shifting: v.shiftTimer > 0,
      limiter: v.limiter,
    });
  }
}
