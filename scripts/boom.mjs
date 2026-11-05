import { createRequire } from 'module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('ERR', e.message));
await page.goto('http://localhost:5173/#seed=SEEDRUNNER&play');
await page.waitForTimeout(7000);
const info = await page.evaluate(() => {
  document.querySelectorAll('.menu').forEach(m => m.classList.add('hidden'));
  const g = window.game, gen = g.chunks.gen; const V = g.player.vehicle.pos.constructor;
  g.sky.hours = 17.5; g.weather.forced = 'clear';
  let sp = null;
  outer: for (let r = 0; r < 10; r++) for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) for (const d of [0,1]) { const e = gen.edge(i,j,d); if (!e) continue; const s = e.setPieces.find(s => s.kind === 'gas'); if (s) { sp = s; break outer; } }
  const fx = Math.sin(sp.yaw), fz = Math.cos(sp.yaw), rx = -fz, rz = fx;
  const lat = sp.side * (sp.halfW + 15 - 3.5);
  const target = new V(sp.x + rx * lat, sp.y, sp.z + rz * lat);
  const start = target.clone().addScaledVector(new V(fx, 0, fz), -28);
  g.chunks.ensureSync(target.x, target.z);
  g.player.vehicle.teleport(start.setY(sp.y + 0.8), sp.yaw, 22);
  g.rig.snap(g.player.vehicle);
  g.input.setVirtual('up', true);
  return 'gas at ' + target.x.toFixed(0) + ',' + target.z.toFixed(0);
});
console.log(info);
for (const t of [2600, 1200, 1500]) { await page.waitForTimeout(t); await page.screenshot({ path: 'scripts/out/boom-' + t + '.png' }); }
await browser.close();
