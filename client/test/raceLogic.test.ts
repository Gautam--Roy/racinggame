import { describe, expect, it } from 'vitest';
import { CheckpointTracker } from '../src/game/raceLogic';

describe('CheckpointTracker (4 checkpoints, 2 laps)', () => {
  const fresh = () => new CheckpointTracker(4, 2);

  it('starts on lap 1 expecting checkpoint 1 (cars start on the line)', () => {
    const t = fresh();
    expect(t.lap).toBe(1);
    expect(t.nextCp).toBe(1);
    expect(t.passed).toBe(0);
  });

  it('only the expected checkpoint counts', () => {
    const t = fresh();
    expect(t.hit(2)).toBe('none'); // skipping ahead ignored
    expect(t.hit(0)).toBe('none'); // start line again ignored
    expect(t.hit(1)).toBe('cp');
    expect(t.passed).toBe(1);
    expect(t.nextCp).toBe(2);
  });

  it('re-hitting the same checkpoint is idempotent', () => {
    const t = fresh();
    t.hit(1);
    expect(t.hit(1)).toBe('none');
    expect(t.passed).toBe(1);
  });

  it('crossing the start line after a full sequence increments the lap', () => {
    const t = fresh();
    for (const i of [1, 2, 3]) t.hit(i);
    expect(t.hit(0)).toBe('lap');
    expect(t.lap).toBe(2);
    expect(t.nextCp).toBe(1);
    expect(t.passed).toBe(4);
  });

  it('finishes after the final lap', () => {
    const t = fresh();
    for (const i of [1, 2, 3]) t.hit(i);
    t.hit(0); // lap 2
    for (const i of [1, 2, 3]) t.hit(i);
    expect(t.hit(0)).toBe('finish');
    expect(t.finished).toBe(true);
    expect(t.passed).toBe(8);
    expect(t.hit(1)).toBe('none'); // inert after finish
  });
});
