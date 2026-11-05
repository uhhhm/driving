import RAPIER from '@dimforge/rapier3d-compat';

export { RAPIER };

export const G_WORLD = 0x0001;
export const G_CAR = 0x0002;
export const G_TRAFFIC = 0x0004;
export const G_DEBRIS = 0x0008;
export const G_BREAKABLE = 0x0010;

/** membership (what I am) / filter (what I collide with) */
export const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff);

export type ColliderKind = 'terrain' | 'road' | 'static' | 'breakable' | 'traffic' | 'debris' | 'car' | 'setpiece';

export interface ColliderInfo {
  kind: ColliderKind;
  surface?: number; // road surface
  chunk?: { surfaceAt(x: number, z: number): number };
  ref?: unknown; // owning object (breakable prop, traffic car...)
}

export class Physics {
  world!: RAPIER.World;
  events!: RAPIER.EventQueue;
  info = new Map<number, ColliderInfo>();
  readonly fixedDt = 1 / 120;

  async init() {
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: -9.81 * 1.6, z: 0 }); // arcade gravity: snappier jumps
    this.world.timestep = this.fixedDt;
    this.world.integrationParameters.numSolverIterations = 4;
    this.events = new RAPIER.EventQueue(true);
  }

  tag(c: RAPIER.Collider, info: ColliderInfo) {
    this.info.set(c.handle, info);
  }

  removeCollider(c: RAPIER.Collider) {
    this.info.delete(c.handle);
    this.world.removeCollider(c, false);
  }

  removeBody(b: RAPIER.RigidBody) {
    for (let i = 0; i < b.numColliders(); i++) this.info.delete(b.collider(i).handle);
    this.world.removeRigidBody(b);
  }
}
