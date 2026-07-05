import * as THREE from 'three';

const MAX_PARTICLES = 400;

interface Slot {
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  startSize: number;
  endSize: number;
  startAlpha: number;
  r: number;
  g: number;
  b: number;
}

const VERTEX_SHADER = `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (400.0 / -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const FRAGMENT_SHADER = `
uniform sampler2D map;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 tex = texture2D(map, gl_PointCoord);
  gl_FragColor = vec4(vColor, tex.a * vAlpha);
}
`;

let sharedTexture: THREE.CanvasTexture | null = null;

/** Lazily builds (once) a soft radial-gradient texture shared by all particle pools. */
function getSoftTexture(): THREE.CanvasTexture {
  if (sharedTexture) return sharedTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.8)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  sharedTexture = new THREE.CanvasTexture(canvas);
  return sharedTexture;
}

function disposeSharedTexture(): void {
  sharedTexture?.dispose();
  sharedTexture = null;
}

/**
 * Fixed-size particle pool rendered as a single THREE.Points object with a custom shader:
 * a soft radial texture (rather than a flat square dot) plus true per-particle alpha and
 * size-over-life growth/shrink, which THREE.PointsMaterial can't express on its own.
 */
export class ParticlePool {
  readonly points: THREE.Points;
  private readonly geometry: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly alphas: Float32Array;
  private readonly slots: Slot[] = [];
  private cursor = 0;
  private live = 0;

  constructor(blending: THREE.Blending) {
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.sizes = new Float32Array(MAX_PARTICLES);
    this.alphas = new Float32Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.slots.push({ vx: 0, vy: 0, vz: 0, life: 0, maxLife: 0, startSize: 0, endSize: 0, startAlpha: 0, r: 0, g: 0, b: 0 });
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    const material = new THREE.ShaderMaterial({
      uniforms: { map: { value: getSoftTexture() } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
  }

  get activeCount(): number {
    return this.live;
  }

  /**
   * @param startSize particle size at spawn
   * @param endSize particle size at end of life (defaults to startSize — no growth)
   * @param startAlpha peak alpha at spawn, fades linearly to 0 over life (defaults to 1)
   */
  spawn(
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    life: number,
    startSize: number,
    color: number,
    endSize = startSize,
    startAlpha = 1,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    const slot = this.slots[i];
    if (slot.life <= 0) this.live++;
    slot.vx = vel.x;
    slot.vy = vel.y;
    slot.vz = vel.z;
    slot.life = life;
    slot.maxLife = life;
    slot.startSize = startSize;
    slot.endSize = endSize;
    slot.startAlpha = startAlpha;
    const c = TMP_COLOR.set(color);
    slot.r = c.r;
    slot.g = c.g;
    slot.b = c.b;
    this.positions[i * 3] = pos.x;
    this.positions[i * 3 + 1] = pos.y;
    this.positions[i * 3 + 2] = pos.z;
    this.sizes[i] = startSize;
    this.alphas[i] = startAlpha;
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
        this.alphas[i] = 0;
        this.sizes[i] = 0;
        continue;
      }
      live++;
      this.positions[i * 3] += slot.vx * dt;
      this.positions[i * 3 + 1] += slot.vy * dt;
      this.positions[i * 3 + 2] += slot.vz * dt;
      const t = Math.max(0, slot.life / slot.maxLife); // 1 at spawn -> 0 at death
      const age = 1 - t;
      this.sizes[i] = slot.startSize + (slot.endSize - slot.startSize) * age;
      this.alphas[i] = slot.startAlpha * t;
      this.colors[i * 3] = slot.r;
      this.colors[i * 3 + 1] = slot.g;
      this.colors[i * 3 + 2] = slot.b;
    }
    this.live = live;
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

const SMOKE_COLORS = [0xbababa, 0xc4c4c4, 0xcecece, 0xd8d8d8, 0xdddddd];

/** Bundles the two particle pools game.ts needs: soft gray drift smoke (normal blend, grows+fades) and bright turbo flames (additive, kept as-is). */
export class Effects {
  readonly smoke = new ParticlePool(THREE.NormalBlending);
  readonly flame = new ParticlePool(THREE.AdditiveBlending);

  get activeCount(): number {
    return this.smoke.activeCount + this.flame.activeCount;
  }

  /** Drift smoke: light-gray soft blob, grows ~0.7 -> x2.5 over life, alpha 0.55 -> 0. */
  spawnSmoke(pos: THREE.Vector3, vel: THREE.Vector3, life: number): void {
    const startSize = 0.7 + Math.random() * 0.2;
    const color = SMOKE_COLORS[(Math.random() * SMOKE_COLORS.length) | 0];
    this.smoke.spawn(pos, vel, life, startSize, color, startSize * 2.5, 0.55);
  }

  update(dt: number): void {
    this.smoke.update(dt);
    this.flame.update(dt);
  }

  dispose(): void {
    this.smoke.dispose();
    this.flame.dispose();
    disposeSharedTexture();
  }
}

const TMP_COLOR = new THREE.Color();
