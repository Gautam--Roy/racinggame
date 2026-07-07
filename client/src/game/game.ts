import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CAR_STATS, CarState, DEFAULT_LAPS, PlayerInfo, Progress, progressScore, STATE_HZ } from '../../../shared/src/protocol';
import { SnapshotBuffer } from '../net/interpolation';
import { Hud } from '../ui/hud';
import { AudioManager } from './audio';
import { BLIP_STRENGTH, GearBox, gearTorque, GearState } from './gears';
import { ChaseCamera } from './camera';
import { instantiateCar } from './cars';
import { Input } from './input';
import {
  CAR_HALF,
  createLocalCar,
  createRemoteCar,
  createWorld,
  driveCar,
  DRIFT_ENTER_STEER,
  DRIFT_EXIT_STEER,
  DRIFT_SPEED_THRESHOLD,
  freezeCar,
  initRapier,
  MAX_SPEED,
} from './physics';
import { CheckpointTracker } from './raceLogic';
import { createScene, SceneCtx } from './scene';
import { buildTrack, curve, gridPose, ROAD_WIDTH, TrackData } from './track';
import { findTiltTarget, findWheels, prepareWheels, Wheels } from './cars';
import { Effects } from './effects';
import { buildPickups, Pickups, slipstreamTarget } from './pickups';
import { buildSpectators, Spectators } from './spectators';
import { buildDressing, Dressing } from './dressing';

const FIXED_DT = 1 / 60;
const INTERP_DELAY_MS = 120;
const CP_RADIUS = ROAD_WIDTH * 0.75;
const COLLISION_DROP_THRESHOLD = 6; // m/s
const COLLISION_DROP_RANGE = 12; // m/s, maps drop above threshold to intensity 0..1
const WHEEL_RADIUS = 0.34; // m, approx across all car models
const STEER_WHEEL_MAX = 0.45; // rad, front wheel yaw at full steer (parked); scaled down with speed
const TILT_LERP = 8; // 1/s
const TILT_ROLL_MAX = 0.045; // rad
const TILT_PITCH_MAX = 0.06; // rad

// F1-style start lights: emissive colors per phase, GO hold duration before dimming to off.
const LIGHT_RED = 0xff2211;
const LIGHT_YELLOW = 0xffaa00;
const LIGHT_GREEN = 0x22ff44;
const LIGHT_OFF_EMISSIVE = 0x000000;
const LIGHT_OFF_COLOR = 0x220000;
const LIGHT_ON_INTENSITY = 2;
const GO_HOLD_MS = 1200;

