// Day/night cycle: sky dome shader, sun/moon light, fog, biome colour grading inputs.
import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../core/rng';
import { worldUniforms } from './Materials';

export interface SkyState {
  sunDir: THREE.Vector3;
  night: number; // 0 day .. 1 night (incl. city darkness)
  fogColor: THREE.Color;
  horizon: THREE.Color;
}

const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);

export class Sky {
  hours = 16.8;
  dayLengthSec = 720;
  paused = false;
  mesh: THREE.Mesh;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  fog: THREE.Fog;
  state: SkyState = { sunDir: new THREE.Vector3(), night: 0, fogColor: new THREE.Color(), horizon: new THREE.Color() };
  private uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uGround: { value: new THREE.Color() },
    uNight: { value: 0 },
    uCity: { value: 0 },
    uTime: worldUniforms.uTime,
    uCloud: { value: 0.3 },
  };
  cityAmount = 0;
  weatherDark = 0; // 0..1 overcast
  weatherFog = 0; // 0..1 extra fog
  fogNear = 170;
  fogFar = 880;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.SphereGeometry(2500, 32, 16);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir; uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround;
        uniform float uNight; uniform float uCity; uniform float uTime; uniform float uCloud;
        varying vec3 vDir;
        float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
        float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          float a=h(vec3(i,0.)), b=h(vec3(i+vec2(1,0),0.)), c=h(vec3(i+vec2(0,1),0.)), d=h(vec3(i+vec2(1,1),0.));
          return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
        void main(){
          vec3 d = normalize(vDir);
          float y = d.y;
          vec3 col = mix(uHorizon, uZenith, pow(clamp(y,0.0,1.0), 0.45));
          col = mix(col, uGround, smoothstep(0.0, -0.08, y));
          // sun
          float sd = max(dot(d, uSunDir), 0.0);
          vec3 sunCol = mix(vec3(1.0,0.55,0.25), vec3(1.0,0.95,0.85), clamp(uSunDir.y*3.0,0.0,1.0));
          col += sunCol * (pow(sd, 900.0)*30.0 + pow(sd, 12.0)*0.35 + pow(sd,3.0)*0.12) * (1.0-uNight*0.9) * (1.0-uCity*0.8);
          // moon
          vec3 md = -uSunDir;
          float m = max(dot(d, md), 0.0);
          col += vec3(0.8,0.85,1.0) * (smoothstep(0.9993, 0.9996, m)*1.6 + pow(m, 60.0)*0.12) * uNight;
          // stars
          vec3 sp = floor(d*420.0);
          float st = step(0.9975, h(sp)) * smoothstep(0.0, 0.25, y);
          float tw = 0.6 + 0.4*sin(uTime*3.0 + h(sp+1.0)*40.0);
          col += vec3(st*tw) * uNight * (1.0-uCity*0.7) * 1.4;
          // clouds
          vec2 cp = d.xz/(y+0.15) * 2.0 + vec2(uTime*0.01, 0.0);
          float cl = vn(cp)*0.6 + vn(cp*2.3)*0.3 + vn(cp*5.1)*0.1;
          cl = smoothstep(0.55 - uCloud*0.35, 0.95, cl) * smoothstep(0.0, 0.2, y);
          vec3 cloudCol = mix(uHorizon*1.15 + sunCol*0.15*(1.0-uNight), uZenith*0.6, 0.3);
          col = mix(col, cloudCol, cl*0.75);
          // city smog glow near horizon
          col += vec3(0.6,0.15,0.5) * uCity * smoothstep(0.35, 0.0, abs(y)) * 0.35;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    scene.add(this.mesh);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70;
    sc.right = 70;
    sc.top = 70;
    sc.bottom = -70;
    sc.near = 1;
    sc.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbcd8ff, 0x5a4a3a, 1);
    scene.add(this.hemi);
    this.fog = new THREE.Fog(0xffffff, this.fogNear, this.fogFar);
    scene.fog = this.fog;
  }

  update(dt: number, focus: THREE.Vector3) {
    if (!this.paused) {
      const nightish = this.hours < 5.5 || this.hours > 20.5;
      this.hours = (this.hours + (dt * 24) / this.dayLengthSec * (nightish ? 1.8 : 1)) % 24;
    }
    const t = (this.hours / 24) * Math.PI * 2;
    // sun goes round; peak at 13:00
    const elev = Math.sin(t - Math.PI / 2 - 0.26) * 0.95;
    const az = t * 1.0 + 0.6;
    const sunDir = this.state.sunDir.set(Math.cos(az) * Math.cos(Math.asin(elev)), elev, Math.sin(az) * Math.cos(Math.asin(elev))).normalize();
    this.uniforms.uSunDir.value.copy(sunDir);

    const sunNight = smoothstep(0.05, -0.18, elev);
    const night = clamp(Math.max(sunNight, this.cityAmount * 0.92), 0, 1);
    this.state.night = night;
    worldUniforms.uNight.value = night;
    this.uniforms.uNight.value = night;
    this.uniforms.uCity.value = this.cityAmount;
    this.uniforms.uCloud.value = 0.3 + this.weatherDark * 0.7;

    // palette
    const golden = smoothstep(0.35, 0.02, Math.abs(elev)) * (1 - sunNight * 0.7);
    const dayZen = C(0.1, 0.3, 0.8);
    const dayHor = C(0.55, 0.7, 0.9);
    const goldZen = C(0.22, 0.25, 0.55);
    const goldHor = C(1.0, 0.52, 0.28);
    const nightZen = C(0.004, 0.008, 0.03);
    const nightHor = C(0.03, 0.04, 0.08);
    const cityZen = C(0.03, 0.0, 0.06);
    const cityHor = C(0.22, 0.05, 0.22);
    const zen = dayZen.clone().lerp(goldZen, golden).lerp(nightZen, sunNight).lerp(cityZen, this.cityAmount * 0.9);
    const hor = dayHor.clone().lerp(goldHor, golden).lerp(nightHor, sunNight).lerp(cityHor, this.cityAmount * 0.85);
    // weather overcast
    const grey = C(0.5, 0.52, 0.56).multiplyScalar(1 - night * 0.9);
    zen.lerp(grey, this.weatherDark * 0.8);
    hor.lerp(grey.clone().multiplyScalar(1.1), this.weatherDark * 0.85);
    this.uniforms.uZenith.value.copy(zen);
    this.uniforms.uHorizon.value.copy(hor);
    this.uniforms.uGround.value.copy(hor).multiplyScalar(0.5);
    this.state.horizon.copy(hor);
    this.state.fogColor.copy(hor);
    this.fog.color.copy(hor);
    this.fog.near = lerp(this.fogNear, 8, this.weatherFog);
    this.fog.far = lerp(this.fogFar, 140, this.weatherFog);
    if (this.cityAmount > 0) {
      this.fog.near = lerp(this.fog.near, 60, this.cityAmount * 0.5);
      this.fog.far = lerp(this.fog.far, 600, this.cityAmount * 0.5);
    }

    // lights
    const sunUp = Math.max(0, elev);
    const moon = sunNight;
    const lightDir = elev > -0.05 ? sunDir : sunDir.clone().negate();
    const sunCol = C(1, 0.62, 0.38).lerp(C(1, 0.96, 0.9), clamp(sunUp * 3, 0, 1));
    const moonCol = C(0.45, 0.55, 0.85);
    const lightCol = sunCol.lerp(moonCol, moon);
    const intensity = lerp(0.1 + smoothstep(0, 0.25, sunUp) * 2.5, 0.35, moon) * (1 - this.weatherDark * 0.6) * (1 - this.cityAmount * 0.75);
    this.sun.color.copy(lightCol);
    this.sun.intensity = intensity;
    this.sun.position.copy(focus).addScaledVector(lightDir, 200);
    this.sun.target.position.copy(focus);
    this.hemi.color.copy(zen).lerp(C(1, 1, 1), 0.35);
    this.hemi.groundColor.copy(hor).multiplyScalar(0.4);
    this.hemi.intensity = lerp(0.85, 0.25, night) * (1 - this.weatherDark * 0.25);
    // snap shadow camera to texel grid to avoid shimmering
    this.mesh.position.copy(focus);
  }

  get timeString(): string {
    const h = Math.floor(this.hours);
    const m = Math.floor((this.hours - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
