/**
 * Tracks checkpoint sequence, laps, and total checkpoints passed.
 * Cars start ON the start line (checkpoint 0 pre-credited), so the first
 * expected gate is 1. Hitting 0 after a complete sequence = lap (or finish).
 */
export class CheckpointTracker {
  lap = 1;
  nextCp = 1;
  passed = 0;
  finished = false;

  constructor(
    public readonly numCps: number,
    public readonly totalLaps: number,
  ) {}

  hit(i: number): 'none' | 'cp' | 'lap' | 'finish' {
    if (this.finished || i !== this.nextCp) return 'none';
    this.passed++;
    this.nextCp = (this.nextCp + 1) % this.numCps;
    if (i === 0) {
      if (this.lap >= this.totalLaps) {
        this.finished = true;
        return 'finish';
      }
      this.lap++;
      return 'lap';
    }
    return 'cp';
  }
}
