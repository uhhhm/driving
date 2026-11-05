// Headless handling benchmark + "still feels good" guardrails for every car.
//
//   npx tsx scripts/handling.ts            print the table
//   npx tsx scripts/handling.ts --check    also enforce guardrails + personality ordering (exit 1 on failure)
//   npx tsx scripts/handling.ts --json     machine-readable metrics
//   npx tsx scripts/handling.ts --write    regenerate src/vehicle/HandlingStats.ts (garage stat bars)
//
// Runs the real Vehicle + Rapier step on flat test pads (no rendering, no world gen), with the
// same keyboard steering ramp / speed-sensitive lock as Input.poll, so numbers match what a
// keyboard player gets.
import * as THREE from 'three';
import { readFileSync, writeFileSync } from 'node:fs';
import { Physics, RAPIER, G_WORLD, groups } from '../src/core/Physics';
import { Vehicle } from '../src/vehicle/Vehicle';
import { CARS, applyUpgrades, type CarSpec } from '../src/vehicle/VehicleDefs';
import type { Controls } from '../src/core/Input';
import { Surface } from '../src/world/types';

const DT = 1 / 120;
// Vehicle uses performance.now() for surface bumps and the rev-limiter wobble; drive it from
// simulated time so every run is bit-for-bit repeatable.
let simMs = 0;
performance.now = () => simMs;
const G = 9.81; // report lateral accel in real g, not the game's 1.6x arcade gravity
const kmh = (v: Vehicle) => v.speed * 3.6;

type Pad = 'asphalt' | 'grass';
interface Ctl {
  throttle?: number;
  brake?: number;
  /** keyboard-style steer target -1..1 (right positive); smoothed like Input.poll */
  steer?: number;
  handbrake?: boolean;
  boost?: boolean;
  /** analog stick: no keyboard ramp, gamepad's softer speed limit */
  pad?: boolean;
}

class Rig {
  phys = new Physics();
  v!: Vehicle;
  t = 0;
  private steerSmooth = 0;
  env = { weatherGrip: 1, iceRoads: 0 };
  /** weather as Weather.update sets it: rain = wet 1, snow = cover 1 */
  async init(spec: CarSpec, pad: Pad, speedKmh = 0, weather: 'dry' | 'rain' | 'snow' = 'dry') {
    if (weather === 'rain') this.env = { weatherGrip: 0.8, iceRoads: 0 };
    if (weather === 'snow') this.env = { weatherGrip: 1 - 0.2 - 0.28, iceRoads: 0.7 };
    await this.phys.init();
    const c = this.phys.world.createCollider(
      RAPIER.ColliderDesc.cuboid(6000, 1, 6000).setTranslation(0, -1, 0).setFriction(0.6).setCollisionGroups(groups(G_WORLD, 0xffff)),
    );
    // road colliders resolve to asphalt; terrain without a chunk resolves to grass (Vehicle.surfaceOf)
    this.phys.tag(c, pad === 'asphalt' ? { kind: 'road' } : { kind: 'terrain', chunk: { surfaceAt: () => Surface.Grass } });
    this.v = new Vehicle(this.phys, spec, new THREE.Vector3(0, 1.2, -5000), 0);
    this.v.boost = 1e9;
    this.run(0.6, {}); // settle on the springs
    if (speedKmh > 0) {
      const p = this.v.pos.clone();
      this.v.teleport(p, 0, speedKmh / 3.6);
      this.run(0.25, { throttle: 0.4 });
    }
    return this;
  }
  /** Same shape as Input.poll: keyboard ramps in; both get a speed-sensitive lock (softer on a pad). */
  private steer(target: number, pad: boolean) {
    const k = 1 - Math.min(0.55, Math.max(0, (this.v.kmh - 40) / 260)) * (pad ? 0.6 : 1);
    if (pad) {
      this.steerSmooth = target;
      return target * k;
    }
    const rate = target === 0 ? 7 : Math.sign(target) !== Math.sign(this.steerSmooth) ? 9 : 4.2;
    const d = target - this.steerSmooth;
    this.steerSmooth += Math.sign(d) * Math.min(Math.abs(d), rate * DT);
    return this.steerSmooth * k;
  }
  run(seconds: number, ctl: Ctl | ((t: number, v: Vehicle) => Ctl), sample?: (t: number, v: Vehicle) => boolean | void) {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      const c = typeof ctl === 'function' ? ctl(i * DT, this.v) : ctl;
      const controls: Controls = {
        throttle: c.throttle ?? 0,
        brake: c.brake ?? 0,
        steer: this.steer(c.steer ?? 0, !!c.pad),
        handbrake: !!c.handbrake,
        boost: !!c.boost,
        lookBack: false,
        reset: false,
        camera: false,
        pause: false,
        photo: false,
        horn: false,
      };
      simMs += DT * 1000;
      this.v.step(DT, controls, this.env);
      this.phys.world.step(this.phys.events);
      this.v.syncState();
      this.t += DT;
      if (sample && sample(i * DT, this.v) === true) return i * DT;
    }
    return seconds;
  }
}

