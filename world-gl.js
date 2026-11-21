// world-gl.js — 渓谷・岩（隕石・岩柱・岩橋）・火花の WebGL2 描画。
//
// space-fx.js の 2 枚のキャンバス（モデルより奥 = back / 手前 = front）それぞれに 1 つずつ作る。
// どちらも同じ形を描き、モデル中心の深さ（uSplit）で前後に振り分ける。奥の層はビューアの
// キャンバスの後ろにあるのでスプラットに隠れ、手前の層はスプラットの上に重なる。
//
// 色はガンマ 2 で扱う（入力の sRGB を 2 乗して光を計算し、最後に平方根で戻す）。
// 遠くは背景（index.html の CSS のグラデーション）の色に霞み、さらに遠くは透明になって背景に溶ける。

import {
    RING_COUNT,
    PROFILE_N,
    VERT_FLOATS,
    ROCK_VARIANTS,
    ROCK_FLOATS,
    MAX_ROCKS,
    SPARK_FLOATS,
    MAX_SPARKS,
    MAX_BLOBS,
    TAIL_FLOATS,
    MAX_TAILS,
    SUN
} from './world.js';
import { getRockShapes, ROCK_VERT_FLOATS } from './rock-shapes.js';

export const LOOK = {
    sunCol: [1.0, 0.84, 0.64],
    sunPower: 2.4,
    skyCol: [0.45, 0.58, 0.9],
    skyPower: 0.55,
    groundCol: [0.6, 0.4, 0.28],
    groundPower: 0.32,
    fogCol: [0.085, 0.18, 0.4], // 背景の地平線あたりの色
    fogStart: 30,
    fogDist: 170,
    fadeStart: 230,
    fadeEnd: 292,
    rockSaturation: 0.5, // 隕石の彩度（1 = 光の色そのまま、0 = 灰色）。熱で光るひび・彗星は別
    near: 0.1,
    far: 700
};

const lin = (c, k = 1) => c.map((v) => v * v * k);

// ---------------------------------------------------------------------------------------------
// shaders

const COMMON = `
uniform mat4 uGameView;   // game coordinates → camera view space
uniform vec4 uProj;       // P0, P5, A, B: clip = (P0 x, P5 y, A d + B, d), d = view depth
uniform float uLayer;     // 0 behind the model, 1 in front of it
uniform float uSplit;     // view depth of the model's centre
uniform vec3 uSun;
uniform vec3 uSunCol;
uniform vec3 uSkyCol;
uniform vec3 uGroundCol;
uniform vec3 uFogCol;
uniform vec4 uFog;        // fog start, 1 / fog distance, fade start, fade end
uniform vec3 uCam;        // camera position (game coordinates)
uniform float uFlash;
uniform float uTime;

float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x),
                   mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
               mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x),
                   mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
// octaves on turned grids, so the cells of one never line up with the next (no blocky bump)
const mat3 ROT1 = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
const mat3 ROT2 = mat3(0.64, -0.48, 0.60, 0.60, 0.80, 0.00, -0.48, 0.36, 0.80);
float rockNoise(vec3 p, vec3 stretch, out float n2) {
    float n1 = vnoise(p * stretch);
    n2 = vnoise(ROT1 * p * 1.9 + 3.1);
    float n3 = vnoise(ROT2 * p * 4.7 + 7.7);
    return n1 * 0.58 + n2 * 0.3 + n3 * 0.12;
}
// which layer draws a fragment. Solid surfaces overlap a little: the back layer also draws a band
// just in front of the split, so where the front layer's edge goes soft as the browser scales the
// canvases, there is still rock under it (no dark seam). The front layer's copy covers it anyway
bool otherLayer(float depth, float overlap) {
    return uLayer > 0.5 ? depth >= uSplit : depth < uSplit - overlap;
}
vec4 project(vec3 g, out float depth) {
    vec4 v = uGameView * vec4(g, 1.0);
    depth = -v.z;
    return vec4(uProj.x * v.x, uProj.y * v.y, uProj.z * depth + uProj.w, depth);
}
`;

