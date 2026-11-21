// body-shape.js — 自機の当たり判定の形。
//
// スキャン（スプラット）の点のうち、ほぼ不透明なもの（MIN_ALPHA 以上）だけを、静止した姿勢のまま
// 小さな立方体のマス（BODY_CELL）に分け、点が入っているマスごとに小さな球を置く。スキャンの
// まわりの薄いもや（半透明の点）は数えないので、見えている体の輪郭どおりに当たる（後ろから見た
// 輪郭のはみ出しは 1% ほど、最大でも約 0.1 単位）。腕と胴の間、脚の間のすき間は空いたまま。
// 毎フレーム、機体の前傾・バンクに合わせて回す。
// 点の不透明度が読めないときは位置だけで作り、それも読めないときは null（ゲームは 1 つの球で判定）。

export const BODY_CELL = 0.12; // マスの大きさ（ビューアの単位、自機の拡大前。モデルの高さは約 3）
export const BODY_BALL = 0.5; // 球の半径（マスの大きさに対する比）
const MIN_ALPHA = 0.3; // これより薄い点は数えない
const MIN_POINTS = 3; // これより点の少ないマスは無視（漂う小さなゴミ）

const sigmoid = (v) => 1 / (1 + Math.exp(-v));

// the splats' centres (and how opaque each is, when it can be read)
const readPoints = async (res) => {
    const data = res?.gsplatData;
    if (data?.decompress) {
        try {
            const d = await data.decompress();
            const x = d.getProp('x');
            const y = d.getProp('y');
            const z = d.getProp('z');
            const o = d.getProp('opacity');
            if (x && y && z) return { n: d.numSplats, at: (i, k) => (k === 0 ? x[i] : k === 1 ? y[i] : z[i]), alpha: o ? (i) => sigmoid(o[i]) : null };
        } catch {
            // fall back to the centres alone
        }
    }
    let c = res?.centers ?? null;
    if (!c && data?.generateCenters && data?.getCenters) {
        await data.generateCenters();
        c = data.getCenters();
    }
    if (!c || c.length < 3) return null;
    return { n: Math.floor(c.length / 3), at: (i, k) => c[i * 3 + k], alpha: null };
};

// comp: the model's gsplat component. base: its own position / rotation / scale before the game
// turned it. pivot: the model's centre (viewer world). Returns { pts: Float32Array [x, y, z]
// relative to the pivot (viewer axes, unscaled), n, cell } or null
export const buildBody = async (comp, base, pivot) => {
    const src = await readPoints(comp?.resource);
    if (!src) return null;

    const [qx, qy, qz, qw] = base.q;
    const [sx, sy, sz] = base.s;
    const [px, py, pz] = base.p;
    const cell = BODY_CELL;
    const cells = new Map();
    const OFF = 512;
    for (let i = 0; i < src.n; i++) {
        if (src.alpha && src.alpha(i) < MIN_ALPHA) continue;
        // the point where it stands at rest, relative to the model's centre
        const vx = src.at(i, 0) * sx;
        const vy = src.at(i, 1) * sy;
        const vz = src.at(i, 2) * sz;
        const tx = 2 * (qy * vz - qz * vy);
        const ty = 2 * (qz * vx - qx * vz);
        const tz = 2 * (qx * vy - qy * vx);
        const x = px + vx + qw * tx + (qy * tz - qz * ty) - pivot[0];
        const y = py + vy + qw * ty + (qz * tx - qx * tz) - pivot[1];
        const z = pz + vz + qw * tz + (qx * ty - qy * tx) - pivot[2];
        const key = Math.floor(x / cell) + OFF + 1024 * (Math.floor(y / cell) + OFF + 1024 * (Math.floor(z / cell) + OFF));
        let e = cells.get(key);
        if (!e) {
            e = [0, 0, 0, 0];
            cells.set(key, e);
        }
        e[0] += x;
        e[1] += y;
        e[2] += z;
        e[3]++;
    }
    // enough points, and not alone (a lone cell is a stray speck)
    const full = (k) => (cells.get(k)?.[3] ?? 0) >= MIN_POINTS;
    const keep = [];
    for (const [k, e] of cells) {
        if (e[3] < MIN_POINTS) continue;
        let near = 0;
        for (const d of [1, -1, 1024, -1024, 1024 * 1024, -1024 * 1024]) if (full(k + d)) near++;
        if (near === 0) continue;
        keep.push(e[0] / e[3], e[1] / e[3], e[2] / e[3]);
    }
    if (!keep.length) return null;
    return { pts: new Float32Array(keep), n: keep.length / 3, cell };
};
