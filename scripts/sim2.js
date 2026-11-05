(() => {
  const g = window.game;
  const gen = g.chunks.gen;
  const out = [];
  let dirSign = 0;
  const auto = (speedTarget, extra = {}) => (t, v) => {
    const nr = gen.nearestRoad(v.pos.x, v.pos.z, 80);
    if (!nr) return { throttle: 0.5 };
    const e = nr.edge; let q = nr.idx;
    if (!dirSign) dirSign = (v.fwd.x * e.tx[q] + v.fwd.z * e.tz[q]) >= 0 ? 1 : -1;
    const ahead = Math.round((8 + v.speedAbs * 0.5) / 3);
    let qa = Math.max(0, Math.min(e.n - 1, q + dirSign * ahead));
    const tx = e.x[qa] - e.tz[qa] * (-e.halfW * 0.4 * dirSign) - v.pos.x, tz = e.z[qa] + e.tx[qa] * (-e.halfW * 0.4 * dirSign) - v.pos.z;
    const fx = v.fwd.x, fz = v.fwd.z;
    const cross = fx * tz - fz * tx, dot = fx * tx + fz * tz;
    const ang = Math.atan2(cross, dot); // + means target to the left
    const steer = Math.max(-1, Math.min(1, -ang * 2.5));
    const thr = v.kmh < speedTarget ? 1 : 0;
    return { throttle: thr, brake: v.kmh > speedTarget + 20 ? 1 : 0, steer, ...((typeof extra === 'function') ? extra(t, v) : extra) };
  };
  const S = (tag) => (t, v) => out.push(`${tag} t=${t.toFixed(2)} kmh=${v.kmh.toFixed(0)} g=${v.gear} gr=${v.groundedCount} beta=${(v.slipAngleBody*57.3).toFixed(1)} yawr=${v.angVel.dot(v.up).toFixed(2)} spin=${v.wheelspin.toFixed(2)} drift=${v.drifting?1:0} air=${v.airTime.toFixed(2)} y=${v.pos.y.toFixed(1)} hp=${v.health}`);
  g.simulate(12, auto(140), S('cruise'), 1);
  // handbrake drift test: from speed, yank the handbrake + full steer, then hold steer with throttle
  g.simulate(3, (t, v) => ({ throttle: 1, steer: 1, handbrake: t < 0.35 }), S('drift'), 0.2);
  g.simulate(2, (t, v) => ({ throttle: 0.6, steer: 0 }), S('exit'), 0.25);
  return out.join('\n');
})()