const yawRate = (v: Vehicle) => v.angVel.dot(v.up);
const rollDeg = (v: Vehicle) => {
  const side = new THREE.Vector3(1, 0, 0).applyQuaternion(v.quat);
  return Math.abs(Math.asin(THREE.MathUtils.clamp(side.y, -1, 1))) * 57.3;
};
const spun = (v: Vehicle) => Math.abs(v.slipAngleBody) > 1.3 || (v.speed < -1 && v.speedAbs > 3);

export interface Metrics {
  t60: number;
  t100: number;
  t160: number;
  roll80to160: number;
  top: number; // km/h after 40 s
  brake100: number; // m
  latG70: number; // steady skidpad at 70 km/h
  latG140: number;
  turnIn: number; // s to 90% of steady yaw rate at 90 km/h
  slalomBeta: number; // deg, max body slip in a 120 km/h keyboard slalom
  slalomSpin: boolean;
  driftHold: number; // fraction of time drifting after a handbrake entry, steering into the turn
  driftBeta: number; // mean drift angle (deg)
  driftMaxBeta: number;
  driftKeep: number; // speed retained over the 3 s slide
  driftSpin: boolean;
  driftNeutral: number; // hold fraction when letting go of the steering mid-drift
  driftExit: number; // s from counter-steer until the slide is over
  padDriftHold: number; // gamepad: worst of full/half stick into the turn, entered at 70 and 100 km/h
  padDriftMaxBeta: number;
  padDriftSpin: boolean;
  flickRolled: boolean; // abuse: full gamepad lock at 150 km/h
  maxedSafe: boolean; // fully upgraded: still no roll / spin in skidpad, slalom, abuse
  wetDriftHold: number; // worst of rain / snow, gamepad full stick at 90
  wetDriftSpin: boolean;
  snowSlalomSpin: boolean;
  maxRoll: number; // deg, worst body roll across the cornering tests
  rolled: boolean;
  grassT100: number;
  grassTop: number;
  grassLatG: number;
  boostTop: number; // km/h after 8 s of throttle + boost from 100
}

