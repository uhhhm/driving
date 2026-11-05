// Title / garage screen and pause menu.
import { CARS, type CarSpec } from '../vehicle/VehicleDefs';
import { PAINTS, UPGRADE_COST, type Save } from '../game/Save';
import type { Upgrades } from '../vehicle/VehicleDefs';
import { HANDLING_STATS } from '../vehicle/HandlingStats';

export interface MenuResult {
  seed: string;
  car: string;
  paint: number;
}

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
// Garage bars come from measured handling (scripts/handling.ts --write), not guesses from the spec.
const STAT = (c: CarSpec) => HANDLING_STATS[c.id] ?? HANDLING_STATS.kitsune;

const randomSeed = () => {
  const words = ['NEON', 'DUST', 'APEX', 'GHOST', 'VOLT', 'RIDGE', 'TIDE', 'EMBER', 'NOVA', 'RUST', 'COBALT', 'ZEN', 'FURY', 'MIRAGE', 'TURBO', 'ORBIT'];
  return `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(Math.random() * 9000 + 1000)}`;
};

export const dailySeed = () => {
  const d = new Date();
  return `DAILY-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
};

export class TitleMenu {
  el: HTMLDivElement;
  private car: string;
  private paint: number;
  private seed: string;
  private resolve!: (r: MenuResult) => void;

  constructor(
    private save: Save,
    seed: string,
    private inGame = false,
  ) {
    this.car = save.data.car;
    this.paint = save.data.paints[this.car] ?? 0;
    this.seed = seed;
    this.el = document.createElement('div');
    this.el.className = 'menu';
    document.body.appendChild(this.el);
    this.render();
  }

  open(): Promise<MenuResult> {
    this.el.classList.remove('hidden');
    this.render();
    return new Promise((r) => (this.resolve = r));
  }

  private render() {
    const s = this.save.data;
    const spec = CARS.find((c) => c.id === this.car)!;
    const owned = s.owned.includes(this.car);
    const st = STAT(spec);
    const u = this.save.upgrades(this.car);
    const best = s.bestBySeed[this.seed.toUpperCase()] ?? 0;
    this.el.innerHTML = `
      <div class="panel">
        <div>
          <div class="title">SEED<br>RUNNER</div>
          <div class="subtitle">INFINITE · PROCEDURAL · ARCADE</div>
          <label>WORLD SEED</label>
          <div class="row"><input type="text" id="seed" value="${this.seed}" maxlength="24" spellcheck="false" />
            <button class="btn" id="rnd" title="Random seed">🎲</button><button class="btn" id="daily">DAILY</button></div>
          <div class="best" style="margin-top:6px">BEST ON THIS SEED: ${best.toLocaleString()}</div>
          <div style="margin-top:22px" class="row">
            <button class="btn primary" id="go" ${owned ? '' : 'disabled'}>${this.inGame ? 'APPLY & DRIVE' : 'DRIVE'}</button>
          </div>
          <label style="margin-top:22px">CONTROLS</label>
          <div class="controls">
            <kbd>W</kbd><kbd>S</kbd> throttle / brake-reverse<br>
            <kbd>A</kbd><kbd>D</kbd> steer · air roll<br>
            <kbd>SPACE</kbd> handbrake (drift!)<br>
            <kbd>SHIFT</kbd> boost<br>
            <kbd>W</kbd><kbd>S</kbd> in air: flip<br>
            <kbd>SPACE</kbd>+<kbd>A</kbd><kbd>D</kbd> air: spin<br>
            <kbd>C</kbd> camera · <kbd>B</kbd> look back<br>
            <kbd>R</kbd> reset to road · <kbd>H</kbd> horn<br>
            <kbd>F</kbd> photo mode · <kbd>P</kbd>/<kbd>ESC</kbd> pause<br>
            <kbd>M</kbd> radio · <kbd>\`</kbd> debug panel<br>
            🎮 gamepad supported
          </div>
        </div>
        <div>
          <div class="row" style="justify-content:space-between;align-items:baseline"><label style="margin:0">GARAGE</label><div class="credits">${s.credits.toLocaleString()} CR</div></div>
          <div class="cars" style="margin-top:8px">
            ${CARS.map(
              (c) => `<div class="car ${c.id === this.car ? 'sel' : ''} ${s.owned.includes(c.id) ? '' : 'locked'}" data-car="${c.id}">
                <b>${c.name}</b><span>${c.tagline}</span><i>${s.owned.includes(c.id) ? 'OWNED' : '🔒 ' + c.price.toLocaleString() + ' CR'}</i></div>`,
            ).join('')}
          </div>
          <div class="stats">${Object.entries(st)
            .map(([k, v]) => `<span>${k}</span><div class="bar"><i style="width:${Math.round(v * 100)}%"></i></div>`)
            .join('')}</div>
          ${owned ? '' : `<div style="margin-top:10px"><button class="btn" id="buy" ${s.credits >= spec.price ? '' : 'disabled'}>BUY ${spec.name} · ${spec.price.toLocaleString()} CR</button></div>`}
          <label>PAINT</label>
          <div class="swatches">${PAINTS.map(
            (p, i) =>
              `<div class="swatch ${i === this.paint ? 'sel' : ''} ${s.ownedPaints.includes(i) ? '' : 'locked'}" data-paint="${i}" title="${p.name}${s.ownedPaints.includes(i) ? '' : ' · ' + p.price + ' CR'}" style="background:${p.color < 0 ? hex(spec.color) : hex(p.color)}"></div>`,
          ).join('')}</div>
          <label>UPGRADES ${owned ? '' : '(buy the car first)'}</label>
          <div class="upg">${(['engine', 'grip', 'boost', 'armor'] as (keyof Upgrades)[])
            .map(
              (k) => `<span>${k.toUpperCase()}</span><span class="pips">${[0, 1, 2].map((i) => `<i class="${i < u[k] ? 'on' : ''}"></i>`).join('')}</span>
              <button class="btn" data-upg="${k}" ${owned && u[k] < 3 && s.credits >= UPGRADE_COST[u[k]] ? '' : 'disabled'}>${u[k] >= 3 ? 'MAX' : UPGRADE_COST[u[k]].toLocaleString()}</button>`,
            )
            .join('')}</div>
        </div>
      </div>`;
    const q = (id: string) => this.el.querySelector('#' + id) as HTMLElement;
    const seedInput = q('seed') as HTMLInputElement;
    seedInput.addEventListener('input', () => (this.seed = seedInput.value.toUpperCase() || 'SEEDRUNNER'));
    seedInput.addEventListener('keydown', (e) => e.stopPropagation());
    q('rnd').onclick = () => {
      this.seed = randomSeed();
      this.render();
    };
    q('daily').onclick = () => {
      this.seed = dailySeed();
      this.render();
    };
    q('go').onclick = () => {
      if (!this.save.data.owned.includes(this.car)) return;
      this.save.data.car = this.car;
      this.save.data.paints[this.car] = this.paint;
      this.save.write();
      this.el.classList.add('hidden');
      this.resolve({ seed: this.seed.trim().toUpperCase() || 'SEEDRUNNER', car: this.car, paint: this.paint });
    };
    const buy = this.el.querySelector('#buy') as HTMLButtonElement | null;
    if (buy) buy.onclick = () => this.save.buyCar(this.car) && this.render();
    this.el.querySelectorAll<HTMLElement>('.car').forEach((el) => {
      el.onclick = () => {
        this.car = el.dataset.car!;
        this.paint = this.save.data.paints[this.car] ?? 0;
        this.render();
      };
    });
    this.el.querySelectorAll<HTMLElement>('.swatch').forEach((el) => {
      el.onclick = () => {
        const i = Number(el.dataset.paint);
        if (!this.save.data.ownedPaints.includes(i) && !this.save.buyPaint(i)) return;
        this.paint = i;
        this.render();
      };
    });
    this.el.querySelectorAll<HTMLButtonElement>('[data-upg]').forEach((el) => {
      el.onclick = () => this.save.buyUpgrade(this.car, el.dataset.upg as keyof Upgrades) && this.render();
    });
  }
}