// fragment shaders only (screen-space derivatives)
const FRAG = `
// small craters pitting a meteor: round each of a scatter of points (one per cell) a bowl with a
// raised rim. The surface cuts the 3D balls at random heights, so the pits come in all sizes.
// Returns the height (about -1 in a pit's middle, a little above 0 on its rim)
float pits(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    float h = 0.0;
    for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 c = g + vec3(hash13(i + g), hash13(i + g + 17.1), hash13(i + g + 31.7)) - f;
        float r = 0.22 + 0.36 * hash13(i + g + 5.3);
        float t = length(c) / r;
        if (t < 1.0) h -= 1.0 - t * t;
        h += 0.3 * exp(-(t - 1.0) * (t - 1.0) * 16.0);
    }
    return h;
}
// tilt the normal along a height pattern h (in world units), from its screen-space slope
vec3 bump(vec3 N, vec3 p, float h, float k) {
    vec3 dpx = dFdx(p);
    vec3 dpy = dFdy(p);
    vec3 r1 = cross(dpy, N);
    vec3 r2 = cross(N, dpx);
    float det = dot(dpx, r1);
    vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
    return normalize(abs(det) * N - k * grad);
}
// layered canyon rock: bands by absolute height, gently warped
vec3 strata(vec3 p, float h) {
    float warp = vnoise(vec3(p.x * 0.03, 0.0, p.z * 0.03)) * 3.0 + vnoise(p * 0.12) * 0.6;
    float b = (p.y + warp) * 0.31;
    float s = fract(b);
    float lv = hash13(vec3(floor(b), 1.7, 3.1));
    vec3 c = mix(vec3(0.58, 0.32, 0.2), vec3(0.74, 0.53, 0.36), lv);
    c = mix(c, vec3(0.38, 0.21, 0.15), smoothstep(0.8, 0.97, s) * 0.85);
    c = mix(c, vec3(0.84, 0.68, 0.5), smoothstep(0.0, 0.08, s) * (1.0 - smoothstep(0.08, 0.2, s)) * 0.45);
    return c * (0.76 + 0.46 * h);
}
vec3 lighting(vec3 N, float sunVis) {
    float sun = max(dot(N, uSun), 0.0) * sunVis;
    float up = N.y * 0.5 + 0.5;
    return uSunCol * sun + uSkyCol * up + uGroundCol * (1.0 - up) + uFlash * vec3(1.0, 0.6, 0.3);
}
// fog towards the backdrop, then fade out into it; returns premultiplied colour
vec4 finish(vec3 col, vec3 p) {
    float dist = length(p - uCam);
    float fog = 1.0 - exp(-max(dist - uFog.x, 0.0) * uFog.y);
    col = mix(col, uFogCol, fog);
    float a = 1.0 - smoothstep(uFog.z, uFog.w, dist);
    col = sqrt(max(col, 0.0));
    return vec4(col * a, a);
}
`;

