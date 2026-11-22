// hud.js — 画面の文字と操作パネル（タイトル、スコア、速度、シールド、ブースト、メッセージ、ゲームオーバー）。
// 画面全体を覆う .mc-hud がポインター入力も受ける（ビューアのカメラ操作には渡さない）。

const CSS = `
.mc-hud {
    position: fixed; inset: 0; z-index: 5;
    touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
    color: #e8f2ff; cursor: default;
    font-family: 'Orbitron', system-ui, -apple-system, 'Hiragino Sans', sans-serif;
    --accent: #ffbe5c; --cyan: #9fd4ff; --danger: #ff5a4a;
}
.mc-hud * { box-sizing: border-box; }
.mc-jp { font-family: system-ui, -apple-system, 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif; }
.mc-play { position: absolute; inset: 0; pointer-events: none; transition: opacity 0.4s ease; }
.mc-hud[data-screen='title'] .mc-play, .mc-hud[data-screen='loading'] .mc-play, .mc-hud[data-screen='over'] .mc-play,
.mc-hud[data-screen='gallery'] .mc-play { opacity: 0; }
/* ?rocks: labels under the rocks */
.mc-gal { position: absolute; inset: 0; pointer-events: none; display: none; }
.mc-hud[data-screen='gallery'] .mc-gal { display: block; }
.mc-gal-head { position: absolute; left: 0; right: 0; top: 18px; text-align: center; color: #fff; font-size: 17px; letter-spacing: 0.08em; text-shadow: 0 1px 6px rgba(0,0,0,0.8); }
.mc-gal-head small { display: block; margin-top: 6px; font-size: 12px; color: var(--cyan); letter-spacing: 0.04em; }
.mc-gal-label { position: absolute; transform: translate(-50%, 0); text-align: center; color: #fff; font-size: 14px; white-space: nowrap; text-shadow: 0 1px 5px rgba(0,0,0,0.9); }
.mc-gal-label small { display: block; margin-top: 3px; font-size: 11px; color: var(--accent); }
.mc-hud[data-screen='pause'] .mc-play { opacity: 0.35; }
.mc-hud[data-screen='pause'] .mc-top .mc-right { visibility: hidden; }

.mc-top {
    position: absolute; left: 0; right: 0; top: 0;
    padding: max(14px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) 0 max(20px, env(safe-area-inset-left));
    display: flex; justify-content: space-between; align-items: flex-start;
}
.mc-label { font-size: 10px; letter-spacing: 0.28em; color: var(--cyan); opacity: 0.85; }
.mc-score { font-size: 32px; font-weight: 700; letter-spacing: 0.04em; line-height: 1.1; text-shadow: 0 0 14px rgba(120, 180, 255, 0.55); font-variant-numeric: tabular-nums; }
.mc-dist { font-size: 13px; letter-spacing: 0.08em; opacity: 0.85; margin-top: 2px; font-variant-numeric: tabular-nums; }
.mc-right { text-align: right; }
.mc-best { font-size: 16px; font-weight: 500; font-variant-numeric: tabular-nums; }
.mc-sector { font-size: 12px; letter-spacing: 0.2em; margin-top: 6px; color: var(--accent); }

.mc-bottom {
    position: absolute; left: 0; right: 0; bottom: 0;
    padding: 0 max(20px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
    display: flex; justify-content: space-between; align-items: flex-end;
}
.mc-speed { font-size: 40px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; text-shadow: 0 0 14px rgba(120, 180, 255, 0.5); }
.mc-speed small { font-size: 13px; font-weight: 500; margin-left: 6px; opacity: 0.8; letter-spacing: 0.1em; }
.mc-gauge { width: 190px; height: 7px; margin-top: 8px; border-radius: 4px; background: rgba(160, 200, 255, 0.16); overflow: hidden; }
.mc-gauge > i { display: block; height: 100%; width: 100%; transform-origin: left; border-radius: 4px; background: linear-gradient(90deg, #ff8a3d, var(--accent)); box-shadow: 0 0 10px rgba(255, 170, 80, 0.8); }
.mc-gauge.is-low > i { background: rgba(255, 190, 92, 0.35); box-shadow: none; }
.mc-gauge-label { display: flex; justify-content: space-between; width: 190px; margin-top: 4px; }
.mc-gauge-label .is-on { color: var(--accent); opacity: 1; text-shadow: 0 0 8px rgba(255, 170, 80, 0.9); }
.mc-shield { display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; }
.mc-shield i { width: 22px; height: 22px; transform: rotate(45deg); border: 2px solid var(--cyan); border-radius: 3px; background: rgba(159, 212, 255, 0.75); box-shadow: 0 0 12px rgba(120, 190, 255, 0.8); transition: background 0.2s, box-shadow 0.2s, border-color 0.2s; }
.mc-shield i.is-off { background: transparent; box-shadow: none; border-color: rgba(159, 212, 255, 0.3); }
.mc-shield.is-last i:not(.is-off) { border-color: var(--danger); background: rgba(255, 90, 74, 0.8); box-shadow: 0 0 14px rgba(255, 90, 74, 0.9); animation: mc-blink 0.6s steps(2) infinite; }

.mc-center { position: absolute; left: 0; right: 0; top: 18%; text-align: center; pointer-events: none; }
.mc-banner { font-size: 30px; font-weight: 900; letter-spacing: 0.18em; opacity: 0; transition: opacity 0.35s ease; text-shadow: 0 0 18px rgba(120, 180, 255, 0.7); }
.mc-banner small { display: block; font-size: 15px; font-weight: 500; letter-spacing: 0.3em; margin-top: 6px; color: var(--accent); }
.mc-banner.is-on { opacity: 1; }
.mc-warn { margin-top: 10px; font-size: 16px; font-weight: 700; letter-spacing: 0.2em; color: var(--danger); opacity: 0; text-shadow: 0 0 12px rgba(255, 80, 60, 0.9); }
.mc-warn.is-on { animation: mc-warn 1.4s ease forwards; }
.mc-count { position: absolute; left: 0; right: 0; top: 40%; text-align: center; font-size: 96px; font-weight: 900; pointer-events: none; opacity: 0; text-shadow: 0 0 30px rgba(140, 190, 255, 0.85); }
.mc-count.is-pop { animation: mc-pop 0.9s ease-out forwards; }
.mc-popups { position: absolute; left: 50%; top: 60%; width: 0; pointer-events: none; }
.mc-popup { position: absolute; left: 0; transform: translateX(-50%); white-space: nowrap; font-size: 18px; font-weight: 700; letter-spacing: 0.12em; color: var(--accent); text-shadow: 0 0 12px rgba(255, 160, 60, 0.9); animation: mc-rise 1.1s ease-out forwards; }

.mc-flash { position: absolute; inset: 0; pointer-events: none; opacity: 0; background: radial-gradient(ellipse at center, rgba(255, 60, 40, 0) 35%, rgba(255, 40, 30, 0.55) 100%); }
.mc-flash.is-on { animation: mc-flash 0.5s ease-out; }
.mc-white { position: absolute; inset: 0; pointer-events: none; background: #fff3dc; opacity: 0; }
.mc-fade { position: absolute; inset: 0; pointer-events: none; background: #01030b; opacity: 0; transition: opacity 0.28s ease; }
.mc-fade.is-on { opacity: 1; }
.mc-boostfx { position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity 0.3s ease; background: radial-gradient(ellipse at center, rgba(255, 190, 110, 0) 55%, rgba(255, 170, 80, 0.16) 100%); }
.mc-boostfx.is-on { opacity: 1; }
/* the edge of the flying area: a soft glow on the side the player is pressing against */
.mc-edge { position: absolute; pointer-events: none; opacity: 0; transition: opacity 0.25s ease; --c: rgba(130, 200, 255, 0.42); }
.mc-edge.is-l { left: 0; top: 0; bottom: 0; width: 12vw; background: linear-gradient(90deg, var(--c), transparent); }
.mc-edge.is-r { right: 0; top: 0; bottom: 0; width: 12vw; background: linear-gradient(270deg, var(--c), transparent); }
.mc-edge.is-t { left: 0; right: 0; top: 0; height: 12vh; background: linear-gradient(180deg, var(--c), transparent); }
.mc-edge.is-b { left: 0; right: 0; bottom: 0; height: 12vh; background: linear-gradient(0deg, var(--c), transparent); }

.mc-screen {
    position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: space-between;
    padding: max(7vh, env(safe-area-inset-top)) 20px max(6vh, env(safe-area-inset-bottom)); text-align: center;
    background: radial-gradient(ellipse 70% 60% at 50% 50%, rgba(1, 3, 12, 0) 40%, rgba(1, 3, 12, 0.55) 100%);
}
.mc-hud[data-screen='title'] .mc-title, .mc-hud[data-screen='loading'] .mc-title,
.mc-hud[data-screen='over'] .mc-over, .mc-hud[data-screen='pause'] .mc-pause { display: flex; }
.mc-logo { font-size: clamp(38px, 8vw, 84px); font-weight: 900; letter-spacing: 0.16em; line-height: 1.02; padding-left: 0.16em;
    background: linear-gradient(180deg, #ffffff 0%, #cfe6ff 45%, #ffb85a 100%); -webkit-background-clip: text; background-clip: text; color: transparent;
    filter: drop-shadow(0 0 18px rgba(110, 170, 255, 0.55)); }
.mc-logo.is-small { font-size: clamp(30px, 6vw, 58px); }
.mc-sub { margin-top: 12px; font-size: clamp(13px, 1.8vw, 17px); letter-spacing: 0.2em; color: #d7e8ff; text-shadow: 0 1px 10px rgba(0, 0, 0, 0.8); }
.mc-press { font-size: clamp(14px, 2vw, 18px); letter-spacing: 0.3em; padding: 12px 26px; border: 1px solid rgba(159, 212, 255, 0.55); border-radius: 999px;
    background: rgba(6, 16, 44, 0.55); animation: mc-breathe 1.8s ease-in-out infinite; cursor: pointer; }
.mc-press.is-wait { animation: none; opacity: 0.6; cursor: default; }
.mc-keys { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px 18px; margin-top: 16px; font-size: 13px; color: #cfe0f5; text-shadow: 0 1px 8px rgba(0, 0, 0, 0.9); }
.mc-keys b { font-family: 'Orbitron', system-ui, sans-serif; font-weight: 500; color: #fff; margin-right: 6px; padding: 1px 7px; border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 5px; font-size: 11px; }
/* scene select on the title */
.mc-scene { display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 24px; }
.mc-scene-btn { width: 40px; height: 40px; border-radius: 50%; border: 1px solid rgba(159, 212, 255, 0.55); background: rgba(6, 16, 44, 0.55);
    color: #fff; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.mc-scene-btn:hover { background: rgba(40, 80, 150, 0.6); }
.mc-scene-name { min-width: 11em; }
.mc-scene-name b { display: block; font-size: clamp(17px, 2.4vw, 22px); font-weight: 700; letter-spacing: 0.24em; color: #fff; text-shadow: 0 1px 10px rgba(0, 0, 0, 0.8); }
.mc-scene-name small { display: block; margin-top: 4px; font-family: 'Orbitron', system-ui, sans-serif; font-size: 11px; letter-spacing: 0.32em; color: var(--cyan); }
.mc-scene-hint { margin-top: 8px; font-size: 12px; letter-spacing: 0.12em; color: #a9c4e6; text-shadow: 0 1px 8px rgba(0, 0, 0, 0.9); }
.mc-scene.is-fixed .mc-scene-btn, .mc-scene.is-fixed + .mc-scene-hint { visibility: hidden; }
.mc-sound-hint { display: none; margin-top: 10px; font-size: 12px; letter-spacing: 0.06em; color: #ffd28a; text-shadow: 0 1px 8px rgba(0, 0, 0, 0.9); }
.mc-sound-hint.is-on { display: block; }
.mc-title-best { margin-top: 12px; font-size: 13px; letter-spacing: 0.24em; color: var(--accent); }
.mc-result { margin-top: 18px; font-size: clamp(16px, 2.4vw, 22px); letter-spacing: 0.2em; }
.mc-result b { display: block; font-size: clamp(44px, 8vw, 72px); font-weight: 900; letter-spacing: 0.06em; text-shadow: 0 0 22px rgba(120, 180, 255, 0.7); font-variant-numeric: tabular-nums; }
.mc-newrec { margin-top: 6px; font-size: 18px; font-weight: 700; letter-spacing: 0.3em; color: var(--accent); text-shadow: 0 0 14px rgba(255, 160, 60, 0.9); animation: mc-blink 0.8s steps(2) infinite; }
.mc-stats { margin-top: 12px; font-size: 15px; letter-spacing: 0.1em; color: #d7e8ff; }
.mc-pause { justify-content: center; gap: 22px; background: rgba(1, 3, 12, 0.55); }

.mc-boost-btn { position: absolute; right: max(22px, env(safe-area-inset-right)); bottom: max(118px, calc(env(safe-area-inset-bottom) + 100px));
    width: 92px; height: 92px; border-radius: 50%; display: none; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 700; letter-spacing: 0.12em; color: #fff; background: rgba(255, 150, 60, 0.22); border: 2px solid rgba(255, 190, 92, 0.75); }
.mc-boost-btn.is-down { background: rgba(255, 160, 60, 0.6); }
.mc-hud.is-touch[data-screen='play'] .mc-boost-btn, .mc-hud.is-touch[data-screen='countdown'] .mc-boost-btn { display: flex; }
.mc-stick { position: absolute; width: 110px; height: 110px; margin: -55px 0 0 -55px; border-radius: 50%; border: 2px solid rgba(159, 212, 255, 0.4); pointer-events: none; display: none; }
.mc-stick i { position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; background: rgba(159, 212, 255, 0.45); }
.mc-stick.is-on { display: block; }
.mc-mute { position: absolute; right: max(16px, env(safe-area-inset-right)); top: max(12px, env(safe-area-inset-top)); display: none; padding: 6px 12px; border-radius: 999px;
    font-size: 11px; letter-spacing: 0.15em; background: rgba(6, 16, 44, 0.55); border: 1px solid rgba(159, 212, 255, 0.4); cursor: pointer; }
.mc-hud[data-screen='title'] .mc-mute, .mc-hud[data-screen='over'] .mc-mute, .mc-hud[data-screen='pause'] .mc-mute { display: block; }

@media (max-width: 640px) {
    .mc-score { font-size: 24px; }
    .mc-speed { font-size: 30px; }
    .mc-gauge, .mc-gauge-label { width: 140px; }
    .mc-shield i { width: 17px; height: 17px; }
    .mc-banner { font-size: 22px; }
    .mc-count { font-size: 72px; }
}

@keyframes mc-breathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; box-shadow: 0 0 22px rgba(120, 180, 255, 0.45); } }
@keyframes mc-blink { 50% { opacity: 0.35; } }
@keyframes mc-pop { 0% { opacity: 0; transform: scale(1.8); } 18% { opacity: 1; transform: scale(1); } 75% { opacity: 1; } 100% { opacity: 0; transform: scale(0.92); } }
@keyframes mc-rise { 0% { opacity: 0; transform: translate(-50%, 10px); } 15% { opacity: 1; } 100% { opacity: 0; transform: translate(-50%, -46px); } }
@keyframes mc-flash { 0% { opacity: 1; } 100% { opacity: 0; } }
@keyframes mc-warn { 0%, 30%, 60% { opacity: 1; } 15%, 45% { opacity: 0.2; } 100% { opacity: 0; } }
`;

