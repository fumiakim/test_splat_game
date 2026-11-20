// noise.js — 乱数と滑らかなノイズ（world.js と rock-shapes.js が使う）。

const lerp = (a, b, t) => a + (b - a) * t;

export const mulberry32 = (seed) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const hash3 = (x, y, z, s) => {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x1b873593) ^ Math.imul(s, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
};
const fade = (t) => t * t * (3 - 2 * t);

// smooth noise in [-1, 1]
export const noise3 = (x, y, z, s = 0) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const u = fade(x - xi);
    const v = fade(y - yi);
    const w = fade(z - zi);
    const a = lerp(hash3(xi, yi, zi, s), hash3(xi + 1, yi, zi, s), u);
    const b = lerp(hash3(xi, yi + 1, zi, s), hash3(xi + 1, yi + 1, zi, s), u);
    const c = lerp(hash3(xi, yi, zi + 1, s), hash3(xi + 1, yi, zi + 1, s), u);
    const d = lerp(hash3(xi, yi + 1, zi + 1, s), hash3(xi + 1, yi + 1, zi + 1, s), u);
    return lerp(lerp(a, b, v), lerp(c, d, v), w) * 2 - 1;
};

export const fbm3 = (x, y, z, octaves, s = 0) => {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
        sum += amp * noise3(x, y, z, s + i * 17);
        norm += amp;
        amp *= 0.5;
        x *= 2.03;
        y *= 2.03;
        z *= 2.03;
    }
    return sum / norm;
};
