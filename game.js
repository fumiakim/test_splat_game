// game.js — METEOR CANYON
//
// ガウシアンスプラットのガンプラを操り、奥へ奥へと飛ぶ。レースゲームのように、カメラは機体の後ろから
// 進行方向（奥）を見る。シーンはタイトル画面で切り替える（← → / ◀ ▶）:
//   隕石帯   — 宇宙空間で隕石と彗星をかわす
//   要塞の溝 — 巨大な宇宙要塞の表面の溝。曲がりくねって狭い溝を、壁や障害物に触れずに飛ぶ
// URL に ?scene=trench / ?scene=space を付けるとそのシーンで始まる。?canyon は以前の渓谷モード。
// URL に ?rocks を付けると、隕石の形と大きさの見本（ギャラリー）になる。Space / クリックでページ切り替え。
//
//   ← → / A D   左右        ↑ ↓ / W S   上下
//   Space       ブースト（長押し。ゲージを使う）
//   P / Esc     ポーズ       M   音のオン・オフ
//   タッチ: 画面をドラッグして移動、BOOST ボタンで加速。ゲームパッドも使える。
//
// 仕組み
//  - ビューア（index.js）はそのまま使い、毎フレームそのカメラをゲームが置き直す（app の 'update'
//    で、ビューア自身のカメラ処理のあと）。スプラットのモデルは原点に置いたまま、向き（前傾・バンク）
//    だけを変える。動くのは世界のほう: ゲーム座標（x 右, y 上, z 奥）の地形と岩を、プレイヤーの
//    位置を引いてビューアの座標に写す（game.fx.G）。
//  - 地形と岩は space-fx.js の 2 枚のキャンバス（モデルの奥と手前）に world-gl.js が描く。

import { createFx, readBounds } from './space-fx.js';
import { World, UNIT_M, MIN_ALT, MAX_ALT, RINGS_BEHIND, PLAYER_SCALE, PLAYER_HALF_W, PLAYER_PAD, AREA, SUN, qAxis, qMul } from './world.js';
import { createSplatLight, SPLAT_LIGHT } from './splat-light.js';
import { buildBody, BODY_BALL } from './body-shape.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';

const TUNE = {
    speed: [24, 44], // 前進速度（単位/秒）: 開始時 → 最高難度
    boostMul: 1.45,
    boostDrain: 0.34, // ブーストゲージの減り（/秒）
    boostRegen: 0.1,
    boostMin: 0.12, // これだけ溜まっていないとブーストを始められない
    latMax: 18, // 左右の最高速度
    vertMax: 11, // 上下の最高速度
    steer: 5.5, // 操作への追従の速さ
    hp: 3,
    inv: 1.6, // 被弾後の無敵時間（秒）
    sector: 1200, // セクターの長さ（単位）
    lean: 32, // 飛行中の前傾（度）
    titleLean: 14,
    bank: 34, // 左右移動中のバンク（度）
    yaw: 12, // 左右移動中に進む向きへ体をひねる（度）
    pitch: 14, // 上下移動中の前傾の増減（度）
    // カメラ（自機を PLAYER_SCALE 倍に描くので、それに合わせた距離）
    cam: { back: 10.5, up: 3.9, ahead: 18, lookUp: 2.0, lagX: 3.2, lagY: 2.4, fov: 56 },
    title: { az: 2.45, radius: 12.5, up: 0.9, lookUp: 0.3, fov: 46 }
};

const PARAMS = new URL(location.href).searchParams;
const GALLERY = PARAMS.has('rocks');
const HITBOX = PARAMS.has('hitbox'); // 自機の当たり判定の球を光の点で見せる

// the scenes: name on the title, subtitle, sector names
const SCENES = {
    space: {
        name: '隕石帯',
        en: 'ASTEROID FIELD',
        sub: '隕石と彗星をかわして、どこまでも翔べ',
        sectors: ['隕石帯突入', '小惑星群', '彗星の通り道', '岩塊の嵐', '流星群', '深宇宙へ']
    },
    trench: {
        name: '要塞の溝',
        en: 'FORTRESS TRENCH',
        sub: '巨大要塞の溝を、壁に触れずに翔け抜けろ',
        sectors: ['要塞外壁へ', '第一の溝', '狭窄区画', '梁の回廊', '蛇行区画', '隔壁地帯', '最深部へ']
    },
    canyon: {
        name: '渓谷',
        en: 'CANYON',
        sub: '渓谷の岩壁と隕石をかわして、どこまでも翔べ',
        sectors: ['渓谷突入', '隕石帯', '岩柱の森', '天然の岩橋', '流星雨', '狭き峡谷', '深淵へ']
    }
};
const SCENE_ORDER = PARAMS.has('canyon') ? ['space', 'trench', 'canyon'] : ['space', 'trench'];
const firstScene = () => {
    if (GALLERY) return 'space';
    if (PARAMS.has('canyon')) return 'canyon';
    const s = PARAMS.get('scene');
    if (s && SCENES[s]) return s;
    try {
        const v = localStorage.getItem('meteor-canyon-scene');
        if (SCENE_ORDER.includes(v)) return v;
    } catch {
        // not remembered
    }
    return 'space';
};

const MODEL_FALLBACK = { center: [-0.0045, 0.071, 0.032], halfExt: [1.02, 1.48, 0.44] };
const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (t) => t * t * (3 - 2 * t);

// column-major 3x3 rotation matrix of a unit quaternion
const qMat3 = ([x, y, z, w], out) => {
    out[0] = 1 - 2 * (y * y + z * z);
    out[1] = 2 * (x * y + z * w);
    out[2] = 2 * (x * z - y * w);
    out[3] = 2 * (x * y - z * w);
    out[4] = 1 - 2 * (x * x + z * z);
    out[5] = 2 * (y * z + x * w);
    out[6] = 2 * (x * z + y * w);
    out[7] = 2 * (y * z - x * w);
    out[8] = 1 - 2 * (x * x + y * y);
    return out;
};

// camera world matrix (column-major), the same construction as the engine's lookAt
const lookAt = (eye, target, up, out) => {
    let zx = eye[0] - target[0];
    let zy = eye[1] - target[1];
    let zz = eye[2] - target[2];
    let l = Math.hypot(zx, zy, zz) || 1;
    zx /= l;
    zy /= l;
    zz /= l;
    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz) || 1;
    xx /= l;
    xy /= l;
    xz /= l;
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    out.set([xx, xy, xz, 0, yx, yy, yz, 0, zx, zy, zz, 0, eye[0], eye[1], eye[2], 1]);
};