const fmt = (n) => Math.floor(n).toLocaleString('en-US');

export const createHud = ({ touch, subtitle }) => {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.className = 'mc-hud' + (touch ? ' is-touch' : '');
    root.dataset.screen = 'loading';
    const padHtml =
        '<span><b>左スティック / 十字キー</b>移動</span><span><b>Ⓐ / RB / RT</b>ブースト（長押し）</span><span><b>START</b>ポーズ</span><span><b>BACK</b>音</span>';
    let pad = false;
    let hudReady = false;
    const keysHtml = touch
        ? '<span>画面をドラッグして移動</span><span><b>BOOST</b> ボタンで加速</span>'
        : '<span><b>← →</b>左右</span><span><b>↑ ↓</b>上下</span><span><b>SPACE</b>ブースト（長押し）</span><span><b>P</b>ポーズ</span><span><b>M</b>音</span>';
    root.innerHTML = `
        <div class="mc-play">
            <div class="mc-top">
                <div>
                    <div class="mc-label">SCORE</div>
                    <div class="mc-score" data-k="score">0</div>
                    <div class="mc-dist" data-k="dist">0.00 km</div>
                </div>
                <div class="mc-right">
                    <div class="mc-label">BEST</div>
                    <div class="mc-best" data-k="best">0</div>
                    <div class="mc-sector" data-k="sector">SECTOR 1</div>
                </div>
            </div>
            <div class="mc-bottom">
                <div>
                    <div class="mc-speed"><span data-k="speed">0</span><small>km/h</small></div>
                    <div class="mc-gauge" data-k="gauge"><i></i></div>
                    <div class="mc-gauge-label mc-label"><span data-k="boostlabel">BOOST</span><span>${touch ? '' : 'SPACE'}</span></div>
                </div>
                <div class="mc-right">
                    <div class="mc-label">SHIELD</div>
                    <div class="mc-shield" data-k="shield"></div>
                </div>
            </div>
            <div class="mc-center">
                <div class="mc-banner" data-k="banner"></div>
                <div class="mc-warn mc-jp" data-k="warn"></div>
            </div>
            <div class="mc-popups" data-k="popups"></div>
        </div>
        <div class="mc-count" data-k="count"></div>
        <div class="mc-boostfx" data-k="boostfx"></div>
        <div class="mc-edge is-l" data-k="edgel"></div>
        <div class="mc-edge is-r" data-k="edger"></div>
        <div class="mc-edge is-t" data-k="edget"></div>
        <div class="mc-edge is-b" data-k="edgeb"></div>
        <div class="mc-flash" data-k="flash"></div>
        <div class="mc-white" data-k="white"></div>
        <div class="mc-screen mc-title">
            <div>
                <div class="mc-logo">METEOR<br>CANYON</div>
                <div class="mc-sub mc-jp" data-k="subtitle">${subtitle}</div>
                <div class="mc-scene" data-k="scene">
                    <div class="mc-scene-btn" data-scene="-1" role="button" aria-label="前のシーン">◀</div>
                    <div class="mc-scene-name mc-jp"><b data-k="scenename"></b><small data-k="sceneen"></small></div>
                    <div class="mc-scene-btn" data-scene="1" role="button" aria-label="次のシーン">▶</div>
                </div>
                <div class="mc-scene-hint mc-jp" data-k="scenehint">${touch ? '◀ ▶ でシーンを切り替え' : '← → でシーンを切り替え'}</div>
            </div>
            <div>
                <div class="mc-press is-wait" data-k="press">LOADING…</div>
                <div class="mc-keys mc-jp" data-k="keys">${keysHtml}</div>
                <div class="mc-sound-hint mc-jp" data-k="soundhint">🔈 音を出すには、一度クリックかキーを押してください（コントローラーのボタンでは音が鳴り始めません）</div>
                <div class="mc-title-best" data-k="titlebest"></div>
            </div>
        </div>
        <div class="mc-screen mc-over">
            <div>
                <div class="mc-logo is-small">GAME OVER</div>
                <div class="mc-result">SCORE<b data-k="final">0</b></div>
                <div class="mc-newrec" data-k="newrec">NEW RECORD!</div>
                <div class="mc-stats mc-jp" data-k="stats"></div>
            </div>
            <div class="mc-press" data-k="retry">${touch ? 'TAP' : 'PRESS SPACE'} TO RETRY</div>
        </div>
        <div class="mc-screen mc-pause">
            <div class="mc-logo is-small">PAUSED</div>
            <div class="mc-press" data-k="resume">${touch ? 'TAP' : 'P / SPACE'} TO RESUME</div>
        </div>
        <div class="mc-boost-btn" data-k="boostbtn">BOOST</div>
        <div class="mc-stick" data-k="stick"><i></i></div>
        <div class="mc-mute" data-k="mute">SOUND ON</div>
        <div class="mc-fade" data-k="fade"></div>
    `;
    document.body.appendChild(root);
    const el = {};
    for (const n of root.querySelectorAll('[data-k]')) el[n.dataset.k] = n;

    let shieldCount = -1;
    let bannerTimer = 0;
    const last = {};
    const set = (k, text) => {
        if (last[k] !== text) {
            last[k] = text;
            el[k].textContent = text;
        }
    };

    return {
        root,
        el,
        setScreen(name) {
            root.dataset.screen = name;
        },
        setReady(ready) {
            hudReady = ready;
            el.press.classList.toggle('is-wait', !ready);
            el.press.textContent = ready ? (pad ? 'PRESS Ⓐ TO START' : touch ? 'TAP TO START' : 'PRESS SPACE TO START') : 'LOADING…';
        },
        // a game controller in use: its buttons in the hints (and back to the keys when it goes)
        setPad(on) {
            if (pad === on) return;
            pad = on;
            el.keys.innerHTML = on ? padHtml : keysHtml;
            el.scenehint.textContent = on ? '十字キー ◀ ▶ / LB・RB でシーンを切り替え' : touch ? '◀ ▶ でシーンを切り替え' : '← → でシーンを切り替え';
            el.retry.textContent = on ? 'PRESS Ⓐ TO RETRY' : `${touch ? 'TAP' : 'PRESS SPACE'} TO RETRY`;
            el.resume.textContent = on ? 'START / Ⓐ TO RESUME' : `${touch ? 'TAP' : 'P / SPACE'} TO RESUME`;
            this.setReady(hudReady);
        },
        // the browser will not start sound from a controller's button: ask for one click or key
        setSoundHint(on) {
            el.soundhint.classList.toggle('is-on', on);
        },
        // the scene shown on the title: { name, en, sub }, and whether it can be switched
        setScene(s, canSwitch = true) {
            el.scenename.textContent = s.name;
            el.sceneen.textContent = s.en;
            el.subtitle.textContent = s.sub;
            el.scene.classList.toggle('is-fixed', !canSwitch);
        },
        setBest(best) {
            set('best', fmt(best));
            el.titlebest.textContent = best > 0 ? `BEST ${fmt(best)}` : '';
        },
        setMuted(muted) {
            el.mute.textContent = muted ? 'SOUND OFF' : 'SOUND ON';
        },
        update(s) {
            set('score', fmt(s.score));
            set('dist', `${(s.distM / 1000).toFixed(2)} km`);
            set('speed', fmt(s.kmh));
            set('sector', `SECTOR ${s.sector}`);
            el.gauge.firstElementChild.style.transform = `scaleX(${s.boost.toFixed(3)})`;
            el.gauge.classList.toggle('is-low', s.boost < 0.12 && !s.boosting);
            el.boostlabel.classList.toggle('is-on', s.boosting);
            el.boostfx.classList.toggle('is-on', s.boosting);
            if (s.hp !== shieldCount) {
                shieldCount = s.hp;
                el.shield.innerHTML = Array.from({ length: s.maxHp }, (_, i) => `<i class="${i < s.hp ? '' : 'is-off'}"></i>`).join('');
                el.shield.classList.toggle('is-last', s.hp === 1);
            }
        },
        banner(text, sub = '', seconds = 2.4) {
            el.banner.innerHTML = `${text}${sub ? `<small class="mc-jp">${sub}</small>` : ''}`;
            el.banner.classList.add('is-on');
            clearTimeout(bannerTimer);
            bannerTimer = setTimeout(() => el.banner.classList.remove('is-on'), seconds * 1000);
        },
        warn(text) {
            el.warn.textContent = text;
            el.warn.classList.remove('is-on');
            void el.warn.offsetWidth;
            el.warn.classList.add('is-on');
        },
        count(text) {
            el.count.textContent = text;
            el.count.classList.remove('is-pop');
            void el.count.offsetWidth;
            el.count.classList.add('is-pop');
        },
        popup(text) {
            const p = document.createElement('div');
            p.className = 'mc-popup';
            p.textContent = text;
            el.popups.appendChild(p);
            setTimeout(() => p.remove(), 1200);
        },
        hit() {
            el.flash.classList.remove('is-on');
            void el.flash.offsetWidth;
            el.flash.classList.add('is-on');
        },
        edges(e) {
            for (const k of ['l', 'r', 't', 'b']) {
                const on = e[k] > 0;
                if (last['edge' + k] !== on) {
                    last['edge' + k] = on;
                    el['edge' + k].style.opacity = on ? '1' : '0';
                }
            }
        },
        white(v) {
            el.white.style.opacity = v.toFixed(3);
        },
        fade(on) {
            el.fade.classList.toggle('is-on', on);
        },
        gameOver({ score, best, newRecord, distM, nearMisses }) {
            el.final.textContent = fmt(score);
            el.newrec.style.display = newRecord ? '' : 'none';
            el.stats.textContent = `飛行距離 ${(distM / 1000).toFixed(2)} km ・ ニアミス ${nearMisses} 回`;
            this.setBest(best);
        },
        stick(on, x0, y0, sx, sy) {
            el.stick.classList.toggle('is-on', on);
            if (!on) return;
            el.stick.style.left = `${x0}px`;
            el.stick.style.top = `${y0}px`;
            el.stick.firstElementChild.style.transform = `translate(${sx * 33}px, ${-sy * 33}px)`;
        }
    };
};
