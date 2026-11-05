// Web Worker: builds chunk data off the main thread.
import { WorldGen, type Tunables } from './WorldGen';
import type { ChunkData } from './types';

let gen: WorldGen | null = null;

interface Req {
  type: 'init' | 'chunk';
  seed?: number;
  tunables?: Tunables;
  cx?: number;
  cz?: number;
  lod?: number;
  id?: number;
}

function transferables(d: ChunkData): Transferable[] {
  const t: Transferable[] = [d.heights.buffer, d.normals.buffer, d.colors.buffer, d.props.buffer, d.tunnelLights.buffer];
  if (d.surface) t.push(d.surface.buffer);
  for (const m of [d.road, d.structure, d.roadCollider]) {
    if (!m) continue;
    t.push(m.position.buffer, m.normal.buffer, m.index.buffer);
    if (m.uv) t.push(m.uv.buffer);
    if (m.color) t.push(m.color.buffer);
  }
  return t;
}

self.onmessage = (ev: MessageEvent<Req>) => {
  const m = ev.data;
  if (m.type === 'init') {
    gen = new WorldGen(m.seed!, m.tunables);
    return;
  }
  if (m.type === 'chunk' && gen) {
    const d = gen.generateChunk(m.cx!, m.cz!, m.lod!);
    (self as unknown as Worker).postMessage({ id: m.id, data: d }, transferables(d));
  }
};
