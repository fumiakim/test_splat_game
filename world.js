// world.js — 隕石・彗星（と、?canyon のときの渓谷の地形・岩柱・岩橋）・火花と、当たり判定（CPU 側）。
//
// ゲーム座標: x = 右, y = 上, z = 前（奥へ進む向き）。1 単位 ≒ 6 m（スキャンしたガンプラは約 3 単位）。
// 描画は world-gl.js が、ここで作ったデータ（地形の頂点・岩のインスタンス・光の粒）をそのまま使う。
//
// ふだんは宇宙空間（隕石だけ）。プレイヤーは AREA の箱の中を動ける。URL に ?canyon を付けると
// 以前の渓谷モード（地形・岩柱・岩橋あり）になる。

import { mulberry32, noise3, fbm3 } from './noise.js';
import { getRockShapes, pickShape, shapeIndex, SHAPE_TYPES, SHAPE_COUNT, PER_TYPE } from './rock-shapes.js';

export { mulberry32, noise3, fbm3 };

export const UNIT_M = 6;
export const PLAYER_SCALE = 1.8; // 自機（スプラット）をスキャンの何倍の大きさで描くか
export const WALL_H = 40; // 崖の高さ（谷底から縁まで）
export const MIN_ALT = 1.7 * PLAYER_SCALE; // 谷底からの最低高度（モデル中心）
export const MAX_ALT = 17; // 谷底からの最高高度（これより上には上がれない）
export const PLAYER_HALF_W = 0.85 * PLAYER_SCALE; // 壁との当たり判定の半幅
export const PLAYER_PAD = 0.95 * PLAYER_SCALE; // 岩との当たり判定の半径
export const AREA = { x: 18, y: 10 }; // 宇宙モードで動ける範囲（飛行線からの左右・上下）
export const METEOR_R = 1.8; // 隕石の大きさの基準（同じ体積の球の半径）。SIZE_CLASSES の倍率をかける

// 隕石の大きさの階級: 基準の何倍か（k）と、その大きさで出てくる形（rock-shapes.js の種類）
const ALL_TYPES = SHAPE_TYPES.map((t) => t.key);
export const SIZE_CLASSES = {
    small: { name: '小石', k: [0.3, 0.55], types: ['shard', 'potato', 'crater', 'long'] },
    medium: { name: '中', k: [0.55, 1.15], types: ALL_TYPES },
    large: { name: '大', k: [1.15, 1.9], types: ['potato', 'binary', 'long', 'slab', 'crater', 'rubble'] },
    giant: { name: '巨大岩', k: [2.4, 3.3], types: ['rubble', 'slab', 'binary', 'long', 'potato'] }
};
const HIT_SHRINK = 0.9; // 見た目の表面より少し内側で当たる（デコボコの先端はかすめても平気）

export const RING_STEP = 2.0; // 地形の断面の間隔
export const RING_COUNT = 168; // 保持する断面の数
export const RINGS_BEHIND = 14; // プレイヤーより後ろに残す断面の数（カメラの横の崖）
export const VERT_FLOATS = 8; // pos3 normal3 ao sun
const NP = 3; // 崖の上の台地（片側）
const NW = 24; // 崖（片側）
const NF = 13; // 谷底
export const PROFILE_N = 2 * NP + 2 * NW + NF;

export const ROCK_VARIANTS = SHAPE_COUNT; // 岩の形の数（形ごとにまとめて描く）
export const ROCK_FLOATS = 14; // pos3 scale3 quat4 heat shadow seed -
export const MAX_ROCKS = 160;
export const SPARK_FLOATS = 8; // pos3 size rgb intensity
export const MAX_SPARKS = 4000;
export const MAX_BLOBS = 16;
export const TAIL_FLOATS = 14; // head3 tail3 (w0 w1 intensity seed) (rgb -)
export const MAX_TAILS = 16;

