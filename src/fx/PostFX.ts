// Post-processing: bloom, speed blur + chromatic aberration, tone mapping, per-biome grading, vignette.
import * as THREE from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  Effect,
  EffectAttribute,
  ToneMappingEffect,
  ToneMappingMode,
  BlendFunction,
} from 'postprocessing';

const speedFrag = /* glsl */ `
uniform float uSpeed;
uniform float uCA;
uniform vec2 uCenter;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 dir = uv - uCenter;
  float d = length(dir);
  float amt = uSpeed * smoothstep(0.15, 0.75, d);
  vec3 acc = vec3(0.0);
  const int N = 8;
  for (int i = 0; i < N; i++) {
    float t = float(i) / float(N - 1);
    vec2 o = dir * amt * 0.09 * t;
    acc += texture2D(inputBuffer, uv - o).rgb;
  }
  vec3 col = acc / float(N);
  // chromatic aberration (radial)
  float ca = (uCA + uSpeed * 0.35) * d * d * 0.012;
  col.r = mix(col.r, texture2D(inputBuffer, uv - dir * ca * 1.0 - dir * amt * 0.04).r, 0.85);
  col.b = mix(col.b, texture2D(inputBuffer, uv + dir * ca * 1.0).b, 0.85);
  outputColor = vec4(col, inputColor.a);
}`;

class SpeedEffect extends Effect {
  constructor() {
    super('SpeedEffect', speedFrag, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['uSpeed', new THREE.Uniform(0)],
        ['uCA', new THREE.Uniform(0)],
        ['uCenter', new THREE.Uniform(new THREE.Vector2(0.5, 0.52))],
      ]),
    });
  }
}

const gradeFrag = /* glsl */ `
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uSat;
uniform float uContrast;
uniform float uVignette;
uniform vec3 uFlash;
uniform float uDesat;
uniform float uTime;
uniform float uLetterbox;
uniform int uFilter;
float rnd(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)) + uTime)*43758.5453); }
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  c = c * uGain + uLift * (1.0 - c);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, uSat * (1.0 - uDesat));
  c = (c - 0.5) * uContrast + 0.5;
  vec2 q = uv - 0.5;
  float v = 1.0 - dot(q, q) * uVignette;
  c *= clamp(v, 0.0, 1.0);
  c += uFlash;
  c += (rnd(uv) - 0.5) * 0.025;
  if (uFilter == 1) { float g = dot(c, vec3(0.3,0.59,0.11)); c = vec3(pow(g, 1.2)) * 1.1; }
  else if (uFilter == 2) { c *= vec3(1.15, 1.0, 0.8); c = pow(c, vec3(0.95)); }
  else if (uFilter == 3) { c = vec3(c.r*1.1 + c.b*0.2, c.g*0.85, c.b*1.3 + c.r*0.1); }
  else if (uFilter == 4) { c = mix(c, vec3(dot(c, vec3(0.33))), 0.4) * 0.9 + 0.08; }
  float lb = step(abs(uv.y - 0.5), 0.5 - uLetterbox);
  outputColor = vec4(c * lb, inputColor.a);
}`;

class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', gradeFrag, {
      uniforms: new Map<string, THREE.Uniform>([
        ['uLift', new THREE.Uniform(new THREE.Vector3())],
        ['uGain', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['uSat', new THREE.Uniform(1.1)],
        ['uContrast', new THREE.Uniform(1.05)],
        ['uVignette', new THREE.Uniform(0.9)],
        ['uFlash', new THREE.Uniform(new THREE.Vector3())],
        ['uDesat', new THREE.Uniform(0)],
        ['uTime', new THREE.Uniform(0)],
        ['uLetterbox', new THREE.Uniform(0)],
        ['uFilter', new THREE.Uniform(0)],
      ]),
    });
  }
}

interface Grade {
  lift: [number, number, number];
  gain: [number, number, number];
  sat: number;
  contrast: number;
}

// desert, alpine, city, coast
const GRADES: Grade[] = [
  { lift: [0.03, 0.01, -0.01], gain: [1.08, 1.0, 0.9], sat: 1.15, contrast: 1.1 },
  { lift: [-0.01, 0.0, 0.02], gain: [0.97, 1.0, 1.06], sat: 1.05, contrast: 1.05 },
  { lift: [0.02, -0.01, 0.04], gain: [1.05, 0.95, 1.12], sat: 1.3, contrast: 1.12 },
  { lift: [0.0, 0.015, 0.02], gain: [1.0, 1.04, 1.05], sat: 1.2, contrast: 1.04 },
];

