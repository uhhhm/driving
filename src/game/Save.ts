// Progression persisted to localStorage.
import { CARS, type Upgrades } from '../vehicle/VehicleDefs';

export const PAINTS: { name: string; color: number; price: number }[] = [
  { name: 'Factory', color: -1, price: 0 },
  { name: 'Arctic', color: 0xf2f2f2, price: 0 },
  { name: 'Midnight', color: 0x14161c, price: 2000 },
  { name: 'Racing Red', color: 0xd01c1c, price: 3000 },
  { name: 'Lime', color: 0x7dff3d, price: 4000 },
  { name: 'Cyan', color: 0x1fd1ff, price: 5000 },
  { name: 'Hot Pink', color: 0xff3df2, price: 6000 },
  { name: 'Gold', color: 0xd4a72c, price: 12000 },
  { name: 'Chrome Purple', color: 0x6a2fd0, price: 15000 },
  { name: 'Burnt Orange', color: 0xc9561a, price: 8000 },
];

export const UPGRADE_COST = [6000, 14000, 30000];

export interface SaveData {
  credits: number;
  lifetime: number;
  owned: string[];
  car: string;
  paints: Record<string, number>; // car -> paint index
  ownedPaints: number[];
  upgrades: Record<string, Upgrades>;
  bestBySeed: Record<string, number>;
  settings: { volume: number; quality: number; assists: number; invertAir: boolean; crashCam: boolean; music: boolean };
  seen: { intro: boolean };
}

const KEY = 'seedrunner.save.v1';

const DEFAULT: SaveData = {
  credits: 0,
  lifetime: 0,
  owned: ['kitsune'],
  car: 'kitsune',
  paints: {},
  ownedPaints: [0, 1],
  upgrades: {},
  bestBySeed: {},
  settings: { volume: 0.8, quality: 1, assists: 1, invertAir: false, crashCam: true, music: true },
  seen: { intro: false },
};

export class Save {
  data: SaveData;
  constructor() {
    let d: Partial<SaveData> = {};
    try {
      d = JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch {
      d = {};
    }
    this.data = { ...structuredClone(DEFAULT), ...d, settings: { ...DEFAULT.settings, ...(d.settings ?? {}) }, seen: { ...DEFAULT.seen, ...(d.seen ?? {}) } };
  }
  write() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage blocked */
    }
  }
  addCredits(n: number) {
    this.data.credits += n;
    this.data.lifetime += n;
    this.write();
  }
  upgrades(car: string): Upgrades {
    return (this.data.upgrades[car] ??= { engine: 0, grip: 0, boost: 0, armor: 0 });
  }
  buyCar(id: string): boolean {
    const c = CARS.find((x) => x.id === id);
    if (!c || this.data.owned.includes(id) || this.data.credits < c.price) return false;
    this.data.credits -= c.price;
    this.data.owned.push(id);
    this.write();
    return true;
  }
  buyUpgrade(car: string, k: keyof Upgrades): boolean {
    const u = this.upgrades(car);
    const lvl = u[k];
    if (lvl >= 3 || this.data.credits < UPGRADE_COST[lvl]) return false;
    this.data.credits -= UPGRADE_COST[lvl];
    u[k]++;
    this.write();
    return true;
  }
  buyPaint(i: number): boolean {
    if (this.data.ownedPaints.includes(i) || this.data.credits < PAINTS[i].price) return false;
    this.data.credits -= PAINTS[i].price;
    this.data.ownedPaints.push(i);
    this.write();
    return true;
  }
  recordBest(seed: string, score: number): boolean {
    const k = seed.toUpperCase();
    if (score > (this.data.bestBySeed[k] ?? 0)) {
      this.data.bestBySeed[k] = score;
      this.write();
      return true;
    }
    return false;
  }
}