const TERRAIN_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aShade; // ambient occlusion, sun visibility
${COMMON}
out vec3 vPos;
out vec3 vNormal;
out vec2 vShade;
out float vDepth;
void main() {
    vPos = aPos;
    vNormal = aNormal;
    vShade = aShade;
    gl_Position = project(aPos, vDepth);
}`;

const TERRAIN_FS = `#version 300 es
precision highp float;
${COMMON}
${FRAG}
uniform vec4 uBlobs[${MAX_BLOBS}]; // x, z, radius, strength
uniform int uBlobN;
in vec3 vPos;
in vec3 vNormal;
in vec2 vShade;
in float vDepth;
out vec4 outColor;
void main() {
    if (otherLayer(vDepth, 1.0)) discard;
    vec3 p = vPos;
    vec3 N0 = normalize(vNormal);
    // rock grain: finer across the layers than along them
    float n2;
    float h = rockNoise(p, vec3(0.42, 1.15, 0.42), n2);
    vec3 N = bump(N0, p, h, 0.55 * (1.0 - smoothstep(25.0, 110.0, vDepth)));

    vec3 alb = strata(p, h);
    // flat ground collects pale dust
    float ground = smoothstep(0.72, 0.95, N0.y);
    alb = mix(alb, vec3(0.7, 0.53, 0.38) * (0.82 + 0.36 * n2), ground * 0.7);
    alb *= alb;

    vec3 light = lighting(N, vShade.y);
    // soft shadows straight down from the player and the rocks
    float blob = 1.0;
    for (int i = 0; i < ${MAX_BLOBS}; i++) {
        if (i >= uBlobN) break;
        vec4 b = uBlobs[i];
        float d = length(p.xz - b.xy) / b.z;
        blob *= 1.0 - b.w * (1.0 - smoothstep(0.25, 1.0, d));
    }
    light *= mix(1.0, blob, ground);
    outColor = finish(alb * light * vShade.x, p);
}`;

const ROCK_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 iPos;
layout(location = 3) in vec3 iScale;
layout(location = 4) in vec4 iQuat;
layout(location = 5) in vec4 iExtra; // heat, sun visibility, seed, kind (0 meteor, 1 canyon rock, 2 comet)
layout(location = 6) in float aAO;   // how open the surface is to the sky (low in necks, cracks, craters)
${COMMON}
out float vAO;
out vec3 vPos;
out vec3 vNormal;
out vec3 vLocal;
out vec4 vExtra;
out float vDepth;
vec3 qrot(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}
void main() {
    vec3 p = iPos + qrot(iQuat, aPos * iScale);
    vPos = p;
    vNormal = qrot(iQuat, aNormal / iScale);
    vLocal = aPos * iScale;
    vExtra = iExtra;
    vAO = aAO;
    gl_Position = project(p, vDepth);
}`;

const ROCK_FS = `#version 300 es
precision highp float;
${COMMON}
${FRAG}
in vec3 vPos;
in vec3 vNormal;
in vec3 vLocal;
in vec4 vExtra;
in float vAO;
in float vDepth;
out vec4 outColor;
void main() {
    if (otherLayer(vDepth, 1.0)) discard;
    vec3 N0 = normalize(vNormal);
    float seed = vExtra.z * 61.0;
    bool canyon = vExtra.w > 0.5 && vExtra.w < 1.5;
    bool comet = vExtra.w > 1.5;
    // canyon rock is textured in the world like the walls; meteors in their own frame, so the
    // pattern tumbles with them
    vec3 lp = canyon ? vPos : vLocal + seed;
    float n2;
    float h = rockNoise(lp, vec3(0.5, canyon ? 1.15 : 0.5, 0.5), n2);
    float n1 = h;
    // meteors: pitted all over with small craters (fixed size in the world: a big rock has many)
    float pit = 0.0;
    if (!canyon) pit = pits(lp * 1.7) * (1.0 - smoothstep(30.0, 90.0, vDepth));
    vec3 N = bump(N0, vPos, h + pit * 0.16, 0.6 * (1.0 - smoothstep(25.0, 110.0, vDepth)));

    vec3 alb;
    if (canyon) {
        alb = strata(vPos, h);
    } else if (comet) {
        // dirty ice
        alb = mix(vec3(0.55, 0.62, 0.7), vec3(0.85, 0.92, 1.0), smoothstep(0.3, 0.7, n1));
    } else {
        // each meteor its own stone: from neutral grey to a warm brown, lighter or darker
        float tone = fract(vExtra.z * 7.31);
        vec3 dark = mix(vec3(0.36, 0.36, 0.37), vec3(0.42, 0.36, 0.3), tone);
        vec3 pale = mix(vec3(0.56, 0.56, 0.56), vec3(0.62, 0.52, 0.42), tone);
        alb = mix(dark, pale, smoothstep(0.35, 0.75, n1));
        alb *= (0.7 + 0.55 * h) * mix(0.78, 1.12, fract(vExtra.z * 3.77)) * (1.0 + 0.22 * clamp(pit, -1.0, 0.3));
    }
    float heat = comet ? 0.0 : vExtra.x;
    alb *= mix(1.0, 0.35, heat); // charred
    alb *= alb;
    // hollows get less light: sky and sun alike, a little less for the sun (it is a small source)
    float ao = canyon ? 1.0 : vAO;
    vec3 col = alb * lighting(N, vExtra.y * mix(0.4, 1.0, ao)) * mix(0.35, 1.0, ao);
    vec3 V = normalize(uCam - vPos);
    float rim = pow(1.0 - max(dot(N0, V), 0.0), 3.0);
    // a cool rim of skylight, so a meteor stands out against the night sky
    if (!canyon) col += uSkyCol * 0.9 * rim * ao;
    // meteors: less colour than the warm sun and the blue sky would give them
    if (!canyon && !comet) col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, ${LOOK.rockSaturation.toFixed(2)});

    // heat: glowing cracks and a hot rim
    if (heat > 0.0) {
        float c = 1.0 - abs(vnoise(lp * 0.9 + 20.0) * 2.0 - 1.0);
        c = smoothstep(0.86, 0.98, c) * (0.75 + 0.25 * sin(uTime * 9.0 + seed));
        float fres = pow(1.0 - max(dot(N0, V), 0.0), 2.5);
        col += heat * (vec3(1.6, 0.42, 0.06) * c + vec3(1.1, 0.3, 0.05) * fres * heat);
    }
    // comet: ice lit from within, vents of bright gas and a blue-white glow at the limb
    if (comet) {
        float c = 1.0 - abs(vnoise(lp * 0.8 + 40.0) * 2.0 - 1.0);
        c = smoothstep(0.82, 0.98, c) * (0.8 + 0.2 * sin(uTime * 6.0 + seed));
        float fres = pow(1.0 - max(dot(N0, V), 0.0), 2.0);
        col += vec3(0.35, 0.5, 0.65) + vec3(1.4, 1.8, 2.2) * c + vec3(0.9, 1.4, 2.0) * fres;
    }
    outColor = finish(col, vPos);
}`;