export class PostFX {
  composer: EffectComposer;
  bloom: BloomEffect;
  speed: SpeedEffect;
  grade: GradeEffect;
  enabled = true;
  private flash = new THREE.Vector3();
  private renderPass: RenderPass;

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.85, luminanceSmoothing: 0.25, intensity: 1.1, radius: 0.7 });
    this.composer.addPass(new EffectPass(camera, this.bloom));
    this.speed = new SpeedEffect();
    this.composer.addPass(new EffectPass(camera, this.speed));
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.grade = new GradeEffect();
    this.grade.blendMode.blendFunction = BlendFunction.NORMAL;
    this.composer.addPass(new EffectPass(camera, tone, this.grade));
  }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h);
  }

  setFilter(name: string) {
    this.grade.uniforms.get('uFilter')!.value = ['none', 'noir', 'warm', 'cyber', 'faded'].indexOf(name);
  }

  flashColor(r: number, g: number, b: number) {
    this.flash.set(Math.max(this.flash.x, r), Math.max(this.flash.y, g), Math.max(this.flash.z, b));
  }

  update(dt: number, opts: { speed: number; biome: Float32Array; night: number; damage: number; time: number; letterbox: number }) {
    const u = this.speed.uniforms;
    u.get('uSpeed')!.value = opts.speed;
    const g = this.grade.uniforms;
    const lift = g.get('uLift')!.value as THREE.Vector3;
    const gain = g.get('uGain')!.value as THREE.Vector3;
    lift.set(0, 0, 0);
    gain.set(0, 0, 0);
    let sat = 0;
    let con = 0;
    for (let b = 0; b < 4; b++) {
      const w = opts.biome[b];
      const gr = GRADES[b];
      lift.x += gr.lift[0] * w;
      lift.y += gr.lift[1] * w;
      lift.z += gr.lift[2] * w;
      gain.x += gr.gain[0] * w;
      gain.y += gr.gain[1] * w;
      gain.z += gr.gain[2] * w;
      sat += gr.sat * w;
      con += gr.contrast * w;
    }
    // night: cool shadows
    lift.z += opts.night * 0.015;
    gain.multiplyScalar(1 + opts.night * 0.1);
    g.get('uSat')!.value = sat;
    g.get('uContrast')!.value = con;
    g.get('uDesat')!.value = opts.damage * 0.5;
    g.get('uTime')!.value = opts.time;
    g.get('uLetterbox')!.value = opts.letterbox;
    g.get('uVignette')!.value = 0.85 + opts.speed * 0.6 + opts.damage * 0.8;
    this.flash.multiplyScalar(Math.exp(-dt * 6));
    (g.get('uFlash')!.value as THREE.Vector3).copy(this.flash);
    this.bloom.intensity = 0.9 + opts.night * 0.7;
  }

  render(dt: number) {
    if (this.enabled) this.composer.render(dt);
    else this.renderer.render((this.renderPass as unknown as { mainScene: THREE.Scene }).mainScene, (this.renderPass as unknown as { mainCamera: THREE.Camera }).mainCamera);
  }
}

/** Periodically bakes the sky into a PMREM environment map for reflections. */
export class EnvBaker {
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private rt: THREE.WebGLRenderTarget | null = null;
  private timer = 0;
  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    skyMesh: THREE.Mesh,
  ) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    const m = new THREE.Mesh(skyMesh.geometry, skyMesh.material);
    this.envScene.add(m);
    // a dark ground disc so reflections have a horizon
    const ground = new THREE.Mesh(new THREE.CircleGeometry(2000, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x2a2622 }));
    ground.position.y = -5;
    this.envScene.add(ground);
  }
  update(dt: number, force = false) {
    this.timer -= dt;
    if (this.timer > 0 && !force) return;
    this.timer = 2.5;
    const old = this.rt;
    this.rt = this.pmrem.fromScene(this.envScene, 0.02, 0.1, 3000);
    this.scene.environment = this.rt.texture;
    old?.dispose();
  }
}
