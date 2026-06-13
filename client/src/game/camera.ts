import * as THREE from 'three';
import { MAX_SPEED } from './physics';

const BACK = 8.5;
const HEIGHT = 3.6;
const desired = new THREE.Vector3();
const lookAt = new THREE.Vector3();
const fwd = new THREE.Vector3();

export class ChaseCamera {
  constructor(private readonly cam: THREE.PerspectiveCamera) {}

  snap(pos: THREE.Vector3, quat: THREE.Quaternion): void {
    this.place(pos, quat, 1);
  }

  update(pos: THREE.Vector3, quat: THREE.Quaternion, speed: number, dt: number): void {
    this.place(pos, quat, 1 - Math.exp(-5.5 * dt));
    const targetFov = 68 + 14 * Math.min(1, speed / MAX_SPEED);
    if (Math.abs(this.cam.fov - targetFov) > 0.1) {
      this.cam.fov += (targetFov - this.cam.fov) * Math.min(1, 4 * dt);
      this.cam.updateProjectionMatrix();
    }
  }

  private place(pos: THREE.Vector3, quat: THREE.Quaternion, alpha: number): void {
    fwd.set(0, 0, -1).applyQuaternion(quat).setY(0).normalize();
    desired.copy(pos).addScaledVector(fwd, -BACK).setY(pos.y + HEIGHT);
    this.cam.position.lerp(desired, alpha);
    lookAt.copy(pos).addScaledVector(fwd, 5).setY(pos.y + 1.2);
    this.cam.lookAt(lookAt);
  }
}
