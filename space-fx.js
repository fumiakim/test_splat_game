// space-fx.js — 宇宙背景の上に、モデルのまわりをゆっくり漂う光のパーティクルを重ねる。
//
// 仕組み
//  - ビューアのキャンバスは settings.json の background.color を [0,0,0,0] にして透過させ、
//    背景の青いグラデーション（index.html の CSS）が透けて見えるようにする。
//  - パーティクルは 3D 空間（モデルの中心まわり）に置き、ビューアのカメラ行列で投影するので、
//    視点を回すとモデルと一緒に動き、奥行き（視差）が出る。
//  - 描画は 2 枚の WebGL2 キャンバス:
//      back  … ビューアの後ろ（モデルより奥の粒。モデルに隠れる）
//      front … ビューアとUIの間（モデルより手前の粒。モデルの上に重なる）
//    モデル中心より手前か奥かで振り分け、境目はなめらかに重ね合わせる。
//  - 焦点（モデル中心の距離）から外れた粒ほど大きく柔らかいボケ玉になる（被写界深度風）。
//  - 明るい粒は芯が白く飛び、まわりに光が溢れる。モデルの奥には暖色の光の雲ときらめきの塊。
//  - ふくらはぎのスラスター（CONFIG.thrusters）から斜め下へ白い炎を噴き出す（ノズルの光＋
//    ノズルから先端まで一続きの帯。粒の集まりにしないので、近づいても丸い粒に分かれない）。
//
// ゲーム版（game.js から createFx で使う）: カメラとモデルの姿勢はゲームが決める。2 枚のキャンバスには
// 深度バッファを持たせ、渓谷・岩・火花（world-gl.js）を先に描いてから光の粒を重ねる（岩の陰の粒は隠れる）。
// 粒はプレイヤーの移動と逆向きに流れ、速さに応じて尾を引く（モーションブラー）。

import { WorldGL } from './world-gl.js';

const CONFIG = {
    // 数
    dust: 1500, // 細かい光の粒（全体に散らばる）
    orbs: 200, // 少し大きめの光の玉
    flares: 36, // 強く輝く光の玉（白く飛んだ芯と広い光のにじみ）
    clusters: 6, // 光が集まって溢れる場所の数（光の雲＋きらめきの塊）
    clusterDust: 55, // 1 か所あたりのきらめきの粒（増やすと光の塊が濃くなる）
    hazePerCluster: 3, // 1 か所あたりの光の雲
    stars: 1400, // 遠景の星
    // 見た目
    gain: 1.35, // 粒の明るさ
    exposure: 1.3, // 露出（上げると全体が明るくなり、明るい芯が白く飛ぶ）
    glow: 1.0, // 粒のまわりに溢れる光のにじみ（0 = なし）
    haze: 0.6, // 光の雲の明るさ（0 で消える）
    hazeCover: 0.5, // 光の雲が背景の青を覆う割合（上げるほど暖色が濃い）
    cover: 0.6, // ボケ玉が背景を覆う割合（0 = 純粋な加算光、1 = 不透明な円）。上げるほど色が濃く見える
    glowCover: 0.3, // 光のにじみが背景を覆う割合
    aperture: 0.022, // ボケの強さ（大きいほど手前/奥の粒が大きくボケる）
    particleSize: 0.5, // 光の粒（ボケ玉）の見た目の大きさの倍率（1 = 元の大きさ、0.5 = 半分）
    particleOpacity: 0.35, // 光の粒（奥から流れてくる粒）の濃さ（1 = 元のまま、小さいほど透ける）。光の雲・星・炎は別
    maxSizeRatio: 0.2, // ボケ玉の最大直径（画面の高さに対する比）
    frontMaxSizeRatio: 0.12, // モデルより手前のボケ玉の最大直径
    frontBokeh: 0.35, // モデルより手前のボケ玉の明るさ（小さいほどモデルが見やすい）
    frontGlow: 0.45, // モデルより手前の粒の光のにじみ（小さいほどモデルが見やすい）
    softness: 0.9, // 粒のエッジのぼかし（0 = くっきりした円、1 = 中心から外へなめらかに消える）
    // ふくらはぎのスラスターから斜め下へ噴き出す白い炎
    flame: 1.0, // 炎の明るさ（0 で消える）
    flameLength: 1.0, // 炎の長さ（ワールド単位。ノズルの直径がおよそ 0.09）
    flameAngle: 50, // 噴射の向き: 真後ろ（水平）から下へ何度傾けるか
    flameSplay: 0.15, // 左右の炎を外側へ開く量
    flameWidth: 1.0, // 炎の太さ（倍率）
    nozzleSize: 0.09, // ノズルの直径（ワールド単位）
    // ノズルの位置と面の向き（ワールド座標。ビューアでノズルをダブルクリックして拾った値）
    thrusters: [
        { pos: [0.2556, -0.569, -0.0941], normal: [-0.371, 0.222, -0.902] },
        { pos: [-0.2266, -0.6471, -0.1895], normal: [0.292, 0.105, -0.951] }
    ],
    // 炎を隠す物（ワールド座標、静止時の姿勢）。ここにある物がカメラと炎の間に入ると、炎はその後ろに隠れる。
    // 左腕の盾をスプラット上でダブルクリックして測った箱（中心、長さ方向、面の向き、半分の大きさ[長さ, 幅, 厚み]）
    occluders: [
        { center: [0.875, 0.275, -0.03], length: [0.153, -0.988, 0.035], normal: [0.971, 0.157, 0.181], half: [0.87, 0.33, 0.1] }
    ],
    // 動き
    timeScale: 1.0, // 全体の速さ
    speed: 1.0, // 粒が移動する速さ（倍率）。向きは粒ごとにランダムで、ゆっくり曲がりながら進む
    // 配置（モデルの包み込む球の半径 = 1 とした単位）
    innerRadius: 0.8,
    outerRadius: 3.6,
    clusterRadius: [1.6, 3.0],
    clearance: 1.25, // モデルのまわりで粒を出さない範囲（境界箱に対する倍率）
    starRadius: [22, 55],
    wrapSize: 14, // 移動中に繰り返す空間の大きさ（モデルの半径 = 1）。粒の配置範囲より少し大きく
    shutter: 0.022, // 流れる粒の尾の長さ（秒。0 で尾なし）
    // モデルの境界が取れなかったときの代わり（カメラ距離に対する比）
    fallbackRadiusRatio: 0.6,
    maxDpr: 1.5
};

