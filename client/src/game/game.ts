import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CarState, PlayerInfo, Progress, progressScore, STATE_HZ, TOTAL_LAPS } from '../../../shared/src/protocol';
import { SnapshotBuffer } from '../net/interpolation';
import { Hud } from '../ui/hud';
import { AudioManager } from './audio';
import { ChaseCamera } from './camera';
import { instantiateCar } from './cars';
import { Input } from './input';
import { CAR_HALF, createLocalCar, createRemoteCar, createWorld, driveCar, freezeCar, initRapier, MAX_SPEED } from './physics';
import { CheckpointTracker } from './raceLogic';
import { createScene, SceneCtx } from './scene';
import { buildTrack, curve, gridPose, ROAD_WIDTH, TrackData } from './track';
import { findTiltTarget, findWheels, Wheels } from './cars';
import { ParticleSystem } from './effects';

const FIXED_DT = 1 / 60;
const INTERP_DELAY_MS = 120;
const CP_RADIUS = ROAD_WIDTH * 0.75;
const COLLISION_DROP_THRESHOLD = 6; // m/s
const COLLISION_DROP_RANGE = 12; // m/s, maps drop above threshold to intensity 0..1
const WHEEL_RADIUS = 0.34; // m, approx across all car models
const STEER_WHEEL_MAX = 0.45; // rad, front wheel yaw at full steer
const TILT_LERP = 8; // 1/s
const TILT_ROLL_MAX = 0.09; // rad
const TILT_PITCH_MAX = 0.06; // rad

/** Per-car visual animation state: wheel spin/steer, body tilt, smoothed accel estimates. */
interface CarAnim {
  wheels: Wheels;
  tilt: THREE.Object3D | undefined;
  fwdSpeed: number; // smoothed signed forward speed estimate (m/s), used for wheel spin + remotes
  prevHorizVel: THREE.Vector3; // own car only: full (x,z) velocity from the physics body
  prevSpeedEstimate: number; // remote cars only: previous smoothed fwdSpeed, for tilt-from-delta
  roll: number;
  pitch: number;
}

const warnedNoWheels = new WeakSet<THREE.Group>();

function createCarAnim(mesh: THREE.Group): CarAnim {
  const wheels = findWheels(mesh);
  if (!wheels.fl && !wheels.fr && !wheels.bl && !wheels.br && !warnedNoWheels.has(mesh)) {
    warnedNoWheels.add(mesh);
    console.warn('car model has no named wheel nodes — wheels will not animate');
  }
  return {
    wheels,
    tilt: findTiltTarget(mesh),
    fwdSpeed: 0,
    prevHorizVel: new THREE.Vector3(),
    prevSpeedEstimate: 0,
    roll: 0,
    pitch: 0,
  };
}

// Scratch objects reused across frames to avoid hot-path allocation.
const FWD_SCRATCH = new THREE.Vector3();
const LAT_SCRATCH = new THREE.Vector3();
const VEL_SCRATCH = new THREE.Vector3();
const SMOKE_POS = new THREE.Vector3();
const SMOKE_VEL = new THREE.Vector3();
const FLAME_POS = new THREE.Vector3();
const FLAME_VEL = new THREE.Vector3();
const REMOTE_DELTA = new THREE.Vector3();
const REMOTE_FWD = new THREE.Vector3();

export interface GameCallbacks {
  sendState: (state: CarState) => void;
  sendFinished: (timeMs: number) => void;
  sendHorn: () => void;
}

interface RemoteCar {
  mesh: THREE.Group;
  body: RAPIER.RigidBody;
  buffer: SnapshotBuffer;
  progress: Progress;
  anim: CarAnim;
  turboActive: boolean;
  prevPos: THREE.Vector3;
}

