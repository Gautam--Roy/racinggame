import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ROAD_WIDTH } from './track';

const UP = new THREE.Vector3(0, 1, 0);

// --- grandstands -----------------------------------------------------------

/** Each stand's track position (u) and which side of the road it sits on (+1/-1).
 * The two start-area stands (u≈0.98 and u≈0.045) flank the grid on opposite sides of the road;
 * all others sit on the +side. */
interface StandSpec {
  u: number;
  side: 1 | -1;
}
const STAND_SPECS: StandSpec[] = [
  { u: 0.3, side: 1 },
  { u: 0.55, side: 1 },
  { u: 0.8, side: 1 },
  { u: 0.98, side: 1 },
  { u: 0.045, side: -1 },
  { u: 0.15, side: 1 },
  { u: 0.45, side: 1 },
  { u: 0.68, side: 1 },
];
// Stand-corner TV cameras only on 4 of the 8 stands, for perf.
const CAMERA_STAND_INDICES = new Set([0, 2, 3, 4]);

const STAND_AWNING_COLORS = [0xd8342a, 0x2a5cd8, 0x2ea84a, 0xe0862a, 0x9c3fd8, 0xd8ac2a, 0x2ac7c2, 0xd85f8f];
const STAND_WIDTH = 14;
const STAND_DEPTH = 3.2; // depth of one tier step
const STAND_OFFSET = ROAD_WIDTH / 2 + 7;
const TIER_COUNT = 3;
const TIER_HEIGHT = 1.4;
// Roof clears the tallest seated occupant (top tier, seated, at bob peak) — see seating math below.
const ROOF_HEADROOM = 1.0;
const ROOF_Y = TIER_COUNT * TIER_HEIGHT + ROOF_HEADROOM; // 5.2

const CROWD_PER_STAND = 110;
const CROWD_BOB_FREQ = 2.2;
const CROWD_BOB_AMP = 0.12; // seated bounce (was 0.18 when standing)
const CROWD_SWAY_AMP = 0.06;
const CROWD_ENERGY_RADIUS = 45; // m — cars within this distance double bob amplitude
const CROWD_ENERGY_LERP_RATE = 4; // 1/s — how fast a stand's energy ramps toward its target
const CROWD_BODY_RADIUS = 0.22;
// Seated: body cylinder is a short seated torso/lap, not a standing figure.
const CROWD_BODY_HEIGHT = 0.55;
const CROWD_HEAD_RADIUS = 0.13;
// person total height (body + head sphere placed per findHeadCenter below) — see module-level assert.
const CROWD_PERSON_HEIGHT = CROWD_BODY_HEIGHT + CROWD_HEAD_RADIUS * 0.9 + CROWD_HEAD_RADIUS;

// ---- seating clearance proof (computed once at module load, thrown if violated) ----
{
  const topTierSeatY = TIER_HEIGHT * TIER_COUNT; // seat surface for tier index TIER_COUNT-1
  const headTopAtBobPeak = topTierSeatY + CROWD_PERSON_HEIGHT + CROWD_BOB_AMP;
  const clearance = ROOF_Y - headTopAtBobPeak;
  // eslint-disable-next-line no-console
  console.info(
    `[spectators] seating clearance: personHeight=${CROWD_PERSON_HEIGHT.toFixed(3)} topTierSeatY=${topTierSeatY.toFixed(2)} ` +
      `headTopAtBobPeak=${headTopAtBobPeak.toFixed(3)} roofY=${ROOF_Y.toFixed(2)} clearance=${clearance.toFixed(3)}`,
  );
  if (clearance <= 0) {
    throw new Error(`[spectators] seated crowd clips the roof: clearance=${clearance.toFixed(3)} <= 0`);
  }
}

// --- TV cameras --------------------------------------------------------------

const CAMERA_GROUND_US = [0.15, 0.45, 0.7];
const CAMERA_YAW_RATE = 3; // 1/s, exponential approach rate
const CAMERA_MAX_DT = 0.1;

// --- start-grid flags --------------------------------------------------------

