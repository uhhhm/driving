// "SEED FM": a procedural synthwave radio. The progression comes from the world seed; layers
// react to driving (speed → drums, combo → arpeggio lead, police → tense variation).
import { audio } from './AudioEngine';
import { RNG } from '../core/rng';

const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};
const PROGS = [
  [0, 5, 3, 4],
  [0, 3, 5, 4],
  [0, 6, 5, 4],
  [0, 5, 6, 4],
  [0, 2, 5, 4],
];

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

export class Radio {
  enabled = true;
  private ctx: AudioContext | null = null;
  private out!: GainNode;
  private nextTime = 0;
  private step = 0;
  private timer = 0;
  private bpm = 108;
  private root = 45;
  private scale: number[] = SCALES.minor;
  private prog: number[] = PROGS[0];
  private noise!: AudioBuffer;
  private delay!: DelayNode;
  // live inputs
  intensity = 0; // 0..1 speed-ish
  lead = 0; // 0..1 combo-ish
  tension = 0; // police
  volume = 0.35;

  configure(seed: number) {
    const r = new RNG(seed ^ 0x5eed);
    this.root = 40 + r.int(0, 9);
    this.scale = [SCALES.minor, SCALES.dorian, SCALES.phrygian][r.int(0, 2)];
    this.prog = PROGS[r.int(0, PROGS.length - 1)];
    this.bpm = 100 + r.int(0, 20);
  }

  start() {
    if (this.ctx || !audio.ctx) return;
    const ctx = audio.ctx;
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = this.enabled ? this.volume : 0;
    // tape-ish echo
    this.delay = ctx.createDelay(1);
    this.delay.delayTime.value = (60 / this.bpm) * 0.75;
    const fb = ctx.createGain();
    fb.gain.value = 0.28;
    const dl = ctx.createBiquadFilter();
    dl.type = 'lowpass';
    dl.frequency.value = 2200;
    this.delay.connect(dl).connect(fb).connect(this.delay);
    dl.connect(this.out);
    this.out.connect(audio.master);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.nextTime = ctx.currentTime + 0.1;
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.out) this.out.gain.setTargetAtTime(on ? this.volume : 0, this.ctx!.currentTime, 0.3);
  }

  private schedule() {
    const ctx = this.ctx!;
    const spb = 60 / (this.bpm + this.tension * 22) / 4; // 16th notes
    while (this.nextTime < ctx.currentTime + 0.12) {
      this.playStep(this.step, this.nextTime, spb);
      this.nextTime += spb;
      this.step = (this.step + 1) % 256;
    }
  }

  private chordTones(bar: number): number[] {
    const deg = this.prog[bar % 4];
    const sc = this.scale;
    const n = (i: number) => this.root + sc[(deg + i) % 7] + 12 * Math.floor((deg + i) / 7);
    return [n(0), n(2), n(4), n(6)];
  }

  private playStep(step: number, t: number, spb: number) {
    const s16 = step % 16;
    const bar = Math.floor(step / 16);
    const ch = this.chordTones(bar);
    const I = this.intensity;
    // pad: on each bar
    if (s16 === 0) for (const n of ch.slice(0, 3)) this.pad(midi(n + 12), t, spb * 16);
    // bass: driving 8ths, octave jumps
    if (s16 % 2 === 0) this.bass(midi(ch[0] - 12 + (s16 % 8 === 6 ? 12 : 0)), t, spb * 1.6, 0.18 + I * 0.1);
    // drums by intensity
    if (I > 0.25) {
      if (s16 % 4 === 0) this.kick(t);
      if (s16 === 4 || s16 === 12) this.snare(t);
      if (s16 % 2 === 1 || (I > 0.7 && s16 % 2 === 0)) this.hat(t, s16 % 4 === 2 ? 0.05 : 0.03);
    } else if (s16 === 0) this.kick(t, 0.5);
    // lead arpeggio
    if (this.lead > 0.2 || this.tension > 0.5) {
      const pat = [0, 1, 2, 3, 2, 1, 2, 3];
      if (s16 % 2 === 0) {
        const n = ch[pat[(s16 / 2) % 8]] + 24 + (this.tension > 0.5 && s16 % 8 === 4 ? 1 : 0);
        this.pluck(midi(n), t, spb * 1.8, 0.05 + this.lead * 0.04);
      }
    }
  }

  private env(g: GainNode, t: number, a: number, peak: number, dur: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  private osc(type: OscillatorType, f: number, t: number, dur: number, peak: number, attack: number, cutoff: number, toDelay = false, detune = 0) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.detune.value = detune;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    const g = ctx.createGain();
    this.env(g, t, attack, peak, dur);
    o.connect(lp).connect(g).connect(this.out);
    if (toDelay) g.connect(this.delay);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private pad(f: number, t: number, dur: number) {
    for (const det of [-9, 8]) this.osc('sawtooth', f, t, dur, 0.028, dur * 0.35, 900 + this.intensity * 900, true, det);
  }
  private bass(f: number, t: number, dur: number, v: number) {
    this.osc('sawtooth', f, t, dur, v, 0.005, 380 + this.intensity * 500);
    this.osc('square', f / 2, t, dur, v * 0.5, 0.005, 200);
  }
  private pluck(f: number, t: number, dur: number, v: number) {
    this.osc('square', f, t, dur, v, 0.003, 2400, true);
  }
  private kick(t: number, v = 1) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    const g = ctx.createGain();
    this.env(g, t, 0.002, 0.5 * v, 0.25);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.3);
  }
  private noiseHit(t: number, type: BiquadFilterType, f: number, peak: number, dur: number) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const fl = ctx.createBiquadFilter();
    fl.type = type;
    fl.frequency.value = f;
    const g = ctx.createGain();
    this.env(g, t, 0.002, peak, dur);
    s.connect(fl).connect(g).connect(this.out);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
  }
  private snare(t: number) {
    this.noiseHit(t, 'bandpass', 1800, 0.22, 0.18);
    this.osc('triangle', 190, t, 0.1, 0.12, 0.002, 2000);
  }
  private hat(t: number, v: number) {
    this.noiseHit(t, 'highpass', 7000, v, 0.05);
  }

  update(dt: number, speedKmh: number, mult: number, police: boolean) {
    const k = 1 - Math.exp(-dt * 0.8);
    this.intensity += (Math.min(1, Math.max(0, (speedKmh - 30) / 140)) - this.intensity) * k;
    this.lead += (Math.min(1, (mult - 1) / 5) - this.lead) * k * 2;
    this.tension += ((police ? 1 : 0) - this.tension) * k;
  }
}

export const radio = new Radio();