// 太陽の向き（光の来る方向）: 左上、少し手前から
export const SUN = (() => {
    const v = [-0.5, 0.82, -0.12];
    const l = Math.hypot(...v);
    return v.map((x) => x / l);
})();

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth01 = (t) => {
    t = clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------------------------
// the canyon's shape: a winding gorge whose floor rolls, which narrows and twists as the run goes on

export const flare = (h) => 0.2 * h + 0.0035 * h * h; // 上に行くほど谷が広がる

export class Track {
    constructor(seed) {
        this.seed = seed | 0;
        const rnd = mulberry32(seed);
        this.ph = Array.from({ length: 10 }, () => rnd() * TAU);
        this.z0 = Infinity; // the run's start; until then the canyon stays easy
    }

    // difficulty 0..1 by the distance flown in this run
    diff(z) {
        return smooth01((z - this.z0) / 13000);
    }

    centerX(z) {
        const p = this.ph;
        const amp = 0.45 + 0.55 * this.diff(z);
        return amp * (14 * Math.sin(z * 0.0105 + p[0]) + 22 * Math.sin(z * 0.0043 + p[1]) + 4 * Math.sin(z * 0.027 + p[2]));
    }

    floorY(z) {
        const p = this.ph;
        return -6 + 3 * Math.sin(z * 0.0071 + p[3]) + 1.5 * Math.sin(z * 0.017 + p[4]);
    }

    halfWidth(z) {
        const p = this.ph;
        const d = this.diff(z);
        const base = 15 - 5.5 * d;
        const wave = 3.2 * Math.sin(z * 0.0125 + p[5]) + 1.8 * Math.sin(z * 0.031 + p[6]);
        // now and then the canyon pinches into a gorge
        const gorge = Math.max(0, Math.sin(z * 0.0037 + p[7]) - 0.75) * 4 * (3 + 3 * d);
        return Math.max(5.5, base + wave - gorge);
    }

    // how far the wall is pushed back into the rock (buttresses and hollows)
    wallDisp(side, h, z) {
        const o = side > 0 ? 31.7 : -12.3;
        const big = fbm3(z * 0.03 + o, h * 0.045, o * 0.37, 3, this.seed);
        const mid = noise3(z * 0.11, h * 0.14 + o, 3.3, this.seed + 7);
        return 1.3 + 2.1 * big + 0.55 * mid;
    }

    // the wall's x at game height y
    wallX(side, y, z) {
        const h = Math.max(0, y - this.floorY(z));
        return this.centerX(z) + side * (this.halfWidth(z) + flare(h) + this.wallDisp(side, h, z));
    }

    floorDisp(x, z) {
        return 0.7 * fbm3(x * 0.08, 0.5, z * 0.08, 2, this.seed + 3);
    }

    // highest ground under (x, z), a little generous
    groundY(x, z) {
        return this.floorY(z) + Math.max(0, this.floorDisp(x, z));
    }

    // how much sun reaches (x, y, z): march towards the sun and see whether the canyon walls block it
    sunVis(x, y, z) {
        let vis = 1;
        for (const t of MARCH) {
            const qx = x + SUN[0] * t;
            const qy = y + SUN[1] * t;
            const qz = z + SUN[2] * t;
            const h = qy - this.floorY(qz);
            if (h >= WALL_H) break;
            const cx = this.centerX(qz);
            const side = qx > cx ? 1 : -1;
            const room = this.halfWidth(qz) + flare(Math.max(h, 0)) + this.wallDisp(side, Math.max(h, 0), qz) - Math.abs(qx - cx);
            vis = Math.min(vis, clamp(0.5 + room / 2.5, 0, 1));
            if (vis <= 0) break;
        }
        return vis;
    }
}
const MARCH = [3, 5, 8, 11.5, 16, 22, 29, 38, 49, 62];

// ---------------------------------------------------------------------------------------------
// terrain: a ring buffer of cross-sections ahead of (and a little behind) the player

const PLATEAU = [
    [60, 9],
    [24, 5],
    [7, 1.5]
]; // [outward from the rim, rise above it], outermost first
const WALL_T = Array.from({ length: NW }, (_, k) => Math.pow(k / (NW - 1), 1.55));

export class Terrain {
    constructor() {
        this.data = new Float32Array(RING_COUNT * PROFILE_N * VERT_FLOATS);
        this.version = new Uint32Array(RING_COUNT); // bumped whenever a slot is rewritten
        this.slotRing = new Int32Array(RING_COUNT); // which ring each slot holds
        this.first = 0;
        this.last = -1; // ring indices held: first..last
        // how many rings to keep behind the player: many while the title camera looks back along
        // the canyon, few while chasing (more of the buffer ahead). Eased a few rings per frame
        this.behind = RINGS_BEHIND;
        this.behindTarget = RINGS_BEHIND;
        this.P = new Float64Array(PROFILE_N * 3);
        this.Pm = new Float64Array(PROFILE_N * 3);
        this.Pp = new Float64Array(PROFILE_N * 3);
        this.AO = new Float64Array(PROFILE_N);
        this.track = null;
    }

    reset(track, z) {
        this.track = track;
        this.slotRing.fill(-0x7fffffff);
        this.behind = this.behindTarget;
        this.update(z);
    }

    // the slot holding the newest ring: the strip from it to the oldest is not drawn
    get newestSlot() {
        return ((this.last % RING_COUNT) + RING_COUNT) % RING_COUNT;
    }

    update(z) {
        const d = this.behindTarget - this.behind;
        this.behind += Math.max(-3, Math.min(3, d));
        const want0 = Math.floor(z / RING_STEP) - Math.round(this.behind);
        for (let i = want0; i < want0 + RING_COUNT; i++) {
            if (this.slotRing[((i % RING_COUNT) + RING_COUNT) % RING_COUNT] !== i) this.build(i);
        }
        this.first = want0;
        this.last = want0 + RING_COUNT - 1;
    }

    profile(z, P, AO) {
        const t = this.track;
        const cx = t.centerX(z);
        const fy = t.floorY(z);
        const hw = t.halfWidth(z);
        let j = 0;
        const put = (x, y, ao) => {
            P[j * 3] = x;
            P[j * 3 + 1] = y;
            P[j * 3 + 2] = z;
            if (AO) AO[j] = ao;
            j++;
        };
        const wx = (side, h) => cx + side * (hw + flare(h) + t.wallDisp(side, h, z));
        const wallAO = (h) => 0.5 + 0.5 * smooth01(h / 8);
        const rimL = wx(-1, WALL_H);
        const rimR = wx(1, WALL_H);
        for (let k = 0; k < NP; k++) {
            const [d, r] = PLATEAU[k];
            put(rimL - d, fy + WALL_H + r + 1.5 * noise3(z * 0.05, k, 1.5, t.seed), 1);
        }
        for (let k = NW - 1; k >= 0; k--) {
            const h = WALL_H * WALL_T[k];
            put(wx(-1, h), fy + h, wallAO(h));
        }
        const xl = wx(-1, 0);
        const xr = wx(1, 0);
        const width = xr - xl;
        for (let k = 1; k <= NF; k++) {
            const s = k / (NF + 1);
            const x = lerp(xl, xr, s);
            put(x, fy + t.floorDisp(x, z) * Math.sin(Math.PI * s), 0.5 + 0.5 * smooth01((Math.min(s, 1 - s) * width) / 6));
        }
        for (let k = 0; k < NW; k++) {
            const h = WALL_H * WALL_T[k];
            put(wx(1, h), fy + h, wallAO(h));
        }
        for (let k = NP - 1; k >= 0; k--) {
            const [d, r] = PLATEAU[k];
            put(rimR + d, fy + WALL_H + r + 1.5 * noise3(z * 0.05, k, 4.5, t.seed), 1);
        }
    }

    build(i) {
        const z = i * RING_STEP;
        const { P, Pm, Pp, AO } = this;
        this.profile(z, P, AO);
        this.profile(z - 0.6, Pm, null);
        this.profile(z + 0.6, Pp, null);
        const slot = ((i % RING_COUNT) + RING_COUNT) % RING_COUNT;
        this.slotRing[slot] = i;
        const out = this.data;
        let o = slot * PROFILE_N * VERT_FLOATS;
        for (let j = 0; j < PROFILE_N; j++) {
            const a = Math.max(0, j - 1) * 3;
            const b = Math.min(PROFILE_N - 1, j + 1) * 3;
            // along the profile (left → right) and along the canyon
            const tx = P[b] - P[a];
            const ty = P[b + 1] - P[a + 1];
            const tz = P[b + 2] - P[a + 2];
            const zx = Pp[j * 3] - Pm[j * 3];
            const zy = Pp[j * 3 + 1] - Pm[j * 3 + 1];
            const zz = Pp[j * 3 + 2] - Pm[j * 3 + 2];
            // normal = along-canyon × along-profile: up on the floor, into the canyon on the walls
            let nx = zy * tz - zz * ty;
            let ny = zz * tx - zx * tz;
            let nz = zx * ty - zy * tx;
            const nl = Math.hypot(nx, ny, nz) || 1;
            nx /= nl;
            ny /= nl;
            nz /= nl;
            const x = P[j * 3];
            const y = P[j * 3 + 1];
            out[o++] = x;
            out[o++] = y;
            out[o++] = z;
            out[o++] = nx;
            out[o++] = ny;
            out[o++] = nz;
            out[o++] = AO[j];
            out[o++] = this.track.sunVis(x + nx * 0.3, y + ny * 0.3, z + nz * 0.3);
        }
        this.version[slot]++;
    }
}

// ---------------------------------------------------------------------------------------------
// quaternions [x, y, z, w]

export const qAxis = (x, y, z, angle) => {
    const s = Math.sin(angle / 2);
    return [x * s, y * s, z * s, Math.cos(angle / 2)];
};
export const qMul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
];
// rotate v by q (or by its inverse)
const qRot = (q, x, y, z, inverse = false) => {
    const qx = inverse ? -q[0] : q[0];
    const qy = inverse ? -q[1] : q[1];
    const qz = inverse ? -q[2] : q[2];
    const qw = q[3];
    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
};
const randomQuat = (rnd) => {
    const u1 = rnd();
    const u2 = rnd() * TAU;
    const u3 = rnd() * TAU;
    const a = Math.sqrt(1 - u1);
    const b = Math.sqrt(u1);
    return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
};
const randomDir = (rnd) => {
    const z = rnd() * 2 - 1;
    const a = rnd() * TAU;
    const s = Math.sqrt(1 - z * z);
    return [s * Math.cos(a), z, s * Math.sin(a)];
};