// sRGB の色と出現の重み。添付画像のような金〜橙を主体に、少しだけ淡い青。
const PALETTE = [
    { c: [1.0, 0.7, 0.28], w: 0.38 }, // gold
    { c: [1.0, 0.5, 0.14], w: 0.26 }, // amber
    { c: [1.0, 0.32, 0.08], w: 0.12 }, // orange-red
    { c: [1.0, 0.86, 0.58], w: 0.16 }, // warm white
    { c: [0.5, 0.76, 0.95], w: 0.08 } // pale blue
];
const WARM = PALETTE.slice(0, 4);
const STAR_PALETTE = [
    { c: [0.78, 0.86, 1.0], w: 0.62 },
    { c: [1.0, 0.95, 0.85], w: 0.2 },
    { c: [1.0, 0.75, 0.45], w: 0.18 }
];
// 光の雲: 赤橙〜橙の外側と、クリーム色の明るい芯
const HAZE_PALETTE = [
    { c: [1.0, 0.3, 0.1], w: 0.4 },
    { c: [1.0, 0.5, 0.17], w: 0.4 },
    { c: [0.85, 0.28, 0.3], w: 0.2 }
];
const HAZE_CORE = [1.0, 0.82, 0.55];
// 炎の先の方の色（根元は白）
const FLAME_TAIL = [0.72, 0.86, 1.0];

// occluder boxes with orthonormal axes: u along the length, w the face normal, v across
const OCCLUDERS = (CONFIG.occluders ?? []).map((o) => {
    const norm = (a) => {
        const l = Math.hypot(...a) || 1;
        return a.map((x) => x / l);
    };
    const u = norm(o.length);
    const nn = norm(o.normal);
    const d = nn[0] * u[0] + nn[1] * u[1] + nn[2] * u[2];
    const w = norm([nn[0] - d * u[0], nn[1] - d * u[1], nn[2] - d * u[2]]);
    const v = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    return { center: o.center, u, v, w, half: o.half };
});

// ---------------------------------------------------------------------------------------------
// particles

const mulberry32 = (seed) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const mix = (a, b, t) => a + (b - a) * t;

// kinds
const FIELD = 0; // light particle with depth of field
const STAR = 1; // distant star, fixed pixel size
const HAZE = 2; // large soft cloud of light, behind the model only
const FLAME = 3; // glow at a thruster nozzle, in world coordinates
const BEAM = 4; // thruster jet: one tapered strip from the nozzle to the tip, in world coordinates

// per instance: pos(3) motion(4) phase(4) look(4) params(4) extra(4) = 23 floats
const STRIDE = 23;

