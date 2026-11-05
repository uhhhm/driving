// Simple road-following driver (attract mode / demo).
import type { Controls } from '../core/Input';
import type { Game } from '../core/Game';

export class AutoPilot {
  active = false;
  private stuck = 0;
  private flick = 0;
  constructor(private game: Game) {}

  controls(dt: number): Partial<Controls> {
    const g = this.game;
    const v = g.player.vehicle;
    const nr = g.chunks.gen.nearestRoad(v.pos.x, v.pos.z, 120);
    if (!nr) return { throttle: 0.6 };
    const e = nr.edge;
    const q = nr.idx;
    const dir = v.fwd.x * e.tx[q] + v.fwd.z * e.tz[q] >= 0 ? 1 : -1;
    const ahead = Math.round((10 + v.speedAbs * 0.55) / 3);
    const qa = Math.max(0, Math.min(e.n - 1, q + dir * ahead));
    const lane = e.halfW * 0.35 * dir;
    const tx = e.x[qa] - e.tz[qa] * lane - v.pos.x;
    const tz = e.z[qa] + e.tx[qa] * lane - v.pos.z;
    const ang = Math.atan2(v.fwd.x * tz - v.fwd.z * tx, v.fwd.x * tx + v.fwd.z * tz);
    // curvature ahead → target speed
    const qb = Math.max(0, Math.min(e.n - 1, q + dir * (ahead + 12)));
    const turn = Math.abs(e.tx[qa] * e.tz[qb] - e.tz[qa] * e.tx[qb]);
    const target = 150 - turn * 260;
    if (v.speedAbs < 2) this.stuck += dt;
    else this.stuck = 0;
    if (this.stuck > 3) {
      this.stuck = 0;
      g.resetToRoad();
    }
    this.flick -= dt;
    // show off: occasional handbrake drift into corners
    const hb = turn > 0.25 && v.kmh > 70 && this.flick < 0;
    if (hb) this.flick = 2;
    return {
      throttle: v.kmh < target ? 1 : 0.2,
      brake: v.kmh > target + 30 ? 0.6 : 0,
      steer: v.groundedCount ? Math.max(-1, Math.min(1, ang * 2.4)) : 0,
      handbrake: this.flick > 1.75,
      boost: v.kmh > 90 && Math.abs(ang) < 0.05 && v.boost > v.spec.boostCapacity * 0.6,
    };
  }
}
