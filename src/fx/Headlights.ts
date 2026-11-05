// Player headlights: one real spotlight plus volumetric beam cones that light up fog at night.
import * as THREE from 'three';
import type { CarModel } from '../vehicle/CarModel';
import type { Vehicle } from '../vehicle/Vehicle';

export class Headlights {
  spot: THREE.SpotLight;
  private beams: THREE.Mesh[] = [];
  private beamMat: THREE.ShaderMaterial;
  constructor(private scene: THREE.Scene) {
    this.spot = new THREE.SpotLight(0xfff2d8, 0, 90, 0.55, 0.6, 1.2);
    this.spot.castShadow = false;
    scene.add(this.spot, this.spot.target);
    this.beamMat = new THREE.ShaderMaterial({
      uniforms: { uI: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: `varying float vT; varying vec3 vN; varying vec3 vV;
        void main(){ vT = uv.y; vec4 wp = modelMatrix*vec4(position,1.0); vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix*viewMatrix*wp; }`,
      fragmentShader: `uniform float uI; varying float vT; varying vec3 vN; varying vec3 vV;
        void main(){ float e = 1.0 - pow(abs(dot(vN, vV)), 0.8); float a = pow(vT, 2.2) * (1.0 - e) * uI * 0.22; gl_FragColor = vec4(vec3(1.0,0.95,0.82)*a, 1.0); }`,
    });
  }
  attach(model: CarModel) {
    for (const b of this.beams) b.parent?.remove(b);
    this.beams = [];
    for (const hl of model.headlights) {
      const g = new THREE.ConeGeometry(4.5, 26, 16, 1, true);
      g.translate(0, -13, 0);
      g.rotateX(-Math.PI / 2 - 0.06);
      const m = new THREE.Mesh(g, this.beamMat);
      m.position.copy(hl.position);
      m.renderOrder = 12;
      model.bodyGroup.add(m);
      this.beams.push(m);
    }
  }
  update(night: number, fog: number, model: CarModel, v: Vehicle) {
    const on = Math.max(night, fog * 0.6);
    this.spot.intensity = on * 260;
    this.spot.visible = on > 0.05;
    const p = model.root.position;
    this.spot.position.copy(v.fwd).multiplyScalar(1.8).add(p).add(v.up.clone().multiplyScalar(0.8));
    this.spot.target.position.copy(v.fwd).multiplyScalar(30).add(p).add(v.up.clone().multiplyScalar(-1.5));
    this.beamMat.uniforms.uI.value = on * (0.5 + fog * 0.8);
    for (const b of this.beams) b.visible = on > 0.05;
  }
}