const buildParticles = () => {
    const rnd = mulberry32(20261115);
    const TAU = Math.PI * 2;
    const pick = (palette) => {
        let r = rnd();
        for (const p of palette) {
            if ((r -= p.w) <= 0) return p.c;
        }
        return palette[0].c;
    };
    const dir = () => {
        const z = rnd() * 2 - 1;
        const a = rnd() * TAU;
        const s = Math.sqrt(1 - z * z);
        return [s * Math.cos(a), z, s * Math.sin(a)];
    };
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(TAU * rnd());
    const out = [];

    // size: world diameter in model-radius units (FIELD, HAZE) or css px (STAR)
    // drift: the particle travels at `speed` (model radii per second) in its own random direction,
    //   which slowly turns, along a circle of `radius` through its start point (so it never leaves)
    // group: the particles of one cluster also share the cluster's drift, so the cloud moves as one
    const push = ({ pos, amp, freq, color, intensity, size, kind, twinkle, drift, glow = 0, group = 0 }) => {
        const jitter = 0.94 + rnd() * 0.12;
        out.push(
            ...pos,
            amp,
            freq * mix(0.7, 1.3, rnd()),
            freq * mix(0.7, 1.3, rnd()),
            freq * mix(0.7, 1.3, rnd()),
            rnd() * TAU,
            rnd() * TAU,
            rnd() * TAU,
            rnd() * TAU,
            Math.min(1, color[0] * jitter),
            Math.min(1, color[1] * jitter),
            Math.min(1, color[2] * jitter),
            intensity,
            size,
            kind,
            twinkle,
            drift.speed,
            glow,
            rnd(),
            drift.radius,
            group
        );
    };

    // log-uniform: as many small as large, over a wide range
    const sizeIn = (a, b) => a * Math.pow(b / a, rnd());
    const roam = (speed, radius) => ({ speed: mix(speed[0], speed[1], rnd()), radius: mix(radius[0], radius[1], rnd()) });
    const shell = (inner, outer, power) => {
        const r = mix(inner, outer, Math.pow(rnd(), power));
        return dir().map((v) => v * r);
    };
    // the space the player flies through: wide, not so tall, the whole streaming length
    const air = () => [mix(-7, 7, rnd()), mix(-4.5, 4.5, rnd()), mix(-7, 7, rnd())];

    // scattered light
    for (let i = 0; i < CONFIG.dust; i++) {
        push({
            pos: air(),
            amp: mix(0.02, 0.05, rnd()),
            freq: TAU * mix(0.03, 0.09, rnd()),
            color: pick(PALETTE),
            intensity: mix(0.35, 1.35, Math.pow(rnd(), 1.8)),
            size: sizeIn(0.0015, 0.014),
            kind: FIELD,
            twinkle: mix(0.5, 2.6, rnd()),
            drift: roam([0.05, 0.18], [0.5, 1.4]),
            glow: mix(0.15, 0.7, Math.pow(rnd(), 3))
        });
    }
    for (let i = 0; i < CONFIG.orbs; i++) {
        push({
            pos: air(),
            amp: mix(0.03, 0.07, rnd()),
            freq: TAU * mix(0.02, 0.06, rnd()),
            color: rnd() < 0.07 ? [0.5, 0.78, 0.92] : pick(WARM),
            intensity: mix(0.7, 1.5, rnd()),
            size: sizeIn(0.006, 0.032),
            kind: FIELD,
            twinkle: mix(0.3, 1.2, rnd()),
            drift: roam([0.04, 0.14], [0.6, 1.5]),
            glow: mix(0.5, 1.0, rnd())
        });
    }

    // clusters: a warm cloud of light with dense glitter and a few flares in it, spread around
    // the model (mostly level with it, not above or below)
    const flareSpots = [];
    for (let k = 0; k < CONFIG.clusters; k++) {
        const a = ((k + rnd() * 0.7) / CONFIG.clusters) * TAU;
        const y = Math.max(-0.7, Math.min(0.7, gauss() * 0.35));
        const r = mix(CONFIG.clusterRadius[0], CONFIG.clusterRadius[1], rnd());
        const h = Math.sqrt(1 - y * y);
        const c = [h * Math.cos(a) * r, y * r, h * Math.sin(a) * r];
        const group = k + 1;
        const streak = dir();
        const near = (spread, along) => {
            const t = gauss() * along;
            return c.map((v, i) => v + gauss() * spread + streak[i] * t);
        };
        flareSpots.push({ near, group });

        for (let i = 0; i < CONFIG.hazePerCluster; i++) {
            const core = i === 0;
            push({
                pos: near(0.3, 0.25),
                amp: mix(0.04, 0.08, rnd()),
                freq: TAU * mix(0.01, 0.03, rnd()),
                color: core ? HAZE_CORE : pick(HAZE_PALETTE),
                intensity: core ? mix(0.32, 0.48, rnd()) : mix(0.28, 0.5, rnd()),
                size: core ? mix(0.9, 1.4, rnd()) : mix(1.4, 2.6, rnd()),
                kind: HAZE,
                twinkle: mix(0.08, 0.25, rnd()),
                drift: roam([0.01, 0.03], [0.1, 0.3]),
                group
            });
        }
        for (let i = 0; i < CONFIG.clusterDust; i++) {
            push({
                pos: near(0.42, 0.8),
                amp: mix(0.015, 0.04, rnd()),
                freq: TAU * mix(0.04, 0.12, rnd()),
                color: pick(WARM),
                intensity: mix(0.35, 1.2, Math.pow(rnd(), 1.6)),
                size: sizeIn(0.0015, 0.011),
                kind: FIELD,
                twinkle: mix(0.6, 3.0, rnd()),
                drift: roam([0.02, 0.08], [0.08, 0.3]),
                glow: mix(0.2, 0.55, Math.pow(rnd(), 2)),
                group
            });
        }
    }

    // flares: a third inside the clusters, the rest anywhere
    for (let i = 0; i < CONFIG.flares; i++) {
        const spot = i % 3 === 0 && flareSpots.length ? flareSpots[i % flareSpots.length] : null;
        push({
            pos: spot ? spot.near(0.35, 0.5) : shell(CONFIG.innerRadius * 1.2, CONFIG.outerRadius * 0.85, 1.0),
            amp: mix(0.03, 0.06, rnd()),
            freq: TAU * mix(0.015, 0.04, rnd()),
            color: pick(WARM),
            intensity: mix(1.6, 2.6, rnd()),
            size: sizeIn(0.014, 0.05),
            kind: FIELD,
            twinkle: mix(0.2, 0.7, rnd()),
            drift: spot ? roam([0.02, 0.05], [0.15, 0.4]) : roam([0.04, 0.12], [0.6, 1.4]),
            glow: mix(1.0, 1.4, rnd()),
            group: spot ? spot.group : 0
        });
    }

    for (let i = 0; i < CONFIG.stars; i++) {
        const r = mix(CONFIG.starRadius[0], CONFIG.starRadius[1], rnd());
        push({
            pos: dir().map((v) => v * r),
            amp: 0,
            freq: 0,
            color: pick(STAR_PALETTE),
            intensity: mix(0.12, 0.75, Math.pow(rnd(), 2.2)),
            size: sizeIn(0.45, 2.0),
            kind: STAR,
            twinkle: mix(0.4, 2.0, rnd()),
            drift: { speed: 0, radius: 0 }
        });
    }
    // thruster flames, in world coordinates (the nozzles were picked on the splat itself). Per
    // nozzle a glow at the nozzle (FLAME) and two tapered strips along the jet (BEAM): a wide pale
    // plume and a short white-hot core. A strip is one continuous shape, so the flame never
    // breaks up into separate blobs however close the camera gets.
    //   pos = nozzle, motion = (jet direction, length), phase = (point inside the calf, flicker),
    //   look = (colour, intensity), params = (size or width at the nozzle, kind, width at the tip, -),
    //   extra = (-, seed, -, -)
    const flameStart = out.length / STRIDE;
    const T = CONFIG.thrusters ?? [];
    if (CONFIG.flame > 0 && T.length) {
        const norm = (v) => {
            const l = Math.hypot(...v) || 1;
            return v.map((x) => x / l);
        };
        const up = [0, 1, 0];
        // the legs' common backward direction, level; "right" is across the model
        const back = norm([T.reduce((a, t) => a + t.normal[0], 0), 0, T.reduce((a, t) => a + t.normal[2], 0)]);
        const right = norm([up[1] * back[2] - up[2] * back[1], up[2] * back[0] - up[0] * back[2], up[0] * back[1] - up[1] * back[0]]);
        const mean = [0, 1, 2].map((i) => T.reduce((a, t) => a + t.pos[i], 0) / T.length);
        const tilt = (CONFIG.flameAngle * Math.PI) / 180;
        const w = CONFIG.nozzleSize * CONFIG.flameWidth;
        for (const t of T) {
            const side = Math.sign((t.pos[0] - mean[0]) * right[0] + (t.pos[2] - mean[2]) * right[2]);
            const dir = norm([0, 1, 2].map((i) => back[i] * Math.cos(tilt) - up[i] * Math.sin(tilt) + right[i] * side * CONFIG.flameSplay));
            const n = norm(t.normal);
            const start = t.pos.map((v, i) => v + n[i] * 0.01);
            const inside = t.pos.map((v, i) => v - back[i] * CONFIG.nozzleSize * 1.2);
            const flicker = rnd() * TAU;
            const emit = (kind, look, w0, w1, length) =>
                out.push(...start, ...dir, length, ...inside, flicker, ...look, w0, kind, w1, 0, 0, rnd(), 0, 0);
            emit(FLAME, [1, 1, 1, 1.2], CONFIG.nozzleSize * 3.2, 0, 0); // glow at the nozzle
            emit(BEAM, [...FLAME_TAIL, 1.8], w * 1.5, w * 5.5, CONFIG.flameLength); // plume
            emit(BEAM, [1, 1, 1, 2.2], w * 0.9, w * 1.7, CONFIG.flameLength * 0.5); // white-hot core
        }
    }

    return { data: new Float32Array(out), count: out.length / STRIDE, flameStart };
};

// ---------------------------------------------------------------------------------------------
// shaders

const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 aPos;
layout(location = 2) in vec4 aMotion;  // amp, freq xyz
layout(location = 3) in vec4 aPhase;   // phase xyz, twinkle phase
layout(location = 4) in vec4 aLook;    // rgb, intensity
layout(location = 5) in vec4 aParams;  // size, kind, twinkle speed, drift speed
layout(location = 6) in vec4 aExtra;   // glow, seed, drift radius, cluster id (0 = none)

uniform mat4 uView;
uniform vec2 uProj;        // projection scale x, y
uniform vec3 uCenter;
uniform float uScale;      // model bounding radius (world)
uniform vec3 uHalfExt;     // model clearance half extents (world)
uniform float uTime;
uniform vec2 uViewport;    // device px
uniform float uDpr;
uniform float uFocus;      // view depth of the model centre
uniform float uBand;       // front/back blend band (world)
uniform float uAperture;
uniform float uMaxSize;    // device px
uniform float uParticleSize; // light particles drawn at this fraction of their size
uniform float uLayer;      // 0 back, 1 front
uniform float uGain;
uniform float uFrontBokeh;
uniform float uCover;
uniform float uParticleOpacity;
uniform float uSoftness;
uniform float uGlow;
uniform float uHaze;
uniform float uSpeed;
uniform float uFlame;
uniform float uFlameScale; // jet length with the thrust
uniform vec3 uOffset;      // how far the space has moved past the model (model radii)
uniform float uWrap;       // the space repeats every uWrap
uniform mat3 uModelRot;    // the model's turn and lean while flying
uniform vec3 uPivot;       // ... about its centre (world)
uniform float uModelScale; // the model is drawn this much larger than it was scanned (about its centre)
uniform vec2 uDepthAB;     // ndc z = A + B / depth (the same near / far as the canyon)
uniform vec3 uVel;         // how fast the space streams past (world units / s)
uniform float uShutter;    // motion streak length (s)

