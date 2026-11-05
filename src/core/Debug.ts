// Live tuning panel (toggle with ` or F1).
import GUI from 'lil-gui';
import type { Game } from './Game';
import type { WeatherKind } from '../world/Weather';

export class DebugPanel {
  gui: GUI;
  constructor(private game: Game) {
    const g = game;
    this.gui = new GUI({ title: 'SEEDRUNNER · TUNING' });
    this.gui.hide();
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Backquote' || e.code === 'F1') {
        e.preventDefault();
        this.gui._hidden ? this.gui.show() : this.gui.hide();
        g.hud.showDebug = !this.gui._hidden;
      }
    });

    const veh = this.gui.addFolder('Vehicle (live)');
    const v = () => g.player.vehicle;
    const t = { gripMul: 1, powerMul: 1, assistMul: 1, airMul: 1, springMul: 1, slideMul: 1 };
    for (const k of Object.keys(t) as (keyof typeof t)[]) {
      veh.add(t, k, 0.2, 2.5, 0.01).onChange((val: number) => (v().tune[k] = val));
    }
    const spec = {
      get torque() { return v().spec.torque; }, set torque(x: number) { v().spec.torque = x; },
      get gripF() { return v().spec.gripF; }, set gripF(x: number) { v().spec.gripF = x; },
      get gripR() { return v().spec.gripR; }, set gripR(x: number) { v().spec.gripR = x; },
      get slide() { return v().spec.slide; }, set slide(x: number) { v().spec.slide = x; },
      get peakSlip() { return v().spec.peakSlip; }, set peakSlip(x: number) { v().spec.peakSlip = x; },
      get maxSteer() { return v().spec.maxSteer; }, set maxSteer(x: number) { v().spec.maxSteer = x; },
      get driftAssist() { return v().spec.driftAssist; }, set driftAssist(x: number) { v().spec.driftAssist = x; },
      get stability() { return v().spec.stability; }, set stability(x: number) { v().spec.stability = x; },
      get downforce() { return v().spec.downforce; }, set downforce(x: number) { v().spec.downforce = x; },
      get boostForce() { return v().spec.boostForce; }, set boostForce(x: number) { v().spec.boostForce = x; },
      get drag() { return v().spec.drag; }, set drag(x: number) { v().spec.drag = x; },
    };
    const sf = veh.addFolder('Spec');
    sf.add(spec, 'torque', 100, 2000, 10);
    sf.add(spec, 'gripF', 0.4, 2, 0.01);
    sf.add(spec, 'gripR', 0.4, 2, 0.01);
    sf.add(spec, 'slide', 0.3, 1, 0.01);
    sf.add(spec, 'peakSlip', 0.05, 0.4, 0.01);
    sf.add(spec, 'maxSteer', 0.2, 1, 0.01);
    sf.add(spec, 'driftAssist', 0, 1.5, 0.01);
    sf.add(spec, 'stability', 0, 2, 0.01);
    sf.add(spec, 'downforce', 0, 6, 0.1);
    sf.add(spec, 'boostForce', 0, 3, 0.05);
    sf.add(spec, 'drag', 0.1, 2, 0.01);
    sf.close();
    veh.add({ refill: () => { v().boost = v().spec.boostCapacity; v().health = 100; g.player.model.repair(); } }, 'refill').name('Repair + refill boost');

    const world = this.gui.addFolder('World gen (regenerates)');
    const wt = { ...g.chunks.gen.t };
    const regen = () => g.regenerateWorld(wt);
    world.add(wt, 'heightScale', 0.2, 2.5, 0.05).onFinishChange(regen);
    world.add(wt, 'crestHeight', 0, 3, 0.05).onFinishChange(regen);
    world.add(wt, 'bankStrength', 0, 3, 0.05).onFinishChange(regen);
    world.add(wt, 'propDensity', 0, 3, 0.05).onFinishChange(regen);
    world.add(wt, 'wiggle', 0, 2.5, 0.05).onFinishChange(regen);
    world.add(g.chunks, 'viewRadius', 3, 9, 1).name('view radius (chunks)');
    world.close();

    const env = this.gui.addFolder('Environment');
    env.add(g.sky, 'hours', 0, 24, 0.1).listen().name('time of day');
    env.add(g.sky, 'dayLengthSec', 60, 3600, 10).name('day length (s)');
    env.add(g.sky, 'paused').name('freeze time');
    const w = { weather: 'auto' };
    env.add(w, 'weather', ['auto', 'clear', 'cloudy', 'fog', 'rain', 'storm', 'snow']).onChange((k: string) => (g.weather.forced = k === 'auto' ? null : (k as WeatherKind)));
    env.add(g.traffic, 'density', 0, 2, 0.05).name('traffic density');
    env.add(g.events, 'enabled').name('random events');
    env.add({ chase: () => g.police.startChase(2) }, 'chase').name('Start police chase');
    env.add({ ev: () => g.events.start() }, 'ev').name('Start random event');

    const gfx = this.gui.addFolder('Graphics & camera');
    gfx.add(g.postfx, 'enabled').name('post-processing');
    gfx.add(g.rig, 'fovBase', 50, 100, 1).name('base FOV');
    gfx.add({ q: g.quality }, 'q', 0, 2, 1).name('quality').onChange((q: number) => g.setQuality(q));
    gfx.add(g.impacts, 'crashCamEnabled').name('crash cam');
    gfx.close();
  }
}