// ---------------------------------------------------------------------------------------------
// sparks, fire and dust: little lights that live for a moment

export class Sparks {
    constructor(max = MAX_SPARKS) {
        this.max = max;
        this.f = new Float32Array(max * 16);
        this.alive = new Uint8Array(max);
        this.next = 0;
        this.out = new Float32Array(max * SPARK_FLOATS);
        this.count = 0;
    }

    clear() {
        this.alive.fill(0);
    }

    // p, v: position and velocity; life (s); size from s0 to s1; colour; intensity; gravity; drag
    emit(px, py, pz, vx, vy, vz, life, s0, s1, r, g, b, inten, grav = 0, drag = 0) {
        const i = this.next;
        this.next = (i + 1) % this.max;
        const f = this.f;
        const o = i * 16;
        f[o] = px;
        f[o + 1] = py;
        f[o + 2] = pz;
        f[o + 3] = vx;
        f[o + 4] = vy;
        f[o + 5] = vz;
        f[o + 6] = 0;
        f[o + 7] = life;
        f[o + 8] = s0;
        f[o + 9] = s1;
        f[o + 10] = r;
        f[o + 11] = g;
        f[o + 12] = b;
        f[o + 13] = inten;
        f[o + 14] = grav;
        f[o + 15] = drag;
        this.alive[i] = 1;
    }

    update(dt) {
        const { f, alive, out } = this;
        let n = 0;
        for (let i = 0; i < this.max; i++) {
            if (!alive[i]) continue;
            const o = i * 16;
            f[o + 6] += dt;
            const t = f[o + 6] / f[o + 7];
            if (t >= 1) {
                alive[i] = 0;
                continue;
            }
            const k = Math.exp(-f[o + 15] * dt);
            f[o + 3] *= k;
            f[o + 4] = f[o + 4] * k - f[o + 14] * dt;
            f[o + 5] *= k;
            f[o] += f[o + 3] * dt;
            f[o + 1] += f[o + 4] * dt;
            f[o + 2] += f[o + 5] * dt;
            const w = n * SPARK_FLOATS;
            out[w] = f[o];
            out[w + 1] = f[o + 1];
            out[w + 2] = f[o + 2];
            out[w + 3] = lerp(f[o + 8], f[o + 9], t);
            out[w + 4] = f[o + 10];
            out[w + 5] = f[o + 11];
            out[w + 6] = f[o + 12];
            // fade in quickly, out slowly
            out[w + 7] = f[o + 13] * Math.min(1, t * 12) * (1 - t) * (1 - t);
            n++;
        }
        this.count = n;
    }
}

// ---------------------------------------------------------------------------------------------
// the world: terrain, rocks, sparks; spawning and collisions

const CHUNK = 30; // obstacles are laid out chunk by chunk
const SPAWN_AHEAD = 290;
const GRACE = 320; // nothing in the way for the first stretch of a run
const ROCK_KIND = { meteor: 0, pillar: 1, bridge: 1, comet: 2 }; // how world-gl.js shades each

