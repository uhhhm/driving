import { WorldGen } from '../src/world/WorldGen';
const g = new WorldGen(Number(process.argv[2] ?? 12345));
let edges = 0, crest = 0, bridge = 0, tunnel = 0; const sp: Record<string, number> = {};
for (let i = -10; i <= 10; i++) for (let j = -10; j <= 10; j++) for (const d of [0, 1]) {
  const e = g.edge(i, j, d); if (!e) continue; edges++;
  let c = 0, b = 0, t = 0; for (let q = 0; q < e.n; q++) { if (e.flags[q] & 4) c = 1; if (e.flags[q] & 1) b = 1; if (e.flags[q] & 2) t = 1; }
  crest += c; bridge += b; tunnel += t; for (const s of e.setPieces) sp[s.kind] = (sp[s.kind] ?? 0) + 1;
}
console.log({ edges, crest, bridge, tunnel, ...sp });
