// Sea plane that follows the player: animated normals, fresnel, sun glint, fogged.
import * as THREE from 'three';
import { SEA_LEVEL } from './types';

export class Water {
  mesh: THREE.Mesh;
  level = SEA_LEVEL;
  private mat: THREE.ShaderMaterial;
  constructor(scene: THREE.Scene) {
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      fog: true,
      uniforms: {
        ...THREE.UniformsLib.fog,
        uTime: { value: 0 },
        uSky: { value: new THREE.Color() },
        uSun: { value: new THREE.Vector3(0, 1, 0) },
        uNight: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vW;
        #include <fog_pars_vertex>
        void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vW = wp.xyz; vec4 mvPosition = viewMatrix * wp; gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uSky; uniform vec3 uSun; uniform float uNight; varying vec3 vW;
        #include <fog_pars_fragment>
        vec2 w(vec2 p, float t){ return vec2(sin(p.x*0.11+t*1.1)+sin(p.y*0.07-t*0.8)*0.7+sin((p.x+p.y)*0.23+t*1.7)*0.3,
                                            cos(p.y*0.13+t*0.9)+cos(p.x*0.05+t*0.6)*0.7+cos((p.x-p.y)*0.21-t*1.3)*0.3); }
        void main(){
          vec2 g = w(vW.xz, uTime) * 0.08 + w(vW.xz*3.1, uTime*1.6)*0.03;
          vec3 n = normalize(vec3(g.x, 1.0, g.y));
          vec3 v = normalize(cameraPosition - vW);
          float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
          vec3 deep = mix(vec3(0.02,0.16,0.22), vec3(0.01,0.03,0.06), uNight);
          vec3 col = mix(deep, uSky*0.75, fres*0.6);
          vec3 h = normalize(uSun + v);
          col += vec3(1.0,0.9,0.7) * pow(max(dot(n,h),0.0), 220.0) * 4.0 * (1.0-uNight);
          float foam = smoothstep(0.75, 1.0, sin(vW.x*0.3 + uTime*2.0)*sin(vW.z*0.27 - uTime*1.7)) * 0.08;
          col += foam;
          gl_FragColor = vec4(col, 0.92);
          #include <fog_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000, 1, 1).rotateX(-Math.PI / 2), this.mat);
    this.mesh.position.y = this.level;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }
  update(t: number, focus: THREE.Vector3, sky: THREE.Color, sun: THREE.Vector3, night: number) {
    this.mesh.position.x = Math.round(focus.x / 50) * 50;
    this.mesh.position.z = Math.round(focus.z / 50) * 50;
    this.mat.uniforms.uTime.value = t;
    this.mat.uniforms.uSky.value.copy(sky);
    this.mat.uniforms.uSun.value.copy(sun);
    this.mat.uniforms.uNight.value = night;
  }
}
