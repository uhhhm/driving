(() => { window.__lat = 4.2;
  const g = window.game, gen = g.chunks.gen;
  let found = null;
  outer: for (let r = 0; r < 20; r++) for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) for (const d of [0,1]) {
    const e = gen.edge(i, j, d); if (!e) continue;
    const sp = e.setPieces.find(s => s.kind === (window.__kind || 'loop')); if (sp) { found = { e, sp }; break outer; }
  }
  if (!found) return 'no piece';
  const { e, sp } = found;
  const speed = window.__speed || 45;
  const q0 = sp.idx - 30, lat = window.__lat ?? 4.2; const startZ = window.__startZ ?? -60;
  const V = g.player.vehicle.pos.constructor;
  const p = new V(e.x[q0] - e.tz[q0] * lat, e.h[q0] + 0.8, e.z[q0] + e.tx[q0] * lat);
  g.chunks.ensureSync(sp.x, sp.z); g.chunks.ensureSync(p.x, p.z);
  const yaw = sp.yaw;
  const ez = g.setPieces.loopEntries.get(sp) ?? -40; const sz = ez + 4; p.set(sp.x + Math.cos(yaw) * -5.1 + Math.sin(yaw) * sz, sp.y + 0.6, sp.z + Math.sin(yaw) * 5.1 + Math.cos(yaw) * sz);
  g.player.vehicle.teleport(p, yaw + Math.atan(10.8 / 230), speed);
  g.traffic.clear();
  window.__lookAt = new V(sp.x, sp.y, sp.z); window.__off = [Math.cos(sp.yaw)*45, 22, -Math.sin(sp.yaw)*45];
  const out = [`piece ${sp.kind} at ${sp.x.toFixed(0)},${sp.y.toFixed(1)},${sp.z.toFixed(0)} param=${sp.param.toFixed(2)} hw=${e.halfW}`];
  const kinds = (v) => v.wheels.map(w => w.grounded ? (g.physics.info.get(w.hitCollider)?.kind ?? '?')[0] : '-').join('');
  const ctl = (t, v) => {
    const rel = v.pos.clone().sub(new V(sp.x, sp.y, sp.z));
    const along = rel.x * Math.sin(sp.yaw) + rel.z * Math.cos(sp.yaw);
    if (true) return { throttle: 1, steer: 0, boost: !!window.__boost };
    // aim at the entry lane point ahead (local x = -4.2)
    const az = Math.min(-10, along + 18), ax = -4.2;
    const tx = sp.x + Math.cos(sp.yaw) * ax + Math.sin(sp.yaw) * az - v.pos.x;
    const tz = sp.z - Math.sin(sp.yaw) * ax + Math.cos(sp.yaw) * az - v.pos.z;
    const ang = Math.atan2(v.fwd.x * tz - v.fwd.z * tx, v.fwd.x * tx + v.fwd.z * tz);
    return { throttle: 1, steer: Math.max(-1, Math.min(1, ang * 3)), boost: !!window.__boost };
  };
  g.simulate(window.__secs || 7, ctl, (t, v) => {
    const rel = v.pos.clone().sub(new V(sp.x, sp.y, sp.z));
    const along = rel.x * Math.sin(sp.yaw) + rel.z * Math.cos(sp.yaw); const lx = rel.x * Math.cos(sp.yaw) - rel.z * Math.sin(sp.yaw);
    out.push(`t=${t.toFixed(2)} kmh=${v.kmh.toFixed(0)} along=${along.toFixed(1)} lx=${lx.toFixed(2)} h=${(v.pos.y - sp.y).toFixed(1)} upY=${v.up.y.toFixed(2)} w=${kinds(v)} hp=${v.health.toFixed(0)}`);
    if (v.health < (window.__lastHp ?? 100) - 5 && (window.__nlog = (window.__nlog||0)+1) < 4) { window.__lastHp = v.health; out.push('IMPACT at t=' + t.toFixed(2)); g.physics.world.contactPairsWith(v.collider, (c2) => { const i = g.physics.info.get(c2.handle); g.physics.world.contactPair(v.collider, c2, (m, f) => { if (m.numContacts()) { const lp = f ? m.localContactPoint2(0) : m.localContactPoint1(0); out.push('  ' + i?.kind + ' local ' + lp.x.toFixed(2) + ',' + lp.y.toFixed(2) + ',' + lp.z.toFixed(2) + ' n ' + m.normal().x.toFixed(2) + ',' + m.normal().y.toFixed(2) + ',' + m.normal().z.toFixed(2)); } }); }); }
    if (false) { window.__logged = 1; g.physics.world.contactPairsWith(v.collider, (c2) => { const i = g.physics.info.get(c2.handle); const tr = c2.translation(); out.push('HIT ' + (i?.kind) + ' shape' + c2.shape.type); g.physics.world.contactPair(v.collider, c2, (m, f) => { for (let k = 0; k < m.numContacts(); k++) { const lp = f ? m.localContactPoint2(k) : m.localContactPoint1(k); const n = m.normal(); out.push(`  pt local ${lp.x.toFixed(2)},${lp.y.toFixed(2)},${lp.z.toFixed(2)} dist ${m.contactDist(k).toFixed(3)} n ${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)} imp ${m.contactImpulse(k).toFixed(0)}`); } }); }); out.push('car ' + v.pos.x.toFixed(1)+','+v.pos.y.toFixed(1)+','+v.pos.z.toFixed(1)); }
  }, 0.05);
  return out.join('\n');
})()
