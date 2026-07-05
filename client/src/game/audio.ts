import * as THREE from 'three';

// Shared across all AudioManager instances/races. Browsers cap the number of
// concurrent AudioContexts, and autoplay policy requires the context be
// created/resumed from a user-gesture handler. We build it once, lazily, on
// the first gesture and reuse it for every subsequent race/rematch instead of
// constructing a fresh (born-suspended, potentially silent) context each time.
let sharedCtx: AudioContext | null = null;

/** Construct the shared AudioContext on demand and resume it if suspended. */
function ensureContext(): AudioContext | null {
  if (!sharedCtx) {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    sharedCtx = new Ctx();
  }
  if (sharedCtx.state === 'suspended') void sharedCtx.resume();
  return sharedCtx;
}

/**
 * 5-gear virtual RPM model for the engine sound. Pure function (no
 * AudioContext access) so it's directly unit-testable.
 *
 * Gears have overlapping bands over the 0..1 speedRatio range; within a
 * gear's band, rpm rises from 0.3 to 1.0. We pick the HIGHEST gear whose
 * band contains the ratio, which means as speed climbs, the engine "shifts
 * up" at the top of each band and rpm visibly drops back down into the next
 * gear's (lower) bandProgress — the classic arcade sawtooth.
 */
const GEAR_BANDS: ReadonlyArray<readonly [number, number]> = [
  [0, 0.18],
  [0.14, 0.34],
  [0.3, 0.52],
  [0.48, 0.74],
  [0.7, 1.0],
];

export function gearRpm(speedRatio: number): { rpm: number; gear: number } {
  const r = clamp01(speedRatio);
  if (r < 0.02) return { rpm: 0.22, gear: 1 };

  let gear = 1;
  for (let g = GEAR_BANDS.length; g >= 1; g--) {
    const [lo, hi] = GEAR_BANDS[g - 1];
    if (r >= lo && r <= hi) {
      gear = g;
      break;
    }
  }

  const [lo, hi] = GEAR_BANDS[gear - 1];
  const bandProgress = clamp01((r - lo) / (hi - lo));
  const rpm = 0.3 + 0.7 * bandProgress;
  return { rpm, gear };
}