export class World {
    constructor({ canyon = false } = {}) {
        this.canyon = canyon;
        this.terrain = new Terrain();
        this.shapes = getRockShapes();
        this.sparks = new Sparks();
        this.rocks = [];
        this.rockData = Array.from({ length: ROCK_VARIANTS }, () => new Float32Array(MAX_ROCKS * ROCK_FLOATS));
        this.rockCount = new Int32Array(ROCK_VARIANTS);
        this.blobs = new Float32Array(MAX_BLOBS * 4);
        this.tails = new Float32Array(MAX_TAILS * TAIL_FLOATS); // comet tails, drawn as glowing strips
        this.tailCount = 0;
        this.blobCount = 0;
        this.flash = 0; // brief brightening after a big impact
        this.events = [];
        this.reset(1, 0);
    }

    reset(seed, z) {
        this.seed = seed;
        this.rnd = mulberry32(seed * 7 + 3);
        this.track = new Track(seed);
        if (this.canyon) this.terrain.reset(this.track, z);
        this.rocks.length = 0;
        this.sparks.clear();
        this.nextChunk = Math.floor(z / CHUNK) * CHUNK + CHUNK;
        this.spawning = false;
        this.nextComet = Infinity;
        this.lastBridge = -Infinity;
        this.lastGiant = -Infinity;
        this.time = 0;
    }

    // a run starts here: the canyon's difficulty counts from this point, obstacles appear after a grace
    startRun(z) {
        this.track.z0 = z;
        this.spawning = true;
        this.nextChunk = Math.floor((z + GRACE) / CHUNK) * CHUNK;
        this.nextComet = this.time + 14;
    }

    stopSpawning() {
        this.spawning = false;
    }

    // ---- spawning

    spawnChunk(zc, player) {
        const rnd = this.rnd;
        const tr = this.track;
        const d = tr.diff(zc);
        const run = zc - tr.z0;

        const poisson = (mean) => {
            let k = 0;
            let p = Math.exp(-mean);
            let s = p;
            const u = rnd();
            while (u > s && k < 10) {
                k++;
                p *= mean / k;
                s += p;
            }
            return k;
        };
        // a size class (small ones most often), then a size within it: as many near its low end as
        // near its high end
        const sizeClass = () => {
            const u = rnd();
            return u < 0.32 ? 'small' : u < 0.75 ? 'medium' : 'large';
        };
        const size = (cls) => {
            const [k0, k1] = SIZE_CLASSES[cls].k;
            return METEOR_R * k0 * Math.pow(k1 / k0, rnd()) * (1 + 0.1 * d);
        };
        const meteor = (o, cls, r = size(cls)) => {
            const drifting = cls !== 'giant' && rnd() < lerp(0.15, 0.6, d);
            const rock = this.addRock({
                kind: 'meteor',
                variant: pickShape(rnd, SIZE_CLASSES[cls].types),
                vx: drifting ? (rnd() < 0.5 ? -1 : 1) * lerp(1.5, 5.5, rnd()) * (0.5 + d) : 0,
                vy: drifting ? (rnd() - 0.5) * (this.canyon ? 1.5 : 3) : 0,
                sx: r * lerp(0.9, 1.1, rnd()),
                sy: r * lerp(0.9, 1.1, rnd()),
                sz: r * lerp(0.9, 1.1, rnd()),
                q: randomQuat(rnd),
                spin: randomDir(rnd),
                spinRate: 0,
                heat: cls !== 'giant' && rnd() < 0.15 ? lerp(0.25, 0.55, rnd()) : 0,
                ...o
            });
            // small ones tumble quickly, long and big ones slowly
            if (!o.spinRate) rock.spinRate = lerp(0.15, 1.1, rnd()) / Math.sqrt(rock.reach / METEOR_R);
            return rock;
        };

        if (!this.canyon) {
            // now and then a giant: slow, never drifting, seen from far off; the others keep clear of it
            let giant = null;
            if (run > 700 && zc - this.lastGiant > 240 && rnd() < lerp(0.05, 0.09, d)) {
                giant = meteor({ x: (rnd() * 2 - 1) * AREA.x * 0.85, y: (rnd() * 2 - 1) * AREA.y * 0.8, z: zc + rnd() * CHUNK, spinRate: lerp(0.04, 0.12, rnd()) }, 'giant');
                this.lastGiant = giant.z;
            }
            const clearOfGiant = (x, y, z, r) => !giant || Math.hypot(x - giant.x, y - giant.y, z - giant.z) > giant.reach + r * 1.6 + 2;
            // open space: meteors anywhere in (and a little beyond) the flying area; some on the
            // player's own line, so standing still is never safe
            const n = poisson(lerp(0.9, 2.6, d));
            for (let i = 0; i < n; i++) {
                const cls = sizeClass();
                const r = size(cls);
                const aimed = rnd() < lerp(0.25, 0.45, d);
                const x = aimed ? player.x + (rnd() * 2 - 1) * 5 : (rnd() * 2 - 1) * (AREA.x + 4);
                const y = aimed ? player.y + (rnd() * 2 - 1) * 4 : (rnd() * 2 - 1) * (AREA.y + 3);
                const z = zc + rnd() * CHUNK;
                if (!clearOfGiant(x, y, z, r)) continue;
                meteor({ x, y, z }, cls, r);
                // small stones often come with a few companions
                if (cls === 'small' && rnd() < 0.45) {
                    const k = 1 + Math.floor(rnd() * 3);
                    for (let j = 0; j < k; j++) {
                        const [a, b2, c] = randomDir(rnd);
                        const dist = lerp(2.2, 5, rnd());
                        const p = [x + a * dist, y + b2 * dist * 0.8, z + c * dist];
                        if (clearOfGiant(p[0], p[1], p[2], r)) meteor({ x: p[0], y: p[1], z: p[2] }, 'small');
                    }
                }
            }
            // now and then a swarm of small ones
            if (run > 1200 && rnd() < lerp(0.05, 0.16, d)) {
                const cx = (rnd() * 2 - 1) * AREA.x * 0.7;
                const cy = (rnd() * 2 - 1) * AREA.y * 0.7;
                const cz = zc + rnd() * CHUNK;
                const k = 5 + Math.floor(rnd() * 5);
                for (let i = 0; i < k; i++) {
                    const [a, b2, c] = randomDir(rnd);
                    const dist = lerp(2, 9, rnd());
                    const p = [cx + a * dist, cy + b2 * dist * 0.7, cz + c * dist];
                    if (clearOfGiant(p[0], p[1], p[2], METEOR_R)) meteor({ x: p[0], y: p[1], z: p[2] }, rnd() < 0.7 ? 'small' : 'medium');
                }
            }
            return;
        }

        // ---- canyon mode
        // a pillar of rock rising from the floor: go round it
        let pillarZ = -Infinity;
        if (run > 1400 && rnd() < lerp(0.1, 0.38, d)) {
            const z = zc + rnd() * CHUNK;
            const hw = tr.halfWidth(z);
            const r = Math.min(lerp(1.4, 2.8, rnd()), hw * 0.38);
            const x = tr.centerX(z) + (rnd() * 2 - 1) * (hw - r - 1.5);
            this.addRock({ kind: 'pillar', variant: pickShape(rnd, ['crater']), x, y: tr.floorY(z) - 4, z, sx: r, sy: 36, sz: r * lerp(0.8, 1.2, rnd()), q: qAxis(0, 1, 0, rnd() * TAU) });
            pillarZ = z;
        }

        // a natural bridge across the canyon: under it or over it
        if (run > 2600 && zc - this.lastBridge > 170 && Math.abs(zc - pillarZ) > 40 && rnd() < lerp(0.06, 0.16, d)) {
            const z = zc + CHUNK * 0.5;
            const h = lerp(5, 11, rnd());
            const t = lerp(2.0, 3.0, rnd());
            const span = tr.halfWidth(z) + flare(h) + 7;
            this.addRock({ kind: 'bridge', variant: pickShape(rnd, ['crater']), x: tr.centerX(z), y: tr.floorY(z) + h, z, sx: span, sy: t, sz: lerp(4, 6, rnd()), q: qAxis(0, 0, 1, (rnd() - 0.5) * 0.12) });
            this.lastBridge = z;
        }

        // floating meteors, some drifting across
        const n = poisson(lerp(0.55, 2.1, d));
        for (let i = 0; i < n; i++) {
            const z = zc + rnd() * CHUNK;
            if (Math.abs(z - pillarZ) < 8) continue;
            const cls = sizeClass();
            const r = size(cls);
            const h = lerp(MIN_ALT + 0.5, MAX_ALT - 1, rnd());
            const room = Math.max(0, tr.halfWidth(z) + flare(h) - r - 0.8);
            meteor({ x: tr.centerX(z) + (rnd() * 2 - 1) * room, y: tr.floorY(z) + h, z }, cls, r);
        }
    }

