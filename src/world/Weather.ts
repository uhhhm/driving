// Weather state machine + precipitation rendering. Affects grip, fog, wetness, snow cover, audio.
import * as THREE from 'three';
import type { Game } from '../core/Game';
import { damp } from '../core/rng';
import { worldUniforms } from './Materials';
import { audio } from '../audio/AudioEngine';
import { bus } from '../core/events';

export type WeatherKind = 'clear' | 'cloudy' | 'fog' | 'rain' | 'storm' | 'snow';
const NAMES: Record<WeatherKind, string> = { clear: 'CLEAR', cloudy: 'OVERCAST', fog: 'FOG', rain: 'RAIN', storm: 'STORM', snow: 'SNOW' };

interface Target {
  dark: number;
  fog: number;
  rain: number;
  snow: number;
}
const TARGETS: Record<WeatherKind, Target> = {
  clear: { dark: 0, fog: 0, rain: 0, snow: 0 },
  cloudy: { dark: 0.55, fog: 0.1, rain: 0, snow: 0 },
  fog: { dark: 0.4, fog: 0.85, rain: 0, snow: 0 },
  rain: { dark: 0.7, fog: 0.35, rain: 0.8, snow: 0 },
  storm: { dark: 0.95, fog: 0.45, rain: 1, snow: 0 },
  snow: { dark: 0.6, fog: 0.5, rain: 0, snow: 1 },
};

const N_RAIN = 9000;
const N_SNOW = 6000;
const BOX = 60;

export class Weather {
  kind: WeatherKind = 'clear';
  forced: WeatherKind | null = null;
  private timer = 50;
  dark = 0;
  fog = 0;
  rain = 0;
  snow = 0;
  wet = 0; // surface wetness lags rain
  cover = 0; // snow cover lags snowfall
  private rainMesh: THREE.LineSegments;
  private snowMesh: THREE.Points;
  private rainPos: Float32Array;
  private snowPos: Float32Array;
  private lightning = 0;
  private nextBolt = 5;
  private flashLight: THREE.HemisphereLight;

