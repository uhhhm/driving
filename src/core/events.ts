// Tiny typed event bus that decouples gameplay, audio, camera and HUD.

export interface GameEvents {
  crash: { impulse: number; x: number; y: number; z: number; withTraffic: boolean };
  smash: { kind: string; x: number; y: number; z: number; points: number };
  explode: { x: number; y: number; z: number; power: number };
  nearMiss: { dist: number; speed: number };
  trick: { name: string; points: number; color?: string };
  land: { airTime: number; impact: number; clean: boolean };
  takeoff: Record<string, never>;
  shift: { gear: number; up: boolean };
  boostStart: Record<string, never>;
  boostEnd: Record<string, never>;
  bank: { points: number; multiplier: number };
  comboLost: { points: number };
  toast: { text: string; sub?: string; color?: string; big?: boolean };
  biome: { name: string; biome: number };
  eventStart: { title: string; desc: string };
  eventEnd: { title: string; success: boolean; reward: number };
  checkpoint: { left: number };
  police: { heat: number };
  busted: Record<string, never>;
  wrecked: Record<string, never>;
  unlock: { name: string };
  reset: Record<string, never>;
}

type Handler<T> = (payload: T) => void;

class Bus {
  private map = new Map<keyof GameEvents, Set<Handler<unknown>>>();
  on<K extends keyof GameEvents>(k: K, fn: Handler<GameEvents[K]>): () => void {
    let s = this.map.get(k);
    if (!s) this.map.set(k, (s = new Set()));
    s.add(fn as Handler<unknown>);
    return () => s!.delete(fn as Handler<unknown>);
  }
  emit<K extends keyof GameEvents>(k: K, payload: GameEvents[K]) {
    const s = this.map.get(k);
    if (s) for (const fn of s) fn(payload);
  }
}

export const bus = new Bus();
