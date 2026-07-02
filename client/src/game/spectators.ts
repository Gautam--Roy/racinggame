import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ROAD_WIDTH } from './track';

const UP = new THREE.Vector3(0, 1, 0);

// --- grandstands -----------------------------------------------------------

const STAND_US = [0.02, 0.3, 0.55, 0.8];
const STAND_AWNING_COLORS = [0xd8342a, 0x2a5cd8, 0x2ea84a, 0xe0862a]; // red / blue / green / orange
const STAND_WIDTH = 14;
const STAND_DEPTH = 3.2; // depth of one tier step
const STAND_OFFSET = ROAD_WIDTH / 2 + 7;
const TIER_COUNT = 3;
const TIER_HEIGHT = 1.4;

const CROWD_PER_STAND = 110;
const CROWD_BOB_FREQ = 2.2;
const CROWD_BOB_AMP = 0.18;
const CROWD_SWAY_AMP = 0.06;
const CROWD_ENERGY_RADIUS = 45; // m — cars within this distance double bob amplitude
const CROWD_BODY_RADIUS = 0.22;
const CROWD_BODY_HEIGHT = 0.9;
const CROWD_HEAD_RADIUS = 0.16;

// --- TV cameras --------------------------------------------------------------

const CAMERA_GROUND_US = [0.15, 0.45, 0.7];
const CAMERA_YAW_RATE = 3; // 1/s, exponential approach rate
const CAMERA_MAX_DT = 0.1;

export interface Spectators {
  group: THREE.Group;
  stands: THREE.Vector3[];
  update(tSec: number, cars: THREE.Vector3[]): void;
  dispose(): void;
}

interface TrackFrame {
  pos: THREE.Vector3;
  tangent: THREE.Vector3;
  side: THREE.Vector3;
  yaw: number; // facing from side toward the road (i.e. away from stand's outward side)
}

function trackFrame(curve: THREE.CatmullRomCurve3, u: number): TrackFrame {
  const pos = curve.getPointAt(u);
  const tangent = curve.getTangentAt(u);
  const side = new THREE.Vector3().crossVectors(tangent, UP).normalize();
  return { pos, tangent, side, yaw: 0 };
}

interface StandInstanceData {
  base: THREE.Vector3[];
  phase: number[];
  angle: number[]; // per-instance yaw offset (matches stand facing) so sway rotates correctly
}

/**
 * Builds 4 grandstands with animated crowds and track-side TV camera props along `curve`.
 * Structure is merged into a handful of meshes; crowds are one InstancedMesh per stand.
 * No per-frame allocations in update() — all scratch objects are module/closure-level.
 */
