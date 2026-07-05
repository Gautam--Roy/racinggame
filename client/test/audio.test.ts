import { describe, expect, it } from 'vitest';
import { gearRpm } from '../src/game/audio';

describe('gearRpm', () => {
  it('idle/stationary: ratio 0 sits in gear 1 at low rpm', () => {
    const { rpm, gear } = gearRpm(0);
    expect(gear).toBe(1);
    expect(rpm).toBeLessThan(0.35);
  });

  it('rpm is monotonically increasing within a single gear band', () => {
    // 0.02..0.13 all fall in gear 1 only (gear 2 starts at 0.14).
    const samples = [0.02, 0.05, 0.08, 0.11, 0.13].map(gearRpm);
    for (const { gear } of samples) expect(gear).toBe(1);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].rpm).toBeGreaterThan(samples[i - 1].rpm);
    }
  });

  it('each upshift boundary drops rpm (just above the boundary < just below it)', () => {
    // Because we pick the HIGHEST gear whose band contains the ratio, the
    // actual upshift points are where the NEXT gear's band opens (its low
    // end) -- 0.14, 0.30, 0.48, 0.70 -- not the current gear's band top.
    const boundaries = [0.14, 0.3, 0.48, 0.7];
    for (const b of boundaries) {
      const below = gearRpm(b - 0.001);
      const above = gearRpm(b + 0.001);
      expect(above.gear).toBeGreaterThan(below.gear);
      expect(above.rpm).toBeLessThan(below.rpm);
    }
  });

  it('ratio 1 reaches gear 5 at rpm close to 1', () => {
    const { rpm, gear } = gearRpm(1);
    expect(gear).toBe(5);
    expect(rpm).toBeCloseTo(1, 5);
  });

  it('clamps out-of-range ratios', () => {
    expect(gearRpm(-1).gear).toBe(1);
    const over = gearRpm(2);
    expect(over.gear).toBe(5);
    expect(over.rpm).toBeCloseTo(1, 5);
  });
});
