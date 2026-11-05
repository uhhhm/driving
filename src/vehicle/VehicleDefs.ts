// Car specifications. All the personality lives here.

export type BodyStyle = 'coupe' | 'muscle' | 'truck' | 'couch' | 'wedge' | 'van';

export interface CarSpec {
  id: string;
  name: string;
  tagline: string;
  style: BodyStyle;
  price: number;
  color: number;
  accent: number;
  // body
  mass: number;
  half: [number, number, number]; // collider half extents (x,y,z)
  colliderY: number; // collider centre offset
  comY: number; // centre-of-mass height (relative to body origin)
  inertia: [number, number, number]; // multipliers on box inertia (pitch, yaw, roll)
  // wheels
  wheelX: number; // half track
  wheelZf: number; // front axle z
  wheelZr: number; // rear axle z (negative)
  wheelY: number; // mount height
  wheelR: number;
  wheelW: number;
  restLen: number;
  travel: number;
  freq: number; // suspension natural frequency (Hz)
  zeta: number; // damping ratio
  antiRoll: number;
  // tyres
  gripF: number;
  gripR: number;
  peakSlip: number; // rad
  slide: number; // grip fraction at full slide (drift plateau)
  offroad: number; // 0 = road tyres, 1 = full off-road (less penalty on dirt/grass/sand)
  // engine & drivetrain
  drive: 'RWD' | 'AWD' | 'FWD';
  torque: number; // Nm
  idleRpm: number;
  redline: number;
  gears: number[];
  finalDrive: number;
  shiftTime: number;
  brake: number; // N total
  drag: number;
  // handling helpers
  maxSteer: number; // rad
  steerSpeedFalloff: number; // how quickly lock reduces with speed
  driftAssist: number; // 0..1
  stability: number; // yaw damping
  downforce: number;
  airControl: number;
  boostForce: number; // in g's
  boostCapacity: number; // seconds
  // audio
  cylinders: number;
  enginePitch: number;
  // damage
  toughness: number;
}

const base: Omit<CarSpec, 'id' | 'name' | 'tagline' | 'style' | 'price' | 'color' | 'accent'> = {
  mass: 1200,
  half: [0.92, 0.42, 2.15],
  colliderY: 0.62,
  comY: 0.28,
  inertia: [1.2, 1.6, 0.85],
  wheelX: 0.82,
  wheelZf: 1.32,
  wheelZr: -1.3,
  wheelY: 0.52,
  wheelR: 0.34,
  wheelW: 0.26,
  restLen: 0.42,
  travel: 0.3,
  freq: 1.9,
  zeta: 0.42,
  antiRoll: 0.35,
  gripF: 1.08,
  gripR: 1.0,
  peakSlip: 0.14,
  slide: 0.72,
  offroad: 0.2,
  drive: 'RWD',
  torque: 520,
  idleRpm: 900,
  redline: 7600,
  gears: [3.3, 2.2, 1.6, 1.25, 1.0, 0.82],
  finalDrive: 3.7,
  shiftTime: 0.14,
  brake: 19000,
  drag: 0.62,
  maxSteer: 0.6,
  steerSpeedFalloff: 0.55,
  driftAssist: 0.8,
  stability: 0.6,
  downforce: 1.4,
  airControl: 1,
  boostForce: 0.55,
  boostCapacity: 4,
  cylinders: 4,
  enginePitch: 1,
  toughness: 1,
};