  constructor(private game: Game) {
    // rain streaks
    this.rainPos = new Float32Array(N_RAIN * 6);
    for (let i = 0; i < N_RAIN; i++) {
      const x = (Math.random() - 0.5) * BOX * 2;
      const y = Math.random() * BOX;
      const z = (Math.random() - 0.5) * BOX * 2;
      this.rainPos.set([x, y, z, x, y - 0.9, z], i * 6);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.rainMesh = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xa8b8d0, transparent: true, opacity: 0.35, depthWrite: false }));
    this.rainMesh.frustumCulled = false;
    this.rainMesh.visible = false;
    game.scene.add(this.rainMesh);
    // snow flakes
    this.snowPos = new Float32Array(N_SNOW * 3);
    for (let i = 0; i < N_SNOW; i++) this.snowPos.set([(Math.random() - 0.5) * BOX * 2, Math.random() * BOX, (Math.random() - 0.5) * BOX * 2], i * 3);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.snowPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.snowMesh = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.18, transparent: true, opacity: 0.9, depthWrite: false }));
    this.snowMesh.frustumCulled = false;
    this.snowMesh.visible = false;
    game.scene.add(this.snowMesh);
    this.flashLight = new THREE.HemisphereLight(0xcfd8ff, 0x444466, 0);
    game.scene.add(this.flashLight);
  }

  get name() {
    return NAMES[this.kind];
  }

  set(k: WeatherKind) {
    if (k === this.kind) return;
    this.kind = k;
    bus.emit('toast', { text: `WEATHER: ${NAMES[k]}`, color: '#9ecbff' });
  }

  private pick() {
    const alpine = this.game.biomeWeights[1] > 0.5;
    const city = this.game.biomeWeights[2] > 0.5;
    const r = Math.random();
    let k: WeatherKind;
    if (r < 0.38) k = 'clear';
    else if (r < 0.55) k = 'cloudy';
    else if (r < 0.68) k = 'fog';
    else if (r < 0.86) k = 'rain';
    else k = 'storm';
    if (alpine && (k === 'rain' || k === 'storm')) k = 'snow';
    if (city && k === 'clear' && Math.random() < 0.5) k = 'rain'; // neon + wet streets = yes
    this.set(k);
  }

  update(dt: number) {
    if (dt <= 0) return;
    const g = this.game;
    this.timer -= dt;
    if (this.forced) this.set(this.forced);
    else if (this.timer <= 0) {
      this.timer = 70 + Math.random() * 80;
      this.pick();
    }
    // snow only where cold; rain in alpine turns into snow over time
    let k = this.kind;
    if (k === 'snow' && g.biomeWeights[0] > 0.6) k = 'cloudy';
    const t = TARGETS[k];
    const rate = 0.25;
    this.dark = damp(this.dark, t.dark, rate, dt);
    this.fog = damp(this.fog, t.fog, rate, dt);
    this.rain = damp(this.rain, t.rain, rate * 1.5, dt);
    this.snow = damp(this.snow, t.snow, rate * 1.5, dt);
    this.wet = damp(this.wet, this.rain > 0.2 ? 1 : 0, this.rain > 0.2 ? 0.15 : 0.04, dt);
    this.cover = damp(this.cover, this.snow > 0.3 ? 1 : g.biomeWeights[1] > 0.6 && g.player.vehicle.pos.y > 110 ? 0.6 : 0, this.snow > 0.3 ? 0.06 : 0.03, dt);

    g.sky.weatherDark = this.dark;
    g.sky.weatherFog = this.fog * 0.8;
    worldUniforms.uWet.value = this.wet;
    worldUniforms.uSnow.value = this.cover;
    g.weatherGrip = 1 - this.wet * 0.2 - this.cover * 0.28;
    g.iceRoads = this.cover * 0.7;
    g.weatherWet = this.wet;
    g.vfx && (g.vfx.rain = this.rain);

    // precipitation follows the camera
    const cam = g.rig.camera.position;
    const v = g.player.vehicle.vel;
    this.rainMesh.visible = this.rain > 0.02;
    this.snowMesh.visible = this.snow > 0.02;
    if (this.rainMesh.visible) {
      const p = this.rainPos;
      const n = Math.floor(N_RAIN * Math.min(1, this.rain));
      (this.rainMesh.material as THREE.LineBasicMaterial).opacity = 0.18 + this.rain * 0.25;
      const fall = 28 * dt;
      const sx = -v.x * 0.04, sz = -v.z * 0.04; // streak tilt from motion
      for (let i = 0; i < N_RAIN; i++) {
        const o = i * 6;
        if (i >= n) {
          p[o + 1] = p[o + 4] = -1000;
          continue;
        }
        let y = p[o + 1] - fall;
        let x = p[o];
        let z = p[o + 2];
        if (y < cam.y - 20 || y < -900) {
          y = cam.y + BOX * 0.6 + Math.random() * 10;
          x = cam.x + (Math.random() - 0.5) * BOX * 2;
          z = cam.z + (Math.random() - 0.5) * BOX * 2;
        }
        // wrap horizontally around camera
        if (x - cam.x > BOX) x -= BOX * 2;
        else if (x - cam.x < -BOX) x += BOX * 2;
        if (z - cam.z > BOX) z -= BOX * 2;
        else if (z - cam.z < -BOX) z += BOX * 2;
        p[o] = x;
        p[o + 1] = y;
        p[o + 2] = z;
        p[o + 3] = x + sx;
        p[o + 4] = y + 1.1;
        p[o + 5] = z + sz;
      }
      this.rainMesh.geometry.attributes.position.needsUpdate = true;
      // splashes near the car
      if (Math.random() < this.rain * 0.8) {
        const sp = g.player.vehicle.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 30, 0, (Math.random() - 0.5) * 30));
        sp.y = g.chunks.heightAt(sp.x, sp.z) + 0.05;
        g.particles?.splash(sp, 2);
      }
    }
    if (this.snowMesh.visible) {
      const p = this.snowPos;
      const time = g.simTime;
      for (let i = 0; i < N_SNOW; i++) {
        const o = i * 3;
        let x = p[o] + Math.sin(time * 0.8 + i) * 0.6 * dt;
        let y = p[o + 1] - 2.2 * dt;
        let z = p[o + 2] + Math.cos(time * 0.7 + i * 1.3) * 0.6 * dt;
        if (y < cam.y - 15) y = cam.y + BOX * 0.5;
        if (x - cam.x > BOX) x -= BOX * 2;
        else if (x - cam.x < -BOX) x += BOX * 2;
        if (z - cam.z > BOX) z -= BOX * 2;
        else if (z - cam.z < -BOX) z += BOX * 2;
        p[o] = x;
        p[o + 1] = y;
        p[o + 2] = z;
      }
      (this.snowMesh.material as THREE.PointsMaterial).opacity = this.snow;
      this.snowMesh.geometry.attributes.position.needsUpdate = true;
    }
    // lightning
    if (this.kind === 'storm' && this.rain > 0.6) {
      this.nextBolt -= dt;
      if (this.nextBolt <= 0) {
        this.nextBolt = 6 + Math.random() * 14;
        this.lightning = 1;
        const delay = 300 + Math.random() * 2500;
        setTimeout(() => audio.thunder(), delay);
      }
    }
    this.lightning = Math.max(0, this.lightning - dt * 3);
    const flick = this.lightning > 0 ? this.lightning * (0.6 + 0.4 * Math.sin(g.simTime * 80)) : 0;
    this.flashLight.intensity = flick * 6;
    if (flick > 0.5) g.postfx?.flashColor(0.15, 0.17, 0.25);
  }
}