/** Per-car visual animation state: wheel spin/steer, body tilt, smoothed accel estimates. */
interface CarAnim {
  wheels: Wheels;
  steer: { left?: THREE.Group; right?: THREE.Group };
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
  // Insert steering pivots on this instantiated (already-cloned) car only — never on the shared template.
  const steer = prepareWheels(wheels);
  return {
    wheels,
    steer,
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
const OWN_FWD_SCRATCH = new THREE.Vector3();
const CAM_VEL_SCRATCH = new THREE.Vector3();
const DRIFT_FWD_SCRATCH = new THREE.Vector3();
const DRIFT_VEL_SCRATCH = new THREE.Vector3();

const TURBO_DURATION_MS = 2500;
const TURBO_MAX_CHARGES = 2;
const PICKUP_RADIUS = 3; // m
const SLIP_LERP = 1.2; // 1/s

export interface GameCallbacks {
  sendState: (state: CarState) => void;
  sendFinished: (timeMs: number) => void;
  sendHorn: () => void;
  sendPickup: (idx: number) => void;
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
  private laps = DEFAULT_LAPS;
  private stats: { speed: number; accel: number } = { speed: 1, accel: 1 };
  private tracker = new CheckpointTracker(0, DEFAULT_LAPS); // re-created with real cp count/laps in create()
  private remotes = new Map<string, RemoteCar>();
  readonly audio = new AudioManager();
  private prevHorizSpeed = 0;
  private lastScreechAt = 0;
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
  readonly effects = new Effects();
  private pickups!: Pickups;
  private spectators!: Spectators;
  private dressing!: Dressing;
  private readonly carPosScratch: THREE.Vector3[] = [];
  private charges = 0;
  private turboUntil = 0;
  private slipBonus = 0;
  private prevTurboActive = false;
  private readonly slipScratch: THREE.Vector3[] = [];
  /** Hysteresis-owned drift state for the LOCAL car — single source of truth for both physics grip/oversteer and smoke/camera visuals. */
  private drifting = false;
  /** Continuous 0..1 ramp toward (drifting ? 1 : 0), ~200ms time constant, so grip/oversteer engage
   * smoothly instead of snapping the instant the `drifting` hysteresis flag flips. */
  private driftAmount = 0;
  private gearbox = new GearBox();
  private gearState: GearState = { rpm: 0.22, gear: 1, shiftDip: 0, blip: 0 };
  /** Overall speed/MAX_SPEED, computed alongside gearState in fixedStep; fed into audio.engine()
   * (rendered from the rAF loop, not fixedStep) so pitch/crossfade/wind/roll all carry a genuine
   * monotonic speed cue on top of the per-gear rpm sawtooth. */
  private speedRatio = 0;


  private get turboActive(): boolean {
    return performance.now() < this.turboUntil;
  }

  private constructor(
    private readonly selfId: string,
    private readonly cb: GameCallbacks,
  ) {}

  static async create(
    canvas: HTMLCanvasElement,
    selfId: string,
    players: PlayerInfo[],
    grid: Record<string, number>,
    laps: number,
    cb: GameCallbacks,
  ): Promise<Game> {
    await initRapier();
    const game = new Game(selfId, cb);
    game.laps = laps;
    game.ctx = createScene(canvas);
    game.track = buildTrack();
    game.ctx.scene.add(game.track.group);
    game.world = createWorld(game.track.barriers);
    game.tracker = new CheckpointTracker(game.track.checkpoints.length, laps);
    game.chase = new ChaseCamera(game.ctx.camera);

    const mapPts: { x: number; z: number }[] = [];
    for (let i = 0; i < 128; i++) {
      const p = curve.getPointAt(i / 128);
      mapPts.push({ x: p.x, z: p.z });
    }
    game.hud.initMinimap(mapPts);
    game.hud.onMuteClick = () => game.hud.setMuted(game.audio.toggleMuted());
    game.ctx.scene.add(game.effects.smoke.points);
    game.ctx.scene.add(game.effects.flame.points);
    game.pickups = buildPickups(game.ctx.scene, curve);
    game.spectators = await buildSpectators(curve);
    game.ctx.scene.add(game.spectators.group);
    game.audio.setCrowdSources(game.spectators.stands);
    game.dressing = buildDressing(curve);
    game.ctx.scene.add(game.dressing.group);

    for (const p of players) {
      const mesh = await instantiateCar(p.car);
      const { pos, yaw } = gridPose(grid[p.id] ?? 0);
      if (p.id === selfId) {
        game.stats = CAR_STATS[p.car];
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
    this.hud.setLap(1, this.laps);
    this.goTime = performance.now() + countdownMs;
    const tick = () => {
      if (this.disposed || this.phase !== 'countdown') return;
      const left = this.goTime - performance.now();
      if (left <= 0) {
        this.phase = 'racing';
        this.lapStart = this.goTime;
        this.hud.setCountdown('GO!');
        this.audio.countdownBeep(true);
        this.setStartLights('green');
        this.countdownTimer = setTimeout(() => this.hud.setCountdown(null), 800);
        setTimeout(() => this.setStartLights('off'), GO_HOLD_MS);
      } else {
        const text = `${Math.ceil(left / 1000)}`;
        this.hud.setCountdown(text);
        if (text !== this.lastCountdownText) {
          this.lastCountdownText = text;
          this.audio.countdownBeep(false);
        }
        // Map remaining time to a 3-2-1 light phase using the FRACTION of countdownMs elapsed,
        // so this works for both the 3s multiplayer countdown and the 1.5s practice countdown.
        const phase = Math.ceil((left / countdownMs) * 3);
        this.setStartLights(phase >= 3 ? 'red' : 'yellow');
        this.countdownTimer = setTimeout(tick, 100);
      }
    };
    tick();
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Drives the F1-style start-light rig exposed by TrackData. All 5 discs share a phase. */
  private setStartLights(phase: 'red' | 'yellow' | 'green' | 'off'): void {
    const lights = this.track.startLights;
    let emissive = LIGHT_OFF_EMISSIVE;
    let intensity = 0;
    if (phase === 'red') emissive = LIGHT_RED;
    else if (phase === 'yellow') emissive = LIGHT_YELLOW;
    else if (phase === 'green') emissive = LIGHT_GREEN;
    if (phase !== 'off') intensity = LIGHT_ON_INTENSITY;
    for (const mat of lights) {
      mat.emissive.setHex(emissive);
      mat.emissiveIntensity = intensity;
      mat.color.setHex(LIGHT_OFF_COLOR);
    }
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
    this.setStartLights('off');
    this.input.dispose();
    this.hud.hide();
    this.hud.dispose();
    this.audio.dispose();
    this.ctx.scene.remove(this.effects.smoke.points);
    this.ctx.scene.remove(this.effects.flame.points);
    this.effects.dispose();
    for (const mesh of this.pickups.meshes) this.ctx.scene.remove(mesh);
    this.pickups.meshes[0]?.geometry.dispose();
    const mat = this.pickups.meshes[0]?.material;
    if (mat && !Array.isArray(mat)) mat.dispose();
    this.ctx.scene.remove(this.spectators.group);
    this.spectators.dispose();
    this.ctx.scene.remove(this.dressing.group);
    this.dressing.dispose();
    this.ctx.dispose();
  }

  /** Called by main.ts when a remote's horn ServerMsg arrives; louder when they're closer. */
  onHorn(id: string): void {
    const r = this.remotes.get(id);
    if (!r) return;
    const dist = horizDist(this.currPos, r.mesh.position);
    this.audio.horn(Math.min(1, dist / 120));
  }

  /** Called by main.ts when a remote's pickup ServerMsg arrives; mirror their board state locally. */
  onPickup(idx: number, _id: string): void {
    this.pickups.board.take(idx, performance.now());
  }

  private syncFromBody(): void {
    const t = this.myBody.translation();
    const r = this.myBody.rotation();
    this.currPos.set(t.x, t.y, t.z);
    this.currQuat.set(r.x, r.y, r.z, r.w);
  }

  private fixedStep(): void {
    this.input.update(FIXED_DT);
    if (this.phase === 'racing') {
      // Drift hysteresis: compute the CURRENT forward speed from the body's pre-step state (same
      // pattern driveCar uses internally) so the enter/exit decision reflects reality, not last frame.
      // Enter at |steer| > DRIFT_ENTER_STEER (see isDrifting/handbrake); exit only once handbrake is
      // released AND either steer has come back under DRIFT_EXIT_STEER or speed has dropped off —
      // this hysteresis band is what stops the drift flag flickering right at the boundary.
      const r = this.myBody.rotation();
      DRIFT_FWD_SCRATCH.set(0, 0, -1).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
      DRIFT_FWD_SCRATCH.y = 0;
      DRIFT_FWD_SCRATCH.normalize();
      const lv0 = this.myBody.linvel();
      DRIFT_VEL_SCRATCH.set(lv0.x, 0, lv0.z);
      const fwdSpeedNow = DRIFT_VEL_SCRATCH.dot(DRIFT_FWD_SCRATCH);
      const absSteer = Math.abs(this.input.steer);
      if (!this.drifting) {
        this.drifting =
          this.input.handbrake || (absSteer > DRIFT_ENTER_STEER && Math.abs(fwdSpeedNow) > DRIFT_SPEED_THRESHOLD);
      } else if (!this.input.handbrake && (absSteer < DRIFT_EXIT_STEER || Math.abs(fwdSpeedNow) < 12)) {
        this.drifting = false;
      }

      const driftTarget = this.drifting ? 1 : 0;
      this.driftAmount += (driftTarget - this.driftAmount) * (1 - Math.exp(-5 * FIXED_DT));
      const speedRatio = Math.abs(fwdSpeedNow) / (MAX_SPEED * this.stats.speed);
      this.speedRatio = speedRatio;
      this.gearState = this.gearbox.update(speedRatio, FIXED_DT);
      const gearFactor =
        gearTorque(this.gearState.rpm) * (1 - 0.65 * this.gearState.shiftDip) * (1 + BLIP_STRENGTH * this.gearState.blip);
      driveCar(this.myBody, this.input, FIXED_DT, {
        turbo: this.turboActive,
        slipBonus: this.slipBonus,
        drifting: this.drifting,
        driftAmount: this.driftAmount,
        stats: this.stats,
        gearFactor,
      });
      this.updateTurbo();
    } else {
      freezeCar(this.myBody);
    }
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

  /** Pickup overlap/collection, Shift-to-boost, and slipstream draft — all local-first, mirrored over the wire. */
  private updateTurbo(): void {
    const now = performance.now();

    for (let i = 0; i < this.pickups.meshes.length; i++) {
      if (!this.pickups.board.available(i, now)) continue;
      const mesh = this.pickups.meshes[i];
      if (horizDist(this.currPos, mesh.position) < PICKUP_RADIUS) {
        if (this.pickups.board.take(i, now)) {
          this.cb.sendPickup(i);
          this.charges = Math.min(this.charges + 1, TURBO_MAX_CHARGES);
          this.audio.turboWhoosh(0.5);
          this.hud.setTurbo(this.charges, this.turboActive);
        }
      }
    }

    if (this.input.turboPressed && this.charges > 0) {
      this.charges--;
      this.turboUntil = now + TURBO_DURATION_MS;
      this.audio.turboWhoosh();
      this.hud.setTurbo(this.charges, this.turboActive);
    }

    OWN_FWD_SCRATCH.set(0, 0, -1).applyQuaternion(this.currQuat);
    OWN_FWD_SCRATCH.y = 0;
    OWN_FWD_SCRATCH.normalize();
    const lv = this.myBody.linvel();
    const speed = Math.hypot(lv.x, lv.z);
    this.slipScratch.length = 0;
    for (const r of this.remotes.values()) this.slipScratch.push(r.mesh.position);
    const target = slipstreamTarget(this.currPos, OWN_FWD_SCRATCH, speed, this.slipScratch);
    this.slipBonus += (target - this.slipBonus) * Math.min(1, SLIP_LERP * FIXED_DT);

    const turboActive = this.turboActive;
    if (this.prevTurboActive && !turboActive) {
      this.hud.setTurbo(this.charges, false);
    }
    this.prevTurboActive = turboActive;
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
    const { wheels, steer, tilt } = anim;
    const spinDelta = (fwdSpeed / WHEEL_RADIUS) * dt;
    if (wheels.fl) wheels.fl.rotation.x += spinDelta;
    if (wheels.fr) wheels.fr.rotation.x += spinDelta;
    if (wheels.bl) wheels.bl.rotation.x += spinDelta;
    if (wheels.br) wheels.br.rotation.x += spinDelta;
    // Speed-sensitive steering visual: full lock (~26°) when parked, tapering to ~10° at MAX_SPEED —
    // matches how a real car's front wheels appear to turn less sharply at speed.
    const steerY = this.input.steer * STEER_WHEEL_MAX * (1 - 0.6 * Math.min(1, horizSpeed / MAX_SPEED));
    if (steer.left) steer.left.rotation.y = steerY;
    if (steer.right) steer.right.rotation.y = steerY;

    // body tilt from lateral/longitudinal acceleration
    const lateral = LAT_SCRATCH.set(lv.x - anim.prevHorizVel.x, 0, lv.z - anim.prevHorizVel.z);
    const lateralAccel = (lateral.x * -fwd.z + lateral.z * fwd.x) / dt; // component perpendicular to fwd
    const longAccel = (fwdSpeed - anim.fwdSpeed) / dt;
    anim.fwdSpeed = fwdSpeed;
    anim.prevHorizVel.set(lv.x, 0, lv.z);
    // Body leans AWAY from the corner center (outward), like a real car under lateral G — verified
    // empirically with a temporary probe during development (see commit history for the readings).
    const targetRoll = THREE.MathUtils.clamp(-lateralAccel * 0.01, -TILT_ROLL_MAX, TILT_ROLL_MAX);
    const targetPitch = THREE.MathUtils.clamp(longAccel * 0.012, -TILT_PITCH_MAX, TILT_PITCH_MAX);
    const tiltAlpha = Math.min(1, TILT_LERP * dt);
    anim.roll += (targetRoll - anim.roll) * tiltAlpha;
    anim.pitch += (targetPitch - anim.pitch) * tiltAlpha;
    if (tilt) {
      tilt.rotation.z = anim.roll;
      tilt.rotation.x = anim.pitch;
    }

    // drift smoke: own car, using the same hysteresis flag that drives the physics grip/oversteer,
    // so the visual slide and the actual physics slide are always the same source of truth.
    if (this.drifting && horizSpeed > 8) {
      for (const w of [wheels.bl, wheels.br]) {
        if (!w) continue;
        for (let i = 0; i < 3; i++) {
          w.getWorldPosition(SMOKE_POS);
          SMOKE_POS.y = 0.1;
          SMOKE_VEL.set((Math.random() - 0.5) * 1.0, 0.4 + Math.random() * 0.6, (Math.random() - 0.5) * 1.0);
          SMOKE_VEL.addScaledVector(VEL_SCRATCH.set(lv.x, 0, lv.z), 0.4);
          const life = 0.9 + Math.random() * 0.4;
          this.effects.spawnSmoke(SMOKE_POS, SMOKE_VEL, life);
        }
      }
      const nowMs = performance.now();
      if (nowMs - this.lastScreechAt > 180) {
        this.lastScreechAt = nowMs;
        this.audio.tireScreech();
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
      this.effects.flame.spawn(FLAME_POS, FLAME_VEL, 0.25, 0.6, color);
    }
  }

  private updateRaceLogic(): void {
    if (this.phase !== 'racing') return;

    // checkpoint crossing
    const next = this.track.checkpoints[this.tracker.nextCp];
    if (next && horizDist(this.currPos, next.pos) < CP_RADIUS) {
      const result = this.tracker.hit(this.tracker.nextCp);
      if (result === 'lap') {
        this.hud.setLap(this.tracker.lap, this.laps);
        this.lapStart = performance.now();
      }
      if (result === 'finish') {
        this.phase = 'done';
        const nowMs = performance.now();
        this.hud.setTimes(nowMs - this.lapStart, nowMs - this.goTime); // freeze final times
        this.hud.setWaiting(true);
        this.hud.setWrongWay(false);
        this.turboUntil = 0;
        this.hud.setTurbo(this.charges, false);
        this.cb.sendState(this.buildState()); // final state so remotes see turbo off
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

  private buildState(): CarState {
    const state: CarState = {
      p: this.renderPos.toArray() as [number, number, number],
      q: this.renderQuat.toArray() as [number, number, number, number],
      progress: this.myProgress(),
    };
    if (this.turboActive) state.b = true; // omit when false to keep payloads lean
    return state;
  }

  private netSend(dt: number): void {
    this.sendTimer += dt;
    if (this.sendTimer < 1 / STATE_HZ) return;
    this.sendTimer = 0;
    this.cb.sendState(this.buildState());
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
    this.pickups.update(now, dt);
    this.ctx.cloudGroup.rotation.y += 0.0015 * dt;
    this.ctx.sky.position.copy(this.ctx.camera.position);

    this.carPosScratch.length = 0;
    this.carPosScratch.push(this.renderPos);
    for (const r of this.remotes.values()) this.carPosScratch.push(r.mesh.position);
    this.spectators.update(now / 1000, this.carPosScratch);

    const lv = this.myBody.linvel();
    const speed = Math.hypot(lv.x, lv.z);
    this.hud.setSpeed(speed);
    if (this.phase === 'racing') this.hud.setTimes(now - this.lapStart, now - this.goTime);
    this.hud.updateMinimap(
      { x: this.renderPos.x, z: this.renderPos.z },
      [...this.remotes.values()].map((r) => ({ x: r.mesh.position.x, z: r.mesh.position.z })),
    );
    CAM_VEL_SCRATCH.set(lv.x, lv.y, lv.z);
    this.chase.update(this.renderPos, this.renderQuat, CAM_VEL_SCRATCH, speed, this.input.steer, dt, this.turboActive, this.drifting);
    this.audio.engine(this.gearState, this.speedRatio, this.turboActive);
    // crowd proximity is owned here (game.ts): nearest-stand distance from the own car,
    // rather than inside AudioManager, since Game already tracks car/stand world positions.
    let nearestStandDist = Infinity;
    for (const s of this.spectators.stands) {
      const d = horizDist(this.renderPos, s);
      if (d < nearestStandDist) nearestStandDist = d;
    }
    this.audio.crowd(1 - Math.min(1, Math.max(0, nearestStandDist / 140)));
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
