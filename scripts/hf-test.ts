import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();
const w = new RAPIER.World({ x: 0, y: -9.8, z: 0 });
const N = 4; // subdivisions
const heights = new Float32Array((N + 1) * (N + 1));
// put a spike at grid (ix=1, iz=3) using index iz + ix*(N+1)  (column-major guess)
for (let ix = 0; ix <= N; ix++) for (let iz = 0; iz <= N; iz++) heights[iz + ix * (N + 1)] = ix * 10 + iz; // h = 10*ix + iz
w.createCollider(RAPIER.ColliderDesc.heightfield(N, N, heights, { x: 4, y: 1, z: 4 }));
w.step();
for (const [x, z] of [[-1.99, -1.99], [1.99, -1.99], [-1.99, 1.99], [0, 0], [1.99,1.99]]) {
  const hit = w.castRay(new RAPIER.Ray({ x, y: 100, z }, { x: 0, y: -1, z: 0 }), 200, true);
  console.log(x, z, hit ? (100 - hit.timeOfImpact).toFixed(2) : null);
}