export class Game {
  private ctx!: SceneCtx;
  private world!: RAPIER.World;
  private track!: TrackData;
  private input = new Input();
  private hud = new Hud();
  private chase!: ChaseCamera;
  private myBody!: RAPIER.RigidBody;
  private myMesh!: THREE.Group;
  private tracker = new CheckpointTracker(0, TOTAL_LAPS); // re-created with real cp count in create()
  private remotes = new Map<string, RemoteCar>();
  readonly audio = new AudioManager();
  private prevHorizSpeed = 0;
  private lastCountdownText: string | null = null;
  private disposed = false;
  private countdownTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private phase: 'countdown' | 'racing' | 'done' = 'countdown';
  private goTime = 0;
  private lapStart = 0;
  private accumulator = 0;
  private lastTime = 0;
  private sendTimer = 0;
  private raf = 0;
  private prevPos = new THREE.Vector3();
  private currPos = new THREE.Vector3();
  private prevQuat = new THREE.Quaternion();
  private currQuat = new THREE.Quaternion();
  private renderPos = new THREE.Vector3();
  private renderQuat = new THREE.Quaternion();
  private myAnim!: CarAnim;
  readonly effects = new ParticleSystem();
  /** Task 4 sets this when a turbo pickup boost is active. */
  private turboActive = false;

  private constructor(
    private readonly selfId: string,
    private readonly cb: GameCallbacks,
  ) {}

  static async create(
    canvas: HTMLCanvasElement,
    selfId: string,
    players: PlayerInfo[],
    grid: Record<string, number>,
    cb: GameCallbacks,
  ): Promise<Game> {
    await initRapier();
    const game = new Game(selfId, cb);
    game.ctx = createScene(canvas);
    game.track = buildTrack();
    game.ctx.scene.add(game.track.group);
    game.world = createWorld(game.track.barriers);
    game.tracker = new CheckpointTracker(game.track.checkpoints.length, TOTAL_LAPS);
    game.chase = new ChaseCamera(game.ctx.camera);

    const mapPts: { x: number; z: number }[] = [];
    for (let i = 0; i < 128; i++) {
      const p = curve.getPointAt(i / 128);
      mapPts.push({ x: p.x, z: p.z });
    }
    game.hud.initMinimap(mapPts);
    game.hud.onMuteClick = () => game.hud.setMuted(game.audio.toggleMuted());
    game.ctx.scene.add(game.effects.points);

    for (const p of players) {
      const mesh = await instantiateCar(p.car);
      const { pos, yaw } = gridPose(grid[p.id] ?? 0);
      if (p.id === selfId) {
        game.myMesh = mesh;
        game.myAnim = createCarAnim(mesh);
        game.myBody = createLocalCar(game.world, pos, yaw);
        game.syncFromBody();
        game.prevPos.copy(game.currPos);
        game.prevQuat.copy(game.currQuat);
        game.chase.snap(game.currPos, game.currQuat);
      } else {
        const body = createRemoteCar(game.world);
        body.setNextKinematicTranslation({ x: pos.x, y: CAR_HALF.y, z: pos.z });
        mesh.position.copy(pos);
        mesh.rotation.y = yaw;
        game.remotes.set(p.id, {
          mesh,
          body,
          buffer: new SnapshotBuffer(),
          progress: { passed: 0, dist: 0 },
          anim: createCarAnim(mesh),
          turboActive: false,
          prevPos: pos.clone(),
        });
      }
      game.ctx.scene.add(mesh);
    }
    return game;
  }

