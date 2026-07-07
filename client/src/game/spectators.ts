import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
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
const ROOF_HEADROOM = 1.6;
const ROOF_Y = TIER_COUNT * TIER_HEIGHT + ROOF_HEADROOM; // 5.8

// Denser crowd: 2 rows per tier x ~13 per row x 3 tiers = ~78 seats per stand, split across the 3
// model variants (still 3 InstancedMeshes/stand -- perf unaffected, matrices updated every other
// frame). CROWD_PER_STAND is the actual total seat count (matches totalSeats in the build loop);
// keep the two in sync if either factor changes.
const CROWD_ROWS_PER_TIER = 2;
const CROWD_PER_ROW = 28;
const CROWD_PER_STAND = CROWD_ROWS_PER_TIER * CROWD_PER_ROW * TIER_COUNT; // = 168
const CROWD_VARIANTS = 3;
const CROWD_PER_VARIANT = Math.floor(CROWD_PER_STAND / CROWD_VARIANTS);
// Seated crowd is normalized to this standing-equivalent height once seated on a tier.
const CROWD_SEAT_HEIGHT = 0.9;
// Instances rendered ~1.25x larger than a literal seated-height model so they read clearly at
// typical camera distance instead of vanishing into sparse pastel dots.
const CROWD_SCALE_BOOST = 1.25;

// ---- crowd texture cards: the realism multiplier -- a painted "sea of people" backdrop behind
// the 3D rows, filling the upper tiers with hundreds of apparent spectators at ~zero draw cost
// (two swapped/crossfaded planes per stand, alpha-tested edges). ----
const CROWD_CARD_TEX_W = 1024;
const CROWD_CARD_TEX_H = 256;
const CROWD_CARD_ROWS = 4;
const CROWD_CARD_COLS = 40;
const CROWD_CARD_SKIN_TONES = ['#ffddb0', '#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#5a3825'];
const CROWD_CARD_CLOTHING_COLORS = [
  '#d8342a', '#2a5cd8', '#2ea84a', '#e0862a', '#9c3fd8', '#d8ac2a', '#2ac7c2', '#d85f8f',
  '#4a4e57', '#c9c9c9', '#7a2ee6', '#1f8a5f',
];
const CROWD_CARD_CROSSFADE_HZ = 1.4;
const CROWD_CARD_WIDTH = STAND_WIDTH * 0.98;
// Sized to fit the headroom between the top tier and the roof (ROOF_Y - top tier height), verified
// against ROOF_Y/TIER_COUNT/TIER_HEIGHT below at the card's build site so it never clips the roof.
const CROWD_CARD_HEIGHT = 1.3;

// Motion behavior groups assigned per-instance at build time.
const enum Behavior {
  Sway = 0,
  Idle = 1,
  Cheer = 2,
}
const BEHAVIOR_WEIGHTS: [Behavior, number][] = [
  [Behavior.Sway, 0.45],
  [Behavior.Idle, 0.35],
  [Behavior.Cheer, 0.2],
];
const SWAY_ROTZ_AMP = 0.04;
const SWAY_FREQ = 0.5; // Hz
const IDLE_ROTY_AMP = 0.15;
const IDLE_FREQ = 0.2; // Hz
const IDLE_BOB_AMP = 0.02;
const CHEER_BOB_AMP = 0.08;
const CHEER_FREQ = 2; // Hz
const CHEER_ROTX_AMP = -0.06;

const CROWD_ENERGY_RADIUS = 45; // m — cars within this distance ramp a stand's cheer energy toward 2
const CROWD_ENERGY_LERP_RATE = 4; // 1/s — how fast a stand's energy ramps toward its target

// ---- fallback procedural seated-person geometry (used only if models fail to load) ----
const CROWD_BODY_RADIUS = 0.22;
const CROWD_BODY_HEIGHT = 0.55;
const CROWD_HEAD_RADIUS = 0.13;
const FALLBACK_PERSON_HEIGHT = CROWD_BODY_HEIGHT + CROWD_HEAD_RADIUS * 0.9 + CROWD_HEAD_RADIUS;

