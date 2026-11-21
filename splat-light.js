// splat-light.js — 自機（ガウシアンスプラットのガンプラ）のライティング。
//
// スキャンの色にはスタジオの光が焼き込まれているので、その上から光を足し引きする:
//   - 太陽: 隕石と同じ左上からの光（当たる側を明るく暖かく、反対側を青みの影に）
//   - 空のリムライト: 輪郭に沿って淡い青
//   - スラスター: ふくらはぎのノズルの青白い光が脚と足を照らす（ブーストで強く）
//   - 彗星: 近くを通る彗星の方向から青白い光
//   - 被弾: 赤い光が一瞬、近くの爆発: 橙の光
//   - 色の調整: 彩度・コントラスト・明るさ
//
// 仕組み: エンジン（PlayCanvas）の gsplat に「ワークバッファ修飾子」を渡す。スプラット 1 粒ごとに
// 色を書き換えられる。粒の向きは、楕円体のいちばん薄い軸を面の向き（法線）として使う
// （丸い粒は向きがはっきりしないので、モデルの中心から外向きの向きに寄せる）。
// 値は毎フレーム uniform で渡す（座標はビューアのワールド座標）。

export const SPLAT_LIGHT = {
    sunColor: [1.0, 0.9, 0.78], // 太陽の光の色
    sun: 1.05, // 太陽の強さ
    toCamera: 0.8, // 太陽の向きをカメラ側へ寄せる量（0 = 隕石と同じ向き。上げるほど見えている面が明るい）
    ambient: [0.38, 0.42, 0.54], // 影の側の明るさ（少し青い）
    rim: [0.35, 0.55, 0.95], // 輪郭の空の光の色
    rimPower: 0.35, // ... の強さ
    jetColor: [0.6, 0.8, 1.0], // スラスターの光の色
    jet: 0.7, // ... の強さ（ブースト中はさらに強く）
    jetRadius: 0.55, // ... の届く距離（ワールド単位、自機の拡大率がかかる）
    cometColor: [0.5, 0.75, 1.0], // 彗星の光の色
    comet: 0.9, // ... の強さ（いちばん近いとき）
    cometRange: [70, 10], // この距離（ゲームの単位）から光り始め、ここで最大
    hitColor: [1.0, 0.22, 0.12], // 被弾したときの光
    flashColor: [1.0, 0.6, 0.3], // 近くの爆発の光
    saturation: 0.92, // 彩度（1 = スキャンのまま）
    contrast: 1.06, // コントラスト
    brightness: 1.0, // 明るさ
    amount: 1.0 // ライティング全体のかかり具合（0 = スキャンのまま）
};

