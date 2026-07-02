import * as THREE from 'three';

/** Spline u positions (center of road) for each turbo pickup. Length must equal PICKUP_COUNT. */
export const PICKUP_US = [0.12, 0.31, 0.55, 0.68, 0.86];
export const RESPAWN_MS = 10_000;

const HOVER_HEIGHT = 1.2;
const RADIUS = 0.9;
const BOB_AMPLITUDE = 0.18;
const BOB_SPEED = 1.6; // rad/s
const SPIN_SPEED = 1.4; // rad/s

/** Pure state machine tracking which pickups are currently taken and when they respawn. */
export class PickupBoard {
  private takenAt = new Map<number, number>();

  available(idx: number, now: number): boolean {
    const t = this.takenAt.get(idx);
    return t === undefined || now - t >= RESPAWN_MS;
  }

  /** Marks idx as taken at `now`. Returns false if out of range or already taken (not yet respawned). */
  take(idx: number, now: number): boolean {
    if (idx < 0 || idx >= PICKUP_US.length) return false;
    if (!this.available(idx, now)) return false;
    this.takenAt.set(idx, now);
    return true;
  }
}

const SLIP_MIN_AHEAD = 4;
const SLIP_MAX_AHEAD = 14;
const SLIP_MAX_LATERAL = 2.2;
const SLIP_MIN_SPEED = 15;
const SLIP_BONUS = 0.15;

const SLIP_DELTA = new THREE.Vector3();

/**
 * Target slipstream bonus (0 or SLIP_BONUS) for the current frame: any remote car
 * 4-14m ahead of ownPos along ownFwd, within 2.2m lateral offset, while own speed
 * exceeds 15 m/s, grants a draft. Pure function — smoothing happens in the caller.
 */
export function slipstreamTarget(
  ownPos: THREE.Vector3,
  ownFwd: THREE.Vector3,
  ownSpeed: number,
  remotePositions: THREE.Vector3[],
): number {
  if (ownSpeed <= SLIP_MIN_SPEED) return 0;
  for (const rp of remotePositions) {
    SLIP_DELTA.set(rp.x - ownPos.x, 0, rp.z - ownPos.z);
    const ahead = SLIP_DELTA.x * ownFwd.x + SLIP_DELTA.z * ownFwd.z;
    if (ahead < SLIP_MIN_AHEAD || ahead > SLIP_MAX_AHEAD) continue;
    const lateral = Math.abs(SLIP_DELTA.x * -ownFwd.z + SLIP_DELTA.z * ownFwd.x);
    if (lateral >= SLIP_MAX_LATERAL) continue;
    return SLIP_BONUS;
  }
  return 0;
}

export interface Pickups {
  meshes: THREE.Mesh[];
  board: PickupBoard;
  update(nowMs: number, dt: number): void;
}

/** Builds the 5 spinning/bobbing turbo pickups along the track centerline. Shares one geometry+material. */
export function buildPickups(scene: THREE.Scene, curve: THREE.CatmullRomCurve3): Pickups {
  const geometry = new THREE.IcosahedronGeometry(RADIUS, 0);
  const material = new THREE.MeshStandardMaterial({
    color: 0x22ddee,
    emissive: 0x22ddee,
    emissiveIntensity: 1.2,
    roughness: 0.3,
    metalness: 0.2,
  });

  const board = new PickupBoard();
  const meshes: THREE.Mesh[] = [];
  const basePositions: THREE.Vector3[] = [];
  const phases: number[] = [];

  for (let i = 0; i < PICKUP_US.length; i++) {
    const p = curve.getPointAt(PICKUP_US[i]);
    const base = p.clone().setY(HOVER_HEIGHT);
    basePositions.push(base);
    phases.push(i * 1.3);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(base);
    scene.add(mesh);
    meshes.push(mesh);
  }

  function update(nowMs: number, dt: number): void {
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      const visible = board.available(i, nowMs);
      mesh.visible = visible;
      if (!visible) continue;
      mesh.rotation.y += SPIN_SPEED * dt;
      mesh.rotation.x += SPIN_SPEED * 0.6 * dt;
      const bob = Math.sin(nowMs / 1000 * BOB_SPEED + phases[i]) * BOB_AMPLITUDE;
      mesh.position.y = basePositions[i].y + bob;
    }
  }

  return { meshes, board, update };
}
