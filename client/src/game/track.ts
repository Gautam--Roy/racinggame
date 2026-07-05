import * as THREE from 'three';

export const ROAD_WIDTH = 14;
export const NUM_CHECKPOINTS = 16;
const SAMPLES = 320;
const UP = new THREE.Vector3(0, 1, 0);

const CONTROL_POINTS = [
  [0, -70], [55, -95], [115, -55], [125, 25], [75, 70], [25, 45],
  [-25, 95], [-95, 80], [-130, 10], [-95, -65], [-40, -95],
].map(([x, z]) => new THREE.Vector3(x, 0, z));

export const curve = new THREE.CatmullRomCurve3(CONTROL_POINTS, true, 'catmullrom', 0.5);

export interface BarrierBox {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  half: THREE.Vector3;
}

export interface Checkpoint {
  pos: THREE.Vector3;
  tangent: THREE.Vector3;
}

export interface TrackData {
  group: THREE.Group; // all visuals — add to scene
  barriers: BarrierBox[]; // physics layer creates colliders from these
  checkpoints: Checkpoint[]; // [0] is the start/finish line
  startLights: THREE.MeshStandardMaterial[]; // 5 materials, one per light disc, driven by game.ts countdown
}

export function buildTrack(): TrackData {
  const group = new THREE.Group();

  // --- ground ---
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900),
    new THREE.MeshStandardMaterial({ color: 0x4e7a3d }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  group.add(ground);

  // --- road ribbon ---
  group.add(ribbon(ROAD_WIDTH, 0.0, new THREE.MeshStandardMaterial({ color: 0x2e2f33, roughness: 0.95 })));
  // edge lines
  group.add(stripe(ROAD_WIDTH / 2 - 0.35, 0xffffff));
  group.add(stripe(-(ROAD_WIDTH / 2 - 0.35), 0xffffff));

  // --- barriers (visual walls + physics boxes) ---
  const barriers: BarrierBox[] = [];
  const wallGeo = new THREE.BoxGeometry(0.4, 1.0, 6.4);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xd84b41 });
  const wallMatW = new THREE.MeshStandardMaterial({ color: 0xf3f4f6 });
  const nWalls = Math.floor(curve.getLength() / 6);
  const walls = new THREE.InstancedMesh(wallGeo, wallMat, nWalls * 2);
  const wallsW = new THREE.InstancedMesh(wallGeo, wallMatW, nWalls * 2);
  const m = new THREE.Matrix4();
  let wi = 0;
  let wwi = 0;
  for (let i = 0; i < nWalls; i++) {
    const u = i / nWalls;
    const pos = curve.getPointAt(u);
    const tan = curve.getTangentAt(u);
    const side = new THREE.Vector3().crossVectors(tan, UP).normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), tan);
    for (const dir of [-1, 1]) {
      const p = pos.clone().addScaledVector(side, dir * (ROAD_WIDTH / 2 + 0.8)).setY(0.5);
      barriers.push({ pos: p, quat: quat.clone(), half: new THREE.Vector3(0.2, 0.5, 3.2) });
      m.compose(p, quat, new THREE.Vector3(1, 1, 1));
      if (i % 2 === 0) walls.setMatrixAt(wi++, m);
      else wallsW.setMatrixAt(wwi++, m);
    }
  }
  walls.count = wi;
  wallsW.count = wwi;
  group.add(walls, wallsW);

  // --- checkpoints ---
  const checkpoints: Checkpoint[] = [];
  for (let i = 0; i < NUM_CHECKPOINTS; i++) {
    const u = i / NUM_CHECKPOINTS;
    checkpoints.push({ pos: curve.getPointAt(u), tangent: curve.getTangentAt(u) });
  }

  // --- start/finish gantry ---
  const start = checkpoints[0];
  const side = new THREE.Vector3().crossVectors(start.tangent, UP).normalize();
  const postGeo = new THREE.CylinderGeometry(0.3, 0.3, 7);
  const postMat = new THREE.MeshStandardMaterial({ color: 0xdddddd });
  for (const dir of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.copy(start.pos).addScaledVector(side, dir * (ROAD_WIDTH / 2 + 1)).setY(3.5);
    group.add(post);
  }
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(ROAD_WIDTH + 3.5, 1.2, 0.8),
    new THREE.MeshStandardMaterial({ color: 0xe8463c }),
  );
  beam.position.copy(start.pos).setY(7);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), side);
  group.add(beam);

  // --- F1-style start light rig, mounted under the gantry beam, facing the grid ---
  // Cars approach the line from behind it (grid sits at u≈0.99, just before u=0/checkpoint 0),
  // so the rig must face back along -tangent (toward the grid), not along the tangent.
  const startLights: THREE.MeshStandardMaterial[] = [];
  const rigGroup = new THREE.Group();
  const housingGeo = new THREE.BoxGeometry(3.2, 0.5, 0.25);
  const housingMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 });
  const housing = new THREE.Mesh(housingGeo, housingMat);
  rigGroup.add(housing);
  const discGeo = new THREE.CircleGeometry(0.18, 16);
  const discCount = 5;
  for (let i = 0; i < discCount; i++) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x220000,
      emissive: 0x000000,
      emissiveIntensity: 0,
      roughness: 0.4,
    });
    startLights.push(mat);
    const disc = new THREE.Mesh(discGeo, mat);
    const x = (i - (discCount - 1) / 2) * 0.6;
    disc.position.set(x, 0, 0.13);
    rigGroup.add(disc);
  }
  rigGroup.position.copy(start.pos).setY(6.3);
  // Face the grid: the grid approaches from behind the line, i.e. along -tangent.
  const facingGrid = start.tangent.clone().negate();
  rigGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), facingGrid);
  group.add(rigGroup);

  // --- trees (instanced, kept off the road) ---
  const roadPts: THREE.Vector3[] = [];
  for (let i = 0; i < 100; i++) roadPts.push(curve.getPointAt(i / 100));
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 2.4);
  const leafGeo = new THREE.ConeGeometry(2.0, 5.0, 7);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x6b4a2b }), 160);
  const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ color: 0x2f6b34 }), 160);
  leaves.castShadow = true;
  let ti = 0;
  let attempts = 0;
  // deterministic pseudo-random so every client builds the same forest
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  while (ti < 160 && attempts++ < 4000) {
    const p = new THREE.Vector3(rand() * 700 - 350, 0, rand() * 700 - 350);
    if (roadPts.some((rp) => rp.distanceTo(p) < ROAD_WIDTH * 1.8)) continue;
    m.compose(p.clone().setY(1.2), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    trunks.setMatrixAt(ti, m);
    m.compose(p.clone().setY(4.6), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    leaves.setMatrixAt(ti, m);
    ti++;
  }
  trunks.count = leaves.count = ti;
  group.add(trunks, leaves);

  return { group, barriers, checkpoints, startLights };
}

function ribbon(width: number, y: number, mat: THREE.Material): THREE.Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const u = (i % SAMPLES) / SAMPLES;
    const pos = curve.getPointAt(u);
    const tan = curve.getTangentAt(u);
    const side = new THREE.Vector3().crossVectors(tan, UP).normalize();
    const l = pos.clone().addScaledVector(side, -width / 2);
    const r = pos.clone().addScaledVector(side, width / 2);
    positions.push(l.x, y, l.z, r.x, y, r.z);
    if (i < SAMPLES) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function stripe(offset: number, color: number): THREE.Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const u = (i % SAMPLES) / SAMPLES;
    const pos = curve.getPointAt(u);
    const tan = curve.getTangentAt(u);
    const side = new THREE.Vector3().crossVectors(tan, UP).normalize();
    const l = pos.clone().addScaledVector(side, offset - 0.18);
    const r = pos.clone().addScaledVector(side, offset + 0.18);
    positions.push(l.x, 0.02, l.z, r.x, 0.02, r.z);
    if (i < SAMPLES) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
}

/** Starting grid pose for a slot (0-3), just behind the start line, 2 columns. */
export function gridPose(slot: number): { pos: THREE.Vector3; yaw: number } {
  const u = (1 - 0.010 - Math.floor(slot / 2) * 0.008 + 1) % 1;
  const pos = curve.getPointAt(u);
  const tan = curve.getTangentAt(u);
  const side = new THREE.Vector3().crossVectors(tan, UP).normalize();
  pos.addScaledVector(side, slot % 2 === 0 ? -ROAD_WIDTH / 4 : ROAD_WIDTH / 4);
  const yaw = Math.atan2(-tan.x, -tan.z);
  return { pos, yaw };
}
