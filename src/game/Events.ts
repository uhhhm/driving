// Procedural events that pop up during free roam.
import * as THREE from 'three';
import type { Game } from '../core/Game';
import { bus } from '../core/events';
import { audio } from '../audio/AudioEngine';
import type { RoadEdge } from '../world/types';

type Kind = 'sprint' | 'smash' | 'speed' | 'drift' | 'air' | 'nearmiss' | 'chase';

interface Active {
  kind: Kind;
  title: string;
  time: number;
  limit: number;
  goal: number;
  progress: number;
  reward: number;
  countdown: number;
  // sprint
  gates?: { pos: THREE.Vector3; yaw: number; obj: THREE.Group }[];
  gateIdx?: number;
  // speed
  armed?: boolean;
}

const _v = new THREE.Vector3();

export class Events {
  active: Active | null = null;
  private cooldown = 25;
  private gateMat: THREE.ShaderMaterial;
  private pillarMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 2.5, 3) });
  private beamMat: THREE.ShaderMaterial;
  completed = 0;
  enabled = true;

  constructor(private game: Game) {
    this.gateMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `uniform float uTime; varying vec2 vUv;
        void main(){ float s = step(0.5, fract(vUv.y*6.0 - uTime*1.5)); float e = smoothstep(0.45,0.5,abs(vUv.x-0.5));
          vec3 c = mix(vec3(0.1,0.9,1.0), vec3(1.0,0.2,0.9), vUv.y);
          gl_FragColor = vec4(c*(0.12 + 0.12*s + e*0.8), 1.0); }`,
    });
    this.beamMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `uniform float uTime; varying vec2 vUv; void main(){ float a = (1.0-vUv.y) * (0.5+0.5*sin(uTime*4.0 + vUv.y*20.0)); gl_FragColor = vec4(vec3(0.2,0.9,1.0)*a*0.8, 1.0); }`,
    });
    bus.on('smash', () => this.bump('smash', 1));
    bus.on('nearMiss', () => this.bump('nearmiss', 1));
    bus.on('busted', () => {
      if (this.active?.kind === 'chase') this.finish(false);
    });
  }

  onTrick(name: string, pts: number) {
    if (this.active?.kind === 'drift' && name.includes('DRIFT')) this.bump('drift', pts);
  }

  private bump(kind: Kind, n: number) {
    if (this.active && this.active.kind === kind && this.active.countdown <= 0) this.active.progress += n;
  }

  start(kind?: Kind): void {
    if (this.active) this.cancel();
    const g = this.game;
    const kinds: Kind[] = ['sprint', 'smash', 'speed', 'drift', 'air', 'nearmiss', 'chase'];
    const city = g.biomeWeights[2] > 0.5;
    kind ??= kinds[Math.floor(Math.random() * kinds.length)];
    if (kind === 'nearmiss' && (g.traffic?.cars.length ?? 0) < 8) kind = 'drift';
    if (kind === 'smash' && !city && Math.random() < 0.3) kind = 'sprint';
    const a: Active = { kind, title: '', time: 0, limit: 30, goal: 1, progress: 0, reward: 5000, countdown: 3 };
    switch (kind) {
      case 'sprint': {
        if (!this.buildSprint(a)) return this.start('drift');
        a.title = 'CHECKPOINT SPRINT';
        break;
      }
      case 'smash':
        a.title = 'SMASH FEST';
        a.goal = 20;
        a.limit = 35;
        a.reward = 6000;
        break;
      case 'speed':
        a.title = 'SPEED DEMON';
        a.goal = 150;
        a.limit = 20;
        a.reward = 7000;
        a.armed = false;
        break;
      case 'drift':
        a.title = 'DRIFT KING';
        a.goal = 12000;
        a.limit = 40;
        a.reward = 6000;
        break;
      case 'air':
        a.title = 'HANG TIME';
        a.goal = 4;
        a.limit = 45;
        a.reward = 6000;
        break;
      case 'nearmiss':
        a.title = 'NEEDLE THREADER';
        a.goal = 8;
        a.limit = 45;
        a.reward = 7000;
        break;
      case 'chase':
        a.title = 'HOT PURSUIT';
        a.goal = 60;
        a.limit = 60;
        a.reward = 12000;
        break;
    }
    this.active = a;
    audio.chime(true);
    bus.emit('eventStart', { title: a.title, desc: this.desc(a) });
    bus.emit('toast', { text: a.title, sub: this.desc(a), color: '#2ef2ff', big: true });
  }

  private desc(a: Active): string {
    switch (a.kind) {
      case 'sprint':
        return `HIT ${a.gates!.length} CHECKPOINTS`;
      case 'smash':
        return `SMASH ${a.goal} THINGS IN ${a.limit}S`;
      case 'speed':
        return `DON'T DROP BELOW ${a.goal} KM/H`;
      case 'drift':
        return `${a.goal.toLocaleString()} DRIFT POINTS IN ${a.limit}S`;
      case 'air':
        return `${a.goal}S OF TOTAL AIR TIME`;
      case 'nearmiss':
        return `${a.goal} NEAR MISSES`;
      case 'chase':
        return `SURVIVE THE COPS FOR ${a.goal}S`;
    }
  }

  private buildSprint(a: Active): boolean {
    const g = this.game;
    const v = g.player.vehicle;
    const gen = g.chunks.gen;
    const near = gen.nearestRoad(v.pos.x, v.pos.z, 60);
    if (!near) return false;
    let e: RoadEdge = near.edge;
    let dir = v.fwd.x * e.tx[near.idx] + v.fwd.z * e.tz[near.idx] >= 0 ? 1 : -1;
    let q = near.idx;
    const gates: { pos: THREE.Vector3; yaw: number; obj: THREE.Group }[] = [];
    let dist = 0;
    let total = 0;
    const spacing = 330;
    let guard = 0;
    while (gates.length < 5 && guard++ < 4000) {
      q += dir;
      dist += 3;
      total += 3;
      if (q <= 0 || q >= e.n - 1) {
        const ni = dir > 0 ? e.bi : e.ai;
        const nj = dir > 0 ? e.bj : e.aj;
        const opts = gen.nodeEdges(ni, nj).filter((x) => x !== e);
        if (!opts.length) break;
        const ne = opts[Math.floor(Math.random() * opts.length)];
        const fromA = ne.ai === ni && ne.aj === nj;
        e = ne;
        dir = fromA ? 1 : -1;
        q = fromA ? 0 : e.n - 1;
      }
      if (dist >= spacing) {
        dist = 0;
        const yaw = Math.atan2(e.tx[q] * dir, e.tz[q] * dir);
        const pos = new THREE.Vector3(e.x[q], e.h[q], e.z[q]);
        gates.push({ pos, yaw, obj: this.makeGate(pos, yaw, e.halfW + 2) });
      }
    }
    if (gates.length < 3) {
      for (const gt of gates) g.scene.remove(gt.obj);
      return false;
    }
    a.gates = gates;
    a.gateIdx = 0;
    a.goal = gates.length;
    a.limit = Math.round((total / (110 / 3.6)) * 1.15 + 6);
    a.reward = 3000 + gates.length * 1200;
    gates.forEach((gt, i) => (gt.obj.visible = i < 2));
    return true;
  }

  private makeGate(pos: THREE.Vector3, yaw: number, halfW: number): THREE.Group {
    const grp = new THREE.Group();
    const H = 9;
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.6, H, 0.6), this.pillarMat);
      p.position.set(s * halfW, H / 2, 0);
      grp.add(p);
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(halfW * 2 + 0.6, 0.6, 0.6), this.pillarMat);
    top.position.y = H;
    grp.add(top);
    const curtain = new THREE.Mesh(new THREE.PlaneGeometry(halfW * 2, H), this.gateMat);
    curtain.position.y = H / 2;
    grp.add(curtain);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 300, 8, 1, true).translate(0, 150, 0), this.beamMat);
    grp.add(beam);
    grp.position.copy(pos);
    grp.rotation.y = yaw;
    this.game.scene.add(grp);
    return grp;
  }

  private cleanup() {
    const a = this.active;
    if (a?.gates) for (const gt of a.gates) this.game.scene.remove(gt.obj);
    if (a?.kind === 'chase') this.game.police?.endChase(false);
  }

  cancel() {
    this.cleanup();
    this.active = null;
    this.game.hud.setEvent(null);
    this.cooldown = 30;
  }

  private finish(success: boolean) {
    const a = this.active!;
    const g = this.game;
    if (success) {
      const bonus = Math.round(a.reward * (a.kind === 'sprint' ? 1 + Math.max(0, a.limit - a.time) / a.limit : 1));
      g.save.addCredits(bonus);
      g.score.award(`${a.title} COMPLETE`, bonus, '#7dff3d', 2);
      g.hud.center('COMPLETE', 1.6, 'good');
      audio.chime(true);
      this.completed++;
    } else {
      g.hud.center('FAILED', 1.4, 'danger');
      audio.fail();
    }
    bus.emit('eventEnd', { title: a.title, success, reward: a.reward });
    if (a.kind === 'chase' && success) g.police.endChase(true);
    this.cleanup();
    this.active = null;
    g.hud.setEvent(null);
    this.cooldown = 35 + Math.random() * 25;
  }

  update(dt: number) {
    const g = this.game;
    this.gateMat.uniforms.uTime.value += dt;
    this.beamMat.uniforms.uTime.value += dt;
    if (!this.enabled || dt <= 0) return;
    const a = this.active;
    if (!a) {
      this.cooldown -= dt;
      if (this.cooldown <= 0 && !g.police.active) this.start();
      return;
    }
    const v = g.player.vehicle;
    if (a.countdown > 0) {
      const before = Math.ceil(a.countdown);
      a.countdown -= dt;
      const after = Math.ceil(a.countdown);
      if (after !== before && after > 0) {
        g.hud.center(String(after), 0.6);
        audio.ping(after);
      }
      if (a.countdown <= 0) {
        g.hud.center('GO!', 0.7, 'good');
        audio.chime(false);
        if (a.kind === 'chase') g.police.startChase(2);
      }
    } else {
      a.time += dt;
    }
    let fail = a.countdown <= 0 && a.time > a.limit;
    let done = false;
    let line = '';
    switch (a.kind) {
      case 'sprint': {
        const gt = a.gates![a.gateIdx!];
        const d = _v.copy(gt.pos).sub(v.pos);
        if (Math.hypot(d.x, d.z) < 14 && Math.abs(d.y) < 10 && a.countdown <= 0) {
          g.scene.remove(gt.obj);
          a.gateIdx!++;
          a.progress++;
          audio.chime(false);
          a.limit += 4;
          bus.emit('checkpoint', { left: a.gates!.length - a.gateIdx! });
          g.hud.center(a.gateIdx! >= a.gates!.length ? 'FINISH' : `+4s`, 0.6, 'good');
          if (a.gateIdx! < a.gates!.length) a.gates![a.gateIdx!].obj.visible = true;
          if (a.gateIdx! + 1 < a.gates!.length) a.gates![a.gateIdx! + 1].obj.visible = true;
        }
        if (a.gateIdx! >= a.gates!.length) done = true;
        else {
          const nxt = a.gates![a.gateIdx!];
          g.hud.minimap.markers.push({ x: nxt.pos.x, z: nxt.pos.z, color: '#2ef2ff', size: 7, shape: 'diamond' });
          line = `${Math.round(Math.hypot(nxt.pos.x - v.pos.x, nxt.pos.z - v.pos.z))} m`;
        }
        break;
      }
      case 'speed': {
        if (!a.armed) {
          line = `REACH ${a.goal} KM/H`;
          if (v.kmh >= a.goal && a.countdown <= 0) {
            a.armed = true;
            a.time = 0;
          } else if (a.countdown <= 0 && a.time > 12) fail = true;
          else fail = false;
          if (a.armed) g.hud.center('HOLD IT!', 0.8);
        } else {
          a.progress = a.time;
          line = `${Math.round(v.kmh)} KM/H`;
          if (v.kmh < a.goal) fail = true;
          if (a.time >= a.limit) {
            done = true;
            fail = false;
          }
        }
        break;
      }
      case 'air':
        if (v.groundedCount === 0 && v.airTime > 0.15 && a.countdown <= 0) a.progress += dt;
        line = `${a.progress.toFixed(1)} / ${a.goal}s`;
        if (a.progress >= a.goal) done = true;
        break;
      case 'chase':
        if (a.countdown <= 0) a.progress = a.time;
        line = `HEAT ${g.police.heat}`;
        if (a.time >= a.goal) {
          done = true;
          fail = false;
        }
        if (a.countdown <= 0 && !g.police.active && a.time > 3) done = true; // escaped early
        break;
      default:
        if (a.progress >= a.goal) done = true;
        line = `${Math.round(a.progress).toLocaleString()} / ${a.goal.toLocaleString()}`;
    }
    if (done) return this.finish(true);
    if (fail) return this.finish(false);
    const remain = Math.max(0, a.limit - a.time);
    const pct = a.kind === 'sprint' ? a.gateIdx! / a.gates!.length : Math.min(1, a.progress / a.goal);
    g.hud.setEvent(
      `<h3>${a.title}</h3><p>${this.desc(a)}</p><div class="big">${a.countdown > 0 ? Math.ceil(a.countdown) : remain.toFixed(1)}<small>${line}</small></div><div class="bar"><i style="width:${(pct * 100).toFixed(0)}%"></i></div>`,
    );
  }
}