float ndcZ(float d) {
    return clamp(uDepthAB.x + uDepthAB.y / d, -1.0, 0.99999);
}

out vec2 vUv;
out vec3 vColor;
out float vAlpha;
out float vBlur;
out float vEdge;
out float vCover;
out float vSpan;           // quad size / particle size (> 1 leaves room for the glow)
out float vGlow;
flat out float vKind;
out vec2 vSeed;
out vec3 vWorld;           // flames: world position, for the per-pixel occlusion test
out float vFront;          // flames: 1 in front of the calf, 0 behind it

float hash1(float n) {
    return fract(sin(n) * 43758.5453123);
}


// Travel at \`speed\` in a random direction that slowly turns: a circle of \`radius\` through the
// start point, on a plane picked from \`seed\`. Bounded, so nothing ever has to wrap around.
vec3 drift(float seed, float speed, float radius, float t) {
    if (speed <= 0.0 || radius <= 0.0) return vec3(0.0);
    vec3 axis = normalize(vec3(hash1(seed * 12.9898 + 1.0), hash1(seed * 78.233 + 2.0), hash1(seed * 37.719 + 3.0)) - 0.5 + 1e-4);
    vec3 ref = abs(axis.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 b = normalize(cross(axis, ref));
    vec3 c = cross(axis, b);
    float ph = hash1(seed * 4.1414 + 4.0) * 6.2831853;
    float ang = t * speed / radius + ph;
    return radius * ((cos(ang) - cos(ph)) * b + (sin(ang) - sin(ph)) * c);
}

void main() {
    vUv = aCorner;
    vColor = aLook.rgb;
    vAlpha = 0.0;
    vBlur = 0.0;
    vEdge = 0.1;
    vCover = 0.0;
    vSpan = 1.0;
    vGlow = 0.0;
    vKind = aParams.y;
    vSeed = vec2(aExtra.y * 37.0, aExtra.y * 53.0 + 7.0);
    vWorld = vec3(0.0);
    vFront = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

    vec3 world;
    float travelFade = 1.0;
    if (aParams.y > 2.5) {
        // thruster glow or jet: aPos is the nozzle itself (world), turned and leaned with the model
        world = uPivot + uModelRot * ((aPos - uPivot) * uModelScale);
    } else {
        // each particle travels its own random way; a cluster also travels as one; plus a wobble
        float tm = uTime * uSpeed;
        vec3 p = aPos + drift(aExtra.y, aParams.w, aExtra.z, tm);
        if (aExtra.w > 0.5) {
            float g = aExtra.w * 0.1373 + 0.05;
            p += drift(g, mix(0.05, 0.11, hash1(g * 7.13 + 5.0)), mix(0.8, 1.5, hash1(g * 3.31 + 6.0)), tm);
        }
        p += aMotion.x * sin(tm * aMotion.yzw + aPhase.xyz);
        if (aParams.y < 0.5 || aParams.y > 1.5) {
            // light and clouds stream past as the model flies; the space repeats every uWrap, and
            // whatever is about to jump to the other side fades out first (stars stay put)
            // each particle (a cluster as a whole) repeats at its own interval, so the space
            // never comes round again in the same pattern
            float wseed = aExtra.w > 0.5 ? hash1(aExtra.w * 0.618 + 0.3) : fract(aExtra.y * 7.31 + 0.17);
            float wrapSize = uWrap * mix(0.9, 1.3, wseed);
            p -= uOffset;
            p = mod(p + 0.5 * wrapSize, wrapSize) - 0.5 * wrapSize;
            vec3 ap = abs(p);
            travelFade = 1.0 - smoothstep(0.4 * wrapSize, 0.5 * wrapSize, max(ap.x, max(ap.y, ap.z)));
        }
        world = uCenter + p * uScale;
    }
    vec4 v = uView * vec4(world, 1.0);
    float depth = -v.z;
    if (depth < 0.02) return;

    float tw = 0.5 + 0.5 * sin(uTime * aParams.z + aPhase.w);
    float intensity = aLook.a * uGain;
    float sizePx;
    float blur = 0.0;
    vec2 axis = vec2(1.0, 0.0); // quad orientation on screen (streaks are stretched along their motion)
    float stretch = 1.0;
    vec2 shiftPx = vec2(0.0);
    float pxPerUnit = uProj.y * 0.5 * uViewport.y / depth;

    bool beam = aParams.y > 3.5;
    vec4 beamPos = vec4(2.0, 2.0, 2.0, 1.0);
    if (aParams.y > 2.5) {
        float flicker = 0.85 + 0.15 * sin(uTime * 37.0 + aPhase.w) * sin(uTime * 23.0 + aPhase.w * 1.7);
        float refDepth = -(uView * vec4(uPivot + uModelRot * ((aPhase.xyz - uPivot) * uModelScale), 1.0)).z; // inside the calf
        float myDepth = depth;
        if (beam) {
            // a strip from the nozzle to the tip of the jet, narrow at the nozzle, wide at the tip
            float jetLen = aMotion.w * uFlameScale * uModelScale;
            vec3 tipW = world + (uModelRot * aMotion.xyz) * jetLen;
            vec4 vt = uView * vec4(tipW, 1.0);
            float tipDepth = -vt.z;
            if (tipDepth < 0.02) return;
            vec2 ps = vec2(uProj.x * v.x, uProj.y * v.y) / depth * uViewport * 0.5;
            vec2 pt = vec2(uProj.x * vt.x, uProj.y * vt.y) / tipDepth * uViewport * 0.5;
            float w0 = aParams.x * uModelScale * pxPerUnit;
            float w1 = aParams.z * uModelScale * uProj.y * 0.5 * uViewport.y / tipDepth;
            vec2 seg = pt - ps;
            float segLen = length(seg);
            vec2 along = segLen > 1e-3 ? seg / segLen : vec2(0.0, -1.0);
            // seen end-on the strip would fold into a thin line: keep it at least about as long
            // as it is wide, and dim it, so it reads as a soft glow instead
            float full = jetLen * 0.5 * (pxPerUnit + uProj.y * 0.5 * uViewport.y / tipDepth);
            float side = clamp(segLen / max(full, 1.0), 0.0, 1.0);
            float halfLen = max(segLen, 0.7 * max(w0, w1)) * 0.5;
            vec2 mid = (ps + pt) * 0.5;
            float t = aCorner.x * 0.5 + 0.5;
            vec2 px = mix(mid - along * halfLen, mid + along * halfLen, t)
                + vec2(-along.y, along.x) * aCorner.y * mix(w0, w1, t) * 0.5;
            beamPos = vec4(px / (uViewport * 0.5), ndcZ(mix(depth, tipDepth, t)), 1.0);
            vUv = vec2(t, aCorner.y);
            intensity = aLook.a * mix(0.4, 1.0, side);
            myDepth = mix(depth, tipDepth, t);
            vWorld = mix(world, tipW, t);
        } else {
            // the glow at the nozzle itself
            sizePx = max(aParams.x * uModelScale * pxPerUnit, 3.0 * uDpr);
            intensity = aLook.a;
            vWorld = world;
        }
        intensity *= uFlame * flicker;
        // in front of the calf draws over the model, behind it is hidden by the model; the layer is
        // chosen per pixel in the fragment shader, which also checks the shield
        vFront = smoothstep(refDepth + 0.03 * uModelScale, refDepth - 0.03 * uModelScale, myDepth);
    } else if (aParams.y > 1.5) {
        // cloud of light: behind the model only, so it never hazes the model itself
        if (uLayer > 0.5) return;
        sizePx = aParams.x * uScale * pxPerUnit;
        intensity = aLook.a * uHaze * mix(0.75, 1.0, tw);
        intensity *= smoothstep(0.3 * uScale, 1.0 * uScale, depth);
        intensity *= 1.0 - smoothstep(2.0 * uViewport.y, 3.5 * uViewport.y, sizePx);
    } else {
        if (aParams.y < 0.5) {
            // light particle with depth-of-field
            float sharp = max(aParams.x * uScale * pxPerUnit, 0.9 * uDpr);
            float coc = uAperture * uViewport.y * abs(depth - uFocus) / depth;
            float D = sqrt(sharp * sharp + coc * coc);
            blur = smoothstep(0.0, 1.0, (coc - sharp) / max(5.0 * uDpr, 2.0 * sharp));
            // softer edges fade out sooner, so the disc is drawn a little larger to keep its size
            float base = mix(sharp * 3.0, D * mix(1.1, 1.55, uSoftness), blur);
            float spread = clamp(2.5 * sharp / D, 0.0, 1.0);
            intensity *= mix(1.0, (0.28 + 0.6 * spread) * (1.0 + 0.45 * uSoftness), blur);
            intensity *= mix(mix(0.3, 1.0, tw), mix(0.8, 1.0, tw), blur);
            intensity *= uParticleOpacity;

            // keep clear of the model itself
            vec3 q = (world - uCenter) / uHalfExt;
            intensity *= smoothstep(1.0, 1.6, length(q));

            // very close or very large: fade away instead of filling the screen
            intensity *= smoothstep(0.12 * uScale, 0.45 * uScale, depth);
            intensity *= 1.0 - smoothstep(uMaxSize * 0.55, uMaxSize, base);
            base = min(base, uMaxSize);
            base = max(base * uParticleSize, 1.2 * uDpr);

            // light spilling around it: wide for a sharp point, a thin aura for a soft disc
            float glow = aExtra.x * uGlow;
            vSpan = 1.0 + glow * mix(2.4, 0.4, blur);
            vGlow = glow * mix(0.3, 0.14, blur);
            sizePx = base * vSpan;

            // edge width as a fraction of the radius: a little variety, widened by the softness
            float edge = clamp(max(2.5 / base, mix(0.08, 0.45, fract(aPhase.w * 7.13))), 0.04, 0.6);
            vEdge = mix(edge, 1.0, uSoftness);

            // streaming past: stretch into a streak from where it was a moment ago
            if (uShutter > 0.0) {
                vec4 pv = uView * vec4(world - uVel * uShutter, 1.0);
                float pd = -pv.z;
                if (pd > 0.02) {
                    vec2 s0 = vec2(uProj.x * v.x, uProj.y * v.y) / depth * uViewport * 0.5;
                    vec2 s1 = vec2(uProj.x * pv.x, uProj.y * pv.y) / pd * uViewport * 0.5;
                    vec2 seg = s0 - s1;
                    float len = min(length(seg), uViewport.y * 0.2);
                    if (len > 1.0) {
                        axis = normalize(seg);
                        stretch = 1.0 + len / max(sizePx, 1.0);
                        shiftPx = -axis * len * 0.5;
                        intensity /= sqrt(stretch);
                    }
                }
            }
        } else {
            // distant star: fixed pixel size
            sizePx = aParams.x * uDpr * 4.0;
            vSpan = 4.0 / 3.0;
            intensity *= mix(0.35, 1.0, tw);
        }

        // in front of the model centre goes on the front layer, behind on the back layer
        float wFront = smoothstep(uFocus + uBand, uFocus - uBand, depth);
        intensity *= uLayer > 0.5 ? wFront : 1.0 - wFront;
        // soft discs in front of the model are kept faint so they do not veil it
        if (uLayer > 0.5) intensity *= mix(1.0, uFrontBokeh, blur);
    }
    intensity *= travelFade;
    if (!beam && intensity < 0.003) return;

    vAlpha = intensity;
    vBlur = blur;
    vCover = uCover * blur * uParticleOpacity; // blur is only ever set for the light particles
    if (beam) {
        gl_Position = beamPos;
        return;
    }
    vec2 ndc = vec2(uProj.x * v.x, uProj.y * v.y) / depth;
    vec2 offPx = (axis * aCorner.x * stretch + vec2(-axis.y, axis.x) * aCorner.y) * sizePx * 0.5;
    // stars sit behind everything; the rest at its own depth, so the canyon hides what is behind it
    float z = aParams.y > 0.5 && aParams.y < 1.5 ? 0.99999 : ndcZ(depth);
    gl_Position = vec4(ndc + (offPx + shiftPx) * 2.0 / uViewport, z, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec3 vColor;
in float vAlpha;
in float vBlur;
in float vEdge;
in float vCover;
in float vSpan;
in float vGlow;
flat in float vKind;
in vec2 vSeed;
in vec3 vWorld;
in float vFront;
uniform vec3 uCamPos;
uniform int uOccN;
uniform vec3 uOccC[4];
uniform vec3 uOccU[4];
uniform vec3 uOccV[4];
uniform vec3 uOccW[4];
uniform vec3 uOccH[4];
uniform float uSoftness;
uniform float uExposure;
uniform float uHazeCover;
uniform float uGlowCover;
uniform float uTime;
uniform float uLayer;
out vec4 outColor;

float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}
// 1 when one of the occluder boxes (the shield) lies between the camera and point b
float occluded(vec3 a, vec3 b) {
    vec3 dir = b - a;
    for (int i = 0; i < 4; i++) {
        if (i >= uOccN) break;
        vec3 o = a - uOccC[i];
        vec3 lo = vec3(dot(o, uOccU[i]), dot(o, uOccV[i]), dot(o, uOccW[i]));
        vec3 ld = vec3(dot(dir, uOccU[i]), dot(dir, uOccV[i]), dot(dir, uOccW[i]));
        vec3 inv = 1.0 / mix(vec3(1e-6), ld, step(1e-6, abs(ld)));
        vec3 t0 = (-uOccH[i] - lo) * inv;
        vec3 t1 = (uOccH[i] - lo) * inv;
        vec3 tmin = min(t0, t1);
        vec3 tmax = max(t0, t1);
        float tn = max(max(tmin.x, tmin.y), tmin.z);
        float tf = min(min(tmax.x, tmax.y), tmax.z);
        if (tn <= tf && tf > 0.0 && tn < 0.995) return 1.0;
    }
    return 0.0;
}

// how much of a flame pixel this layer draws: in front of the calf and not behind the shield
// goes on the front layer (over the model); the rest goes behind the model, which hides it
float flameLayer() {
    float wf = vFront * (1.0 - occluded(uCamPos, vWorld));
    return uLayer > 0.5 ? wf : 1.0 - wf;
}

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() {
    float d = length(vUv);

    // Light is summed, then pushed through an exposure curve: dim light keeps its colour and
    // strong light saturates towards white, so bright cores burn white inside an orange glow.
    vec3 light = vec3(0.0);
    float cover = 0.0;
    if (vKind > 3.5) {
        // jet strip: u runs from the nozzle (0) to the tip (1), v across it (-1..1). Noise
        // scrolling downstream makes it flicker and flow; the centre line burns whitest.
        float u = vUv.x;
        float v = vUv.y;
        float acrossP = exp(-v * v * 3.0) * (1.0 - v * v);
        float alongP = smoothstep(0.0, 0.06, u) * pow(max(1.0 - u, 0.0), 1.1);
        vec2 q = vec2(u * 6.0 - uTime * 7.0, v * 1.6 + vSeed.x);
        float n = 0.6 * noise(q) + 0.4 * noise(q * 2.1 + vec2(-uTime * 5.0, vSeed.y));
        float L = vAlpha * acrossP * alongP * mix(0.5, 1.4, n) * flameLayer();
        light = mix(vColor, vec3(1.0), exp(-v * v * 8.0) * (1.0 - u)) * L;
        cover = min(L, 0.9);
    } else if (d > 1.0) {
        discard;
    } else if (vKind > 2.5) {
        // nozzle glow: a soft round glow
        float e = 1.0 - d * d;
        float L = vAlpha * exp(-d * d * 2.6) * e * e * flameLayer();
        light = vColor * L;
        cover = min(L, 0.9);
    } else if (vKind > 1.5) {
        // cloud: a broad soft glow, broken up by slowly drifting noise so it is not a circle
        vec2 q = vUv * 1.7 + vSeed + vec2(uTime * 0.008, -uTime * 0.005);
        float n = 0.65 * noise(q) + 0.35 * noise(q * 2.3 + 11.0);
        float shape = exp(-d * d * 3.2) * (1.0 - d * d) * mix(0.35, 1.35, n);
        float L = vAlpha * shape;
        light = vColor * L;
        cover = L * uHazeCover;
    } else {
        float dc = d * vSpan; // 0..1 is the particle itself, beyond that only its glow
        // in focus: bright core with a soft halo
        float sharp = exp(-dc * dc * mix(20.0, 11.0, uSoftness)) + mix(0.32, 0.45, uSoftness) * exp(-dc * dc * 3.4);
        // out of focus: a disc whose edge fades over vEdge of its radius
        float disc = 1.0 - smoothstep(1.0 - vEdge, 1.0, dc);
        float bokeh = disc * (0.78 + 0.3 * (1.0 - uSoftness) * smoothstep(0.5, 0.96, dc));
        float core = vAlpha * mix(sharp, bokeh, vBlur);
        float glow = vAlpha * vGlow * exp(-d * d * 4.0) * (1.0 - d * d);
        // the glow is a deeper, more saturated shade of the particle's colour
        light = vColor * core + pow(vColor, vec3(1.6)) * glow;
        cover = core * vCover + glow * uGlowCover;
    }
    vec3 rgb = 1.0 - exp(-light * uExposure);
    // premultiplied: the light is added, and part of it also covers what is behind, so warm
    // light reads as warm over the blue instead of turning grey. The front layer sits inside the
    // viewer's own compositing group, where pure light (alpha 0) does not show, so there every
    // pixel covers as much as it shines (a screen-like blend over the model)
    float a = clamp(cover, 0.0, 1.0);
    if (uLayer > 0.5) a = max(a, max(rgb.r, max(rgb.g, rgb.b)));
    outColor = vec4(rgb, a);
}`;

// ---------------------------------------------------------------------------------------------
// one WebGL2 canvas

class Layer {
    constructor(canvas, layerIndex, particles) {
        this.canvas = canvas;
        this.layerIndex = layerIndex;
        const gl = canvas.getContext('webgl2', {
            alpha: true,
            premultipliedAlpha: true,
            antialias: false,
            depth: true,
            stencil: false,
            powerPreference: 'high-performance'
        });
        if (!gl) throw new Error('WebGL2 is not available');
        this.gl = gl;

        const compile = (type, src) => {
            const sh = gl.createShader(type);
            gl.shaderSource(sh, src);
            gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
            return sh;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        this.prog = prog;
        this.u = {};
        for (const name of [
            'uView', 'uProj', 'uCenter', 'uScale', 'uHalfExt', 'uTime', 'uViewport', 'uDpr',
            'uFocus', 'uBand', 'uAperture', 'uMaxSize', 'uParticleSize', 'uLayer', 'uGain', 'uFrontBokeh', 'uCover', 'uSoftness',
            'uGlow', 'uHaze', 'uExposure', 'uParticleOpacity', 'uHazeCover', 'uGlowCover', 'uSpeed', 'uFlame',
            'uFlameScale', 'uOffset', 'uWrap', 'uModelRot', 'uPivot', 'uModelScale', 'uDepthAB', 'uVel', 'uShutter',
            'uCamPos', 'uOccN', 'uOccC', 'uOccU', 'uOccV', 'uOccW', 'uOccH'
        ]) {
            this.u[name] = gl.getUniformLocation(prog, name);
        }

        const quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const inst = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, inst);
        gl.bufferData(gl.ARRAY_BUFFER, particles.data, gl.STATIC_DRAW);
        // one vertex array per instance range over the same buffer (WebGL2 has no base instance)
        const makeVao = (firstInstance) => {
            const vao = gl.createVertexArray();
            gl.bindVertexArray(vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, quad);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, inst);
            let offset = firstInstance * STRIDE;
            [3, 4, 4, 4, 4, 4].forEach((n, i) => {
                gl.enableVertexAttribArray(i + 1);
                gl.vertexAttribPointer(i + 1, n, gl.FLOAT, false, STRIDE * 4, offset * 4);
                gl.vertexAttribDivisor(i + 1, 1);
                offset += n;
            });
            gl.bindVertexArray(null);
            return vao;
        };
        this.vao = makeVao(0);
        this.count = particles.flameStart;
        this.flameVao = makeVao(particles.flameStart);
        this.flameCount = particles.count - particles.flameStart;

        gl.enable(gl.BLEND);
        gl.clearColor(0, 0, 0, 0);
        gl.clearDepth(1);

        try {
            this.world = new WorldGL(gl);
        } catch (err) {
            console.warn('canyon renderer disabled:', err);
            this.world = null;
        }
    }

    resize(dpr) {
        const { canvas } = this;
        const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        return [w, h];
    }

    draw(frame) {
        const { gl, u } = this;
        const [w, h] = this.resize(frame.dpr);
        gl.viewport(0, 0, w, h);
        gl.depthMask(true);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (frame.hidden) return;
        frame.p0 = frame.projX(w, h);
        frame.p5 = frame.projY(w, h);
        frame.vw = w;
        frame.vh = h;
        // the canyon and the rocks first: they hide the light behind them
        if (this.world && frame.world) this.world.drawSolid(frame, frame.world, this.layerIndex);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.useProgram(this.prog);
        gl.uniformMatrix4fv(u.uView, false, frame.view);
        gl.uniform2f(u.uProj, frame.projX(w, h), frame.projY(w, h));
        gl.uniform3fv(u.uCenter, frame.center);
        gl.uniform1f(u.uScale, frame.radius);
        gl.uniform3fv(u.uHalfExt, frame.halfExt);
        gl.uniform1f(u.uTime, frame.time);
        gl.uniform2f(u.uViewport, w, h);
        gl.uniform1f(u.uDpr, frame.dpr);
        gl.uniform1f(u.uFocus, frame.focus);
        gl.uniform1f(u.uBand, frame.band);
        gl.uniform1f(u.uAperture, CONFIG.aperture);
        gl.uniform1f(u.uMaxSize, (this.layerIndex ? CONFIG.frontMaxSizeRatio : CONFIG.maxSizeRatio) * h);
        gl.uniform1f(u.uParticleSize, CONFIG.particleSize);
        gl.uniform1f(u.uFrontBokeh, CONFIG.frontBokeh);
        gl.uniform1f(u.uCover, CONFIG.cover);
        gl.uniform1f(u.uParticleOpacity, CONFIG.particleOpacity);
        gl.uniform1f(u.uSoftness, CONFIG.softness);
        gl.uniform1f(u.uGlow, CONFIG.glow * (this.layerIndex ? CONFIG.frontGlow : 1));
        gl.uniform1f(u.uHaze, CONFIG.haze * frame.fade);
        gl.uniform1f(u.uExposure, CONFIG.exposure);
        gl.uniform1f(u.uSpeed, CONFIG.speed);
        gl.uniform1f(u.uFlame, CONFIG.flame * frame.modelFade * frame.thrust);
        gl.uniform1f(u.uFlameScale, frame.flameScale);
        gl.uniform3fv(u.uOffset, frame.offset);
        gl.uniform1f(u.uWrap, CONFIG.wrapSize);
        gl.uniformMatrix3fv(u.uModelRot, false, frame.modelRot);
        gl.uniform3fv(u.uPivot, frame.pivot);
        gl.uniform1f(u.uModelScale, frame.modelScale);
        {
            const n = frame.near;
            const f = frame.far;
            gl.uniform2f(u.uDepthAB, (f + n) / (f - n), (-2 * f * n) / (f - n));
        }
        gl.uniform3fv(u.uVel, frame.vel);
        gl.uniform1f(u.uShutter, CONFIG.shutter);
        gl.uniform3fv(u.uCamPos, frame.camPos);
        gl.uniform1i(u.uOccN, frame.occ.n);
        gl.uniform3fv(u.uOccC, frame.occ.c);
        gl.uniform3fv(u.uOccU, frame.occ.u);
        gl.uniform3fv(u.uOccV, frame.occ.v);
        gl.uniform3fv(u.uOccW, frame.occ.w);
        gl.uniform3fv(u.uOccH, frame.occ.h);
        gl.uniform1f(u.uHazeCover, CONFIG.hazeCover);
        gl.uniform1f(u.uGlowCover, CONFIG.glowCover * (this.layerIndex ? 0.5 : 1));
        gl.uniform1f(u.uLayer, this.layerIndex);
        gl.uniform1f(u.uGain, CONFIG.gain * frame.fade);
        // the light particles add up
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.bindVertexArray(this.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
        // sparks, fire and flashes
        if (this.world && frame.world) {
            this.world.drawGlow(frame, frame.world, this.layerIndex);
            gl.useProgram(this.prog);
        }
        // the flames go over them: a particle behind a flame is covered by it, rather than having
        // the flame's light added on top, which turned the round particles into white discs
        if (this.flameCount > 0) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.bindVertexArray(this.flameVao);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.flameCount);
        }
        gl.bindVertexArray(null);
        gl.depthMask(true);
    }
}

// ---------------------------------------------------------------------------------------------
// camera helpers (column-major 4x4, like PlayCanvas)

const invert = (m, out) => {
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return false;
    det = 1 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return true;
};

// world-space bounds of the splat, from the engine's own aabb
export const readBounds = (app) => {
    const gs = app.root?.findComponents?.('gsplat')?.[0];
    const aabb = gs?.customAabb;
    if (!aabb) return null;
    const m = gs.entity.getWorldTransform().data;
    const c = aabb.center;
    const e = aabb.halfExtents;
    const center = [0, 1, 2].map((i) => m[i] * c.x + m[4 + i] * c.y + m[8 + i] * c.z + m[12 + i]);
    const halfExt = [0, 1, 2].map(
        (i) => Math.abs(m[i]) * e.x + Math.abs(m[4 + i]) * e.y + Math.abs(m[8 + i]) * e.z
    );
    if (!halfExt.every((v) => v > 1e-4 && Number.isFinite(v))) return null;
    return { center, halfExt };
};

// column-major 4x4 product a * b (b may be a Float64Array)
const mul4 = (a, b, out) => {
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
    }
    return out;
};

// ---------------------------------------------------------------------------------------------

// game: { camWorld, vfov, model: { center, halfExt }, fx: { offset, vel, rotMat, thrust, sprint, G,
// camG, flash }, world } — read every frame
export const createFx = (game) => {
    // the calf nozzles, for the game's own use (splat-light.js lights the legs from them)
    if (game.fx) game.fx.thrusters = CONFIG.thrusters;
    const params = new URL(location.href).searchParams;
    const style = document.createElement('style');
    style.textContent = `
        .space-fx { pointer-events: none; }
        .space-fx-back { position: fixed; inset: 0; width: 100%; height: 100%; z-index: 0; }
    `;
    document.head.appendChild(style);

    const backCanvas = document.createElement('canvas');
    backCanvas.className = 'space-fx space-fx-back';
    document.body.prepend(backCanvas);
    const frontCanvas = document.createElement('canvas');
    frontCanvas.className = 'space-fx space-fx-front';

    const particles = buildParticles();
    if (params.has('noparticles')) particles.flameStart = 0;
    let back;
    let front = null;
    try {
        back = new Layer(backCanvas, 0, particles);
    } catch (err) {
        console.warn('space-fx disabled:', err);
        backCanvas.remove();
        return { render() {}, setApp() {} };
    }

    // the front layer sits right above the viewer's canvas and below its ui
    const attachFront = () => {
        if (front) return true;
        const viewerCanvas = document.querySelector('.sse-viewer > canvas');
        if (!viewerCanvas) return false;
        viewerCanvas.after(frontCanvas);
        try {
            front = new Layer(frontCanvas, 1, particles);
        } catch (err) {
            console.warn('space-fx front layer disabled:', err);
            frontCanvas.remove();
            front = false;
        }
        return true;
    };


    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const view = new Float32Array(16);
    const camWorld = new Float32Array(16);
    let proj = null; // [P0, P5] from the engine camera

    const frame = {
        view,
        center: new Float32Array(3),
        halfExt: new Float32Array(3),
        radius: 1,
        focus: 9,
        band: 0.2,
        time: 0,
        dpr: 1,
        fade: 0,
        modelFade: 0, // flames belong to the model: they wait for it to load
        thrust: 0,
        flameScale: 1,
        offset: new Float32Array(3),
        vel: new Float32Array(3),
        modelRot: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
        modelScale: 1,
        pivot: new Float32Array(3),
        camPos: new Float32Array(3),
        occ: { n: 0, c: new Float32Array(12), u: new Float32Array(12), v: new Float32Array(12), w: new Float32Array(12), h: new Float32Array(12) },
        hidden: false,
        near: 0.1,
        far: 700,
        // the canyon
        world: null,
        gameView: new Float32Array(16),
        camG: new Float32Array(3),
        flash: 0,
        fadeRange: [230, 292], // where the canyon fades out into the backdrop
        p0: 1,
        p5: 1,
        projX: (w, h) => (proj ? proj[0] : 1 / Math.tan((game.vfov * Math.PI) / 360) / (w / h)),
        projY: (w, h) => (proj ? proj[1] : 1 / Math.tan((game.vfov * Math.PI) / 360))
    };
    const gameView64 = new Float64Array(16);

    let app = null;
    let cameraComponent = null;
    let lastNow = performance.now();
    const startNow = lastNow;

    const render = () => {
        const now = performance.now();
        const dt = Math.min(0.1, (now - lastNow) / 1000);
        lastNow = now;
        frame.time = ((now - startNow) / 1000) * CONFIG.timeScale * (reducedMotion ? 0.3 : 1);
        frame.fade = Math.min(1, (now - startNow) / 2500);
        frame.dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxDpr);

        if (front === null) attachFront();

        // camera: what the engine renders with, once there is one; the game's own until then
        if (cameraComponent?.entity) {
            const p = cameraComponent.projectionMatrix?.data;
            proj = p ? [p[0], p[5]] : null;
            camWorld.set(cameraComponent.entity.getWorldTransform().data);
            frame.hidden = !!app.xr?.active;
        } else {
            proj = null;
            camWorld.set(game.camWorld);
        }
        invert(camWorld, view);

        // the model: its centre and (scanned) size from the game; the clear space round it grows
        // with the scale it is drawn at, the light particles' layout does not
        const bounds = game.model;
        const scale = game.fx.scale;
        if (app) frame.modelFade = Math.min(1, frame.modelFade + dt / 1.2);
        frame.center.set(bounds.center);
        const longest = Math.max(...bounds.halfExt);
        for (let i = 0; i < 3; i++) {
            frame.halfExt[i] = Math.max(bounds.halfExt[i], longest * 0.6) * CONFIG.clearance * scale;
        }
        frame.radius = Math.hypot(...bounds.halfExt);
        frame.band = Math.max(0.05, Math.min(...bounds.halfExt) * 0.5 * scale);
        const [cx, cy, cz] = bounds.center;
        frame.focus = Math.max(0.05, -(view[2] * cx + view[6] * cy + view[10] * cz + view[14]));

        // the game: how far the space has streamed past, the model's pose, the flames
        const gs = game.fx;
        const pivot = game.model.center;
        frame.offset.set(gs.offset);
        frame.vel.set(gs.vel);
        frame.modelRot.set(gs.rotMat);
        frame.modelScale = scale;
        frame.pivot.set(pivot);
        frame.thrust = gs.thrust;
        frame.camPos.set([camWorld[12], camWorld[13], camWorld[14]]);
        // occluders turn and lean with the model, about its centre
        const occ = frame.occ;
        occ.n = Math.min(4, OCCLUDERS.length);
        const R = gs.rotMat;
        const rot = (x, y, z) => [R[0] * x + R[3] * y + R[6] * z, R[1] * x + R[4] * y + R[7] * z, R[2] * x + R[5] * y + R[8] * z];
        for (let i = 0; i < occ.n; i++) {
            const b = OCCLUDERS[i];
            const c = rot((b.center[0] - pivot[0]) * scale, (b.center[1] - pivot[1]) * scale, (b.center[2] - pivot[2]) * scale);
            occ.c.set([c[0] + pivot[0], c[1] + pivot[1], c[2] + pivot[2]], i * 3);
            occ.u.set(rot(...b.u), i * 3);
            occ.v.set(rot(...b.v), i * 3);
            occ.w.set(rot(...b.w), i * 3);
            occ.h.set(b.half.map((x) => x * scale), i * 3);
        }
        frame.flameScale = (0.7 + 0.3 * gs.thrust) * (1 + 0.6 * gs.sprint);

        // the canyon: game coordinates → camera view
        frame.world = game.world;
        frame.gameView.set(mul4(view, gs.G, gameView64));
        frame.camG.set(gs.camG);
        frame.flash = gs.flash;
        frame.fadeRange = gs.fadeRange;

        back.draw(frame);
        if (front) front.draw(frame);
    };

    return {
        frame,
        render,
        // from now on the engine's camera is the one to follow
        setApp(a) {
            app = a;
            cameraComponent = app.root.findComponents('camera')[0] ?? null;
        }
    };
};
