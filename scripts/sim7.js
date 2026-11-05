(() => {
  const g = window.game;
  const gen = g.chunks.gen;
  const log = [];
  for (const k of ['crash','smash','wrecked']) window.bus.on(k, (e) => { const v = g.player.vehicle; const nr = gen.nearestRoad(v.pos.x, v.pos.z, 50); if ((e.impulse||0) > 20) { window.__crashAt = v.pos.clone(); const hits = []; g.physics.world.contactPairsWith(v.collider, (c2) => { const i = g.physics.info.get(c2.handle); g.physics.world.contactPair(v.collider, c2, (m, f) => { if (m.numContacts()) { const lp = f ? m.localContactPoint2(0) : m.localContactPoint1(0); hits.push(i?.kind + ' lp ' + lp.x.toFixed(1) + ',' + lp.y.toFixed(1) + ',' + lp.z.toFixed(1) + ' n ' + m.normal().x.toFixed(2) + ',' + m.normal().y.toFixed(2) + ',' + m.normal().z.toFixed(2) + ' f' + f); } }); }); window.__hits = hits.join(' | ') + ' vel ' + v.vel.x.toFixed(1) + ',' + v.vel.y.toFixed(1) + ',' + v.vel.z.toFixed(1) + ' prev ' + v.prevVel.x.toFixed(1) + ',' + v.prevVel.y.toFixed(1) + ',' + v.prevVel.z.toFixed(1); throw new Error('stop'); } log.push(`${k} imp=${(e.impulse||0).toFixed(1)} kmh=${v.kmh.toFixed(0)} upY=${v.up.y.toFixed(2)} lat=${nr ? nr.lateral.toFixed(1) + '/' + nr.edge.halfW + ' q' + nr.idx + '/' + nr.edge.n + ' fl' + nr.edge.flags[nr.idx] : '-'} gr=${v.groundedCount} kinds=${v.wheels.map(w => w.grounded ? (g.physics.info.get(w.hitCollider)?.kind ?? '?')[0] : '-').join('')}`); });
  let flick = 0;
  const auto = (t, v) => {
    const nr = gen.nearestRoad(v.pos.x, v.pos.z, 80);
    if (!nr) return { throttle: 0.5 };
    const e = nr.edge; const q = nr.idx;
    const dir = (v.fwd.x * e.tx[q] + v.fwd.z * e.tz[q]) >= 0 ? 1 : -1;
    const ahead = Math.round((10 + v.speedAbs * 0.55) / 3);
    const qa = Math.max(0, Math.min(e.n - 1, q + dir * ahead));
    const lane = e.halfW * 0.35 * dir;
    const tx = e.x[qa] - e.tz[qa] * lane - v.pos.x, tz = e.z[qa] + e.tx[qa] * lane - v.pos.z;
    const ang = Math.atan2(v.fwd.x * tz - v.fwd.z * tx, v.fwd.x * tx + v.fwd.z * tz);
    const qb = Math.max(0, Math.min(e.n - 1, q + dir * (ahead + 12)));
    const turn = Math.abs(e.tx[qa] * e.tz[qb] - e.tz[qa] * e.tx[qb]);
    const target = 160 - turn * 260;
    return { throttle: v.kmh < target ? 1 : 0.2, brake: v.kmh > target + 30 ? 0.6 : 0, steer: v.groundedCount ? Math.max(-1, Math.min(1, ang * 2.4)) : 0 };
  };
  g.traffic.enabled = false; g.traffic.clear(); let dm = 0, steps = 0; const _s = g.simulate.bind(g);
  const t0 = performance.now();
  try { g.simulate(40, auto, (t, v) => { steps++; { const nr = gen.nearestRoad(v.pos.x, v.pos.z, 40); (window.__trace ??= []).push(`t${t.toFixed(2)} ${v.kmh.toFixed(0)}kmh dy=${nr ? (v.pos.y - nr.y).toFixed(1) : '-'} e${nr?.edge.key} q${nr?.idx} gr${v.groundedCount} upY${v.up.y.toFixed(2)}`); if (window.__trace.length > 40) window.__trace.shift(); } if (v.driftMode) dm++; g.traffic.update(0.25); g.police.update(0.25); g.impacts.update(0.25); g.events.update(0.25); }, 0.1); } catch (err) {}
  const ms = performance.now() - t0;
  const v = g.player.vehicle;
  return log.slice(0, 40).join('\n') + `\n--- simMs=${ms.toFixed(0)} for 40s; kmh=${v.kmh.toFixed(0)} hp=${v.health.toFixed(0)} total=${g.score.total} pot=${g.score.pot} stats=${JSON.stringify(g.score.stats)} driftFrac=${(dm/steps).toFixed(2)}`;
})()
;(() => { const g = window.game; const v = g.player.vehicle; window.__lookAt = window.__crashAt || v.pos.clone(); const yaw = Math.atan2(v.fwd.x, v.fwd.z); window.__off = [Math.cos(yaw)*14 - Math.sin(yaw)*10, 6, -Math.sin(yaw)*14 - Math.cos(yaw)*10]; })();
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
;window.__hits
;(() => {
  const g = window.game; const R = window.__R; const p = window.__crashAt; const v = g.player.vehicle;
  const d = v.prevVel.clone().setY(0).normalize();
  const out = [];
  for (const back of [6]) for (const h of [-1.5, -0.5, 0, 0.5, 1, 2, 3]) {
    const o = p.clone().addScaledVector(d, -back); o.y += h;
    const hit = g.physics.world.castRayAndGetNormal(new R.Ray(o, d), 20, true, undefined, undefined, undefined, v.body);
    if (hit) { const hp = o.clone().addScaledVector(d, hit.timeOfImpact); out.push(`h${h}: toi ${hit.timeOfImpact.toFixed(2)} ${g.physics.info.get(hit.collider.handle)?.kind} n ${hit.normal.x.toFixed(2)},${hit.normal.y.toFixed(2)},${hit.normal.z.toFixed(2)} at y=${hp.y.toFixed(1)}`); } else out.push(`h${h}: none`);
  }
  const nr = g.chunks.gen.nearestRoad(p.x, p.z, 50); const e = nr.edge;
  out.push(`road y at crash ${nr.y.toFixed(2)} car y ${p.y.toFixed(2)} edge ${e.key} idx ${nr.idx} flags ${Array.from(e.flags.slice(Math.max(0,nr.idx-5), nr.idx+6)).join('')} h ${Array.from(e.h.slice(Math.max(0,nr.idx-5), nr.idx+6)).map(x=>x.toFixed(1)).join(',')} raw ${Array.from(e.raw.slice(Math.max(0,nr.idx-5), nr.idx+6)).map(x=>x.toFixed(0)).join(',')}`);
  return out.join('\n');
})()
;window.__trace.join('\n')
