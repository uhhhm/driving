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
