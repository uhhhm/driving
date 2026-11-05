// Score & combo system. Tricks feed a pending pot × multiplier that banks after a calm period.
import * as THREE from 'three';
import type { Game } from '../core/Game';
import { bus } from '../core/events';
import { audio } from '../audio/AudioEngine';

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

export interface ComboView {
  pot: number;
  mult: number;
  timer: number; // 0..1 remaining
  label: string;
  live: number; // in-progress trick points (drift / air)
}

export class Score {
  total = 0; // banked this session
  best = 0;
  pot = 0;
  mult = 1;
  private multProgress = 0;
  private calm = 0;
  readonly bankDelay = 2.6;
  // live tricks
  driftPts = 0;
  private driftTime = 0;
  airPts = 0;
  private airTime = 0;
  private spinAcc = new THREE.Vector3(); // local axis rotation accumulators
  private prevQuat = new THREE.Quaternion();
  private wasAir = false;
  private speedPts = 0;
  private smashChain = 0;
  label = '';
  stats = { drifts: 0, nearMisses: 0, maxAir: 0, flips: 0, smashed: 0, takedowns: 0, topSpeed: 0, distance: 0 };
  onBank: ((pts: number) => void) | null = null;

  constructor(private game: Game) {
    bus.on('nearMiss', (e) => {
      const close = Math.max(0, 1.5 - e.dist) / 1.5; // 0..1
      const pts = Math.round((250 + e.speed * 8) * (1 + close * 2));
      this.stats.nearMisses++;
      this.award(close > 0.75 ? 'INSANE NEAR MISS' : close > 0.4 ? 'CLOSE CALL' : 'NEAR MISS', pts, '#4dfff0', 1);
      game.slowMo(0.55, 0.18);
    });
    bus.on('smash', (e) => {
      this.stats.smashed++;
      this.smashChain++;
      this.award(e.kind, e.points, '#ffb02e', this.smashChain % 4 === 0 ? 1 : 0.25);
    });
    bus.on('trick', (e) => {
      if (e.name.includes('TAKEDOWN')) this.stats.takedowns++;
      this.award(e.name, e.points, e.color ?? '#ff4d2e', 1);
    });
    bus.on('crash', (e) => {
      if (e.impulse > 14 && !e.withTraffic) this.lose();
    });
    bus.on('wrecked', () => this.lose());
    bus.on('reset', () => this.lose());
    bus.on('explode', () => this.award('KABOOM', 400, '#ff6a00', 1));
  }

  /** Add points to the pot. multInc adds to multiplier progress. */
  award(name: string, pts: number, color: string, multInc: number) {
    this.pot += pts;
    this.calm = 0;
    this.multProgress += multInc;
    while (this.multProgress >= 1 && this.mult < 10) {
      this.multProgress -= 1;
      this.mult++;
      audio.ping(this.mult);
    }
    this.label = name;
    this.game.player.vehicle.boost = Math.min(this.game.player.vehicle.spec.boostCapacity, this.game.player.vehicle.boost + pts / 2500);
    this.onTrick?.(name, pts, color);
  }
  onTrick: ((name: string, pts: number, color: string) => void) | null = null;

  lose() {
    if (this.pot + this.driftPts + this.airPts > 0) {
      bus.emit('comboLost', { points: Math.round((this.pot + this.driftPts) * this.mult) });
      audio.fail();
    }
    this.pot = 0;
    this.driftPts = 0;
    this.airPts = 0;
    this.mult = 1;
    this.multProgress = 0;
    this.smashChain = 0;
    this.spinAcc.set(0, 0, 0);
  }

  bank() {
    const pts = Math.round(this.pot * this.mult);
    if (pts > 0) {
      this.total += pts;
      bus.emit('bank', { points: pts, multiplier: this.mult });
      audio.chime(pts > 20000);
      this.onBank?.(pts);
    }
    this.pot = 0;
    this.mult = 1;
    this.multProgress = 0;
    this.smashChain = 0;
  }