export function buildSpectators(curve: THREE.CatmullRomCurve3): Spectators {
  const group = new THREE.Group();
  const stands: THREE.Vector3[] = [];
  const disposables: { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] }[] = [];

  // ---- shared structure geometry (built once, instanced via merged meshes per stand) ----
  const tierBoxGeo = new THREE.BoxGeometry(STAND_WIDTH, TIER_HEIGHT, STAND_DEPTH);
  const postGeo = new THREE.CylinderGeometry(0.15, 0.15, TIER_COUNT * TIER_HEIGHT + 1.2, 6);
  const roofGeo = new THREE.BoxGeometry(STAND_WIDTH + 1, 0.25, STAND_DEPTH * TIER_COUNT + 1.5);
  const panelGeo = new THREE.BoxGeometry(0.3, TIER_COUNT * TIER_HEIGHT, STAND_DEPTH * TIER_COUNT);
  const structureMat = new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.85 });
  const postMat = new THREE.MeshStandardMaterial({ color: 0x555a60, roughness: 0.7 });
  disposables.push({ geometry: tierBoxGeo }, { geometry: postGeo }, { geometry: roofGeo }, { geometry: panelGeo });
  disposables.push({ material: structureMat }, { material: postMat });

  // ---- crowd body+head merged geometry (shared across all stand InstancedMeshes) ----
  const bodyGeo = new THREE.CylinderGeometry(CROWD_BODY_RADIUS, CROWD_BODY_RADIUS * 1.1, CROWD_BODY_HEIGHT, 6);
  bodyGeo.translate(0, CROWD_BODY_HEIGHT / 2, 0);
  const headGeo = new THREE.SphereGeometry(CROWD_HEAD_RADIUS, 7, 6);
  headGeo.translate(0, CROWD_BODY_HEIGHT + CROWD_HEAD_RADIUS * 0.9, 0);
  const personGeo = mergeGeometries([bodyGeo, headGeo], false) ?? bodyGeo;
  bodyGeo.dispose();
  headGeo.dispose();
  disposables.push({ geometry: personGeo });

  const instancedMeshes: THREE.InstancedMesh[] = [];
  const instancedData: StandInstanceData[] = [];
  const instancedEnergized: Float32Array[] = []; // per-instance current bob energy (1 = normal, 2 = cheering)

  // ---- camera prop geometry (shared) ----
  const legGeo = new THREE.CylinderGeometry(0.03, 0.03, 1.1, 5);
  const camBodyGeo = new THREE.BoxGeometry(0.35, 0.28, 0.5);
  const lensGeo = new THREE.CylinderGeometry(0.09, 0.11, 0.35, 10);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a });
  const camMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.4, metalness: 0.3 });
  disposables.push({ geometry: legGeo }, { geometry: camBodyGeo }, { geometry: lensGeo });
  disposables.push({ material: legMat }, { material: camMat });

  interface CameraRig {
    head: THREE.Group; // yaw-rotated subgroup (box + lens)
    yaw: number;
  }
  const cameras: CameraRig[] = [];

  function buildCameraProp(): CameraRig {
    const root = new THREE.Group();
    // 3-leg tripod
    for (let i = 0; i < 3; i++) {
      const leg = new THREE.Mesh(legGeo, legMat);
      const a = (i / 3) * Math.PI * 2;
      leg.position.set(Math.cos(a) * 0.25, 0.55, Math.sin(a) * 0.25);
      leg.rotation.z = Math.cos(a) * 0.35;
      leg.rotation.x = Math.sin(a) * 0.35;
      root.add(leg);
    }
    const head = new THREE.Group();
    head.position.y = 1.15;
    const box = new THREE.Mesh(camBodyGeo, camMat);
    head.add(box);
    const lens = new THREE.Mesh(lensGeo, camMat);
    lens.rotation.x = Math.PI / 2;
    lens.position.z = -0.4;
    head.add(lens);
    root.add(head);
    group.add(root);
    return { head, yaw: 0 };
  }

  // ---- build 4 grandstands ----
  for (let s = 0; s < STAND_US.length; s++) {
    const u = STAND_US[s];
    const { pos, side } = trackFrame(curve, u);
    const standRoot = new THREE.Group();
    const centerOut = pos.clone().addScaledVector(side, STAND_OFFSET);
    centerOut.y = 0;
    standRoot.position.copy(centerOut);
    // face the road: forward direction is -side (from stand toward track centerline)
    const facing = side.clone().negate();
    standRoot.rotation.y = Math.atan2(facing.x, facing.z);
    group.add(standRoot);
    stands.push(centerOut.clone().setY(1.5));

    // 3 tiered steps: each tier rises and recedes away from the road
    const tierBoxes: THREE.Mesh[] = [];
    for (let t = 0; t < TIER_COUNT; t++) {
      const box = new THREE.Mesh(tierBoxGeo, structureMat);
      box.position.set(0, TIER_HEIGHT / 2 + t * TIER_HEIGHT, -(t * STAND_DEPTH));
      box.scale.z = 1; // geometry already STAND_DEPTH deep
      standRoot.add(box);
      tierBoxes.push(box);
    }

    // corner posts + roof slab
    const roofY = TIER_COUNT * TIER_HEIGHT + 0.6;
    const postXs = [-STAND_WIDTH / 2 + 0.4, STAND_WIDTH / 2 - 0.4];
    const postZs = [0.5, -(STAND_DEPTH * (TIER_COUNT - 1) + 0.5)];
    for (const px of postXs) {
      for (const pz of postZs) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(px, roofY / 2, pz);
        standRoot.add(post);
      }
    }
    const awningMat = new THREE.MeshStandardMaterial({ color: STAND_AWNING_COLORS[s % STAND_AWNING_COLORS.length], roughness: 0.6 });
    disposables.push({ material: awningMat });
    const roof = new THREE.Mesh(roofGeo, awningMat);
    roof.position.set(0, roofY, -(STAND_DEPTH * (TIER_COUNT - 1)) / 2);
    standRoot.add(roof);

    // 2 side panels
    for (const px of [-STAND_WIDTH / 2 - 0.1, STAND_WIDTH / 2 + 0.1]) {
      const panel = new THREE.Mesh(panelGeo, structureMat);
      panel.position.set(px, (TIER_COUNT * TIER_HEIGHT) / 2, -(STAND_DEPTH * (TIER_COUNT - 1)) / 2);
      standRoot.add(panel);
    }

    // ---- crowd instanced mesh, seated across the 3 tiers ----
    const crowdMat = new THREE.MeshStandardMaterial({ roughness: 0.9, vertexColors: false });
    disposables.push({ material: crowdMat });
    const instanced = new THREE.InstancedMesh(personGeo, crowdMat, CROWD_PER_STAND);
    instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const base: THREE.Vector3[] = [];
    const phase: number[] = [];
    const angle: number[] = [];
    const color = new THREE.Color();
    const tmpMat = new THREE.Matrix4();
    const tmpQuat = new THREE.Quaternion();
    const tmpScale = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < CROWD_PER_STAND; i++) {
      const tier = i % TIER_COUNT;
      const acrossJitter = (Math.random() - 0.5) * (STAND_WIDTH - 1.2);
      const depthJitter = (Math.random() - 0.5) * (STAND_DEPTH - 0.6);
      const bx = acrossJitter;
      const by = TIER_HEIGHT * tier + 0.05;
      const bz = -(tier * STAND_DEPTH) - STAND_DEPTH / 2 + depthJitter;
      const b = new THREE.Vector3(bx, by, bz);
      base.push(b);
      phase.push(Math.random() * Math.PI * 2);
      const a = Math.PI + (Math.random() - 0.5) * 0.3; // face the road (root already faces road via +z front)
      angle.push(a);
      tmpQuat.setFromAxisAngle(UP, a);
      tmpMat.compose(b, tmpQuat, tmpScale);
      instanced.setMatrixAt(i, tmpMat);
      color.setHSL(Math.random(), 0.55 + Math.random() * 0.3, 0.35 + Math.random() * 0.3);
      instanced.setColorAt(i, color);
    }
    instanced.instanceMatrix.needsUpdate = true;
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
    standRoot.add(instanced);
    instancedMeshes.push(instanced);
    instancedData.push({ base, phase, angle });
    instancedEnergized.push(new Float32Array(1).fill(1));

    // TV camera at this stand's track-facing corner
    const rig = buildCameraProp();
    rig.head.parent!.position.set(
      centerOut.x + facing.x * 1.5 + side.x * (STAND_WIDTH / 2 - 1),
      0,
      centerOut.z + facing.z * 1.5 + side.z * (STAND_WIDTH / 2 - 1),
    );
    cameras.push(rig);
  }

  // ---- 3 ground-spot TV cameras, opposite side of the road from stands at those u values ----
  // Stands sit on `side` at STAND_US; opposite-side ground cams use the local frame's side * -1.
  for (const u of CAMERA_GROUND_US) {
    const { pos, side } = trackFrame(curve, u);
    const p = pos.clone().addScaledVector(side, -(ROAD_WIDTH / 2 + 4));
    p.y = 0;
    const rig = buildCameraProp();
    rig.head.parent!.position.copy(p);
    cameras.push(rig);
  }

  // ---- update scratch (module/closure-level, no per-frame allocation) ----
  const scratchMat = new THREE.Matrix4();
  const scratchQuat = new THREE.Quaternion();
  const scratchPos = new THREE.Vector3();
  const scratchScale = new THREE.Vector3(1, 1, 1);
  const camWorldPos = new THREE.Vector3();
  const camToTarget = new THREE.Vector3();
  const standWorldPos = stands; // already world-space centers, reused for proximity checks
  let frameCounter = 0;
  let lastT = 0;

  function update(tSec: number, cars: THREE.Vector3[]): void {
    const dt = lastT === 0 ? 0 : Math.min(CAMERA_MAX_DT, Math.max(0, tSec - lastT));
    lastT = tSec;

    frameCounter++;
    const doCrowd = frameCounter % 2 === 0;

    if (doCrowd) {
      for (let s = 0; s < instancedMeshes.length; s++) {
        const mesh = instancedMeshes[s];
        const data = instancedData[s];
        // energy: double amplitude if any car is within CROWD_ENERGY_RADIUS of this stand
        let energized = false;
        const standPos = standWorldPos[s];
        for (let c = 0; c < cars.length; c++) {
          const dx = cars[c].x - standPos.x;
          const dz = cars[c].z - standPos.z;
          if (dx * dx + dz * dz < CROWD_ENERGY_RADIUS * CROWD_ENERGY_RADIUS) {
            energized = true;
            break;
          }
        }
        const ampMul = energized ? 2 : 1;
        for (let i = 0; i < data.base.length; i++) {
          const b = data.base[i];
          const phase = data.phase[i];
          const bob = Math.abs(Math.sin(tSec * CROWD_BOB_FREQ + phase)) * CROWD_BOB_AMP * ampMul;
          const sway = Math.sin(tSec * CROWD_BOB_FREQ * 0.5 + phase) > 0 ? CROWD_SWAY_AMP : -CROWD_SWAY_AMP;
          scratchPos.set(b.x, b.y + bob, b.z);
          scratchQuat.setFromAxisAngle(UP, data.angle[i]);
          // apply a small extra roll via a secondary rotation around Z is not representable through
          // a single axis-angle on Y alone; combine yaw with a Z-tilt using Euler.
          EULER_SCRATCH.set(0, data.angle[i], sway);
          scratchQuat.setFromEuler(EULER_SCRATCH);
          scratchMat.compose(scratchPos, scratchQuat, scratchScale);
          mesh.setMatrixAt(i, scratchMat);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
    }

    // TV cameras: yaw-lerp toward nearest car
    for (let i = 0; i < cameras.length; i++) {
      const rig = cameras[i];
      const root = rig.head.parent!;
      root.getWorldPosition(camWorldPos);
      let nearest: THREE.Vector3 | null = null;
      let bestDist = Infinity;
      for (let c = 0; c < cars.length; c++) {
        const d = camWorldPos.distanceToSquared(cars[c]);
        if (d < bestDist) {
          bestDist = d;
          nearest = cars[c];
        }
      }
      if (!nearest) continue;
      camToTarget.subVectors(nearest, camWorldPos);
      const targetYaw = Math.atan2(camToTarget.x, camToTarget.z) - root.rotation.y;
      const alpha = dt > 0 ? 1 - Math.exp(-CAMERA_YAW_RATE * dt) : 0;
      rig.yaw = lerpAngle(rig.yaw, targetYaw, alpha);
      rig.head.rotation.y = rig.yaw;
    }
  }

  function dispose(): void {
    for (const mesh of instancedMeshes) mesh.dispose();
    for (const d of disposables) {
      d.geometry?.dispose();
      if (d.material) {
        if (Array.isArray(d.material)) d.material.forEach((m) => m.dispose());
        else d.material.dispose();
      }
    }
  }

  return { group, stands, update, dispose };
}

const EULER_SCRATCH = new THREE.Euler();

/** Shortest-path lerp between two angles (radians). */
function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}
