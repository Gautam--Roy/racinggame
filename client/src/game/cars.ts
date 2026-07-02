import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CAR_MODELS, CarModel } from '../../../shared/src/protocol';

export const CAR_LENGTH = 3.6;
/** Kenney models face +Z; our forward convention is −Z. Flip if cars appear to drive backwards. */
const MODEL_YAW = Math.PI;

export const ACCENT: Record<CarModel, number> = {
  race: 0xd8342a,
  'race-future': 0x2a6fd8,
  'sedan-sports': 0x2ad860,
  suv: 0xd8b02a,
  'hatchback-sports': 0x8a2ad8,
  police: 0x2a4ad8,
  taxi: 0xffc400,
  ambulance: 0xd84a4a,
};

export const CAR_DISPLAY: Record<CarModel, string> = {
  race: 'Racer',
  'race-future': 'Future GP',
  'sedan-sports': 'Sport Sedan',
  suv: 'SUV',
  'hatchback-sports': 'Hot Hatch',
  police: 'Police',
  taxi: 'Taxi',
  ambulance: 'Ambulance',
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
    group = normalizeCar(gltf.scene);
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

/** Node names Kenney's car-kit GLBs use for wheel meshes. */
const WHEEL_NAMES = {
  fl: 'wheel-front-left',
  fr: 'wheel-front-right',
  bl: 'wheel-back-left',
  br: 'wheel-back-right',
} as const;

export interface Wheels {
  fl?: THREE.Object3D;
  fr?: THREE.Object3D;
  bl?: THREE.Object3D;
  br?: THREE.Object3D;
}

/** Looks up wheel nodes by name on an instantiated car group (works after clone(true) since names persist). */
export function findWheels(group: THREE.Object3D): Wheels {
  return {
    fl: group.getObjectByName(WHEEL_NAMES.fl) ?? undefined,
    fr: group.getObjectByName(WHEEL_NAMES.fr) ?? undefined,
    bl: group.getObjectByName(WHEEL_NAMES.bl) ?? undefined,
    br: group.getObjectByName(WHEEL_NAMES.br) ?? undefined,
  };
}

/** The group that body-tilt (roll/pitch) should be applied to; composes under MODEL_YAW. */
export function findTiltTarget(group: THREE.Object3D): THREE.Object3D | undefined {
  return group.getObjectByName('car-inner') ?? undefined;
}

export function normalizeCar(scene: THREE.Group): THREE.Group {
  const wrapper = new THREE.Group();
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const scale = CAR_LENGTH / Math.max(size.z, 0.001);
  scene.scale.setScalar(scale);
  const box2 = new THREE.Box3().setFromObject(scene);
  const center = box2.getCenter(new THREE.Vector3());
  scene.position.set(-center.x, -box2.min.y, -center.z);
  const inner = new THREE.Group();
  inner.name = 'car-inner';
  inner.add(scene);
  inner.rotation.y = MODEL_YAW;
  wrapper.add(inner);
  return wrapper;
}

function fallbackCar(color: number): THREE.Group {
  const wrapper = new THREE.Group();
  const inner = new THREE.Group();
  inner.name = 'car-inner';
  wrapper.add(inner);

  const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.4, roughness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, CAR_LENGTH), mat);
  body.position.y = 0.55;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.45, 1.6), dark);
  cabin.position.set(0, 1.0, 0.1);
  inner.add(body, cabin);
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.3, 14);
  wheelGeo.rotateZ(Math.PI / 2);
  const corners: [number, number, keyof typeof WHEEL_NAMES][] = [
    [-0.85, -1.15, 'fl'],
    [0.85, -1.15, 'fr'],
    [-0.85, 1.15, 'bl'],
    [0.85, 1.15, 'br'],
  ];
  for (const [x, z, key] of corners) {
    const w = new THREE.Mesh(wheelGeo, dark);
    w.position.set(x, 0.34, z);
    w.name = WHEEL_NAMES[key];
    inner.add(w);
  }
  return wrapper;
}
