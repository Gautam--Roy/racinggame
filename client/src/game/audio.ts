import * as THREE from 'three';
import type { GearState } from './gears';

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
 * Web Audio soundscape built on a shared, gesture-gated AudioContext. The
 * node graph is (re)built on `unlock()`, called from a user-gesture handler
 * in main.ts (autoplay policy). Every public method no-ops safely before
 * unlock so callers never need to guard.
 */
// Sample-driven engine tuning. playbackRate maps rpm (0..1) onto this range --
// tuned so idle sounds idle and redline sounds urgent without chipmunking.
const ENGINE_RATE_BASE = 0.55;
const ENGINE_RATE_SPAN = 1.1;
const ENGINE_TURBO_BOOST = 1.18;
// Equal-power crossfade band between the low-RPM and high-RPM loops.
const CROSSFADE_LO = 0.45;
const CROSSFADE_HI = 0.75;
// Post-shift rev-match blip: momentary playbackRate bump -- a "nice rev-match effect" tied to the
// real gear-catch moment (GearState.blip) instead of a constant LFO.
const BLIP_RATE_BOOST = 0.04;

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  // engine (sample-based: two pitch-graded loops crossfaded by rpm)
  private engineLowBuffer: AudioBuffer | null = null;
  private engineHighBuffer: AudioBuffer | null = null;
  private engineLowSource: AudioBufferSourceNode | null = null;
  private engineHighSource: AudioBufferSourceNode | null = null;
  private engineLowGain: GainNode | null = null;
  private engineHighGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;
  private engineBuffersLoaded = false;

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
    void this.loadEngineBuffers();

    (window as unknown as {
      __audioDebug?: () => {
        state: string;
        muted: boolean;
        engineMode: 'sample' | 'synth';
        buffersLoaded: boolean;
      };
    }).__audioDebug = () => ({
      state: this.ctx?.state ?? 'closed',
      muted: this.muted,
      engineMode: 'sample',
      buffersLoaded: this.engineBuffersLoaded,
    });
  }

  /**
   * Fetch + decode the two sample-based engine loops (same-origin /audio/...), lazily, once per
   * shared AudioContext lifetime. Every engine() call no-ops safely until this resolves — brief
   * silence on the very first unlock() is fine, per spec.
   */
  private async loadEngineBuffers(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || this.engineBuffersLoaded) return;
    try {
      const [lowRes, highRes] = await Promise.all([
        fetch('/audio/engine-low.ogg'),
        fetch('/audio/engine-high.ogg'),
      ]);
      const [lowBuf, highBuf] = await Promise.all([lowRes.arrayBuffer(), highRes.arrayBuffer()]);
      const [lowDecoded, highDecoded] = await Promise.all([
        ctx.decodeAudioData(lowBuf),
        ctx.decodeAudioData(highBuf),
      ]);
      // ctx/dispose() may have run while the fetch/decode was in flight.
      if (!this.ctx || this.ctx !== ctx) return;
      this.engineLowBuffer = lowDecoded;
      this.engineHighBuffer = highDecoded;
      this.startEngineSources();
      this.engineBuffersLoaded = true;
    } catch {
      /* offline, blocked fetch, or unsupported codec — engine() stays silent, no crash */
    }
  }

  private buildEngine(): void {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.value = 0.5;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 350;

    const lowGain = ctx.createGain();
    lowGain.gain.value = 1; // equal-power crossfade weights, set per-frame in engine()
    const highGain = ctx.createGain();
    highGain.gain.value = 0;

    lowGain.connect(filter);
    highGain.connect(filter);
    filter.connect(gain);
    gain.connect(this.master!);

    this.engineFilter = filter;
    this.engineGain = gain;
    this.engineLowGain = lowGain;
    this.engineHighGain = highGain;
  }

  /** Starts the two looping sample sources once buffers are decoded. Called once per unlock(). */
  private startEngineSources(): void {
    const ctx = this.ctx;
    if (!ctx || !this.engineLowBuffer || !this.engineHighBuffer || !this.engineLowGain || !this.engineHighGain) {
      return;
    }
    const low = ctx.createBufferSource();
    low.buffer = this.engineLowBuffer;
    low.loop = true;
    low.playbackRate.value = ENGINE_RATE_BASE;
    low.connect(this.engineLowGain);
    low.start();

    const high = ctx.createBufferSource();
    high.buffer = this.engineHighBuffer;
    high.loop = true;
    high.playbackRate.value = ENGINE_RATE_BASE;
    high.connect(this.engineHighGain);
    high.start();

    this.engineLowSource = low;
    this.engineHighSource = high;
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
   * Engine note per frame. `gs` is the shared GearBox output (see gears.ts),
   * computed once per fixedStep in game.ts and passed to BOTH this method and
   * driveCar's gearFactor — so the pitch you hear and the acceleration you
   * feel are always driven by the exact same rpm/gear/shiftDip, never two
   * independently-smoothed models drifting apart. turbo boosts pitch/gain.
   *
   * Sample-driven: two pitch-graded engine loops (low/high RPM) crossfaded by
   * rpm with an equal-power curve, both resampled via playbackRate to track
   * rpm continuously within their band. No-ops safely until loadEngineBuffers()
   * resolves (this.engineLowSource stays null) — brief silence on first
   * unlock() is expected. Also updates the wind noise layer, which scales
   * with speed only.
   */
  engine(gs: GearState, turbo: boolean): void {
    if (
      !this.ctx ||
      !this.engineLowSource ||
      !this.engineHighSource ||
      !this.engineLowGain ||
      !this.engineHighGain ||
      !this.engineFilter ||
      !this.engineGain
    ) {
      return;
    }
    const boost = turbo ? ENGINE_TURBO_BOOST : 1;
    const t = this.ctx.currentTime;

    const rpm = clamp01(gs.rpm);
    const blip = clamp01(gs.blip);
    const rate = (ENGINE_RATE_BASE + rpm * ENGINE_RATE_SPAN) * boost * (1 + BLIP_RATE_BOOST * blip);
    this.engineLowSource.playbackRate.setTargetAtTime(rate, t, 0.05);
    this.engineHighSource.playbackRate.setTargetAtTime(rate, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(350 + rpm * 2600 + (turbo ? 600 : 0), t, 0.05);

    // Equal-power crossfade: cos/sin pair so the combined perceived loudness stays roughly
    // constant through the handoff instead of dipping (linear fade) or bulging (both at 1).
    const x = clamp01((rpm - CROSSFADE_LO) / (CROSSFADE_HI - CROSSFADE_LO));
    const lowWeight = Math.cos(x * (Math.PI / 2));
    const highWeight = Math.sin(x * (Math.PI / 2));
    this.engineLowGain.gain.setTargetAtTime(lowWeight, t, 0.05);
    this.engineHighGain.gain.setTargetAtTime(highWeight, t, 0.05);

    const baseGain = 0.5 + rpm * (0.85 - 0.5);
    const shiftDip = clamp01(gs.shiftDip);
    this.engineGain.gain.setTargetAtTime(baseGain * (1 - 0.35 * shiftDip), t, 0.05);

    if (this.windGain) {
      // Approximate overall speed ratio from gear+rpm (gear bands span 0..1 in
      // fifths with overlap; this is close enough for a wind-noise curve that
      // only needs to trend upward with speed, not be exact).
      const speedApprox = clamp01(((gs.gear - 1) + rpm) / 5);
      this.windGain.gain.setTargetAtTime(0.05 * speedApprox * speedApprox, t, 0.1);
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
      this.engineLowSource?.stop();
      this.engineHighSource?.stop();
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
    this.engineLowBuffer = null;
    this.engineHighBuffer = null;
    this.engineLowSource = null;
    this.engineHighSource = null;
    this.engineLowGain = null;
    this.engineHighGain = null;
    this.engineFilter = null;
    this.engineGain = null;
    this.engineBuffersLoaded = false;
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