async function measure(spec: CarSpec): Promise<Metrics> {
  const m = {} as Metrics;
  let maxRoll = 0;
  let rolled = false;
  const trackRoll = (v: Vehicle) => {
    maxRoll = Math.max(maxRoll, rollDeg(v));
    if (v.up.y < 0.3) rolled = true;
  };

  // --- straight line ---
  {
    const r = await new Rig().init(spec, 'asphalt');
    m.t60 = m.t100 = m.t160 = NaN;
    let t80 = NaN;
    r.run(40, { throttle: 1 }, (t, v) => {
      const k = kmh(v);
      if (isNaN(m.t60) && k >= 60) m.t60 = t;
      if (isNaN(t80) && k >= 80) t80 = t;
      if (isNaN(m.t100) && k >= 100) m.t100 = t;
      if (isNaN(m.t160) && k >= 160) m.t160 = t;
    });
    m.roll80to160 = m.t160 - t80;
    m.top = r.v.kmh;
  }
  {
    const r = await new Rig().init(spec, 'asphalt', 100);
    const p0 = r.v.pos.clone();
    r.run(10, { brake: 1 }, (_t, v) => v.speedAbs < 0.3);
    m.brake100 = Math.hypot(r.v.pos.x - p0.x, r.v.pos.z - p0.z);
  }
  // --- steady cornering (speed held with a simple throttle controller) ---
  const skidpad = async (pad: Pad, target: number) => {
    const r = await new Rig().init(spec, pad, target);
    let acc = 0;
    let n = 0;
    r.run(5, (_t, v) => ({ steer: 1, throttle: Math.max(0, Math.min(1, (target - v.kmh) * 0.15 + 0.35)) }), (t, v) => {
      trackRoll(v);
      if (t > 2.5) {
        acc += Math.abs(yawRate(v)) * v.speedAbs;
        n++;
      }
    });
    return acc / n / G;
  };
  m.latG70 = await skidpad('asphalt', 70);
  m.latG140 = await skidpad('asphalt', 140);
  m.grassLatG = await skidpad('grass', 60);
  // --- turn-in response ---
  {
    const r = await new Rig().init(spec, 'asphalt', 90);
    const yaws: number[] = [];
    r.run(2.5, (_t, v) => ({ steer: 0.6, throttle: Math.max(0, Math.min(1, (90 - v.kmh) * 0.15 + 0.35)) }), (_t, v) => {
      yaws.push(Math.abs(yawRate(v)));
    });
    const steady = yaws.slice(-60).reduce((a, b) => a + b, 0) / 60;
    m.turnIn = yaws.findIndex((y) => y >= steady * 0.9) * DT;
  }
  // --- slalom (keyboard flicks at highway speed): must never spin ---
  {
    const r = await new Rig().init(spec, 'asphalt', 120);
    let maxB = 0;
    let s = false;
    r.run(6, (t) => ({ throttle: 0.7, steer: Math.floor(t / 0.7) % 2 ? 1 : -1 }), (_t, v) => {
      maxB = Math.max(maxB, Math.abs(v.slipAngleBody));
      if (spun(v)) s = true;
      trackRoll(v);
    });
    m.slalomBeta = maxB * 57.3;
    m.slalomSpin = s;
  }
  // --- drifting: handbrake flick at 70, then three ways of holding it ---
  const drift = async (after: Ctl, entryKmh = 70, weather: 'dry' | 'rain' | 'snow' = 'dry') => {
    const r = await new Rig().init(spec, 'asphalt', entryKmh, weather);
    const v0 = r.v.speedAbs;
    let n = 0, on = 0, sumB = 0, maxB = 0, s = false;
    r.run(3.4, (t) => (t < 0.35 ? { throttle: 1, steer: 1, handbrake: true } : after), (t, v) => {
      trackRoll(v);
      if (spun(v)) s = true;
      if (t < 0.5) return;
      n++;
      if (v.drifting) {
        on++;
        sumB += Math.abs(v.slipAngleBody);
      }
      maxB = Math.max(maxB, Math.abs(v.slipAngleBody));
    });
    return { r, hold: on / n, beta: (on ? sumB / on : 0) * 57.3, maxB: maxB * 57.3, keep: r.v.speedAbs / v0, spin: s };
  };
  {
    const d = await drift({ throttle: 1, steer: 1 });
    m.driftHold = d.hold;
    m.driftBeta = d.beta;
    m.driftMaxBeta = d.maxB;
    m.driftKeep = d.keep;
    m.driftSpin = d.spin;
    const nd = await drift({ throttle: 1, steer: 0 });
    m.driftNeutral = nd.hold;
    m.driftSpin ||= nd.spin;
    // exit: from a held drift, counter-steer and time how long until the car is driving straight again
    const ex = nd.r;
    if (!ex.v.driftMode) m.driftExit = 0;
    else {
      const t = ex.run(3, { throttle: 0.6, steer: -0.8 }, (_t, v) => !v.driftMode);
      m.driftExit = ex.v.driftMode ? Infinity : t;
      if (spun(ex.v)) m.driftSpin = true;
    }
  }
  // gamepad drifts: instant full / half stick (no keyboard ramp to soften the flick)
  {
    let hold = 1, maxB = 0, s = false;
    for (const [st, entry] of [[1, 70], [0.5, 70], [1, 100], [0.5, 100]]) {
      const d = await drift({ throttle: 1, steer: st, pad: true }, entry);
      hold = Math.min(hold, d.hold);
      maxB = Math.max(maxB, d.maxB);
      s ||= d.spin;
    }
    m.padDriftHold = hold;
    m.padDriftMaxBeta = maxB;
    m.padDriftSpin = s;
  }
  // bad weather: slides must stay catchable on wet and snowy roads
  {
    let hold = 1, s = false;
    for (const w of ['rain', 'snow'] as const) {
      const d = await drift({ throttle: 1, steer: 1, pad: true }, 90, w);
      hold = Math.min(hold, d.hold);
      s ||= d.spin;
    }
    m.wetDriftHold = hold;
    m.wetDriftSpin = s;
    const r = await new Rig().init(spec, 'asphalt', 100, 'snow');
    let sp = false;
    r.run(6, (t) => ({ throttle: 0.7, steer: Math.floor(t / 0.7) % 2 ? 1 : -1 }), (_t, v) => {
      if (spun(v)) sp = true;
    });
    m.snowSlalomSpin = sp;
  }
  // abuse: full stick lock at 150 km/h and hold it (only the top-heavy van is allowed to tip)
  {
    const r = await new Rig().init(spec, 'asphalt', 150);
    let fell = false;
    r.run(3, { throttle: 0.6, steer: 1, pad: true }, (_t, v) => {
      if (v.up.y < 0.3) fell = true;
    });
    m.flickRolled = fell;
  }
  // --- off-road ---
  {
    const r = await new Rig().init(spec, 'grass');
    m.grassT100 = NaN;
    r.run(30, { throttle: 1 }, (t, v) => {
      if (isNaN(m.grassT100) && kmh(v) >= 100) m.grassT100 = t;
    });
    m.grassTop = r.v.kmh;
  }
  // --- boost ---
  {
    const r = await new Rig().init(spec, 'asphalt', 100);
    r.run(8, { throttle: 1, boost: true });
    m.boostTop = r.v.kmh;
  }
  m.maxRoll = maxRoll;
  m.rolled = rolled;
  m.maxedSafe = await maxedSafe(spec);
  return m;
}

