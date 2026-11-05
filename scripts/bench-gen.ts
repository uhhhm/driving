import { WorldGen } from '../src/world/WorldGen';
const g = new WorldGen(12345);
let t = performance.now();
for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) g.edge(i, j, 0), g.edge(i, j, 1);
console.log('edges', (performance.now() - t).toFixed(1), 'ms');
for (const lod of [0, 1, 2]) {
  t = performance.now();
  let props = 0, tris = 0;
  for (let k = 0; k < 9; k++) {
    const d = g.generateChunk(k % 3, Math.floor(k / 3), lod);
    props += d.props.length / 9; tris += (d.road?.index.length ?? 0) / 3;
  }
  console.log('lod', lod, ((performance.now() - t) / 9).toFixed(1), 'ms/chunk props', props / 9, 'roadtris', tris / 9);
}
const e = g.edge(0, 0, 0)!;
console.log(e && { type: e.type, n: e.n, len: e.len.toFixed(0), sp: e.setPieces.map((s) => s.kind), hmin: Math.min(...e.h), hmax: Math.max(...e.h) });
const counts: Record<string, number> = {};
for (let i = -10; i <= 10; i++) for (let j = -10; j <= 10; j++) for (const d of [0, 1]) { const e = g.edge(i, j, d); if (!e) continue; counts['t' + e.type] = (counts['t' + e.type] ?? 0) + 1; for (const s of e.setPieces) counts[s.kind] = (counts[s.kind] ?? 0) + 1; let b = 0, tu = 0; for (let q = 0; q < e.n; q++) { if (e.flags[q] & 1) b++; if (e.flags[q] & 2) tu++; } if (b) counts.bridgeEdges = (counts.bridgeEdges ?? 0) + 1; if (tu) counts.tunnelEdges = (counts.tunnelEdges ?? 0) + 1; }
console.log(counts);
const bc = [0,0,0,0]; for (let i=-10;i<=10;i++) for (let j=-10;j<=10;j++) bc[g.dominantBiome(i*300,j*300)]++; console.log('biomes', bc);