const SPARK_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iPosSize;
layout(location = 2) in vec4 iColor;
${COMMON}
out vec2 vUv;
out vec4 vColor;
out float vDepth;
void main() {
    vec4 v = uGameView * vec4(iPosSize.xyz, 1.0);
    v.xy += aCorner * iPosSize.w * 0.5;
    vDepth = -v.z;
    vUv = aCorner;
    vColor = iColor;
    gl_Position = vDepth < 0.05 ? vec4(2.0, 2.0, 2.0, 1.0)
        : vec4(uProj.x * v.x, uProj.y * v.y, uProj.z * vDepth + uProj.w, vDepth);
}`;

const SPARK_FS = `#version 300 es
precision highp float;
${COMMON}
${FRAG}
in vec2 vUv;
in vec4 vColor;
in float vDepth;
out vec4 outColor;
void main() {
    if (otherLayer(vDepth, 0.0)) discard;
    float d2 = dot(vUv, vUv);
    if (d2 > 1.0) discard;
    float a = exp(-d2 * 4.0) * (1.0 - d2);
    vec3 light = vColor.rgb * vColor.a * a;
    vec3 rgb = (1.0 - exp(-light * 1.6)) * exp(-max(vDepth - uFog.x, 0.0) * uFog.y * 0.7);
    // light that also covers what is behind it in proportion to its brightness: pure light
    // (alpha 0) is dropped by some of the browser's compositing paths
    outColor = vec4(rgb, max(rgb.r, max(rgb.g, rgb.b)));
}`;

// comet tails: one strip from the head out along the tail, built on screen (like the thruster jets
// in space-fx.js), so it never breaks into blobs and still shows when seen nearly end-on
const TAIL_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 iHead;
layout(location = 2) in vec3 iTail;    // from the head to the tip
layout(location = 3) in vec4 iShape;   // width at the head, width at the tip, intensity, seed
layout(location = 4) in vec4 iColor;
${COMMON}
uniform vec2 uViewport;
out vec2 vUv;
out vec3 vColor;
out float vInten;
out float vSeed;
out float vDepth;
void main() {
    vColor = iColor.rgb;
    vInten = iShape.z;
    vSeed = iShape.w;
    vUv = vec2(aCorner.x * 0.5 + 0.5, aCorner.y);
    vec4 v0 = uGameView * vec4(iHead, 1.0);
    vec4 v1 = uGameView * vec4(iHead + iTail, 1.0);
    float d0 = -v0.z;
    float d1 = -v1.z;
    vDepth = d0;
    if (d0 < 1.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }
    // the tip behind the camera: cut the strip short
    if (d1 < 1.0) {
        v1 = mix(v0, v1, (d0 - 1.0) / max(d0 - d1, 1e-3));
        d1 = 1.0;
    }
    vec2 hv = uViewport * 0.5;
    vec2 s0 = vec2(uProj.x * v0.x, uProj.y * v0.y) / d0 * hv;
    vec2 s1 = vec2(uProj.x * v1.x, uProj.y * v1.y) / d1 * hv;
    float w0 = iShape.x * uProj.y * hv.y / d0;
    float w1 = iShape.y * uProj.y * hv.y / d1;
    vec2 seg = s1 - s0;
    float len = length(seg);
    vec2 along = len > 1e-3 ? seg / len : vec2(1.0, 0.0);
    // seen end-on it would shrink to nothing: keep it at least about as long as it is wide
    float shown = max(len, 0.8 * max(w0, w1));
    float t = vUv.x;
    vec2 p = s0 + along * mix(-0.25 * w0, shown, t) + vec2(-along.y, along.x) * aCorner.y * mix(w0, w1, t) * 0.5;
    float d = mix(d0, d1, t);
    vDepth = d;
    gl_Position = vec4(p / hv, uProj.z + uProj.w / d, 1.0);
}`;