const FLAG_COUNT = 6;
const FLAG_POLE_HEIGHT = 4;
const FLAG_COLORS = [0xd8342a, 0x2a5cd8, 0xe0862a, 0x2ea84a]; // solid accent colors mixed with checker
const FLAG_U_MIN = 0.985;
const FLAG_U_MAX = 0.015; // wraps past u=1 -> 0
const FLAG_FLUTTER_YAW_AMP = 0.25;
const FLAG_FLUTTER_Z_AMP = 0.15;
const FLAG_FLUTTER_FREQ = 3;

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
}

function trackFrame(curve: THREE.CatmullRomCurve3, u: number): TrackFrame {
  const uu = ((u % 1) + 1) % 1;
  const pos = curve.getPointAt(uu);
  const tangent = curve.getTangentAt(uu);
  const side = new THREE.Vector3().crossVectors(tangent, UP).normalize();
  return { pos, tangent, side };
}

interface StandInstanceData {
  base: THREE.Vector3[];
  phase: number[];
  angle: number[]; // per-instance yaw offset (matches stand facing) so sway rotates correctly
}

/** Generates an 8x8 black/white checker pattern CanvasTexture, used for checkered flags. */
function buildCheckerTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#111' : '#fff';
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Builds 8 grandstands with animated crowds and track-side TV camera props along `curve`,
 * plus a start-grid flag/marshal area near the line. Structure is merged into a handful of
 * meshes; crowds are one InstancedMesh per stand. No per-frame allocations in update().
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
  // Seated figure: short body (torso/lap height, not standing) + head on top.
  const bodyGeo = new THREE.CylinderGeometry(CROWD_BODY_RADIUS, CROWD_BODY_RADIUS * 1.1, CROWD_BODY_HEIGHT, 6);
  bodyGeo.translate(0, CROWD_BODY_HEIGHT / 2, 0);
  const headGeo = new THREE.SphereGeometry(CROWD_HEAD_RADIUS, 7, 6);
  headGeo.translate(0, CROWD_BODY_HEIGHT + CROWD_HEAD_RADIUS * 0.9, 0);
  const mergedPersonGeo = mergeGeometries([bodyGeo, headGeo], false);
  const personGeo = mergedPersonGeo ?? bodyGeo;
  if (mergedPersonGeo) {
    bodyGeo.dispose();
    headGeo.dispose();
  }
  disposables.push({ geometry: personGeo });

  // ---- standing figure (for marshal props near the grid — scaled 1.2x standing pose) ----
  const standBodyGeo = new THREE.CylinderGeometry(CROWD_BODY_RADIUS, CROWD_BODY_RADIUS * 1.1, 0.9, 6);
  standBodyGeo.translate(0, 0.45, 0);
  const standHeadGeo = new THREE.SphereGeometry(CROWD_HEAD_RADIUS, 7, 6);
  standHeadGeo.translate(0, 0.9 + CROWD_HEAD_RADIUS * 0.9, 0);
  const mergedStandingGeo = mergeGeometries([standBodyGeo, standHeadGeo], false);
  const standingPersonGeo = mergedStandingGeo ?? standBodyGeo;
  if (mergedStandingGeo) {
    standBodyGeo.dispose();
    standHeadGeo.dispose();
  }
  disposables.push({ geometry: standingPersonGeo });

  const instancedMeshes: THREE.InstancedMesh[] = [];
  const instancedData: StandInstanceData[] = [];
  const standEnergy: number[] = []; // per-stand smoothed bob energy (ramps toward 1 = normal, 2 = cheering)

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

  // ---- build 8 grandstands ----
  for (let s = 0; s < STAND_SPECS.length; s++) {
    const { u, side: sideSign } = STAND_SPECS[s];
    const { pos, side: sideVec } = trackFrame(curve, u);
    const side = sideVec.clone().multiplyScalar(sideSign);
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
    for (let t = 0; t < TIER_COUNT; t++) {
      const box = new THREE.Mesh(tierBoxGeo, structureMat);
      box.position.set(0, TIER_HEIGHT / 2 + t * TIER_HEIGHT, -(t * STAND_DEPTH));
      standRoot.add(box);
    }

    // corner posts + roof slab
    const postXs = [-STAND_WIDTH / 2 + 0.4, STAND_WIDTH / 2 - 0.4];
    const postZs = [0.5, -(STAND_DEPTH * (TIER_COUNT - 1) + 0.5)];
    for (const px of postXs) {
      for (const pz of postZs) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(px, ROOF_Y / 2, pz);
        standRoot.add(post);
      }
    }
    const awningMat = new THREE.MeshStandardMaterial({ color: STAND_AWNING_COLORS[s % STAND_AWNING_COLORS.length], roughness: 0.6 });
    disposables.push({ material: awningMat });
    const roof = new THREE.Mesh(roofGeo, awningMat);
    roof.position.set(0, ROOF_Y, -(STAND_DEPTH * (TIER_COUNT - 1)) / 2);
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
      // Person geometry's bottom is at local y=0 (body cylinder translated so its base sits at
      // the origin). Seat it flush on this tier's TOP surface: tier `t`'s box is centered at
      // TIER_HEIGHT/2 + t*TIER_HEIGHT with height TIER_HEIGHT, so its top is TIER_HEIGHT*(t+1).
      const by = TIER_HEIGHT * (tier + 1);
      // Pull instances forward off the tier's leading edge (away from the riser in front) so feet
      // don't poke through the next tier down; bias jitter range toward the back half of the tread.
      const bz = -(tier * STAND_DEPTH) - STAND_DEPTH / 2 + depthJitter * 0.5 - STAND_DEPTH * 0.15;
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
    standEnergy.push(1);

    // TV camera at this stand's track-facing corner — only on the 4 selected stands (perf)
    if (CAMERA_STAND_INDICES.has(s)) {
      const rig = buildCameraProp();
      rig.head.parent!.position.set(
        centerOut.x + facing.x * 1.5 + side.x * (STAND_WIDTH / 2 - 1),
        0,
        centerOut.z + facing.z * 1.5 + side.z * (STAND_WIDTH / 2 - 1),
      );
      cameras.push(rig);
    }
  }

  // ---- 3 ground-spot TV cameras, opposite side of the road from stands at those u values ----
  for (const u of CAMERA_GROUND_US) {
    const { pos, side } = trackFrame(curve, u);
    const p = pos.clone().addScaledVector(side, -(ROAD_WIDTH / 2 + 4));
    p.y = 0;
    const rig = buildCameraProp();
    rig.head.parent!.position.copy(p);
    cameras.push(rig);
  }

  // ---- start-grid flag area: 6 flagpoles + 2 marshal boxes, off-road both sides near u~0.99-0.01 ----
  const checkerTexture = buildCheckerTexture();
  const poleGeo = new THREE.CylinderGeometry(0.05, 0.06, FLAG_POLE_HEIGHT, 6);
  const flagGeo = new THREE.PlaneGeometry(1.2, 0.8, 4, 1);
  flagGeo.translate(0.6, 0, 0); // hinge edge at the pole (local x=0)
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.4, roughness: 0.5 });
  disposables.push({ geometry: poleGeo }, { geometry: flagGeo }, { material: poleMat });

  interface FlagRig {
    plane: THREE.Mesh;
    phase: number;
  }
  const flags: FlagRig[] = [];
  const flagMaterials: THREE.Material[] = [];

  for (let i = 0; i < FLAG_COUNT; i++) {
    // alternate sides of the road, spread across the grid-zone u range (wraps past u=1)
    const t = i / (FLAG_COUNT - 1);
    let u = FLAG_U_MIN + t * (FLAG_U_MAX + (1 - FLAG_U_MIN));
    u = u % 1;
    const sideSign: 1 | -1 = i % 2 === 0 ? 1 : -1;
    const { pos, side: sideVec } = trackFrame(curve, u);
    const p = pos.clone().addScaledVector(sideVec, sideSign * (ROAD_WIDTH / 2 + 3));
    p.y = 0;

    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.copy(p).setY(FLAG_POLE_HEIGHT / 2);
    group.add(pole);

    const useChecker = i % 2 === 0;
    const flagMat = new THREE.MeshStandardMaterial({
      map: useChecker ? checkerTexture : null,
      color: useChecker ? 0xffffff : FLAG_COLORS[i % FLAG_COLORS.length],
      side: THREE.DoubleSide,
      roughness: 0.8,
    });
    flagMaterials.push(flagMat);
    const plane = new THREE.Mesh(flagGeo, flagMat);
    plane.position.copy(p).setY(FLAG_POLE_HEIGHT - 0.5);
    group.add(plane);
    flags.push({ plane, phase: Math.random() * Math.PI * 2 });
  }

  // 2 marshal boxes (1.5m cube podium + a scaled-up standing person) near the grid
  const podiumGeo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
  const podiumMat = new THREE.MeshStandardMaterial({ color: 0xe0862a, roughness: 0.7 });
  disposables.push({ geometry: podiumGeo }, { material: podiumMat });
  const marshalMat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  disposables.push({ material: marshalMat });
  for (const sideSign of [1, -1] as const) {
    const u = 0.995 + (sideSign === -1 ? 0.02 : 0);
    const { pos, side: sideVec } = trackFrame(curve, u % 1);
    const p = pos.clone().addScaledVector(sideVec, sideSign * (ROAD_WIDTH / 2 + 5.5));
    p.y = 0;
    const podium = new THREE.Mesh(podiumGeo, podiumMat);
    podium.position.copy(p).setY(0.75);
    group.add(podium);
    const marshal = new THREE.Mesh(standingPersonGeo, marshalMat);
    marshal.scale.setScalar(1.2);
    marshal.position.copy(p).setY(1.5);
    const facing = sideVec.clone().multiplyScalar(-sideSign);
    marshal.rotation.y = Math.atan2(facing.x, facing.z);
    group.add(marshal);
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
  let lastCrowdT = 0;

  function update(tSec: number, cars: THREE.Vector3[]): void {
    const dt = lastT === 0 ? 0 : Math.min(CAMERA_MAX_DT, Math.max(0, tSec - lastT));
    lastT = tSec;

    frameCounter++;
    const doCrowd = frameCounter % 2 === 0;

    if (doCrowd) {
      const crowdDt = lastCrowdT === 0 ? 0 : Math.min(CAMERA_MAX_DT * 2, Math.max(0, tSec - lastCrowdT));
      lastCrowdT = tSec;
      const energyAlpha = crowdDt > 0 ? 1 - Math.exp(-CROWD_ENERGY_LERP_RATE * crowdDt) : 0;
      for (let s = 0; s < instancedMeshes.length; s++) {
        const mesh = instancedMeshes[s];
        const data = instancedData[s];
        // energy target: double amplitude if any car is within CROWD_ENERGY_RADIUS of this stand;
        // smoothly ramp the stand's actual energy toward that target so amplitude doesn't pop.
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
        const targetEnergy = energized ? 2 : 1;
        standEnergy[s] += (targetEnergy - standEnergy[s]) * energyAlpha;
        const ampMul = standEnergy[s];
        for (let i = 0; i < data.base.length; i++) {
          const b = data.base[i];
          const phase = data.phase[i];
          const bob = Math.abs(Math.sin(tSec * CROWD_BOB_FREQ + phase)) * CROWD_BOB_AMP * ampMul;
          const sway = Math.sin(tSec * CROWD_BOB_FREQ * 0.5 + phase) > 0 ? CROWD_SWAY_AMP : -CROWD_SWAY_AMP;
          scratchPos.set(b.x, b.y + bob, b.z);
          // a yaw + Z-tilt sway isn't representable via a single axis-angle on Y alone,
          // so encode both fully via Euler (yaw on Y, sway tilt on Z) in one composed rotation.
          EULER_SCRATCH.set(0, data.angle[i], sway);
          scratchQuat.setFromEuler(EULER_SCRATCH);
          scratchMat.compose(scratchPos, scratchQuat, scratchScale);
          mesh.setMatrixAt(i, scratchMat);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
    }

    // flag flutter: cheap per-frame rotation oscillation, no shader
    for (const f of flags) {
      f.plane.rotation.y = Math.sin(tSec * FLAG_FLUTTER_FREQ * 0.6 + f.phase) * FLAG_FLUTTER_YAW_AMP;
      f.plane.rotation.z = Math.sin(tSec * FLAG_FLUTTER_FREQ + f.phase) * FLAG_FLUTTER_Z_AMP;
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
    for (const m of flagMaterials) m.dispose();
    checkerTexture.dispose();
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
