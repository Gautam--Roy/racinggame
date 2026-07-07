import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { BarrierBox } from './track';
import type { Input } from './input';

export const CAR_HALF = { x: 0.85, y: 0.45, z: 1.8 };
export const MAX_SPEED = 46; // m/s ≈ 166 km/h
const ENGINE_ACCEL = 24;
// Rapier's per-body linear damping (see createLocalCar) continuously bleeds velocity, including
// forward speed. driveCar's throttle taper (1 - fwdSpeed/maxSpeed) was derived assuming a
// frictionless top speed, so damping was quietly capping the CAR well below MAX_SPEED (e.g. ~87
// km/h actual vs ~137 km/h nominal at the old constants) — likely a chunk of the "weird"/underwhelming
// feel. We compensate for it explicitly in the throttle accel below so the taper curve's equilibrium
// lands at the intended maxSpeed instead of wherever engine-force-vs-damping happens to balance.
const LINEAR_DAMPING = 0.35;
const BRAKE_ACCEL = 32;
const REVERSE_ACCEL = 10;
const MAX_REVERSE = 9;
const HANDBRAKE_DECEL = 13; // m/s², extra longitudinal braking while handbrake is held
const HANDBRAKE_MIN_SPEED = 0.5; // m/s, below this we don't apply handbrake decel (no reverse creep)
const HANDBRAKE_THROTTLE_CUT = 0.15; // locking wheels beats throttle: engine force is cut to this fraction
const TURN_RATE = 2.3; // rad/s at full steer
const GRIP = 9; // lateral velocity kill rate
const GRIP_HANDBRAKE = 1.1;
const GRIP_DRIFT_CORNER = GRIP * 0.22; // ≈2.0 — loose cornering grip while drifting
export const DRIFT_ENTER_STEER = 0.65;
export const DRIFT_EXIT_STEER = 0.45;
export const DRIFT_SPEED_THRESHOLD = 15; // m/s
const DRIFT_OVERSTEER_MULT = 1.3; // extra yaw rate while drifting, simulates the rear stepping out

/** True when the car should be sliding: handbrake pulled, or steering hard at speed. Stateless "enter" test — callers owning hysteresis (game.ts) should track their own drifting flag rather than calling this every frame for the exit decision. */
export function isDrifting(steer: number, handbrake: boolean, fwdSpeed: number): boolean {
  return handbrake || (Math.abs(steer) > DRIFT_ENTER_STEER && Math.abs(fwdSpeed) > DRIFT_SPEED_THRESHOLD);
}

/**
 * Pure longitudinal-accel decision, extracted out of driveCar so it's unit-testable without a
 * Rapier world. Composes throttle drive (with damping compensation), brake/reverse, AND handbrake
 * braking: previously handbrake only selected a looser grip constant (driftGripTarget in driveCar)
 * and applied NO deceleration of its own, so "Space" alone (no steering) did nothing but kick up
 * smoke -- this is what makes it actually slow the car down, stacking with the grip-drop snap-slide
 * when combined with steering input.
 *
 * throttle: Input.throttle (+1 forward, -1 brake/reverse, 0 neutral).
 * handbrake: Input.handbrake.
 * fwdSpeed: current forward speed (m/s, signed).
 * engineAccel: effective engine accel for this frame (already scaled by stats/turbo/slip/gearFactor).
 * maxSpeed: effective max speed for this frame (already scaled by stats/turbo/slip).
 */
export function longitudinalAccel(
  throttle: number,
  handbrake: boolean,
  fwdSpeed: number,
  engineAccel: number,
  maxSpeed: number,
): number {
  let accel = 0;
  // Locking the wheels beats the throttle: cut engine force way down while handbrake is held,
  // even if the driver is still holding W.
  const effectiveThrottle = handbrake && throttle > 0 ? throttle * HANDBRAKE_THROTTLE_CUT : throttle;
  if (effectiveThrottle > 0) {
    // Damping compensation: add back what setLinearDamping is about to remove from fwdSpeed this
    // step, so the taper curve's zero-crossing (net accel = 0) actually occurs at maxSpeed rather
    // than at the lower speed where undamped engine force happens to equal the damping loss.
    const dampingCompensation = LINEAR_DAMPING * Math.max(0, fwdSpeed);
    accel =
      engineAccel * effectiveThrottle * Math.max(0, 1 - Math.max(0, fwdSpeed) / maxSpeed) + dampingCompensation;
  } else if (effectiveThrottle < 0) {
    accel = fwdSpeed > 0.5 ? -BRAKE_ACCEL : fwdSpeed > -MAX_REVERSE ? -REVERSE_ACCEL : 0;
  }

  if (handbrake && Math.abs(fwdSpeed) > HANDBRAKE_MIN_SPEED) {
    accel -= HANDBRAKE_DECEL * Math.sign(fwdSpeed);
  }

  return accel;
}

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

