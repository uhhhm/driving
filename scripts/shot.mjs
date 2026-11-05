// Usage: node scripts/shot.mjs <hash> <outPrefix> [evalScriptFile] [waitMs]
import { createRequire } from 'module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
import fs from 'fs';
const [hash = 'seed=SEEDRUNNER', out = 'scripts/out/shot', evalFile, waitMs = '6000'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(`http://localhost:5173/#${hash}`);
await page.waitForTimeout(Number(waitMs));
if (evalFile) {
  const code = fs.readFileSync(evalFile, 'utf8');
  const res = await page.evaluate(code);
  if (res !== undefined) console.log('EVAL:', typeof res === 'string' ? res : JSON.stringify(res, null, 1));
}
await page.screenshot({ path: `${out}.png` });
console.log([...new Set(logs)].slice(0, 30).map(s=>s.slice(0,600)).join('\n'));
await browser.close();
