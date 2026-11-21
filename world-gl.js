// world-gl.js — 地形（渓谷・要塞の溝）・岩（隕石・岩柱・岩橋）・要塞の箱・火花の WebGL2 描画。
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

// solid surfaces (terrain, rocks, boxes): which layer draws a fragment. With the model's body known
// (uProxyOn), the back layer draws everything (under the splat) and the front layer draws only what is
// in front of the body, pixel by pixel: uProxyDepth holds the depth of the body's balls (the same balls
// the game hits with), so a wall or a block covers the model exactly where it is nearer than the model
// there, and is covered by it where it is behind. Without it: split at the model's centre (otherLayer)
const SOLID = `
uniform float uProxyOn;
uniform float uBodyR;     // how far the body reaches from its centre (view depth)
uniform highp sampler2D uProxyDepth;
bool solidHidden(float depth) {
    if (uProxyOn < 0.5) return otherLayer(depth, 1.0);
    if (uLayer < 0.5) return false;
    // wholly behind the model: the back layer's copy is enough (no fading drawn twice)
    if (depth > uSplit + uBodyR) return true;
    float body = texelFetch(uProxyDepth, ivec2(gl_FragCoord.xy), 0).r;
    return gl_FragCoord.z > body;
}
`;

// fragment shaders only (screen-space derivatives)
const FRAG = `
// the fortress's hull plating: 4-unit cells, some split in two or four. Each panel stands proud or
// sits sunk in (with a wide bevel, so the light catches one edge and the other falls in shade), some
// carry a raised inner plate or a sunken frame, ribs or a vent; dark deep seams between; a rare small
// lamp. uv: the surface's own two directions in world units. Returns the albedo; h: the height (for
// bump, world units); lamp: the lamps' light
vec3 plating(vec2 uv, float salt, out float h, out float lamp) {
    vec2 c = uv / 4.0;
    vec2 ci = floor(c);
    vec2 cf = fract(c);
    float r = hash13(vec3(ci, salt));
    vec2 split = vec2(r > 0.45 ? 2.0 : 1.0, fract(r * 7.13) > 0.5 ? 2.0 : 1.0);
    vec2 sc = cf * split;
    vec2 si = floor(sc);
    vec2 sf = fract(sc);
    vec3 id = vec3(ci * 2.0 + si, salt + 3.0);
    float tone = hash13(id);
    float kind = hash13(id + 17.0);
    vec2 size = 4.0 / split;
    vec2 e = min(sf, 1.0 - sf) * size;
    float edge = min(e.x, e.y);
    float seam = 1.0 - smoothstep(0.05, 0.16, edge);
    // proud, sunk or flush, over a bevel about a third of a unit wide
    float raise = kind > 0.7 ? 0.55 : (kind < 0.22 ? -0.5 : 0.12);
    h = raise * smoothstep(0.08, 0.42, edge);
    float patchy = hash13(vec3(floor(uv / 13.0), salt + 9.0));
    vec3 col = vec3(0.47, 0.49, 0.52) * mix(0.72, 1.12, tone) * mix(0.82, 1.06, patchy);
    float inset = min(size.x, size.y) * 0.22;
    if (kind > 0.3 && kind < 0.45) {
        // a raised plate inside the panel
        float inner = smoothstep(inset, inset + 0.18, edge);
        h += 0.3 * inner;
        col *= 1.0 + 0.08 * inner;
    } else if (kind > 0.45 && kind < 0.58) {
        // ribs across
        float rib = abs(fract(sf.y * size.y / 0.45) - 0.5);
        h += 0.16 * smoothstep(0.08, 0.28, rib);
        col *= 0.86 + 0.14 * smoothstep(0.08, 0.3, rib);
    } else if (kind > 0.58 && kind < 0.67) {
        // a vent: a deep dark slot
        float vent = step(abs(sf.x - 0.5) * size.x, size.x * 0.32) * step(abs(sf.y - 0.5) * size.y, size.y * 0.16);
        col *= 1.0 - 0.7 * vent;
        h -= 0.35 * vent;
    } else if (kind > 0.67 && kind < 0.7) {
        // a sunken frame round a flush centre
        float frame = smoothstep(inset - 0.1, inset, edge) * (1.0 - smoothstep(inset + 0.15, inset + 0.25, edge));
        h -= 0.25 * frame;
        col *= 1.0 - 0.35 * frame;
    }
    // deep seams; sunken panels and slots darker inside (less light gets in)
    h -= 0.3 * seam;
    col *= 1.0 - 0.65 * seam;
    col *= 1.0 - 0.3 * clamp(-h * 1.6, 0.0, 1.0);
    lamp = 0.0;
    if (hash13(id + 41.0) > 0.93) {
        lamp = 1.0 - smoothstep(0.06, 0.12, length(sf * size - vec2(0.35)));
    }
    return col;
}
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
${SOLID}
${FRAG}
uniform vec4 uBlobs[${MAX_BLOBS}]; // x, z, radius, strength
uniform int uBlobN;
uniform float uStyle; // 0 canyon rock, 1 the fortress's metal plating
in vec3 vPos;
in vec3 vNormal;
in vec2 vShade;
in float vDepth;
out vec4 outColor;
float blobShadow(vec3 p) {
    float blob = 1.0;
    for (int i = 0; i < ${MAX_BLOBS}; i++) {
        if (i >= uBlobN) break;
        vec4 b = uBlobs[i];
        float d = length(p.xz - b.xy) / b.z;
        blob *= 1.0 - b.w * (1.0 - smoothstep(0.25, 1.0, d));
    }
    return blob;
}
void main() {
    if (solidHidden(vDepth)) discard;
    vec3 p = vPos;
    vec3 N0 = normalize(vNormal);
    if (uStyle > 0.5) {
        // the trench: plates on the floor and the top laid along x/z, on the walls along z/y, with
        // deep grooves every few units up the walls and ribs along them
        bool level = abs(N0.y) > 0.6;
        float h;
        float lamp;
        vec3 alb = plating(level ? p.xz : vec2(p.z, p.y), level ? 1.0 : 2.0, h, lamp);
        if (!level) {
            float band = abs(fract(p.y / 6.5 + 0.5) - 0.5) * 6.5;
            float groove = 1.0 - smoothstep(0.2, 0.55, band);
            h -= 0.7 * groove;
            alb *= 1.0 - 0.45 * groove;
            float rib = abs(fract(p.z / 9.0) - 0.5) * 9.0;
            float ribS = 1.0 - smoothstep(0.3, 0.6, rib);
            h += 0.5 * ribS;
            alb *= 1.0 + 0.12 * ribS;
        }
        vec3 N = bump(N0, p, h, 1.35 * (1.0 - smoothstep(40.0, 150.0, vDepth)));
        alb *= alb;
        vec3 light = lighting(N, vShade.y);
        light *= mix(1.0, blobShadow(p), smoothstep(0.72, 0.95, N0.y));
        vec3 col = alb * light * vShade.x + vec3(1.0, 0.8, 0.55) * lamp * 1.6;
        outColor = finish(col, p);
        return;
    }
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
    light *= mix(1.0, blobShadow(p), ground);
    outColor = finish(alb * light * vShade.x, p);
}`;

