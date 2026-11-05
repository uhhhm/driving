(() => {
  const g = window.game;
  const gen = g.chunks.gen;
  const out = [];
  let dirSign = 0;
  const auto = (speedTarget) => (t, v) => {
    const nr = gen.nearestRoad(v.pos.x, v.pos.z, 80);
    if (!nr) return { throttle: 0.5 };
    const e = nr.edge; let q = nr.idx;
    dirSign = (v.fwd.x * e.tx[q] + v.fwd.z * e.tz[q]) >= 0 ? 1 : -1;
    const ahead = Math.round((8 + v.speedAbs * 0.5) / 3);
    let qa = Math.max(0, Math.min(e.n - 1, q + dirSign * ahead));
    const lane = e.halfW * 0.4 * dirSign;
    const tx = e.x[qa] - e.tz[qa] * lane - v.pos.x, tz = e.z[qa] + e.tx[qa] * lane - v.pos.z;
    const fx = v.fwd.x, fz = v.fwd.z;
    const ang = Math.atan2(fx * tz - fz * tx, fx * tx + fz * tz);
    return { throttle: v.kmh < speedTarget ? 1 : 0, brake: v.kmh > speedTarget + 25 ? 1 : 0, steer: v.groundedCount ? Math.max(-1, Math.min(1, ang * 2.5)) : 0 };
  };
  const kinds = (v) => v.wheels.map(w => w.grounded ? (g.physics.info.get(w.hitCollider)?.kind ?? '?')[0] : '-').join('');
  g.simulate(14, auto(120), (t, v) => {
    const nr = gen.nearestRoad(v.pos.x, v.pos.z, 80);
    out.push(`t=${t.toFixed(1)} kmh=${v.kmh.toFixed(0)} pos=${v.pos.x.toFixed(0)},${v.pos.y.toFixed(1)},${v.pos.z.toFixed(0)} lat=${nr?nr.lateral.toFixed(1):'-'} roadY=${nr?nr.y.toFixed(1):'-'} hw=${nr?nr.edge.halfW:''} wheels=${kinds(v)} comp=${v.wheels.map(w=>w.comp.toFixed(2)).join(',')} upY=${v.up.y.toFixed(2)}`);
  }, 0.5);
  return out.join('\n');
})()
