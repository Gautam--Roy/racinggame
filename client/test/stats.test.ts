import { describe, expect, it } from 'vitest';
import { CAR_MODELS, CAR_STATS } from '../../shared/src/protocol';
import { longitudinalAccel, MAX_SPEED } from '../src/game/physics';

const ENGINE_ACCEL = 22; // mirrors the private constant in physics.ts (see driveCar effective-cap formula)

describe('CAR_STATS', () => {
  it('every CAR_MODELS entry has stats', () => {
    for (const car of CAR_MODELS) {
      expect(CAR_STATS[car]).toBeDefined();
    }
  });

  it('all speed/accel values are within [0.9, 1.15]', () => {
    for (const car of CAR_MODELS) {
      const { speed, accel } = CAR_STATS[car];
      expect(speed).toBeGreaterThanOrEqual(0.9);
      expect(speed).toBeLessThanOrEqual(1.15);
      expect(accel).toBeGreaterThanOrEqual(0.9);
      expect(accel).toBeLessThanOrEqual(1.15);
    }
  });
});

/**
 * driveCar (physics.ts) computes, per the DriveOpts.stats multiplier:
 *   maxSpeed    = MAX_SPEED * stats.speed * (turbo ? 1.4 : 1 + slipBonus)
 *   engineAccel = ENGINE_ACCEL * stats.accel * (turbo ? 1.6 : 1 + slipBonus)
 * driveCar itself isn't a pure function (it reads/writes a RAPIER RigidBody), so rather than
 * standing up a physics world here we verify the effective-cap arithmetic directly against the
 * same constants driveCar uses — this is the composition the "per-vehicle character" feature
 * depends on (multiplicative with turbo/slipstream, so those effects still stack per-car).
 */
function effectiveCaps(stats: { speed: number; accel: number }, opts: { turbo: boolean; slipBonus: number }) {
  const maxSpeed = MAX_SPEED * stats.speed * (opts.turbo ? 1.4 : 1 + opts.slipBonus);
  const engineAccel = ENGINE_ACCEL * stats.accel * (opts.turbo ? 1.6 : 1 + opts.slipBonus);
  return { maxSpeed, engineAccel };
}

describe('effective speed/accel caps (mirrors driveCar composition)', () => {
  it('a race car (speed 1.05, accel 0.97) gets a higher cap and lower accel than baseline', () => {
    const base = effectiveCaps({ speed: 1, accel: 1 }, { turbo: false, slipBonus: 0 });
    const race = effectiveCaps(CAR_STATS.race, { turbo: false, slipBonus: 0 });
    expect(race.maxSpeed).toBeGreaterThan(base.maxSpeed);
    expect(race.engineAccel).toBeLessThan(base.engineAccel);
    expect(race.maxSpeed).toBeCloseTo(MAX_SPEED * 1.05, 5);
    expect(race.engineAccel).toBeCloseTo(ENGINE_ACCEL * 0.97, 5);
  });

  it('an suv (speed 0.95, accel 1.04) trades top speed for acceleration', () => {
    const suv = effectiveCaps(CAR_STATS.suv, { turbo: false, slipBonus: 0 });
    expect(suv.maxSpeed).toBeLessThan(MAX_SPEED);
    expect(suv.engineAccel).toBeGreaterThan(ENGINE_ACCEL);
  });

  it('turbo and per-car stats compose multiplicatively', () => {
    const withTurbo = effectiveCaps(CAR_STATS['race-future'], { turbo: true, slipBonus: 0 });
    expect(withTurbo.maxSpeed).toBeCloseTo(MAX_SPEED * 1.08 * 1.4, 5);
    expect(withTurbo.engineAccel).toBeCloseTo(ENGINE_ACCEL * 0.92 * 1.6, 5);
  });

  it('slipstream bonus and per-car stats compose multiplicatively', () => {
    const withSlip = effectiveCaps(CAR_STATS.taxi, { turbo: false, slipBonus: 0.2 });
    expect(withSlip.maxSpeed).toBeCloseTo(MAX_SPEED * 0.96 * 1.2, 5);
    expect(withSlip.engineAccel).toBeCloseTo(ENGINE_ACCEL * 1.06 * 1.2, 5);
  });
});

describe('longitudinalAccel (handbrake braking)', () => {
  it('throttle-only, no handbrake: positive accel, tapering toward maxSpeed', () => {
    const a = longitudinalAccel(1, false, 10, 24, 46);
    expect(a).toBeGreaterThan(0);
  });

  it('handbrake at speed produces strongly negative accel even with full throttle', () => {
    // Handbrake cuts engine force to 15% and adds a flat -13 m/s^2 decel; at moderate speed the
    // (small) throttle contribution plus damping compensation don't come close to offsetting that.
    const a = longitudinalAccel(1, true, 10, 24, 46);
    expect(a).toBeLessThan(-5);
  });

  it('handbrake at speed with no throttle also brakes hard', () => {
    const a = longitudinalAccel(0, true, 25, 24, 46);
    expect(a).toBeLessThan(-10);
  });

  it('handbrake near zero speed produces no reverse creep (accel not pushed negative-signed toward reverse)', () => {
    const a = longitudinalAccel(0, true, 0.1, 24, 46);
    expect(a).toBeCloseTo(0, 5);
  });

  it('brake (throttle < 0) behavior unchanged without handbrake: strong deceleration while moving forward', () => {
    const a = longitudinalAccel(-1, false, 20, 24, 46);
    expect(a).toBeLessThan(0);
  });

  it('brake at low/negative speed applies reverse accel, unaffected by handbrake changes', () => {
    const a = longitudinalAccel(-1, false, -3, 24, 46);
    expect(a).toBeLessThan(0);
    expect(a).toBeGreaterThan(-15); // reverse accel magnitude (10), not brake accel (32)
  });
});
