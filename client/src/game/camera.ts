import * as THREE from 'three';
import { MAX_SPEED } from './physics';

const BACK = 8.5;
const HEIGHT = 3.6;
const desired = new THREE.Vector3();
const lookAt = new THREE.Vector3();
const fwd = new THREE.Vector3();
const shake = new THREE.Vector3();

export class ChaseCamera {
  constructor(private readonly cam: THREE.PerspectiveCamera) {}

  snap(pos: THREE.Vector3, quat: THREE.Quaternion): void {
    this.place(pos, quat, 1);
  }

  update(pos: THREE.Vector3, quat: THREE.Quaternion, speed: number, dt: number, turbo = false): void {
    this.place(pos, quat, 1 - Math.exp(-5.5 * dt));
    const targetFov = 68 + 14 * Math.min(1, speed / MAX_SPEED);
    if (Math.abs(this.cam.fov - targetFov) > 0.1) {
      this.cam.fov += (targetFov - this.cam.fov) * Math.min(1, 4 * dt);
      this.cam.updateProjectionMatrix();
    }

    // render-only shake, scales with speed ratio squared; not part of deterministic physics
    const ratio = THREE.MathUtils.clamp(speed / MAX_SPEED, 0, 1);
    const amount = 0.1 * ratio * ratio * (turbo ? 1.5 : 1);
    shake.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(amount);
    this.cam.position.add(shake);
  }

  private place(pos: THREE.Vector3, quat: THREE.Quaternion, alpha: number): void {
    fwd.set(0, 0, -1).applyQuaternion(quat).setY(0).normalize();
    desired.copy(pos).addScaledVector(fwd, -BACK).setY(pos.y + HEIGHT);
    this.cam.position.lerp(desired, alpha);
    lookAt.copy(pos).addScaledVector(fwd, 5).setY(pos.y + 1.2);
    this.cam.lookAt(lookAt);
  }
}