export const CARS: CarSpec[] = [
  {
    ...base,
    id: 'kitsune',
    name: 'KITSUNE GT',
    tagline: 'Light, twitchy, born sideways.',
    style: 'coupe',
    price: 0,
    color: 0xff5a1f,
    accent: 0xf2f2f2,
    mass: 1150,
    gripF: 1.12,
    gripR: 0.98,
    slide: 0.8,
    driftAssist: 1,
    torque: 480,
    redline: 8400,
    cylinders: 4,
    enginePitch: 1.25,
  },
  {
    ...base,
    id: 'bulldozer',
    name: 'BULLDOZER V8',
    tagline: 'Two tonnes of American bad decisions.',
    style: 'muscle',
    price: 15000,
    color: 0x16181d,
    accent: 0xffc21a,
    mass: 1750,
    half: [1.0, 0.45, 2.45],
    wheelX: 0.9,
    wheelZf: 1.55,
    wheelZr: -1.5,
    wheelR: 0.37,
    wheelW: 0.32,
    freq: 1.55,
    zeta: 0.38,
    inertia: [1.3, 1.9, 0.9],
    torque: 980,
    redline: 6400,
    gears: [2.9, 1.9, 1.4, 1.1, 0.88, 0.72],
    finalDrive: 3.5,
    gripF: 1.0,
    gripR: 0.92,
    slide: 0.7,
    brake: 26000,
    drag: 0.7,
    maxSteer: 0.52,
    cylinders: 8,
    enginePitch: 0.62,
    toughness: 1.8,
    boostForce: 0.6,
  },
  {
    ...base,
    id: 'mule',
    name: 'MULE 4x4',
    tagline: 'Roads are a suggestion.',
    style: 'truck',
    price: 30000,
    color: 0x5d7a3a,
    accent: 0x222222,
    mass: 1900,
    half: [1.05, 0.55, 2.4],
    colliderY: 1.0,
    comY: 0.55,
    wheelX: 0.98,
    wheelZf: 1.55,
    wheelZr: -1.5,
    wheelY: 0.8,
    wheelR: 0.52,
    wheelW: 0.4,
    restLen: 0.62,
    travel: 0.55,
    freq: 1.35,
    zeta: 0.5,
    antiRoll: 0.55,
    inertia: [1.3, 1.6, 1.1],
    drive: 'AWD',
    torque: 1050,
    redline: 5800,
    gears: [3.6, 2.3, 1.6, 1.2, 0.95, 0.78],
    finalDrive: 3.9,
    gripF: 1.0,
    gripR: 0.98,
    slide: 0.78,
    offroad: 1,
    drag: 0.95,
    maxSteer: 0.55,
    driftAssist: 0.6,
    cylinders: 6,
    enginePitch: 0.72,
    toughness: 2.2,
    airControl: 0.8,
  },
  {
    ...base,
    id: 'couch',
    name: 'THE COUCH',
    tagline: 'A three-seater sofa with a jet engine. Why not.',
    style: 'couch',
    price: 60000,
    color: 0x7a2f5a,
    accent: 0xd8b26a,
    mass: 700,
    half: [1.1, 0.45, 0.9],
    colliderY: 0.75,
    comY: 0.35,
    wheelX: 0.95,
    wheelZf: 0.7,
    wheelZr: -0.7,
    wheelY: 0.42,
    wheelR: 0.22,
    wheelW: 0.16,
    restLen: 0.35,
    travel: 0.25,
    freq: 2.4,
    zeta: 0.3,
    inertia: [0.8, 1.1, 0.8],
    torque: 260,
    redline: 9000,
    gears: [3.0, 2.0, 1.5, 1.2, 1.0],
    gripF: 1.05,
    gripR: 0.95,
    slide: 0.85,
    drag: 0.4,
    maxSteer: 0.7,
    driftAssist: 0.9,
    boostForce: 1.6,
    boostCapacity: 6,
    airControl: 1.8,
    cylinders: 2,
    enginePitch: 1.6,
    toughness: 0.7,
  },
  {
    ...base,
    id: 'bolt',
    name: 'BOLT HYPER',
    tagline: 'Glued to the road until it is not.',
    style: 'wedge',
    price: 90000,
    color: 0x1fd1ff,
    accent: 0x101010,
    mass: 1350,
    half: [1.0, 0.36, 2.3],
    colliderY: 0.55,
    comY: 0.2,
    wheelX: 0.88,
    wheelZf: 1.42,
    wheelZr: -1.42,
    wheelY: 0.48,
    wheelR: 0.35,
    wheelW: 0.32,
    restLen: 0.36,
    travel: 0.22,
    freq: 2.3,
    zeta: 0.5,
    drive: 'AWD',
    torque: 900,
    redline: 9200,
    gears: [3.1, 2.2, 1.7, 1.35, 1.1, 0.92, 0.78],
    finalDrive: 3.4,
    gripF: 1.22,
    gripR: 1.18,
    peakSlip: 0.12,
    slide: 0.66,
    drag: 0.45,
    downforce: 3.2,
    driftAssist: 0.6,
    stability: 0.8,
    cylinders: 12,
    enginePitch: 1.05,
    boostForce: 0.75,
    toughness: 0.9,
  },
  {
    ...base,
    id: 'tacovan',
    name: 'TACO VAN',
    tagline: 'Top-heavy. Delicious. Rolls over a lot.',
    style: 'van',
    price: 45000,
    color: 0xffd23f,
    accent: 0xe8412c,
    mass: 2100,
    half: [1.05, 1.05, 2.5],
    colliderY: 1.45,
    comY: 0.85,
    wheelX: 0.92,
    wheelZf: 1.65,
    wheelZr: -1.6,
    wheelY: 0.6,
    wheelR: 0.4,
    wheelW: 0.28,
    restLen: 0.45,
    travel: 0.32,
    freq: 1.45,
    zeta: 0.4,
    antiRoll: 0.2,
    inertia: [1.2, 1.5, 0.8],
    drive: 'FWD',
    torque: 820,
    redline: 5600,
    gears: [3.4, 2.1, 1.45, 1.1, 0.86],
    finalDrive: 3.9,
    gripF: 1.0,
    gripR: 0.95,
    slide: 0.78,
    drag: 1.05,
    maxSteer: 0.55,
    cylinders: 6,
    enginePitch: 0.8,
    toughness: 2.5,
    boostForce: 0.8,
  },
];

export function carById(id: string): CarSpec {
  return CARS.find((c) => c.id === id) ?? CARS[0];
}

/** Upgrades scale a few spec fields. Levels 0..3. */
export interface Upgrades {
  engine: number;
  grip: number;
  boost: number;
  armor: number;
}

export function applyUpgrades(spec: CarSpec, u: Upgrades): CarSpec {
  return {
    ...spec,
    torque: spec.torque * (1 + u.engine * 0.12),
    gripF: spec.gripF * (1 + u.grip * 0.04),
    gripR: spec.gripR * (1 + u.grip * 0.04),
    boostCapacity: spec.boostCapacity * (1 + u.boost * 0.25),
    boostForce: spec.boostForce * (1 + u.boost * 0.08),
    toughness: spec.toughness * (1 + u.armor * 0.35),
  };
}
