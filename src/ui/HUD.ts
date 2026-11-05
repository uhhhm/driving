// Placeholder HUD (expanded later)
import type { Game } from '../core/Game';

export class HUD {
  el: HTMLDivElement;
  constructor(private game: Game) {
    this.el = document.createElement('div');
    this.el.style.cssText = 'position:fixed;left:16px;bottom:16px;color:#fff;font:600 28px system-ui;text-shadow:0 2px 6px #000';
    document.body.appendChild(this.el);
  }
  update(_dt: number) {
    const v = this.game.player.vehicle;
    const s = this.game.stats;
    this.el.textContent = `${Math.round(v.kmh)} km/h  G${v.gear}  ${Math.round(v.rpm)}rpm  fps ${s.fps.toFixed(0)}`;
  }
}
