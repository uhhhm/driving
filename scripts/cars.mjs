import { createRequire } from 'module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on('pageerror', (e) => console.log('ERR', e.message));
await page.goto('http://localhost:5173/#seed=SEEDRUNNER&play');
await page.waitForTimeout(7000);
for (const id of (process.argv[2] || 'kitsune,bulldozer,mule,tacovan,couch,bolt').split(',')) {
  await page.evaluate((id) => {
    document.querySelectorAll('.menu').forEach(m => m.classList.add('hidden')); const g = window.game; const v = g.player.vehicle; const V = v.pos.constructor;
    g.sky.hours = 15; g.weather.forced = 'clear'; g.traffic.enabled = false; g.traffic.clear();
    g.spawnPlayer(g.__carById(id), v.pos.clone(), Math.atan2(v.fwd.x, v.fwd.z), 0);
    g.resetToRoad();
    const nv = g.player.vehicle; const yaw = Math.atan2(nv.fwd.x, nv.fwd.z);
    g.rig.photo = true; g.hud.visible = false;
    const c = nv.pos.clone(); const f = nv.fwd.clone(); const r = nv.right.clone();
    g.rig.camera.position.copy(c).addScaledVector(f, 5.5).addScaledVector(r, 4.5).add(new V(0, 1.8, 0));
    g.rig.camera.lookAt(c.clone().add(new V(0, 0.8, 0)));
    g.rig.camera.fov = 50; g.rig.camera.updateProjectionMatrix();
  }, id);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'scripts/out/car-' + id + '.png' });
}
await browser.close();