const ROCK_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 iPos;
layout(location = 3) in vec3 iScale;
layout(location = 4) in vec4 iQuat;
layout(location = 5) in vec4 iExtra; // heat, sun visibility, seed, kind (0 meteor, 1 canyon rock, 2 comet, 3 obstacle box, 4 decor box)
layout(location = 6) in float aAO;   // how open the surface is to the sky (low in necks, cracks, craters)
${COMMON}
out float vAO;
out vec3 vPos;
out vec3 vNormal;
out vec3 vLocal;
out vec3 vUnit;  // the mesh's own coordinates (a box: -1..1 on each axis)
out vec3 vScale;
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
    vUnit = aPos;
    vScale = iScale;
    vExtra = iExtra;
    vAO = aAO;
    gl_Position = project(p, vDepth);
}`;

const ROCK_FS = `#version 300 es
precision highp float;
${COMMON}
${SOLID}
${FRAG}
in vec3 vPos;
in vec3 vNormal;
in vec3 vLocal;
in vec3 vUnit;
in vec3 vScale;
in vec4 vExtra;
in float vAO;
in float vDepth;
out vec4 outColor;
void main() {
    if (solidHidden(vDepth)) discard;
    vec3 N0 = normalize(vNormal);
    float seed = vExtra.z * 61.0;
    if (vExtra.w > 2.5) {
        // a box of the fortress: plated like the trench, in its own frame (face by face)
        vec3 a = abs(vUnit);
        vec2 uv = a.x > 0.999 ? vLocal.zy : (a.y > 0.999 ? vLocal.xz : vLocal.xy);
        float h;
        float lamp;
        vec3 alb = plating(uv + vExtra.z * 37.0, 5.0, h, lamp);
        vec3 N = bump(N0, vPos, h, 1.2 * (1.0 - smoothstep(40.0, 150.0, vDepth)));
        alb *= alb * (vExtra.w > 3.5 ? 0.85 : 1.0);
        // darker low down, where it meets what it stands on
        float low = 0.6 + 0.4 * smoothstep(-1.0, -0.2, vUnit.y);
        vec3 col = alb * lighting(N, vExtra.y) * low + vec3(1.0, 0.8, 0.55) * lamp * 1.6;
        if (vExtra.w < 3.5) {
            // an obstacle: amber light round the face that meets the player, so its edges (and the
            // opening beside them) read at speed
            float toFront = (vUnit.z + 1.0) * vScale.z;
            vec2 across = vec2((1.0 - a.x) * vScale.x, (1.0 - a.y) * vScale.y);
            float onFront = step(0.999, -vUnit.z);
            float edge = onFront > 0.5 ? min(across.x, across.y) : toFront;
            float strip = 1.0 - smoothstep(0.12, 0.3, edge);
            float pulse = 0.8 + 0.2 * sin(uTime * 5.0 + seed);
            col += vec3(1.0, 0.5, 0.12) * strip * 2.2 * pulse;
        }
        outColor = finish(col, vPos);
        return;
    }
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

// the model's body as depth: each of its balls a sphere facing the camera, writing the depth of its
// front surface (drawn a little larger than it is, so the splat's soft edge is not cut by what is behind)
const PROXY_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iBall; // x, y, z, radius (game coordinates)
uniform mat4 uGameView;
uniform vec4 uProj;
uniform float uInflate;
out vec2 vUv;
out vec3 vC;
out float vR;
void main() {
    vec4 v = uGameView * vec4(iBall.xyz, 1.0);
    float r = iBall.w * uInflate;
    vC = v.xyz;
    vR = r;
    vUv = aCorner;
    vec3 q = v.xyz + vec3(aCorner * r * 1.15, 0.0);
    float d = -q.z;
    gl_Position = d < 0.06 ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(uProj.x * q.x, uProj.y * q.y, uProj.z * d + uProj.w, d);
}`;

const PROXY_FS = `#version 300 es
precision highp float;
uniform vec4 uProj;
in vec2 vUv;
in vec3 vC;
in float vR;
out vec4 outColor;
void main() {
    vec2 uv = vUv * 1.15;
    float q = dot(uv, uv);
    if (q > 1.0) discard;
    float d = max(-vC.z - sqrt(1.0 - q) * vR, 0.06);
    gl_FragDepth = (uProj.z + uProj.w / d) * 0.5 + 0.5;
    outColor = vec4(0.0);
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

// a unit box (-1..1), flat faces: the fortress's blocks
const buildBoxMesh = () => {
    const F = ROCK_VERT_FLOATS;
    const faces = [
        [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
        [[-1, 0, 0], [0, 0, -1], [0, 1, 0]],
        [[0, 1, 0], [1, 0, 0], [0, 0, 1]],
        [[0, -1, 0], [1, 0, 0], [0, 0, -1]],
        [[0, 0, 1], [-1, 0, 0], [0, 1, 0]],
        [[0, 0, -1], [1, 0, 0], [0, 1, 0]]
    ];
    const data = new Float32Array(24 * F);
    const index = [];
    faces.forEach(([n, u, v], f) => {
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        corners.forEach(([a, b], k) => {
            const p = [n[0] + u[0] * a + v[0] * b, n[1] + u[1] * a + v[1] * b, n[2] + u[2] * a + v[2] * b];
            data.set([...p, ...n, 1], (f * 4 + k) * F);
        });
        const o = f * 4;
        index.push(o, o + 1, o + 2, o, o + 2, o + 3);
    });
    return { data, index: new Uint16Array(index) };
};

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
        const SOLID_U = ['uProxyOn', 'uBodyR', 'uProxyDepth'];
        this.terrain = link(TERRAIN_VS, TERRAIN_FS, ['uBlobs', 'uBlobN', 'uStyle', ...SOLID_U]);
        this.rock = link(ROCK_VS, ROCK_FS, SOLID_U);
        this.proxy = link(PROXY_VS, PROXY_FS, ['uInflate']);
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
        if (!rockMeshes) rockMeshes = [...getRockShapes(), buildBoxMesh()];
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

        // the model's body (balls) as depth, rendered into its own depth texture
        this.proxyVao = gl.createVertexArray();
        gl.bindVertexArray(this.proxyVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        this.proxyInst = gl.createBuffer();
        this.proxyCap = 0;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.proxyInst);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
        gl.vertexAttribDivisor(1, 1);
        gl.bindVertexArray(null);
        this.proxyTex = gl.createTexture();
        this.proxyColor = gl.createRenderbuffer();
        this.proxyFbo = gl.createFramebuffer();
        this.proxySize = [0, 0];
        this.proxyOk = true;
        this.sizeProxy(1, 1);

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

    drawTerrain(frame, world, layer, proxyOn = false, body = null) {
        const { gl } = this;
        const t = world.terrain;
        const p = this.terrain;
        gl.useProgram(p.prog);
        this.setCommon(p, frame, layer);
        this.setProxy(p, proxyOn, body);
        gl.uniform4fv(p.u.uBlobs, world.blobs);
        gl.uniform1i(p.u.uBlobN, world.blobCount);
        gl.uniform1f(p.u.uStyle, world.mode === 'trench' ? 1 : 0);
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

    sizeProxy(w, h) {
        const { gl } = this;
        if (this.proxySize[0] === w && this.proxySize[1] === h) return;
        this.proxySize = [w, h];
        gl.bindTexture(gl.TEXTURE_2D, this.proxyTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.proxyColor);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.proxyFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.proxyTex, 0);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.proxyColor);
        this.proxyOk = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // the body's balls into the depth texture (front layer only)
    drawProxy(frame, body) {
        const { gl } = this;
        const w = frame.vw;
        const h = frame.vh;
        this.sizeProxy(w, h);
        if (!this.proxyOk) return false;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.proxyInst);
        if (this.proxyCap < body.n) {
            this.proxyCap = body.n;
            gl.bufferData(gl.ARRAY_BUFFER, body.pts.byteLength, gl.DYNAMIC_DRAW);
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, body.pts, 0, body.n * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.proxyFbo);
        gl.viewport(0, 0, w, h);
        gl.colorMask(false, false, false, false);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        gl.depthMask(true);
        gl.clearDepth(1);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        const p = this.proxy;
        gl.useProgram(p.prog);
        const n = LOOK.near;
        const f = LOOK.far;
        gl.uniformMatrix4fv(p.u.uGameView, false, frame.gameView);
        gl.uniform4f(p.u.uProj, frame.p0, frame.p5, (f + n) / (f - n), (-2 * f * n) / (f - n));
        gl.uniform1f(p.u.uInflate, 1.3);
        gl.bindVertexArray(this.proxyVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, body.n);
        gl.bindVertexArray(null);
        gl.colorMask(true, true, true, true);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, w, h);
        return true;
    }

    // the body's depth for the solid shaders
    setProxy(p, on, body) {
        const { gl } = this;
        gl.activeTexture(gl.TEXTURE7);
        gl.bindTexture(gl.TEXTURE_2D, this.proxyTex);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(p.u.uProxyDepth, 7);
        gl.uniform1f(p.u.uProxyOn, on ? 1 : 0);
        gl.uniform1f(p.u.uBodyR, body ? body.R + 0.5 : 0);
    }

    // opaque: canyon and rocks (writes depth)
    drawSolid(frame, world, layer) {
        const { gl } = this;
        // the model's body, when the game knows it: per-pixel cover between the model and the solids
        const body = world.bodyProxy;
        let proxyOn = !!(body && body.n);
        if (proxyOn && layer > 0.5) proxyOn = this.drawProxy(frame, body);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.disable(gl.CULL_FACE);

        // the ground and walls (the canyon or the trench)
        if (world.terrainOn) this.drawTerrain(frame, world, layer, proxyOn, body);

        // rocks
        const r = this.rock;
        gl.useProgram(r.prog);
        this.setCommon(r, frame, layer);
        this.setProxy(r, proxyOn, body);
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
