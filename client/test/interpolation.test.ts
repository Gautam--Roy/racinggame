import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { SnapshotBuffer } from '../src/net/interpolation';

const p = new Vector3();
const q = new Quaternion();

describe('SnapshotBuffer', () => {
  it('returns false when empty', () => {
    expect(new SnapshotBuffer().sample(100, p, q)).toBe(false);
  });

  it('clamps to the only/oldest snapshot', () => {
    const buf = new SnapshotBuffer();
    buf.push({ t: 100, p: [1, 2, 3], q: [0, 0, 0, 1] });
    expect(buf.sample(50, p, q)).toBe(true);
    expect(p.toArray()).toEqual([1, 2, 3]);
  });

  it('interpolates linearly between two snapshots', () => {
    const buf = new SnapshotBuffer();
    buf.push({ t: 100, p: [0, 0, 0], q: [0, 0, 0, 1] });
    buf.push({ t: 200, p: [10, 0, 0], q: [0, 0, 0, 1] });
    buf.sample(150, p, q);
    expect(p.x).toBeCloseTo(5);
  });

  it('clamps to the newest snapshot when sampling past the end', () => {
    const buf = new SnapshotBuffer();
    buf.push({ t: 100, p: [0, 0, 0], q: [0, 0, 0, 1] });
    buf.push({ t: 200, p: [10, 0, 0], q: [0, 0, 0, 1] });
    buf.sample(999, p, q);
    expect(p.x).toBeCloseTo(10);
  });

  it('slerps rotation', () => {
    const buf = new SnapshotBuffer();
    const q90 = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    buf.push({ t: 0, p: [0, 0, 0], q: [0, 0, 0, 1] });
    buf.push({ t: 100, p: [0, 0, 0], q: q90.toArray() as [number, number, number, number] });
    buf.sample(50, p, q);
    const q45 = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4);
    expect(q.angleTo(q45)).toBeLessThan(0.01);
  });

  it('caps buffer size', () => {
    const buf = new SnapshotBuffer();
    for (let i = 0; i < 200; i++) buf.push({ t: i, p: [i, 0, 0], q: [0, 0, 0, 1] });
    buf.sample(0, p, q); // oldest retained is i=140
    expect(p.x).toBeCloseTo(140);
  });
});
