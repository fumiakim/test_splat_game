// audio.js — 効果音とエンジン音（Web Audio で合成。音声ファイルは使わない）。
// ブラウザの決まりで、最初のキーやタップのあとに unlock() してから鳴る。

export const createAudio = () => {
    let ctx = null;
    let master = null;
    let noise = null;
    let engine = null;
    let muted = false;
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

        // engine: wind rushing past, a low hum and a turbine whine
        const windSrc = ctx.createBufferSource();
        windSrc.buffer = noise;
        windSrc.loop = true;
        const windF = ctx.createBiquadFilter();
        windF.type = 'bandpass';
        windF.Q.value = 0.7;
        windF.frequency.value = 500;
        const windG = ctx.createGain();
        windG.gain.value = 0;
        windSrc.connect(windF).connect(windG).connect(master);
        windSrc.start();

        const humG = ctx.createGain();
        humG.gain.value = 0;
        const humF = ctx.createBiquadFilter();
        humF.type = 'lowpass';
        humF.frequency.value = 300;
        humF.connect(humG).connect(master);
        const hums = [55, 55.6, 110.4].map((f) => {
            const o = ctx.createOscillator();
            o.type = 'sawtooth';
            o.frequency.value = f;
            o.connect(humF);
            o.start();
            return o;
        });

        const whine = ctx.createOscillator();
        whine.type = 'sine';
        whine.frequency.value = 300;
        const whineG = ctx.createGain();
        whineG.gain.value = 0;
        whine.connect(whineG).connect(master);
        whine.start();

        engine = { windF, windG, humF, humG, hums, whine, whineG };
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
        // level 0..1 (speed), boost 0..1, on 0..1 (flying at all)
        engine(level, boost, on) {
            if (!engine) return;
            const t = ctx.currentTime;
            const e = engine;
            e.windF.frequency.setTargetAtTime(400 + level * 1400 + boost * 900, t, 0.15);
            e.windG.gain.setTargetAtTime(on * (0.05 + level * 0.12 + boost * 0.08), t, 0.15);
            e.humF.frequency.setTargetAtTime(180 + level * 260 + boost * 400, t, 0.2);
            e.humG.gain.setTargetAtTime(on * (0.05 + boost * 0.04), t, 0.2);
            const pitch = 1 + level * 0.35 + boost * 0.3;
            e.hums.forEach((o, i) => o.frequency.setTargetAtTime([55, 55.6, 110.4][i] * pitch, t, 0.2));
            e.whine.frequency.setTargetAtTime(380 + level * 420 + boost * 500, t, 0.2);
            e.whineG.gain.setTargetAtTime(on * (0.008 + boost * 0.012), t, 0.2);
        },
        hit() {
            noiseBurst('lowpass', 1600, 200, 0.8, 0.9, 0.005, 0.45);
            tone('sine', 120, 38, 0.8, 0.005, 0.4);
            tone('square', 1900, 900, 0.05, 0.002, 0.12);
        },
        scrape() {
            noiseBurst('highpass', 2500, 3800, 0.6, 0.12, 0.01, 0.12);
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