// the same lighting in both shading languages (WebGPU and WebGL2)
const WGSL = `
uniform uSlPivot: vec3f;
uniform uSlCam: vec3f;
uniform uSlSunDir: vec3f;
uniform uSlSunCol: vec3f;
uniform uSlAmb: vec3f;
uniform uSlRim: vec3f;
uniform uSlL2Dir: vec3f;
uniform uSlL2Col: vec3f;
uniform uSlJet0: vec4f;
uniform uSlJet1: vec4f;
uniform uSlJetCol: vec4f;
uniform uSlTint: vec3f;
uniform uSlGrade: vec4f;
var<private> slAxis: vec3f;
var<private> slFlat: f32;

fn modifySplatCenter(center: ptr<function, vec3f>) {
}

// the thinnest axis of the splat's ellipsoid, turned into the world: the surface's facing
fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    let s = *scale;
    var a = vec3f(1.0, 0.0, 0.0);
    var lo = s.x;
    var mid = min(s.y, s.z);
    if (s.y <= s.x && s.y <= s.z) {
        a = vec3f(0.0, 1.0, 0.0);
        lo = s.y;
        mid = min(s.x, s.z);
    } else if (s.z <= s.x && s.z <= s.y) {
        a = vec3f(0.0, 0.0, 1.0);
        lo = s.z;
        mid = min(s.x, s.y);
    }
    let q = *rotation;
    let t = 2.0 * cross(q.xyz, a);
    slAxis = a + q.w * t + cross(q.xyz, t);
    slFlat = clamp(1.0 - lo / max(mid, 1e-6), 0.0, 1.0);
}

fn slJet(jet: vec4f, center: vec3f, n: vec3f) -> f32 {
    let d = jet.xyz - center;
    let r2 = uniform.uSlJetCol.w * uniform.uSlJetCol.w;
    let dl = max(length(d), 1e-4);
    return jet.w * r2 / (r2 + dl * dl) * (0.35 + 0.65 * max(dot(n, d / dl), 0.0));
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let c = (*color).rgb;
    let V = normalize(uniform.uSlCam - center);
    let outward = normalize(center - uniform.uSlPivot + vec3f(0.0, 1e-4, 0.0));
    var n = normalize(slAxis);
    if (dot(n, V) < 0.0) {
        n = -n;
    }
    let w = smoothstep(0.2, 0.75, slFlat);
    n = normalize(mix(outward, n, w));
    // sun (wrapped round a little, so the terminator is soft), sky, a comet going by
    let d = (dot(n, uniform.uSlSunDir) + 0.25) / 1.25;
    let k = uniform.uSlAmb + uniform.uSlSunCol * max(d, 0.0) + uniform.uSlL2Col * max(dot(n, uniform.uSlL2Dir), 0.0);
    var col = c * k;
    let rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
    col = col + uniform.uSlRim * rim * (0.35 + 0.65 * w);
    // the thrusters light the legs
    let g = slJet(uniform.uSlJet0, center, n) + slJet(uniform.uSlJet1, center, n);
    col = col + uniform.uSlJetCol.rgb * g * (c * 1.6 + vec3f(0.08));
    // a hit, an explosion close by
    col = col + uniform.uSlTint * (c + vec3f(0.1));
    // colour grading
    let lum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
    col = mix(vec3f(lum), col, uniform.uSlGrade.x);
    col = (col - vec3f(0.5)) * uniform.uSlGrade.y + vec3f(0.5);
    col = col * uniform.uSlGrade.z;
    *color = vec4f(max(mix(c, col, uniform.uSlGrade.w), vec3f(0.0)), (*color).a);
}
`;

const GLSL = `
uniform vec3 uSlPivot;
uniform vec3 uSlCam;
uniform vec3 uSlSunDir;
uniform vec3 uSlSunCol;
uniform vec3 uSlAmb;
uniform vec3 uSlRim;
uniform vec3 uSlL2Dir;
uniform vec3 uSlL2Col;
uniform vec4 uSlJet0;
uniform vec4 uSlJet1;
uniform vec4 uSlJetCol;
uniform vec3 uSlTint;
uniform vec4 uSlGrade;
vec3 slAxis;
float slFlat;

void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    vec3 s = scale;
    vec3 a = vec3(1.0, 0.0, 0.0);
    float lo = s.x;
    float mid = min(s.y, s.z);
    if (s.y <= s.x && s.y <= s.z) {
        a = vec3(0.0, 1.0, 0.0);
        lo = s.y;
        mid = min(s.x, s.z);
    } else if (s.z <= s.x && s.z <= s.y) {
        a = vec3(0.0, 0.0, 1.0);
        lo = s.z;
        mid = min(s.x, s.y);
    }
    vec4 q = rotation;
    vec3 t = 2.0 * cross(q.xyz, a);
    slAxis = a + q.w * t + cross(q.xyz, t);
    slFlat = clamp(1.0 - lo / max(mid, 1e-6), 0.0, 1.0);
}

float slJet(vec4 jet, vec3 center, vec3 n) {
    vec3 d = jet.xyz - center;
    float r2 = uSlJetCol.w * uSlJetCol.w;
    float dl = max(length(d), 1e-4);
    return jet.w * r2 / (r2 + dl * dl) * (0.35 + 0.65 * max(dot(n, d / dl), 0.0));
}

void modifySplatColor(vec3 center, inout vec4 color) {
    vec3 c = color.rgb;
    vec3 V = normalize(uSlCam - center);
    vec3 outward = normalize(center - uSlPivot + vec3(0.0, 1e-4, 0.0));
    vec3 n = normalize(slAxis);
    if (dot(n, V) < 0.0) n = -n;
    float w = smoothstep(0.2, 0.75, slFlat);
    n = normalize(mix(outward, n, w));
    float d = (dot(n, uSlSunDir) + 0.25) / 1.25;
    vec3 k = uSlAmb + uSlSunCol * max(d, 0.0) + uSlL2Col * max(dot(n, uSlL2Dir), 0.0);
    vec3 col = c * k;
    float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
    col += uSlRim * rim * (0.35 + 0.65 * w);
    float g = slJet(uSlJet0, center, n) + slJet(uSlJet1, center, n);
    col += uSlJetCol.rgb * g * (c * 1.6 + vec3(0.08));
    col += uSlTint * (c + vec3(0.1));
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(lum), col, uSlGrade.x);
    col = (col - 0.5) * uSlGrade.y + 0.5;
    col *= uSlGrade.z;
    color = vec4(max(mix(c, col, uSlGrade.w), vec3(0.0)), color.a);
}
`;

