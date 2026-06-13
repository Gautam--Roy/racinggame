import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { BarrierBox } from './track';
import type { Input } from './input';

export const CAR_HALF = { x: 0.85, y: 0.45, z: 1.8 };
export const MAX_SPEED = 38; // m/s ≈ 137 km/h
const ENGINE_ACCEL = 22;
const BRAKE_ACCEL = 32;
const REVERSE_ACCEL = 10;
const MAX_REVERSE = 9;
const TURN_RATE = 2.3; // rad/s at full steer
const GRIP = 9; // lateral velocity kill rate
const GRIP_HANDBRAKE = 2.2;

let initialized = false;
export async function initRapier(): Promise<void> {
  if (!initialized) {
    await RAPIER.init();
    initialized = true;
  }
}

export function createWorld(barriers: BarrierBox[]): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  // ground
  world.createCollider(RAPIER.ColliderDesc.cuboid(450, 0.5, 450).setTranslation(0, -0.5, 0).setFriction(0.8));
  // barriers
  for (const b of barriers) {
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(b.half.x, b.half.y, b.half.z)
        .setTranslation(b.pos.x, b.pos.y, b.pos.z)
        .setRotation({ x: b.quat.x, y: b.quat.y, z: b.quat.z, w: b.quat.w })
        .setRestitution(0.4),
    );
  }
  return world;
}

function carCollider(): RAPIER.ColliderDesc {
  return RAPIER.ColliderDesc.cuboid(CAR_HALF.x, CAR_HALF.y, CAR_HALF.z).setFriction(0.3).setRestitution(0.4);
}

export function createLocalCar(world: RAPIER.World, pos: THREE.Vector3, yaw: number): RAPIER.RigidBody {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, CAR_HALF.y + 0.05, pos.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .enabledRotations(false, true, false) // arcade: never roll/pitch
      .setLinearDamping(0.35)
      .setAngularDamping(5)
      .setCcdEnabled(true),
  );
  world.createCollider(carCollider().setMass(120), body);
  return body;
}

export function createRemoteCar(world: RAPIER.World): RAPIER.RigidBody {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
  world.createCollider(carCollider(), body);
  return body;
}

const FWD = new THREE.Vector3();
const VEL = new THREE.Vector3();
const LAT = new THREE.Vector3();
const Q = new THREE.Quaternion();

/** Arcade controller: read velocity, apply engine/brake/grip, write back. Collisions still shove the car because Rapier's solver adjusts velocity during the step and we re-read it next step. */
export function driveCar(body: RAPIER.RigidBody, input: Input, dt: number): void {
  const r = body.rotation();
  Q.set(r.x, r.y, r.z, r.w);
  FWD.set(0, 0, -1).applyQuaternion(Q);
  FWD.y = 0;
  FWD.normalize();
  const lv = body.linvel();
  VEL.set(lv.x, 0, lv.z);
  const fwdSpeed = VEL.dot(FWD);

  let accel = 0;
  if (input.throttle > 0) accel = ENGINE_ACCEL * input.throttle * Math.max(0, 1 - Math.max(0, fwdSpeed) / MAX_SPEED);
  else if (input.throttle < 0) accel = fwdSpeed > 0.5 ? -BRAKE_ACCEL : fwdSpeed > -MAX_REVERSE ? -REVERSE_ACCEL : 0;
  VEL.addScaledVector(FWD, accel * dt);

  LAT.copy(VEL).addScaledVector(FWD, -VEL.dot(FWD)); // lateral component
  const grip = input.handbrake ? GRIP_HANDBRAKE : GRIP;
  VEL.addScaledVector(LAT, -Math.min(1, grip * dt));

  body.setLinvel({ x: VEL.x, y: lv.y, z: VEL.z }, true);

  const speedFactor = THREE.MathUtils.clamp(Math.abs(fwdSpeed) / 11, 0, 1) * Math.sign(fwdSpeed || 1);
  body.setAngvel({ x: 0, y: input.steer * TURN_RATE * speedFactor, z: 0 }, true);
}

export function freezeCar(body: RAPIER.RigidBody): void {
  body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
}
