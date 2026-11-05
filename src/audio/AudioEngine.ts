// Procedural Web Audio: engine synth, tyres, wind, surface, crashes, sirens, ambience, UI blips.
import { clamp } from '../core/rng';

export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  private sfx!: GainNode;
  private comp!: DynamicsCompressorNode;
  private noiseBuf!: AudioBuffer;
  // engine
  private engOsc: OscillatorNode[] = [];
  private engGain!: GainNode;
  private engFilter!: BiquadFilterNode;
  private engShaper!: WaveShaperNode;
  private engLfo!: OscillatorNode;
  private engLfoGain!: GainNode;
  private intakeNoise!: AudioBufferSourceNode;
  private intakeGain!: GainNode;
  private intakeFilter!: BiquadFilterNode;
  // tyres
  private squealOsc!: OscillatorNode;
  private squealGain!: GainNode;
  private squealNoiseGain!: GainNode;
  private squealFilter!: BiquadFilterNode;
  private gravelGain!: GainNode;
  private gravelFilter!: BiquadFilterNode;
  // wind
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  // boost
  private boostGain!: GainNode;
  private boostFilter!: BiquadFilterNode;
  // rain / ambience
  private rainGain!: GainNode;
  private ambGain!: GainNode;
  private ambFilter!: BiquadFilterNode;
  private waveGain!: GainNode;
  // sirens
  private sirenOsc!: OscillatorNode;
  private sirenGain!: GainNode;
  private sirenLfo!: OscillatorNode;
  cylinders = 4;
  pitch = 1;
  volume = 0.8;
  muted = false;
  private lastPop = 0;
  private birdTimer = 0;

  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.ratio.value = 6;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.comp.connect(this.master);
    this.master.connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.comp);
    // white noise buffer
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // ---- engine ----
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.Q.value = 2.5;
    this.engShaper = ctx.createWaveShaper();
    this.engShaper.curve = this.makeDistortion(18);
    const engMix = ctx.createGain();
    engMix.gain.value = 0.35;
    const types: OscillatorType[] = ['sawtooth', 'square', 'sawtooth', 'triangle'];
    const gains = [0.6, 0.45, 0.25, 0.5];
    for (let i = 0; i < 4; i++) {
      const o = ctx.createOscillator();
      o.type = types[i];
      const g = ctx.createGain();
      g.gain.value = gains[i];
      o.connect(g).connect(engMix);
      o.start();
      this.engOsc.push(o);
    }
    // lumpy cam: amplitude modulation
    this.engLfo = ctx.createOscillator();
    this.engLfo.type = 'sine';
    this.engLfoGain = ctx.createGain();
    this.engLfoGain.gain.value = 0.25;
    const amp = ctx.createGain();
    amp.gain.value = 0.8;
    this.engLfo.connect(this.engLfoGain).connect(amp.gain);
    this.engLfo.start();
    engMix.connect(this.engShaper).connect(amp).connect(this.engFilter).connect(this.engGain).connect(this.comp);
    // intake / turbo whoosh
    this.intakeNoise = this.noiseSource(true);
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.Q.value = 3;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    this.intakeNoise.connect(this.intakeFilter).connect(this.intakeGain).connect(this.comp);

    // ---- tyre squeal ----
    this.squealOsc = ctx.createOscillator();
    this.squealOsc.type = 'triangle';
    this.squealOsc.frequency.value = 820;
    const vib = ctx.createOscillator();
    vib.frequency.value = 13;
    const vibG = ctx.createGain();
    vibG.gain.value = 30;
    vib.connect(vibG).connect(this.squealOsc.frequency);
    vib.start();
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = 'bandpass';
    this.squealFilter.frequency.value = 1400;
    this.squealFilter.Q.value = 2;
    this.squealOsc.connect(this.squealGain).connect(this.comp);
    this.squealOsc.start();
    const sn = this.noiseSource(true);
    this.squealNoiseGain = ctx.createGain();
    this.squealNoiseGain.gain.value = 0;
    sn.connect(this.squealFilter).connect(this.squealNoiseGain).connect(this.comp);

    // gravel / off-road rumble
    const gn = this.noiseSource(true);
    this.gravelFilter = ctx.createBiquadFilter();
    this.gravelFilter.type = 'lowpass';
    this.gravelFilter.frequency.value = 600;
    this.gravelGain = ctx.createGain();
    this.gravelGain.gain.value = 0;
    gn.connect(this.gravelFilter).connect(this.gravelGain).connect(this.comp);

    // wind
    const wn = this.noiseSource(true);
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wn.connect(this.windFilter).connect(this.windGain).connect(this.comp);

    // boost jet
    const bn = this.noiseSource(true);
    this.boostFilter = ctx.createBiquadFilter();
    this.boostFilter.type = 'lowpass';
    this.boostFilter.frequency.value = 900;
    this.boostGain = ctx.createGain();
    this.boostGain.gain.value = 0;
    bn.connect(this.boostFilter).connect(this.boostGain).connect(this.comp);

    // rain
    const rn = this.noiseSource(true);
    const rf = ctx.createBiquadFilter();
    rf.type = 'highpass';
    rf.frequency.value = 1500;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rn.connect(rf).connect(this.rainGain).connect(this.comp);

    // ambience bed (filtered noise: wind in desert / city hum)
    const an = this.noiseSource(true);
    this.ambFilter = ctx.createBiquadFilter();
    this.ambFilter.type = 'lowpass';
    this.ambFilter.frequency.value = 300;
    this.ambGain = ctx.createGain();
    this.ambGain.gain.value = 0;
    an.connect(this.ambFilter).connect(this.ambGain).connect(this.comp);
    // ocean waves (slow LFO on lowpassed noise)
    const on = this.noiseSource(true);
    const of = ctx.createBiquadFilter();
    of.type = 'lowpass';
    of.frequency.value = 500;
    this.waveGain = ctx.createGain();
    this.waveGain.gain.value = 0;
    const waveLfo = ctx.createOscillator();
    waveLfo.frequency.value = 0.12;
    const waveLfoG = ctx.createGain();
    waveLfoG.gain.value = 0.5;
    const waveAmp = ctx.createGain();
    waveAmp.gain.value = 0.5;
    waveLfo.connect(waveLfoG).connect(waveAmp.gain);
    waveLfo.start();
    on.connect(of).connect(waveAmp).connect(this.waveGain).connect(this.comp);

    // siren
    this.sirenOsc = ctx.createOscillator();
    this.sirenOsc.type = 'square';
    this.sirenOsc.frequency.value = 700;
    this.sirenLfo = ctx.createOscillator();
    this.sirenLfo.type = 'square';
    this.sirenLfo.frequency.value = 1.6;
    const slg = ctx.createGain();
    slg.gain.value = 130;
    this.sirenLfo.connect(slg).connect(this.sirenOsc.frequency);
    this.sirenLfo.start();
    const sf = ctx.createBiquadFilter();
    sf.type = 'lowpass';
    sf.frequency.value = 2200;
    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenOsc.connect(sf).connect(this.sirenGain).connect(this.comp);
    this.sirenOsc.start();
  }

  private makeDistortion(k: number) {
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  private noiseSource(loop: boolean): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = loop;
    s.loopStart = Math.random();
    s.start(0, Math.random() * 1.5);
    return s;
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  setCar(cylinders: number, pitch: number) {
    this.cylinders = cylinders;
    this.pitch = pitch;
  }

  /** Called every frame with vehicle state. */
  update(s: {
    rpm: number;
    redline: number;
    throttle: number;
    speed: number;
    slip: number;
    offroad: number;
    boosting: boolean;
    grounded: boolean;
    timeScale: number;
    rain: number;
    biome: Float32Array;
    night: number;
    siren: number;
    sirenDist: number;
    shifting: boolean;
    limiter: boolean;
  }) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const ts = clamp(s.timeScale, 0.25, 1);
    const set = (p: AudioParam, v: number, tc = 0.05) => p.setTargetAtTime(v, t, tc);
    // engine: firing frequency
    const fire = (s.rpm / 60) * (this.cylinders / 2) * this.pitch * 0.5 * ts;
    const f = Math.max(18, fire);
    set(this.engOsc[0].frequency, f, 0.02);
    set(this.engOsc[1].frequency, f * 0.5, 0.02);
    set(this.engOsc[2].frequency, f * 2.01, 0.02);
    set(this.engOsc[3].frequency, f * 0.25, 0.02);
    set(this.engLfo.frequency, (s.rpm / 60) * 0.5, 0.05);
    set(this.engLfoGain.gain, this.cylinders >= 8 ? 0.45 * (1 - s.rpm / s.redline) : 0.15, 0.1);
    const load = s.shifting ? 0.15 : s.throttle;
    const r = s.rpm / s.redline;
    set(this.engFilter.frequency, 280 + r * 2400 + load * 1600, 0.04);
    set(this.engGain.gain, (0.22 + load * 0.3 + r * 0.15) * (s.limiter ? 0.7 + Math.random() * 0.3 : 1), 0.03);
    set(this.intakeFilter.frequency, 800 + r * 3000, 0.05);
    set(this.intakeGain.gain, load * r * 0.08, 0.05);

    // backfire pops on lift-off at high rpm
    if (s.throttle < 0.1 && r > 0.55 && t - this.lastPop > 0.08 && Math.random() < 0.35) {
      this.lastPop = t;
      this.pop(0.25 + Math.random() * 0.3);
    }

    // tyres
    const sq = clamp((s.slip - 0.15) * 1.3, 0, 1) * (1 - s.offroad) * (s.grounded ? 1 : 0);
    set(this.squealGain.gain, sq * 0.09, 0.04);
    set(this.squealNoiseGain.gain, sq * 0.22, 0.04);
    set(this.squealOsc.frequency, (760 + s.slip * 260) * ts, 0.08);
    const gr = s.offroad * clamp(s.speed / 25, 0, 1) * (s.grounded ? 1 : 0);
    set(this.gravelGain.gain, gr * 0.35 + s.offroad * clamp(s.slip, 0, 1) * 0.2, 0.06);
    set(this.gravelFilter.frequency, 300 + s.speed * 20, 0.1);
    // wind
    const w = clamp(s.speed / 75, 0, 1);
    set(this.windGain.gain, w * w * 0.55 + (s.grounded ? 0 : 0.1), 0.15);
    set(this.windFilter.frequency, 300 + w * 1600, 0.2);
    // boost
    set(this.boostGain.gain, s.boosting ? 0.55 : 0, s.boosting ? 0.03 : 0.25);
    set(this.boostFilter.frequency, s.boosting ? 1800 : 400, 0.3);
    // weather & ambience
    set(this.rainGain.gain, s.rain * 0.22, 0.5);
    const city = s.biome[2];
    const desert = s.biome[0];
    const coast = s.biome[3];
    set(this.ambGain.gain, (desert * 0.12 + city * 0.1) * (1 - w * 0.5), 0.8);
    set(this.ambFilter.frequency, city > 0.5 ? 140 : 380, 1);
    set(this.waveGain.gain, coast * 0.28 * (1 - w * 0.4), 1);
    // siren
    const sv = s.siren * clamp(1 - s.sirenDist / 350, 0, 1);
    set(this.sirenGain.gain, sv * 0.09, 0.1);

    // birds in forest/coast during day
    this.birdTimer -= 1 / 60;
    if (this.birdTimer <= 0) {
      this.birdTimer = 0.6 + Math.random() * 2.5;
      const nature = (s.biome[1] + s.biome[3]) * (1 - s.night) * (1 - s.rain);
      if (Math.random() < nature * 0.8 && s.speed < 40) this.chirp(0.04 * nature);
      if (s.night > 0.6 && Math.random() < 0.5 * (1 - city)) this.cricket(0.02);
    }
  }

  // ---------------- one-shots ----------------
  private env(g: GainNode, attack: number, peak: number, decay: number) {
    const t = this.ctx!.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private burst(dur: number, filterType: BiquadFilterType, freq: number, q: number, peak: number, sweepTo?: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, ctx.currentTime + dur);
    const g = ctx.createGain();
    src.connect(f).connect(g).connect(this.sfx);
    this.env(g, 0.005, peak, dur);
    src.start(0, Math.random());
    src.stop(ctx.currentTime + dur + 0.1);
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, peak: number, delay = 0) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    const t = ctx.currentTime + delay;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  pop(v: number) {
    if (!this.ctx) return;
    this.burst(0.07, 'lowpass', 900, 1, v);
    this.tone('square', 90, 40, 0.06, v * 0.4);
  }

  shift(up: boolean) {
    if (!this.ctx) return;
    if (up) this.burst(0.18, 'highpass', 2500, 0.7, 0.12, 6000); // blow-off
    this.tone('sine', 140, 60, 0.05, 0.15);
  }

  crash(intensity: number) {
    if (!this.ctx) return;
    const k = clamp(intensity, 0.1, 1.5);
    this.tone('sine', 140, 35, 0.35 + k * 0.3, 0.6 * k); // thump
    this.burst(0.25 + k * 0.4, 'bandpass', 1800, 0.8, 0.5 * k, 400); // crunch
    this.burst(0.12, 'highpass', 4000, 0.5, 0.25 * k); // snap
    const clanks = Math.floor(2 + k * 5);
    for (let i = 0; i < clanks; i++) {
      this.tone('square', 300 + Math.random() * 900, 120, 0.08 + Math.random() * 0.15, 0.06 * k, Math.random() * 0.35);
    }
    if (k > 0.6) for (let i = 0; i < 6; i++) this.tone('sine', 3000 + Math.random() * 4000, 2500, 0.05, 0.04, 0.05 + Math.random() * 0.3); // glass
  }

  thud(v: number) {
    if (!this.ctx) return;
    this.tone('sine', 90, 40, 0.18, clamp(v, 0, 0.6));
    this.burst(0.08, 'lowpass', 500, 1, v * 0.5);
  }

  smash(kind: string) {
    if (!this.ctx) return;
    if (kind === 'wood') {
      this.burst(0.25, 'bandpass', 900, 1.2, 0.4, 300);
      this.tone('triangle', 220, 90, 0.12, 0.2);
    } else if (kind === 'plastic') {
      this.burst(0.12, 'bandpass', 1600, 1.5, 0.3);
      this.tone('square', 500, 250, 0.06, 0.08);
    } else if (kind === 'metal') {
      this.burst(0.2, 'bandpass', 2200, 2, 0.35);
      for (let i = 0; i < 3; i++) this.tone('square', 600 + Math.random() * 1200, 300, 0.2, 0.06, i * 0.05);
    } else {
      this.burst(0.2, 'lowpass', 600, 1, 0.3);
    }
  }

  explosion(power: number) {
    if (!this.ctx) return;
    this.tone('sine', 80, 20, 1.6, 0.9 * power);
    this.burst(1.8, 'lowpass', 2500, 0.7, 0.9 * power, 120);
    this.burst(0.4, 'highpass', 1500, 0.5, 0.4 * power);
  }

  whoosh(v: number) {
    if (!this.ctx) return;
    this.burst(0.45, 'bandpass', 500, 1.2, 0.35 * v, 2200);
  }

  landing(v: number) {
    if (!this.ctx) return;
    this.tone('sine', 110, 40, 0.25, clamp(v, 0, 0.8));
    this.burst(0.15, 'lowpass', 400, 1, clamp(v, 0, 0.6));
  }

  boostKick() {
    if (!this.ctx) return;
    this.tone('sawtooth', 60, 200, 0.35, 0.25);
    this.burst(0.6, 'lowpass', 300, 1, 0.5, 3000);
  }

  ping(mult: number) {
    if (!this.ctx) return;
    const base = 520 * Math.pow(1.06, Math.min(24, mult));
    this.tone('triangle', base, base * 1.01, 0.12, 0.12);
    this.tone('sine', base * 2, base * 2, 0.08, 0.05, 0.03);
  }

  chime(big: boolean) {
    if (!this.ctx) return;
    const notes = big ? [523, 659, 784, 1046] : [659, 988];
    notes.forEach((n, i) => this.tone('triangle', n, n, 0.35, 0.12, i * 0.07));
  }

  fail() {
    if (!this.ctx) return;
    [392, 330, 262].forEach((n, i) => this.tone('sawtooth', n, n * 0.98, 0.25, 0.08, i * 0.12));
  }

  horn() {
    if (!this.ctx) return;
    this.tone('sawtooth', 415, 410, 0.4, 0.15);
    this.tone('sawtooth', 523, 520, 0.4, 0.12);
  }

  trafficHonk(dist: number) {
    if (!this.ctx) return;
    const v = clamp(1 - dist / 60, 0, 1) * 0.12;
    if (v < 0.01) return;
    const f = 300 + Math.random() * 200;
    this.tone('square', f, f, 0.35, v);
    this.tone('square', f * 1.26, f * 1.26, 0.35, v * 0.7);
  }

  thunder() {
    if (!this.ctx) return;
    this.burst(3.5, 'lowpass', 300, 0.5, 0.7, 60);
    this.tone('sine', 50, 25, 2.5, 0.4, 0.1);
  }

  private chirp(v: number) {
    const base = 2200 + Math.random() * 1800;
    const n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) this.tone('sine', base, base * (1.2 + Math.random() * 0.3), 0.07, v, i * 0.11);
  }

  private cricket(v: number) {
    for (let i = 0; i < 4; i++) this.tone('square', 4200, 4100, 0.025, v, i * 0.05);
  }

  /** Big flock flap when birds scatter. */
  flap() {
    if (!this.ctx) return;
    for (let i = 0; i < 8; i++) this.burst(0.06, 'bandpass', 700 + Math.random() * 500, 2, 0.08, undefined);
  }
}

export const audio = new AudioEngine();
