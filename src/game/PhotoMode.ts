// Photo mode: freeze time, free camera, tweak time of day / FOV / filters, save PNG.
import type { Game } from '../core/Game';

const FILTERS = ['none', 'noir', 'warm', 'cyber', 'faded'];

export class PhotoMode {
  active = false;
  private ui: HTMLDivElement;
  private mouse = { dx: 0, dy: 0, down: false };
  private filter = 0;
  private prevHud = true;
  private fov = 60;

  constructor(private game: Game) {
    this.ui = document.createElement('div');
    this.ui.className = 'photo-ui hidden';
    document.body.appendChild(this.ui);
    const c = game.renderer.domElement;
    c.addEventListener('mousedown', () => (this.mouse.down = true));
    window.addEventListener('mouseup', () => (this.mouse.down = false));
    window.addEventListener('mousemove', (e) => {
      if (!this.active || !this.mouse.down) return;
      this.mouse.dx += e.movementX;
      this.mouse.dy += e.movementY;
    });
    window.addEventListener('wheel', (e) => {
      if (!this.active) return;
      this.fov = Math.max(15, Math.min(110, this.fov + Math.sign(e.deltaY) * 3));
    });
    window.addEventListener('keydown', (e) => {
      if (!this.active) return;
      if (e.code === 'BracketLeft') game.sky.hours = (game.sky.hours + 23.5) % 24;
      if (e.code === 'BracketRight') game.sky.hours = (game.sky.hours + 0.5) % 24;
      if (e.code === 'KeyT') this.filter = (this.filter + 1) % FILTERS.length;
      if (e.code === 'KeyG') game.hud.visible = !game.hud.visible;
      if (e.code === 'Enter') this.capture();
      this.refresh();
    });
  }

  toggle() {
    this.active ? this.exit() : this.enter();
  }

  enter() {
    const g = this.game;
    this.active = true;
    g.paused = true;
    g.sky.paused = true;
    this.prevHud = g.hud.visible;
    g.hud.visible = false;
    g.input.enabled = false;
    this.fov = g.rig.camera.fov;
    g.rig.enterPhoto();
    this.ui.classList.remove('hidden');
    this.refresh();
  }

  exit() {
    const g = this.game;
    this.active = false;
    g.paused = false;
    g.sky.paused = false;
    g.hud.visible = this.prevHud;
    g.input.enabled = true;
    g.rig.photo = false;
    g.rig.snap(g.player.vehicle);
    this.ui.classList.add('hidden');
    g.postfx.setFilter('none');
  }

  private refresh() {
    this.ui.innerHTML = `PHOTO MODE · <kbd>WASD</kbd>/<kbd>QE</kbd> move · drag look · wheel FOV ${this.fov}° · <kbd>[</kbd><kbd>]</kbd> time ${this.game.sky.timeString} · <kbd>T</kbd> filter: ${FILTERS[this.filter]} · <kbd>G</kbd> HUD · <kbd>ENTER</kbd> save · <kbd>F</kbd> exit`;
    this.game.postfx.setFilter(FILTERS[this.filter]);
  }

  update(realDt: number) {
    if (!this.active) return;
    const g = this.game;
    g.rig.updatePhoto(realDt, g.input.keysDown, this.mouse);
    g.rig.camera.fov = this.fov;
    g.rig.camera.updateProjectionMatrix();
    this.mouse.dx = this.mouse.dy = 0;
    g.sky.update(0, g.player.vehicle.pos);
  }

  capture() {
    const g = this.game;
    g.postfx.render(0);
    const url = g.renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `seedrunner-${g.seedText}-${Date.now()}.png`;
    a.click();
    const f = document.createElement('div');
    f.className = 'flash on';
    document.body.appendChild(f);
    requestAnimationFrame(() => {
      f.className = 'flash';
      setTimeout(() => f.remove(), 500);
    });
  }
}
