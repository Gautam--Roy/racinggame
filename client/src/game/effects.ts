import * as THREE from 'three';

const MAX_PARTICLES = 400;

interface Slot {
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  r: number;
  g: number;
  b: number;
}

/**
 * Fixed-size particle pool rendered as a single additive THREE.Points object.
 * Fade is approximated by darkening color toward black (no built-in per-point alpha
 * on PointsMaterial) — reads as fade-out under additive blending.
 */
export class ParticleSystem {
  readonly points: THREE.Points;
  private readonly geometry: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly slots: Slot[] = [];
  private cursor = 0;
  private live = 0;

  constructor() {
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.sizes = new Float32Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.slots.push({ vx: 0, vy: 0, vz: 0, life: 0, maxLife: 0, size: 0, r: 0, g: 0, b: 0 });
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    const material = new THREE.PointsMaterial({
      size: 1,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
  }

  get activeCount(): number {
    return this.live;
  }

  spawn(pos: THREE.Vector3, vel: THREE.Vector3, life: number, size: number, color: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    const slot = this.slots[i];
    if (slot.life <= 0) this.live++;
    slot.vx = vel.x;
    slot.vy = vel.y;
    slot.vz = vel.z;
    slot.life = life;
    slot.maxLife = life;
    slot.size = size;
    const c = TMP_COLOR.set(color);
    slot.r = c.r;
    slot.g = c.g;
    slot.b = c.b;
    this.positions[i * 3] = pos.x;
    this.positions[i * 3 + 1] = pos.y;
    this.positions[i * 3 + 2] = pos.z;
    this.sizes[i] = size;
    this.colors[i * 3] = c.r;
    this.colors[i * 3 + 1] = c.g;
    this.colors[i * 3 + 2] = c.b;
  }

  update(dt: number): void {
    let live = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const slot = this.slots[i];
      if (slot.life <= 0) continue;
      slot.life -= dt;
      if (slot.life <= 0) {
        this.sizes[i] = 0;
        this.colors[i * 3] = 0;
        this.colors[i * 3 + 1] = 0;
        this.colors[i * 3 + 2] = 0;
        continue;
      }
      live++;
      this.positions[i * 3] += slot.vx * dt;
      this.positions[i * 3 + 1] += slot.vy * dt;
      this.positions[i * 3 + 2] += slot.vz * dt;
      const t = Math.max(0, slot.life / slot.maxLife);
      this.colors[i * 3] = slot.r * t;
      this.colors[i * 3 + 1] = slot.g * t;
      this.colors[i * 3 + 2] = slot.b * t;
      this.sizes[i] = slot.size * t;
    }
    this.live = live;
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.geometry.attributes.size.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

const TMP_COLOR = new THREE.Color();
