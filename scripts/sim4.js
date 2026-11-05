(() => {
  const g = window.game;
  const gen = g.chunks.gen;
  const out = [];
  const auto = (speedTarget) => (t, v) => {
    const nr = gen.nearestRoad(v.pos.x, v.pos.z, 80);
    if (!nr) return { throttle: 0.5 };
    const e = nr.edge; let q = nr.idx;
    const dirSign = (v.fwd.x * e.tx[q] + v.fwd.z * e.tz[q]) >= 0 ? 1 : -1;
    const ahead = Math.round((8 + v.speedAbs * 0.5) / 3);
    let qa = Math.max(0, Math.min(e.n - 1, q + dirSign * ahead));
    const lane = e.halfW * 0.4 * dirSign;
    const tx = e.x[qa] - e.tz[qa] * lane - v.pos.x, tz = e.z[qa] + e.tx[qa] * lane - v.pos.z;
    const ang = Math.atan2(v.fwd.x * tz - v.fwd.z * tx, v.fwd.x * tx + v.fwd.z * tz);
    return { throttle: v.kmh < speedTarget ? 1 : 0, brake: v.kmh > speedTarget + 25 ? 1 : 0, steer: v.groundedCount ? Math.max(-1, Math.min(1, ang * 2.5)) : 0 };
  };
  let prev = 0;
  g.simulate(13, auto(120), (t, v) => {
    if (prev - v.speedAbs > 3) {
      const hits = [];
      g.physics.world.contactPairsWith(v.collider, (c2) => { const i = g.physics.info.get(c2.handle); const tr = c2.translation(); hits.push((i?.kind ?? '?') + '@' + tr.x.toFixed(0) + ',' + tr.y.toFixed(0) + ',' + tr.z.toFixed(0) + ' shape' + c2.shape.type); });
      const nr = gen.nearestRoad(v.pos.x, v.pos.z, 80);
      out.push(`t=${t.toFixed(2)} dv=${(prev - v.speedAbs).toFixed(1)} pos=${v.pos.x.toFixed(1)},${v.pos.y.toFixed(1)},${v.pos.z.toFixed(1)} hits=${hits.join(' ')} edge=${nr?.edge.key} idx=${nr?.idx}/${nr?.edge.n} flags=${nr?.edge.flags[nr.idx]}`);
    }
    prev = v.speedAbs;
  }, 1/120);
  return out.slice(0, 20).join('\n');
})()
