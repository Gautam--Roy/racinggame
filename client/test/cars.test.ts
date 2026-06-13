import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CAR_LENGTH, normalizeCar } from '../src/game/cars';

describe('normalizeCar', () => {
  it('scales to CAR_LENGTH, centers x/z, and seats the bottom at y=0', () => {
    const raw = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1.4, 5));
    mesh.position.set(3, 2, -1); // arbitrary offset to catch centering bugs
    raw.add(mesh);
    const car = normalizeCar(raw);
    const box = new THREE.Box3().setFromObject(car);
    expect(box.max.z - box.min.z).toBeCloseTo(CAR_LENGTH, 5);
    expect(box.min.y).toBeCloseTo(0, 5);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 5);
    expect((box.min.z + box.max.z) / 2).toBeCloseTo(0, 5);
  });
});