/**
 * Web Audio soundscape built on a shared, gesture-gated AudioContext. The
 * node graph is (re)built on `unlock()`, called from a user-gesture handler
 * in main.ts (autoplay policy). Every public method no-ops safely before
 * unlock so callers never need to guard.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  // engine
  private engineOsc: OscillatorNode | null = null;
  private engineDetuneOsc: OscillatorNode | null = null;
  private engineSubOsc: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;
  private vibratoOsc: OscillatorNode | null = null;
  private vibratoGain: GainNode | null = null;
  private engineRpm = 0.22; // smoothed virtual-gear RPM (0..1), starts at idle
  private lastGear = 1;
  private lastShiftAt = -Infinity;
  private lastEngineUpdateAt: number | null = null;

  // wind
  private windSource: AudioBufferSourceNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;

  // crowd bed
  private crowdSource: AudioBufferSourceNode | null = null;
  private crowdFilter: BiquadFilterNode | null = null;
  private crowdGain: GainNode | null = null;
  private crowdSources: THREE.Vector3[] = [];
  private nextCheerAt = 0;

  muted = false;

  /**
   * Get (or create) the shared AudioContext and, on first call for this
   * instance, build this instance's node graph on it. Idempotent and safe
   * to call repeatedly — each call re-attempts resume() if suspended.
   */
  unlock(): void {
    const ctx = ensureContext();
    if (!ctx) return;
    this.ctx = ctx;

    if (this.master) return; // node graph already built for this instance

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(ctx.destination);

    this.buildEngine();
    this.buildWind();
    this.buildCrowd();

    (window as unknown as { __audioDebug?: () => { state: string; muted: boolean } }).__audioDebug = () => ({
      state: this.ctx?.state ?? 'closed',
      muted: this.muted,
    });
  }

  private buildEngine(): void {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.value = 0.07;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 350;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 55 + 0.22 * 210;

    // Second, slightly detuned saw layered on the main osc for thickness.
    const detuneOsc = ctx.createOscillator();
    detuneOsc.type = 'sawtooth';
    detuneOsc.frequency.value = osc.frequency.value + 6;

    const sub = ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.value = (55 + 0.22 * 210) / 2;

    // Gentle vibrato LFO modulating the main osc's frequency.
    const vibratoOsc = ctx.createOscillator();
    vibratoOsc.type = 'sine';
    vibratoOsc.frequency.value = 4.5;
    const vibratoGain = ctx.createGain();
    vibratoGain.gain.value = 2.5; // +/- 2.5 Hz depth
    vibratoOsc.connect(vibratoGain);
    vibratoGain.connect(osc.frequency);
    vibratoGain.connect(detuneOsc.frequency);

    osc.connect(filter);
    detuneOsc.connect(filter);
    sub.connect(filter);
    filter.connect(gain);
    gain.connect(this.master!);

    osc.start();
    detuneOsc.start();
    sub.start();
    vibratoOsc.start();

    this.engineOsc = osc;
    this.engineDetuneOsc = detuneOsc;
    this.engineSubOsc = sub;
    this.engineFilter = filter;
    this.engineGain = gain;
    this.vibratoOsc = vibratoOsc;
    this.vibratoGain = vibratoGain;
  }

  private buildWind(): void {
    const ctx = this.ctx!;
    const buffer = renderWhiteNoise(ctx, 2);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 480;
    filter.Q.value = 0.8;

    const gain = ctx.createGain();
    gain.gain.value = 0; // silent at rest

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master!);
    source.start();

    this.windSource = source;
    this.windFilter = filter;
    this.windGain = gain;
  }

  private buildCrowd(): void {
    const ctx = this.ctx!;
    const buffer = renderPinkNoise(ctx, 2);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;

    const gain = ctx.createGain();
    gain.gain.value = 0.015;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master!);
    source.start();

    this.crowdSource = source;
    this.crowdFilter = filter;
    this.crowdGain = gain;
    this.nextCheerAt = ctx.currentTime + 3 + Math.random() * 4;
  }

  /**
   * Engine note per frame. speedRatio 0..1, turbo boosts pitch/gain.
   *
   * Drives a virtual 5-gear RPM model (see `gearRpm`): rpm glides toward its
   * per-gear target, and gear changes both dip the RPM (producing the
   * audible climb-drop-climb "shift" sawtooth) and briefly duck the gain.
   * Also updates the wind noise layer, which scales with speed only.
   */
  engine(speedRatio: number, turbo: boolean): void {
    if (
      !this.ctx ||
      !this.engineOsc ||
      !this.engineDetuneOsc ||
      !this.engineSubOsc ||
      !this.engineFilter ||
      !this.engineGain
    ) {
      return;
    }
    const r = clamp01(speedRatio);
    const boost = turbo ? 1.25 : 1;
    const t = this.ctx.currentTime;

    const { rpm: targetRpm, gear } = gearRpm(r);

    if (gear !== this.lastGear) {
      this.lastGear = gear;
      this.lastShiftAt = t;
    }
    // Smooth the RPM toward its target at a ~6/s rate (frame-rate independent),
    // so upshifts audibly dip before climbing again instead of snapping instantly.
    const dt = this.lastEngineUpdateAt === null ? 1 / 60 : Math.max(0, Math.min(0.25, t - this.lastEngineUpdateAt));
    this.lastEngineUpdateAt = t;
    const rpmLerp = 1 - Math.exp(-6 * dt);
    this.engineRpm += (targetRpm - this.engineRpm) * rpmLerp;

    const rpm = this.engineRpm;
    const freq = (55 + rpm * 210) * boost;
    this.engineOsc.frequency.setTargetAtTime(freq, t, 0.05);
    this.engineDetuneOsc.frequency.setTargetAtTime(freq + 6, t, 0.05);
    this.engineSubOsc.frequency.setTargetAtTime(freq / 2, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(350 + rpm * 2600 + (turbo ? 600 : 0), t, 0.05);

    const baseGain = 0.07 + rpm * (0.15 - 0.07);
    const sinceShift = t - this.lastShiftAt;
    const shiftDip = sinceShift < 0.12 ? 0.8 : 1; // -20% dip for ~120ms on gear change
    this.engineGain.gain.setTargetAtTime(baseGain * shiftDip, t, 0.05);

    if (this.windGain) {
      this.windGain.gain.setTargetAtTime(0.05 * r * r, t, 0.1);
    }
  }

  countdownBeep(final: boolean): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = final ? 0.35 : 0.12;
    const freq = final ? 1320 : 880;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + dur);
  }

  /** distanceRatio 0..1 (0 = own horn / very close). */
  horn(distanceRatio: number): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 0.4;
    const r = clamp01(distanceRatio);
    const gainValue = 0.3 / (1 + 3 * r); // 0.3 is the max amplitude (spec formula normalized)

    for (const freq of [370, 466]) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(gainValue, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + dur);
    }
  }

  /** intensity: unclamped input, clamped internally to 0..1 for gain. */
  collision(intensity: number): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 0.08;
    const buffer = renderWhiteNoise(ctx, dur);

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 800;

    const gain = ctx.createGain();
    gain.gain.value = clamp01(intensity) * 0.6;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(t);
    source.stop(t + dur);
  }

  /** 160ms bandpass white-noise chirp, one-shot self-collecting like collision(). Used while drifting. */
  tireScreech(): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 0.16;
    const buffer = renderWhiteNoise(ctx, dur);

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1100;
    filter.Q.value = 3;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.06, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(t);
    source.stop(t + dur);
  }

  /** gain scales the peak amplitude (0.3 base); pass a lower value for the pickup-collect variant. */
  turboWhoosh(gain = 1): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 0.6;
    const buffer = renderWhiteNoise(ctx, dur);

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(300, t);
    filter.frequency.exponentialRampToValueAtTime(3000, t + dur);

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(0.3 * clamp01(gain), t);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    source.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(this.master);
    source.start(t);
    source.stop(t + dur);
  }

  /** Grandstand world positions, used to compute crowd proximity. Task 5 wires real stands. */
  setCrowdSources(positions: THREE.Vector3[]): void {
    this.crowdSources = positions;
  }

  /** proximityRatio 0..1 (1 = right next to a stand). Call once per frame. */
  crowd(proximityRatio: number): void {
    if (!this.ctx || !this.crowdGain) return;
    const t = this.ctx.currentTime;
    const r = clamp01(proximityRatio);
    const base = 0.015 + r * (0.09 - 0.015);
    this.crowdGain.gain.setTargetAtTime(base, t, 0.2);

    if (t >= this.nextCheerAt) {
      this.nextCheerAt = t + 3 + Math.random() * 4;
      const g = this.crowdGain;
      const swell = base * 2;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(base, t);
      g.gain.linearRampToValueAtTime(swell, t + 0.4);
      g.gain.linearRampToValueAtTime(base, t + 1.2);
    }
    void this.crowdSources; // reserved for future spatialization
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.05);
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /**
   * Tear down this instance's node graph only. The shared AudioContext is
   * NOT closed here — it persists across races so a rematch (a fresh
   * AudioManager instance) can reuse it instead of hitting the browser's
   * context cap or being born suspended without a gesture.
   */
  dispose(): void {
    try {
      this.engineOsc?.stop();
      this.engineDetuneOsc?.stop();
      this.engineSubOsc?.stop();
      this.vibratoOsc?.stop();
      this.windSource?.stop();
      this.crowdSource?.stop();
    } catch {
      /* already stopped */
    }
    try {
      this.master?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.engineOsc = null;
    this.engineDetuneOsc = null;
    this.engineSubOsc = null;
    this.engineFilter = null;
    this.engineGain = null;
    this.vibratoOsc = null;
    this.vibratoGain = null;
    this.windSource = null;
    this.windFilter = null;
    this.windGain = null;
    this.crowdSource = null;
    this.crowdFilter = null;
    this.crowdGain = null;
    this.master = null;
    this.ctx = null;
    delete (window as unknown as { __audioDebug?: unknown }).__audioDebug;
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function renderWhiteNoise(ctx: AudioContext | OfflineAudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function renderPinkNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    b6 = white * 0.115926;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    data[i] = pink * 0.11;
  }
  return buffer;
}
