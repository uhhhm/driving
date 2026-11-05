// Heads-up display: speedo, boost/health, combo meter, trick popups, toasts, event panel, minimap, heat.
import type { Game } from '../core/Game';
import { bus } from '../core/events';
import { Minimap } from './Minimap';

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export class HUD {
  root: HTMLDivElement;
  /** top-left stack: Road School goal + event/pursuit panel share it so they never overlap */
  topLeft: HTMLDivElement;
  private speedo: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D;
  private combo: HTMLDivElement;
  private comboPot: HTMLDivElement;
  private comboMult: HTMLDivElement;
  private comboBar: HTMLDivElement;
  private comboLive: HTMLDivElement;
  private tricks: HTMLDivElement;
  private toasts: HTMLDivElement;
  private eventPanel: HTMLDivElement;
  private scoreEl: HTMLDivElement;
  private infoEl: HTMLDivElement;
  private heatEl: HTMLDivElement;
  private hint: HTMLDivElement;
  private centerMsg: HTMLDivElement;
  private debugEl: HTMLDivElement;
  minimap: Minimap;
  private lastMult = 1;
  private frameN = 0;
  private lastPot = 0;
  showDebug = false;
  visible = true;
  private dpr = Math.min(2, window.devicePixelRatio || 1);

  constructor(private game: Game) {
    const r = document.createElement('div');
    r.id = 'hud';
    r.innerHTML = `
      <div class="hud-tr"><div class="score"></div><div class="info"></div><div class="heat"></div></div>
      <div class="hud-tl"><div class="hud-event"></div></div>
      <div class="hud-combo"><div class="combo-mult">x1</div><div class="combo-pot">0</div><div class="combo-live"></div><div class="combo-bar"><i></i></div></div>
      <div class="hud-tricks"></div>
      <div class="hud-toasts"></div>
      <div class="hud-center"></div>
      <canvas class="hud-speedo"></canvas>
      <div class="hud-hint"></div>
      <div class="hud-debug"></div>`;
    document.body.appendChild(r);
    this.root = r;
    const q = <T extends HTMLElement>(s: string) => r.querySelector(s) as T;
    this.speedo = q('.hud-speedo');
    this.speedo.width = 260 * this.dpr;
    this.speedo.height = 260 * this.dpr;
    this.sctx = this.speedo.getContext('2d')!;
    this.combo = q('.hud-combo');
    this.comboPot = q('.combo-pot');
    this.comboMult = q('.combo-mult');
    this.comboBar = q('.combo-bar i');
    this.comboLive = q('.combo-live');
    this.tricks = q('.hud-tricks');
    this.toasts = q('.hud-toasts');
    this.topLeft = q('.hud-tl');
    this.eventPanel = q('.hud-event');
    this.scoreEl = q('.score');
    this.infoEl = q('.info');
    this.heatEl = q('.heat');
    this.hint = q('.hud-hint');
    this.centerMsg = q('.hud-center');
    this.debugEl = q('.hud-debug');
    this.minimap = new Minimap(game, r);

    bus.on('toast', (e) => this.toast(e.text, e.sub, e.color, e.big));
    bus.on('bank', (e) => this.popTrick(`+${fmt(e.points)}`, '#ffffff', true, `BANKED x${e.multiplier}`));
    bus.on('comboLost', (e) => this.popTrick('COMBO LOST', '#ff3b3b', true, `-${fmt(e.points)}`));
    bus.on('biome', (e) => (this.region = e.name));
  }
  region = '';

  setHint(html: string, seconds = 8) {
    this.hint.innerHTML = html;
    this.hint.classList.add('show');
    clearTimeout(this.hintT);
    this.hintT = window.setTimeout(() => this.hint.classList.remove('show'), seconds * 1000);
  }
  private hintT = 0;

  center(html: string, seconds = 1.2, cls = '') {
    this.centerMsg.innerHTML = html;
    this.centerMsg.className = 'hud-center show ' + cls;
    clearTimeout(this.centerT);
    this.centerT = window.setTimeout(() => (this.centerMsg.className = 'hud-center'), seconds * 1000);
  }
  private centerT = 0;

  popTrick(text: string, color: string, big = false, sub = '') {
    const el = document.createElement('div');
    el.className = 'trick' + (big ? ' big' : '');
    el.style.color = color;
    el.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
    this.tricks.prepend(el);
    while (this.tricks.children.length > 5) this.tricks.lastChild!.remove();
    setTimeout(() => el.classList.add('out'), 1400);
    setTimeout(() => el.remove(), 1900);
  }

  toast(text: string, sub?: string, color?: string, big?: boolean) {
    const el = document.createElement('div');
    el.className = 'toast' + (big ? ' big' : '');
    if (color) el.style.color = color;
    el.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
    this.toasts.appendChild(el);
    while (this.toasts.children.length > 3) this.toasts.firstChild!.remove();
    setTimeout(() => el.classList.add('out'), big ? 3200 : 2000);
    setTimeout(() => el.remove(), big ? 3800 : 2500);
  }

  setEvent(html: string | null) {
    if (!html) {
      this.eventPanel.classList.remove('show');
      return;
    }
    this.eventPanel.innerHTML = html;
    this.eventPanel.classList.add('show');
  }

  setHeat(level: number, status: string) {
    if (level <= 0) {
      this.heatEl.innerHTML = '';
      return;
    }
    let s = '';
    for (let i = 0; i < 5; i++) s += `<b class="${i < level ? 'on' : ''}">★</b>`;
    this.heatEl.innerHTML = `${s}<span>${status}</span>`;
  }

  update(dt: number) {
    const g = this.game;
    this.root.style.display = this.visible ? '' : 'none';
    if (!this.visible) return;
    const v = g.player.vehicle;
    if (++this.frameN % 2 === 0) this.drawSpeedo(v.kmh, v.rpm / v.spec.redline, v.gear, v.boost / v.spec.boostCapacity, v.health / 100, v.boosting, v.limiter);
    // combo
    const s = g.score;
    if (s) {
      const view = s.view;
      const active = view.pot > 0 || view.live > 0;
      this.combo.classList.toggle('show', active);
      if (active) {
        this.comboPot.textContent = fmt(view.pot);
        this.comboMult.textContent = `x${view.mult}`;
        (this.comboBar as HTMLElement).style.transform = `scaleX(${Math.max(0, view.timer)})`;
        this.comboLive.textContent = view.live > 0 ? `${g.player.vehicle.drifting ? 'DRIFT' : 'AIR'} +${fmt(view.live)}` : '';
        if (view.mult !== this.lastMult) {
          this.comboMult.classList.remove('pop');
          void this.comboMult.offsetWidth;
          this.comboMult.classList.add('pop');
        }
        if (view.pot !== this.lastPot) {
          this.comboPot.classList.remove('bump');
          void this.comboPot.offsetWidth;
          this.comboPot.classList.add('bump');
        }
      }
      this.lastMult = view.mult;
      this.lastPot = view.pot;
      this.scoreEl.innerHTML = `${fmt(s.total)}<small>CR ${fmt(g.save?.data.credits ?? 0)}</small>`;
    }
    const weather = g.weather?.name ?? '';
    this.infoEl.innerHTML = `${this.region}<br><small>${g.sky.timeString} · ${weather}</small>`;
    this.minimap.update(dt);
    if (this.showDebug) {
      const st = g.stats;
      this.debugEl.style.display = 'block';
      this.debugEl.textContent = `fps ${st.fps.toFixed(0)}  frame ${st.frameMs.toFixed(1)}ms  phys ${st.physMs.toFixed(1)}  render ${st.renderMs.toFixed(1)}\nchunks ${g.chunks.loadedCount} pending ${g.chunks.pendingCount} gen ${g.chunks.stats.genMs.toFixed(1)}ms  calls ${g.renderer.info.render.calls} tris ${(g.renderer.info.render.triangles / 1000).toFixed(0)}k\ntraffic ${g.traffic?.cars.length ?? 0}  beta ${(v.slipAngleBody * 57.3).toFixed(0)}°  drift ${v.driftMode ? 'Y' : 'n'}  surf ${v.wheels.map((w) => w.surface).join('')}  pos ${v.pos.x.toFixed(0)},${v.pos.y.toFixed(0)},${v.pos.z.toFixed(0)}`;
    } else this.debugEl.style.display = 'none';
  }

  private drawSpeedo(kmh: number, rpm01: number, gear: number, boost: number, health: number, boosting: boolean, limiter: boolean) {
    const c = this.sctx;
    const d = this.dpr;
    const W = 260 * d;
    c.clearRect(0, 0, W, W);
    const cx = W / 2;
    const cy = W / 2;
    const R = 108 * d;
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    // backing
    c.beginPath();
    c.arc(cx, cy, R + 8 * d, 0, Math.PI * 2);
    c.fillStyle = 'rgba(8,8,14,0.55)';
    c.fill();
    // rpm ticks
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const a = a0 + (a1 - a0) * t;
      const inner = i % 5 === 0 ? R - 16 * d : R - 9 * d;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      c.lineTo(cx + Math.cos(a) * (R - 2 * d), cy + Math.sin(a) * (R - 2 * d));
      c.strokeStyle = t > 0.85 ? '#ff3b3b' : 'rgba(255,255,255,0.45)';
      c.lineWidth = (i % 5 === 0 ? 3 : 1.5) * d;
      c.stroke();
    }
    // rpm arc
    const ar = a0 + (a1 - a0) * Math.min(1, rpm01);
    const grad = c.createLinearGradient(0, W, W, 0);
    grad.addColorStop(0, '#2ef2ff');
    grad.addColorStop(0.7, '#ff3df2');
    grad.addColorStop(1, '#ff3b3b');
    c.beginPath();
    c.arc(cx, cy, R - 24 * d, a0, ar);
    c.strokeStyle = limiter ? (Math.random() < 0.5 ? '#ff3b3b' : '#ffffff') : grad;
    c.lineWidth = 10 * d;
    c.lineCap = 'round';
    c.stroke();
    // boost arc (inner)
    c.beginPath();
    c.arc(cx, cy, R - 40 * d, a0, a0 + (a1 - a0) * boost);
    c.strokeStyle = boosting ? '#ffffff' : '#ff9d2e';
    c.lineWidth = 5 * d;
    c.stroke();
    // health arc (outer thin)
    c.beginPath();
    c.arc(cx, cy, R + 4 * d, a0, a0 + (a1 - a0) * health);
    c.strokeStyle = health < 0.3 ? '#ff3b3b' : '#7dff3d';
    c.lineWidth = 3 * d;
    c.lineCap = 'butt';
    c.stroke();
    // numbers
    c.fillStyle = '#fff';
    c.textAlign = 'center';
    c.font = `700 ${58 * d}px 'Chakra Petch', system-ui, sans-serif`;
    c.fillText(String(Math.round(kmh)), cx, cy + 12 * d);
    c.font = `600 ${14 * d}px 'Chakra Petch', system-ui, sans-serif`;
    c.fillStyle = 'rgba(255,255,255,0.6)';
    c.fillText('KM/H', cx, cy + 32 * d);
    c.font = `700 ${26 * d}px 'Chakra Petch', system-ui, sans-serif`;
    c.fillStyle = gear === -1 ? '#ff3b3b' : '#2ef2ff';
    c.fillText(gear === -1 ? 'R' : String(gear), cx, cy + 72 * d);
    c.font = `600 ${11 * d}px 'Chakra Petch', system-ui, sans-serif`;
    c.fillStyle = 'rgba(255,255,255,0.5)';
    c.fillText('BOOST', cx - 52 * d, cy + 92 * d);
    c.fillText('HULL', cx + 52 * d, cy + 92 * d);
  }
}
