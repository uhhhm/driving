(() => { window.__lat = -4.2; window.__secs = 2.6;
  const g = window.game, gen = g.chunks.gen;
  let found = null;
  outer: for (let r = 0; r < 20; r++) for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) for (const d of [0,1]) {
    const e = gen.edge(i, j, d); if (!e) continue;
    const sp = e.setPieces.find(s => s.kind === (window.__kind || 'loop')); if (sp) { found = { e, sp }; break outer; }
  }
  if (!found) return 'no piece';
  const { e, sp } = found;
  const speed = window.__speed || 33;
  const q0 = sp.idx - 30, lat = window.__lat ?? 4.2;
  const V = g.player.vehicle.pos.constructor;
  const p = new V(e.x[q0] - e.tz[q0] * lat, e.h[q0] + 0.8, e.z[q0] + e.tx[q0] * lat);
  g.chunks.ensureSync(sp.x, sp.z); g.chunks.ensureSync(p.x, p.z);
  const yaw = Math.atan2(e.tx[q0], e.tz[q0]);
  g.player.vehicle.teleport(p, yaw, speed);
  g.traffic.clear();
  window.__lookAt = new V(sp.x, sp.y, sp.z); window.__off = [Math.cos(sp.yaw)*45, 22, -Math.sin(sp.yaw)*45];
  const out = [`piece ${sp.kind} at ${sp.x.toFixed(0)},${sp.y.toFixed(1)},${sp.z.toFixed(0)} param=${sp.param.toFixed(2)} hw=${e.halfW}`];
  const kinds = (v) => v.wheels.map(w => w.grounded ? (g.physics.info.get(w.hitCollider)?.kind ?? '?')[0] : '-').join('');
  g.simulate(window.__secs || 7, (t, v) => ({ throttle: 1, steer: 0 }), (t, v) => {
    const rel = v.pos.clone().sub(new V(sp.x, sp.y, sp.z));
    const along = rel.x * Math.sin(sp.yaw) + rel.z * Math.cos(sp.yaw);
    out.push(`t=${t.toFixed(2)} kmh=${v.kmh.toFixed(0)} along=${along.toFixed(1)} h=${(v.pos.y - sp.y).toFixed(1)} upY=${v.up.y.toFixed(2)} w=${kinds(v)} hp=${v.health.toFixed(0)}`);
    if (v.kmh < 60 && !window.__logged && t > 2.5) { window.__logged = 1; g.physics.world.contactPairsWith(v.collider, (c2) => { const i = g.physics.info.get(c2.handle); const tr = c2.translation(); out.push('HIT ' + (i?.kind) + ' shape' + c2.shape.type); g.physics.world.contactPair(v.collider, c2, (m, f) => { for (let k = 0; k < m.numContacts(); k++) { const lp = f ? m.localContactPoint2(k) : m.localContactPoint1(k); const n = m.normal(); out.push(`  pt local ${lp.x.toFixed(2)},${lp.y.toFixed(2)},${lp.z.toFixed(2)} dist ${m.contactDist(k).toFixed(3)} n ${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)} imp ${m.contactImpulse(k).toFixed(0)}`); } }); }); out.push('car ' + v.pos.x.toFixed(1)+','+v.pos.y.toFixed(1)+','+v.pos.z.toFixed(1)); }
  }, 0.05);
  return out.join('\n');
})()
;(() => { const g = window.game; const v = g.player.vehicle; window.__lookAt = v.pos.clone(); const yaw = Math.atan2(v.fwd.x, v.fwd.z); window.__off = [Math.cos(yaw)*9 - Math.sin(yaw)*3, 3, -Math.sin(yaw)*9 - Math.cos(yaw)*3]; })();
(() => {
  const g = window.game;
  const V = g.player.vehicle.pos.constructor;
  const p = window.__lookAt || g.player.vehicle.pos;
  g.rig.photo = true; g.rig.crash = null; g.hud.visible = false; g.paused = true;
  const off = window.__off || [18, 14, 18];
  g.rig.camera.position.set(p.x + off[0], p.y + off[1], p.z + off[2]);
  g.rig.camera.lookAt(new V(p.x, p.y, p.z));
  g.rig.camera.fov = 60; g.rig.camera.updateProjectionMatrix();
  return 'ok';
})()