    // a comet: an icy head in a glowing coma with a long tail. It shows up far ahead and off to one
    // side (in view from the start), and comes in at a slant to cross the player's line about where
    // the player will be, so it has to be dodged
    spawnComet(player) {
        const rnd = this.rnd;
        const d = this.track.diff(player.z);
        const side = rnd() < 0.5 ? -1 : 1;
        const lx = this.canyon ? 8 : AREA.x;
        const ly = this.canyon ? 6 : AREA.y;
        const cx = this.canyon ? this.track.centerX(player.z) : 0;
        const cy = this.canyon ? player.y : 0;
        const T = lerp(4.0, 3.0, d) * lerp(0.9, 1.1, rnd()); // seconds until it crosses the player's line
        const dz0 = lerp(220, 270, rnd());
        const start = [player.x + side * dz0 * lerp(0.18, 0.38, rnd()), player.y + dz0 * lerp(-0.08, 0.25, rnd()), player.z + dz0];
        const target = [
            clamp(player.x + (rnd() * 2 - 1) * 7, cx - lx * 1.3, cx + lx * 1.3),
            clamp(player.y + (rnd() * 2 - 1) * 5, cy - ly * 1.3, cy + ly * 1.3),
            player.z + player.speed * T
        ];
        const r = lerp(1.8, 3.0, rnd());
        this.addRock({
            kind: 'comet',
            variant: pickShape(rnd, ['potato', 'crater']),
            x: start[0],
            y: start[1],
            z: start[2],
            vx: (target[0] - start[0]) / T,
            vy: (target[1] - start[1]) / T,
            vz: (target[2] - start[2]) / T,
            sx: r,
            sy: r * 0.92,
            sz: r * 1.05,
            q: randomQuat(rnd),
            spin: randomDir(rnd),
            spinRate: 0.8,
            heat: 1
        });
        this.events.push({ type: 'comet', side });
    }