/** Upgrades add grip and power; make sure a maxed-out car doesn't fall off the rollover cliff. */
async function maxedSafe(base: CarSpec) {
  const spec = applyUpgrades(base, { engine: 3, grip: 3, boost: 3, armor: 3 });
  let ok = true;
  const watch = (_t: number, v: Vehicle) => {
    if (v.up.y < 0.3 || spun(v)) {
      if (ok && process.env.WHY) console.error(`${base.id} maxed: ${v.up.y < 0.3 ? 'rolled' : 'spun'} at ${v.kmh.toFixed(0)} km/h`);
      ok = false;
    }
  };
  for (const [kmhTarget, pad] of [[140, false], [150, true]] as const) {
    const r = await new Rig().init(spec, 'asphalt', kmhTarget);
    r.run(4, (_t, v) => ({ steer: 1, pad, throttle: Math.max(0, Math.min(1, (kmhTarget - v.kmh) * 0.15 + 0.35)) }), watch);
  }
  const r = await new Rig().init(spec, 'asphalt', 120);
  r.run(6, (t) => ({ throttle: 0.7, steer: Math.floor(t / 0.7) % 2 ? 1 : -1 }), watch);
  return ok;
}

// ---------------------------------------------------------------------------------------------
// Guardrails: every car must stay fun to drive, whatever its personality.
const GUARD: [string, (m: Metrics) => boolean][] = [
  ['0-100 between 1.7 and 6.0 s', (m) => m.t100 >= 1.7 && m.t100 <= 6.0],
  ['top speed >= 170 km/h', (m) => m.top >= 170],
  ['100-0 brake <= 45 m', (m) => m.brake100 <= 45],
  ['skidpad 70 >= 0.75 g', (m) => m.latG70 >= 0.75],
  ['turn-in <= 0.75 s', (m) => m.turnIn <= 0.75],
  ['no spin in the 120 km/h slalom', (m) => !m.slalomSpin],
  ['slalom slip <= 25 deg', (m) => m.slalomBeta <= 25],
  ['drift holds >= 85% steering in', (m) => m.driftHold >= 0.85],
  ['drift holds >= 75% hands-off', (m) => m.driftNeutral >= 0.75],
  ['drift never spins out', (m) => !m.driftSpin],
  ['drift angle 22-60 deg', (m) => m.driftBeta >= 22 && m.driftBeta <= 60],
  ['drift keeps >= 70% speed', (m) => m.driftKeep >= 0.7],
  ['counter-steer exits within 1.2 s', (m) => m.driftExit <= 1.2],
  ['never rolls in the handling tests', (m) => !m.rolled && !m.flickRolled],
  ['fully upgraded: still never rolls or spins', (m) => m.maxedSafe],
  ['gamepad drift holds >= 80%', (m) => m.padDriftHold >= 0.8],
  ['gamepad drift never spins out', (m) => !m.padDriftSpin && m.padDriftMaxBeta <= 70],
  ['rain/snow drift holds >= 70% and never spins', (m) => m.wetDriftHold >= 0.7 && !m.wetDriftSpin],
  ['no spin in a 100 km/h snow slalom', (m) => !m.snowSlalomSpin],
  ['grass 0-100 <= 9 s', (m) => m.grassT100 <= 9],
];

