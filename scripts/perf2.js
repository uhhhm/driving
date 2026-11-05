(async () => {
  const g = window.game;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  g.player.vehicle.spec.boostCapacity = 999; g.player.vehicle.boost = 999;
  g.input.setVirtual('up', true); g.input.setVirtual('boost', true);
  await wait(2000);
  g.profMax = {};
  const frames = []; let last = performance.now();
  const t0 = performance.now();
  while (performance.now() - t0 < 10000) { await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); frames.push(g.stats.frameMs); last = n; }
  frames.sort((a,b)=>a-b);
  return `kmh=${g.player.vehicle.kmh.toFixed(0)} frames=${frames.length} p50=${frames[frames.length>>1].toFixed(1)} p95=${frames[Math.floor(frames.length*0.95)].toFixed(1)} max=${frames[frames.length-1].toFixed(1)} chunks=${g.chunks.loadedCount} pending=${g.chunks.pendingCount} max=${JSON.stringify(Object.fromEntries(Object.entries(g.profMax).map(([k,v])=>[k,+v.toFixed(1)])))}`;
})()
