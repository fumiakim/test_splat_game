// rock-shapes.js — 隕石の形のカタログ（いろいろな形の岩のメッシュと、当たり判定用の半径の表）。
//
// 形の種類（それぞれ乱数の種を変えて PER_TYPE 個ずつ）:
//   じゃがいも型 / 細長い型 / 双子型（2 つの塊がくっついた形） / 平たい板状 / 角ばった破片 /
//   クレーター型 / ごつごつ塊（小さな塊の寄せ集め）
//
// 作り方: 楕円体（ローブ）をなめらかにつなぎ、平面で削り（破片の面・板の上下）、中心から放射状に
// 表面を探す（球面トレース）。その表面をクレーター（くぼみ＋盛り上がった縁）とノイズでデコボコに
// する。くぼみ（双子の首・塊のすき間・クレーターの底）は暗くする（頂点ごとの遮蔽 ao）。
// 中心から表面までの距離は方向の表（緯度×経度）にも残し、当たり判定に使う。
// 大きさは「同じ体積の球の半径」が 1 になるようにそろえる（細長い型は端が 1 より遠くまで届く）。

import { mulberry32, noise3, fbm3 } from './noise.js';

export const SHAPE_TYPES = [
    { key: 'potato', name: 'じゃがいも型' },
    { key: 'long', name: '細長い型' },
    { key: 'binary', name: '双子型' },
    { key: 'slab', name: '平たい板状' },
    { key: 'shard', name: '角ばった破片' },
    { key: 'crater', name: 'クレーター型' },
    { key: 'rubble', name: 'ごつごつ塊' }
];
export const PER_TYPE = 3;
export const SHAPE_COUNT = SHAPE_TYPES.length * PER_TYPE;
export const ROCK_VERT_FLOATS = 7; // pos3 normal3 ao

const SUBDIV = 4; // 2562 vertices per rock
const NT = 32; // radius table: rows from the top (+y) down
const NPH = 64; // ... and columns round
const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------------------------------------------------------------------------------------------
// geometry helpers

