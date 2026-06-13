import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CAR_MODELS, CarModel } from '../../../shared/src/protocol';

export const CAR_LENGTH = 3.6;
/** Kenney models face +Z; our forward convention is −Z. Flip if cars appear to drive backwards. */
const MODEL_YAW = Math.PI;

const ACCENT: Record<CarModel, number> = {
  race: 0xd8342a,
  'race-future': 0x2a6fd8,
  'sedan-sports': 0x2ad860,
  suv: 0xd8b02a,
};

const loader = new GLTFLoader();
const cache = new Map<CarModel, THREE.Group>();

export async function preloadCars(models: CarModel[] = [...CAR_MODELS]): Promise<void> {
  await Promise.all(models.map((m) => loadCarTemplate(m)));
}

async function loadCarTemplate(model: CarModel): Promise<THREE.Group> {
  const cached = cache.get(model);
  if (cached) return cached;
  let group: THREE.Group;
  try {
    const gltf = await loader.loadAsync(`/models/cars/${model}.glb`);
    group = normalize(gltf.scene);
  } catch {
    console.warn(`model ${model}.glb missing — using fallback car`);
    group = fallbackCar(ACCENT[model]);
  }
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = false;
    }
  });
  cache.set(model, group);
  return group;
}

/** Returns a fresh instance; bottom of wheels at y=0, centered, facing −Z, ~CAR_LENGTH long. */
export async function instantiateCar(model: CarModel): Promise<THREE.Group> {
  const template = await loadCarTemplate(model);
  return template.clone(true);
}

function normalize(scene: THREE.Group): THREE.Group {
  const wrapper = new THREE.Group();
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const scale = CAR_LENGTH / Math.max(size.z, 0.001);
  scene.scale.setScalar(scale);
  const box2 = new THREE.Box3().setFromObject(scene);
  const center = box2.getCenter(new THREE.Vector3());
  scene.position.sub(center).setY(scene.position.y - box2.min.y);
  const inner = new THREE.Group();
  inner.add(scene);
  inner.rotation.y = MODEL_YAW;
  wrapper.add(inner);
  return wrapper;
}

function fallbackCar(color: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.4, roughness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, CAR_LENGTH), mat);
  body.position.y = 0.55;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.45, 1.6), dark);
  cabin.position.set(0, 1.0, 0.1);
  g.add(body, cabin);
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.3, 14);
  wheelGeo.rotateZ(Math.PI / 2);
  for (const [x, z] of [[-0.85, -1.15], [0.85, -1.15], [-0.85, 1.15], [0.85, 1.15]]) {
    const w = new THREE.Mesh(wheelGeo, dark);
    w.position.set(x, 0.34, z);
    g.add(w);
  }
  return g;
}