export function paintColor(spec: CarSpec, paintIdx: number): number {
  const p = PAINTS[paintIdx] ?? PAINTS[0];
  return p.color < 0 ? spec.color : p.color;
}

export class PauseMenu {
  el: HTMLDivElement;
  onAction: (a: string) => void = () => {};
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'menu hidden';
    document.body.appendChild(this.el);
  }
  open(info: { seed: string; volume: number; crashCam: boolean; music: boolean; quality: number; score: number; best: number }) {
    this.el.classList.remove('hidden');
    this.el.innerHTML = `<div class="pause-box">
      <div class="pause-title">PAUSED</div>
      <div class="best" style="text-align:center">SEED <b>${info.seed}</b> · RUN ${info.score.toLocaleString()} · BEST ${info.best.toLocaleString()}</div>
      <button class="btn primary" data-a="resume">RESUME</button>
      <button class="btn" data-a="reset">RESET CAR</button>
      <button class="btn" data-a="garage">GARAGE / NEW SEED</button>
      <button class="btn" data-a="share">COPY SEED LINK</button>
      <button class="btn" data-a="photo">PHOTO MODE</button>
      <button class="btn" data-a="event">START RANDOM EVENT</button>
      <button class="btn" data-a="endrun">END RUN (SAVE GHOST)</button>
      <label>VOLUME</label><input type="range" min="0" max="1" step="0.05" value="${info.volume}" data-a="volume" />
      <label>GRAPHICS QUALITY</label><input type="range" min="0" max="2" step="1" value="${info.quality}" data-a="quality" />
      <label><input type="checkbox" data-a="crashcam" ${info.crashCam ? 'checked' : ''}/> CINEMATIC CRASH CAM</label>
      <label><input type="checkbox" data-a="music" ${info.music ? 'checked' : ''}/> SEED FM RADIO (M)</label>
    </div>`;
    this.el.querySelectorAll<HTMLElement>('[data-a]').forEach((b) => {
      const a = b.dataset.a!;
      if (b instanceof HTMLInputElement) {
        b.oninput = () => this.onAction(`${a}:${b.type === 'checkbox' ? (b.checked ? 1 : 0) : b.value}`);
      } else b.onclick = () => this.onAction(a);
    });
  }
  close() {
    this.el.classList.add('hidden');
  }
  get isOpen() {
    return !this.el.classList.contains('hidden');
  }
}
