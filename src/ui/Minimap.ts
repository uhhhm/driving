// Rotating minimap of the procedural road graph with markers.
import type { Game } from '../core/Game';
import { RoadType, BIOME_COUNT } from '../world/types';

export interface MapMarker {
  x: number;
  z: number;
  color: string;
  size?: number;
  shape?: 'dot' | 'ring' | 'diamond' | 'arrow';
  label?: string;
}

const ROAD_COL = ['#d8d8e0', '#c9b98a', '#a8865a', '#c58aff'];

export class Minimap {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  markers: MapMarker[] = [];
  radius = 420; // metres shown
  private size = 210;
  private dpr = Math.min(2, window.devicePixelRatio || 1);
  private frame = 0;

  constructor(
    private game: Game,
    parent: HTMLElement,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-minimap';
    this.canvas.width = this.size * this.dpr;
    this.canvas.height = this.size * this.dpr;
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  update(_dt: number) {
    if (++this.frame % 2) return;
    const g = this.game;
    const v = g.player.vehicle;
    const c = this.ctx;
    const S = this.size * this.dpr;
    const half = S / 2;
    const scale = half / this.radius;
    const heading = Math.atan2(v.fwd.x, v.fwd.z);
    c.save();
    c.clearRect(0, 0, S, S);
    c.beginPath();
    c.arc(half, half, half - 2, 0, Math.PI * 2);
    c.clip();
    // biome-tinted background
    const w = g.biomeWeights;
    const bcol = [
      [90, 52, 30],
      [24, 46, 30],
      [30, 14, 44],
      [20, 52, 62],
    ];
    let r = 0, gg = 0, b = 0;
    for (let i = 0; i < BIOME_COUNT; i++) {
      r += bcol[i][0] * w[i];
      gg += bcol[i][1] * w[i];
      b += bcol[i][2] * w[i];
    }
    c.fillStyle = `rgba(${r | 0},${gg | 0},${b | 0},0.78)`;
    c.fillRect(0, 0, S, S);
    // transform: world -> map (car at centre, heading up)
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    const tx = (x: number, z: number): [number, number] => {
      const dx = x - v.pos.x;
      const dz = z - v.pos.z;
      // rotate so heading points up; +x (left of car) to screen left
      const rx = dx * cos - dz * sin;
      const rz = dx * sin + dz * cos;
      return [half - rx * scale, half - rz * scale];
    };
    const R = this.radius * 1.42;
    const edges = g.chunks.gen.edgesNear(v.pos.x - R, v.pos.z - R, v.pos.x + R, v.pos.z + R);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const pass of [0, 1]) {
      for (const e of edges) {
        c.beginPath();
        const step = 3;
        for (let q = 0; q < e.n; q += step) {
          const [px, py] = tx(e.x[q], e.z[q]);
          if (q === 0) c.moveTo(px, py);
          else c.lineTo(px, py);
        }
        const [ex, ey] = tx(e.x[e.n - 1], e.z[e.n - 1]);
        c.lineTo(ex, ey);
        if (pass === 0) {
          c.strokeStyle = 'rgba(0,0,0,0.55)';
          c.lineWidth = (e.type === RoadType.Highway || e.type === RoadType.Avenue ? 7 : 5) * this.dpr;
        } else {
          c.strokeStyle = ROAD_COL[e.type];
          c.lineWidth = (e.type === RoadType.Highway || e.type === RoadType.Avenue ? 3.2 : 2) * this.dpr;
        }
        c.stroke();
      }
    }
    // set piece icons
    for (const e of edges)
      for (const sp of e.setPieces) {
        const [px, py] = tx(sp.x, sp.z);
        c.fillStyle = sp.kind === 'loop' ? '#7dff3d' : sp.kind === 'ramp' ? '#ffd23f' : sp.kind === 'gas' ? '#ff4d2e' : sp.kind === 'jam' ? '#ff9d2e' : '#4dfff0';
        c.beginPath();
        c.arc(px, py, 3.5 * this.dpr, 0, Math.PI * 2);
        c.fill();
      }
    // traffic
    if (g.traffic) {
      for (const t of g.traffic.cars) {
        const [px, py] = tx(t.pos.x, t.pos.z);
        c.fillStyle = t.wrecked ? '#666' : 'rgba(255,255,255,0.85)';
        c.fillRect(px - 1.5 * this.dpr, py - 1.5 * this.dpr, 3 * this.dpr, 3 * this.dpr);
      }
    }
    // markers
    const blink = Math.floor(performance.now() / 250) % 2;
    for (const m of this.markers) {
      let [px, py] = tx(m.x, m.z);
      const dx = px - half;
      const dy = py - half;
      const d = Math.hypot(dx, dy);
      const lim = half - 10 * this.dpr;
      const clamped = d > lim;
      if (clamped) {
        px = half + (dx / d) * lim;
        py = half + (dy / d) * lim;
      }
      const sz = (m.size ?? 5) * this.dpr;
      c.fillStyle = m.color === 'police' ? (blink ? '#ff2a2a' : '#2a6bff') : m.color;
      c.strokeStyle = c.fillStyle;
      c.lineWidth = 2 * this.dpr;
      c.beginPath();
      if (m.shape === 'ring') {
        c.arc(px, py, sz, 0, Math.PI * 2);
        c.stroke();
      } else if (m.shape === 'diamond') {
        c.moveTo(px, py - sz);
        c.lineTo(px + sz, py);
        c.lineTo(px, py + sz);
        c.lineTo(px - sz, py);
        c.closePath();
        c.fill();
      } else {
        c.arc(px, py, sz, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.restore();
    // player arrow
    c.save();
    c.translate(half, half);
    c.fillStyle = '#2ef2ff';
    c.strokeStyle = '#000';
    c.lineWidth = 2 * this.dpr;
    c.beginPath();
    const a = 8 * this.dpr;
    c.moveTo(0, -a * 1.3);
    c.lineTo(a, a);
    c.lineTo(0, a * 0.4);
    c.lineTo(-a, a);
    c.closePath();
    c.stroke();
    c.fill();
    c.restore();
    // ring
    c.beginPath();
    c.arc(half, half, half - 2, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(255,255,255,0.35)';
    c.lineWidth = 2 * this.dpr;
    c.stroke();
    // north
    const nx = half + Math.sin(-heading + Math.PI) * 0;
    void nx;
  }
}