    // ?rocks: the shapes side by side (page 0) or the size classes (page 1), turning slowly in front
    // of the camera. Returns the labels to put under them
    gallery(page) {
        this.rocks.length = 0;
        this.sparks.clear();
        this.spawning = false;
        this.nextComet = Infinity;
        const labels = [];
        const Z = page === 0 ? 30 : 36;
        const put = (variant, x, y, r, turn) =>
            this.addRock({ kind: 'meteor', variant, x, y, z: Z, sx: r, sy: r, sz: r, q: qMul(qAxis(1, 0, 0, 0.45), qAxis(0, 1, 0, turn)), spin: [0, 1, 0], spinRate: 0.3, seed: (variant * 0.618 + 0.13) % 1 });
        if (page === 0) {
            SHAPE_TYPES.forEach((t, ti) => {
                const x = (ti - (SHAPE_TYPES.length - 1) / 2) * 8.2;
                for (let v = 0; v < PER_TYPE; v++) put(ti * PER_TYPE + v, x, 8 - v * 8, 2.3, ti * 1.3 + v * 2.1);
                labels.push({ x, y: -12.6, z: Z, title: t.name, sub: '' });
            });
            return labels;
        }
        const pct = { small: '32%', medium: '43%', large: '25%', giant: 'まれ' };
        const groups = [
            ['small', 0.42, [['shard', -27.5, 1.2], ['potato', -25, -1], ['crater', -22.5, 0.6]]],
            ['medium', 0.85, [['binary', -15, 0], ['long', -9.5, 0]]],
            ['large', 1.5, [['slab', -0.5, 0], ['rubble', 7.5, 0]]],
            ['giant', 2.85, [['rubble', 21, 0]]]
        ];
        let i = 0;
        for (const [cls, k, items] of groups) {
            const c = SIZE_CLASSES[cls];
            for (const [key, x, y] of items) put(shapeIndex(key, i++ % PER_TYPE), x, y, METEOR_R * k, i * 1.7);
            const xs = items.map((it) => it[1]);
            labels.push({ x: (Math.min(...xs) + Math.max(...xs)) / 2, y: -8.5, z: Z, title: c.name, sub: '×' + c.k[0] + '〜' + c.k[1] + '　' + pct[cls] });
        }
        return labels;
    }

    addRock(o) {
        const rock = {
            kind: 'meteor',
            x: 0,
            y: 0,
            z: 0,
            vx: 0,
            vy: 0,
            vz: 0,
            sx: 1,
            sy: 1,
            sz: 1,
            q: [0, 0, 0, 1],
            spin: [0, 1, 0],
            spinRate: 0,
            heat: 0,
            variant: shapeIndex('crater', 0),
            seed: this.rnd(),
            minClear: Infinity,
            done: false,
            ...o
        };
        rock.shadow = this.canyon ? this.track.sunVis(rock.x, rock.y + rock.sy * 0.3, rock.z) : 1;
        // how far from its centre the rock reaches (its shape's furthest point)
        rock.reach = this.shapes[rock.variant].maxR * Math.max(rock.sx, rock.sy, rock.sz);
        this.rocks.push(rock);
        return rock;
    }

    // ---- effects

    burst(x, y, z, opts = {}) {
        const rnd = this.rnd;
        const s = this.sparks;
        const {
            sparks = 40,
            speed = 14,
            debris = 0,
            fire = 0,
            dust = 0,
            flash = 0,
            up = 0,
            color = [1, 0.62, 0.25]
        } = opts;
        if (flash > 0) s.emit(x, y, z, 0, 0, 0, 0.35, flash, flash * 1.6, 1, 0.85, 0.6, 2.4);
        for (let i = 0; i < sparks; i++) {
            const [a, b, c] = randomDir(rnd);
            const v = speed * lerp(0.3, 1, rnd());
            s.emit(x, y, z, a * v, b * v + up, c * v, lerp(0.35, 0.9, rnd()), lerp(0.12, 0.3, rnd()), 0.02, color[0], color[1], color[2], lerp(1.2, 2.4, rnd()), 9, 1.2);
        }
        for (let i = 0; i < fire; i++) {
            const [a, b, c] = randomDir(rnd);
            const v = speed * 0.35 * rnd();
            s.emit(x + a, y + b, z + c, a * v, b * v + up * 0.4, c * v, lerp(0.5, 1.1, rnd()), lerp(1.0, 2.2, rnd()), lerp(2.5, 4.5, rnd()), 1, lerp(0.35, 0.6, rnd()), 0.12, lerp(0.8, 1.4, rnd()), -1.5, 2);
        }
        for (let i = 0; i < debris; i++) {
            const [a, b, c] = randomDir(rnd);
            const v = speed * lerp(0.3, 0.8, rnd());
            s.emit(x, y, z, a * v, Math.abs(b) * v + up, c * v, lerp(0.8, 1.6, rnd()), lerp(0.25, 0.5, rnd()), 0.15, 0.55, 0.32, 0.18, 0.5, 22, 0.4);
        }
        for (let i = 0; i < dust; i++) {
            const [a, , c] = randomDir(rnd);
            const v = speed * 0.4 * rnd();
            s.emit(x + a * 2, y + rnd(), z + c * 2, a * v, lerp(0.5, 3, rnd()), c * v, lerp(1.0, 2.0, rnd()), lerp(1.5, 3, rnd()), lerp(4, 7, rnd()), 0.62, 0.45, 0.32, 0.22, -0.3, 1.5);
        }
    }

    // ---- per frame

    update(dt, player) {
        this.time += dt;
        const tr = this.track;
        if (this.canyon) this.terrain.update(player.z);
        this.flash = Math.max(0, this.flash - dt * 2.5);

        if (this.spawning) {
            while (this.nextChunk < player.z + SPAWN_AHEAD) {
                this.spawnChunk(this.nextChunk, player);
                this.nextChunk += CHUNK;
            }
            if (this.time >= this.nextComet) {
                const d = tr.diff(player.z);
                if (player.z - tr.z0 > 500) this.spawnComet(player);
                this.nextComet = this.time + lerp(15, 7, d) * lerp(0.75, 1.25, this.rnd());
            }
        }

        for (const r of this.rocks) {
            if (r.done) continue;
            if (r.spinRate) r.q = qMul(qAxis(r.spin[0], r.spin[1], r.spin[2], r.spinRate * dt), r.q);
            if (r.kind === 'meteor' && (r.vx || r.vy)) {
                r.x += r.vx * dt;
                r.y += r.vy * dt;
                if (this.canyon) {
                    // drifting meteors bounce off the walls and stay in the flying band
                    const h = r.y - tr.floorY(r.z);
                    const room = tr.halfWidth(r.z) + flare(Math.max(h, 0)) - r.sx;
                    const dx = r.x - tr.centerX(r.z);
                    if ((dx > room && r.vx > 0) || (dx < -room && r.vx < 0)) r.vx = -r.vx;
                    if ((h < 2 && r.vy < 0) || (h > MAX_ALT && r.vy > 0)) r.vy = -r.vy;
                    r.shadow = tr.sunVis(r.x, r.y, r.z);
                } else {
                    // drift back towards the flying area rather than off into the dark
                    if ((r.x > AREA.x + 6 && r.vx > 0) || (r.x < -AREA.x - 6 && r.vx < 0)) r.vx = -r.vx;
                    if ((r.y > AREA.y + 4 && r.vy > 0) || (r.y < -AREA.y - 4 && r.vy < 0)) r.vy = -r.vy;
                }
            } else if (r.kind === 'comet') {
                r.x += r.vx * dt;
                r.y += r.vy * dt;
                r.z += r.vz * dt;
                this.cometTail(r, dt);
                if (Math.abs(r.x - player.x) > 300) r.done = true;
            }
            if (r.z + r.sz < player.z - 40) r.done = true;
        }
        this.rocks = this.rocks.filter((r) => !r.done);
        this.sparks.update(dt);
        this.fillRockData();
    }

