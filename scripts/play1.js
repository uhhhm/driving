(async () => {
  const g = window.game;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  g.input.setVirtual('up', true);
  await wait(6000);
  return `kmh=${g.player.vehicle.kmh.toFixed(0)} fps=${g.stats.fps.toFixed(0)} traffic=${g.traffic.cars.length} chunks=${g.chunks.loadedCount} calls=${g.renderer.info.render.calls} tris=${g.renderer.info.render.triangles} score=${g.score.total} pot=${g.score.pot} hp=${g.player.vehicle.health.toFixed(0)}`;
})()
