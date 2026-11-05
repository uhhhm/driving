// Visual tour: teleports to biomes / times / weather and screenshots each.
import { createRequire } from 'module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const scen = JSON.parse(process.argv[2] || '[]');
const seed = process.argv[3] || 'SEEDRUNNER';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = new Set();
page.on('pageerror', (e) => errs.add(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.add(m.text()); });
await page.goto('http://localhost:5173/#seed=' + seed + '&play');
await page.waitForTimeout(5000);
for (const s of scen) {
  const info = await page.evaluate((s) => {
    const g = window.game;
    const gen = g.chunks.gen;
    if (s.biome !== undefined) {
      // search the road graph for an edge in that biome
      outer: for (let r = 0; r < 25; r++) for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
        const e = gen.edge(i, j, 0) || gen.edge(i, j, 1);
        if (!e || e.biome !== s.biome || e.n < 60) continue;
        const q = s.q ?? 30;
        g.player.vehicle.teleport(new g.player.vehicle.pos.constructor(e.x[q], e.h[q] + 1, e.z[q]), Math.atan2(e.tx[q], e.tz[q]), 20);
        g.chunks.ensureSync(e.x[q], e.z[q]);
        g.resetToRoad(true);
        break outer;
      }
    }
    if (s.hours !== undefined) g.sky.hours = s.hours;
    if (s.weather) { g.weather.forced = s.weather; }
    if (s.cam) g.rig.mode = s.cam;
    if (s.event) g.events.start(s.event);
    if (s.chase) g.police.startChase(3);
    if (s.boost) g.input.setVirtual('boost', true);
    g.input.setVirtual('up', !!s.throttle);
    return 'ok';
  }, s).catch((e) => 'ERR ' + e.message);
  await page.waitForTimeout(s.wait ?? 5000);
  await page.screenshot({ path: 'scripts/out/tour-' + s.name + '.png' });
  const st = await page.evaluate(() => { const g = window.game; return `fps=${g.stats.fps.toFixed(0)} kmh=${g.player.vehicle.kmh.toFixed(0)} pos=${g.player.vehicle.pos.x.toFixed(0)},${g.player.vehicle.pos.z.toFixed(0)} biome=${Array.from(g.biomeWeights).map(x=>x.toFixed(2))}`; });
  console.log(s.name, info, st);
}
console.log('errors:', [...errs].slice(0, 10).join('\n'));
await browser.close();
