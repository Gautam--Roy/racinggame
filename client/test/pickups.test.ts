import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PICKUP_COUNT } from '../../shared/src/protocol';
import { PICKUP_US, RESPAWN_MS, PickupBoard, slipstreamTarget } from '../src/game/pickups';

describe('PICKUP_US', () => {
  it('has one entry per pickup slot', () => {
    expect(PICKUP_US.length).toBe(PICKUP_COUNT);
  });
});

describe('PickupBoard', () => {
  it('starts with all pickups available', () => {
    const board = new PickupBoard();
    for (let i = 0; i < PICKUP_US.length; i++) expect(board.available(i, 0)).toBe(true);
  });

  it('take() makes a pickup unavailable', () => {
    const board = new PickupBoard();
    expect(board.take(0, 1000)).toBe(true);
    expect(board.available(0, 1000)).toBe(false);
  });

  it('is unavailable 1ms before respawn', () => {
    const board = new PickupBoard();
    board.take(0, 1000);
    expect(board.available(0, 1000 + RESPAWN_MS - 1)).toBe(false);
  });

  it('is available again exactly at the respawn boundary', () => {
    const board = new PickupBoard();
    board.take(0, 1000);
    expect(board.available(0, 1000 + RESPAWN_MS)).toBe(true);
  });

  it('rejects a double-take before respawn', () => {
    const board = new PickupBoard();
    expect(board.take(0, 1000)).toBe(true);
    expect(board.take(0, 1500)).toBe(false);
  });

  it('allows a take again after respawn', () => {
    const board = new PickupBoard();
    board.take(0, 1000);
    expect(board.take(0, 1000 + RESPAWN_MS)).toBe(true);
  });

  it('tracks indices independently', () => {
    const board = new PickupBoard();
    board.take(0, 1000);
    expect(board.available(1, 1000)).toBe(true);
    expect(board.take(1, 1000)).toBe(true);
  });

  it('rejects take() for an out-of-range index', () => {
    const board = new PickupBoard();
    expect(board.take(-1, 0)).toBe(false);
    expect(board.take(PICKUP_US.length, 0)).toBe(false);
  });
});

describe('slipstreamTarget', () => {
  const ownPos = new THREE.Vector3(0, 0, 0);
  const ownFwd = new THREE.Vector3(0, 0, -1);

  it('gives a draft bonus when a remote is ahead, in-window, and own speed is high enough', () => {
    const remote = new THREE.Vector3(0, 0, -8); // 8m ahead along -Z
    expect(slipstreamTarget(ownPos, ownFwd, 20, [remote])).toBe(0.15);
  });

  it('gives no bonus when the remote is behind', () => {
    const remote = new THREE.Vector3(0, 0, 8); // behind
    expect(slipstreamTarget(ownPos, ownFwd, 20, [remote])).toBe(0);
  });

  it('gives no bonus when the remote is too far ahead', () => {
    const remote = new THREE.Vector3(0, 0, -20); // 20m ahead, outside 4-14m window
    expect(slipstreamTarget(ownPos, ownFwd, 20, [remote])).toBe(0);
  });

  it('gives no bonus when the remote is too close (below 4m window)', () => {
    const remote = new THREE.Vector3(0, 0, -2);
    expect(slipstreamTarget(ownPos, ownFwd, 20, [remote])).toBe(0);
  });

  it('gives no bonus when the remote is too far to the side', () => {
    const remote = new THREE.Vector3(3, 0, -8); // 3m lateral, over the 2.2m limit
    expect(slipstreamTarget(ownPos, ownFwd, 20, [remote])).toBe(0);
  });

  it('gives no bonus when own speed is too low', () => {
    const remote = new THREE.Vector3(0, 0, -8);
    expect(slipstreamTarget(ownPos, ownFwd, 10, [remote])).toBe(0);
  });

  it('returns 0.15 if any of several remotes qualifies', () => {
    const far = new THREE.Vector3(0, 0, 30);
    const good = new THREE.Vector3(0, 0, -10);
    expect(slipstreamTarget(ownPos, ownFwd, 20, [far, good])).toBe(0.15);
  });
});