  start(countdownMs: number): void {
    if (this.started || this.disposed) return; this.started = true;
    this.hud.show();
    this.hud.setLap(1, TOTAL_LAPS);
    this.goTime = performance.now() + countdownMs;
    const tick = () => {
      if (this.disposed || this.phase !== 'countdown') return;
      const left = this.goTime - performance.now();
      if (left <= 0) {
        this.phase = 'racing';
        this.lapStart = this.goTime;
        this.hud.setCountdown('GO!');
        this.audio.countdownBeep(true);
        this.countdownTimer = setTimeout(() => this.hud.setCountdown(null), 800);
      } else {
        const text = `${Math.ceil(left / 1000)}`;
        this.hud.setCountdown(text);
        if (text !== this.lastCountdownText) {
          this.lastCountdownText = text;
          this.audio.countdownBeep(false);
        }
        this.countdownTimer = setTimeout(tick, 100);
      }
    };
    tick();
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  onRemoteState(id: string, state: CarState): void {
    const r = this.remotes.get(id);
    if (!r) return;
    r.buffer.push({ t: performance.now(), p: state.p, q: state.q });
    r.progress = state.progress;
    r.turboActive = !!state.b;
  }

  onPlayerLeft(id: string): void {
    const r = this.remotes.get(id);
    if (!r) return;
    this.ctx.scene.remove(r.mesh);
    this.world.removeRigidBody(r.body);
    this.remotes.delete(id);
  }

  dispose(): void {
    this.disposed = true;
    if (this.countdownTimer) clearTimeout(this.countdownTimer);
    this.phase = 'done';
    cancelAnimationFrame(this.raf);
    this.input.dispose();
    this.hud.hide();
    this.hud.dispose();
    this.audio.dispose();
    this.ctx.scene.remove(this.effects.points);
    this.effects.dispose();
    this.ctx.dispose();
  }

  /** Called by main.ts when a remote's horn ServerMsg arrives; louder when they're closer. */
  onHorn(id: string): void {
    const r = this.remotes.get(id);
    if (!r) return;
    const dist = horizDist(this.currPos, r.mesh.position);
    this.audio.horn(Math.min(1, dist / 120));
  }

  private syncFromBody(): void {
    const t = this.myBody.translation();
    const r = this.myBody.rotation();
    this.currPos.set(t.x, t.y, t.z);
    this.currQuat.set(r.x, r.y, r.z, r.w);
  }

  private fixedStep(): void {
    this.input.update(FIXED_DT);
    if (this.phase === 'racing') driveCar(this.myBody, this.input, FIXED_DT);
    else freezeCar(this.myBody);
    if (this.input.hornPressed) {
      this.cb.sendHorn();
      this.audio.horn(0);
    }
    if (this.input.mutePressed) {
      this.hud.setMuted(this.audio.toggleMuted());
    }
    this.world.step();
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.syncFromBody();

    const lvNow = this.myBody.linvel();
    const horizSpeed = Math.hypot(lvNow.x, lvNow.z);
    if (this.phase === 'racing') {
      const drop = this.prevHorizSpeed - horizSpeed;
      if (drop > COLLISION_DROP_THRESHOLD) {
        this.audio.collision((drop - COLLISION_DROP_THRESHOLD) / COLLISION_DROP_RANGE);
      }
    }
    this.prevHorizSpeed = horizSpeed;

    this.animateOwnCar(FIXED_DT);

    this.updateRaceLogic(); // Task 13
  }

  /** Wheel spin/steer, body tilt, and drift-smoke/turbo-flame emission for the local car. */
  private animateOwnCar(dt: number): void {
    const lv = this.myBody.linvel();
    const fwd = FWD_SCRATCH.set(0, 0, -1).applyQuaternion(this.currQuat);
    fwd.y = 0;
    fwd.normalize();
    const fwdSpeed = lv.x * fwd.x + lv.z * fwd.z;
    const horizSpeed = Math.hypot(lv.x, lv.z);

    const anim = this.myAnim;
    const { wheels, tilt } = anim;
    const spinDelta = (fwdSpeed / WHEEL_RADIUS) * dt;
    if (wheels.fl) wheels.fl.rotation.x += spinDelta;
    if (wheels.fr) wheels.fr.rotation.x += spinDelta;
    if (wheels.bl) wheels.bl.rotation.x += spinDelta;
    if (wheels.br) wheels.br.rotation.x += spinDelta;
    const steerY = this.input.steer * STEER_WHEEL_MAX;
    if (wheels.fl) wheels.fl.rotation.y = steerY;
    if (wheels.fr) wheels.fr.rotation.y = steerY;

    // body tilt from lateral/longitudinal acceleration
    const lateral = LAT_SCRATCH.set(lv.x - anim.prevHorizVel.x, 0, lv.z - anim.prevHorizVel.z);
    const lateralAccel = (lateral.x * -fwd.z + lateral.z * fwd.x) / dt; // component perpendicular to fwd
    const longAccel = (fwdSpeed - anim.fwdSpeed) / dt;
    anim.fwdSpeed = fwdSpeed;
    anim.prevHorizVel.set(lv.x, 0, lv.z);
    const targetRoll = THREE.MathUtils.clamp(-lateralAccel * 0.02, -TILT_ROLL_MAX, TILT_ROLL_MAX);
    const targetPitch = THREE.MathUtils.clamp(longAccel * 0.012, -TILT_PITCH_MAX, TILT_PITCH_MAX);
    const tiltAlpha = Math.min(1, TILT_LERP * dt);
    anim.roll += (targetRoll - anim.roll) * tiltAlpha;
    anim.pitch += (targetPitch - anim.pitch) * tiltAlpha;
    if (tilt) {
      tilt.rotation.z = anim.roll;
      tilt.rotation.x = anim.pitch;
    }

    // drift smoke: own car, handbrake + moving reasonably fast
    if (this.input.handbrake && horizSpeed > 8) {
      for (const w of [wheels.bl, wheels.br]) {
        if (!w) continue;
        w.getWorldPosition(SMOKE_POS);
        SMOKE_VEL.set((Math.random() - 0.5) * 0.6, 1.2 + Math.random() * 0.6, (Math.random() - 0.5) * 0.6);
        SMOKE_VEL.addScaledVector(VEL_SCRATCH.set(lv.x, 0, lv.z), 0.3);
        this.effects.spawn(SMOKE_POS, SMOKE_VEL, 0.7, 0.9, 0x888888);
      }
    }

    // turbo flames: own car
    if (this.turboActive) this.emitTurboFlames(this.currPos, fwd);
  }

  private emitTurboFlames(pos: THREE.Vector3, fwd: THREE.Vector3): void {
    for (let i = 0; i < 6; i++) {
      FLAME_POS.copy(pos).addScaledVector(fwd, -CAR_HALF.z);
      FLAME_POS.x += (Math.random() - 0.5) * 0.4;
      FLAME_POS.y += (Math.random() - 0.5) * 0.2;
      FLAME_VEL.copy(fwd).multiplyScalar(-(4 + Math.random() * 3));
      FLAME_VEL.y += Math.random() * 1.5;
      const color = Math.random() < 0.5 ? 0xff7722 : 0xffcc44;
      this.effects.spawn(FLAME_POS, FLAME_VEL, 0.25, 0.6, color);
    }
  }

  private updateRaceLogic(): void {
    if (this.phase !== 'racing') return;

    // checkpoint crossing
    const next = this.track.checkpoints[this.tracker.nextCp];
    if (next && horizDist(this.currPos, next.pos) < CP_RADIUS) {
      const result = this.tracker.hit(this.tracker.nextCp);
      if (result === 'lap') {
        this.hud.setLap(this.tracker.lap, TOTAL_LAPS);
        this.lapStart = performance.now();
      }
      if (result === 'finish') {
        this.phase = 'done';
        const nowMs = performance.now();
        this.hud.setTimes(nowMs - this.lapStart, nowMs - this.goTime); // freeze final times
        this.hud.setWaiting(true);
        this.hud.setWrongWay(false);
        this.cb.sendFinished(Math.round(nowMs - this.goTime));
        return;
      }
    }

    // wrong-way: moving against the tangent of the nearest checkpoint
    const lv = this.myBody.linvel();
    const speed = Math.hypot(lv.x, lv.z);
    if (speed > 4) {
      let nearest = this.track.checkpoints[0];
      let best = Infinity;
      for (const cp of this.track.checkpoints) {
        const d = horizDist(this.currPos, cp.pos);
        if (d < best) {
          best = d;
          nearest = cp;
        }
      }
      const along = lv.x * nearest.tangent.x + lv.z * nearest.tangent.z;
      this.hud.setWrongWay(along < -3);
    } else {
      this.hud.setWrongWay(false);
    }

    // live position among all cars
    const myScore = progressScore(this.myProgress());
    let rank = 1;
    for (const r of this.remotes.values()) if (progressScore(r.progress) > myScore) rank++;
    this.hud.setPosition(rank, this.remotes.size + 1);
  }

  private myProgress(): Progress {
    const next = this.track.checkpoints[this.tracker.nextCp];
    const dist = next ? horizDist(this.currPos, next.pos) : 0;
    return { passed: this.tracker.passed, dist };
  }

  private netSend(dt: number): void {
    this.sendTimer += dt;
    if (this.sendTimer < 1 / STATE_HZ) return;
    this.sendTimer = 0;
    this.cb.sendState({
      p: this.renderPos.toArray() as [number, number, number],
      q: this.renderQuat.toArray() as [number, number, number, number],
      progress: this.myProgress(),
    });
  }

  private loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;

    this.accumulator += dt;
    while (this.accumulator >= FIXED_DT) {
      this.fixedStep();
      this.accumulator -= FIXED_DT;
    }

    // render-interpolate own car between physics states
    const alpha = this.accumulator / FIXED_DT;
    this.renderPos.lerpVectors(this.prevPos, this.currPos, alpha);
    this.renderQuat.slerpQuaternions(this.prevQuat, this.currQuat, alpha);
    this.myMesh.position.copy(this.renderPos).y -= CAR_HALF.y;
    this.myMesh.quaternion.copy(this.renderQuat);

    // remote cars: interpolate INTERP_DELAY_MS in the past, drive kinematic bodies
    const sampleT = performance.now() - INTERP_DELAY_MS;
    for (const r of this.remotes.values()) {
      if (r.buffer.sample(sampleT, r.mesh.position, r.mesh.quaternion)) {
        r.body.setNextKinematicTranslation({ x: r.mesh.position.x, y: r.mesh.position.y, z: r.mesh.position.z });
        r.body.setNextKinematicRotation(r.mesh.quaternion);
        this.animateRemoteCar(r, dt);
        r.mesh.position.y -= CAR_HALF.y;
      }
    }
    this.effects.update(dt);

    const lv = this.myBody.linvel();
    const speed = Math.hypot(lv.x, lv.z);
    this.hud.setSpeed(speed);
    if (this.phase === 'racing') this.hud.setTimes(now - this.lapStart, now - this.goTime);
    this.hud.updateMinimap(
      { x: this.renderPos.x, z: this.renderPos.z },
      [...this.remotes.values()].map((r) => ({ x: r.mesh.position.x, z: r.mesh.position.z })),
    );
    this.chase.update(this.renderPos, this.renderQuat, speed, dt, false); // Task 4 sets real turbo flag
    this.audio.engine(speed / MAX_SPEED, false); // Task 4: turbo
    this.audio.crowd(0); // Task 5: real proximity via setCrowdSources + nearest-stand distance
    if (this.phase === 'racing') this.netSend(dt);
    this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);
  };

  /** Wheel spin/steer estimate + turbo flames for a remote car, driven by interpolated position deltas. */
  private animateRemoteCar(r: RemoteCar, dt: number): void {
    if (dt <= 0) return;
    REMOTE_DELTA.set(r.mesh.position.x - r.prevPos.x, 0, r.mesh.position.z - r.prevPos.z);
    r.prevPos.copy(r.mesh.position);
    REMOTE_FWD.set(0, 0, -1).applyQuaternion(r.mesh.quaternion);
    REMOTE_FWD.y = 0;
    REMOTE_FWD.normalize();
    const rawSpeed = REMOTE_DELTA.length() / dt;
    const signed = (REMOTE_DELTA.x * REMOTE_FWD.x + REMOTE_DELTA.z * REMOTE_FWD.z) / dt >= 0 ? rawSpeed : -rawSpeed;
    r.anim.fwdSpeed += (signed - r.anim.fwdSpeed) * 0.2;

    const { wheels, tilt } = r.anim;
    const spinDelta = (r.anim.fwdSpeed / WHEEL_RADIUS) * dt;
    if (wheels.fl) wheels.fl.rotation.x += spinDelta;
    if (wheels.fr) wheels.fr.rotation.x += spinDelta;
    if (wheels.bl) wheels.bl.rotation.x += spinDelta;
    if (wheels.br) wheels.br.rotation.x += spinDelta;
    // remotes: no steer signal available over the wire, front wheels stay centered

    // body tilt: heavily smoothed, half amplitude, driven off the same speed-delta signal
    const targetPitch = THREE.MathUtils.clamp((r.anim.fwdSpeed - r.anim.prevSpeedEstimate) * 0.006, -TILT_PITCH_MAX / 2, TILT_PITCH_MAX / 2);
    r.anim.prevSpeedEstimate = r.anim.fwdSpeed;
    const alpha = Math.min(1, (TILT_LERP / 2) * dt);
    r.anim.pitch += (targetPitch - r.anim.pitch) * alpha;
    if (tilt) tilt.rotation.x = r.anim.pitch;

    if (r.turboActive) this.emitTurboFlames(r.mesh.position, REMOTE_FWD);
  }
}

function horizDist(a: THREE.Vector3, b: THREE.Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.hypot(dx, dz);
}

