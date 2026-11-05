# SEEDRUNNER

**An infinite, procedurally generated arcade driving game for the browser.**
Burnout's crashes, Crazy Taxi's energy, Trackmania's stunts and a dash of BeamNG chaos — on a
world grown from a seed you can share.

Type a seed (or roll a random one, or take the daily), pick a car and go. Desert canyons, alpine
switchbacks, a neon city where it's always night, and coastal cliffs blend into each other forever.
Drift, thread traffic, launch off crests, loop the loops, smash gas stations, outrun the cops.

```
three.js · TypeScript · Vite · Rapier (WASM physics) · Web Audio · Web Workers
```

## Run it

Requires Node 18+.

```bash
npm install
```

```bash
npm run dev
```

Open the printed URL (default <http://localhost:5173>). Production build:

```bash
npm run build
```

```bash
npm run preview
```

Share a world by URL: `http://localhost:5173/#seed=NEON-4242` (add `&play` to skip the menu).

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Throttle / brake (hold to reverse) | `W` / `S` (or arrows) | RT / LT |
| Steer | `A` / `D` | Left stick |
| Handbrake — **drift** | `Space` | A or RB |
| Boost | `Shift` (or `N`) | X or B |
| Air control: flip / roll | `W` `S` / `A` `D` while airborne | same |
| Air spin (yaw) | `Space` + `A` `D` while airborne | same |
| Camera (chase / far / hood / cinematic) | `C` | Y |
| Look back | `B` | LB / L3 |
| Reset to road | `R` | Back / D-pad down |
| Horn (scares birds) | `H` | R3 |
| Radio on/off | `M` | — |
| Photo mode | `F` | D-pad up |
| Pause | `P` / `Esc` | Start |
| Debug / tuning panel | `` ` `` or `F1` | — |

**Drifting:** tap the handbrake (or brake-tap with throttle, or flick the car) while turning to
start a slide. Then *steer into the turn* to deepen the angle and tighten your line, *let go* to
hold a smooth slide, and *counter-steer* to straighten out. Keep the throttle in to keep it flowing.

**Air:** inputs you were already holding when you left the ground are ignored until you release
them, so you never flip by accident — press `W`/`S` fresh in the air for flips, `A`/`D` for barrel
rolls. Land on your wheels to bank the trick.

**Photo mode:** `WASD`/`QE` fly, drag to look, mouse wheel for FOV, `[` `]` time of day,
`T` filters, `G` hide HUD, `Enter` saves a PNG.

## The game

* **Free roam is the game.** Everything cool you do feeds a combo pot: drifts, near misses, big
  air, flips/rolls/spins, clean landings, smashing props, takedowns, sustained 200+ km/h. Each
  trick bumps the multiplier (up to ×10). Stay calm for ~2.6 s and the pot banks into score and
  credits — crash hard, land on your roof or get busted and you lose it.
* **Procedural events** pop up as you drive: *Checkpoint Sprint* (gates along the real road graph,
  with sky beacons), *Smash Fest*, *Speed Demon* (stay above 150), *Drift King*, *Hang Time*,
  *Needle Threader* (near misses) and *Hot Pursuit*.
* **Police:** speed past a roadside speed trap or cause enough mayhem and you're wanted. Heat
  rises over time and with every cop takedown; more and faster interceptors join. Get out of
  range for 10 s to escape (reward) — stop near a cop and you're busted (fine, combo lost).
* **Traffic** follows the road graph with lanes and car-following; some drivers weave. Hit them
  and they become tumbling physics wrecks (takedowns). Highway pile-ups (jams) appear too.
* **Set pieces:** helix loop-the-loops (clothoid, ~30 m tall), table-top kicker ramps, half-pipes,
  gas stations with explosive pumps, construction zones with plank kickers, traffic jams.
* **Progression** (saved in `localStorage`): credits buy cars, paints and upgrades (engine, grip,
  boost, armour — 3 levels each). Best score per seed is tracked.
* **Ghosts:** your best run on each seed is recorded and replays as a ghost car next time
  (*Pause → End run* saves it; it also saves when you leave).
* **Little things:** persistent skid marks, headlights and street lamps that light up fog and
  rain, flocks of birds that scatter when you blast past (or honk), far-off sirens across the
  city at night, a sky that darkens as you enter the neon city, region names announced as you
  cross biome borders, slow-mo on near misses and flips, letterboxed crash cam.
* **Seed FM:** a procedural synthwave radio whose chord progression comes from the seed. Drums
  kick in with speed, an arpeggio lead with your combo, and it gets tense during police chases.

### Cars

| Car | Personality |
|---|---|
| **Kitsune GT** | Light RWD coupe, twitchy, born sideways. The starter. |
| **Bulldozer V8** | Heavy muscle. Huge torque, lazy big-angle slides, shrugs off hits. |
| **Mule 4x4** | AWD off-roader with long-travel suspension. Barely notices dirt, sand or snow. |
| **Taco Van** | FWD, top-heavy, delicious. Rolls over a lot. Giant taco on the roof. |
| **The Couch** | A three-seat sofa with a jet engine. Absurd boost, absurd air control. |
| **Bolt Hyper** | AWD hypercar with real downforce. Glued to the road until it isn't. |

### World

* Biomes are a domain-warped smooth Voronoi over 1.5 km cells, blended at the borders:
  **Desert Canyon** (terraced mesas, strata, dry washes, cacti), **Alpine Forest** (ridged
  mountains, snow line, switchbacks, breakable pines), **Neon City** (always night — the sky
  darkens as you drive in; neon towers, billboards, wet streets) and **Coastal Cliffs** (sea,
  beaches, palms, bridges over water). Each has its own palette, props, road style and colour grade.
* Roads are a jittered-grid graph (one junction per 320 m cell). Edges are centripetal
  Catmull-Rom splines with per-biome wiggle (hairpin switchbacks in the mountains, dead straight
  in the city), straight stubs at junctions, a smoothed + grade-limited elevation profile,
  deliberate **crests** for air, **banking** from curvature, **bridges** (deck, rails, pillars)
  where the road floats and **tunnels** (lit shells) where it's buried in a hill.
* **Surfaces** feel different: asphalt, concrete, dirt, grass, sand (draggy), rock, snow, ice.
  **Weather** (clear → overcast → fog → rain/storm with lightning, snow in the mountains) changes
  grip, fog, wetness (shiny roads, spray) and snow cover. A 12-minute day/night cycle.
* Same seed → same world, always. Region names are generated too.

## Architecture

```
src/
  main.ts              boot, attract mode, menu / pause flow
  core/
    Game.ts            orchestrator: fixed 120 Hz physics loop, interpolation, systems, quality, dynamic resolution
    Physics.ts         Rapier world, collision groups, collider metadata
    Input.ts           keyboard + gamepad → analog controls (steer smoothing, speed-sensitive lock, rumble)
    events.ts          typed event bus (crash, trick, nearMiss, smash, bank, police…)
    rng.ts             hashing, seeded RNG, simplex noise / fBm / ridged
    Debug.ts           lil-gui live tuning panel
  world/
    WorldGen.ts        PURE deterministic generation: biomes, terrain, road graph & profiles,
                       props, set-piece placement, chunk meshes (runs in worker + main thread)
    worldgen.worker.ts chunk generation off the main thread (transferable buffers)
    ChunkManager.ts    streaming, LOD rings, heightfield/trimesh colliders, prop colliders, breakables
    PropRenderer.ts    global instanced props (near set casts shadows), neon buildings & billboards
    PropGeometry.ts    procedural low-poly prop meshes + per-prop physics/break data
    SetPieces.ts       loops (clothoid helix + soft rail), ramps, half-pipes, gas stations…
    Sky.ts Weather.ts Water.ts Materials.ts types.ts
  vehicle/
    Vehicle.ts         raycast-wheel vehicle: suspension, impulse tyre model, drivetrain, drift
                       controller, air control, boost, stunt "magnet" mode
    VehicleDefs.ts     car specs + upgrades
    CarModel.ts        procedural car bodies with vertex deformation + detachable parts
  camera/CameraRig.ts  chase (velocity-aligned so drifts read), far, hood, cinematic, crash cam, photo
  audio/
    AudioEngine.ts     synthesized engine (RPM/load), squeal, gravel, wind, crashes, sirens, ambience
    Radio.ts           procedural synthwave radio
  fx/                  PostFX (bloom, speed blur + CA, ACES, per-biome grade, vignette), particles,
                       skid marks, headlights + volumetric beams, birds, vehicle FX
  game/                Score/combo, Events, Police, Traffic, Impacts (damage, smashing, debris),
                       Ghost, PhotoMode, Save, AutoPilot
  ui/                  HUD (canvas speedo, combo meter, toasts), Minimap, Menus, CSS
```

### How the driving works

The car is a single Rapier rigid body with a rounded box collider, a low centre of mass and
hand-shaped inertia. Each wheel is a ray along the body's down axis:

* **Suspension:** spring (from a natural frequency per car) + asymmetric damper + bump stop,
  anti-roll bars per axle.
* **Tyres:** each step, the lateral impulse that would cancel the contact patch's sideways velocity
  is computed and clamped to a grip budget `μ(surface, weather, car) · load · curve(slip angle)`.
  The curve peaks around 8° then falls to a *slide plateau*. Longitudinal drive/brake share the
  budget (friction circle), so wheelspin and locked wheels cost cornering grip.
* **Arcade layer:** traction control and a bicycle-model yaw limiter keep grip driving planted. A
  **drift state machine** (handbrake, brake-tap or flick to enter) swaps in a slip-angle
  controller: steering sets the target angle, a PD yaw controller holds it, throttle keeps the
  slide flowing and steering into the turn tightens the line. Counter-steer exits cleanly.
* **Air:** takeoff kills the pitch kick from the suspension, inputs held through takeoff are
  latched, gentle self-levelling when you let go.
* **Stunt surfaces:** on loops/half-pipes/tunnels gravity is redirected into the track ("magnet"),
  springs stiffen, and loops act as a soft rail toward their helix centreline.

### Performance

* Terrain chunks (128 m) are generated in a Web Worker; three LOD rings (2 m / 4 m / 8 m grids)
  with skirts; physics colliders only for the 3×3 chunks around the car.
* All props are global `InstancedMesh`es rebuilt by memcpy from per-chunk matrix caches; only the
  near ring casts shadows. ~140 draw calls / ~350k triangles typical.
* Fixed 120 Hz physics with render interpolation; ~1–2 ms/frame CPU for physics + gameplay.
* **Dynamic resolution** drops the render scale when the frame rate dips below ~52 fps and
  restores it when there is headroom; three quality presets in the pause menu.

### Camera

The chase camera follows the *velocity* direction (blended with the car's heading), so drift
angle is visible on screen. FOV opens with speed and punches on boost; trauma-based shake on
impacts/landings; it never clips terrain or walls (height + raycast occlusion). The crash cam
grabs a nearby angle, slows time to ~25% and letterboxes for a beat.

### Testing / tuning hooks

`window.game` exposes the game in dev builds. `game.simulate(seconds, controlsFn, sampleFn)` runs
the physics deterministically without rendering — the handling numbers above (drift angle,
radius, loop completion, 0–100) were tuned with it. `scripts/` contains the headless Playwright
harnesses used during development (`shot.mjs`, `tour.mjs`, `drift.js`, `loop.js`, `perf.js`) and
`npx tsx scripts/bench-gen.ts` benchmarks world generation in Node.

## Known limitations

* No true SSAO pass (it was too expensive alongside bloom + shadows for the 60 fps budget);
  terrain gets curvature-baked AO and cars get real shadows instead.
* Tunnels are cut-and-cover shells in a trench rather than bored through the heightfield.
* Ghosts replay from the spawn point of a seed, so they're most fun when you race the same seed
  from a fresh start.