// Personality: who should beat whom. Keeps the roster from collapsing back into six skins.
const ORDER: [string, (r: Record<string, Metrics>) => boolean][] = [
  ['Bulldozer out-drags Kitsune (80-160)', (r) => r.bulldozer.roll80to160 < r.kitsune.roll80to160 * 0.85],
  ['Bulldozer has a higher top speed than Kitsune', (r) => r.bulldozer.top > r.kitsune.top + 10],
  ['Bulldozer slides at a bigger angle than Kitsune', (r) => r.bulldozer.driftBeta > r.kitsune.driftBeta],
  ['Bulldozer turns in lazier than Kitsune', (r) => r.bulldozer.turnIn > r.kitsune.turnIn],
  ['Kitsune is the easiest drifter of the RWD/FWD cars (hands-off hold)', (r) => r.kitsune.driftNeutral >= Math.max(r.bulldozer.driftNeutral, r.tacovan.driftNeutral)],
  ['Kitsune corners harder than Bulldozer at 70', (r) => r.kitsune.latG70 > r.bulldozer.latG70],
  ['Mule loses the least acceleration on grass', (r) => Object.values(r).every((m) => m.grassT100 / m.t100 >= r.mule.grassT100 / r.mule.t100 - 1e-6)],
  ['Mule keeps the most of its top speed on grass', (r) => Object.values(r).every((m) => m.grassTop / m.top <= r.mule.grassTop / r.mule.top + 1e-6)],
  ['Mule has the most grip on grass', (r) => Object.values(r).every((m) => m.grassLatG <= r.mule.grassLatG + 1e-6)],
  ['Bolt loses the most grip on grass', (r) => Object.values(r).every((m) => m.grassLatG / m.latG70 >= r.bolt.grassLatG / r.bolt.latG70 - 1e-6)],
  ['Mule is slower than Kitsune on asphalt (0-100)', (r) => r.mule.t100 > r.kitsune.t100],
  ['Taco Van leans the most', (r) => Object.values(r).every((m) => m.maxRoll <= r.tacovan.maxRoll + 1e-6)],
  ['Taco Van is the slowest off the line', (r) => Object.values(r).every((m) => m.t100 <= r.tacovan.t100 + 1e-6)],
  ['Couch has the biggest boost', (r) => Object.values(r).every((m) => m.boostTop - m.top <= r.couch.boostTop - r.couch.top + 1e-6)],
  ['Couch is slow without boost', (r) => r.couch.top < r.kitsune.top],
  ['Bolt is quickest 0-100', (r) => Object.values(r).every((m) => m.t100 >= r.bolt.t100)],
  ['Bolt has the highest top speed', (r) => Object.values(r).every((m) => m.top <= r.bolt.top)],
  ['Bolt corners hardest at 140', (r) => Object.values(r).every((m) => m.latG140 <= r.bolt.latG140)],
];

