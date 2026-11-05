// Shared world-generation types & constants (worker-safe, no three.js).

export const CHUNK = 128; // metres per terrain chunk
export const CELL = 320; // metres per road-graph cell
export const BIOME_CELL = 1500; // metres per biome region cell
export const SAMPLE_DS = 3; // road sample spacing (m)
export const SEA_LEVEL = 0;

export const enum Biome {
  Desert = 0,
  Alpine = 1,
  City = 2,
  Coast = 3,
}
export const BIOME_COUNT = 4;
export const BIOME_NAMES = ['Desert Canyon', 'Alpine Forest', 'Neon City', 'Coastal Cliffs'];

export const enum RoadType {
  Highway = 0,
  Mountain = 1,
  Dirt = 2,
  Avenue = 3,
}

export const enum Surface {
  Asphalt = 0,
  Dirt = 1,
  Grass = 2,
  Sand = 3,
  Snow = 4,
  Rock = 5,
  Ice = 6,
  Concrete = 7,
}
export const SURFACE_NAMES = ['asphalt', 'dirt', 'grass', 'sand', 'snow', 'rock', 'ice', 'concrete'];

export const enum Prop {
  Pine = 0,
  Cactus = 1,
  Palm = 2,
  Rock = 3,
  Building = 4,
  Lamp = 5,
  Cone = 6,
  Barrier = 7,
  Crate = 8,
  Bush = 9,
  Barrel = 10,
  Pump = 11,
  Billboard = 12,
  Fence = 13,
}
export const PROP_COUNT = 14;
export const PROP_STRIDE = 9; // type, x, y, z, yaw, sx, sy, sz, variant

export const enum RoadFlag {
  Bridge = 1,
  Tunnel = 2,
  Crest = 4,
  Stunt = 8,
}

export type SetPieceKind = 'ramp' | 'loop' | 'gas' | 'construction' | 'jam' | 'halfpipe';

export interface SetPiece {
  kind: SetPieceKind;
  edgeKey: string;
  idx: number; // sample index along edge
  x: number;
  y: number;
  z: number;
  yaw: number; // heading of road (radians, atan2(tx, tz))
  side: number; // -1/1 for roadside pieces (right-positive)
  halfW: number;
  param: number; // deterministic random [0,1)
}

export interface RoadEdge {
  key: string;
  ai: number;
  aj: number;
  bi: number;
  bj: number;
  type: RoadType;
  biome: number;
  halfW: number;
  n: number;
  len: number;
  x: Float32Array;
  z: Float32Array;
  h: Float32Array;
  raw: Float32Array; // terrain height under centreline before carving
  bank: Float32Array;
  tx: Float32Array;
  tz: Float32Array;
  s: Float32Array;
  flags: Uint8Array;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  setPieces: SetPiece[];
  noTraffic: boolean;
}

export interface MeshBuffers {
  position: Float32Array;
  normal: Float32Array;
  uv?: Float32Array;
  color?: Float32Array;
  index: Uint32Array;
}

export interface ChunkData {
  cx: number;
  cz: number;
  lod: number;
  res: number;
  heights: Float32Array; // (res+1)^2, row-major: z * (res+1) + x
  normals: Float32Array; // 3 per vertex
  colors: Float32Array; // 3 per vertex
  detail: Float32Array; // 4 per vertex: desert, alpine, coast weight, road-shoulder proximity
  surface: Uint8Array | null; // res*res cells (lod 0 only)
  minH: number;
  maxH: number;
  props: Float32Array; // PROP_STRIDE per prop
  road: MeshBuffers | null; // drivable road surface (uv.x across, uv.y along, color.r = type, color.g = wet-able)
  structure: MeshBuffers | null; // bridges, pillars, rails, tunnel shells (concrete)
  rock: MeshBuffers | null; // rock skin over tunnels
  roadCollider: MeshBuffers | null; // what the car can drive on/hit (road + rails + tunnel interior)
  tunnelLights: Float32Array; // x,y,z triples
  setPieces: SetPiece[];
  biomeMix: Float32Array; // average weight per biome in this chunk
  genMs: number;
}
