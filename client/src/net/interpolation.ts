import { Quaternion, Vector3 } from 'three';

export interface Snapshot {
  t: number; // local receipt time (performance.now())
  p: [number, number, number];
  q: [number, number, number, number];
}

const MAX_SNAPSHOTS = 60;
const qa = new Quaternion();
const qb = new Quaternion();

export class SnapshotBuffer {
  private snaps: Snapshot[] = [];

  push(s: Snapshot): void {
    this.snaps.push(s);
    if (this.snaps.length > MAX_SNAPSHOTS) this.snaps.shift();
  }

  /** Sample pose at time t into outP/outQ. Returns false if no data yet. */
  sample(t: number, outP: Vector3, outQ: Quaternion): boolean {
    const s = this.snaps;
    if (s.length === 0) return false;
    if (t <= s[0].t) return this.set(s[0], outP, outQ);
    const last = s[s.length - 1];
    if (t >= last.t) return this.set(last, outP, outQ);
    for (let i = s.length - 2; i >= 0; i--) {
      if (s[i].t <= t) {
        const a = s[i];
        const b = s[i + 1];
        const f = (t - a.t) / (b.t - a.t);
        outP.set(
          a.p[0] + (b.p[0] - a.p[0]) * f,
          a.p[1] + (b.p[1] - a.p[1]) * f,
          a.p[2] + (b.p[2] - a.p[2]) * f,
        );
        qa.fromArray(a.q);
        qb.fromArray(b.q);
        outQ.slerpQuaternions(qa, qb, f);
        return true;
      }
    }
    return this.set(s[0], outP, outQ);
  }

  private set(s: Snapshot, outP: Vector3, outQ: Quaternion): boolean {
    outP.set(s.p[0], s.p[1], s.p[2]);
    outQ.fromArray(s.q);
    return true;
  }
}
