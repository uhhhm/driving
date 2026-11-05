(async () => {
  const g = window.game;
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  g.input.setVirtual('up', true);
  await wait(3000);
  const info = g.renderer.info;
  // CPU timing of non-render work per frame
  const t0 = performance.now(); let n = 0;
  const p0 = g.stats.physMs;
  const sc = g.scene; let meshes = 0, inst = 0, instCount = 0, visible = 0;
  sc.traverse(o => { if (o.isMesh) { meshes++; if (o.visible) visible++; if (o.isInstancedMesh) { inst++; instCount += o.count; } } });
  return JSON.stringify(Object.fromEntries(Object.entries(g.prof).map(([k,v])=>[k,+v.toFixed(2)]))) + ` calls=${info.render.calls} tris=${(info.render.triangles/1000).toFixed(0)}k geoms=${info.memory.geometries} tex=${info.memory.textures} programs=${info.programs.length} meshes=${meshes} visible=${visible} instanced=${inst} instances=${instCount} chunks=${g.chunks.loadedCount} physMs=${g.stats.physMs.toFixed(2)} frameMs=${g.stats.frameMs.toFixed(1)} renderMs=${g.stats.renderMs.toFixed(1)} genMs=${g.chunks.stats.genMs.toFixed(1)} colliders=${g.physics.world.colliders.len()} bodies=${g.physics.world.bodies.len()}`;
})()
