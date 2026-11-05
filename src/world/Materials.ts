import * as THREE from 'three';

/** Uniforms shared by all world materials (weather, time, night). */
export const worldUniforms = {
  uTime: { value: 0 },
  uWet: { value: 0 }, // 0..1 rain wetness
  uSnow: { value: 0 }, // 0..1 snow cover
  uNight: { value: 0 }, // 0..1
};

const NOISE_GLSL = /* glsl */ `
float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
`;

function injectWorldPos(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNorm;')
    .replace(
      '#include <worldpos_vertex>',
      '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed,1.0)).xyz;\nvWNorm = normalize(mat3(modelMatrix) * objectNormal);',
    );
  // worldpos_vertex only computes worldPosition under some defines; make sure transformed exists.
}

export function makeTerrainMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, worldUniforms);
    injectWorldPos(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNorm;\nuniform float uWet; uniform float uSnow; uniform float uTime;\n${NOISE_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float dn = vnoise(vWPos.xz*0.35)*0.5 + vnoise(vWPos.xz*1.7)*0.3 + vnoise(vWPos.xz*7.0)*0.2;
        diffuseColor.rgb *= 0.82 + dn*0.36;
        float up = clamp(vWNorm.y, 0.0, 1.0);
        float snowAmt = smoothstep(0.55, 0.85, up) * smoothstep(0.2, 0.6, uSnow + dn*0.3 - 0.15);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92,0.94,1.0), snowAmt);
        diffuseColor.rgb *= 1.0 - uWet*0.35*(1.0-snowAmt);
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.45, uWet*(1.0-snowAmt));`,
      );
  };
  return m;
}

export function makeRoadMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, vertexColors: true });
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -2;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, worldUniforms);
    injectWorldPos(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vRoadUv;\nvarying vec3 vRoadInfo;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvRoadUv = uv;\nvRoadInfo = color;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNorm;\nvarying vec2 vRoadUv;\nvarying vec3 vRoadInfo;\nuniform float uWet; uniform float uSnow; uniform float uNight;\n${NOISE_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `
        float typ = vRoadInfo.r; // 0.25 mountain, 0.5 highway, 0.75 avenue, 1 dirt
        float hw = max(vRoadInfo.g, 1.0);
        float u = vRoadUv.x; float v = vRoadUv.y * hw * 2.0; // metres along
        float lat = (u - 0.5) * 2.0 * hw; // metres from centre
        float n1 = vnoise(vWPos.xz*0.8)*0.6 + vnoise(vWPos.xz*4.0)*0.4;
        vec3 asphalt = vec3(0.075,0.075,0.085) * (0.85 + n1*0.3);
        // tyre-worn lanes
        float lane = abs(abs(lat) - hw*0.5);
        asphalt *= 1.0 - smoothstep(1.4, 0.2, lane)*0.18;
        vec3 col = asphalt;
        float isDirt = step(0.9, typ);
        if (isDirt < 0.5) {
          // edge lines
          float edge = smoothstep(0.12, 0.05, abs(abs(lat) - (hw - 0.45)));
          vec3 edgeCol = vec3(0.85);
          // centre line(s)
          float cl;
          vec3 cc;
          if (typ > 0.6) { // avenue: double yellow + dashed lanes
            cl = smoothstep(0.1, 0.04, abs(abs(lat) - 0.22));
            cc = vec3(0.95, 0.7, 0.1);
            float dash = step(0.5, fract(v/6.0)) * smoothstep(0.1, 0.04, abs(abs(lat) - hw*0.5));
            col = mix(col, vec3(0.8), dash);
          } else if (typ > 0.4) { // highway: dashed white
            cl = smoothstep(0.12, 0.05, abs(lat)) * step(0.45, fract(v/9.0));
            cc = vec3(0.9);
          } else { // mountain: solid yellow
            cl = smoothstep(0.1, 0.04, abs(lat));
            cc = vec3(0.95, 0.75, 0.15);
          }
          col = mix(col, edgeCol, edge);
          col = mix(col, cc, cl);
          // shoulders / curbs
          float sh = step(hw, abs(lat));
          vec3 curb = mix(vec3(0.6,0.08,0.06), vec3(0.85), step(0.5, fract(v/3.0)));
          col = mix(col, typ > 0.6 ? vec3(0.35,0.35,0.38) : (vRoadInfo.b > 0.5 ? vec3(0.4) : curb*0.7), sh);
        } else {
          vec3 dirt = vec3(0.42,0.31,0.2) * (0.75 + n1*0.5);
          float rut = smoothstep(0.9, 0.2, abs(abs(lat) - 1.0));
          dirt *= 1.0 - rut*0.18;
          col = dirt;
        }
        // fade the road edges into terrain
        float fadeEdge = smoothstep(hw+0.7, hw+0.2, abs(lat));
        diffuseColor.rgb = col;
        diffuseColor.a = 1.0;
        float snowAmt = smoothstep(0.3, 0.9, uSnow) * (0.35 + 0.65*smoothstep(1.6, 3.0, abs(lane))) * (0.6 + n1*0.4);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85,0.88,0.95), snowAmt);
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float puddle = smoothstep(0.55, 0.75, vnoise(vWPos.xz*0.15));
        roughnessFactor = mix(roughnessFactor, mix(0.25, 0.04, puddle), uWet*(1.0-isDirt*0.6));
        diffuseColor.rgb *= 1.0 - uWet*0.3;`,
      );
  };
  return m;
}

export function makeConcreteMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x8a8580, roughness: 0.9, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, worldUniforms);
    injectWorldPos(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNorm;\n${NOISE_GLSL}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>\n diffuseColor.rgb *= 0.75 + vnoise(vWPos.xz*2.0 + vWPos.y)*0.25 + vnoise(vWPos.xy*0.3)*0.15;
         diffuseColor.rgb *= 0.9 + 0.1*step(0.5, fract(vWPos.y*0.5));`,
      );
  };
  return m;
}
