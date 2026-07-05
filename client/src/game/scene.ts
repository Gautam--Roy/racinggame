import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  cloudGroup: THREE.Group;
  sky: THREE.Object3D;
  dispose: () => void;
}

// Sun elevation/azimuth drive BOTH the Sky shader's sun disc and the DirectionalLight direction,
// so shadows and the visible sun agree. Azimuth 0 == +Z axis, increasing toward +X (matches the
// spherical-coords convention used below for both the light position and Sky's sunPosition).
const SUN_ELEVATION_DEG = 32;
const SUN_AZIMUTH_DEG = 55;
const SUN_DIST = 400; // arbitrary — only direction matters for the light/Sky sun vector

const SKY_TURBIDITY = 6;
const SKY_RAYLEIGH = 1.8;
const SKY_MIE_COEFFICIENT = 0.004;
const SKY_MIE_DIRECTIONAL_G = 0.85;

// Horizon tone sample-matched against the Sky shader's output at this elevation (see verification
// screenshots) so the fog-to-sky seam is subtle instead of a visible band.
const FOG_COLOR = 0xcfd9e8;

const CLOUD_COUNT_LOW = 12; // large/soft, lower band
const CLOUD_COUNT_HIGH = 10; // smaller/wispier, upper band

function sunDirection(): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(90 - SUN_ELEVATION_DEG); // polar angle from +Y
  const theta = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG);
  return new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
}

function buildSky(): Sky {
  const sky = new Sky();
  sky.scale.setScalar(900);
  const u = sky.material.uniforms;
  u.turbidity.value = SKY_TURBIDITY;
  u.rayleigh.value = SKY_RAYLEIGH;
  u.mieCoefficient.value = SKY_MIE_COEFFICIENT;
  u.mieDirectionalG.value = SKY_MIE_DIRECTIONAL_G;
  u.sunPosition.value.copy(sunDirection());
  return sky;
}

/** One CanvasTexture layout: a handful of soft white radial-gradient blobs on transparent. */
function buildCloudTexture(blobs: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  for (let i = 0; i < blobs; i++) {
    const cx = 40 + Math.random() * (canvas.width - 80);
    const cy = 40 + Math.random() * (canvas.height - 80);
    const r = 30 + Math.random() * 45;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.5)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function buildClouds(): { group: THREE.Group; textures: THREE.CanvasTexture[]; baseMaterials: THREE.SpriteMaterial[] } {
  const group = new THREE.Group();
  const textureA = buildCloudTexture(5); // 4-6 blobs, layout A
  const textureB = buildCloudTexture(7); // more, smaller blobs, layout B (wispier)
  const materialA = new THREE.SpriteMaterial({ map: textureA, transparent: true, depthWrite: false, fog: false });
  const materialB = new THREE.SpriteMaterial({ map: textureB, transparent: true, depthWrite: false, fog: false });

  // Bigger world (~1290m loop) -> push clouds further out and higher so they clear the track's
  // extent (bbox ~ x[-164,190] z[-164,135]) at every camera position, plus re-tuned opacity for
  // the ACES-tonemapped scene (slightly lower than the pre-tonemap values so they don't blow out).
  // low band: large/soft
  for (let i = 0; i < CLOUD_COUNT_LOW; i++) {
    const sprite = new THREE.Sprite(materialA.clone());
    const angle = Math.random() * Math.PI * 2;
    const dist = 250 + Math.random() * 180; // 250..430
    const y = 110 + Math.random() * 45; // 110..155
    sprite.position.set(Math.cos(angle) * dist, y, Math.sin(angle) * dist);
    const w = 70 + Math.random() * 90; // 70..160
    sprite.scale.set(w, w * 0.45, 1);
    sprite.material.opacity = 0.42 + Math.random() * 0.18; // 0.42..0.6
    group.add(sprite);
  }
  // high band: smaller/wispier
  for (let i = 0; i < CLOUD_COUNT_HIGH; i++) {
    const sprite = new THREE.Sprite(materialB.clone());
    const angle = Math.random() * Math.PI * 2;
    const dist = 280 + Math.random() * 240; // 280..520
    const y = 160 + Math.random() * 40; // 160..200
    sprite.position.set(Math.cos(angle) * dist, y, Math.sin(angle) * dist);
    const w = 60 + Math.random() * 45; // 60..105
    sprite.scale.set(w, w * 0.45, 1);
    sprite.material.opacity = 0.25 + Math.random() * 0.18; // 0.25..0.43
    group.add(sprite);
  }
  return { group, textures: [textureA, textureB], baseMaterials: [materialA, materialB] };
}

export function createScene(canvas: HTMLCanvasElement): SceneCtx {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Required for three's Sky (Preetham atmospheric scattering) to grade correctly; also changes
  // overall scene exposure — verified visually against screenshots (asphalt/grass still read
  // correctly at 0.55; adjust within 0.45-0.7 if the scene looks washed out or too dark).
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.55;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(FOG_COLOR, 160, 560);

  const sky = buildSky();
  scene.add(sky);

  const { group: cloudGroup, textures: cloudTextures, baseMaterials: cloudBaseMaterials } = buildClouds();
  scene.add(cloudGroup);
  // each sprite got its own cloned material (independent opacity) — collect them for disposal
  const cloudMaterials: THREE.Material[] = [];
  cloudGroup.traverse((obj) => {
    if (obj instanceof THREE.Sprite) cloudMaterials.push(obj.material as THREE.Material);
  });

  const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x3e5e3a, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3da, 2.2);
  sun.position.copy(sunDirection().multiplyScalar(SUN_DIST));
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -170;
  sc.right = sc.top = 170;
  sc.far = 500;
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1100);
  camera.position.set(0, 40, 60);
  camera.lookAt(0, 0, 0);

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  return {
    renderer,
    scene,
    camera,
    cloudGroup,
    sky,
    dispose: () => {
      window.removeEventListener('resize', onResize);
      sky.geometry.dispose();
      (sky.material as THREE.Material).dispose();
      for (const m of cloudMaterials) m.dispose();
      for (const m of cloudBaseMaterials) m.dispose();
      for (const t of cloudTextures) t.dispose();
      renderer.dispose();
    },
  };
}
