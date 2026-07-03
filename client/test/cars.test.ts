import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CAR_LENGTH, normalizeCar, prepareWheels } from '../src/game/cars';

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

  it("tilt writes preserve the model's yaw orientation", () => {
    // Regression test: cloning re-decomposes the yaw-pi quaternion on 'car-yaw' into an
    // Euler with components possibly spread across axes. If per-frame tilt code then wrote
    // rotation.x/z onto that SAME object, it would collapse/overwrite the yaw, silently
    // flipping the model to face forward (+Z) instead of the intended backward (-Z) direction.
    const raw = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1.4, 5));
    raw.add(mesh);
    const template = normalizeCar(raw);

    // The clone step is essential: it triggers quaternion->Euler re-decomposition on 'car-yaw'.
    const car = template.clone(true);

    const tiltGroup = car.getObjectByName('car-inner');
    expect(tiltGroup).toBeDefined();

    // Per-frame tilt writes, applied only to 'car-inner' (never 'car-yaw').
    tiltGroup!.rotation.x = 0.05;
    tiltGroup!.rotation.z = 0.03;
    car.updateMatrixWorld(true);

    // Find the deepest model node (the actual mesh) to read its world orientation.
    let deepest: THREE.Object3D = car;
    while (deepest.children.length > 0) {
      deepest = deepest.children[0];
    }

    // Kenney-native front is local +Z; our yaw fixup (MODEL_YAW = PI) should still make the
    // model's front point toward world -Z after tilt writes. If car-yaw's yaw were collapsed
    // to identity, this local (0,0,1) would transform to world +Z instead, and the dot below
    // would be negative rather than > 0.9.
    const localFront = new THREE.Vector3(0, 0, 1);
    const worldFront = localFront
      .clone()
      .transformDirection(deepest.matrixWorld)
      .normalize();
    const expectedForward = new THREE.Vector3(0, 0, -1);
    expect(worldFront.dot(expectedForward)).toBeGreaterThan(0.9);
  });
});

describe('prepareWheels', () => {
  it('steer pivot insertion preserves wheel world position', () => {
    const raw = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1.4, 5));
    raw.add(mesh);
    const wheel = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3));
    wheel.name = 'wheel-front-left';
    wheel.position.set(-0.85, 0.34, -1.15);
    raw.add(wheel);

    const car = normalizeCar(raw).clone(true);
    car.updateMatrixWorld(true);

    const wheelNode = car.getObjectByName('wheel-front-left')!;
    expect(wheelNode).toBeDefined();
    const before = new THREE.Vector3();
    wheelNode.getWorldPosition(before);

    const { left } = prepareWheels({ fl: wheelNode });
    car.updateMatrixWorld(true);

    expect(left).toBeDefined();
    const after = new THREE.Vector3();
    wheelNode.getWorldPosition(after);

    expect(after.x).toBeCloseTo(before.x, 5);
    expect(after.y).toBeCloseTo(before.y, 5);
    expect(after.z).toBeCloseTo(before.z, 5);

    // Steer pivot rotates only y; verify it exists and, after rotating and returning to
    // rotation.y = 0, the wheel's world position is still governed purely by the pivot
    // (no residual local offset baked into the wheel itself).
    left!.rotation.y = 0.4;
    car.updateMatrixWorld(true);
    left!.rotation.y = 0;
    car.updateMatrixWorld(true);
    const restored = new THREE.Vector3();
    wheelNode.getWorldPosition(restored);
    expect(restored.x).toBeCloseTo(before.x, 5);
    expect(restored.y).toBeCloseTo(before.y, 5);
    expect(restored.z).toBeCloseTo(before.z, 5);
  });
});
