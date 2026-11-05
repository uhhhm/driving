(() => {
  const g = window.game;
  const out = [];
  const S = (tag) => (t, v) => out.push(`${tag} t=${t.toFixed(2)} kmh=${v.kmh.toFixed(0)} g=${v.gear} rpm=${v.rpm.toFixed(0)} gr=${v.groundedCount} beta=${(v.slipAngleBody*57.3).toFixed(1)} yawr=${v.angVel.dot(v.up).toFixed(2)} spin=${v.wheelspin.toFixed(2)} drift=${v.drifting?1:0} y=${v.pos.y.toFixed(1)}`);
  g.simulate(8, () => ({ throttle: 1 }), S('accel'), 0.5);
  g.simulate(2.5, (t) => ({ throttle: 1, steer: 1, handbrake: t < 0.5 }), S('hb-drift'), 0.25);
  g.simulate(2, () => ({ throttle: 0.7, steer: -0.3 }), S('counter'), 0.25);
  g.simulate(3, () => ({ brake: 1 }), S('brake'), 0.5);
  return out.join('\n');
})()
