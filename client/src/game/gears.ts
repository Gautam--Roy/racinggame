/**
 * Shared gearbox model driving BOTH the engine sound (audio.ts) and the
 * physics acceleration curve (physics.ts via game.ts). Keeping this in one
 * place means the pitch you hear and the acceleration you feel are always
 * in sync — gear changes audibly dip AND physically dip at the same instant.
 */

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
 * Torque curve peaking mid-high RPM, roughly modeling a real engine's power
 * band: soft at idle, strong through the middle, tapering slightly toward
 * redline. Pure function, used to scale acceleration by gearFactor so power
 * delivery surges through each gear rather than being flat.
 *
 * At rpm=0: 0.72. At rpm=0.87 (peak, root of derivative 0.66 - 0.76*rpm = 0): ~1.0.
 * At rpm=1: ~1.0.
 */
export function gearTorque(rpm: number): number {
  const r = clamp01(rpm);
  return 0.72 + 0.66 * r - 0.38 * r * r;
}

const RPM_SMOOTH_RATE = 8; // 1/s, exponential approach rate toward target rpm, used OUTSIDE a shift
const NO_DIP_BELOW_RATIO = 0.12; // launch feel: skip the shift dip entirely below this speedRatio
const BLIP_MS = 200; // post-shift torque-surge duration
export const BLIP_STRENGTH = 0.08; // gearFactor gets *(1 + BLIP_STRENGTH * blip) — see game.ts wiring

/** Shift duration varies by (new) gear: longer/clunkier for low gears, quicker/crisper up high. */
function shiftDurationMs(gear: number): number {
  return 260 - gear * 24;
}

export interface GearState {
  rpm: number;
  gear: number;
  shiftDip: number;
  /** Post-shift torque-surge envelope: 0 during/before a shift, jumps to 1 the instant the dip
   * ends, then decays linearly to 0 over BLIP_MS. Multiply into gearFactor for a brief extra kick
   * right after the drivetrain "catches" in the new gear (game.ts: gearFactor * (1 + 0.08 * blip)). */
  blip: number;
}

/**
 * Stateful smoothing wrapper around gearRpm. Owns a smoothed rpm value and
 * detects gear changes to emit a shiftDip envelope: 1 at the moment of an
 * UPSHIFT, decaying to 0 over a per-gear shift duration (longer for low gears,
 * shorter for high gears — shiftDurationMs). Downshifts (can happen when
 * slowing down) produce no dip — only upshifts under acceleration jolt the
 * drivetrain. Shifts below NO_DIP_BELOW_RATIO speedRatio are skipped entirely
 * so launches off the line feel seamless. While a dip is active, the smoothed
 * rpm target eases toward the new (lower) rpm with a quicker, eased curve
 * instead of the steady-state exponential smoothing constant, so the pitch
 * visibly (audibly) snaps down and recovers rather than just gliding. Once
 * the dip ends, a brief blip envelope ramps 1 -> 0 over BLIP_MS, giving a
 * torque-surge feel as the drivetrain "catches" in the new gear.
 *
 * Deliberately framework-free (no AudioContext, no THREE) so it's trivially
 * unit-testable by stepping update() with manual dt values.
 */
export class GearBox {
  private smoothedRpm = 0.22;
  private lastGear = 1;
  private msSinceUpshift = Infinity;
  private shiftDurMs = 180;
  /** Debounce guard: once an upshift's dip has been armed, ignore further upshift
   * re-triggers for this long even if the gear index flaps back and forth at a
   * band boundary. Without this, the dip's own deceleration can nudge speedRatio
   * back across the boundary, re-arming a fresh full-strength dip forever — a
   * self-sustaining stall right at the boundary (observed empirically: the car
   * would get stuck at a fixed speed just below a gear's band edge). */
  private msSinceLastArm = Infinity;

  update(speedRatio: number, dtSec: number): GearState {
    const { rpm: targetRpm, gear } = gearRpm(speedRatio);
    const rearmGuardMs = this.shiftDurMs * 2;

    if (gear !== this.lastGear) {
      if (
        gear > this.lastGear &&
        this.msSinceLastArm >= rearmGuardMs &&
        speedRatio >= NO_DIP_BELOW_RATIO
      ) {
        this.shiftDurMs = shiftDurationMs(gear);
        this.msSinceUpshift = 0;
        this.msSinceLastArm = 0;
      }
      this.lastGear = gear;
    }
    if (this.msSinceUpshift < Infinity) this.msSinceUpshift += dtSec * 1000;
    if (this.msSinceLastArm < Infinity) this.msSinceLastArm += dtSec * 1000;

    const inDip = this.msSinceUpshift < this.shiftDurMs;
    const shiftDip = inDip ? 1 - this.msSinceUpshift / this.shiftDurMs : 0;

    if (inDip) {
      // Eased glide toward the target rpm while shifting: a quicker approach than the steady-
      // state smoothing rate, easing out (rate falls as the dip empties) so the pitch snaps down
      // promptly at the start of the shift and settles smoothly rather than linearly.
      const easedRate = RPM_SMOOTH_RATE * (1.8 + 2.2 * shiftDip);
      const lerp = 1 - Math.exp(-easedRate * dtSec);
      this.smoothedRpm += (targetRpm - this.smoothedRpm) * lerp;
    } else {
      const lerp = 1 - Math.exp(-RPM_SMOOTH_RATE * dtSec);
      this.smoothedRpm += (targetRpm - this.smoothedRpm) * lerp;
    }

    // Blip window starts right when the dip ends (msSinceUpshift crosses shiftDurMs) and lasts
    // BLIP_MS beyond that.
    const msSinceDipEnd = this.msSinceUpshift - this.shiftDurMs;
    const blip =
      !inDip && msSinceDipEnd >= 0 && msSinceDipEnd < BLIP_MS ? 1 - msSinceDipEnd / BLIP_MS : 0;

    return { rpm: this.smoothedRpm, gear, shiftDip, blip };
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