// ---------------------------------------------------------------------------------------------
// input: keyboard, a drag anywhere (touch or mouse) as a stick, a gamepad

const STEER = {
    ArrowLeft: [-1, 0],
    KeyA: [-1, 0],
    ArrowRight: [1, 0],
    KeyD: [1, 0],
    ArrowUp: [0, 1],
    KeyW: [0, 1],
    ArrowDown: [0, -1],
    KeyS: [0, -1]
};
const GAME_KEYS = new Set([...Object.keys(STEER), 'Space', 'Enter', 'KeyP', 'Escape', 'KeyM', 'ShiftLeft', 'ShiftRight']);

const createInput = (hud, onPress) => {
    const keys = new Set();
    const ptr = { id: null, x0: 0, y0: 0, x: 0, y: 0 };
    let boostPtr = null;
    let padPrev = [false, false];
    let stickShown = false;

    window.addEventListener(
        'keydown',
        (e) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            // none of the viewer's own shortcuts: the camera belongs to the game
            e.stopImmediatePropagation();
            if (!GAME_KEYS.has(e.code)) return;
            e.preventDefault();
            if (!e.repeat) onPress(e.code);
            keys.add(e.code);
        },
        { capture: true }
    );
    window.addEventListener(
        'keyup',
        (e) => {
            e.stopImmediatePropagation();
            keys.delete(e.code);
        },
        { capture: true }
    );
    const release = () => {
        keys.clear();
        ptr.id = null;
        boostPtr = null;
        hud.el.boostbtn.classList.remove('is-down');
    };
    window.addEventListener('blur', () => {
        release();
        onPress('blur');
    });
    document.addEventListener('visibilitychange', () => {
        release();
        if (document.hidden) onPress('blur');
    });

    const root = hud.root;
    root.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.mc-mute')) {
            onPress('KeyM');
            return;
        }
        const sceneBtn = e.target.closest('[data-scene]');
        if (sceneBtn) {
            onPress(sceneBtn.dataset.scene === '-1' ? 'ScenePrev' : 'SceneNext');
            return;
        }
        if (e.target.closest('.mc-boost-btn')) {
            boostPtr = e.pointerId;
            hud.el.boostbtn.classList.add('is-down');
            onPress('boost');
            return;
        }
        onPress('pointer');
        if (ptr.id === null) {
            ptr.id = e.pointerId;
            ptr.x0 = ptr.x = e.clientX;
            ptr.y0 = ptr.y = e.clientY;
        }
    });
    root.addEventListener('pointermove', (e) => {
        if (e.pointerId !== ptr.id) return;
        ptr.x = e.clientX;
        ptr.y = e.clientY;
    });
    const up = (e) => {
        if (e.pointerId === ptr.id) ptr.id = null;
        if (e.pointerId === boostPtr) {
            boostPtr = null;
            hud.el.boostbtn.classList.remove('is-down');
        }
    };
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    root.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });

    return {
        read() {
            let x = 0;
            let y = 0;
            for (const k of keys) {
                const s = STEER[k];
                if (s) {
                    x += s[0];
                    y += s[1];
                }
            }
            x = clamp(x, -1, 1);
            y = clamp(y, -1, 1);
            let boost = keys.has('Space') || keys.has('ShiftLeft') || keys.has('ShiftRight') || boostPtr !== null;

            if (ptr.id !== null) {
                const s = Math.min(innerWidth, innerHeight) * 0.11;
                let sx = (ptr.x - ptr.x0) / s;
                let sy = -(ptr.y - ptr.y0) / s;
                const l = Math.hypot(sx, sy);
                if (l > 1) {
                    sx /= l;
                    sy /= l;
                    // pulled past the rim: the centre follows the finger
                    ptr.x0 = ptr.x - sx * s;
                    ptr.y0 = ptr.y + sy * s;
                }
                x = sx;
                y = sy;
                hud.stick(true, ptr.x0, ptr.y0, sx, sy);
                stickShown = true;
            } else if (stickShown) {
                hud.stick(false);
                stickShown = false;
            }

            const pads = navigator.getGamepads?.() ?? [];
            for (const pad of pads) {
                if (!pad) continue;
                const dz = (v) => (Math.abs(v) < 0.18 ? 0 : v);
                const ax = dz(pad.axes[0] ?? 0);
                const ay = dz(pad.axes[1] ?? 0);
                if (ax || ay) {
                    x = ax;
                    y = -ay;
                }
                const b = (i) => !!pad.buttons[i]?.pressed;
                if (b(14)) x = -1;
                if (b(15)) x = 1;
                if (b(12)) y = 1;
                if (b(13)) y = -1;
                if (b(0) || b(5) || b(7)) boost = true;
                const now = [b(0), b(9)];
                if (now[0] && !padPrev[0]) onPress('PadA');
                if (now[1] && !padPrev[1]) onPress('PadStart');
                padPrev = now;
                break;
            }
            return { x, y, boost };
        }
    };
};

// ---------------------------------------------------------------------------------------------

// best scores, one per scene (the asteroid field keeps the key it always had)
const bestKey = (scene) => (scene === 'space' ? 'meteor-canyon-best' : `meteor-canyon-best-${scene}`);
const loadBest = (scene) => {
    try {
        return Number(localStorage.getItem(bestKey(scene))) || 0;
    } catch {
        return 0;
    }
};
const saveBest = (scene, v) => {
    try {
        localStorage.setItem(bestKey(scene), String(Math.floor(v)));
    } catch {
        // not remembered: fine
    }
};

