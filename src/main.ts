import { Game } from './core/Game';
import { DebugPanel } from './core/Debug';
import { TitleMenu, PauseMenu } from './ui/Menu';
import { AutoPilot } from './game/AutoPilot';
import { audio } from './audio/AudioEngine';
import { carById } from './vehicle/VehicleDefs';
import { bus } from './core/events';
import type { Controls } from './core/Input';

async function boot() {
  const app = document.getElementById('app')!;
  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.innerHTML = 'SEEDRUNNER<small>GROWING A WORLD…</small>';
  document.body.appendChild(loading);

  const game = new Game(app);
  const params = new URLSearchParams(location.hash.slice(1));
  const save = game.save;
  const seed = (params.get('seed') ?? 'SEEDRUNNER').toUpperCase();
  const carId = params.get('car') ?? save.data.car;
  await game.init(seed, carId, save.data.paints[carId] ?? 0);
  (window as unknown as { game: Game; bus: typeof bus }).game = game;
  (window as unknown as { bus: typeof bus }).bus = bus;
  (game as unknown as { __carById: typeof carById }).__carById = carById;
  (window as unknown as { __R: unknown }).__R = (await import('./core/Physics')).RAPIER;
  new DebugPanel(game);

  // attract mode: the menu sits over a live, self-driving world
  const pilot = new AutoPilot(game);
  pilot.active = true;
  game.rig.mode = 'cinematic';
  const realPoll = game.input.poll.bind(game.input);
  game.input.poll = (dt: number, kmh: number): Controls => {
    const c = realPoll(dt, kmh);
    if (!pilot.active) return c;
    return { ...c, ...pilot.controls(dt), reset: false, camera: false, photo: false };
  };
  game.events.enabled = false;
  game.start();
  setTimeout(() => loading.classList.add('done'), 300);

  const title = new TitleMenu(save, seed, false);
  const pause = new PauseMenu();
  const quickstart = params.has('play');

  const drive = async (first: boolean) => {
    const r = quickstart && first ? { seed, car: carId, paint: save.data.paints[carId] ?? 0 } : await title.open();
    title.el.classList.add('hidden');
    audio.start();
    if (r.seed !== game.seedText) {
      location.hash = `seed=${encodeURIComponent(r.seed)}&play`;
      location.reload();
      return;
    }
    if (r.car !== game.player.vehicle.spec.id || r.paint !== game.player.paint) {
      const v = game.player.vehicle;
      game.spawnPlayer(carById(r.car), v.pos.clone().add(v.up.clone().multiplyScalar(0.5)), Math.atan2(v.fwd.x, v.fwd.z), r.paint);
      game.resetToRoad();
    }
    pilot.active = false;
    game.paused = false;
    game.rig.mode = 'chase';
    game.rig.snap(game.player.vehicle);
    game.events.enabled = true;
    game.score.lose();
    game.score.total = 0;
    game.ghost.restart();
    game.input.enabled = true;
    if (!save.data.seen.intro) {
      game.hud.setHint('<kbd>W</kbd> gas · <kbd>A</kbd><kbd>D</kbd> steer · <kbd>SPACE</kbd> drift · <kbd>SHIFT</kbd> boost · <kbd>R</kbd> reset · <kbd>C</kbd> camera · <kbd>P</kbd> pause', 12);
      save.data.seen.intro = true;
      save.write();
    }
    history.replaceState(null, '', `#seed=${encodeURIComponent(game.seedText)}`);
  };

  const endRun = () => {
    const total = game.score.total;
    const best = save.recordBest(game.seedText, total);
    const ghost = game.ghost.commit();
    if (best) bus.emit('toast', { text: 'NEW BEST ON THIS SEED', sub: total.toLocaleString(), color: '#ffd23f', big: true });
    else if (ghost) bus.emit('toast', { text: 'GHOST SAVED', color: '#7ff' });
  };
  window.addEventListener('beforeunload', () => {
    if (!pilot.active) endRun();
  });

  game.onPause = () => {
    if (pilot.active) return;
    if (pause.isOpen) {
      pause.close();
      game.paused = false;
      return;
    }
    game.paused = true;
    const s = save.data.settings;
    pause.open({ seed: game.seedText, volume: s.volume, crashCam: s.crashCam, quality: s.quality, score: game.score.total, best: save.data.bestBySeed[game.seedText] ?? 0 });
  };
  pause.onAction = (a) => {
    const [k, val] = a.split(':');
    const s = save.data.settings;
    switch (k) {
      case 'resume':
        pause.close();
        game.paused = false;
        break;
      case 'reset':
        pause.close();
        game.paused = false;
        game.resetToRoad();
        break;
      case 'garage':
        pause.close();
        endRun();
        pilot.active = true;
        game.paused = false;
        game.rig.mode = 'cinematic';
        game.events.cancel();
        game.police.endChase(false);
        drive(false);
        break;
      case 'share': {
        const url = `${location.origin}${location.pathname}#seed=${encodeURIComponent(game.seedText)}`;
        navigator.clipboard?.writeText(url).catch(() => {});
        bus.emit('toast', { text: 'SEED LINK COPIED', sub: url });
        break;
      }
      case 'photo':
        pause.close();
        game.paused = false;
        game.photo.enter();
        break;
      case 'event':
        pause.close();
        game.paused = false;
        game.events.start();
        break;
      case 'endrun':
        endRun();
        game.score.total = 0;
        game.ghost.restart();
        pause.close();
        game.paused = false;
        break;
      case 'volume':
        s.volume = Number(val);
        audio.setVolume(s.volume);
        save.write();
        break;
      case 'quality':
        s.quality = Number(val);
        game.setQuality(s.quality);
        save.write();
        break;
      case 'crashcam':
        s.crashCam = val === '1';
        game.impacts.crashCamEnabled = s.crashCam;
        save.write();
        break;
    }
  };
  // resume audio on any interaction
  window.addEventListener('pointerdown', () => audio.start());
  window.addEventListener('keydown', () => audio.start());
  drive(true);
}
boot();