/** Optional dynamic modifiers layered on top of the base arcade tuning (turbo boost, slipstream draft). */
export interface DriveOpts {
  turbo: boolean;
  slipBonus: number;
  /** Caller-owned hysteresis flag (see game.ts) — true while the car should behave as drifting (loose cornering grip + oversteer yaw boost). Used for smoke/audio gating; the physics response itself is driven continuously by driftAmount. */
  drifting: boolean;
  /** Continuous 0..1 ramp toward the drifting target (see game.ts), so grip/oversteer engage smoothly over ~200ms instead of snapping the instant the drifting flag flips. Defaults to 0 (no drift). */
  driftAmount?: number;
  /** Per-vehicle performance multipliers (see CAR_STATS in protocol.ts). Defaults to {1,1} (no effect). */
  stats?: { speed: number; accel: number };
  /** Gearbox torque-curve multiplier on engineAccel (see gears.ts gearTorque + GearBox.shiftDip). Defaults to 1 (no effect). */
  gearFactor?: number;
}

const DEFAULT_STATS = { speed: 1, accel: 1 };
const DEFAULT_DRIVE_OPTS: DriveOpts = { turbo: false, slipBonus: 0, drifting: false, driftAmount: 0, stats: DEFAULT_STATS };

/** Arcade controller: read velocity, apply engine/brake/grip, write back. Collisions still shove the car because Rapier's solver adjusts velocity during the step and we re-read it next step. */
export function driveCar(body: RAPIER.RigidBody, input: Input, dt: number, opts: DriveOpts = DEFAULT_DRIVE_OPTS): void {
  const r = body.rotation();
  Q.set(r.x, r.y, r.z, r.w);
  FWD.set(0, 0, -1).applyQuaternion(Q);
  FWD.y = 0;
  FWD.normalize();
  const lv = body.linvel();
  VEL.set(lv.x, 0, lv.z);
  const fwdSpeed = VEL.dot(FWD);

  const stats = opts.stats ?? DEFAULT_STATS;
  const maxSpeed = MAX_SPEED * stats.speed * (opts.turbo ? 1.4 : 1 + opts.slipBonus);
  const engineAccel = ENGINE_ACCEL * stats.accel * (opts.turbo ? 1.6 : 1 + opts.slipBonus) * (opts.gearFactor ?? 1);

  const accel = longitudinalAccel(input.throttle, input.handbrake, fwdSpeed, engineAccel, maxSpeed);
  VEL.addScaledVector(FWD, accel * dt);

  LAT.copy(VEL).addScaledVector(FWD, -VEL.dot(FWD)); // lateral component
  const driftAmount = THREE.MathUtils.clamp(opts.driftAmount ?? 0, 0, 1);
  const driftGripTarget = input.handbrake ? GRIP_HANDBRAKE : GRIP_DRIFT_CORNER;
  const grip = THREE.MathUtils.lerp(GRIP, driftGripTarget, driftAmount);
  VEL.addScaledVector(LAT, -Math.min(1, grip * dt));

  body.setLinvel({ x: VEL.x, y: lv.y, z: VEL.z }, true);

  const speedFactor = THREE.MathUtils.clamp(Math.abs(fwdSpeed) / 11, 0, 1) * Math.sign(fwdSpeed || 1);
  const oversteer = 1 + (DRIFT_OVERSTEER_MULT - 1) * driftAmount;
  body.setAngvel({ x: 0, y: input.steer * TURN_RATE * speedFactor * oversteer, z: 0 }, true);
}

export function freezeCar(body: RAPIER.RigidBody): void {
  body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
}
