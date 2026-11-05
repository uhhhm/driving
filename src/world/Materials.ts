import * as THREE from 'three';

/** Uniforms shared by all world materials (weather, time, night). */
export const worldUniforms = {
  uTime: { value: 0 },
  uWet: { value: 0 }, // 0..1 rain wetness
  uSnow: { value: 0 }, // 0..1 snow cover
  uNight: { value: 0 }, // 0..1
  uDetail: { value: 1 }, // per-pixel terrain detail (0 on the Low preset)
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

/**
 * Terrain: vertex colours carry the biome palette (2–8 m resolution). Everything finer is done
 * per pixel here so the ground holds up close: grass clumps and dirt patches, wind-rippled sand,
 * layered rock strata on steep faces (triplanar), gravel shoulders, concrete grime, plus a
 * derivative-based bump so the detail catches the light. Fine detail fades out with distance
 * (no shimmer) and is skipped entirely on the Low quality preset (uDetail = 0).
 */
export function makeTerrainMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, worldUniforms);
    injectWorldPos(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aDetail;\nvarying vec4 vDetail;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvDetail = aDetail;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNorm;\nvarying vec4 vDetail;\nuniform float uWet; uniform float uSnow; uniform float uTime; uniform float uDetail;\n${NOISE_GLSL}
        // bump from screen-space derivatives of a scalar height (view space in, view space out)
        vec2 rot2(vec2 p) { return mat2(0.8, -0.6, 0.6, 0.8) * p; }
        vec3 terrainBump(vec3 pos, vec3 n, float h, float fd) {
          vec3 sx = dFdx(pos), sy = dFdy(pos);
          vec3 r1 = cross(sy, n), r2 = cross(n, sx);
          float det = dot(sx, r1) * fd;
          vec2 dh = vec2(dFdx(h), dFdy(h));
          vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
          return normalize(abs(det) * n - grad);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec2 xz = vWPos.xz;
        vec3 wn = normalize(vWNorm);
        float up = clamp(wn.y, 0.0, 1.0);
        float camD = length(vWPos - cameraPosition);
        float fine = uDetail * (1.0 - smoothstep(45.0, 140.0, camD)); // close-up detail
        float midD = uDetail * (1.0 - smoothstep(180.0, 520.0, camD)); // rock strata, patches
        float wDes = vDetail.x, wAlp = vDetail.y, wCoa = vDetail.z, shoulder = vDetail.w;
        float wCity = clamp(1.0 - wDes - wAlp - wCoa, 0.0, 1.0);
        float rockM = smoothstep(0.86, 0.62, up); // steep faces (vertex colour is already rock there)
        float flatM = 1.0 - rockM;
        float beach = wCoa * smoothstep(4.5, 1.5, vWPos.y);
        float grassW = clamp((wAlp + wCoa - beach) * flatM * (1.0 - shoulder), 0.0, 1.0);
        float sandW = clamp((wDes + beach) * flatM * (1.0 - shoulder * 0.6), 0.0, 1.0);
        float lum0 = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
        float snowy = wAlp * smoothstep(0.6, 0.8, lum0);
        grassW *= 1.0 - snowy;

        // large-scale patches: breaks up the flat look at every distance
        float macro = vnoise(xz * 0.027) * 0.6 + vnoise(xz * 0.09 + 31.0) * 0.4;
        float dn = vnoise(xz * 0.35) * 0.5 + vnoise(xz * 1.7) * 0.3 + vnoise(xz * 7.0) * 0.2;
        diffuseColor.rgb *= 0.84 + dn * 0.32;
        diffuseColor.rgb *= 0.9 + macro * 0.2;
        // sun-dried grass in some patches, lush in others
        float dry = smoothstep(0.5, 0.78, macro) * grassW;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.45, 1.2, 0.62), dry * 0.55);

        float bumpH = 0.0;
        if (uDetail > 0.5) {
          // grass: clumps + scattered bare dirt patches
          float clump = vnoise(xz * 2.6) * 0.55 + vnoise(rot2(xz) * 9.0) * 0.45;
          diffuseColor.rgb *= mix(1.0, 0.72 + clump * 0.5, grassW * fine);
          float bare = smoothstep(0.66, 0.8, vnoise(xz * 0.16 + 17.0) + clump * 0.12) * grassW * midD;
          vec3 dirt = vec3(0.26, 0.2, 0.13) * (0.8 + dn * 0.4);
          diffuseColor.rgb = mix(diffuseColor.rgb, dirt, bare * 0.75);
          bumpH += (clump * 0.06) * grassW * fine;

          // sand: wind ripples whose direction wanders, plus darker scrub specks
          float wv = vnoise(xz * 0.045) * 7.0;
          float rp = sin(dot(xz, vec2(0.84, 0.54)) * 2.4 + wv + vnoise(xz * 0.5) * 2.5) * 0.5 + 0.5;
          rp = rp * rp;
          diffuseColor.rgb *= mix(1.0, 0.9 + rp * 0.17, sandW * fine);
          float speck = smoothstep(0.8, 0.9, vnoise(xz * 1.3 + 9.0) * 0.7 + vnoise(xz * 5.0) * 0.3);
          diffuseColor.rgb *= 1.0 - speck * 0.25 * sandW * fine;
          bumpH += rp * 0.07 * sandW * fine;

          // rock: wavy strata + broken faces, projected along the face (triplanar on x/z).
          // Several rotated octaves so value-noise cells never line up into "bricks".
          if (rockM > 0.01) {
            vec3 an = abs(wn); an = an * an; an /= (an.x + an.y + an.z);
            vec2 px = vec2(vWPos.z, vWPos.y), pz = vec2(vWPos.x, vWPos.y);
            mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
            float rkx = vnoise(px * vec2(0.45, 0.9)) * 0.45 + vnoise(rot * px * 1.9 + 3.0) * 0.35 + vnoise(rot * rot * px * 5.3) * 0.2;
            float rkz = vnoise(pz * vec2(0.45, 0.9) + 11.0) * 0.45 + vnoise(rot * pz * 1.9 + 7.0) * 0.35 + vnoise(rot * rot * pz * 5.3) * 0.2;
            float rky = vnoise(xz * 0.9) * 0.6 + vnoise(rot * xz * 3.1) * 0.4;
            float rk = rkx * an.x + rkz * an.z + rky * an.y;
            // canyon walls get bold layered strata; other biomes a gentler, cracked look
            float strataK = mix(0.35, 1.0, wDes);
            float ledge = fract(vWPos.y * 0.3 + rk * 1.1 + vnoise(xz * 0.07) * 2.0);
            float lip = smoothstep(0.0, 0.18, ledge) * smoothstep(1.0, 0.7, ledge); // lighter ledge tops, dark undercuts
            float strata = (0.72 + rk * 0.42) * mix(1.0, 0.8 + 0.28 * lip, strataK);
            diffuseColor.rgb *= mix(1.0, strata, rockM * midD);
            bumpH += (rk * 0.22 + lip * 0.18 * strataK) * rockM * midD;
          }

          // snow: soft wind-blown drifts
          diffuseColor.rgb *= mix(1.0, 0.93 + vnoise(xz * 0.6) * 0.1, snowy * fine);
          bumpH += vnoise(xz * 0.6) * 0.12 * snowy * fine;

          // road shoulders: gravel
          float grav = vnoise(xz * 6.0) * 0.55 + vnoise(rot2(xz) * 17.0) * 0.45;
          diffuseColor.rgb *= mix(1.0, 0.84 + grav * 0.3, shoulder * fine * 0.85);
          bumpH += grav * 0.02 * shoulder * fine;

          // city lots: concrete grime + stains
          float grime = vnoise(xz * 3.0) * 0.5 + vnoise(xz * 0.4) * 0.5;
          diffuseColor.rgb *= mix(1.0, 0.82 + grime * 0.3, wCity * flatM * fine);
        }

        float snowAmt = smoothstep(0.55, 0.85, up) * smoothstep(0.2, 0.6, uSnow + dn*0.3 - 0.15);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92,0.94,1.0), snowAmt);
        diffuseColor.rgb *= 1.0 - uWet*0.35*(1.0-snowAmt);
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.45, uWet*(1.0-snowAmt));`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\nif (uDetail > 0.5) normal = terrainBump(-vViewPosition, normal, bumpH * (1.0 - snowAmt * 0.7), faceDirection);`,
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