// ---------------------------------------------------------------------------------------------
// Garage stat bars, derived from the measurements (relative to the roster, 0.15..1).
const STATS_FILE = new URL('../src/vehicle/HandlingStats.ts', import.meta.url);
function statsSource(r: Record<string, Metrics>) {
  const ids = Object.keys(r);
  const norm = (fn: (m: Metrics) => number) => {
    const xs = ids.map((id) => fn(r[id]));
    const lo = Math.min(...xs), hi = Math.max(...xs);
    return Object.fromEntries(ids.map((id, i) => [id, 0.15 + (0.85 * (xs[i] - lo)) / (hi - lo || 1)]));
  };
  const mix = (...parts: Record<string, number>[]) => Object.fromEntries(ids.map((id) => [id, parts.reduce((a, p) => a + p[id], 0) / parts.length]));
  const bars = {
    ACCEL: mix(norm((m) => 1 / m.t100), norm((m) => 1 / m.roll80to160)),
    SPEED: norm((m) => m.top),
    GRIP: mix(norm((m) => m.latG70), norm((m) => m.latG140)),
    DRIFT: norm((m) => m.driftBeta),
    OFFROAD: mix(norm((m) => m.grassLatG / m.latG70), norm((m) => m.grassTop / m.top), norm((m) => m.t100 / m.grassT100)),
    BOOST: norm((m) => m.boostTop - m.top),
  };
  const lines = ids.map((id) => {
    const kv = Object.entries(bars).map(([k, v]) => `${k}: ${v[id].toFixed(2)}`).join(', ');
    return `  ${id}: { ${kv} },`;
  });
  return `// Generated by \`npx tsx scripts/handling.ts --write\` from measured handling (do not edit by hand).
// Bars are relative to the roster: 1 = best car at that, 0.15 = worst.
export type HandlingStat = 'ACCEL' | 'SPEED' | 'GRIP' | 'DRIFT' | 'OFFROAD' | 'BOOST';
export const HANDLING_STATS: Record<string, Record<HandlingStat, number>> = {
${lines.join('\n')}
};
`;
}

const f = (x: number, d = 1) => (isFinite(x) ? x.toFixed(d) : ' -- ');

