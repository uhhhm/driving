(async () => {
  const g = window.game, v = g.player.vehicle, inp = g.input;
  const log = [];
  const sample = (t) => log.push({ t, kmh: Math.round(v.kmh), gear: v.gear, rpm: Math.round(v.rpm), gr: v.groundedCount, beta: +(v.slipAngleBody*57.3).toFixed(1), y: +v.pos.y.toFixed(1), upY: +v.up.y.toFixed(2), drift: v.drifting });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  inp.setVirtual('up', true);
  for (let i = 0; i < 12; i++) { await wait(500); sample(i*0.5); }
  inp.setVirtual('right', true); inp.setVirtual('handbrake', true);
  await wait(400); sample('hb'); inp.setVirtual('handbrake', false);
  for (let i = 0; i < 6; i++) { await wait(300); sample('drift'+i); }
  inp.setVirtual('right', false);
  for (let i = 0; i < 4; i++) { await wait(400); sample('rec'+i); }
  inp.setVirtual('up', false); inp.setVirtual('down', true);
  for (let i = 0; i < 6; i++) { await wait(400); sample('brk'+i); }
  return log.map(o => JSON.stringify(o)).join('\n') + '\nsimTime ' + g.simTime.toFixed(1) + ' fps ' + g.stats.fps.toFixed(0);
})()
