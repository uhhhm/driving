# SEEDRUNNER — Design Doc

> An infinite, seed-generated arcade driving playground. Burnout's crashes, Crazy Taxi's
> energy, Trackmania's stunts, a dash of BeamNG chaos. Every seed is a road trip nobody
> has driven before — and every seed can be shared.

## Pillars

1. **Handling first.** The car must feel weighty, grippy, and *throwable*. Drifts are easy to
   start, easy to hold, and rewarding to chain. Crashes are spectacular, never frustrating.
2. **Something every second.** Traffic to thread, crests to launch off, props to smash,
   events popping up, cops on your tail, weather rolling in.
3. **The world is the content.** Procedural biomes, roads, landmarks and set pieces —
   deterministic per seed so a great seed is worth sharing.
4. **Juice everything.** FOV punches, shake, slow-mo, sparks, squeal, pop-in combo text.

## Core loop

```
 drive ──► do something cool (drift / near-miss / air / flip / smash / speed)
   ▲              │
   │              ▼
   │        score × combo multiplier (chain within 2.5 s or it banks)
   │              │
   │              ▼
   └── bank score ► credits ► unlock cars, paint, upgrades (localStorage)
           ▲
           └── procedural events (sprints, smash-fests, speed-traps, police heat)
```

* Combo: every trick adds to the pending pot and bumps the multiplier. Stop doing tricks
  for ~2.5 s and the pot banks. Crash hard and the pot is **lost** — risk vs. reward.
* Events are generated from what's around you (a checkpoint sprint follows the real road
  graph; smash-fests spawn near prop-dense areas; police spawn behind you on highways).

## World

* **Seed → everything.** `hash(seed, x, z, salt)` drives terrain noise, the road graph,
  props, set pieces, traffic spawn and region names. The seed lives in the URL (`#seed=`)
  and on the car's licence plate.
* **Terrain**: 128 m chunks streamed around the player, built in a Web Worker. Near chunks
  are full-res with Rapier heightfield colliders; far chunks are low-res and visual only.
* **Biomes** (smooth-Voronoi regions ~1.5 km across, blended at the borders):
  | Biome           | Terrain                    | Roads                        | Props                         |
  |-----------------|----------------------------|------------------------------|-------------------------------|
  | Desert Canyon   | terraced mesas, dry washes | dusty highways, dirt trails  | cacti, boulders, arches       |
  | Alpine Forest   | big ridged mountains       | switchbacks, tunnels, bridges| pines (breakable), rocks, snow|
  | Neon City       | flat plateau               | straight grid, wide avenues  | towers w/ neon, lamps, cones  |
  | Coastal Cliffs  | cliffs dropping to the sea | coastal highway, bridges     | palms, lighthouses, rocks     |
* **Road network**: a jittered grid graph (one node per 320 m cell). Each edge is a
  Catmull-Rom spline with per-biome wiggle (switchbacks in the mountains, dead straight
  in the city). An elevation profile is sampled from the terrain, smoothed and
  grade-limited, then deliberately given *crests* for air. Corners are banked by
  curvature. Where the road floats far above terrain it becomes a **bridge** (deck +
  pillars); where it is buried it becomes a **tunnel** (cut + lit concrete tube).
  Terrain is carved to the road, the road ribbon is a trimesh collider.
* **Set pieces** on road edges: giant ramps, loop-the-loops, half-pipe bowls, gas stations
  (explode!), construction zones (cones, barriers, plank ramps), traffic jams.
* **Sky**: physically-flavoured gradient sky shader, sun/moon, stars, 12-min day cycle.
  **Weather** state machine: clear → fog → rain/snow (snow in alpine). Wetness/snow
  reduces grip, fog density follows, headlights light the fog at night.

## Vehicle

Custom raycast-wheel vehicle on a Rapier rigid body (we own the tyre model — arcade feel
is all in the tyre model):

* Per wheel: ray along body-down → spring/damper suspension → load `N`.
* Lateral grip: impulse that cancels contact lateral velocity, clamped to
  `μ(surface, weather) · N · curve(slipAngle)`; the curve peaks around 8° then falls off
  to a car-specific *drift plateau* — that plateau is what makes drifts holdable.
* Longitudinal: engine torque curve × gear × final drive, auto gearbox with real shift
  pauses, brakes, handbrake kills rear grip.
* Arcade helpers (tunable): yaw-rate stabiliser, counter-steer assist, drift speed
  retention, downforce that grows with speed (lets loops work), anti-roll bars.
* Air control: pitch (throttle/brake), roll (steer), yaw (steer + handbrake).
* Boost: thrust + FOV punch + radial blur + shake. Refilled by tricks.
* Damage: car mesh vertices deform toward impact points (cheap CPU deform of a few
  hundred verts), panels (bumpers, doors, hood, spoiler) detach above thresholds and become
  physics debris; smoke when health is low. Reset with `R`.

Cars: **Kitsune** (light drift car), **Bulldozer** (heavy muscle), **Mule** (off-road truck,
long travel), **Couch** (an actual sofa with a jet engine), and unlockables.

## Architecture

```
src/
  core/      Game loop, fixed-step clock, input (kb + gamepad), seeded RNG/noise, save, debug GUI
  world/     WorldGen (pure, worker-safe), ChunkManager, RoadNetwork, Biomes, Props, SetPieces,
             Sky, Weather, Traffic, Water
  vehicle/   VehicleDefs, Vehicle (physics), CarModel (procedural mesh + damage)
  camera/    CameraRig (chase, hood, look-back, crash cam, photo)
  audio/     AudioEngine (engine synth, tyres, wind, impacts, sirens, ambience)
  fx/        Particles (GPU points), SkidMarks (ring buffer), PostFX, Shake
  game/      Score/Combo, Events, Police, Ghost, Progression, PhotoMode
  ui/        HUD, Minimap, Menus (garage, pause), Toasts
```

* All world generation is **pure functions of (seed, coords)** → identical in worker and
  main thread, deterministic, shareable.
* Physics at a fixed 120 Hz with interpolation for rendering; render at display rate.
* Systems talk through a tiny typed event bus (`crash`, `trick`, `nearMiss`, `smash`…), so
  audio / score / camera / HUD are decoupled.

## Milestones

1. **Vertical slice** — one biome, road graph, terrain streaming, one car with great
   handling, chase cam, speedo. *Play-test & tune.*
2. **World** — 4 biomes, props, sky/day-night, fog, post FX, particles, skids, audio.
3. **Chaos** — traffic, near-misses, smashables, damage, crash cam, boost, score/combo.
4. **Game** — events, police, set pieces, weather/grip, progression/garage, ghosts,
   photo mode, minimap, debug panel.
5. **Polish & perf** — profiling, LOD, instancing, README.
