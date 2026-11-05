(() => {
  const g = window.game;
  const gen = g.chunks.gen;
  const log = [];
  for (const k of ['crash','smash','nearMiss','trick','bank','comboLost','explode','wrecked','reset']) window.bus.on(k, (e) => log.push(`${k} ${JSON.stringify(e).slice(0,90)}`));
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
  const t0 = performance.now();
  g.simulate(40, auto, (t, v) => { g.traffic.update(0.25); g.police.update(0.25); g.impacts.update(0.25); g.events.update(0.25); }, 0.25);
  const ms = performance.now() - t0;
  const v = g.player.vehicle;
  return log.slice(0, 40).join('\n') + `\n--- simMs=${ms.toFixed(0)} for 40s; kmh=${v.kmh.toFixed(0)} hp=${v.health.toFixed(0)} total=${g.score.total} pot=${g.score.pot} stats=${JSON.stringify(g.score.stats)} traffic=${g.traffic.cars.length}`;
})()