const icosphere = (subdiv) => {
    const t = (1 + Math.sqrt(5)) / 2;
    const verts = [
        [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
        [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
        [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]
    ].map((v) => {
        const l = Math.hypot(...v);
        return v.map((x) => x / l);
    });
    let faces = [
        [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
        [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
        [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
    ];
    for (let s = 0; s < subdiv; s++) {
        const mid = new Map();
        const midpoint = (a, b) => {
            const key = a < b ? a * 100000 + b : b * 100000 + a;
            let i = mid.get(key);
            if (i === undefined) {
                const v = verts[a].map((x, k) => x + verts[b][k]);
                const l = Math.hypot(...v);
                i = verts.length;
                verts.push(v.map((x) => x / l));
                mid.set(key, i);
            }
            return i;
        };
        const next = [];
        for (const [a, b, c] of faces) {
            const ab = midpoint(a, b);
            const bc = midpoint(b, c);
            const ca = midpoint(c, a);
            next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
        }
        faces = next;
    }
    return { verts, faces };
};

const randDir = (rnd) => {
    const z = rnd() * 2 - 1;
    const a = rnd() * TAU;
    const s = Math.sqrt(1 - z * z);
    return [s * Math.cos(a), z, s * Math.sin(a)];
};
const norm = (v) => {
    const l = Math.hypot(...v) || 1;
    return v.map((x) => x / l);
};
// rotation matrix (rows) about a random axis by up to maxAngle
const randRot = (rnd, maxAngle = Math.PI) => {
    const [x, y, z] = randDir(rnd);
    const a = (rnd() * 2 - 1) * maxAngle;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const t = 1 - c;
    return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
};

// distance to an ellipsoid (a close estimate, good enough to trace)
const sdEll = (x, y, z, rx, ry, rz) => {
    const k0 = Math.hypot(x / rx, y / ry, z / rz);
    const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
    return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
};
const smin = (a, b, k) => {
    const h = Math.max(k - Math.abs(a - b), 0) / k;
    return Math.min(a, b) - h * h * k * 0.25;
};
const smax = (a, b, k) => -smin(-a, -b, k);

const makeSdf = (lobes, cuts, k, cutK) => (x, y, z) => {
    let d = Infinity;
    for (const L of lobes) {
        let px = x - L.c[0];
        let py = y - L.c[1];
        let pz = z - L.c[2];
        if (L.m) {
            const m = L.m;
            const qx = m[0] * px + m[1] * py + m[2] * pz;
            const qy = m[3] * px + m[4] * py + m[5] * pz;
            const qz = m[6] * px + m[7] * py + m[8] * pz;
            px = qx;
            py = qy;
            pz = qz;
        }
        const e = sdEll(px, py, pz, L.r[0], L.r[1], L.r[2]);
        d = d === Infinity ? e : smin(d, e, k);
    }
    for (const C of cuts) d = smax(d, x * C.n[0] + y * C.n[1] + z * C.n[2] - C.d, cutK);
    return d;
};

// from outside in along a ray through the centre: the outermost surface
const trace = (sdf, dx, dy, dz, tMax) => {
    let t = tMax;
    for (let i = 0; i < 160; i++) {
        const f = sdf(dx * t, dy * t, dz * t);
        if (f < 1e-3) break;
        t -= Math.max(f * 0.9, 5e-4);
        if (t < 0.05) return 0.05;
    }
    return t;
};

// ---------------------------------------------------------------------------------------------
// the recipes. Lobes: ellipsoids blended with smoothness k. Chips: planes that slice off the
// lobes at frac of their reach in that direction (smoothed by cutK). Craters: groups of
// [count range, radius range, depth range]

const R = (rnd, a, b) => lerp(a, b, rnd());
const RI = (rnd, a, b) => a + Math.floor(rnd() * (b - a + 1));
const chips = (rnd, n, f0, f1, dir = () => randDir(rnd)) => Array.from({ length: n }, () => ({ n: norm(dir()), frac: R(rnd, f0, f1) }));
const bulges = (rnd, n, main, dist, s0, s1) =>
    Array.from({ length: n }, () => {
        const d = randDir(rnd);
        const s = R(rnd, s0, s1);
        return {
            c: [d[0] * main[0] * dist, d[1] * main[1] * dist, d[2] * main[2] * dist],
            r: [s * R(rnd, 0.9, 1.25), s * R(rnd, 0.8, 1.1), s * R(rnd, 0.85, 1.15)],
            m: randRot(rnd)
        };
    });

const RECIPES = {
    // a lumpy, slightly long potato with a few knobs and a flattened side or two
    potato(rnd) {
        const main = [R(rnd, 1.25, 1.5), R(rnd, 0.78, 0.92), R(rnd, 0.88, 1.02)];
        return {
            lobes: [{ c: [0, 0, 0], r: main }, ...bulges(rnd, RI(rnd, 2, 4), main, 0.55, 0.45, 0.68)],
            k: 0.45,
            chips: chips(rnd, RI(rnd, 1, 2), 0.82, 0.92),
            cutK: 0.22,
            noise: { amp: 0.13, freq: 1.25, ridge: 0.035 },
            craters: [[6, 10, 0.18, 0.5, 0.06, 0.13]]
        };
    },
    // a long, slightly bent body, thicker in the middle, often with a broken-off end
    long(rnd) {
        const n = RI(rnd, 3, 4);
        const bend = R(rnd, -0.32, 0.32);
        const L = R(rnd, 1.0, 1.2);
        const lobes = Array.from({ length: n }, (_, i) => {
            const t = (i / (n - 1)) * 2 - 1;
            const s = lerp(0.74, 0.5, Math.abs(t)) * R(rnd, 0.9, 1.1);
            return { c: [t * L, bend * (t * t - 0.4), R(rnd, -0.08, 0.08)], r: [s * 1.15, s * R(rnd, 0.82, 1.0), s * R(rnd, 0.9, 1.05)], m: randRot(rnd, 0.4) };
        });
        const cuts = chips(rnd, RI(rnd, 0, 1), 0.85, 0.93);
        if (rnd() < 0.7) cuts.push({ n: norm([rnd() < 0.5 ? -1 : 1, R(rnd, -0.4, 0.4), R(rnd, -0.4, 0.4)]), frac: R(rnd, 0.8, 0.9) });
        return { lobes, k: 0.55, chips: cuts, cutK: 0.12, noise: { amp: 0.11, freq: 1.3, ridge: 0.03 }, craters: [[5, 8, 0.15, 0.4, 0.05, 0.11]] };
    },
    // a contact binary: a big lobe and a smaller one joined by a narrow neck
    binary(rnd) {
        const A = R(rnd, 0.88, 1.0);
        const B = A * R(rnd, 0.62, 0.8);
        const a = { c: [-0.5, 0, 0], r: [A * 1.1, A * R(rnd, 0.86, 0.98), A * R(rnd, 0.9, 1.0)] };
        const b = { c: [-0.5 + A * 0.95 + B * 0.72, R(rnd, -0.14, 0.14), R(rnd, -0.14, 0.14)], r: [B * 1.12, B * R(rnd, 0.85, 1.0), B * R(rnd, 0.9, 1.05)], m: randRot(rnd, 0.6) };
        const knob = (o, s) => {
            const d = randDir(rnd);
            const k = s * R(rnd, 0.35, 0.5);
            return { c: [o.c[0] + d[0] * s * 0.6, o.c[1] + d[1] * s * 0.6, o.c[2] + d[2] * s * 0.6], r: [k, k * 0.85, k], m: randRot(rnd) };
        };
        return {
            lobes: [a, b, knob(a, A), knob(b, B)],
            k: 0.2,
            chips: chips(rnd, RI(rnd, 0, 1), 0.85, 0.93),
            cutK: 0.15,
            noise: { amp: 0.11, freq: 1.35, ridge: 0.03 },
            craters: [[6, 10, 0.15, 0.42, 0.06, 0.12]]
        };
    },
    // a flat slab with a broken outline: flat top and bottom, chipped sides
    slab(rnd) {
        const main = [R(rnd, 1.45, 1.7), R(rnd, 0.5, 0.6), R(rnd, 1.05, 1.3)];
        const lobes = [{ c: [0, 0, 0], r: main }];
        const m = RI(rnd, 2, 3);
        for (let i = 0; i < m; i++) {
            const a = rnd() * TAU;
            const s = R(rnd, 0.5, 0.75);
            lobes.push({ c: [Math.cos(a) * main[0] * 0.55, R(rnd, -0.08, 0.08), Math.sin(a) * main[2] * 0.55], r: [s, s * 0.55, s * R(rnd, 0.8, 1.1)], m: randRot(rnd, 0.25) });
        }
        const tilt = () => [R(rnd, -0.18, 0.18), 0, R(rnd, -0.18, 0.18)];
        const top = tilt();
        const bot = tilt();
        const cuts = [
            { n: norm([top[0], 1, top[2]]), frac: R(rnd, 0.7, 0.84) },
            { n: norm([bot[0], -1, bot[2]]), frac: R(rnd, 0.74, 0.88) },
            ...chips(rnd, RI(rnd, 2, 3), 0.83, 0.93, () => {
                const a = rnd() * TAU;
                return [Math.cos(a), R(rnd, -0.3, 0.3), Math.sin(a)];
            })
        ];
        return { lobes, k: 0.4, chips: cuts, cutK: 0.15, noise: { amp: 0.08, freq: 1.3, ridge: 0.025 }, craters: [[4, 7, 0.2, 0.5, 0.05, 0.09]] };
    },
    // a fresh fragment: many flat broken faces with blunt edges
    shard(rnd) {
        const main = [R(rnd, 1.15, 1.35), R(rnd, 0.85, 1.0), R(rnd, 0.9, 1.05)];
        return {
            lobes: [{ c: [0, 0, 0], r: main }, ...bulges(rnd, 1, main, 0.5, 0.45, 0.6)],
            k: 0.4,
            chips: chips(rnd, RI(rnd, 6, 9), 0.64, 0.86),
            cutK: 0.07,
            noise: { amp: 0.045, freq: 1.5 },
            craters: [[1, 3, 0.15, 0.3, 0.03, 0.06]]
        };
    },
    // a roundish body pocked with two or three great craters and many small ones
    crater(rnd) {
        const main = [R(rnd, 1.0, 1.1), R(rnd, 0.9, 0.98), R(rnd, 0.94, 1.04)];
        return {
            lobes: [{ c: [0, 0, 0], r: main }, ...bulges(rnd, RI(rnd, 1, 2), main, 0.6, 0.35, 0.5)],
            k: 0.4,
            chips: [],
            cutK: 0.1,
            noise: { amp: 0.08, freq: 1.3, ridge: 0.025 },
            craters: [
                [2, 3, 0.55, 0.85, 0.2, 0.3],
                [8, 12, 0.12, 0.3, 0.04, 0.09]
            ]
        };
    },
    // a rubble pile: lumps of many sizes stuck together, deep cracks between them
    rubble(rnd) {
        const main = [R(rnd, 0.85, 1.0), R(rnd, 0.72, 0.85), R(rnd, 0.8, 0.95)];
        const lobes = [{ c: [0, 0, 0], r: main }];
        const n = RI(rnd, 6, 9);
        for (let i = 0; i < n; i++) {
            const d = randDir(rnd);
            const dist = R(rnd, 0.5, 0.9);
            const s = R(rnd, 0.38, 0.72);
            lobes.push({ c: [d[0] * dist * 1.15, d[1] * dist * 0.85, d[2] * dist], r: [s * R(rnd, 0.9, 1.3), s * R(rnd, 0.75, 1.05), s * R(rnd, 0.85, 1.15)], m: randRot(rnd) });
        }
        return {
            lobes,
            k: 0.26,
            chips: chips(rnd, RI(rnd, 0, 2), 0.84, 0.93),
            cutK: 0.15,
            noise: { amp: 0.13, freq: 1.4, ridge: 0.06 },
            craters: [[6, 10, 0.12, 0.35, 0.04, 0.08]]
        };
    }
};

// ---------------------------------------------------------------------------------------------
// building one shape

const SPHERE = icosphere(SUBDIV);
const INDEX = new Uint16Array(SPHERE.faces.flat());
// the radius table's directions
const TABLE_DIRS = (() => {
    const out = [];
    for (let i = 0; i < NT; i++) {
        const th = ((i + 0.5) / NT) * Math.PI;
        for (let j = 0; j < NPH; j++) {
            const ph = (j / NPH) * TAU;
            out.push([Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]);
        }
    }
    return out;
})();

const buildShape = (typeIndex, variant) => {
    const type = SHAPE_TYPES[typeIndex];
    const rnd = mulberry32(7919 * (typeIndex + 1) + 104729 * (variant + 1));
    const rec = RECIPES[type.key](rnd);
    const { lobes, k, cutK } = rec;
    const reach = Math.max(...lobes.map((L) => Math.hypot(...L.c) + Math.max(...L.r))) + 0.2;

    // the chips' planes, at a fraction of how far the lobes reach that way
    const sdf0 = makeSdf(lobes, [], k, cutK);
    const cuts = rec.chips.map((c) => ({ n: c.n, d: trace(sdf0, c.n[0], c.n[1], c.n[2], reach) * c.frac }));
    const sdf = makeSdf(lobes, cuts, k, cutK);
    const base = (d) => trace(sdf, d[0], d[1], d[2], reach);

    // craters: centred on the base surface
    const craters = [];
    for (const [n0, n1, r0, r1, d0, d1] of rec.craters) {
        const n = RI(rnd, n0, n1);
        for (let i = 0; i < n; i++) {
            const d = randDir(rnd);
            const b = base(d);
            craters.push({ c: [d[0] * b, d[1] * b, d[2] * b], r: R(rnd, r0, r1), depth: R(rnd, d0, d1) });
        }
    }
    const off = [rnd() * 100, rnd() * 100, rnd() * 100];
    const { amp, freq, ridge = 0 } = rec.noise;
    // the bumps and pits at a point P of the base surface: [radial offset, how deep in a crater]
    const relief = (P) => {
        const [x, y, z] = P;
        let h = amp * fbm3(x * freq + off[0], y * freq + off[1], z * freq + off[2], 4) + 0.022 * noise3(x * 5.5 + off[1], y * 5.5 + off[2], z * 5.5 + off[0]);
        if (ridge) h += ridge * (1 - 2 * Math.abs(noise3(x * 2.2 + off[2], y * 2.2, z * 2.2 + off[1])));
        let bowl = 0;
        for (const C of craters) {
            const t = Math.hypot(x - C.c[0], y - C.c[1], z - C.c[2]) / C.r;
            if (t > 1.8) continue;
            if (t < 1) {
                h -= C.depth * (1 - t * t);
                bowl = Math.max(bowl, (1 - t * t) * Math.min(1, C.depth / 0.12));
            }
            h += C.depth * 0.4 * Math.exp(-(((t - 1) / 0.28) ** 2));
        }
        return [h, bowl];
    };
    const surface = (d) => {
        const b = base(d);
        const [h, bowl] = relief([d[0] * b, d[1] * b, d[2] * b]);
        return [Math.max(0.12, b + h), bowl];
    };

    const nv = SPHERE.verts.length;
    const rad = new Float32Array(nv);
    const bowl = new Float32Array(nv);
    SPHERE.verts.forEach((d, i) => {
        const [r, bw] = surface(d);
        rad[i] = r;
        bowl[i] = bw;
    });
    const table = new Float32Array(NT * NPH);
    TABLE_DIRS.forEach((d, i) => {
        table[i] = surface(d)[0];
    });

    // size: the radius of the ball of the same volume is 1
    let v3 = 0;
    for (let i = 0; i < nv; i++) v3 += rad[i] ** 3;
    const req = Math.cbrt(v3 / nv);
    for (let i = 0; i < nv; i++) rad[i] /= req;
    for (let i = 0; i < table.length; i++) table[i] /= req;

    // how far the surface is from the centre in the direction (dx, dy, dz) (a unit vector)
    const sample = (dx, dy, dz) => {
        const th = Math.acos(clamp(dy, -1, 1));
        let ph = Math.atan2(dz, dx);
        if (ph < 0) ph += TAU;
        const fi = clamp((th / Math.PI) * NT - 0.5, 0, NT - 1);
        const fj = (ph / TAU) * NPH;
        const i0 = Math.min(Math.floor(fi), NT - 2);
        const ti = fi - i0;
        const j0 = Math.floor(fj) % NPH;
        const j1 = (j0 + 1) % NPH;
        const tj = fj - Math.floor(fj);
        const at = (a, i, j) => a[i * NPH + j];
        const bil = (a) => lerp(lerp(at(a, i0, j0), at(a, i0, j1), tj), lerp(at(a, i0 + 1, j0), at(a, i0 + 1, j1), tj), ti);
        return bil(table);
    };

    // positions, normals
    const pos = SPHERE.verts.map((d, i) => [d[0] * rad[i], d[1] * rad[i], d[2] * rad[i]]);
    const nrm = pos.map(() => [0, 0, 0]);
    for (const [a, b, c] of SPHERE.faces) {
        const u = [pos[b][0] - pos[a][0], pos[b][1] - pos[a][1], pos[b][2] - pos[a][2]];
        const v = [pos[c][0] - pos[a][0], pos[c][1] - pos[a][1], pos[c][2] - pos[a][2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        for (const i of [a, b, c]) for (let q = 0; q < 3; q++) nrm[i][q] += n[q];
    }

    // occlusion: step out along the normal; where the surface is still close (a neck, a crack, a
    // crater) less of the sky reaches in
    const data = new Float32Array(nv * ROCK_VERT_FLOATS);
    let maxR = 0;
    const ext = [0, 0, 0];
    for (let i = 0; i < nv; i++) {
        const p = pos[i];
        let n = norm(nrm[i]);
        if (n[0] * p[0] + n[1] * p[1] + n[2] * p[2] < 0) n = n.map((x) => -x);
        let occ = 0;
        for (const [h, w] of [[0.1, 0.45], [0.22, 0.3], [0.4, 0.25]]) {
            const q = [p[0] + n[0] * h, p[1] + n[1] * h, p[2] + n[2] * h];
            const ql = Math.hypot(...q);
            const f = ql - sample(q[0] / ql, q[1] / ql, q[2] / ql);
            occ += (w * Math.max(0, h - f)) / h;
        }
        const ao = clamp(1 - occ * 2.0, 0, 1) * (1 - 0.6 * bowl[i]);
        data.set([p[0], p[1], p[2], n[0], n[1], n[2], 0.3 + 0.7 * ao], i * ROCK_VERT_FLOATS);
        maxR = Math.max(maxR, rad[i]);
        for (let q = 0; q < 3; q++) ext[q] = Math.max(ext[q], Math.abs(p[q]));
    }

    return { type: type.key, name: type.name, typeIndex, variant, data, index: INDEX, maxR, ext, sample };
};

// ---------------------------------------------------------------------------------------------

let shapes = null;
// every shape (built once, on first use)
export const getRockShapes = () => {
    if (!shapes) {
        shapes = [];
        for (let t = 0; t < SHAPE_TYPES.length; t++) for (let v = 0; v < PER_TYPE; v++) shapes.push(buildShape(t, v));
    }
    return shapes;
};

export const shapeIndex = (key, variant = 0) => SHAPE_TYPES.findIndex((t) => t.key === key) * PER_TYPE + variant;

// a random shape among the given types
export const pickShape = (rnd, keys) => shapeIndex(keys[Math.floor(rnd() * keys.length)], Math.floor(rnd() * PER_TYPE));
