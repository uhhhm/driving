(async () => {
  const g = window.game;
  const errs = [];
  g.renderer.setPixelRatio(0.1); g.autoRes = false; g.renderer.shadowMap.enabled = false; g.sky.sun.castShadow = false; g.postfx.enabled = false;
  g.sky.dayLengthSec = 90;
  g.police.startChase(3);
  g.events.start('smash');
  const t0 = performance.now();
  let frames = 0, maxFrame = 0;
  const steer = ['left', 'right'];
  for (let i = 0; i < 3600 && performance.now() - t0 < 200000; i++) {
    const sec = Math.floor(i / 60);
    g.input.setVirtual('up', true);
    g.input.setVirtual(steer[sec % 2], sec % 3 === 0);
    g.input.setVirtual('handbrake', sec % 7 === 0 && i % 60 < 15);
    g.input.setVirtual('boost', sec % 4 === 0);
    if (i === 900) g.weather.forced = 'storm';
    if (i === 1800) { g.weather.forced = 'snow'; g.events.start('sprint'); }
    if (i === 2700) { g.weather.forced = null; g.events.start('drift'); }
    if (i % 600 === 599) g.resetToRoad();
    g['last'] = performance.now() - 1000 / 60;
    const f0 = performance.now();
    try { g.frame(); } catch (e) { errs.push(String(e && e.stack || e).slice(0, 300)); if (errs.length > 3) break; }
    maxFrame = Math.max(maxFrame, performance.now() - f0);
    frames++;
    if (i % 120 === 0) await new Promise(r => setTimeout(r, 0));
  }
  const v = g.player.vehicle;
  return `frames=${frames} errors=${errs.length} ${errs.join(' || ')} simTime=${g.simTime.toFixed(0)} pos=${v.pos.x.toFixed(0)},${v.pos.y.toFixed(0)},${v.pos.z.toFixed(0)} hp=${v.health.toFixed(0)} score=${g.score.total} stats=${JSON.stringify(g.score.stats)} cops=${g.police.cops.length} heat=${g.police.heat} traffic=${g.traffic.cars.length} chunks=${g.chunks.loadedCount} geoms=${g.renderer.info.memory.geometries} colliders=${g.physics.world.colliders.len()} bodies=${g.physics.world.bodies.len()} hours=${g.sky.hours.toFixed(1)} event=${g.events.active?.title} credits=${g.save.data.credits}`;
})()
