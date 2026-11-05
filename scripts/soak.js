(async () => {
  const g = window.game;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const errs = [];
  window.addEventListener('error', (e) => errs.push(e.message));
  g.sky.dayLengthSec = 60; // fast cycle
  g.weather.forced = 'storm';
  g.events.start('smash');
  g.police.startChase(3);
  const steer = ['left', 'right'];
  for (let i = 0; i < 40; i++) {
    g.input.setVirtual('up', true);
    g.input.setVirtual(steer[i % 2], i % 3 === 0);
    g.input.setVirtual('handbrake', i % 5 === 0);
    g.input.setVirtual('boost', i % 4 === 0);
    if (i === 15) g.weather.forced = 'snow';
    if (i === 25) { g.weather.forced = null; g.events.start('sprint'); }
    if (i % 10 === 9) g.resetToRoad();
    await wait(1000);
  }
  return `errors=${errs.length} ${errs.slice(0,3).join(' | ')} simTime=${g.simTime.toFixed(0)} hp=${g.player.vehicle.health.toFixed(0)} cops=${g.police.cops.length} heat=${g.police.heat} traffic=${g.traffic.cars.length} chunks=${g.chunks.loadedCount} geoms=${g.renderer.info.memory.geometries} hours=${g.sky.hours.toFixed(1)} weather=${g.weather.kind}`;
})()