const norm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
};

export const createSplatLight = () => {
    let comp = null;
    const L = SPLAT_LIGHT;
    const u = {
        uSlPivot: new Float32Array(3),
        uSlCam: new Float32Array(3),
        uSlSunDir: new Float32Array(3),
        uSlSunCol: new Float32Array(3),
        uSlAmb: new Float32Array(3),
        uSlRim: new Float32Array(3),
        uSlL2Dir: new Float32Array([0, 1, 0]),
        uSlL2Col: new Float32Array(3),
        uSlJet0: new Float32Array(4),
        uSlJet1: new Float32Array(4),
        uSlJetCol: new Float32Array(4),
        uSlTint: new Float32Array(3),
        uSlGrade: new Float32Array(4)
    };
    const fx = { hit: 0 };

    return {
        // the model's gsplat component, once it has loaded
        attach(gsplat) {
            comp = gsplat;
            comp.setWorkBufferModifier({ wgsl: WGSL, glsl: GLSL });
        },
        hit() {
            fx.hit = 1;
        },
        // s: { dt, pivot, cam, sunDir (viewer world, towards the sun), jets: [[x, y, z], ...],
        //      thrust 0..1, boost 0..1, scale, comet: { dir, near 0..1 } | null, flash 0.. }
        update(s) {
            if (!comp) return;
            fx.hit = Math.max(0, fx.hit - s.dt * 2.2);
            u.uSlPivot.set(s.pivot);
            u.uSlCam.set(s.cam);
            // the meteors' sun, turned towards the camera a little so the side in view is not all in shade
            const sd = norm(s.sunDir);
            const cd = norm([s.cam[0] - s.pivot[0], s.cam[1] - s.pivot[1], s.cam[2] - s.pivot[2]]);
            u.uSlSunDir.set(norm([sd[0] + cd[0] * L.toCamera, sd[1] + cd[1] * L.toCamera, sd[2] + cd[2] * L.toCamera]));
            u.uSlSunCol.set(L.sunColor.map((c) => c * L.sun));
            u.uSlAmb.set(L.ambient);
            u.uSlRim.set(L.rim.map((c) => c * L.rimPower));
            if (s.comet) {
                u.uSlL2Dir.set(norm(s.comet.dir));
                u.uSlL2Col.set(L.cometColor.map((c) => c * L.comet * s.comet.near));
            } else {
                u.uSlL2Col.fill(0);
            }
            const flicker = 0.9 + 0.1 * Math.sin(s.time * 37) * Math.sin(s.time * 23 + 1.3);
            const jet = L.jet * s.thrust * (1 + 0.9 * s.boost) * flicker;
            const set4 = (a, p, w) => {
                a[0] = p[0];
                a[1] = p[1];
                a[2] = p[2];
                a[3] = w;
            };
            set4(u.uSlJet0, s.jets[0] ?? [0, -99, 0], s.jets[0] ? jet : 0);
            set4(u.uSlJet1, s.jets[1] ?? [0, -99, 0], s.jets[1] ? jet : 0);
            set4(u.uSlJetCol, L.jetColor, L.jetRadius * s.scale);
            for (let i = 0; i < 3; i++) u.uSlTint[i] = L.hitColor[i] * fx.hit * 0.7 + L.flashColor[i] * Math.min(s.flash, 1.5) * 0.3;
            u.uSlGrade.set([L.saturation, L.contrast, L.brightness, L.amount]);
            for (const [name, value] of Object.entries(u)) comp.setParameter(name, value);
        }
    };
};
