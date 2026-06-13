import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CarState, PlayerInfo, Progress, STATE_HZ, TOTAL_LAPS } from '../../../shared/src/protocol';
import { SnapshotBuffer } from '../net/interpolation';
import { Hud } from '../ui/hud';
import { ChaseCamera } from './camera';
import { instantiateCar } from './cars';
import { Input } from './input';
import { CAR_HALF, createLocalCar, createRemoteCar, createWorld, driveCar, freezeCar, initRapier } from './physics';
import { CheckpointTracker } from './raceLogic';
import { createScene, SceneCtx } from './scene';
import { buildTrack, curve, gridPose, ROAD_WIDTH, TrackData } from './track';

const FIXED_DT = 1 / 60;
const INTERP_DELAY_MS = 120;
const CP_RADIUS = ROAD_WIDTH * 0.75;

export interface GameCallbacks {
  sendState: (state: CarState) => void;
  sendFinished: (timeMs: number) => void;
}

interface RemoteCar {
  mesh: THREE.Group;
  body: RAPIER.RigidBody;
  buffer: SnapshotBuffer;
  progress: Progress;
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

    for (const p of players) {
      const mesh = await instantiateCar(p.car);
      const { pos, yaw } = gridPose(grid[p.id] ?? 0);
      if (p.id === selfId) {
        game.myMesh = mesh;
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
        game.remotes.set(p.id, { mesh, body, buffer: new SnapshotBuffer(), progress: { passed: 0, dist: 0 } });
      }
      game.ctx.scene.add(mesh);
    }
    return game;
  }

  start(countdownMs: number): void {
    this.hud.show();
    this.hud.setLap(1, TOTAL_LAPS);
    this.goTime = performance.now() + countdownMs;
    const tick = () => {
      if (this.phase !== 'countdown') return;
      const left = this.goTime - performance.now();
      if (left <= 0) {
        this.phase = 'racing';
        this.lapStart = this.goTime;
        this.hud.setCountdown('GO!');
        setTimeout(() => this.hud.setCountdown(null), 800);
      } else {
        this.hud.setCountdown(`${Math.ceil(left / 1000)}`);
        setTimeout(tick, 100);
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
  }

  onPlayerLeft(id: string): void {
    const r = this.remotes.get(id);
    if (!r) return;
    this.ctx.scene.remove(r.mesh);
    this.world.removeRigidBody(r.body);
    this.remotes.delete(id);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.input.dispose();
    this.hud.hide();
    this.ctx.dispose();
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
    this.world.step();
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.syncFromBody();
    this.updateRaceLogic(); // Task 13
  }

  private updateRaceLogic(): void {
    // filled in by Task 13
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
        r.mesh.position.y -= CAR_HALF.y;
      }
    }

    const lv = this.myBody.linvel();
    const speed = Math.hypot(lv.x, lv.z);
    this.hud.setSpeed(speed);
    if (this.phase === 'racing') this.hud.setTimes(now - this.lapStart, now - this.goTime);
    this.hud.updateMinimap(
      { x: this.renderPos.x, z: this.renderPos.z },
      [...this.remotes.values()].map((r) => ({ x: r.mesh.position.x, z: r.mesh.position.z })),
    );
    this.chase.update(this.renderPos, this.renderQuat, speed, dt);
    if (this.phase === 'racing') this.netSend(dt);
    this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);
  };
}

function horizDist(a: THREE.Vector3, b: THREE.Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.hypot(dx, dz);
}

// suppress unused variable warning for CP_RADIUS (used by Task 13)
void CP_RADIUS;
