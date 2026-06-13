export class CheckpointTracker {
  lap = 1;
  nextCp = 1;
  passed = 0;
  finished = false;
  constructor(
    public readonly numCps: number,
    public readonly totalLaps: number,
  ) {}
  hit(_i: number): 'none' | 'cp' | 'lap' | 'finish' {
    return 'none';
  }
}
