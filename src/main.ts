import { Game } from './core/Game';

async function boot() {
  const app = document.getElementById('app')!;
  const game = new Game(app);
  const params = new URLSearchParams(location.hash.slice(1));
  await game.init(params.get('seed') ?? 'SEEDRUNNER', params.get('car') ?? 'kitsune');
  game.start();
  (window as unknown as { game: Game }).game = game;
}
boot();
