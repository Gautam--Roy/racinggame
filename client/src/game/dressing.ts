import * as THREE from 'three';
import { ROAD_WIDTH } from './track';

const UP = new THREE.Vector3(0, 1, 0);

export interface Dressing {
  group: THREE.Group;
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

// ---- tire stacks: hairpin outside (u≈0.204, apex) + 2 sweeper apexes (u≈0.296, u≈0.343) ----
// u values derived by sampling the actual CONTROL_POINTS curve in track.ts (nearest-point search
// against the hairpin's apex control point [183,-60] and the two sweeper control points
// [75,-40]/[25,-10] — see commit history for the probe script/output).
interface TireStackSpec {
  u: number;
  side: 1 | -1; // which side of the road (outside of the corner)
  offset: number; // extra distance beyond ROAD_WIDTH/2
}
const TIRE_STACK_SPECS: TireStackSpec[] = [
  { u: 0.204, side: 1, offset: 2.5 }, // hairpin apex, outside
  { u: 0.176, side: 1, offset: 2.5 }, // hairpin entry-side, outside
  { u: 0.232, side: 1, offset: 2.5 }, // hairpin exit-side, outside
  { u: 0.296, side: -1, offset: 2.2 }, // sweeper apex 1
  { u: 0.343, side: -1, offset: 2.2 }, // sweeper apex 2
];
const TIRES_PER_STACK = 5;
const TIRE_RADIUS = 0.45;
const TIRE_TUBE = 0.22;
const TIRE_STACK_HEIGHT = 4; // tires per stack (vertical count)

// ---- sponsor billboards along straights ----
interface BillboardSpec {
  u: number;
  side: 1 | -1;
  text: string;
  bg: string;
  fg: string;
}
const BILLBOARD_SPECS: BillboardSpec[] = [
  { u: 0.03, side: 1, text: 'VELOCITY', bg: '#0d3b8c', fg: '#ffffff' },
  { u: 0.07, side: -1, text: 'RUSH ENERGY', bg: '#c81e2c', fg: '#ffe14d' },
  { u: 0.12, side: 1, text: 'KENNEY MOTORS', bg: '#1a1a1a', fg: '#f0f0f0' },
  { u: 0.62, side: 1, text: 'TURBO+', bg: '#e0862a', fg: '#1a1a1a' },
];
const BILLBOARD_W = 6;
const BILLBOARD_H = 2.5;
const BILLBOARD_POST_HEIGHT = 4;

// ---- brake marker boards approaching the hairpin (right side) ----
// Hairpin apex at u≈0.204; boards count down 100/50/25m before it, placed on the approach side.
const HAIRPIN_APEX_U = 0.204;
const BRAKE_MARKER_DISTANCES_M = [100, 50, 25];

// ---- pit building, opposite the grid stands ----
const PIT_U = 0.965; // near start/finish, opposite side from the grid-area stand
const PIT_WIDTH = 12;
const PIT_HEIGHT = 4;
const PIT_DEPTH = 6;

// ---- light poles ----
const LIGHT_POLE_COUNT = 6;
const LIGHT_POLE_HEIGHT = 7;

/** Approximate along-track meters-per-u near a given u (used to place brake markers at exact
 * along-track distances before the hairpin apex, rather than in u-space directly). */
function metersToU(curve: THREE.CatmullRomCurve3, atU: number, meters: number): number {
  const totalLen = curve.getLength();
  return ((atU - meters / totalLen) % 1 + 1) % 1;
}

/** Builds a small canvas-texture billboard panel with a solid background + centered text. */
function buildBillboardTexture(text: string, bg: string, fg: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512 * (BILLBOARD_H / BILLBOARD_W);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = fg;
  ctx.lineWidth = 8;
  ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  ctx.fillStyle = fg;
  ctx.font = `bold ${Math.floor(canvas.height * 0.28)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Builds a brake-marker board canvas texture: white background, bold number, red border stripe. */
function buildBrakeMarkerTexture(distance: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#d8342a';
  const stripeH = canvas.height * 0.12;
  ctx.fillRect(0, 0, canvas.width, stripeH);
  ctx.fillRect(0, canvas.height - stripeH, canvas.width, stripeH);
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 110px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(distance), canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Builds static track-side dressing: tire stacks at the hairpin outside + 2 sweeper apexes,
 * sponsor billboards along the straights, brake-marker boards approaching the hairpin, a pit
 * building opposite the grid stands, and light poles. Everything here is static (no per-frame
 * updates) — geometry/materials are shared and instanced where there are more than a few repeats,
 * and dispose() releases every GPU resource this module allocates.
 */
export function buildDressing(curve: THREE.CatmullRomCurve3): Dressing {
  const group = new THREE.Group();
  const disposables: { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[]; texture?: THREE.Texture }[] = [];

  // ---- tire stacks: instanced torus rings, black with one red/white ring accent per stack ----
  const tireGeo = new THREE.TorusGeometry(TIRE_RADIUS, TIRE_TUBE, 8, 16);
  tireGeo.rotateX(Math.PI / 2);
  const blackTireMat = new THREE.MeshStandardMaterial({ color: 0x181818, roughness: 0.95 });
  const redTireMat = new THREE.MeshStandardMaterial({ color: 0xc8342a, roughness: 0.7 });
  const whiteTireMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.7 });
  disposables.push({ geometry: tireGeo }, { material: blackTireMat }, { material: redTireMat }, { material: whiteTireMat });

  const totalTires = TIRE_STACK_SPECS.length * TIRES_PER_STACK * TIRE_STACK_HEIGHT;
  const blackTires = new THREE.InstancedMesh(tireGeo, blackTireMat, totalTires);
  const accentTires = new THREE.InstancedMesh(tireGeo, redTireMat, TIRE_STACK_SPECS.length * TIRES_PER_STACK);
  const whiteAccentTires = new THREE.InstancedMesh(tireGeo, whiteTireMat, TIRE_STACK_SPECS.length * TIRES_PER_STACK);
  let blackIdx = 0;
  let accentIdx = 0;
  let whiteIdx = 0;
  const m4 = new THREE.Matrix4();
  const q4 = new THREE.Quaternion();
  const s4 = new THREE.Vector3(1, 1, 1);
  const stackSpacing = TIRE_RADIUS * 2.1;

  for (const spec of TIRE_STACK_SPECS) {
    const { pos, side: sideVec } = trackFrame(curve, spec.u);
    const clusterCenter = pos.clone().addScaledVector(sideVec, spec.side * (ROAD_WIDTH / 2 + spec.offset));
    // cluster of TIRES_PER_STACK stacks arranged in a small arc, each stack TIRE_STACK_HEIGHT tall
    for (let stackI = 0; stackI < TIRES_PER_STACK; stackI++) {
      const angle = (stackI / TIRES_PER_STACK) * Math.PI * 2;
      const cx = clusterCenter.x + Math.cos(angle) * stackSpacing * 1.4;
      const cz = clusterCenter.z + Math.sin(angle) * stackSpacing * 1.4;
      // accent ring: red or white alternating per stack, placed at the top of the stack
      const useRed = stackI % 2 === 0;
      for (let h = 0; h < TIRE_STACK_HEIGHT; h++) {
        const y = TIRE_TUBE + h * (TIRE_TUBE * 2 + 0.02);
        m4.compose(new THREE.Vector3(cx, y, cz), q4, s4);
        if (h === TIRE_STACK_HEIGHT - 1) {
          if (useRed) accentTires.setMatrixAt(accentIdx++, m4);
          else whiteAccentTires.setMatrixAt(whiteIdx++, m4);
        } else {
          blackTires.setMatrixAt(blackIdx++, m4);
        }
      }
    }
  }
  blackTires.count = blackIdx;
  accentTires.count = accentIdx;
  whiteAccentTires.count = whiteIdx;
  blackTires.instanceMatrix.needsUpdate = true;
  accentTires.instanceMatrix.needsUpdate = true;
  whiteAccentTires.instanceMatrix.needsUpdate = true;
  group.add(blackTires, accentTires, whiteAccentTires);

  // ---- sponsor billboards: posts + 6x2.5m CanvasTexture panels ----
  const billboardPostGeo = new THREE.CylinderGeometry(0.18, 0.22, BILLBOARD_POST_HEIGHT, 8);
  const billboardPanelGeo = new THREE.PlaneGeometry(BILLBOARD_W, BILLBOARD_H);
  const billboardPostMat = new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 0.7 });
  disposables.push({ geometry: billboardPostGeo }, { geometry: billboardPanelGeo }, { material: billboardPostMat });

  for (const spec of BILLBOARD_SPECS) {
    const { pos, side: sideVec } = trackFrame(curve, spec.u);
    const base = pos.clone().addScaledVector(sideVec, spec.side * (ROAD_WIDTH / 2 + 3.5));
    base.y = 0;
    const facing = sideVec.clone().multiplyScalar(-spec.side);
    const yaw = Math.atan2(facing.x, facing.z);

    for (const dx of [-BILLBOARD_W / 2 + 0.5, BILLBOARD_W / 2 - 0.5]) {
      const post = new THREE.Mesh(billboardPostGeo, billboardPostMat);
      const localOffset = new THREE.Vector3(dx, 0, 0).applyAxisAngle(UP, yaw);
      post.position.copy(base).add(localOffset).setY(BILLBOARD_POST_HEIGHT / 2);
      group.add(post);
    }

    const texture = buildBillboardTexture(spec.text, spec.bg, spec.fg);
    disposables.push({ texture });
    const panelMat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.6 });
    disposables.push({ material: panelMat });
    const panel = new THREE.Mesh(billboardPanelGeo, panelMat);
    panel.position.copy(base).setY(BILLBOARD_POST_HEIGHT - BILLBOARD_H / 2 + 0.3);
    panel.rotation.y = yaw;
    group.add(panel);
  }

  // ---- brake marker boards approaching the hairpin (right/outside side, 100/50/25m out) ----
  const markerPostGeo = new THREE.CylinderGeometry(0.06, 0.08, 2.2, 6);
  const markerPanelGeo = new THREE.PlaneGeometry(1.1, 1.1);
  const markerPostMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.8 });
  disposables.push({ geometry: markerPostGeo }, { geometry: markerPanelGeo }, { material: markerPostMat });

  for (const dist of BRAKE_MARKER_DISTANCES_M) {
    const u = metersToU(curve, HAIRPIN_APEX_U, dist);
    const { pos, side: sideVec } = trackFrame(curve, u);
    const p = pos.clone().addScaledVector(sideVec, ROAD_WIDTH / 2 + 1.5);
    p.y = 0;
    const post = new THREE.Mesh(markerPostGeo, markerPostMat);
    post.position.copy(p).setY(1.1);
    group.add(post);

    const texture = buildBrakeMarkerTexture(dist);
    disposables.push({ texture });
    const panelMat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.5, side: THREE.DoubleSide });
    disposables.push({ material: panelMat });
    const panel = new THREE.Mesh(markerPanelGeo, panelMat);
    panel.position.copy(p).setY(2.0);
    const facing = sideVec.clone().multiplyScalar(-1);
    panel.rotation.y = Math.atan2(facing.x, facing.z);
    group.add(panel);
  }

  // ---- pit building: 12x4x6m with garage insets + awning, opposite the grid stands ----
  const pitBodyGeo = new THREE.BoxGeometry(PIT_WIDTH, PIT_HEIGHT, PIT_DEPTH);
  const pitBodyMat = new THREE.MeshStandardMaterial({ color: 0xd4d6da, roughness: 0.8 });
  const garageGeo = new THREE.BoxGeometry(PIT_WIDTH / 4 - 0.3, PIT_HEIGHT * 0.65, 0.3);
  const garageMat = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.6 });
  const awningGeo = new THREE.BoxGeometry(PIT_WIDTH + 1, 0.3, 2);
  const awningMat = new THREE.MeshStandardMaterial({ color: 0xc8342a, roughness: 0.6 });
  disposables.push({ geometry: pitBodyGeo }, { geometry: garageGeo }, { geometry: awningGeo });
  disposables.push({ material: pitBodyMat }, { material: garageMat }, { material: awningMat });

  {
    const { pos, side: sideVec } = trackFrame(curve, PIT_U);
    // opposite side from the grid-area stand (grid stands sit at +side per spectators.ts specs
    // near u≈0.98/0.045) — place the pit building on the -side.
    const base = pos.clone().addScaledVector(sideVec, -(ROAD_WIDTH / 2 + PIT_DEPTH / 2 + 5));
    base.y = 0;
    const facing = sideVec.clone(); // face back toward the road (+side direction)
    const yaw = Math.atan2(facing.x, facing.z);

    const body = new THREE.Mesh(pitBodyGeo, pitBodyMat);
    body.position.copy(base).setY(PIT_HEIGHT / 2);
    body.rotation.y = yaw;
    group.add(body);

    for (let i = 0; i < 4; i++) {
      const dx = (i - 1.5) * (PIT_WIDTH / 4);
      const garage = new THREE.Mesh(garageGeo, garageMat);
      const localOffset = new THREE.Vector3(dx, 0, PIT_DEPTH / 2 + 0.01).applyAxisAngle(UP, yaw);
      garage.position.copy(base).add(localOffset).setY(PIT_HEIGHT * 0.65 * 0.5 + 0.2);
      garage.rotation.y = yaw;
      group.add(garage);
    }

    const awning = new THREE.Mesh(awningGeo, awningMat);
    const awningOffset = new THREE.Vector3(0, 0, PIT_DEPTH / 2 + 1).applyAxisAngle(UP, yaw);
    awning.position.copy(base).add(awningOffset).setY(PIT_HEIGHT - 0.2);
    awning.rotation.y = yaw;
    group.add(awning);
  }

  // ---- 6 light poles with emissive heads, spread around the circuit ----
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.16, LIGHT_POLE_HEIGHT, 8);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x5a5d62, roughness: 0.7 });
  const headGeo = new THREE.SphereGeometry(0.35, 10, 8);
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xfff6d8,
    emissive: 0xfff6d8,
    emissiveIntensity: 1.2,
    roughness: 0.4,
  });
  disposables.push({ geometry: poleGeo }, { geometry: headGeo }, { material: poleMat }, { material: headMat });

  const lightPoles = new THREE.InstancedMesh(poleGeo, poleMat, LIGHT_POLE_COUNT);
  const lightHeads = new THREE.InstancedMesh(headGeo, headMat, LIGHT_POLE_COUNT);
  for (let i = 0; i < LIGHT_POLE_COUNT; i++) {
    const u = (i / LIGHT_POLE_COUNT + 0.5 / LIGHT_POLE_COUNT) % 1;
    const sideSign: 1 | -1 = i % 2 === 0 ? 1 : -1;
    const { pos, side: sideVec } = trackFrame(curve, u);
    const p = pos.clone().addScaledVector(sideVec, sideSign * (ROAD_WIDTH / 2 + 2.2));
    p.y = 0;
    m4.compose(p.clone().setY(LIGHT_POLE_HEIGHT / 2), q4, s4);
    lightPoles.setMatrixAt(i, m4);
    m4.compose(p.clone().setY(LIGHT_POLE_HEIGHT), q4, s4);
    lightHeads.setMatrixAt(i, m4);
  }
  lightPoles.instanceMatrix.needsUpdate = true;
  lightHeads.instanceMatrix.needsUpdate = true;
  group.add(lightPoles, lightHeads);

  function dispose(): void {
    for (const d of disposables) {
      d.geometry?.dispose();
      d.texture?.dispose();
      if (d.material) {
        if (Array.isArray(d.material)) d.material.forEach((m) => m.dispose());
        else d.material.dispose();
      }
    }
    blackTires.dispose();
    accentTires.dispose();
    whiteAccentTires.dispose();
    lightPoles.dispose();
    lightHeads.dispose();
  }

  return { group, dispose };
}