    // a comet's light: a coma round the head, a long blue ion tail blown out from it, a shorter
    // warm dust tail and glints of ice. The tail points away from the way it flies, turned towards the
    // side so it is seen in profile even when the comet comes almost straight at the camera
    cometTail(r, dt) {
        const rnd = this.rnd;
        const s = this.sparks;
        const v = Math.hypot(r.vx, r.vy, r.vz) || 1;
        let tx = -r.vx / v;
        let ty = -r.vy / v + 0.12;
        let tz = (-r.vz / v) * 0.2;
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl;
        ty /= tl;
        tz /= tl;
        r.tail = [tx, ty, tz];
        const R = r.sx;
        // coma: travels with the head
        s.emit(r.x, r.y, r.z, r.vx, r.vy, r.vz, 0.14, R * 3.6, R * 3.8, 0.6, 0.82, 1, 1.3, 0, 0);
        s.emit(r.x, r.y, r.z, r.vx, r.vy, r.vz, 0.1, R * 1.6, R * 1.7, 0.9, 0.97, 1, 2.2, 0, 0);
        const jit = () => (rnd() - 0.5) * R * 0.6;
        // ion tail (besides the strip): keeps most of the head's speed and streams out behind it
        for (let i = 0; i < 4; i++) {
            const k = lerp(6, 24, rnd());
            s.emit(
                r.x + jit(),
                r.y + jit(),
                r.z + jit(),
                r.vx * 0.8 + tx * k + (rnd() - 0.5),
                r.vy * 0.8 + ty * k + (rnd() - 0.5),
                r.vz * 0.8 + tz * k + (rnd() - 0.5),
                lerp(1.6, 2.6, rnd()),
                R * lerp(1.0, 1.4, rnd()),
                R * lerp(4, 6, rnd()),
                0.42,
                lerp(0.68, 0.8, rnd()),
                1,
                lerp(0.5, 0.7, rnd()),
                0,
                0
            );
        }
        // dust tail: slower, warmer, spreading and sagging
        for (let i = 0; i < 3; i++) {
            const k = lerp(3, 9, rnd());
            const [a, b, c] = randomDir(rnd);
            s.emit(r.x + jit(), r.y + jit(), r.z + jit(), r.vx * 0.55 + tx * k + a * 2, r.vy * 0.55 + ty * k + b * 2 - 2, r.vz * 0.55 + tz * k + c * 2, lerp(1.0, 1.6, rnd()), R * 1.2, R * 3.5, 1, 0.88, 0.7, 0.26, 0, 0);
        }
        // glints of ice
        for (let i = 0; i < 2; i++) {
            const [a, b, c] = randomDir(rnd);
            s.emit(r.x + a * R, r.y + b * R, r.z + c * R, r.vx * 0.7 + tx * 8 + a * 4, r.vy * 0.7 + ty * 8 + b * 4, r.vz * 0.7 + tz * 8 + c * 4, lerp(0.6, 1.2, rnd()), 0.4, 0.05, 0.8, 0.95, 1, 2.2, 0, 0);
        }
    }

    fillRockData() {
        this.fillTails();
        this.rockCount.fill(0);
        for (const r of this.rocks) {
            const v = r.variant;
            const n = this.rockCount[v];
            if (n >= MAX_ROCKS) continue;
            const a = this.rockData[v];
            const o = n * ROCK_FLOATS;
            a[o] = r.x;
            a[o + 1] = r.y;
            a[o + 2] = r.z;
            a[o + 3] = r.sx;
            a[o + 4] = r.sy;
            a[o + 5] = r.sz;
            a[o + 6] = r.q[0];
            a[o + 7] = r.q[1];
            a[o + 8] = r.q[2];
            a[o + 9] = r.q[3];
            a[o + 10] = r.heat;
            a[o + 11] = r.shadow;
            a[o + 12] = r.seed;
            a[o + 13] = ROCK_KIND[r.kind] ?? 0;
            this.rockCount[v] = n + 1;
        }
    }

    // each comet: a long narrow blue ion tail and a shorter, wider, warmer dust tail that bends
    // back along its path
    fillTails() {
        const a = this.tails;
        let n = 0;
        const put = (r, dir, len, w0, w1, inten, col) => {
            if (n >= MAX_TAILS) return;
            a.set([r.x, r.y, r.z, dir[0] * len, dir[1] * len, dir[2] * len, w0, w1, inten, r.seed * 10 + n, col[0], col[1], col[2], 0], n * TAIL_FLOATS);
            n++;
        };
        for (const r of this.rocks) {
            if (r.kind !== 'comet' || !r.tail) continue;
            const R = r.sx;
            const v = Math.hypot(r.vx, r.vy, r.vz) || 1;
            put(r, r.tail, R * 24, R * 1.8, R * 6, 1.25, [0.42, 0.7, 1.0]);
            const d = [r.tail[0] - (r.vx / v) * 0.6, r.tail[1] - (r.vy / v) * 0.6 - 0.25, r.tail[2] - (r.vz / v) * 0.12];
            const l = Math.hypot(...d) || 1;
            put(r, d.map((x) => x / l), R * 12, R * 2.4, R * 8, 0.75, [1.0, 0.86, 0.64]);
        }
        this.tailCount = n;
    }