async function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  // quick tuning without editing VehicleDefs: --set mule.torque=800 --set bolt.slide=0.7
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--set') continue;
    const [lhs, val] = argv[++i].split('=');
    const [id, key] = lhs.split('.');
    const car = CARS.find((c) => c.id === id) as unknown as Record<string, unknown>;
    if (!car || !(key in car)) throw new Error(`unknown --set target ${lhs}`);
    car[key] = val.includes(',') ? val.split(',').map(Number) : isNaN(Number(val)) ? val : Number(val);
  }
  const only = argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
  const res: Record<string, Metrics> = {};
  for (const c of CARS) if (!only || only.includes(c.id)) res[c.id] = await measure(c);
  if (args.has('--json')) {
    console.log(JSON.stringify(res, null, 1));
    return;
  }
  const cols: [string, (m: Metrics) => string][] = [
    ['0-100', (m) => f(m.t100, 2)],
    ['80-160', (m) => f(m.roll80to160, 2)],
    ['top', (m) => f(m.top, 0)],
    ['brake', (m) => f(m.brake100, 1)],
    ['g@70', (m) => f(m.latG70, 2)],
    ['g@140', (m) => f(m.latG140, 2)],
    ['turnIn', (m) => f(m.turnIn, 2)],
    ['slalom', (m) => f(m.slalomBeta, 0) + (m.slalomSpin ? '!' : '')],
    ['drift%', (m) => f(m.driftHold * 100, 0)],
    ['free%', (m) => f(m.driftNeutral * 100, 0)],
    ['angle', (m) => f(m.driftBeta, 0) + '/' + f(m.driftMaxBeta, 0) + (m.driftSpin ? '!' : '')],
    ['keep', (m) => f(m.driftKeep * 100, 0)],
    ['exit', (m) => f(m.driftExit, 2)],
    ['pad%', (m) => f(m.padDriftHold * 100, 0) + '/' + f(m.padDriftMaxBeta, 0) + (m.padDriftSpin ? '!' : '')],
    ['abuse', (m) => (m.flickRolled ? 'ROLL' : 'ok') + (m.maxedSafe ? '' : '/U')],
    ['wet%', (m) => f(m.wetDriftHold * 100, 0) + (m.wetDriftSpin ? '!' : '') + (m.snowSlalomSpin ? 'S' : '')],
    ['roll', (m) => f(m.maxRoll, 0) + (m.rolled ? '!' : '')],
    ['g0-100', (m) => f(m.grassT100, 1)],
    ['gTop', (m) => f(m.grassTop, 0)],
    ['g@60', (m) => f(m.grassLatG, 2)],
    ['boost', (m) => f(m.boostTop, 0)],
  ];
  const w = 10;
  console.log('car'.padEnd(w) + cols.map(([h]) => h.padStart(8)).join(''));
  for (const id of Object.keys(res)) console.log(id.padEnd(w) + cols.map(([, fn]) => fn(res[id]).padStart(8)).join(''));
  console.log(
    '\n0-100/80-160 s · top km/h · brake 100-0 m · lateral g (skidpad) · turn-in s · slalom max slip deg · drift: hold % steering in / hands-off, mean/max angle, % speed kept, counter-steer exit s · max body roll deg · grass 0-100 s / top / lateral g · boost km/h after 8 s',
  );
  const src = statsSource(res);
  if (args.has('--write') && !only) {
    writeFileSync(STATS_FILE, src);
    console.log('\nwrote src/vehicle/HandlingStats.ts');
  }
  if (!args.has('--check') || only) return;
  let fails = 0;
  console.log('\nGuardrails');
  for (const c of CARS)
    for (const [name, ok] of GUARD)
      if (!ok(res[c.id])) {
        fails++;
        console.log(`  FAIL ${c.id}: ${name}`);
      }
  console.log('Personality');
  for (const [name, ok] of ORDER) {
    const pass = ok(res);
    if (!pass) fails++;
    console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}`);
  }
  let current = '';
  try {
    current = readFileSync(STATS_FILE, 'utf8');
  } catch {
    /* missing */
  }
  if (current !== src) {
    fails++;
    console.log('  FAIL garage stats are stale: run `npx tsx scripts/handling.ts --write`');
  }
  console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
  process.exitCode = fails ? 1 : 0;
}

main();