const createGame = () => {
    const touch = window.matchMedia?.('(hover: none)').matches || navigator.maxTouchPoints > 0;
    let scene = firstScene();
    const hud = createHud({ touch, subtitle: SCENES[scene].sub });
    // (?.: right after an update a browser may still hold an older cached file for a few minutes)
    hud.setScene?.(SCENES[scene], !GALLERY);
    const audio = createAudio();
    const world = new World({ mode: scene });
    // the trench's measures (from world.js, through the world so a stale cached copy cannot break
    // the import)
    const TRENCH = world.trenchSpec ?? { floor: -9, depth: 26, ledge: 0.55, speed: [44, 66] };
    // how fast the player can move sideways (quicker in the trench, where it flies faster)
    const latMax = () => (scene === 'trench' ? TRENCH.latMax ?? TUNE.latMax : TUNE.latMax);
    const light = createSplatLight(); // the model's lighting (sun, thrusters, comets, hits)

    const fx = {
        offset: new Float32Array(3), // how far the space has streamed past (viewer axes, model radii)
        vel: new Float32Array(3), // ... and how fast (viewer world units / s)
        rotMat: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
        thrust: 0,
        sprint: 0,
        G: new Float64Array(16), // game coordinates → viewer world
        camG: new Float32Array(3), // camera position in game coordinates
        flash: 0,
        fadeRange: [230, 292], // the canyon fades into the backdrop between these distances
        scale: PLAYER_SCALE // the model is drawn this much larger than scanned
    };
    const game = {
        state: 'loading',
        world,
        model: { center: [...MODEL_FALLBACK.center], halfExt: [...MODEL_FALLBACK.halfExt] },
        vfov: 50,
        camWorld: new Float32Array(16),
        fx
    };

    let best = loadBest(scene);
    hud.setBest(best);
    hud.setMuted(audio.muted);

    const TITLE_BEHIND = 100; // rings kept behind the player while the title camera looks back
    const p = { x: 0, y: 0, z: 0, vx: 0, vy: 0, speed: 0, hp: TUNE.hp, inv: 0, boost: 1, boosting: false, slow: 1, alive: true };
    const run = { z0: 0, z1: null, score: 0, near: 0, combo: 0, comboT: 0, sector: 1 }; // z1: where it ended
    const rail = { x: 0, y: 0 };
    const pose = { lean: TUNE.titleLean * DEG, bank: 0, yaw: 0, sprint: 0, wobble: 0 };
    const rot = { q: [0, 0, 0, 1] };
    let time = 0;
    let camBlend = 0; // 0: the title view in front of the model, 1: chasing it from behind
    let heading = 0; // the trench's direction where the player is (radians, + towards +x)
    let countdown = 0;
    let lastCount = 0;
    let stateT = 0;
    let shake = 0;
    let white = 0;
    let resetT = 0;
    let paused = null; // the state to go back to
    let app = null;
    let camEntity = null;
    let splat = null;
    let base = null;
    // the player's shape for hits: balls built from the scan's points (body-shape.js)
    let gsComp = null;
    let body = null;
    let bodyState = 'none';
    const bodyWorld = { pts: null, n: 0, R: 0 };
    // the balls where the model stands now (turned and enlarged with it), in game coordinates
    const updateBody = () => {
        if (!body) return null;
        if (!bodyWorld.pts) bodyWorld.pts = new Float32Array(body.n * 4);
        const m = fx.rotMat;
        const ks = fx.scale;
        const rad = body.cell * BODY_BALL * ks;
        const out = bodyWorld.pts;
        let R = 0;
        for (let i = 0; i < body.n; i++) {
            const x = body.pts[i * 3] * ks;
            const y = body.pts[i * 3 + 1] * ks;
            const z = body.pts[i * 3 + 2] * ks;
            const vx = m[0] * x + m[3] * y + m[6] * z;
            const vy = m[1] * x + m[4] * y + m[7] * z;
            const vz = m[2] * x + m[5] * y + m[8] * z;
            // viewer axes → game axes: x flips
            out[i * 4] = p.x - vx;
            out[i * 4 + 1] = p.y + vy;
            out[i * 4 + 2] = p.z + vz;
            out[i * 4 + 3] = rad;
            R = Math.max(R, Math.hypot(vx, vy, vz) + rad);
        }
        bodyWorld.n = body.n;
        bodyWorld.R = R;
        return bodyWorld;
    };

    const edge = { l: 0, r: 0, t: 0, b: 0 }; // pressing against the edge of the flying area
    const placePlayer = (z) => {
        const tr = world.track;
        p.z = z;
        p.x = scene === 'space' ? 0 : tr.centerX(z + (scene === 'trench' ? 6 : 25));
        p.y = scene === 'space' ? 0 : tr.floorY(z) + (scene === 'trench' ? 9 : 6);
        p.vx = 0;
        p.vy = 0;
        rail.x = p.x;
        rail.y = p.y;
    };

    const newWorld = () => {
        world.terrain.behindTarget = camBlend < 0.5 ? TITLE_BEHIND : RINGS_BEHIND;
        world.reset((Math.random() * 2 ** 31) | 0, 0);
        placePlayer(0);
        p.speed = 12;
    };
    newWorld();

    // the title's scene select
    const switchScene = (dir) => {
        const i = SCENE_ORDER.indexOf(scene);
        scene = SCENE_ORDER[(i + dir + SCENE_ORDER.length) % SCENE_ORDER.length];
        try {
            localStorage.setItem('meteor-canyon-scene', scene);
        } catch {
            // not remembered: fine
        }
        world.setMode(scene);
        newWorld();
        hud.setScene?.(SCENES[scene]);
        best = loadBest(scene);
        hud.setBest(best);
        audio.beep(false);
    };

    const setSplatVisible = (v) => {
        if (splat) splat.enabled = v;
    };

    // ---- ?rocks: a gallery of the meteors' shapes and sizes
    const gallery = { page: 0, labels: [], els: [], root: null };
    const GALLERY_PAGES = [
        ['隕石の形　7 種類 × 各 3 個', 'じゃがいも型・細長い型・双子型・平たい板状・角ばった破片・クレーター型・ごつごつ塊　／　Space・クリックで「大きさ」へ'],
        ['隕石の大きさ　4 階級', '倍率は基準の大きさ（これまでの標準の隕石）に対して。％は出てくる割合、巨大岩はときどき　／　Space・クリックで「形」へ']
    ];
    const showGallery = (page) => {
        gallery.page = page;
        gallery.labels = world.gallery(page);
        if (!gallery.root) {
            gallery.root = document.createElement('div');
            gallery.root.className = 'mc-gal mc-jp';
            hud.root.append(gallery.root);
        }
        const [head, sub] = GALLERY_PAGES[page];
        gallery.root.innerHTML = '<div class="mc-gal-head">' + head + '<small>' + sub + '</small></div>';
        gallery.els = gallery.labels.map((l) => {
            const el = document.createElement('div');
            el.className = 'mc-gal-label';
            el.innerHTML = l.title + (l.sub ? '<small>' + l.sub + '</small>' : '');
            gallery.root.append(el);
            return el;
        });
    };
    // game coordinates → CSS pixels, through the camera set up in updateCamera
    const toScreen = (x, y, z) => {
        const C = game.model.center;
        const m = game.camWorld;
        const vx = C[0] - (x - p.x) - m[12];
        const vy = C[1] + (y - p.y) - m[13];
        const vz = C[2] + (z - p.z) - m[14];
        const cx = vx * m[0] + vy * m[1] + vz * m[2];
        const cy = vx * m[4] + vy * m[5] + vz * m[6];
        const cz = -(vx * m[8] + vy * m[9] + vz * m[10]);
        const t = Math.tan((game.vfov * DEG) / 2);
        const aspect = innerWidth / Math.max(1, innerHeight);
        return [(cx / (cz * t * aspect) * 0.5 + 0.5) * innerWidth, (0.5 - (cy / (cz * t)) * 0.5) * innerHeight];
    };
    const placeGalleryLabels = () => {
        gallery.labels.forEach((l, i) => {
            const [sx, sy] = toScreen(l.x, l.y, l.z);
            gallery.els[i].style.left = sx.toFixed(1) + 'px';
            gallery.els[i].style.top = sy.toFixed(1) + 'px';
        });
    };

    // ---- states

    const setState = (s) => {
        game.state = s;
        stateT = 0;
        hud.setScreen(s === 'dying' ? 'play' : s);
    };

    const startRun = () => {
        world.startRun(p.z);
        run.z0 = p.z;
        run.z1 = null;
        run.score = 0;
        run.near = 0;
        run.combo = 0;
        run.comboT = 0;
        run.sector = 1;
        p.hp = TUNE.hp;
        p.inv = 0;
        p.boost = 1;
        p.boosting = false;
        p.slow = 1;
        p.alive = true;
        countdown = 3;
        lastCount = 4;
        setState('countdown');
    };

    const retry = () => {
        hud.fade(true);
        resetT = 0.32;
    };

    const die = () => {
        p.alive = false;
        run.z1 = p.z;
        p.boosting = false;
        world.burst(p.x, p.y, p.z, { sparks: 200, speed: 32, debris: 70, fire: 44, flash: 24, up: 2 });
        world.burst(p.x, p.y, p.z, { sparks: 70, speed: 15, color: [0.6, 0.85, 1] });
        world.stopSpawning();
        white = 0.85;
        shake = 1.6;
        audio.explode();
        setSplatVisible(false);
        setState('dying');
    };

    const gameOver = () => {
        const newRecord = run.score > best && run.score > 0;
        if (newRecord) {
            best = Math.floor(run.score);
            saveBest(scene, best);
        }
        hud.gameOver({ score: run.score, best, newRecord, distM: (run.z1 - run.z0) * UNIT_M, nearMisses: run.near });
        setState('over');
    };

    const onPress = (code) => {
        if (code !== 'blur') audio.unlock();
        if (code === 'KeyM') hud.setMuted(audio.toggleMute());
        const go = ['Space', 'Enter', 'pointer', 'PadA', 'boost'].includes(code);
        switch (game.state) {
            case 'gallery':
                if (go) showGallery((gallery.page + 1) % GALLERY_PAGES.length);
                break;
            case 'loading':
            case 'title':
                if (code === 'ScenePrev' || code === 'ArrowLeft' || code === 'KeyA') switchScene(-1);
                else if (code === 'SceneNext' || code === 'ArrowRight' || code === 'KeyD') switchScene(1);
                else if (go && app) startRun();
                break;
            case 'over':
                if (go && stateT > 0.8 && resetT <= 0) retry();
                break;
            case 'countdown':
            case 'play':
                if (['KeyP', 'Escape', 'PadStart', 'blur'].includes(code)) {
                    paused = game.state;
                    setState('pause');
                }
                break;
            case 'pause':
                if (['KeyP', 'Escape', 'PadStart', 'Space', 'Enter', 'pointer', 'PadA'].includes(code)) {
                    const back = paused;
                    paused = null;
                    game.state = back;
                    hud.setScreen(back);
                }
                break;
        }
    };
    const input = createInput(hud, onPress);

    // ---- flying

    // metal: struck the fortress (its clang is played by the caller instead of the thud)
    const damage = (metal = false) => {
        if (p.inv > 0 || !p.alive) return;
        p.hp -= 1;
        p.inv = TUNE.inv;
        p.slow = 0.6;
        shake = Math.max(shake, 0.9);
        pose.wobble = 1;
        run.combo = 0;
        hud.hit();
        if (!metal) audio.hit();
        light.hit();
        if (p.hp <= 0) die();
    };

    // the fortress is metal: a high clang (softer while still shielded from the last hit); the canyon's
    // rock: a scrape and a thud. (audio.clang may be missing from a stale cached audio.js)
    const clang = (hurts) => {
        if (audio.clang) audio.clang(hurts && p.inv <= 0 ? 1 : 0.5);
        else audio.scrape();
    };
    const grazeSound = () => (scene === 'trench' && audio.screech ? audio.screech() : audio.scrape());
    const wallHit = (side, damaging) => {
        world.burst(p.x + side * PLAYER_HALF_W, p.y - 0.5, p.z + 1.2, { sparks: 26, speed: 11, debris: 6, color: [1, 0.75, 0.4] });
        if (scene === 'trench') {
            clang(damaging);
            if (damaging) damage(true);
        } else {
            audio.scrape();
            if (damaging) damage();
        }
    };

    // open space: the flying area is a box; its edge stops the player (no damage) and glows
    const areaLimit = () => {
        edge.l = edge.r = edge.t = edge.b = 0;
        if (p.x < -AREA.x) {
            p.x = -AREA.x;
            if (p.vx < 0) p.vx = 0;
            edge.l = 1;
        } else if (p.x > AREA.x) {
            p.x = AREA.x;
            if (p.vx > 0) p.vx = 0;
            edge.r = 1;
        }
        if (p.y < -AREA.y) {
            p.y = -AREA.y;
            if (p.vy < 0) p.vy = 0;
            edge.b = 1;
        } else if (p.y > AREA.y) {
            p.y = AREA.y;
            if (p.vy > 0) p.vy = 0;
            edge.t = 1;
        }
    };

    // the trench: stay below its rim; its walls (and its floor) push back, and the walls hurt
    const trenchCollide = (inp, damaging) => {
        const tr = world.track;
        const ceil = TRENCH.floor + TRENCH.depth - 4;
        if (p.y > ceil) {
            p.y = ceil;
            if (p.vy > 0) p.vy = 0;
        }
        const b = updateBody();
        const c = b ? world.trenchContact(b.pts, b.n) : world.trenchContact([p.x, p.y - 2, p.z, PLAYER_HALF_W, p.x, p.y + 1, p.z, PLAYER_HALF_W], 2);
        // the floor and the walls count once the body is in by more than the tolerance; a lighter
        // touch only throws sparks off them
        const tol = world.hitTolerance ?? 0;
        const floorSparks = (n, up) => {
            for (let k = 0; k < n; k++) {
                world.sparks.emit(p.x + (Math.random() - 0.5) * 2.5, TRENCH.floor + 0.2, p.z + 0.5, (Math.random() - 0.5) * 6, up * (0.5 + Math.random()), -p.speed * 0.25, 0.4, 0.15, 0.03, 1, 0.75, 0.4, 2.0, 9, 1.2);
            }
        };
        if (c.floor > tol) {
            // struck the floor: thrown back up, and it hurts
            p.y += c.floor + 0.2;
            p.vy = Math.max(p.vy, 0) + 7;
            world.burst(p.x, TRENCH.floor + 0.3, p.z + 0.8, { sparks: 26, speed: 11, debris: 6, color: [1, 0.75, 0.4], up: 3 });
            clang(damaging);
            if (damaging) damage(true);
        } else if (c.floor > 0) {
            // skimming it: sparks off the plating
            if (Math.random() < 0.6) floorSparks(1, 4);
            if (time - lastGraze > 0.3) {
                lastGraze = time;
                grazeSound();
            }
        }
        if (c.left > tol && c.right > tol) {
            p.x = tr.centerX(p.z);
            wallHit(c.left > c.right ? -1 : 1, damaging);
        } else if (c.left > tol) {
            p.x += c.left / c.cos + 0.25;
            p.vx = Math.max(p.vx, 0) + 8;
            wallHit(-1, damaging);
        } else if (c.right > tol) {
            p.x -= c.right / c.cos + 0.25;
            p.vx = Math.min(p.vx, 0) - 8;
            wallHit(1, damaging);
        } else if (c.left > 0 || c.right > 0) {
            const side = c.left > c.right ? -1 : 1;
            if (Math.random() < 0.5) {
                world.sparks.emit(p.x + side * 1.9, p.y + (Math.random() - 0.5) * 3, p.z + 0.8, -side * (2 + Math.random() * 4), (Math.random() - 0.5) * 4, -p.speed * 0.3, 0.35, 0.14, 0.03, 1, 0.8, 0.5, 2.0, 6, 1.2);
            }
            if (time - lastGraze > 0.3) {
                lastGraze = time;
                grazeSound();
            }
        }
    };
    let lastGraze = -1;

    const terrainCollide = (inp, damaging) => {
        if (scene === 'space') {
            areaLimit();
            return;
        }
        if (scene === 'trench') {
            trenchCollide(inp, damaging);
            return;
        }
        const tr = world.track;
        const ground = tr.groundY(p.x, p.z) + MIN_ALT;
        if (p.y < ground) {
            p.y = ground;
            if (p.vy < 0) p.vy = 0;
            // skimming the floor kicks up dust
            if (inp.y < -0.3 && Math.random() < 0.5) {
                world.sparks.emit(p.x + (Math.random() - 0.5) * 1.5, ground - MIN_ALT + 0.3, p.z + 0.5, (Math.random() - 0.5) * 4, 2 + Math.random() * 3, -p.speed * 0.3, 0.8, 1.2, 4, 0.7, 0.52, 0.36, 0.25, -0.5, 1.5);
            }
        }
        const ceil = tr.floorY(p.z) + MAX_ALT;
        if (p.y > ceil) {
            p.y = ceil;
            if (p.vy > 0) p.vy = 0;
        }
        const [lo, hi] = world.wallLimits(p.y, p.z);
        if (lo > hi) {
            p.x = (lo + hi) / 2;
        } else if (p.x < lo) {
            p.x = lo + 0.25;
            p.vx = Math.max(p.vx, 0) + 8;
            wallHit(-1, damaging);
        } else if (p.x > hi) {
            p.x = hi - 0.25;
            p.vx = Math.min(p.vx, 0) - 8;
            wallHit(1, damaging);
        }
    };

    const fly = (dt, inp, live) => {
        const tr = world.track;
        const d = tr.diff(p.z);
        const sp = scene === 'trench' ? TRENCH.speed : TUNE.speed;
        const cruise = lerp(sp[0], sp[1], d);
        p.boosting = live && inp.boost && p.boost > (p.boosting ? 0.002 : TUNE.boostMin);
        p.boost = clamp(p.boost + (p.boosting ? -TUNE.boostDrain : TUNE.boostRegen) * dt, 0, 1);
        p.slow = Math.min(1, p.slow + dt * 0.45);
        const target = cruise * (p.boosting ? TUNE.boostMul : 1) * p.slow * (live ? 1 : 0.75);
        p.speed += (target - p.speed) * (1 - Math.exp(-dt * (p.boosting ? 2.2 : 1.2)));
        const k = 1 - Math.exp(-dt * (scene === 'trench' ? TRENCH.steer ?? TUNE.steer : TUNE.steer));
        p.vx += (inp.x * latMax() - p.vx) * k;
        p.vy += (inp.y * TUNE.vertMax - p.vy) * k;
        // in the trench the model follows part of its bends by itself; the rest is the player's
        p.follow = scene === 'trench' ? (TRENCH.follow ?? 0) * tr.slope(p.z) * p.speed : 0;
        p.x += (p.vx + p.follow) * dt;
        p.y += p.vy * dt;
        const dz = p.speed * dt;
        p.z += dz;
        p.inv = Math.max(0, p.inv - dt);

        terrainCollide(inp, live);
        world.update(dt, p);

        for (const ev of world.collide(p, p.inv > 0 || !live, updateBody())) {
            if (ev.type === 'hit') {
                const r = ev.rock;
                p.x += ev.nx * 2;
                p.y += ev.ny * 2;
                p.vx = ev.nx * 12;
                p.vy = ev.ny * 9;
                // sparks where it struck (taken before the push)
                const at = ev.at ?? [p.x, p.y, p.z]; // (an older cached world.js gives no point)
                world.burst(at[0], at[1], at[2], { sparks: 50, speed: 16, debris: 10 });
                if (r.kind === 'meteor') {
                    // a meteor shatters
                    r.done = true;
                    world.burst(r.x, r.y, r.z, { sparks: 30, speed: 12, debris: Math.round(16 + r.sx * 10), fire: r.heat > 0.5 ? 14 : 0 });
                } else if (r.kind === 'comet') {
                    r.done = true;
                    world.burst(r.x, r.y, r.z, { sparks: 90, speed: 20, debris: 20, flash: 14, color: [0.6, 0.85, 1] });
                } else if (r.kind === 'mine') {
                    // a mine goes off
                    r.done = true;
                    world.burst(r.x, r.y, r.z, { sparks: 90, speed: 24, debris: 26, fire: 34, flash: 20, color: [1, 0.55, 0.2] });
                    audio.boom(0);
                    shake = Math.max(shake, 1.3);
                }
                // the fortress's blocks and wall parts are metal
                const metal = r.kind === 'block' || r.kind === 'greeble';
                if (metal) clang(true);
                damage(metal);
            } else if (ev.type === 'graze') {
                // a touch lighter than the tolerance: sparks, no harm
                const at = ev.at ?? [p.x, p.y, p.z];
                world.burst(at[0], at[1], at[2], { sparks: 16, speed: 9, color: [1, 0.8, 0.5] });
                grazeSound();
            } else if (ev.type === 'near' && live && p.alive) {
                run.combo = run.comboT > 0 ? Math.min(run.combo + 1, 9) : 1;
                run.comboT = 4;
                const comet = ev.rock.kind === 'comet';
                const mine = ev.rock.kind === 'mine';
                const pts = (comet ? 300 : mine ? 150 : 100) * run.combo;
                run.score += pts;
                run.near++;
                hud.popup(`${comet ? 'COMET ' : mine ? 'MINE ' : ''}NEAR MISS +${pts}${run.combo > 1 ? `  ×${run.combo}` : ''}`);
                audio.near(run.combo);
            }
        }

        if (live && p.alive) {
            run.score += dz * (p.boosting ? 2 : 1);
            run.comboT = Math.max(0, run.comboT - dt);
            const sector = 1 + Math.floor((p.z - run.z0) / TUNE.sector);
            if (sector !== run.sector) {
                run.sector = sector;
                const names = SCENES[scene].sectors;
                hud.banner(`SECTOR ${sector}`, names[Math.min(sector - 1, names.length - 1)]);
                audio.beep(true);
            }
        }
    };

    // title, game over: drift along the canyon on autopilot
    const cruise = (dt, speed) => {
        const tr = world.track;
        p.speed += (speed - p.speed) * (1 - Math.exp(-dt * 1.2));
        p.z += p.speed * dt;
        const tx = scene === 'space' ? 0 : tr.centerX(p.z + (scene === 'trench' ? 6 : 25));
        const ty = (scene === 'space' ? 0 : tr.floorY(p.z) + (scene === 'trench' ? 9 : 6)) + Math.sin(time * 0.9) * 0.5;
        const nx = p.x + (tx - p.x) * (1 - Math.exp(-dt * 1.5));
        const ny = p.y + (ty - p.y) * (1 - Math.exp(-dt * 2));
        if (dt > 0) {
            p.vx = (nx - p.x) / dt;
            p.vy = (ny - p.y) / dt;
        }
        p.x = nx;
        p.y = ny;
        world.update(dt, p);
    };

    const worldEvents = () => {
        for (const ev of world.events) {
            if (ev.type === 'curve' && game.state === 'play') {
                const arrow = ev.side < 0 ? '←' : '→';
                hud.warn(ev.kind === 'sharp' ? `⚠ 急カーブ ${arrow}` : `⚠ 連続カーブ ${arrow} ×${ev.n}`);
                audio.warn();
            }
            if (ev.type === 'comet' && game.state === 'play') {
                hud.warn(`⚠ 彗星接近 ${ev.side < 0 ? '←' : '→'}`);
                audio.comet();
            }
        }
        world.events.length = 0;
    };

    // ---- the camera, the model, what the renderer needs

    const updateCamera = (dt) => {
        const c = TUNE.cam;
        // which way the trench runs just ahead (0 elsewhere), eased so the view swings smoothly
        const want = scene === 'trench' && world.track.slope ? Math.atan(world.track.slope(p.z + 10)) : 0;
        heading += (want - heading) * (1 - Math.exp(-dt * 5));
        const t = TUNE.title;
        rail.x += (p.x - rail.x) * (1 - Math.exp(-dt * c.lagX));
        rail.y += (p.y - rail.y) * (1 - Math.exp(-dt * c.lagY));
        rail.x = clamp(rail.x, p.x - 6, p.x + 6);
        rail.y = clamp(rail.y, p.y - 4, p.y + 4);
        const b = ease(camBlend);
        const ox = (rail.x - p.x) * b;
        const oy = (rail.y - p.y) * b;
        const fast = clamp((p.speed - TUNE.speed[0]) / 40, 0, 1);
        const back = c.back + fast * 1.2 + pose.sprint * 1.2;
        // round the model from the front (title) to behind it (chase)
        const az = lerp(t.az + Math.sin(time * 0.13) * 0.3, 0, b);
        const radius = lerp(t.radius, back, b);
        let ex = Math.sin(az) * radius + ox;
        let ey = lerp(t.up, c.up, b) + oy;
        let ez = -Math.cos(az) * radius;
        let tx = ox * 0.55;
        const ty = lerp(t.lookUp, c.lookUp + oy * 0.5, b);
        let tz = lerp(0, c.ahead, b);
        // the trench: the camera swings round with the trench's bends (from behind along it), stays
        // inside it, and looks a little further the way it bends
        if (scene === 'trench') {
            const tr = world.track;
            const hd = heading * b;
            const ch = Math.cos(hd);
            const sh = Math.sin(hd);
            [ex, ez] = [ex * ch + ez * sh, -ex * sh + ez * ch];
            [tx, tz] = [tx * ch + tz * sh, -tx * sh + tz * ch];
            const zc = p.z + ez;
            const cxC = tr.centerX(zc);
            const room = Math.abs(tr.wallX(1, p.y + ey, zc) - cxC) - 1.2;
            ex = clamp(p.x + ex, cxC - room, cxC + room) - p.x;
            tx += (tr.centerX(p.z + tz) - p.x - tx) * 0.15 * b;
        }
        if (shake > 0) {
            ex += shake * 0.3 * Math.sin(time * 53.1);
            ey += shake * 0.3 * Math.sin(time * 61.7 + 1.3);
            shake = Math.max(0, shake - dt * 1.8);
        }
        const roll = clamp(p.vx / latMax(), -1, 1) * 0.045 * b;

        let vfov = lerp(t.fov, c.fov + fast * 6 + pose.sprint * 8, b);
        // portrait screens: keep enough of the canyon in view sideways
        const aspect = innerWidth / Math.max(1, innerHeight);
        const needV = (2 * Math.atan(Math.tan((70 * DEG) / 2) / aspect)) / DEG;
        vfov = Math.min(100, Math.max(vfov, needV));
        game.vfov = vfov;

        // game (relative to the player) → viewer world: x flips (the model faces +Z, its right is -X)
        const C = game.model.center;
        const W = (x, y, z) => [C[0] - x, C[1] + y, C[2] + z];
        const eye = W(ex, ey, ez);
        const target = W(tx, ty, tz);
        const up = [-Math.sin(roll), Math.cos(roll), 0];
        lookAt(eye, target, up, game.camWorld);
        if (camEntity) {
            camEntity.setPosition(eye[0], eye[1], eye[2]);
            camEntity.lookAt(target[0], target[1], target[2], up[0], up[1], up[2]);
            const cam = camEntity.camera;
            cam.horizontalFov = false;
            cam.fov = vfov;
            cam.nearClip = 0.05;
            cam.farClip = 60;
        }
        fx.camG[0] = p.x + ex;
        fx.camG[1] = p.y + ey;
        fx.camG[2] = p.z + ez;
        fx.G.set([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, C[0] + p.x, C[1] - p.y, C[2] - p.z, 1]);
    };

    const updateModel = (dt) => {
        const b = camBlend;
        const vxn = clamp(p.vx / latMax(), -1, 1);
        const vyn = clamp(p.vy / TUNE.vertMax, -1, 1);
        const k = 1 - Math.exp(-dt * 5);
        pose.sprint += ((p.boosting ? 1 : 0) - pose.sprint) * (1 - Math.exp(-dt * 3));
        const lean = (lerp(TUNE.titleLean, TUNE.lean, b) + pose.sprint * 10 - vyn * TUNE.pitch) * DEG;
        pose.lean += (lean - pose.lean) * k;
        pose.bank += (vxn * TUNE.bank * DEG - pose.bank) * k;
        // turned the way the player slides, and (in the trench) along the trench itself
        pose.yaw += (-vxn * TUNE.yaw * DEG - heading - pose.yaw) * k;
        pose.wobble = Math.max(0, pose.wobble - dt * 1.5);
        const wob = pose.wobble * 0.35 * Math.sin(time * 30);
        const bob = (1 - b) * 0.05 * Math.sin(time * 1.3);
        // lean about the model's right axis (top towards +Z, its front), turn, then bank about the
        // direction of flight (+Z): a positive angle tips the top towards -X, the screen's right
        rot.q = qMul(qAxis(0, 0, 1, pose.bank + wob + bob), qMul(qAxis(0, 1, 0, pose.yaw), qAxis(1, 0, 0, pose.lean)));
        qMat3(rot.q, fx.rotMat);

        if (!splat) return;
        if (!base) {
            const pp = splat.getLocalPosition();
            const qq = splat.getLocalRotation();
            const ss = splat.getLocalScale();
            base = { p: [pp.x, pp.y, pp.z], q: [qq.x, qq.y, qq.z, qq.w], s: [ss.x, ss.y, ss.z] };
        }
        // turn, lean and enlarge the model about its centre
        const pivot = game.model.center;
        const ks = fx.scale;
        const q = qMul(rot.q, base.q);
        const m = fx.rotMat;
        const d = [(base.p[0] - pivot[0]) * ks, (base.p[1] - pivot[1]) * ks, (base.p[2] - pivot[2]) * ks];
        splat.setLocalPosition(
            pivot[0] + m[0] * d[0] + m[3] * d[1] + m[6] * d[2],
            pivot[1] + m[1] * d[0] + m[4] * d[1] + m[7] * d[2],
            pivot[2] + m[2] * d[0] + m[5] * d[1] + m[8] * d[2]
        );
        splat.setLocalRotation(q[0], q[1], q[2], q[3]);
        splat.setLocalScale(base.s[0] * ks, base.s[1] * ks, base.s[2] * ks);
    };

    const updateFx = (dt) => {
        const R = Math.hypot(...game.model.halfExt);
        fx.offset[0] = -p.x / R;
        fx.offset[1] = p.y / R;
        fx.offset[2] = p.z / R;
        fx.vel[0] = p.vx + (p.follow || 0);
        fx.vel[1] = -p.vy;
        fx.vel[2] = -p.speed;
        const flying = game.state === 'play' || game.state === 'countdown' || game.state === 'pause';
        const thrust = game.state === 'gallery' || (!p.alive && game.state !== 'title') ? 0 : flying ? 1 : 0.75;
        fx.thrust += (thrust - fx.thrust) * (1 - Math.exp(-dt * 6));
        if (!p.alive && game.state !== 'title') fx.thrust = 0;
        fx.sprint = pose.sprint;
        fx.flash = world.flash;
        // looking back along the canyon (title) there is less of it: fade out sooner
        const b = ease(camBlend);
        fx.fadeRange[0] = lerp(120, 230, b);
        fx.fadeRange[1] = lerp(190, 292, b);
    };

    // the model's lighting: the meteors' sun, its own thrusters, the nearest comet
    const updateLight = (dt) => {
        const pivot = game.model.center;
        const m = fx.rotMat;
        const ks = fx.scale;
        // a little below and behind each nozzle, where its jet is brightest; turned with the model
        const jets = (fx.thrusters ?? []).map(({ pos }) => {
            const d = [(pos[0] - pivot[0]) * ks, (pos[1] - pivot[1] - 0.1) * ks, (pos[2] - pivot[2] - 0.08) * ks];
            return [
                pivot[0] + m[0] * d[0] + m[3] * d[1] + m[6] * d[2],
                pivot[1] + m[1] * d[0] + m[4] * d[1] + m[7] * d[2],
                pivot[2] + m[2] * d[0] + m[5] * d[1] + m[8] * d[2]
            ];
        });
        let comet = null;
        let nearest = Infinity;
        for (const r of world.rocks) {
            if (r.kind !== 'comet') continue;
            const dx = r.x - p.x;
            const dy = r.y - p.y;
            const dz = r.z - p.z;
            const dist = Math.hypot(dx, dy, dz);
            if (dist >= nearest) continue;
            nearest = dist;
            const [far, close] = SPLAT_LIGHT.cometRange;
            // game → viewer axes: x flips
            comet = { dir: [-dx, dy, dz], near: ease(clamp((far - dist) / (far - close), 0, 1)) };
        }
        const w = game.camWorld;
        light.update({
            dt,
            time,
            pivot,
            cam: [w[12], w[13], w[14]],
            sunDir: [-SUN[0], SUN[1], SUN[2]],
            jets,
            thrust: fx.thrust,
            boost: pose.sprint,
            scale: ks,
            comet,
            flash: world.flash
        });
    };

    // ---- the frame

    const tick = (dtIn) => {
        const dt = game.state === 'pause' ? 0 : Math.min(dtIn, 0.05);
        time += dt;
        stateT += dt;
        const inp = input.read();

        switch (game.state) {
            case 'loading':
            case 'title':
                cruise(dt, 12);
                camBlend = Math.max(0, camBlend - dt * 0.8);
                break;
            case 'countdown': {
                countdown -= dt;
                const n = Math.ceil(countdown);
                if (n !== lastCount && n > 0) {
                    lastCount = n;
                    hud.count(String(n));
                    audio.beep(false);
                }
                camBlend = Math.min(1, camBlend + dt / 1.6);
                fly(dt, inp, false);
                if (countdown <= 0) {
                    setState('play');
                    hud.count('GO!');
                    audio.beep(true);
                    hud.banner('SECTOR 1', SCENES[scene].sectors[0]);
                }
                break;
            }
            case 'play':
                camBlend = Math.min(1, camBlend + dt / 1.6);
                fly(dt, inp, true);
                break;
            case 'dying':
                p.speed *= Math.exp(-dt * 1.4);
                p.z += p.speed * dt;
                world.update(dt, p);
                if (stateT > 2.3) gameOver();
                break;
            case 'over':
                cruise(dt, 10);
                break;
            case 'gallery':
                // stand still behind the (hidden) model and look at the rocks
                p.x = p.y = p.z = p.vx = p.vy = p.speed = 0;
                rail.x = rail.y = 0;
                camBlend = 1;
                world.update(dt, p);
                break;
        }
        worldEvents();

        if (resetT > 0) {
            resetT -= dtIn;
            if (resetT <= 0) {
                newWorld();
                setSplatVisible(true);
                camBlend = 1;
                startRun();
                hud.fade(false);
            }
        }

        world.terrain.behindTarget = camBlend < 0.5 ? TITLE_BEHIND : RINGS_BEHIND;
        // the round blob under the player only while its shaped shadow (world-gl.js) is not there
        world.player = p;
        world.fillBlobs(p, (p.alive || game.state === 'title') && !world.bodyProxy);
        updateCamera(dt);
        updateModel(dt);
        // once the model and its resting pose are known: its shape for hits
        if (gsComp && base && bodyState === 'none') {
            bodyState = 'building';
            buildBody(gsComp, base, game.model.center)
                .then((b) => {
                    body = b;
                    bodyState = b ? 'ready' : 'failed';
                })
                .catch(() => {
                    bodyState = 'failed';
                });
        }
        // the body for drawing: walls and blocks cover the model exactly where they are nearer than it
        world.bodyProxy = body && splat?.enabled && game.state !== 'gallery' ? updateBody() : null;
        if (HITBOX && body && splat?.enabled) {
            const b = updateBody();
            for (let i = 0; i < b.n; i++) world.sparks.emit(b.pts[i * 4], b.pts[i * 4 + 1], b.pts[i * 4 + 2], 0, 0, 0, 0.045, b.pts[i * 4 + 3] * 2.2, b.pts[i * 4 + 3] * 2.2, 0.3, 1, 0.5, 0.8, 0, 0);
        }
        updateFx(dt);
        updateLight(dtIn);
        if (game.state === 'gallery') placeGalleryLabels();

        if (scene !== 'space') edge.l = edge.r = edge.t = edge.b = 0;
        if (game.state !== 'play' && game.state !== 'countdown') edge.l = edge.r = edge.t = edge.b = 0;
        hud.edges(edge);
        white = Math.max(0, white - dtIn * 1.6);
        hud.white(Math.max(white, world.flash * 0.25));
        hud.update({
            score: run.score,
            distM: Math.max(0, (run.z1 ?? p.z) - run.z0) * UNIT_M,
            kmh: p.speed * UNIT_M * 3.6,
            sector: run.sector,
            boost: p.boost,
            boosting: p.boosting,
            hp: Math.max(0, p.hp),
            maxHp: TUNE.hp
        });
        const flying = game.state !== 'pause' && game.state !== 'gallery' && (p.alive || game.state === 'title');
        audio.engine(clamp(p.speed / 64, 0, 1), pose.sprint, flying ? 1 : 0);
    };

    if (GALLERY) {
        setState('gallery');
        showGallery(0);
    }

    game.tick = tick;
    game.debug = { p, run, TUNE, light: SPLAT_LIGHT, body: () => ({ state: bodyState, n: body?.n ?? 0, world: updateBody() }) };
    game.attach = (a) => {
        app = a;
        camEntity = app.root.findComponents('camera')[0]?.entity ?? null;
        const gs = app.root.findComponents('gsplat')[0] ?? null;
        splat = gs?.entity ?? null;
        if (gs) light.attach(gs);
        gsComp = gs;
        const b = readBounds(app);
        if (b) {
            game.model.center = b.center;
            game.model.halfExt = b.halfExt;
        }
        if (game.state === 'loading') setState('title');
        if (game.state === 'gallery') setSplatVisible(false);
        hud.setReady(true);
    };
    return game;
};

// ---------------------------------------------------------------------------------------------

const game = createGame();
const fx = createFx(game);
// for poking at from the console
window.meteorCanyon = { game, fx };

// until the viewer has loaded the model, run on our own clock; then inside the engine's frame,
// after the viewer has placed its camera (so ours wins) and before it renders
let last = performance.now();
const boot = () => {
    const a = window.app;
    if (a?.on && a.root?.findComponents('gsplat')[0]) {
        game.attach(a);
        fx.setApp(a);
        a.on('update', (dt) => {
            game.tick(dt);
            a.renderNextFrame = true;
        });
        a.on('framerender', fx.render);
        return;
    }
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    game.tick(dt);
    fx.render();
    requestAnimationFrame(boot);
};
requestAnimationFrame(boot);
