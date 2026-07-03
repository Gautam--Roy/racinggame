import * as THREE from 'three';

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  cloudGroup: THREE.Group;
  dispose: () => void;
}

const SKY_TOP = 0x3a7bd5;
const SKY_HORIZON = 0xcfe4f5;
const CLOUD_COUNT = 14;

/** Vertical-gradient sky dome: cheap ShaderMaterial mixing top/horizon color by world-Y direction. */
function buildSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(600, 32, 15);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(SKY_TOP) },
      horizonColor: { value: new THREE.Color(SKY_HORIZON) },
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
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      varying vec3 vWorldDir;
      void main() {
        float h = clamp(vWorldDir.y, 0.0, 1.0);
        float t = pow(h, 0.6);
        gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0);
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

/** One shared CanvasTexture: a handful of soft white radial-gradient blobs on transparent. */
function buildCloudTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const blobs = 4 + Math.floor(Math.random() * 3); // 4-6
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

function buildClouds(): { group: THREE.Group; texture: THREE.CanvasTexture; material: THREE.SpriteMaterial } {
  const group = new THREE.Group();
  const texture = buildCloudTexture();
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const sprite = new THREE.Sprite(material);
    const angle = Math.random() * Math.PI * 2;
    const dist = 180 + Math.random() * 240; // 180..420
    const y = 90 + Math.random() * 60; // 90..150
    sprite.position.set(Math.cos(angle) * dist, y, Math.sin(angle) * dist);
    const w = 50 + Math.random() * 60; // 50..110
    sprite.scale.set(w, w * 0.5, 1);
    sprite.material.opacity = 0.55 + Math.random() * 0.3; // 0.55..0.85
    group.add(sprite);
  }
  return { group, texture, material };
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

  const { group: cloudGroup, texture: cloudTexture, material: cloudMaterial } = buildClouds();
  scene.add(cloudGroup);

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
      cloudMaterial.dispose();
      cloudTexture.dispose();
      renderer.dispose();
    },
  };
}
