// audio.js — 効果音とジェットエンジンの音（Web Audio で合成。音声ファイルは使わない）。
// ブラウザの決まりで、最初のキーやタップのあとに unlock() してから鳴る。
// 要塞にぶつかった音だけは録音（sounds/hit-metal.mp3）を使う。読み込めないときは合成の金属音。

export const createAudio = () => {
    let ctx = null;
    let master = null;
    let noise = null;
    let engine = null;
    let muted = false;
    let impact = null; // the recorded hit (an AudioBuffer, once loaded)
    try {
        muted = localStorage.getItem('meteor-canyon-muted') === '1';
    } catch {
        // storage unavailable: start with sound on
    }

    const build = () => {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 4;
        comp.connect(ctx.destination);
        master = ctx.createGain();
        master.gain.value = muted ? 0 : 0.75;
        master.connect(comp);

        // two seconds of white noise, reused by everything that hisses or booms
        noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const d = noise.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

        // a jet engine: the roar of the exhaust (noise, bandpassed and lowpassed), a deep rumble, the
        // hiss of air at the intake, the turbine's whine (a cluster of high tones that rise with the
        // speed, with a slight waver) and, when boosting, the afterburner's crackling growl
        const loopNoise = (rate = 1) => {
            const src = ctx.createBufferSource();
            src.buffer = noise;
            src.loop = true;
            src.playbackRate.value = rate;
            src.start(0, Math.random() * 1.9);
            return src;
        };
        const roarF = ctx.createBiquadFilter();
        roarF.type = 'bandpass';
        roarF.Q.value = 0.55;
        roarF.frequency.value = 450;
        const roarL = ctx.createBiquadFilter();
        roarL.type = 'lowpass';
        roarL.frequency.value = 1200;
        const roarG = ctx.createGain();
        roarG.gain.value = 0;
        loopNoise().connect(roarF).connect(roarL).connect(roarG).connect(master);

        const rumbleF = ctx.createBiquadFilter();
        rumbleF.type = 'lowpass';
        rumbleF.frequency.value = 130;
        rumbleF.Q.value = 0.9;
        const rumbleG = ctx.createGain();
        rumbleG.gain.value = 0;
        loopNoise(0.7).connect(rumbleF).connect(rumbleG).connect(master);

        const hissF = ctx.createBiquadFilter();
        hissF.type = 'highpass';
        hissF.frequency.value = 5200;
        const hissG = ctx.createGain();
        hissG.gain.value = 0;
        loopNoise(1.3).connect(hissF).connect(hissG).connect(master);

        // the turbine: a few tones, wavering together
        const whineG = ctx.createGain();
        whineG.gain.value = 0;
        const whineF = ctx.createBiquadFilter();
        whineF.type = 'highpass';
        whineF.frequency.value = 900;
        whineF.connect(whineG).connect(master);
        const vib = ctx.createOscillator();
        vib.frequency.value = 5.5;
        const vibDepth = ctx.createGain();
        vibDepth.gain.value = 9;
        vib.connect(vibDepth);
        vib.start();
        const WHINE = [1650, 2480, 3710, 5200];
        const whines = WHINE.map((f, i) => {
            const o = ctx.createOscillator();
            o.type = i === 0 ? 'triangle' : 'sine';
            o.frequency.value = f;
            vibDepth.connect(o.frequency);
            const g = ctx.createGain();
            g.gain.value = [1, 0.55, 0.35, 0.18][i];
            o.connect(g).connect(whineF);
            o.start();
            return o;
        });

        // the afterburner: a low growl whose loudness jumps about (a slow random signal driving it)
        const burnF = ctx.createBiquadFilter();
        burnF.type = 'lowpass';
        burnF.frequency.value = 700;
        const burnAM = ctx.createGain();
        burnAM.gain.value = 0.55;
        const burnG = ctx.createGain();
        burnG.gain.value = 0;
        loopNoise(0.85).connect(burnF).connect(burnAM).connect(burnG).connect(master);
        const crackle = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.5), ctx.sampleRate);
        {
            const cd = crackle.getChannelData(0);
            let v = 0;
            let hold = 0;
            for (let i = 0; i < cd.length; i++) {
                if (hold-- <= 0) {
                    v = Math.random() * 2 - 1;
                    hold = Math.floor(ctx.sampleRate * (0.012 + Math.random() * 0.05));
                }
                cd[i] = v;
            }
        }
        const crackleSrc = ctx.createBufferSource();
        crackleSrc.buffer = crackle;
        crackleSrc.loop = true;
        const crackleDepth = ctx.createGain();
        crackleDepth.gain.value = 0.45;
        crackleSrc.connect(crackleDepth).connect(burnAM.gain);
        crackleSrc.start();

        engine = { roarF, roarL, roarG, rumbleF, rumbleG, hissG, whines, whineG, burnF, burnG };

        // the recorded hit on the fortress
        fetch(new URL('./sounds/hit-metal.mp3', import.meta.url))
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
            .then((b) => ctx.decodeAudioData(b))
            .then((buf) => {
                impact = buf;
            })
            .catch(() => {
                // no file: the synthesized clang stands in
            });
    };

    const env = (g, t, peak, attack, decay) => {
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(peak, t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    };

    const noiseBurst = (type, freq, freqEnd, q, peak, attack, decay, when = 0) => {
        if (!ctx) return;
        const t = ctx.currentTime + when;
        const src = ctx.createBufferSource();
        src.buffer = noise;
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.Q.value = q;
        f.frequency.setValueAtTime(freq, t);
        if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + attack + decay);
        const g = ctx.createGain();
        env(g, t, peak, attack, decay);
        src.connect(f).connect(g).connect(master);
        src.start(t, Math.random() * 1.5);
        src.stop(t + attack + decay + 0.05);
    };

    const tone = (type, freq, freqEnd, peak, attack, decay, when = 0) => {
        if (!ctx) return;
        const t = ctx.currentTime + when;
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(freq, t);
        if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + attack + decay);
        const g = ctx.createGain();
        env(g, t, peak, attack, decay);
        o.connect(g).connect(master);
        o.start(t);
        o.stop(t + attack + decay + 0.05);
    };

    return {
        get muted() {
            return muted;
        },
        // whether sound is actually playing (a browser starts it only after a click or a key)
        get running() {
            return ctx?.state === 'running';
        },
        // whether the recorded hit has loaded (for checking from the console)
        get sampleReady() {
            return !!impact;
        },
        unlock() {
            if (!ctx) build();
            if (ctx?.state === 'suspended') ctx.resume();
        },
        toggleMute() {
            muted = !muted;
            try {
                localStorage.setItem('meteor-canyon-muted', muted ? '1' : '0');
            } catch {
                // not remembered: fine
            }
            if (master) master.gain.setTargetAtTime(muted ? 0 : 0.75, ctx.currentTime, 0.05);
            return muted;
        },
        // level 0..1 (speed), boost 0..1, on 0..1 (flying at all): the jet spools up with the speed,
        // and the afterburner lights with the boost
        engine(level, boost, on) {
            if (!engine) return;
            const t = ctx.currentTime;
            const e = engine;
            e.roarF.frequency.setTargetAtTime(340 + level * 520 + boost * 260, t, 0.2);
            e.roarL.frequency.setTargetAtTime(900 + level * 1700 + boost * 1400, t, 0.2);
            e.roarG.gain.setTargetAtTime(on * (0.16 + level * 0.2 + boost * 0.14), t, 0.15);
            e.rumbleF.frequency.setTargetAtTime(110 + level * 60 + boost * 40, t, 0.2);
            e.rumbleG.gain.setTargetAtTime(on * (0.22 + level * 0.12 + boost * 0.22), t, 0.15);
            e.hissG.gain.setTargetAtTime(on * (0.015 + level * 0.03 + boost * 0.02), t, 0.15);
            const spool = 0.7 + level * 0.55 + boost * 0.22;
            e.whines.forEach((o, i) => o.frequency.setTargetAtTime([1650, 2480, 3710, 5200][i] * spool, t, 0.35));
            e.whineG.gain.setTargetAtTime(on * (0.012 + level * 0.014 + boost * 0.006), t, 0.25);
            e.burnF.frequency.setTargetAtTime(500 + boost * 500, t, 0.1);
            e.burnG.gain.setTargetAtTime(on * boost * 0.5, t, 0.08);
        },
        hit() {
            noiseBurst('lowpass', 1600, 200, 0.8, 0.9, 0.005, 0.45);
            tone('sine', 120, 38, 0.8, 0.005, 0.4);
            tone('square', 1900, 900, 0.05, 0.002, 0.12);
        },
        scrape() {
            noiseBurst('highpass', 2500, 3800, 0.6, 0.12, 0.01, 0.12);
        },
        // metal striking metal: a high, bright clang. Struck metal rings at several inharmonic tones
        // at once, the higher ones dying away sooner; a sharp click at the strike, and a quieter second
        // strike just after (the plates rattling). strength 0..1
        clang(strength = 1) {
            if (!ctx) return;
            // the recording, a little higher or lower each time so repeats do not sound the same
            if (impact) {
                const src = ctx.createBufferSource();
                src.buffer = impact;
                src.playbackRate.value = 0.94 + Math.random() * 0.12;
                const g = ctx.createGain();
                g.gain.value = 0.5 * strength;
                src.connect(g).connect(master);
                src.start();
                return;
            }
            const strike = (when, base, amp) => {
                const t = ctx.currentTime + when;
                const out = ctx.createGain();
                out.gain.value = amp;
                const hp = ctx.createBiquadFilter();
                hp.type = 'highpass';
                hp.frequency.value = 700;
                out.connect(hp).connect(master);
                const ratios = [1, 1.47, 2.09, 2.56, 3.21, 4.07, 5.12];
                const peaks = [0.5, 0.42, 0.34, 0.26, 0.2, 0.14, 0.08];
                const decays = [1.1, 0.8, 0.6, 0.45, 0.34, 0.24, 0.16];
                ratios.forEach((r, i) => {
                    const o = ctx.createOscillator();
                    o.type = 'sine';
                    o.frequency.value = base * r * (1 + (Math.random() - 0.5) * 0.012);
                    const g = ctx.createGain();
                    g.gain.setValueAtTime(0.0001, t);
                    g.gain.exponentialRampToValueAtTime(peaks[i], t + 0.0015);
                    g.gain.exponentialRampToValueAtTime(0.0001, t + decays[i] * (0.6 + 0.4 * strength));
                    o.connect(g).connect(out);
                    o.start(t);
                    o.stop(t + decays[i] + 0.05);
                });
            };
            const base = 1700 + Math.random() * 900;
            strike(0, base, 0.42 * strength);
            strike(0.03 + Math.random() * 0.03, base * (1.04 + Math.random() * 0.05), 0.18 * strength);
            // the strike's click
            noiseBurst('bandpass', 6500, 3500, 1.4, 0.55 * strength, 0.001, 0.05);
        },
        // metal sliding on metal: a short, ringing screech
        screech() {
            const f = 2600 + Math.random() * 1800;
            noiseBurst('bandpass', f, f * 0.88, 6, 1.6, 0.008, 0.16);
            noiseBurst('bandpass', f * 1.52, f * 1.4, 6, 0.9, 0.008, 0.12);
        },
        near(combo) {
            noiseBurst('bandpass', 3200, 500, 1.2, 0.35, 0.01, 0.3);
            tone('triangle', 880 * Math.pow(1.122, Math.min(combo, 8) - 1), 0, 0.12, 0.005, 0.18, 0.05);
        },
        boom(dist) {
            const k = Math.max(0.05, 1 - dist / 220);
            noiseBurst('lowpass', 420, 60, 0.7, 0.9 * k, 0.01, 1.4);
            tone('sine', 70, 30, 0.6 * k, 0.01, 0.9);
        },
        explode() {
            noiseBurst('lowpass', 2400, 80, 0.6, 1.0, 0.005, 2.0);
            tone('sine', 90, 25, 1.0, 0.005, 1.4);
            noiseBurst('bandpass', 1800, 400, 1.5, 0.3, 0.05, 0.9, 0.12);
        },
        // a comet sweeping in: a rising shimmer
        comet() {
            noiseBurst('bandpass', 900, 5200, 2.5, 0.25, 0.4, 0.9);
            tone('sine', 1320, 1760, 0.05, 0.3, 0.6);
            tone('sine', 1980, 2640, 0.03, 0.3, 0.6, 0.08);
        },
        warn() {
            tone('square', 880, 0, 0.06, 0.005, 0.12);
            tone('square', 660, 0, 0.06, 0.005, 0.12, 0.16);
        },
        beep(high) {
            tone('square', high ? 1320 : 660, 0, 0.1, 0.005, high ? 0.4 : 0.16);
        }
    };
};