const TAIL_FS = `#version 300 es
precision highp float;
${COMMON}
${FRAG}
in vec2 vUv;
in vec3 vColor;
in float vInten;
in float vSeed;
in float vDepth;
out vec4 outColor;
void main() {
    if (otherLayer(vDepth, 0.0)) discard;
    float u = vUv.x;
    float v = vUv.y;
    float across = exp(-v * v * 3.0) * (1.0 - v * v);
    float alongP = smoothstep(0.0, 0.06, u) * pow(max(1.0 - u, 0.0), 1.4);
    // streamers flowing out along the tail
    vec2 q = vec2(u * 6.0 - uTime * 1.6, v * 2.2 + vSeed);
    float n = 0.6 * vnoise(vec3(q, vSeed)) + 0.4 * vnoise(vec3(q * 2.3, vSeed + 7.0));
    float L = vInten * across * alongP * mix(0.5, 1.35, n);
    // white near the head, the tail's own colour further out
    vec3 col = mix(vec3(1.0), vColor, smoothstep(0.0, 0.3, u));
    vec3 rgb = (1.0 - exp(-col * L * 1.6)) * exp(-max(vDepth - uFog.x, 0.0) * uFog.y * 0.5);
    // light that also covers what is behind it in proportion to its brightness: pure light
    // (alpha 0) is dropped by some of the browser's compositing paths
    outColor = vec4(rgb, max(rgb.r, max(rgb.g, rgb.b)));
}`;

let rockMeshes = null; // shared by both canvases (built once)

// ---------------------------------------------------------------------------------------------