  update(dt: number) {
    if (dt <= 0) return;
    const v = this.game.player.vehicle;
    this.stats.topSpeed = Math.max(this.stats.topSpeed, v.kmh);
    this.stats.distance += v.speedAbs * dt;
    // ---- drift ----
    if (v.drifting && v.speedAbs > 9) {
      const ang = Math.min(1.2, Math.abs(v.slipAngleBody));
      this.driftPts += ang * v.speedAbs * 9 * dt;
      this.driftTime += dt;
      this.calm = 0;
    } else if (this.driftPts > 0 && !v.drifting) {
      if (this.driftTime > 0.6) {
        this.stats.drifts++;
        const pts = Math.round(this.driftPts);
        this.award(pts > 4000 ? 'MEGA DRIFT' : pts > 1500 ? 'GREAT DRIFT' : 'DRIFT', pts, '#ff3df2', Math.min(2, 0.5 + this.driftTime / 3));
      }
      this.driftPts = 0;
      this.driftTime = 0;
    }
    // ---- air & flips ----
    const air = v.groundedCount === 0 && v.airTime > 0.15;
    if (air) {
      if (!this.wasAir) {
        this.spinAcc.set(0, 0, 0);
        this.prevQuat.copy(v.quat);
        this.airPts = 0;
        this.airTime = 0;
      }
      this.airTime += dt;
      if (this.airTime > 0.45) this.airPts += 260 * dt * (1 + this.airTime);
      // accumulate rotation in the car's local frame
      _q.copy(this.prevQuat).invert().multiply(v.quat);
      const angle = 2 * Math.acos(Math.min(1, Math.abs(_q.w)));
      if (angle > 1e-4) {
        _v.set(_q.x, _q.y, _q.z).normalize().multiplyScalar(angle * Math.sign(_q.w || 1));
        this.spinAcc.add(_v);
      }
      this.prevQuat.copy(v.quat);
      this.calm = 0;
    } else if (this.wasAir) {
      // landed
      const upright = v.up.y > 0.6;
      this.stats.maxAir = Math.max(this.stats.maxAir, this.airTime);
      if (upright && this.airTime > 0.5) {
        const flipsP = Math.floor(Math.abs(this.spinAcc.x) / (Math.PI * 2) + 0.15);
        const rolls = Math.floor(Math.abs(this.spinAcc.z) / (Math.PI * 2) + 0.15);
        const spins = Math.floor(Math.abs(this.spinAcc.y) / (Math.PI * 2) + 0.2);
        let name = this.airTime > 2.2 ? 'HUGE AIR' : this.airTime > 1.2 ? 'BIG AIR' : 'AIR';
        let pts = Math.round(this.airPts);
        let inc = Math.min(2, this.airTime);
        const parts: string[] = [];
        if (flipsP > 0) parts.push(`${flipsP > 1 ? flipsP + 'x ' : ''}${this.spinAcc.x > 0 ? 'FRONTFLIP' : 'BACKFLIP'}`);
        if (rolls > 0) parts.push(`${rolls > 1 ? rolls + 'x ' : ''}BARREL ROLL`);
        if (spins > 0) parts.push(`${spins * 360} SPIN`);
        const tricks = flipsP + rolls + spins;
        if (tricks > 0) {
          name = parts.join(' + ');
          pts += tricks * 2500;
          inc += tricks;
          this.stats.flips += tricks;
          this.game.slowMo(0.4, 0.35);
        }
        // clean landing bonus
        const lv = v.angVel.length();
        if (lv < 1.5 && this.airTime > 0.9) {
          name += ' · CLEAN';
          pts = Math.round(pts * 1.25);
        }
        if (this.airTime > 0.5) this.award(name, pts, tricks ? '#7dff3d' : '#5ab0ff', inc);
      } else if (!upright && this.airTime > 0.5) {
        this.lose();
      }
      this.airPts = 0;
      this.airTime = 0;
    }
    this.wasAir = air;
    // ---- speed ----
    if (v.kmh > 200 && v.groundedCount > 0) {
      this.speedPts += (v.kmh - 180) * dt * 3;
      this.calm = Math.min(this.calm, this.bankDelay * 0.5);
      if (this.speedPts > 600) {
        this.award(v.kmh > 280 ? 'LUDICROUS SPEED' : 'SPEED DEMON', Math.round(this.speedPts), '#ffe14d', 0.5);
        this.speedPts = 0;
      }
    }
    // ---- bank timer ----
    if (this.pot > 0) {
      this.calm += dt;
      if (this.calm > this.bankDelay) this.bank();
    }
  }

  get view(): ComboView {
    return {
      pot: Math.round(this.pot),
      mult: this.mult,
      timer: this.pot > 0 ? 1 - this.calm / this.bankDelay : 0,
      label: this.label,
      live: Math.round(this.driftPts + this.airPts),
    };
  }
}
