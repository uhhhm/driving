(() => {
  const g = window.game; const gen = g.chunks.gen;
  const { carById } = window.__defs || {};
  const res = [];
  const V = g.player.vehicle.pos.constructor;
  // flat-ish spot: find an avenue or highway edge
  let e = null;
  outer: for (let r = 0; r < 12; r++) for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const x = gen.edge(i, j, 0); if (x && x.n > 80 && (x.type === 3)) { e = x; break outer; } }
  if (!e) outer2: for (let r = 0; r < 12; r++) for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const x = gen.edge(i, j, 0); if (x && x.n > 80) { e = x; break outer2; } }
  // a 2km flat asphalt test pad high in the sky
  if (!window.__pad) { const R = window.__R; const c = g.physics.world.createCollider(R.ColliderDesc.cuboid(1000, 1, 1000).setTranslation(0, 999, 0).setFriction(0.6).setCollisionGroups((1 << 16) | 0xffff)); g.physics.tag(c, { kind: 'road' }); window.__pad = c; }
  const cars = ['kitsune','bulldozer','couch'];
  for (const id of cars) {
    const q = 40;
    g.spawnPlayer(window.game.__carById(id), new V(0, 1001, 0), 0, 0);
    g.traffic.enabled = false; g.traffic.clear(); g.police.clear(); g.events.enabled = false;
    g.chunks.ready = () => true;
    const v = g.player.vehicle;
    v.teleport(new V(0, 1000.9, -300), 0, 26);
    g.simulate(0.5, () => ({ throttle: 1 }));
    const styles = { hold: (t, v) => ({ throttle: 1, steer: 1 }), release: (t, v) => ({ throttle: 1, steer: 0 }), counter: (t, v) => ({ throttle: 1, steer: -0.6 }) };
    const parts = [];
    for (const [name, fn] of Object.entries(styles)) {
      v.teleport(new V(0, 1000.9, -300), 0, 26);
      g.simulate(0.4, () => ({ throttle: 1 }));
      let sumB = 0, n = 0, maxB = 0, drifting = 0; const v0 = v.kmh;
      const betas = []; const yaw0 = Math.atan2(v.vel.x, v.vel.z); let turned = 0, prevY = yaw0, dist = 0;
      g.simulate(3.5, (t, v) => t < 0.35 ? { throttle: 1, steer: 1, handbrake: true } : fn(t, v), (t, v) => { const b = v.slipAngleBody; if (t > 0.5) { sumB += Math.abs(b); n++; maxB = Math.max(maxB, Math.abs(b)); if (v.drifting) drifting++; } if (Math.abs(t*4 - Math.round(t*4)) < 0.01) betas.push(Math.round(b*57.3)); const y = Math.atan2(v.vel.x, v.vel.z); let d = y - prevY; if (d > Math.PI) d -= 2*Math.PI; if (d < -Math.PI) d += 2*Math.PI; turned += d; prevY = y; dist += v.speedAbs * 0.05; }, 0.05);
      parts.push(`${name}: v ${v0.toFixed(0)}->${v.kmh.toFixed(0)} avg ${(sumB/n*57.3).toFixed(0)} max ${(maxB*57.3).toFixed(0)} drift ${(drifting/n).toFixed(2)} turn ${(turned*57.3).toFixed(0)}deg R=${(dist/Math.max(0.01,Math.abs(turned))).toFixed(0)}m [${betas.join(',')}]`);
    }
    res.push(id + '\n   ' + parts.join('\n   '));
  }
  return res.join('\n');
})()
