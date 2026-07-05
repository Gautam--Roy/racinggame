import * as THREE from 'three';
import { MAX_SPEED } from './physics';

const desired = new THREE.Vector3();
const lookAt = new THREE.Vector3();
const fwd = new THREE.Vector3();
const velDir = new THREE.Vector3();
const blended = new THREE.Vector3();
const right = new THREE.Vector3();
const shake = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class ChaseCamera {
  // Smoothed blended direction (car-forward mixed with velocity direction), persisted across frames
  // so quick steering flicks don't snap the camera's aim instantly.
  private readonly smoothedDir = new THREE.Vector3(0, 0, -1);

  constructor(private readonly cam: THREE.PerspectiveCamera) {}

  snap(pos: THREE.Vector3, quat: THREE.Quaternion): void {
    fwd.set(0, 0, -1).applyQuaternion(quat).setY(0).normalize();
    this.smoothedDir.copy(fwd);
    this.place(pos, fwd, 7.5, 3.2, 0, 1);
  }

  update(
    pos: THREE.Vector3,
    quat: THREE.Quaternion,
    velocity: THREE.Vector3,
    speed: number,
    steer: number,
    dt: number,
    turbo = false,
    drifting = false,
  ): void {
    fwd.set(0, 0, -1).applyQuaternion(quat).setY(0).normalize();

    if (speed > 0.5) velDir.set(velocity.x, 0, velocity.z).normalize();
    else velDir.copy(fwd);

    // Above ~6 m/s, blend the camera's aim toward the actual velocity direction so drifting/sliding
    // reads visually (car pointed one way, moving another).
    const mix = speed > 6 ? THREE.MathUtils.clamp((speed - 6) / 10, 0, 0.65) : 0;
    void drifting; // currently the velocity-facing blend alone is enough to make drift visible; reserved for future tuning
    blended.copy(fwd).multiplyScalar(1 - mix).addScaledVector(velDir, mix);
    if (blended.lengthSq() > 1e-8) blended.normalize();
    else blended.copy(fwd);

    // Smooth the blended direction itself (not just camera position) to avoid snapping on quick flicks.
    const dirAlpha = 1 - Math.exp(-3 * dt);
    this.smoothedDir.lerp(blended, dirAlpha).normalize();

    const speedRatio = THREE.MathUtils.clamp(speed / MAX_SPEED, 0, 1);
    const back = 7.5 + 2.5 * speedRatio;
    const height = 3.2 + 0.6 * speedRatio;
    const posAlpha = 1 - Math.exp(-6 * dt);
    this.place(pos, this.smoothedDir, back, height, steer, posAlpha);

    const targetFov = 68 + 14 * speedRatio;
    if (Math.abs(this.cam.fov - targetFov) > 0.1) {
      this.cam.fov += (targetFov - this.cam.fov) * Math.min(1, 4 * dt);
      this.cam.updateProjectionMatrix();
    }

    // render-only shake, only kicks in above 60% of top speed; not part of deterministic physics
    const shakeRatio = speedRatio > 0.6 ? Math.pow((speedRatio - 0.6) / 0.4, 2) : 0;
    const amount = 0.05 * shakeRatio * (turbo ? 1.5 : 1);
    shake.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(amount);
    this.cam.position.add(shake);
  }

  /** Positions and aims the camera. `dir` is the (already smoothed) forward-ish direction to place behind. */
  private place(pos: THREE.Vector3, dir: THREE.Vector3, back: number, height: number, steer: number, alpha: number): void {
    desired.copy(pos).addScaledVector(dir, -back).setY(pos.y + height);
    this.cam.position.lerp(desired, alpha);

    lookAt.copy(pos).addScaledVector(dir, 5).setY(pos.y + 1.2);
    // Lateral look-ahead shift toward the inside/outside of the turn based on steer input.
    right.crossVectors(dir, UP).normalize();
    lookAt.addScaledVector(right, steer * -2.2);
    this.cam.lookAt(lookAt);

    // lookAt() resets rotation (including .z), so subtle roll must be applied after.
    this.cam.rotation.z += THREE.MathUtils.clamp(-steer * 0.03, -0.03, 0.03);
  }
}
