import * as THREE from 'three';

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  cloudGroup: THREE.Group;
  dispose: () => void;
}

const SKY_ZENITH = 0x2a5fb8;
const SKY_MID = 0x7fb2e5;
const SKY_HORIZON = 0xdcecf7;
const SKY_HAZE = 0xf2e8d8;
const CLOUD_COUNT_LOW = 12; // y 90-130, large/soft
const CLOUD_COUNT_HIGH = 10; // y 140-180, smaller/wispier

// Sun direction matches the DirectionalLight position below, normalized.
const SUN_DIR = new THREE.Vector3(120, 180, 80).normalize();

/** Three-stop-gradient sky dome (zenith -> mid -> horizon, plus a low warm-haze tint and a
 * cheap dot-product sun-glow term) — a ShaderMaterial mixing colors by world-space view direction. */
function buildSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(600, 32, 15);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      zenithColor: { value: new THREE.Color(SKY_ZENITH) },
      midColor: { value: new THREE.Color(SKY_MID) },
      horizonColor: { value: new THREE.Color(SKY_HORIZON) },
      hazeColor: { value: new THREE.Color(SKY_HAZE) },
      sunDir: { value: SUN_DIR.clone() },
    },
    vertexShader: `
      varying vec3 vWorldDir;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldDir = normalize(worldPos.xyz - cameraPosition);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      uniform vec3 zenithColor;
      uniform vec3 midColor;
      uniform vec3 horizonColor;
      uniform vec3 hazeColor;
      uniform vec3 sunDir;
      varying vec3 vWorldDir;
      void main() {
        vec3 dir = normalize(vWorldDir);
        float h = clamp(dir.y, -1.0, 1.0);
        // mid stop sits at ~25 deg elevation -> sin(25deg) ~= 0.423
        float midH = 0.423;
        float lowMix = smoothstep(0.0, midH, h);
        vec3 col = mix(horizonColor, midColor, lowMix);
        float highMix = smoothstep(midH, 1.0, h);
        col = mix(col, zenithColor, highMix);
        // warm haze blended into the lowest ~8 degrees (sin(8deg) ~= 0.139)
        float hazeMix = 1.0 - smoothstep(0.0, 0.139, h);
        col = mix(col, hazeColor, hazeMix * 0.6);
        // cheap sun glow: brighten within ~15deg (cos(15deg) ~= 0.966) of the sun direction
        float sunDot = dot(dir, sunDir);
        float glow = smoothstep(0.966, 1.0, sunDot);
        col += vec3(1.0, 0.96, 0.85) * glow * 0.15;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1000;
  return mesh;
}

/** Bright disc + soft glow texture for the sun sprite. */
function buildSunTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const cx = 64;
  const cy = 64;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.15, 'rgba(255,250,235,0.95)');
  grad.addColorStop(0.4, 'rgba(255,240,200,0.35)');
  grad.addColorStop(1, 'rgba(255,240,200,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function buildSun(): { sprite: THREE.Sprite; texture: THREE.CanvasTexture; material: THREE.SpriteMaterial } {
  const texture = buildSunTexture();
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    fog: false,
    color: 0xffffff,
  });
  const sprite = new THREE.Sprite(material);
  const pos = SUN_DIR.clone().multiplyScalar(600 * 0.95);
  sprite.position.copy(pos);
  sprite.scale.set(60, 60, 1);
  sprite.renderOrder = -999;
  return { sprite, texture, material };
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

  // low band: large/soft, opacity 0.5-0.7
  for (let i = 0; i < CLOUD_COUNT_LOW; i++) {
    const sprite = new THREE.Sprite(materialA.clone());
    const angle = Math.random() * Math.PI * 2;
    const dist = 180 + Math.random() * 240; // 180..420
    const y = 90 + Math.random() * 40; // 90..130
    sprite.position.set(Math.cos(angle) * dist, y, Math.sin(angle) * dist);
    const w = 60 + Math.random() * 80; // 60..140
    sprite.scale.set(w, w * 0.45, 1);
    sprite.material.opacity = 0.5 + Math.random() * 0.2; // 0.5..0.7
    group.add(sprite);
  }
  // high band: smaller/wispier, opacity 0.3-0.5
  for (let i = 0; i < CLOUD_COUNT_HIGH; i++) {
    const sprite = new THREE.Sprite(materialB.clone());
    const angle = Math.random() * Math.PI * 2;
    const dist = 180 + Math.random() * 240; // 180..420
    const y = 140 + Math.random() * 40; // 140..180
    sprite.position.set(Math.cos(angle) * dist, y, Math.sin(angle) * dist);
    const w = 60 + Math.random() * 40; // 60..100
    sprite.scale.set(w, w * 0.45, 1);
    sprite.material.opacity = 0.3 + Math.random() * 0.2; // 0.3..0.5
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

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(SKY_HORIZON, 160, 480);

  const sky = buildSky();
  scene.add(sky);

  const { sprite: sunSprite, texture: sunTexture, material: sunMaterial } = buildSun();
  scene.add(sunSprite);

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
  sun.position.set(120, 180, 80);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -170;
  sc.right = sc.top = 170;
  sc.far = 500;
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 700);
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
    dispose: () => {
      window.removeEventListener('resize', onResize);
      sky.geometry.dispose();
      (sky.material as THREE.Material).dispose();
      sunTexture.dispose();
      sunMaterial.dispose();
      for (const m of cloudMaterials) m.dispose();
      for (const m of cloudBaseMaterials) m.dispose();
      for (const t of cloudTextures) t.dispose();
      renderer.dispose();
    },
  };
}