export class WorldGL {
    constructor(gl) {
        this.gl = gl;
        const compile = (type, src) => {
            const sh = gl.createShader(type);
            gl.shaderSource(sh, src);
            gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
            return sh;
        };
        const link = (vs, fs, extra = []) => {
            const prog = gl.createProgram();
            gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
            gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
            const u = {};
            for (const name of [
                'uGameView', 'uProj', 'uLayer', 'uSplit', 'uSun', 'uSunCol', 'uSkyCol', 'uGroundCol',
                'uFogCol', 'uFog', 'uCam', 'uFlash', 'uTime', ...extra
            ]) {
                u[name] = gl.getUniformLocation(prog, name);
            }
            return { prog, u };
        };
        this.terrain = link(TERRAIN_VS, TERRAIN_FS, ['uBlobs', 'uBlobN']);
        this.rock = link(ROCK_VS, ROCK_FS);
        this.spark = link(SPARK_VS, SPARK_FS);
        this.tail = link(TAIL_VS, TAIL_FS, ['uViewport']);

        // terrain: one vertex buffer slot per cross-section, strips between neighbouring slots
        this.terrainVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainVbo);
        gl.bufferData(gl.ARRAY_BUFFER, RING_COUNT * PROFILE_N * VERT_FLOATS * 4, gl.DYNAMIC_DRAW);
        this.uploaded = new Int32Array(RING_COUNT).fill(-1);
        const idx = [];
        for (let k = 0; k < RING_COUNT; k++) {
            const a = k * PROFILE_N;
            const b = ((k + 1) % RING_COUNT) * PROFILE_N;
            for (let j = 0; j < PROFILE_N - 1; j++) {
                idx.push(a + j, b + j, a + j + 1, a + j + 1, b + j, b + j + 1);
            }
        }
        this.indicesPerPair = (PROFILE_N - 1) * 6;
        this.terrainVao = gl.createVertexArray();
        gl.bindVertexArray(this.terrainVao);
        const ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainVbo);
        const stride = VERT_FLOATS * 4;
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
        gl.bindVertexArray(null);

        // rocks: instanced meshes, one per shape (rock-shapes.js)
        if (!rockMeshes) rockMeshes = getRockShapes();
        this.rocks = rockMeshes.map((mesh) => {
            const vao = gl.createVertexArray();
            gl.bindVertexArray(vao);
            const vbo = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
            gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
            const vs = ROCK_VERT_FLOATS * 4;
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, vs, 0);
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(1, 3, gl.FLOAT, false, vs, 12);
            gl.enableVertexAttribArray(6);
            gl.vertexAttribPointer(6, 1, gl.FLOAT, false, vs, 24);
            const ib = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.index, gl.STATIC_DRAW);
            const inst = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, inst);
            gl.bufferData(gl.ARRAY_BUFFER, MAX_ROCKS * ROCK_FLOATS * 4, gl.DYNAMIC_DRAW);
            let off = 0;
            [3, 3, 4, 4].forEach((n, i) => {
                gl.enableVertexAttribArray(2 + i);
                gl.vertexAttribPointer(2 + i, n, gl.FLOAT, false, ROCK_FLOATS * 4, off * 4);
                gl.vertexAttribDivisor(2 + i, 1);
                off += n;
            });
            gl.bindVertexArray(null);
            return { vao, inst, count: mesh.index.length };
        });

        // sparks: camera-facing quads
        this.sparkVao = gl.createVertexArray();
        gl.bindVertexArray(this.sparkVao);
        const quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        this.sparkInst = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkInst);
        gl.bufferData(gl.ARRAY_BUFFER, MAX_SPARKS * SPARK_FLOATS * 4, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, SPARK_FLOATS * 4, 0);
        gl.vertexAttribDivisor(1, 1);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 4, gl.FLOAT, false, SPARK_FLOATS * 4, 16);
        gl.vertexAttribDivisor(2, 1);
        gl.bindVertexArray(null);

        // comet tails: the same quad corners, one instance per tail
        this.tailVao = gl.createVertexArray();
        gl.bindVertexArray(this.tailVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        this.tailInst = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.tailInst);
        gl.bufferData(gl.ARRAY_BUFFER, MAX_TAILS * TAIL_FLOATS * 4, gl.DYNAMIC_DRAW);
        {
            let off = 0;
            [3, 3, 4, 4].forEach((n, i) => {
                gl.enableVertexAttribArray(1 + i);
                gl.vertexAttribPointer(1 + i, n, gl.FLOAT, false, TAIL_FLOATS * 4, off * 4);
                gl.vertexAttribDivisor(1 + i, 1);
                off += n;
            });
        }
        gl.bindVertexArray(null);

        this.colors = {
            sun: lin(LOOK.sunCol, LOOK.sunPower),
            sky: lin(LOOK.skyCol, LOOK.skyPower),
            ground: lin(LOOK.groundCol, LOOK.groundPower),
            fog: lin(LOOK.fogCol)
        };
    }

    setCommon(p, frame, layer) {
        const { gl } = this;
        const { u } = p;
        const n = LOOK.near;
        const f = LOOK.far;
        gl.uniformMatrix4fv(u.uGameView, false, frame.gameView);
        gl.uniform4f(u.uProj, frame.p0, frame.p5, (f + n) / (f - n), (-2 * f * n) / (f - n));
        gl.uniform1f(u.uLayer, layer);
        gl.uniform1f(u.uSplit, frame.focus);
        gl.uniform3fv(u.uSun, SUN);
        gl.uniform3fv(u.uSunCol, this.colors.sun);
        gl.uniform3fv(u.uSkyCol, this.colors.sky);
        gl.uniform3fv(u.uGroundCol, this.colors.ground);
        gl.uniform3fv(u.uFogCol, this.colors.fog);
        gl.uniform4f(u.uFog, LOOK.fogStart, 1 / LOOK.fogDist, frame.fadeRange[0], frame.fadeRange[1]);
        gl.uniform3fv(u.uCam, frame.camG);
        gl.uniform1f(u.uFlash, frame.flash);
        gl.uniform1f(u.uTime, frame.time);
    }

    drawTerrain(frame, world, layer) {
        const { gl } = this;
        const t = world.terrain;
        const p = this.terrain;
        gl.useProgram(p.prog);
        this.setCommon(p, frame, layer);
        gl.uniform4fv(p.u.uBlobs, world.blobs);
        gl.uniform1i(p.u.uBlobN, world.blobCount);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.terrainVbo);
        const slotFloats = PROFILE_N * VERT_FLOATS;
        for (let s = 0; s < RING_COUNT; s++) {
            if (this.uploaded[s] === t.version[s]) continue;
            gl.bufferSubData(gl.ARRAY_BUFFER, s * slotFloats * 4, t.data, s * slotFloats, slotFloats);
            this.uploaded[s] = t.version[s];
        }
        gl.bindVertexArray(this.terrainVao);
        // every strip but the one from the newest cross-section round to the oldest
        const newest = t.newestSlot;
        const ipp = this.indicesPerPair;
        if (newest < RING_COUNT - 1) gl.drawElements(gl.TRIANGLES, (RING_COUNT - 1 - newest) * ipp, gl.UNSIGNED_SHORT, (newest + 1) * ipp * 2);
        if (newest > 0) gl.drawElements(gl.TRIANGLES, newest * ipp, gl.UNSIGNED_SHORT, 0);
    }

    // opaque: canyon and rocks (writes depth)
    drawSolid(frame, world, layer) {
        const { gl } = this;
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.disable(gl.CULL_FACE);

        // canyon (only in canyon mode)
        if (world.canyon) this.drawTerrain(frame, world, layer);

        // rocks
        const r = this.rock;
        gl.useProgram(r.prog);
        this.setCommon(r, frame, layer);
        for (let v = 0; v < ROCK_VARIANTS; v++) {
            const n = world.rockCount[v];
            if (!n) continue;
            const m = this.rocks[v];
            gl.bindBuffer(gl.ARRAY_BUFFER, m.inst);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, world.rockData[v], 0, n * ROCK_FLOATS);
            gl.bindVertexArray(m.vao);
            gl.drawElementsInstanced(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0, n);
        }
        gl.bindVertexArray(null);
    }

    // light: sparks, fire, flashes (added, depth tested but not written)
    drawGlow(frame, world, layer) {
        const { gl } = this;
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        if (world.tailCount) {
            const t = this.tail;
            gl.useProgram(t.prog);
            this.setCommon(t, frame, layer);
            gl.uniform2f(t.u.uViewport, frame.vw, frame.vh);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.tailInst);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, world.tails, 0, world.tailCount * TAIL_FLOATS);
            gl.bindVertexArray(this.tailVao);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, world.tailCount);
        }
        const n = world.sparks.count;
        if (!n) {
            gl.bindVertexArray(null);
            return;
        }
        const p = this.spark;
        gl.useProgram(p.prog);
        this.setCommon(p, frame, layer);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkInst);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, world.sparks.out, 0, n * SPARK_FLOATS);
        gl.bindVertexArray(this.sparkVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
        gl.bindVertexArray(null);
    }
}