// ---- seating clearance proof (computed once at module load, thrown if violated) ----
{
  const topTierSeatY = TIER_HEIGHT * TIER_COUNT; // seat surface for tier index TIER_COUNT-1
  const tallest = Math.max(CROWD_SEAT_HEIGHT, FALLBACK_PERSON_HEIGHT);
  const headTopAtBobPeak = topTierSeatY + tallest + CHEER_BOB_AMP;
  const clearance = ROOF_Y - headTopAtBobPeak;
  // eslint-disable-next-line no-console
  console.info(
    `[spectators] seating clearance: personHeight=${tallest.toFixed(3)} topTierSeatY=${topTierSeatY.toFixed(2)} ` +
      `headTopAtBobPeak=${headTopAtBobPeak.toFixed(3)} roofY=${ROOF_Y.toFixed(2)} clearance=${clearance.toFixed(3)}`,
  );
  if (clearance <= 0) {
    throw new Error(`[spectators] seated crowd clips the roof: clearance=${clearance.toFixed(3)} <= 0`);
  }
}

// ---- crowd-card clearance proof (computed once at module load, thrown if violated) ----
{
  const cardCenterY = TIER_COUNT * TIER_HEIGHT + CROWD_CARD_HEIGHT * 0.5 + 0.05;
  const cardTopY = cardCenterY + CROWD_CARD_HEIGHT / 2;
  const cardClearance = ROOF_Y - cardTopY;
  // eslint-disable-next-line no-console
  console.info(
    `[spectators] crowd-card clearance: cardTopY=${cardTopY.toFixed(3)} roofY=${ROOF_Y.toFixed(2)} clearance=${cardClearance.toFixed(3)}`,
  );
  if (cardClearance <= 0) {
    throw new Error(`[spectators] crowd card clips the roof: clearance=${cardClearance.toFixed(3)} <= 0`);
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
  angle: number[]; // per-instance yaw offset (matches stand facing) so sway/idle rotate correctly
  behavior: Behavior[];
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
 * Paints a "sea of people" crowd card: CROWD_CARD_ROWS x CROWD_CARD_COLS simplified spectator
 * figures (head + shoulders blob, varied skin tone / clothing color, a vertical gradient shading
 * darker toward the bottom of each figure for cheap fake AO, slight per-row jitter so rows don't
 * look perfectly ruled). `poseSeed` offsets each figure's arm/head pose slightly so a second card
 * generated with a different seed can be crossfaded against this one for a subtle "crowd shifting"
 * animation. Returns a CanvasTexture sized CROWD_CARD_TEX_W x CROWD_CARD_TEX_H with a transparent
 * background (alpha-tested in the material) above/around the painted figures.
 */
function buildCrowdCardTexture(poseSeed: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CROWD_CARD_TEX_W;
  canvas.height = CROWD_CARD_TEX_H;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const cellW = canvas.width / CROWD_CARD_COLS;
  const cellH = canvas.height / CROWD_CARD_ROWS;
  // Deterministic-ish PRNG seeded by poseSeed + cell index so frameA/frameB share the same crowd
  // "identity" per seat but with a slightly different pose (arms up/down/waving), not a totally
  // different random crowd -- that reads as a coherent crowd shifting, not noise.
  let seed = poseSeed * 7919 + 13;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 10000) / 10000;
  };

  for (let row = 0; row < CROWD_CARD_ROWS; row++) {
    // back rows (higher on the card = further away) are drawn smaller/higher for cheap depth
    const rowY = row * cellH + cellH * 0.5;
    const rowScale = 0.75 + (row / (CROWD_CARD_ROWS - 1)) * 0.35;
    for (let col = 0; col < CROWD_CARD_COLS; col++) {
      const jitterX = (rand() - 0.5) * cellW * 0.3;
      const jitterY = (rand() - 0.5) * cellH * 0.15;
      const cx = col * cellW + cellW * 0.5 + jitterX;
      const cy = rowY + jitterY;
      const figH = cellH * rowScale * 0.92;
      const figW = figH * 0.55;
      const skin = CROWD_CARD_SKIN_TONES[Math.floor(rand() * CROWD_CARD_SKIN_TONES.length)];
      const clothing = CROWD_CARD_CLOTHING_COLORS[Math.floor(rand() * CROWD_CARD_CLOTHING_COLORS.length)];
      const poseRoll = rand(); // arms-down / arms-up / waving, biased by poseSeed via rand() stream

      // torso/shoulders: vertical gradient, darker at the bottom (cheap fake AO/contact shadow)
      const torsoTop = cy - figH * 0.15;
      const torsoBottom = cy + figH * 0.5;
      const grad = ctx.createLinearGradient(0, torsoTop, 0, torsoBottom);
      grad.addColorStop(0, clothing);
      grad.addColorStop(1, shadeColor(clothing, -0.35));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(cx, (torsoTop + torsoBottom) / 2, figW * 0.5, (torsoBottom - torsoTop) / 2, 0, 0, Math.PI * 2);
      ctx.fill();

      // arms: simple offset blobs, position varies by poseRoll for arms up/down/waving variety
      ctx.fillStyle = shadeColor(clothing, -0.15);
      const armY = poseRoll > 0.66 ? torsoTop - figH * 0.08 : torsoTop + figH * 0.05; // raised vs at-side
      const armSpread = figW * (poseRoll > 0.33 ? 0.62 : 0.5);
      for (const armSign of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(cx + armSign * armSpread, armY, figW * 0.16, figH * 0.22, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // head
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.arc(cx, cy - figH * 0.42, figW * 0.28, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/** Darkens (negative amt) or lightens (positive amt) a '#rrggbb' hex color by `amt` (-1..1). */
function shadeColor(hex: string, amt: number): string {
  const num = parseInt(hex.slice(1), 16);
  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;
  const f = amt < 0 ? 1 + amt : 1 - amt;
  const base = amt < 0 ? 0 : 255;
  r = Math.round(r * f + base * (amt < 0 ? 0 : amt));
  g = Math.round(g * f + base * (amt < 0 ? 0 : amt));
  b = Math.round(b * f + base * (amt < 0 ? 0 : amt));
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  return `#${clamp(r).toString(16).padStart(2, '0')}${clamp(g).toString(16).padStart(2, '0')}${clamp(b).toString(16).padStart(2, '0')}`;
}

function pickBehavior(): Behavior {
  const r = Math.random();
  let acc = 0;
  for (const [b, w] of BEHAVIOR_WEIGHTS) {
    acc += w;
    if (r < acc) return b;
  }
  return Behavior.Sway;
}

// The Kenney "Blocky Characters" arm nodes (arm-left/arm-right) are authored as a box that is as
// WIDE (local X, the outward-from-shoulder axis) as it is long, flush against the torso for the
// model's full height -- at small/distant render scale that reads as a flat horizontal bar level
// with the torso, i.e. a "plus sign" silhouette instead of a person. Verified against the raw glTF
// node data: arm box local bbox is x:[0,0.4] (width, pivoting at the shoulder/node-origin) y:[-1,0.1]
// (already-vertical hang length) z:[-0.2,0.2] (depth). Narrowing the box's local X down to
// ARM_WIDTH_SCALE of its original girth (pivoting at the node's own origin -- the shoulder joint --
// so it can't rotate into/clip the torso) collapses the full-figure bbox width/height ratio from
// ~0.84 to ~0.55, killing the plus-sign read while keeping the arm hanging in the same place.
const ARM_WIDTH_SCALE = 0.3;
const ARM_DEPTH_SCALE = 0.6; // also slim the arm's front-back depth a bit for a less blocky limb

/**
 * Loads a Kenney "Blocky Characters" GLB (unskinned — separate rigid mesh nodes for
 * legs/torso/arms/head parented under a `root` node) and bakes every node's world transform
 * into one merged BufferGeometry, normalized so the figure stands with feet at y=0 and total
 * height 1 (caller rescales/positions as needed). Strips skinIndex/skinWeight attributes
 * defensively (these particular models have none, but merge would otherwise choke on mismatched
 * attribute sets if a differently-authored variant ever slipped in).
 *
 * Before baking, narrows arm-left/arm-right nodes (see ARM_WIDTH_SCALE) so the merged silhouette
 * reads as a person with arms at their sides instead of a flat cross/plus shape.
 */
async function loadBlockyCharacter(loader: GLTFLoader, url: string): Promise<THREE.BufferGeometry> {
  const gltf = await loader.loadAsync(url);
  const scene = gltf.scene;
  scene.traverse((obj) => {
    if (obj.name === 'arm-left' || obj.name === 'arm-right') {
      // Scale about the node's own local origin (the shoulder pivot) BEFORE updateWorldMatrix bakes
      // world transforms below -- narrows the box without moving the shoulder attachment point or
      // risking any rotation-based clipping into the torso.
      obj.scale.set(ARM_WIDTH_SCALE, 1, ARM_DEPTH_SCALE);
    }
  });
  scene.updateWorldMatrix(true, true);
  const parts: THREE.BufferGeometry[] = [];
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      const geo = obj.geometry.clone();
      if (geo.hasAttribute('skinIndex')) geo.deleteAttribute('skinIndex');
      if (geo.hasAttribute('skinWeight')) geo.deleteAttribute('skinWeight');
      if (geo.hasAttribute('tangent')) geo.deleteAttribute('tangent');
      if (geo.hasAttribute('uv')) geo.deleteAttribute('uv');
      geo.applyMatrix4(obj.matrixWorld);
      parts.push(geo);
    }
  });
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error(`[spectators] failed to merge geometry for ${url}`);
  merged.computeBoundingBox();
  const box = merged.boundingBox!;
  const height = Math.max(box.max.y - box.min.y, 0.001);
  const width = Math.max(box.max.x - box.min.x, 0.001);
  // eslint-disable-next-line no-console
  console.info(`[spectators] ${url} bbox aspect (width/height) after arm-down bake: ${(width / height).toFixed(3)}`);
  // normalize: feet at y=0, uniform scale so total height == 1
  merged.translate(0, -box.min.y, 0);
  merged.scale(1 / height, 1 / height, 1 / height);
  merged.computeVertexNormals();
  return merged;
}

/**
 * Builds 8 grandstands with lifelike crowd variants (Kenney "Blocky Characters" models, merged
 * into one InstancedMesh per variant per stand) and per-instance idle/sway/cheer motion, plus
 * track-side TV camera props (each with a standing camera-operator figure joined to the same yaw
 * group) and a start-grid flag/marshal area near the line. Structure is merged into a handful of
 * meshes. No per-frame allocations in update(). Falls back to simple procedural seated-capsule
 * figures if the crowd models fail to load, so the game never breaks on a bad/missing GLB.
 */
export async function buildSpectators(curve: THREE.CatmullRomCurve3): Promise<Spectators> {
  const group = new THREE.Group();
  const stands: THREE.Vector3[] = [];
  const disposables: { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] }[] = [];

  // ---- load the 3 crowd variants + crew (camera-operator) model, normalized to unit height ----
  const loader = new GLTFLoader();
  let crowdGeos: THREE.BufferGeometry[] = [];
  let crewGeo: THREE.BufferGeometry | null = null;
  try {
    const [a, b, c, crew] = await Promise.all([
      loadBlockyCharacter(loader, '/models/crowd/crowd-a.glb'),
      loadBlockyCharacter(loader, '/models/crowd/crowd-b.glb'),
      loadBlockyCharacter(loader, '/models/crowd/crowd-c.glb'),
      loadBlockyCharacter(loader, '/models/crowd/crowd-crew.glb'),
    ]);
    crowdGeos = [a, b, c];
    crewGeo = crew;
  } catch (err) {
    console.warn('[spectators] crowd models failed to load — using fallback procedural figures', err);
    crowdGeos = [];
    crewGeo = null;
  }

  // ---- seated crowd geometry: unit-height model rescaled to CROWD_SEAT_HEIGHT (sunk slightly
  // into the tier so a standing-pose model reads as "seated" without needing a distinct pose) ----
  const usingModels = crowdGeos.length === CROWD_VARIANTS;
  let personGeos: THREE.BufferGeometry[];
  if (usingModels) {
    personGeos = crowdGeos.map((g) => {
      const geo = g.clone();
      geo.scale(CROWD_SEAT_HEIGHT, CROWD_SEAT_HEIGHT, CROWD_SEAT_HEIGHT);
      return geo;
    });
  } else {
    const bodyGeo = new THREE.CylinderGeometry(CROWD_BODY_RADIUS, CROWD_BODY_RADIUS * 1.1, CROWD_BODY_HEIGHT, 6);
    bodyGeo.translate(0, CROWD_BODY_HEIGHT / 2, 0);
    const headGeo = new THREE.SphereGeometry(CROWD_HEAD_RADIUS, 7, 6);
    headGeo.translate(0, CROWD_BODY_HEIGHT + CROWD_HEAD_RADIUS * 0.9, 0);
    const merged = mergeGeometries([bodyGeo, headGeo], false);
    bodyGeo.dispose();
    headGeo.dispose();
    personGeos = [merged ?? new THREE.BoxGeometry(0.3, FALLBACK_PERSON_HEIGHT, 0.3)];
  }
  for (const g of personGeos) disposables.push({ geometry: g });

  // ---- standing figure (for marshal props near the grid) ----
  let standingPersonGeo: THREE.BufferGeometry;
  if (usingModels) {
    standingPersonGeo = crowdGeos[0].clone();
  } else {
    const standBodyGeo = new THREE.CylinderGeometry(CROWD_BODY_RADIUS, CROWD_BODY_RADIUS * 1.1, 0.9, 6);
    standBodyGeo.translate(0, 0.45, 0);
    const standHeadGeo = new THREE.SphereGeometry(CROWD_HEAD_RADIUS, 7, 6);
    standHeadGeo.translate(0, 0.9 + CROWD_HEAD_RADIUS * 0.9, 0);
    const merged = mergeGeometries([standBodyGeo, standHeadGeo], false);
    standBodyGeo.dispose();
    standHeadGeo.dispose();
    standingPersonGeo = merged ?? new THREE.BoxGeometry(0.3, 1.2, 0.3);
  }
  disposables.push({ geometry: standingPersonGeo });
  const standingScale = usingModels ? 1.75 : 1.2; // models are unit-height -> real ~1.75m standing figure

  // ---- camera-operator figure (crew model, or a dark-uniform procedural fallback) ----
  let operatorGeo: THREE.BufferGeometry;
  if (crewGeo) {
    operatorGeo = crewGeo.clone();
  } else {
    const opBodyGeo = new THREE.CylinderGeometry(0.24, 0.28, 1.1, 6);
    opBodyGeo.translate(0, 0.55, 0);
    const opHeadGeo = new THREE.SphereGeometry(0.15, 7, 6);
    opHeadGeo.translate(0, 1.1 + 0.15 * 0.9, 0);
    const merged = mergeGeometries([opBodyGeo, opHeadGeo], false);
    opBodyGeo.dispose();
    opHeadGeo.dispose();
    operatorGeo = merged ?? new THREE.BoxGeometry(0.4, 1.4, 0.4);
  }
  disposables.push({ geometry: operatorGeo });
  const operatorMat = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.85 });
  disposables.push({ material: operatorMat });
  const operatorScale = crewGeo ? 1.75 : 1;

  // ---- shared structure geometry (built once, instanced via merged meshes per stand) ----
  const tierBoxGeo = new THREE.BoxGeometry(STAND_WIDTH, TIER_HEIGHT, STAND_DEPTH);
  const postGeo = new THREE.CylinderGeometry(0.15, 0.15, TIER_COUNT * TIER_HEIGHT + 1.2, 6);
  const roofGeo = new THREE.BoxGeometry(STAND_WIDTH + 1, 0.25, STAND_DEPTH * TIER_COUNT + 1.5);
  const panelGeo = new THREE.BoxGeometry(0.3, TIER_COUNT * TIER_HEIGHT, STAND_DEPTH * TIER_COUNT);
  const structureMat = new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.85 });
  const postMat = new THREE.MeshStandardMaterial({ color: 0x555a60, roughness: 0.7 });
  disposables.push({ geometry: tierBoxGeo }, { geometry: postGeo }, { geometry: roofGeo }, { geometry: panelGeo });
  disposables.push({ material: structureMat }, { material: postMat });

  // ---- seat-row color strips (thin colored boxes on each tier's tread) + safety railings (bars +
  // posts) + crowd texture-card geometry (shared across all 8 stands, only materials differ) ----
  const seatStripGeo = new THREE.BoxGeometry(STAND_WIDTH - 0.6, 0.06, 0.5);
  const railBarGeo = new THREE.BoxGeometry(STAND_WIDTH - 0.4, 0.06, 0.06);
  const railPostGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.55, 5);
  const railMat = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.6, metalness: 0.2 });
  disposables.push({ geometry: seatStripGeo }, { geometry: railBarGeo }, { geometry: railPostGeo });
  disposables.push({ material: railMat });
  const SEAT_STRIP_COLORS = [0x1c3fa8, 0xa81c2e, 0x1c8a3f, 0xd8ac2a];

  // crowd card plane: an inclined billboard behind the 3D rows (upper tier), painted with hundreds
  // of simplified figures. Two textures (frameA/frameB) crossfaded via opacity for a cheap "crowd
  // shifting" animation, rate/mix scaled by stand energy in update().
  const crowdCardGeo = new THREE.PlaneGeometry(CROWD_CARD_WIDTH, CROWD_CARD_HEIGHT);
  disposables.push({ geometry: crowdCardGeo });

  const instancedMeshes: THREE.InstancedMesh[] = []; // one per (stand, variant)
  const instancedData: StandInstanceData[] = [];
  const standEnergy: number[] = []; // per-stand smoothed cheer energy (ramps toward 1 = normal, 2 = cheering)
  const standOfMesh: number[] = []; // parallel to instancedMeshes/instancedData: which stand index owns it

  interface CrowdCardRig {
    mesh: THREE.Mesh;
    material: THREE.MeshBasicMaterial;
    frameA: THREE.CanvasTexture;
    frameB: THREE.CanvasTexture;
    standIdx: number;
    phase: number;
  }
  const crowdCards: CrowdCardRig[] = [];

  // ---- camera prop geometry (shared) — body + lens + emissive-blue monitor + strap hint ----
  const legGeo = new THREE.CylinderGeometry(0.03, 0.03, 1.1, 5);
  const camBodyGeo = new THREE.BoxGeometry(0.35, 0.28, 0.5);
  const lensGeo = new THREE.CylinderGeometry(0.09, 0.11, 0.35, 10);
  const monitorGeo = new THREE.PlaneGeometry(0.16, 0.11);
  const strapGeo = new THREE.BoxGeometry(0.03, 0.03, 0.6);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a });
  const camMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.4, metalness: 0.3 });
  const monitorMat = new THREE.MeshStandardMaterial({
    color: 0x0a1420,
    emissive: 0x2299ff,
    emissiveIntensity: 1.4,
    roughness: 0.3,
  });
  const strapMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
  disposables.push({ geometry: legGeo }, { geometry: camBodyGeo }, { geometry: lensGeo });
  disposables.push({ geometry: monitorGeo }, { geometry: strapGeo });
  disposables.push({ material: legMat }, { material: camMat }, { material: monitorMat }, { material: strapMat });

  interface CameraRig {
    head: THREE.Group; // yaw-rotated subgroup (box + lens + operator), pans with the camera
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
    const monitor = new THREE.Mesh(monitorGeo, monitorMat);
    monitor.position.set(0.24, 0.02, 0.05);
    monitor.rotation.y = -Math.PI / 2.4;
    head.add(monitor);
    const strap = new THREE.Mesh(strapGeo, strapMat);
    strap.position.set(0, 0.05, 0.15);
    strap.rotation.x = Math.PI / 5;
    head.add(strap);
    // operator stands just behind the camera, joined to the same yaw group so operator + camera pan together
    const operator = new THREE.Mesh(operatorGeo, operatorMat);
    operator.scale.setScalar(operatorScale);
    operator.position.set(0, -1.15, 0.55); // feet at ground relative to head's y=1.15 offset
    head.add(operator);
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
    const teamColor = STAND_AWNING_COLORS[s % STAND_AWNING_COLORS.length];
    const awningMat = new THREE.MeshStandardMaterial({ color: teamColor, roughness: 0.6 });
    disposables.push({ material: awningMat });
    const roof = new THREE.Mesh(roofGeo, awningMat);
    roof.position.set(0, ROOF_Y, -(STAND_DEPTH * (TIER_COUNT - 1)) / 2);
    standRoot.add(roof);

    // 2 side panels, subtly tinted with this stand's team/awning color instead of flat structure gray
    const panelMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(teamColor).lerp(new THREE.Color(0x8a8f96), 0.55),
      roughness: 0.85,
    });
    disposables.push({ material: panelMat });
    for (const px of [-STAND_WIDTH / 2 - 0.1, STAND_WIDTH / 2 + 0.1]) {
      const panel = new THREE.Mesh(panelGeo, panelMat);
      panel.position.set(px, (TIER_COUNT * TIER_HEIGHT) / 2, -(STAND_DEPTH * (TIER_COUNT - 1)) / 2);
      standRoot.add(panel);
    }

    // alternating seat-row color strips on each tier's tread (thin colored boxes, cheap "painted
    // seats" dressing) + a safety railing (bar + 2 end posts) along each tier's leading edge
    for (let t = 0; t < TIER_COUNT; t++) {
      const stripMat = new THREE.MeshStandardMaterial({
        color: SEAT_STRIP_COLORS[(s + t) % SEAT_STRIP_COLORS.length],
        roughness: 0.7,
      });
      disposables.push({ material: stripMat });
      const strip = new THREE.Mesh(seatStripGeo, stripMat);
      strip.position.set(0, TIER_HEIGHT * t + TIER_HEIGHT + 0.03, -(t * STAND_DEPTH) - STAND_DEPTH * 0.35);
      standRoot.add(strip);

      const railBar = new THREE.Mesh(railBarGeo, railMat);
      railBar.position.set(0, TIER_HEIGHT * (t + 1) + 0.5, -(t * STAND_DEPTH) - STAND_DEPTH + 0.1);
      standRoot.add(railBar);
      for (const px of [-STAND_WIDTH / 2 + 0.3, STAND_WIDTH / 2 - 0.3]) {
        const post = new THREE.Mesh(railPostGeo, railMat);
        post.position.set(px, TIER_HEIGHT * (t + 1) + 0.27, -(t * STAND_DEPTH) - STAND_DEPTH + 0.1);
        standRoot.add(post);
      }
    }

    // crowd texture card: inclined billboard behind the 3D crowd rows (upper tier / roofline area),
    // painted with hundreds of simplified figures -- the realism multiplier at ~zero draw cost.
    {
      const frameA = buildCrowdCardTexture(s * 2);
      const frameB = buildCrowdCardTexture(s * 2 + 1);
      const cardMat = new THREE.MeshBasicMaterial({
        map: frameA,
        transparent: true,
        alphaTest: 0.1,
        side: THREE.DoubleSide,
      });
      disposables.push({ material: cardMat });
      const card = new THREE.Mesh(crowdCardGeo, cardMat);
      // sits in the headroom strip between the top tier and the roof -- verified to clear ROOF_Y
      // by the seating-clearance-style check just below the stand-build loop.
      card.position.set(0, TIER_COUNT * TIER_HEIGHT + CROWD_CARD_HEIGHT * 0.5 + 0.05, -(STAND_DEPTH * (TIER_COUNT - 1)) - 0.4);
      card.rotation.x = -0.12; // slight backward incline so it reads as receding upper tiers
      standRoot.add(card);
      crowdCards.push({ mesh: card, material: cardMat, frameA, frameB, standIdx: s, phase: Math.random() * Math.PI * 2 });
    }

    // ---- crowd, seated across the 3 tiers x 2 rows per tier — one InstancedMesh per variant ----
    standEnergy.push(1);
    const color = new THREE.Color();
    const tmpMat = new THREE.Matrix4();
    const tmpQuat = new THREE.Quaternion();
    const tmpScale = new THREE.Vector3(CROWD_SCALE_BOOST, CROWD_SCALE_BOOST, CROWD_SCALE_BOOST);
    // Precompute a flat list of (tier, row, acrossSlot) seat slots shared across all 3 variants so
    // the whole stand fills densely and evenly instead of each variant re-randomizing independently.
    const totalSeats = TIER_COUNT * CROWD_ROWS_PER_TIER * CROWD_PER_ROW;
    const seatSlots: { tier: number; row: number; slot: number }[] = [];
    for (let tier = 0; tier < TIER_COUNT; tier++) {
      for (let row = 0; row < CROWD_ROWS_PER_TIER; row++) {
        for (let slot = 0; slot < CROWD_PER_ROW; slot++) seatSlots.push({ tier, row, slot });
      }
    }
    // shuffle so consecutive instances (which get split across the 3 variant meshes) don't all land
    // in the same tier/row, keeping each variant's model visually mixed across the whole stand
    for (let i = seatSlots.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [seatSlots[i], seatSlots[j]] = [seatSlots[j], seatSlots[i]];
    }
    let globalIdx = 0;
    for (let v = 0; v < personGeos.length; v++) {
      const count = v < personGeos.length - 1 ? CROWD_PER_VARIANT : totalSeats - CROWD_PER_VARIANT * (personGeos.length - 1);
      const crowdMat = new THREE.MeshStandardMaterial({ roughness: 0.9, vertexColors: false });
      disposables.push({ material: crowdMat });
      const instanced = new THREE.InstancedMesh(personGeos[v], crowdMat, count);
      instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const base: THREE.Vector3[] = [];
      const phase: number[] = [];
      const angle: number[] = [];
      const behavior: Behavior[] = [];
      for (let i = 0; i < count; i++) {
        const { tier, row, slot } = seatSlots[globalIdx % seatSlots.length];
        // even spread across the tread width, with small per-seat jitter for a less robotic grid
        const acrossStep = (STAND_WIDTH - 1.2) / CROWD_PER_ROW;
        const acrossJitter = (Math.random() - 0.5) * acrossStep * 0.5;
        const bx = -(STAND_WIDTH - 1.2) / 2 + acrossStep * (slot + 0.5) + acrossJitter;
        // Person geometry's bottom is at local y=0. Seat it flush on this tier's TOP surface, minus a
        // small sink so a standing-pose model reads as seated (legs partially hidden behind the tier riser).
        const seatSink = usingModels ? 0.12 : 0;
        const by = TIER_HEIGHT * (tier + 1) - seatSink;
        // 2 rows per tier: front row nearer the riser edge, back row further into the tread depth.
        const rowStep = (STAND_DEPTH - 0.6) / CROWD_ROWS_PER_TIER;
        const depthJitter = (Math.random() - 0.5) * rowStep * 0.3;
        const bz = -(tier * STAND_DEPTH) - STAND_DEPTH * 0.15 - rowStep * (row + 0.5) + depthJitter;
        const b = new THREE.Vector3(bx, by, bz);
        base.push(b);
        phase.push(Math.random() * Math.PI * 2);
        const a = Math.PI + (Math.random() - 0.5) * 0.3; // face the road (root already faces road via +z front)
        angle.push(a);
        behavior.push(pickBehavior());
        tmpQuat.setFromAxisAngle(UP, a);
        tmpMat.compose(b, tmpQuat, tmpScale);
        instanced.setMatrixAt(i, tmpMat);
        color.setHSL(Math.random(), 0.55 + Math.random() * 0.3, 0.35 + Math.random() * 0.3);
        instanced.setColorAt(i, color);
        globalIdx++;
      }
      instanced.instanceMatrix.needsUpdate = true;
      if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
      standRoot.add(instanced);
      instancedMeshes.push(instanced);
      instancedData.push({ base, phase, angle, behavior });
      standOfMesh.push(s);
    }

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
    marshal.scale.setScalar(standingScale);
    // usingModels: geometry feet already at local y=0, so ground placement is y=0; procedural
    // fallback geometry is also centered on its own local origin at y=0 (body base), so both agree.
    marshal.position.copy(p).setY(0);
    const facing = sideVec.clone().multiplyScalar(-sideSign);
    marshal.rotation.y = Math.atan2(facing.x, facing.z);
    group.add(marshal);
  }

  // ---- update scratch (module/closure-level, no per-frame allocation) ----
  const scratchMat = new THREE.Matrix4();
  const scratchQuat = new THREE.Quaternion();
  const scratchPos = new THREE.Vector3();
  const scratchScale = new THREE.Vector3(CROWD_SCALE_BOOST, CROWD_SCALE_BOOST, CROWD_SCALE_BOOST);
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
      // ramp each stand's energy once per frame (several InstancedMeshes can share one stand)
      for (let s = 0; s < stands.length; s++) {
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
      }
      for (let mi = 0; mi < instancedMeshes.length; mi++) {
        const mesh = instancedMeshes[mi];
        const data = instancedData[mi];
        const ampMul = standEnergy[standOfMesh[mi]];
        for (let i = 0; i < data.base.length; i++) {
          const b = data.base[i];
          const phase = data.phase[i];
          const beh = data.behavior[i];
          let by = b.y;
          let rotY = data.angle[i];
          let rotX = 0;
          let rotZ = 0;
          if (beh === Behavior.Sway) {
            rotZ = Math.sin(tSec * SWAY_FREQ * Math.PI * 2 + phase) * SWAY_ROTZ_AMP;
          } else if (beh === Behavior.Idle) {
            rotY += Math.sin(tSec * IDLE_FREQ * Math.PI * 2 + phase) * IDLE_ROTY_AMP;
            by += Math.abs(Math.sin(tSec * IDLE_FREQ * Math.PI * 2 * 2 + phase)) * IDLE_BOB_AMP;
          } else {
            // cheer: amplitude scaled by stand energy — barely moves at energy<=1, full at energy=2
            const cheerScale = Math.max(0, ampMul - 1);
            by += Math.abs(Math.sin(tSec * CHEER_FREQ * Math.PI * 2 + phase)) * CHEER_BOB_AMP * cheerScale;
            rotX = CHEER_ROTX_AMP * cheerScale;
          }
          scratchPos.set(b.x, by, b.z);
          EULER_SCRATCH.set(rotX, rotY, rotZ);
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

    // crowd cards: crossfade frameA<->frameB at ~CROWD_CARD_CROSSFADE_HZ, rate/mix scaled by this
    // stand's energy ramp (calm shimmer idle, faster/more pronounced when cars are nearby/cheering).
    for (const card of crowdCards) {
      const energy = standEnergy[card.standIdx]; // 1 = idle, 2 = cheering
      const rate = CROWD_CARD_CROSSFADE_HZ * (0.5 + 0.5 * (energy - 1) * 2); // ~0.7Hz idle -> ~1.4Hz+ cheering
      const mix = 0.5 + 0.5 * Math.sin(tSec * rate * Math.PI * 2 + card.phase);
      const useB = mix > 0.5;
      const nextMap = useB ? card.frameB : card.frameA;
      if (card.material.map !== nextMap) {
        card.material.map = nextMap;
        card.material.needsUpdate = true;
      }
    }

    // TV cameras (+ joined operator): yaw-lerp toward nearest car
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
    for (const card of crowdCards) {
      card.frameA.dispose();
      card.frameB.dispose();
    }
    for (const d of disposables) {
      d.geometry?.dispose();
      if (d.material) {
        if (Array.isArray(d.material)) d.material.forEach((m) => m.dispose());
        else d.material.dispose();
      }
    }
    for (const g of crowdGeos) g.dispose();
    if (crewGeo) crewGeo.dispose();
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