    // soft shadows straight down on the floor: the player's and the nearest rocks'
    fillBlobs(player, showPlayer) {
        const b = this.blobs;
        let n = 0;
        if (!this.canyon) {
            this.blobCount = 0;
            return;
        }
        const tr = this.track;
        const add = (x, y, z, r, strength) => {
            if (n >= MAX_BLOBS) return;
            const h = y - tr.floorY(z);
            if (h < 0) return;
            const s = strength * clamp(1 - h / 45, 0, 1);
            if (s <= 0.01) return;
            b[n * 4] = x;
            b[n * 4 + 1] = z;
            b[n * 4 + 2] = r * (1 + h * 0.035);
            b[n * 4 + 3] = s;
            n++;
        };
        if (showPlayer) add(player.x, player.y, player.z, 1.5 * PLAYER_SCALE, 0.75);
        const near = this.rocks
            .filter((r) => r.kind !== 'pillar' && r.kind !== 'bridge' && r.z > player.z - 10 && r.z < player.z + 140)
            .sort((p, q) => p.z - q.z);
        for (const r of near) add(r.x, r.y, r.z, r.sx * 1.15, r.kind === 'comet' ? 0.85 : 0.6);
        this.blobCount = n;
    }

    // ---- collisions

    // ellipsoid test of a sphere of radius pad against a rock: k < 1 inside
    static probe(r, px, py, pz, pad) {
        const l = qRot(r.q, px - r.x, py - r.y, pz - r.z, true);
        const shrink = r.kind === 'meteor' || r.kind === 'comet' ? 0.86 : 0.9; // the bumpy surface is mostly inside
        const ax = r.sx * shrink + pad;
        const ay = r.sy * shrink + pad;
        const az = r.sz * shrink + pad;
        const k = Math.hypot(l[0] / ax, l[1] / ay, l[2] / az);
        return { k, l, ax, ay, az, minAxis: Math.min(ax, ay, az) };
    }

    // a meteor or comet against a sphere of radius pad: how far the sphere is from touching its real
    // shape (negative: touching). Measured along the ray from the rock's centre, then tilted by how
    // much the surface leans there (so a long rock's sloping end is not given a wide margin)
    clearance(r, px, py, pz, pad) {
        const l = qRot(r.q, px - r.x, py - r.y, pz - r.z, true);
        const dist = Math.hypot(l[0], l[1], l[2]);
        if (dist < 1e-6) return -pad;
        const mx = l[0] / r.sx;
        const my = l[1] / r.sy;
        const mz = l[2] / r.sz;
        const ml = Math.hypot(mx, my, mz);
        const s = this.shapes[r.variant].sample(mx / ml, my / ml, mz / ml);
        // the surface along this ray, in world units
        const surf = (s.r * HIT_SHRINK * dist) / ml;
        return (dist - surf) * s.lean - pad;
    }

    // wall limits for the player's body at (y, z): [left, right] x
    wallLimits(y, z) {
        const tr = this.track;
        let lo = -Infinity;
        let hi = Infinity;
        for (const dy of [-0.95 * PLAYER_SCALE, 0, 0.8 * PLAYER_SCALE]) {
            lo = Math.max(lo, tr.wallX(-1, y + dy, z) + PLAYER_HALF_W);
            hi = Math.min(hi, tr.wallX(1, y + dy, z) - PLAYER_HALF_W);
        }
        return [lo, hi];
    }

    // rock collisions and near misses; returns events
    collide(player, invulnerable) {
        const out = [];
        for (const r of this.rocks) {
            if (r.done) continue;
            // how far the rock reaches along z
            const zr = r.kind === 'bridge' ? r.sz : r.kind === 'pillar' ? Math.max(r.sx, r.sz) : r.reach;
            if (Math.abs(r.z - player.z) > zr + PLAYER_PAD + 1) {
                // passed: was it close?
                if (!r.passed && r.z + zr < player.z) {
                    r.passed = true;
                    // comets count from further off: they are fast and bright
                    const near = r.kind === 'comet' ? 4 : 1.8;
                    if (!r.hit && r.minClear < near && r.kind !== 'bridge') out.push({ type: 'near', rock: r, clear: r.minClear });
                }
                continue;
            }
            let clear;
            let g;
            if (r.kind === 'meteor' || r.kind === 'comet') {
                clear = this.clearance(r, player.x, player.y, player.z, PLAYER_PAD);
                // pushed away from the rock's centre
                g = [player.x - r.x, player.y - r.y];
            } else {
                const pr = World.probe(r, player.x, player.y, player.z, PLAYER_PAD);
                clear = (pr.k - 1) * pr.minAxis;
                // push out along the surface normal (in the world)
                g = qRot(r.q, pr.l[0] / (pr.ax * pr.ax), pr.l[1] / (pr.ay * pr.ay), pr.l[2] / (pr.az * pr.az));
            }
            if (clear < r.minClear) r.minClear = clear;
            if (clear < 0 && !r.hit && !invulnerable) {
                r.hit = true;
                const gl = Math.hypot(g[0], g[1]);
                out.push({ type: 'hit', rock: r, nx: gl > 1e-4 ? g[0] / gl : 0, ny: gl > 1e-4 ? g[1] / gl : 1 });
            }
        }
        return out;
    }
}
