import type { Chunk } from './ChunkManager';
export class SetPieces {
  onChunkLoaded(_c: Chunk) {}
  onChunkUnloaded(_c: Chunk, _r?: Chunk) {}
  onChunkPhysics(_c: Chunk, _on: boolean) {}
}
