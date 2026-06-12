# 4-Player Browser Racing Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser-based 3D racing game where up to 4 players join a lobby by room code, pick cars, and race 3 laps on a circuit with physical player-vs-player collisions, a speed/lap/position HUD, and host-controlled race start.

**Architecture:** Vanilla Three.js + Rapier (WASM) client simulates its own car with arcade-tuned physics for zero input latency; a Node.js `ws` relay server manages lobbies and rebroadcasts car state at 20 Hz; remote cars are interpolated 120 ms in the past and represented as kinematic colliders so bumping them physically shoves the local car. Spec: `docs/superpowers/specs/2026-06-12-multiplayer-racing-game-design.md`.

**Tech Stack:** TypeScript, Vite, Three.js, `@dimforge/rapier3d-compat`, Node.js + `ws`, Vitest, `tsx`.

**File map (final state):**

```
racinggame/
├── package.json / tsconfig.json / vite.config.ts / .gitignore / README.md
├── shared/src/protocol.ts          # message types + progressScore (both sides import this)
├── server/
│   ├── src/lobby.ts                # Room + LobbyManager state machine (pure, tested)
│   ├── src/server.ts               # ws wiring: relay, countdown, results collation
│   ├── src/index.ts                # entry point
│   └── test/lobby.test.ts
├── scripts/bots.ts                 # 4 headless bots: lobby → race → results e2e
└── client/
    ├── index.html
    ├── public/models/cars/*.glb    # 4 CC0 car models
    ├── test/{interpolation,raceLogic}.test.ts
    └── src/
        ├── main.ts                 # boot + screen flow + socket routing
        ├── net/socket.ts           # WebSocket client wrapper
        ├── net/interpolation.ts    # SnapshotBuffer (pure, tested)
        ├── game/scene.ts           # renderer, lights, fog, resize
        ├── game/track.ts           # spline circuit, barriers, checkpoints, grid
        ├── game/cars.ts            # glTF loading + fallback car
        ├── game/physics.ts         # Rapier world + arcade car controller
        ├── game/input.ts           # keyboard with smoothed steering
        ├── game/camera.ts          # chase camera
        ├── game/raceLogic.ts       # CheckpointTracker (pure, tested)
        ├── game/game.ts            # game loop orchestrator
        └── ui/{screens.ts, hud.ts, style.css}
```

Conventions used throughout: forward is **−Z** in model/body space; `yaw` such that `forward = (−sin yaw, 0, −cos yaw)`; 1 unit = 1 meter; physics fixed step 60 Hz; net send 20 Hz.

---

### Task 1: Project scaffolding & tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore`

- [ ] **Step 1: Install dependencies and create configs**

```bash
cd /home/gautam/Projects/racinggame
npm init -y
npm pkg set type=module private=true \
  scripts.dev=vite scripts.server="tsx server/src/index.ts" \
  scripts.test="vitest run" scripts.bots="tsx scripts/bots.ts"
npm i three @dimforge/rapier3d-compat ws
npm i -D typescript vite vitest tsx @types/three @types/ws
mkdir -p shared/src server/src server/test client/src client/public scripts
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM"],
    "types": ["vite/client"]
  },
  "include": ["client/src", "client/test", "server/src", "server/test", "shared/src", "scripts"]
}
```

Create `vite.config.ts`:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  server: { port: 5173 },
});
```

Create `.gitignore`:

```
node_modules/
client/dist/
*.log
```

- [ ] **Step 2: Verify toolchain**

Run: `npx tsc --noEmit && npx vitest run --passWithNoTests`
Expected: tsc exits 0; vitest reports "No test files found" and exits 0.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: scaffold project tooling (vite, vitest, tsx, three, rapier, ws)"
```

---

### Task 2: Shared protocol module

**Files:**
- Create: `shared/src/protocol.ts`
- Test: `client/test/raceLogic.test.ts` is later; `progressScore` gets a quick test here in `server/test/lobby.test.ts`'s file later — for now verify by typecheck only.

- [ ] **Step 1: Write `shared/src/protocol.ts`**

```ts
export const MAX_PLAYERS = 4;
export const TOTAL_LAPS = 3;
export const STATE_HZ = 20;

export const CAR_MODELS = ['race', 'race-future', 'sedan-sports', 'suv'] as const;
export type CarModel = (typeof CAR_MODELS)[number];

export interface PlayerInfo {
  id: string;
  name: string;
  car: CarModel;
  isHost: boolean;
}

/** Race progress. `passed` = total checkpoints crossed since GO (monotonic). */
export interface Progress {
  passed: number;
  dist: number; // meters to next checkpoint
}

/** Higher = further along the race. Used identically by client ranking and server standings. */
export function progressScore(pr: Progress): number {
  return pr.passed * 1e4 - Math.min(pr.dist, 9999);
}

export interface CarState {
  p: [number, number, number];
  q: [number, number, number, number];
  progress: Progress;
}

export interface Standing {
  id: string;
  name: string;
  timeMs: number | null; // null = did not finish (ranked by progress)
}

export type ClientMsg =
  | { type: 'create'; name: string }
  | { type: 'join'; code: string; name: string }
  | { type: 'pickCar'; car: CarModel }
  | { type: 'start' }
  | { type: 'state'; state: CarState }
  | { type: 'finished'; timeMs: number };

export type ServerMsg =
  | { type: 'created'; code: string; selfId: string; players: PlayerInfo[] }
  | { type: 'joined'; code: string; selfId: string; players: PlayerInfo[] }
  | { type: 'error'; message: string }
  | { type: 'lobby'; players: PlayerInfo[] }
  | { type: 'countdown'; countdownMs: number; grid: Record<string, number> }
  | { type: 'state'; id: string; state: CarState }
  | { type: 'playerLeft'; id: string }
  | { type: 'results'; standings: Standing[] };
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: shared client/server message protocol and progress scoring"
```

---

### Task 3: Server lobby & room state machine (TDD)

**Files:**
- Create: `server/src/lobby.ts`
- Test: `server/test/lobby.test.ts`

- [ ] **Step 1: Write the failing tests**

`server/test/lobby.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LobbyManager, Room } from '../src/lobby';

const seq = (...vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

describe('LobbyManager', () => {
  it('creates a room with a 4-letter code and the creator as host', () => {
    const lm = new LobbyManager(seq(0));
    const room = lm.create('p1', 'Ava');
    expect(room.code).toMatch(/^[A-Z]{4}$/);
    expect(room.players).toHaveLength(1);
    expect(room.players[0]).toMatchObject({ id: 'p1', name: 'Ava', isHost: true });
  });

  it('joins an existing room (case-insensitive code)', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'Ava');
    expect(lm.join(room.code.toLowerCase(), 'p2', 'Ben')).toBe(room);
    expect(room.players.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(room.players[1].isHost).toBe(false);
  });

  it('rejects joining an unknown room', () => {
    const lm = new LobbyManager();
    expect(() => lm.join('ZZZZ', 'p1', 'Ava')).toThrow('Room not found');
  });

  it('rejects a 5th player', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    for (const id of ['p2', 'p3', 'p4']) lm.join(room.code, id, id);
    expect(() => lm.join(room.code, 'p5', 'E')).toThrow('Lobby full');
  });

  it('rejects joining a started race', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    expect(room.start('p1')).toBe(true);
    expect(() => lm.join(room.code, 'p2', 'B')).toThrow('Race already started');
  });

  it('assigns each joiner a distinct default car', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    lm.join(room.code, 'p2', 'B');
    lm.join(room.code, 'p3', 'C');
    const cars = room.players.map((p) => p.car);
    expect(new Set(cars).size).toBe(3);
  });

  it('car picks are exclusive within a room', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    lm.join(room.code, 'p2', 'B');
    const p2car = room.players[1].car;
    expect(room.pickCar('p1', p2car)).toBe(false);
    expect(room.pickCar('p1', 'suv')).toBe(true);
    expect(room.players[0].car).toBe('suv');
  });

  it('only the host can start, and only from the lobby phase', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    lm.join(room.code, 'p2', 'B');
    expect(room.start('p2')).toBe(false);
    expect(room.start('p1')).toBe(true);
    expect(room.phase).toBe('racing');
    expect(room.start('p1')).toBe(false);
  });

  it('promotes the next player when the host leaves; deletes empty rooms', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    lm.join(room.code, 'p2', 'B');
    expect(lm.leave(room.code, 'p1')).toBe(room);
    expect(room.players[0]).toMatchObject({ id: 'p2', isHost: true });
    expect(lm.leave(room.code, 'p2')).toBeNull();
    expect(() => lm.join(room.code, 'p9', 'X')).toThrow('Room not found');
  });

  it('truncates long names and defaults empty names', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'x'.repeat(50));
    expect(room.players[0].name).toHaveLength(16);
    lm.join(room.code, 'p2', '');
    expect(room.players[1].name).toBe('Player');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/test/lobby.test.ts`
Expected: FAIL — cannot resolve `../src/lobby`.

- [ ] **Step 3: Implement `server/src/lobby.ts`**

```ts
import {
  CAR_MODELS,
  CarModel,
  MAX_PLAYERS,
  PlayerInfo,
  Progress,
  progressScore,
  Standing,
} from '../../shared/src/protocol';

export type Phase = 'lobby' | 'racing';

export interface Player {
  id: string;
  name: string;
  car: CarModel;
  isHost: boolean;
}

export class Room {
  phase: Phase = 'lobby';
  players: Player[] = [];
  finishes = new Map<string, number>();
  progress = new Map<string, Progress>();

  constructor(public readonly code: string) {}

  addPlayer(id: string, name: string): Player {
    if (this.phase !== 'lobby') throw new Error('Race already started');
    if (this.players.length >= MAX_PLAYERS) throw new Error('Lobby full');
    const used = new Set(this.players.map((p) => p.car));
    const car = CAR_MODELS.find((c) => !used.has(c))!;
    const player: Player = {
      id,
      name: name.trim().slice(0, 16) || 'Player',
      car,
      isHost: this.players.length === 0,
    };
    this.players.push(player);
    return player;
  }

  removePlayer(id: string): void {
    const wasHost = this.players.find((p) => p.id === id)?.isHost ?? false;
    this.players = this.players.filter((p) => p.id !== id);
    if (wasHost && this.players.length > 0) this.players[0].isHost = true;
  }

  pickCar(id: string, car: CarModel): boolean {
    if (this.phase !== 'lobby' || !CAR_MODELS.includes(car)) return false;
    if (this.players.some((p) => p.car === car && p.id !== id)) return false;
    const player = this.players.find((p) => p.id === id);
    if (!player) return false;
    player.car = car;
    return true;
  }

  start(byId: string): boolean {
    if (this.phase !== 'lobby') return false;
    if (!this.players.find((p) => p.id === byId)?.isHost) return false;
    this.phase = 'racing';
    return true;
  }

  resetToLobby(): void {
    this.phase = 'lobby';
    this.finishes.clear();
    this.progress.clear();
  }

  recordProgress(id: string, pr: Progress): void {
    this.progress.set(id, pr);
  }

  recordFinish(id: string, timeMs: number): void {
    if (this.phase === 'racing' && !this.finishes.has(id)) this.finishes.set(id, timeMs);
  }

  get allFinished(): boolean {
    return this.players.length > 0 && this.players.every((p) => this.finishes.has(p.id));
  }

  standings(): Standing[] {
    const score = (id: string) => {
      const pr = this.progress.get(id);
      return pr ? progressScore(pr) : -1;
    };
    return this.players
      .map((p) => ({ id: p.id, name: p.name, timeMs: this.finishes.get(p.id) ?? null }))
      .sort((a, b) => {
        if (a.timeMs !== null && b.timeMs !== null) return a.timeMs - b.timeMs;
        if (a.timeMs !== null) return -1;
        if (b.timeMs !== null) return 1;
        return score(b.id) - score(a.id);
      });
  }

  playerInfos(): PlayerInfo[] {
    return this.players.map((p) => ({ ...p }));
  }
}

export class LobbyManager {
  readonly rooms = new Map<string, Room>();

  constructor(private readonly random: () => number = Math.random) {}

  private newCode(): string {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code: string;
    do {
      code = Array.from({ length: 4 }, () => letters[Math.floor(this.random() * letters.length)]).join('');
    } while (this.rooms.has(code));
    return code;
  }

  create(playerId: string, name: string): Room {
    const room = new Room(this.newCode());
    room.addPlayer(playerId, name);
    this.rooms.set(room.code, room);
    return room;
  }

  join(code: string, playerId: string, name: string): Room {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) throw new Error('Room not found');
    room.addPlayer(playerId, name);
    return room;
  }

  leave(code: string, playerId: string): Room | null {
    const room = this.rooms.get(code);
    if (!room) return null;
    room.removePlayer(playerId);
    if (room.players.length === 0) {
      this.rooms.delete(code);
      return null;
    }
    return room;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/test/lobby.test.ts`
Expected: 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: server lobby/room state machine with host promotion and car exclusivity"
```

---

### Task 4: Results collation (TDD)

**Files:**
- Modify: `server/test/lobby.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing tests** (append to `server/test/lobby.test.ts`)

```ts
describe('Room results', () => {
  const room4 = () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    for (const id of ['p2', 'p3', 'p4']) lm.join(room.code, id, id.toUpperCase());
    room.start('p1');
    return room;
  };

  it('orders finishers by time', () => {
    const room = room4();
    room.recordFinish('p3', 61000);
    room.recordFinish('p1', 60000);
    room.recordFinish('p2', 62000);
    room.recordFinish('p4', 65000);
    expect(room.allFinished).toBe(true);
    expect(room.standings().map((s) => s.id)).toEqual(['p1', 'p3', 'p2', 'p4']);
  });

  it('ranks non-finishers below finishers, by progress', () => {
    const room = room4();
    room.recordFinish('p2', 60000);
    room.recordProgress('p1', { passed: 40, dist: 10 }); // furthest along
    room.recordProgress('p3', { passed: 39, dist: 5 });
    room.recordProgress('p4', { passed: 40, dist: 50 }); // same cp as p1, further from gate
    const ids = room.standings().map((s) => s.id);
    expect(ids).toEqual(['p2', 'p1', 'p4', 'p3']);
    expect(room.standings()[3].timeMs).toBeNull();
  });

  it('ignores duplicate finishes and finishes outside racing phase', () => {
    const room = room4();
    room.recordFinish('p1', 60000);
    room.recordFinish('p1', 1); // ignored
    expect(room.finishes.get('p1')).toBe(60000);
    room.resetToLobby();
    room.recordFinish('p2', 5); // ignored: not racing
    expect(room.finishes.size).toBe(0);
  });

  it('allFinished accounts for players who left mid-race', () => {
    const room = room4();
    room.recordFinish('p1', 60000);
    room.recordFinish('p2', 61000);
    room.recordFinish('p3', 62000);
    expect(room.allFinished).toBe(false);
    room.removePlayer('p4');
    expect(room.allFinished).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run server/test/lobby.test.ts`
Expected: all PASS (the Task 3 implementation already covers these — these tests lock the behavior in). If any fail, fix `lobby.ts` until green.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test: lock in results collation ordering and edge cases"
```

---

### Task 5: WebSocket server wiring

**Files:**
- Create: `server/src/server.ts`, `server/src/index.ts`

- [ ] **Step 1: Write `server/src/server.ts`**

```ts
import { WebSocket, WebSocketServer } from 'ws';
import { ClientMsg, ServerMsg } from '../../shared/src/protocol';
import { LobbyManager, Room } from './lobby';

const RESULTS_TIMEOUT_MS = 60_000;
const COUNTDOWN_MS = 3_000;

interface Conn {
  ws: WebSocket;
  id: string;
  room: Room | null;
}

export function createGameServer(port: number): WebSocketServer {
  const wss = new WebSocketServer({ port });
  const lobby = new LobbyManager();
  const conns = new Map<string, Conn>();
  const roomTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let nextId = 1;

  const send = (id: string, msg: ServerMsg) => conns.get(id)?.ws.send(JSON.stringify(msg));
  const broadcast = (room: Room, msg: ServerMsg, exceptId?: string) =>
    room.players.forEach((p) => p.id !== exceptId && send(p.id, msg));

  function endRace(room: Room) {
    if (room.phase !== 'racing') return;
    clearTimeout(roomTimers.get(room.code));
    roomTimers.delete(room.code);
    broadcast(room, { type: 'results', standings: room.standings() });
    room.resetToLobby();
    broadcast(room, { type: 'lobby', players: room.playerInfos() });
  }

  function maybeEndRace(room: Room) {
    if (room.phase !== 'racing' || room.finishes.size === 0) return;
    if (room.allFinished) endRace(room);
    else if (!roomTimers.has(room.code))
      roomTimers.set(room.code, setTimeout(() => endRace(room), RESULTS_TIMEOUT_MS));
  }

  function handle(conn: Conn, msg: ClientMsg) {
    switch (msg.type) {
      case 'create': {
        conn.room = lobby.create(conn.id, msg.name);
        send(conn.id, { type: 'created', code: conn.room.code, selfId: conn.id, players: conn.room.playerInfos() });
        break;
      }
      case 'join': {
        conn.room = lobby.join(msg.code, conn.id, msg.name);
        send(conn.id, { type: 'joined', code: conn.room.code, selfId: conn.id, players: conn.room.playerInfos() });
        broadcast(conn.room, { type: 'lobby', players: conn.room.playerInfos() }, conn.id);
        break;
      }
      case 'pickCar': {
        if (conn.room?.pickCar(conn.id, msg.car))
          broadcast(conn.room, { type: 'lobby', players: conn.room.playerInfos() });
        break;
      }
      case 'start': {
        if (conn.room?.start(conn.id)) {
          const grid: Record<string, number> = {};
          conn.room.players.forEach((p, i) => (grid[p.id] = i));
          broadcast(conn.room, { type: 'countdown', countdownMs: COUNTDOWN_MS, grid });
        }
        break;
      }
      case 'state': {
        if (conn.room?.phase === 'racing') {
          conn.room.recordProgress(conn.id, msg.state.progress);
          broadcast(conn.room, { type: 'state', id: conn.id, state: msg.state }, conn.id);
        }
        break;
      }
      case 'finished': {
        if (conn.room) {
          conn.room.recordFinish(conn.id, msg.timeMs);
          maybeEndRace(conn.room);
        }
        break;
      }
    }
  }

  wss.on('connection', (ws) => {
    const conn: Conn = { ws, id: `p${nextId++}`, room: null };
    conns.set(conn.id, conn);

    ws.on('message', (data) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      try {
        handle(conn, msg);
      } catch (e) {
        send(conn.id, { type: 'error', message: (e as Error).message });
      }
    });

    ws.on('close', () => {
      conns.delete(conn.id);
      if (!conn.room) return;
      const room = lobby.leave(conn.room.code, conn.id);
      conn.room = null;
      if (room) {
        broadcast(room, { type: 'playerLeft', id: conn.id });
        broadcast(room, { type: 'lobby', players: room.playerInfos() });
        maybeEndRace(room); // remaining players might now all be finished
      }
    });
  });

  return wss;
}
```

- [ ] **Step 2: Write `server/src/index.ts`**

```ts
import { createGameServer } from './server';

const port = Number(process.env.PORT) || 8080;
createGameServer(port);
console.log(`Racing relay server listening on ws://localhost:${port}`);
```

- [ ] **Step 3: Smoke test**

Run:

```bash
npx tsc --noEmit && (npx tsx server/src/index.ts & SERVER_PID=$!; sleep 2; kill $SERVER_PID)
```

Expected: typecheck passes; server prints `Racing relay server listening on ws://localhost:8080` and exits cleanly.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: websocket relay server with lobby routing, countdown, and results"
```

---

### Task 6: Headless bot end-to-end script

**Files:**
- Create: `scripts/bots.ts`

- [ ] **Step 1: Write `scripts/bots.ts`**

```ts
import WebSocket from 'ws';
import { ClientMsg, ServerMsg } from '../shared/src/protocol';

const URL = process.env.WS_URL ?? 'ws://localhost:8080';
const fail = (m: string) => {
  console.error('FAIL:', m);
  process.exit(1);
};

class Bot {
  ws = new WebSocket(URL);
  private msgs: ServerMsg[] = [];
  private waiters: ((m: ServerMsg) => boolean)[] = [];

  constructor(public name: string) {
    this.ws.on('message', (d) => {
      const msg = JSON.parse(d.toString()) as ServerMsg;
      this.msgs.push(msg);
      this.waiters = this.waiters.filter((w) => !w(msg));
    });
  }

  send(m: ClientMsg) {
    this.ws.send(JSON.stringify(m));
  }

  open() {
    return new Promise((res) => this.ws.on('open', res));
  }

  expect<T extends ServerMsg['type']>(type: T, timeoutMs = 5000): Promise<Extract<ServerMsg, { type: T }>> {
    const found = this.msgs.find((m) => m.type === type);
    if (found) return Promise.resolve(found as Extract<ServerMsg, { type: T }>);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`${this.name}: timeout waiting for '${type}'`)), timeoutMs);
      this.waiters.push((m) => {
        if (m.type !== type) return false;
        clearTimeout(timer);
        res(m as Extract<ServerMsg, { type: T }>);
        return true;
      });
    });
  }
}

async function main() {
  const bots = ['Ava', 'Ben', 'Cyd', 'Dee'].map((n) => new Bot(n));
  await Promise.all(bots.map((b) => b.open()));

  bots[0].send({ type: 'create', name: bots[0].name });
  const created = await bots[0].expect('created');
  console.log('room code:', created.code);

  for (const b of bots.slice(1)) {
    b.send({ type: 'join', code: created.code, name: b.name });
    await b.expect('joined');
  }

  bots[0].send({ type: 'start' });
  await Promise.all(bots.map((b) => b.expect('countdown')));
  console.log('countdown received by all 4 bots');

  // simulate state traffic, then staggered finishes (Ava wins)
  bots.forEach((b, i) => {
    b.send({
      type: 'state',
      state: { p: [0, 0.5, 0], q: [0, 0, 0, 1], progress: { passed: i, dist: 10 } },
    });
    setTimeout(() => b.send({ type: 'finished', timeMs: 60_000 + i * 1500 }), 300 + i * 100);
  });

  const results = await Promise.all(bots.map((b) => b.expect('results')));
  const order = results[0].standings.map((s) => s.name);
  if (order[0] !== 'Ava' || order[3] !== 'Dee') fail(`bad standings: ${order.join(' > ')}`);
  console.log('PASS — standings:', order.join(' > '));
  bots.forEach((b) => b.ws.close());
  process.exit(0);
}

main().catch((e) => fail(e.message));
```

- [ ] **Step 2: Run it against a live server**

Run:

```bash
npx tsx server/src/index.ts & SERVER_PID=$!
sleep 1 && npx tsx scripts/bots.ts; RESULT=$?
kill $SERVER_PID; exit $RESULT
```

Expected output ends with `PASS — standings: Ava > Ben > Cyd > Dee`.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: headless 4-bot end-to-end exercise of lobby and race flow"
```

---

### Task 7: Client shell — HTML, CSS, screens

**Files:**
- Create: `client/index.html`, `client/src/ui/style.css`, `client/src/ui/screens.ts`, `client/src/main.ts`

- [ ] **Step 1: Write `client/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Velocity Rush</title>
    <link rel="stylesheet" href="/src/ui/style.css" />
  </head>
  <body>
    <canvas id="game"></canvas>

    <div id="menu" class="screen">
      <h1>VELOCITY RUSH</h1>
      <input id="name-input" maxlength="16" placeholder="Your name" />
      <button id="create-btn">Create Lobby</button>
      <div class="row">
        <input id="code-input" maxlength="4" placeholder="CODE" />
        <button id="join-btn">Join</button>
      </div>
      <p id="menu-error" class="error"></p>
    </div>

    <div id="lobby" class="screen hidden">
      <h2>Lobby <span id="lobby-code"></span></h2>
      <ul id="player-list"></ul>
      <div id="car-picker"></div>
      <button id="start-btn">Start Race</button>
      <p id="lobby-hint"></p>
    </div>

    <div id="hud" class="hidden">
      <div id="speed">0 km/h</div>
      <div id="lap">Lap 1/3</div>
      <div id="pos">1st/1</div>
      <div id="laptime">Lap 0:00.0</div>
      <div id="totaltime">Total 0:00.0</div>
      <canvas id="minimap" width="200" height="200"></canvas>
      <div id="countdown" class="hidden"></div>
      <div id="wrongway" class="hidden">WRONG WAY</div>
      <div id="waiting" class="hidden">Finished! Waiting for others…</div>
    </div>

    <div id="results" class="screen hidden">
      <h2>Results</h2>
      <table id="results-table"></table>
      <button id="back-btn">Back to Lobby</button>
    </div>

    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `client/src/ui/style.css`**

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; overflow: hidden; background: #0b0e14; font-family: system-ui, sans-serif; }
#game { position: fixed; inset: 0; width: 100%; height: 100%; display: block; }
.hidden { display: none !important; }

.screen {
  position: fixed; inset: 0; display: flex; flex-direction: column; gap: 14px;
  align-items: center; justify-content: center; color: #eef2f8;
  background: rgba(8, 10, 16, 0.82); z-index: 10;
}
.screen h1 { font-size: 56px; letter-spacing: 6px; font-style: italic; }
.screen h2 { font-size: 32px; }
.screen input {
  font-size: 18px; padding: 10px 14px; border-radius: 8px; border: 1px solid #3a4150;
  background: #161b26; color: #eef2f8; text-align: center; width: 240px;
}
#code-input { width: 110px; text-transform: uppercase; }
.screen button {
  font-size: 18px; padding: 10px 26px; border-radius: 8px; border: 0; cursor: pointer;
  background: #e8463c; color: #fff; font-weight: 700;
}
.screen button:disabled { background: #4a4f5a; cursor: default; }
.row { display: flex; gap: 10px; }
.error { color: #ff7b6e; min-height: 1.2em; }

#player-list { list-style: none; font-size: 20px; text-align: center; }
#player-list li { padding: 4px 0; }
#car-picker { display: flex; gap: 10px; }
#car-picker button { background: #2a3text; background: #28304a; font-size: 14px; padding: 8px 14px; }
#car-picker button.mine { outline: 2px solid #e8463c; }
#car-picker button.taken { opacity: 0.35; }

#hud { position: fixed; inset: 0; pointer-events: none; color: #fff; z-index: 5; }
#hud > div { position: absolute; text-shadow: 0 2px 6px rgba(0,0,0,0.7); }
#speed { right: 28px; bottom: 24px; font-size: 42px; font-weight: 800; font-style: italic; }
#lap { left: 28px; top: 20px; font-size: 26px; font-weight: 700; }
#pos { left: 28px; top: 54px; font-size: 26px; font-weight: 700; color: #ffd24d; }
#laptime { right: 28px; bottom: 84px; font-size: 20px; font-weight: 600; }
#totaltime { right: 28px; bottom: 112px; font-size: 20px; font-weight: 600; color: #ffd24d; }
#minimap { position: absolute; right: 20px; top: 20px; width: 170px; height: 170px; }
#countdown { left: 50%; top: 38%; transform: translate(-50%, -50%); font-size: 110px; font-weight: 900; }
#wrongway { left: 50%; top: 18%; transform: translateX(-50%); font-size: 34px; color: #ff5544; font-weight: 900; }
#waiting { left: 50%; top: 30%; transform: translateX(-50%); font-size: 26px; }
#results-table { font-size: 22px; border-spacing: 18px 6px; }
```

Note: fix the typo line `background: #2a3text;` — it must not be present; the `#car-picker button` rule is just `background: #28304a; font-size: 14px; padding: 8px 14px;`.

- [ ] **Step 3: Write `client/src/ui/screens.ts`**

```ts
import { CAR_MODELS, CarModel, PlayerInfo, Standing } from '../../../shared/src/protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class Screens {
  onCreate: (name: string) => void = () => {};
  onJoin: (code: string, name: string) => void = () => {};
  onPickCar: (car: CarModel) => void = () => {};
  onStart: () => void = () => {};
  onBack: () => void = () => {};

  constructor() {
    $('create-btn').addEventListener('click', () => this.onCreate(this.name()));
    $('join-btn').addEventListener('click', () =>
      this.onJoin(($('code-input') as HTMLInputElement).value.trim().toUpperCase(), this.name()),
    );
    $('start-btn').addEventListener('click', () => this.onStart());
    $('back-btn').addEventListener('click', () => this.onBack());
  }

  private name(): string {
    return ($('name-input') as HTMLInputElement).value.trim() || 'Player';
  }

  show(name: 'menu' | 'lobby' | 'results' | 'none'): void {
    for (const id of ['menu', 'lobby', 'results']) $(id).classList.toggle('hidden', id !== name);
  }

  showError(message: string): void {
    $('menu-error').textContent = message;
  }

  renderLobby(code: string, players: PlayerInfo[], selfId: string): void {
    $('lobby-code').textContent = code;
    $('player-list').innerHTML = players
      .map((p) => `<li>${p.isHost ? '👑 ' : ''}${esc(p.name)} — ${p.car}${p.id === selfId ? ' (you)' : ''}</li>`)
      .join('');
    const me = players.find((p) => p.id === selfId);
    const picker = $('car-picker');
    picker.innerHTML = '';
    for (const car of CAR_MODELS) {
      const btn = document.createElement('button');
      btn.textContent = car;
      const owner = players.find((p) => p.car === car);
      if (owner?.id === selfId) btn.classList.add('mine');
      else if (owner) btn.classList.add('taken');
      btn.addEventListener('click', () => this.onPickCar(car));
      picker.appendChild(btn);
    }
    const startBtn = $('start-btn') as HTMLButtonElement;
    startBtn.disabled = !me?.isHost;
    $('lobby-hint').textContent = me?.isHost ? 'You are the host — start when ready.' : 'Waiting for the host to start…';
  }

  renderResults(standings: Standing[]): void {
    const fmt = (ms: number | null) => (ms === null ? 'DNF' : `${(ms / 1000).toFixed(2)}s`);
    $('results-table').innerHTML = standings
      .map((s, i) => `<tr><td>#${i + 1}</td><td>${esc(s.name)}</td><td>${fmt(s.timeMs)}</td></tr>`)
      .join('');
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
```

- [ ] **Step 4: Write a minimal `client/src/main.ts`** (full version replaces this in Task 8)

```ts
import { Screens } from './ui/screens';

const screens = new Screens();
screens.show('menu');
```

- [ ] **Step 5: Verify in browser**

Run: `npx vite --open` (leave running, or run `npx vite` and open http://localhost:5173)
Expected: dark title screen with "VELOCITY RUSH", name input, Create Lobby, code input + Join. No console errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: client shell with menu/lobby/HUD/results screens"
```

---

### Task 8: Net layer + menu/lobby flow

**Files:**
- Create: `client/src/net/socket.ts`
- Modify: `client/src/main.ts` (replace entirely)

- [ ] **Step 1: Write `client/src/net/socket.ts`**

```ts
import { ClientMsg, ServerMsg } from '../../../shared/src/protocol';

export class GameSocket {
  private ws: WebSocket;

  constructor(
    private readonly onMessage: (msg: ServerMsg) => void,
    private readonly onClose: () => void = () => {},
    url = `ws://${location.hostname}:8080`,
  ) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', (e) => this.onMessage(JSON.parse(e.data) as ServerMsg));
    this.ws.addEventListener('close', () => this.onClose());
  }

  ready(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true });
      this.ws.addEventListener('error', () => rej(new Error('Cannot reach game server')), { once: true });
    });
  }

  send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
```

- [ ] **Step 2: Replace `client/src/main.ts`** with the lobby flow (Game integration arrives in Tasks 12–15; the `countdown` branch is a placeholder `console.log` for now):

```ts
import { PlayerInfo, ServerMsg } from '../../shared/src/protocol';
import { GameSocket } from './net/socket';
import { Screens } from './ui/screens';

const screens = new Screens();
let socket: GameSocket | null = null;
let selfId = '';
let roomCode = '';
let players: PlayerInfo[] = [];

function connect(): Promise<GameSocket> {
  if (socket) return Promise.resolve(socket);
  const s = new GameSocket(onMessage, () => {
    socket = null;
    screens.show('menu');
    screens.showError('Disconnected from server');
  });
  return s.ready().then(() => (socket = s));
}

function onMessage(msg: ServerMsg): void {
  switch (msg.type) {
    case 'created':
    case 'joined':
      selfId = msg.selfId;
      roomCode = msg.code;
      players = msg.players;
      screens.renderLobby(roomCode, players, selfId);
      screens.show('lobby');
      break;
    case 'lobby':
      players = msg.players;
      screens.renderLobby(roomCode, players, selfId);
      break;
    case 'error':
      screens.showError(msg.message);
      break;
    case 'countdown':
      console.log('countdown', msg); // replaced in Task 15
      break;
    case 'state':
    case 'playerLeft':
    case 'results':
      break; // wired up in Tasks 14–15
  }
}

screens.onCreate = (name) =>
  connect().then((s) => s.send({ type: 'create', name })).catch((e) => screens.showError(e.message));
screens.onJoin = (code, name) =>
  connect().then((s) => s.send({ type: 'join', code, name })).catch((e) => screens.showError(e.message));
screens.onPickCar = (car) => socket?.send({ type: 'pickCar', car });
screens.onStart = () => socket?.send({ type: 'start' });
screens.onBack = () => {
  screens.renderLobby(roomCode, players, selfId);
  screens.show('lobby');
};

screens.show('menu');
```

- [ ] **Step 3: Manual two-tab test**

Run server (`npm run server`) and client (`npm run dev`) in two terminals. Open two browser tabs at http://localhost:5173.
Expected: tab 1 creates a lobby and sees a 4-letter code; tab 2 joins with that code; both tabs list both players with crown on host; car picks update live in both tabs; picking a taken car does nothing; Start button enabled only in tab 1; joining a bad code shows "Room not found".

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: client networking and live lobby flow"
```

---

### Task 9: Snapshot interpolation (TDD)

**Files:**
- Create: `client/src/net/interpolation.ts`
- Test: `client/test/interpolation.test.ts`

- [ ] **Step 1: Write the failing tests** — `client/test/interpolation.test.ts`:

```ts
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { SnapshotBuffer } from '../src/net/interpolation';

const p = new Vector3();
const q = new Quaternion();

describe('SnapshotBuffer', () => {
  it('returns false when empty', () => {
    expect(new SnapshotBuffer().sample(100, p, q)).toBe(false);
  });

  it('clamps to the only/oldest snapshot', () => {
    const buf = new SnapshotBuffer();
    buf.push({ t: 100, p: [1, 2, 3], q: [0, 0, 0, 1] });
    expect(buf.sample(50, p, q)).toBe(true);
    expect(p.toArray()).toEqual([1, 2, 3]);
  });

  it('interpolates linearly between two snapshots', () => {
    const buf = new SnapshotBuffer();
    buf.push({ t: 100, p: [0, 0, 0], q: [0, 0, 0, 1] });
    buf.push({ t: 200, p: [10, 0, 0], q: [0, 0, 0, 1] });
    buf.sample(150, p, q);
    expect(p.x).toBeCloseTo(5);
  });

  it('clamps to the newest snapshot when sampling past the end', () => {
    const buf = new SnapshotBuffer();
    buf.push({ t: 100, p: [0, 0, 0], q: [0, 0, 0, 1] });
    buf.push({ t: 200, p: [10, 0, 0], q: [0, 0, 0, 1] });
    buf.sample(999, p, q);
    expect(p.x).toBeCloseTo(10);
  });

  it('slerps rotation', () => {
    const buf = new SnapshotBuffer();
    const q90 = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    buf.push({ t: 0, p: [0, 0, 0], q: [0, 0, 0, 1] });
    buf.push({ t: 100, p: [0, 0, 0], q: q90.toArray() as [number, number, number, number] });
    buf.sample(50, p, q);
    const q45 = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4);
    expect(q.angleTo(q45)).toBeLessThan(0.01);
  });

  it('caps buffer size', () => {
    const buf = new SnapshotBuffer();
    for (let i = 0; i < 200; i++) buf.push({ t: i, p: [i, 0, 0], q: [0, 0, 0, 1] });
    buf.sample(0, p, q); // oldest retained is i=140
    expect(p.x).toBeCloseTo(140);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/test/interpolation.test.ts`
Expected: FAIL — cannot resolve `../src/net/interpolation`.

- [ ] **Step 3: Implement `client/src/net/interpolation.ts`**

```ts
import { Quaternion, Vector3 } from 'three';

export interface Snapshot {
  t: number; // local receipt time (performance.now())
  p: [number, number, number];
  q: [number, number, number, number];
}

const MAX_SNAPSHOTS = 60;
const qa = new Quaternion();
const qb = new Quaternion();

export class SnapshotBuffer {
  private snaps: Snapshot[] = [];

  push(s: Snapshot): void {
    this.snaps.push(s);
    if (this.snaps.length > MAX_SNAPSHOTS) this.snaps.shift();
  }

  /** Sample pose at time t into outP/outQ. Returns false if no data yet. */
  sample(t: number, outP: Vector3, outQ: Quaternion): boolean {
    const s = this.snaps;
    if (s.length === 0) return false;
    if (t <= s[0].t) return this.set(s[0], outP, outQ);
    const last = s[s.length - 1];
    if (t >= last.t) return this.set(last, outP, outQ);
    for (let i = s.length - 2; i >= 0; i--) {
      if (s[i].t <= t) {
        const a = s[i];
        const b = s[i + 1];
        const f = (t - a.t) / (b.t - a.t);
        outP.set(
          a.p[0] + (b.p[0] - a.p[0]) * f,
          a.p[1] + (b.p[1] - a.p[1]) * f,
          a.p[2] + (b.p[2] - a.p[2]) * f,
        );
        qa.fromArray(a.q);
        qb.fromArray(b.q);
        outQ.slerpQuaternions(qa, qb, f);
        return true;
      }
    }
    return this.set(s[0], outP, outQ);
  }

  private set(s: Snapshot, outP: Vector3, outQ: Quaternion): boolean {
    outP.set(s.p[0], s.p[1], s.p[2]);
    outQ.fromArray(s.q);
    return true;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run client/test/interpolation.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: snapshot buffer with position lerp and rotation slerp"
```

---

### Task 10: Scene, track, and environment

**Files:**
- Create: `client/src/game/scene.ts`, `client/src/game/track.ts`

- [ ] **Step 1: Write `client/src/game/scene.ts`**

```ts
import * as THREE from 'three';

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  dispose: () => void;
}

export function createScene(canvas: HTMLCanvasElement): SceneCtx {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fc1e8);
  scene.fog = new THREE.Fog(0x8fc1e8, 160, 480);

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
    dispose: () => {
      window.removeEventListener('resize', onResize);
      renderer.dispose();
    },
  };
}
```

- [ ] **Step 2: Write `client/src/game/track.ts`**

```ts
import * as THREE from 'three';

export const ROAD_WIDTH = 14;
export const NUM_CHECKPOINTS = 16;
const SAMPLES = 320;
const UP = new THREE.Vector3(0, 1, 0);

const CONTROL_POINTS = [
  [0, -70], [55, -95], [115, -55], [125, 25], [75, 70], [25, 45],
  [-25, 95], [-95, 80], [-130, 10], [-95, -65], [-40, -95],
].map(([x, z]) => new THREE.Vector3(x, 0, z));

export const curve = new THREE.CatmullRomCurve3(CONTROL_POINTS, true, 'catmullrom', 0.5);

export interface BarrierBox {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  half: THREE.Vector3;
}

export interface Checkpoint {
  pos: THREE.Vector3;
  tangent: THREE.Vector3;
}

export interface TrackData {
  group: THREE.Group; // all visuals — add to scene
  barriers: BarrierBox[]; // physics layer creates colliders from these
  checkpoints: Checkpoint[]; // [0] is the start/finish line
}

export function buildTrack(): TrackData {
  const group = new THREE.Group();

  // --- ground ---
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900),
    new THREE.MeshStandardMaterial({ color: 0x4e7a3d }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  group.add(ground);

  // --- road ribbon ---
  group.add(ribbon(ROAD_WIDTH, 0.0, new THREE.MeshStandardMaterial({ color: 0x2e2f33, roughness: 0.95 })));
  // edge lines
  group.add(stripe(ROAD_WIDTH / 2 - 0.35, 0xffffff));
  group.add(stripe(-(ROAD_WIDTH / 2 - 0.35), 0xffffff));

  // --- barriers (visual walls + physics boxes) ---
  const barriers: BarrierBox[] = [];
  const wallGeo = new THREE.BoxGeometry(0.4, 1.0, 6.4);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xd84b41 });
  const wallMatW = new THREE.MeshStandardMaterial({ color: 0xf3f4f6 });
  const nWalls = Math.floor(curve.getLength() / 6);
  const walls = new THREE.InstancedMesh(wallGeo, wallMat, nWalls * 2);
  const wallsW = new THREE.InstancedMesh(wallGeo, wallMatW, nWalls * 2);
  const m = new THREE.Matrix4();
  let wi = 0;
  let wwi = 0;
  for (let i = 0; i < nWalls; i++) {
    const u = i / nWalls;
    const pos = curve.getPointAt(u);
    const tan = curve.getTangentAt(u);
    const side = new THREE.Vector3().crossVectors(tan, UP).normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), tan);
    for (const dir of [-1, 1]) {
      const p = pos.clone().addScaledVector(side, dir * (ROAD_WIDTH / 2 + 0.8)).setY(0.5);
      barriers.push({ pos: p, quat: quat.clone(), half: new THREE.Vector3(0.2, 0.5, 3.2) });
      m.compose(p, quat, new THREE.Vector3(1, 1, 1));
      if (i % 2 === 0) walls.setMatrixAt(wi++, m);
      else wallsW.setMatrixAt(wwi++, m);
    }
  }
  walls.count = wi;
  wallsW.count = wwi;
  group.add(walls, wallsW);

  // --- checkpoints ---
  const checkpoints: Checkpoint[] = [];
  for (let i = 0; i < NUM_CHECKPOINTS; i++) {
    const u = i / NUM_CHECKPOINTS;
    checkpoints.push({ pos: curve.getPointAt(u), tangent: curve.getTangentAt(u) });
  }

  // --- start/finish gantry ---
  const start = checkpoints[0];
  const side = new THREE.Vector3().crossVectors(start.tangent, UP).normalize();
  const postGeo = new THREE.CylinderGeometry(0.3, 0.3, 7);
  const postMat = new THREE.MeshStandardMaterial({ color: 0xdddddd });
  for (const dir of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.copy(start.pos).addScaledVector(side, dir * (ROAD_WIDTH / 2 + 1)).setY(3.5);
    group.add(post);
  }
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(ROAD_WIDTH + 3.5, 1.2, 0.8),
    new THREE.MeshStandardMaterial({ color: 0xe8463c }),
  );
  beam.position.copy(start.pos).setY(7);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), side);
  group.add(beam);

  // --- trees (instanced, kept off the road) ---
  const roadPts: THREE.Vector3[] = [];
  for (let i = 0; i < 100; i++) roadPts.push(curve.getPointAt(i / 100));
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 2.4);
  const leafGeo = new THREE.ConeGeometry(2.0, 5.0, 7);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x6b4a2b }), 160);
  const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ color: 0x2f6b34 }), 160);
  leaves.castShadow = true;
  let ti = 0;
  let attempts = 0;
  // deterministic pseudo-random so every client builds the same forest
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  while (ti < 160 && attempts++ < 4000) {
    const p = new THREE.Vector3(rand() * 700 - 350, 0, rand() * 700 - 350);
    if (roadPts.some((rp) => rp.distanceTo(p) < ROAD_WIDTH * 1.8)) continue;
    m.compose(p.clone().setY(1.2), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    trunks.setMatrixAt(ti, m);
    m.compose(p.clone().setY(4.6), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
    leaves.setMatrixAt(ti, m);
    ti++;
  }
  trunks.count = leaves.count = ti;
  group.add(trunks, leaves);

  return { group, barriers, checkpoints };
}

function ribbon(width: number, y: number, mat: THREE.Material): THREE.Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const u = (i % SAMPLES) / SAMPLES;
    const pos = curve.getPointAt(u);
    const tan = curve.getTangentAt(u);
    const side = new THREE.Vector3().crossVectors(tan, UP).normalize();
    const l = pos.clone().addScaledVector(side, -width / 2);
    const r = pos.clone().addScaledVector(side, width / 2);
    positions.push(l.x, y, l.z, r.x, y, r.z);
    if (i < SAMPLES) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function stripe(offset: number, color: number): THREE.Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const u = (i % SAMPLES) / SAMPLES;
    const pos = curve.getPointAt(u);
    const tan = curve.getTangentAt(u);
    const side = new THREE.Vector3().crossVectors(tan, UP).normalize();
    const l = pos.clone().addScaledVector(side, offset - 0.18);
    const r = pos.clone().addScaledVector(side, offset + 0.18);
    positions.push(l.x, 0.02, l.z, r.x, 0.02, r.z);
    if (i < SAMPLES) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
}

/** Starting grid pose for a slot (0-3), just behind the start line, 2 columns. */
export function gridPose(slot: number): { pos: THREE.Vector3; yaw: number } {
  const u = (1 - 0.010 - Math.floor(slot / 2) * 0.008 + 1) % 1;
  const pos = curve.getPointAt(u);
  const tan = curve.getTangentAt(u);
  const side = new THREE.Vector3().crossVectors(tan, UP).normalize();
  pos.addScaledVector(side, slot % 2 === 0 ? -ROAD_WIDTH / 4 : ROAD_WIDTH / 4);
  const yaw = Math.atan2(-tan.x, -tan.z);
  return { pos, yaw };
}
```

- [ ] **Step 3: Temporary visual check** — append to `client/src/main.ts` (temporary, removed in Task 12):

```ts
import { createScene } from './game/scene';
import { buildTrack } from './game/track';

if (location.search.includes('track')) {
  screens.show('none');
  const ctx = createScene(document.getElementById('game') as HTMLCanvasElement);
  ctx.scene.add(buildTrack().group);
  ctx.camera.position.set(0, 220, 160);
  ctx.camera.lookAt(0, 0, 0);
  const spin = (t: number) => {
    ctx.camera.position.set(Math.sin(t / 9000) * 260, 200, Math.cos(t / 9000) * 260);
    ctx.camera.lookAt(0, 0, 0);
    ctx.renderer.render(ctx.scene, ctx.camera);
    requestAnimationFrame(spin);
  };
  requestAnimationFrame(spin);
}
```

- [ ] **Step 4: Verify in browser**

Open http://localhost:5173/?track
Expected: a slowly orbiting aerial view of a closed asphalt circuit with white edge lines, alternating red/white barrier walls on both sides, a start gantry, trees scattered around (none on the road), green ground, sky-blue fog. Smooth 60 fps; no console errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: spline circuit with road, barriers, checkpoints, gantry, and scenery"
```

---

### Task 11: Car models — assets + loader

**Files:**
- Create: `client/src/game/cars.ts`, `client/public/models/cars/*.glb`

- [ ] **Step 1: Download 4 CC0 car models (Kenney Car Kit)**

```bash
mkdir -p client/public/models/cars
ZIP_URL=$(curl -sL https://kenney.nl/assets/car-kit | grep -oE 'https://[^"]+\.zip' | head -1)
curl -sL -o /tmp/carkit.zip "$ZIP_URL"
unzip -o /tmp/carkit.zip -d /tmp/carkit
find /tmp/carkit -iname '*.glb' | head -20
```

Locate the GLB folder in the listing (typically `Models/GLB format/`) and copy exactly these four, renaming to match `CAR_MODELS` in the protocol:

```bash
GLB_DIR=$(dirname "$(find /tmp/carkit -iname 'race.glb' | head -1)")
cp "$GLB_DIR/race.glb" "$GLB_DIR/race-future.glb" "$GLB_DIR/sedan-sports.glb" "$GLB_DIR/suv.glb" client/public/models/cars/
ls -la client/public/models/cars/
```

Expected: 4 `.glb` files present.
**Fallback if the download fails** (offline, page layout changed): skip this step — `cars.ts` below builds a decent procedural car when a model 404s, so nothing downstream blocks. Try Quaternius packs (https://quaternius.com, also CC0) as an alternative source, renaming files to the same four names.

- [ ] **Step 2: Write `client/src/game/cars.ts`**

```ts
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
```

- [ ] **Step 3: Verify (typecheck + browser)**

Run: `npx tsc --noEmit` — exit 0. Then in the browser console at http://localhost:5173/?track, no errors (loader code is exercised fully in Task 12).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: CC0 car models with normalization, cache, and procedural fallback"
```

---

### Task 12: Physics, input, chase camera — drivable car (practice mode)

**Files:**
- Create: `client/src/game/physics.ts`, `client/src/game/input.ts`, `client/src/game/camera.ts`, `client/src/game/game.ts`, `client/src/ui/hud.ts`
- Modify: `client/src/main.ts` (replace the `?track` block with `?practice` mode)

- [ ] **Step 1: Write `client/src/game/input.ts`**

```ts
export class Input {
  throttle = 0; // -1..1
  steer = 0; // -1..1, smoothed
  handbrake = false;
  private keys = new Set<string>();
  private onKey = (e: KeyboardEvent) => {
    if (e.type === 'keydown') this.keys.add(e.code);
    else this.keys.delete(e.code);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  };

  constructor() {
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
  }

  update(dt: number): void {
    const k = this.keys;
    const up = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    const down = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    const left = k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0;
    const right = k.has('KeyD') || k.has('ArrowRight') ? 1 : 0;
    this.throttle = up - down;
    const target = left - right;
    this.steer += (target - this.steer) * Math.min(1, dt * 9);
    if (Math.abs(this.steer) < 0.01 && target === 0) this.steer = 0;
    this.handbrake = k.has('Space');
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
  }
}
```

- [ ] **Step 2: Write `client/src/game/physics.ts`**

```ts
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { BarrierBox } from './track';
import type { Input } from './input';

export const CAR_HALF = { x: 0.85, y: 0.45, z: 1.8 };
export const MAX_SPEED = 38; // m/s ≈ 137 km/h
const ENGINE_ACCEL = 22;
const BRAKE_ACCEL = 32;
const REVERSE_ACCEL = 10;
const MAX_REVERSE = 9;
const TURN_RATE = 2.3; // rad/s at full steer
const GRIP = 9; // lateral velocity kill rate
const GRIP_HANDBRAKE = 2.2;

let initialized = false;
export async function initRapier(): Promise<void> {
  if (!initialized) {
    await RAPIER.init();
    initialized = true;
  }
}

export function createWorld(barriers: BarrierBox[]): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  // ground
  world.createCollider(RAPIER.ColliderDesc.cuboid(450, 0.5, 450).setTranslation(0, -0.5, 0).setFriction(0.8));
  // barriers
  for (const b of barriers) {
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(b.half.x, b.half.y, b.half.z)
        .setTranslation(b.pos.x, b.pos.y, b.pos.z)
        .setRotation({ x: b.quat.x, y: b.quat.y, z: b.quat.z, w: b.quat.w })
        .setRestitution(0.4),
    );
  }
  return world;
}

function carCollider(): RAPIER.ColliderDesc {
  return RAPIER.ColliderDesc.cuboid(CAR_HALF.x, CAR_HALF.y, CAR_HALF.z).setFriction(0.3).setRestitution(0.4);
}

export function createLocalCar(world: RAPIER.World, pos: THREE.Vector3, yaw: number): RAPIER.RigidBody {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, CAR_HALF.y + 0.05, pos.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .enabledRotations(false, true, false) // arcade: never roll/pitch
      .setLinearDamping(0.35)
      .setAngularDamping(5)
      .setCcdEnabled(true),
  );
  world.createCollider(carCollider().setMass(120), body);
  return body;
}

export function createRemoteCar(world: RAPIER.World): RAPIER.RigidBody {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
  world.createCollider(carCollider(), body);
  return body;
}

const FWD = new THREE.Vector3();
const VEL = new THREE.Vector3();
const LAT = new THREE.Vector3();
const Q = new THREE.Quaternion();

/** Arcade controller: read velocity, apply engine/brake/grip, write back. Collisions still shove the car because Rapier's solver adjusts velocity during the step and we re-read it next step. */
export function driveCar(body: RAPIER.RigidBody, input: Input, dt: number): void {
  const r = body.rotation();
  Q.set(r.x, r.y, r.z, r.w);
  FWD.set(0, 0, -1).applyQuaternion(Q);
  FWD.y = 0;
  FWD.normalize();
  const lv = body.linvel();
  VEL.set(lv.x, 0, lv.z);
  const fwdSpeed = VEL.dot(FWD);

  let accel = 0;
  if (input.throttle > 0) accel = ENGINE_ACCEL * input.throttle * Math.max(0, 1 - Math.max(0, fwdSpeed) / MAX_SPEED);
  else if (input.throttle < 0) accel = fwdSpeed > 0.5 ? -BRAKE_ACCEL : fwdSpeed > -MAX_REVERSE ? -REVERSE_ACCEL : 0;
  VEL.addScaledVector(FWD, accel * dt);

  LAT.copy(VEL).addScaledVector(FWD, -VEL.dot(FWD)); // lateral component
  const grip = input.handbrake ? GRIP_HANDBRAKE : GRIP;
  VEL.addScaledVector(LAT, -Math.min(1, grip * dt));

  body.setLinvel({ x: VEL.x, y: lv.y, z: VEL.z }, true);

  const speedFactor = THREE.MathUtils.clamp(Math.abs(fwdSpeed) / 11, 0, 1) * Math.sign(fwdSpeed || 1);
  body.setAngvel({ x: 0, y: input.steer * TURN_RATE * speedFactor, z: 0 }, true);
}

export function freezeCar(body: RAPIER.RigidBody): void {
  body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
}
```

- [ ] **Step 3: Write `client/src/game/camera.ts`**

```ts
import * as THREE from 'three';
import { MAX_SPEED } from './physics';

const BACK = 8.5;
const HEIGHT = 3.6;
const desired = new THREE.Vector3();
const lookAt = new THREE.Vector3();
const fwd = new THREE.Vector3();

export class ChaseCamera {
  constructor(private readonly cam: THREE.PerspectiveCamera) {}

  snap(pos: THREE.Vector3, quat: THREE.Quaternion): void {
    this.place(pos, quat, 1);
  }

  update(pos: THREE.Vector3, quat: THREE.Quaternion, speed: number, dt: number): void {
    this.place(pos, quat, 1 - Math.exp(-5.5 * dt));
    const targetFov = 68 + 14 * Math.min(1, speed / MAX_SPEED);
    if (Math.abs(this.cam.fov - targetFov) > 0.1) {
      this.cam.fov += (targetFov - this.cam.fov) * Math.min(1, 4 * dt);
      this.cam.updateProjectionMatrix();
    }
  }

  private place(pos: THREE.Vector3, quat: THREE.Quaternion, alpha: number): void {
    fwd.set(0, 0, -1).applyQuaternion(quat).setY(0).normalize();
    desired.copy(pos).addScaledVector(fwd, -BACK).setY(pos.y + HEIGHT);
    this.cam.position.lerp(desired, alpha);
    lookAt.copy(pos).addScaledVector(fwd, 5).setY(pos.y + 1.2);
    this.cam.lookAt(lookAt);
  }
}
```

- [ ] **Step 4: Write `client/src/ui/hud.ts`**

```ts
const $ = (id: string) => document.getElementById(id)!;
const ORDINALS = ['1st', '2nd', '3rd', '4th'];

function fmtTime(ms: number): string {
  const clamped = Math.max(0, ms);
  const m = Math.floor(clamped / 60000);
  const s = (clamped % 60000) / 1000;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export class Hud {
  private map: CanvasRenderingContext2D | null = null;
  private mapScale = 1;
  private mapOff = { x: 0, y: 0 };
  private mapPath = new Path2D();

  show(): void {
    $('hud').classList.remove('hidden');
  }

  hide(): void {
    $('hud').classList.add('hidden');
    for (const id of ['countdown', 'wrongway', 'waiting']) $(id).classList.add('hidden');
  }

  setSpeed(ms: number): void {
    $('speed').textContent = `${Math.round(Math.abs(ms) * 3.6)} km/h`;
  }

  setLap(lap: number, total: number): void {
    $('lap').textContent = `Lap ${Math.min(lap, total)}/${total}`;
  }

  setPosition(rank: number, total: number): void {
    $('pos').textContent = `${ORDINALS[rank - 1] ?? `${rank}th`}/${total}`;
  }

  setTimes(lapMs: number, totalMs: number): void {
    $('laptime').textContent = `Lap ${fmtTime(lapMs)}`;
    $('totaltime').textContent = `Total ${fmtTime(totalMs)}`;
  }

  /** points: world-space (x,z) samples of the track centerline, in order. */
  initMinimap(points: { x: number; z: number }[]): void {
    const canvas = $('minimap') as HTMLCanvasElement;
    this.map = canvas.getContext('2d');
    const xs = points.map((p) => p.x);
    const zs = points.map((p) => p.z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const pad = 14;
    this.mapScale = Math.min(
      (canvas.width - pad * 2) / (maxX - minX),
      (canvas.height - pad * 2) / (maxZ - minZ),
    );
    this.mapOff = {
      x: pad + (canvas.width - pad * 2 - (maxX - minX) * this.mapScale) / 2 - minX * this.mapScale,
      y: pad + (canvas.height - pad * 2 - (maxZ - minZ) * this.mapScale) / 2 - minZ * this.mapScale,
    };
    this.mapPath = new Path2D();
    points.forEach((p, i) => {
      const m = this.world2map(p.x, p.z);
      if (i === 0) this.mapPath.moveTo(m.x, m.y);
      else this.mapPath.lineTo(m.x, m.y);
    });
    this.mapPath.closePath();
  }

  updateMinimap(self: { x: number; z: number }, others: { x: number; z: number }[]): void {
    const ctx = this.map;
    if (!ctx) return;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke(this.mapPath);
    for (const o of others) this.dot(o, '#9fb2c8', 4);
    this.dot(self, '#e8463c', 5.5);
  }

  private dot(p: { x: number; z: number }, color: string, r: number): void {
    const ctx = this.map!;
    const m = this.world2map(p.x, p.z);
    ctx.beginPath();
    ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  private world2map(x: number, z: number): { x: number; y: number } {
    return { x: x * this.mapScale + this.mapOff.x, y: z * this.mapScale + this.mapOff.y };
  }

  setCountdown(text: string | null): void {
    $('countdown').classList.toggle('hidden', text === null);
    if (text !== null) $('countdown').textContent = text;
  }

  setWrongWay(on: boolean): void {
    $('wrongway').classList.toggle('hidden', !on);
  }

  setWaiting(on: boolean): void {
    $('waiting').classList.toggle('hidden', !on);
  }
}
```

- [ ] **Step 5: Write `client/src/game/game.ts`**

This is the orchestrator. Race logic hooks (`tracker`, positions, wrong-way) land in Task 13; multiplayer in Task 14; this version drives a single local car. Write it with those integration points present but inert:

```ts
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CarState, PlayerInfo, Progress, progressScore, STATE_HZ, TOTAL_LAPS } from '../../../shared/src/protocol';
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
```

Note: `CheckpointTracker` (Task 13) doesn't exist yet. To keep this task self-contained and runnable, create a stub `client/src/game/raceLogic.ts` now — Task 13 replaces it test-first:

```ts
export class CheckpointTracker {
  lap = 1;
  nextCp = 1;
  passed = 0;
  finished = false;
  constructor(
    public readonly numCps: number,
    public readonly totalLaps: number,
  ) {}
  hit(_i: number): 'none' | 'cp' | 'lap' | 'finish' {
    return 'none';
  }
}
```

- [ ] **Step 6: Replace the `?track` block in `client/src/main.ts` with practice mode**

Remove the Task 10 `?track` block and its imports, and add:

```ts
import { Game } from './game/game';
import { preloadCars } from './game/cars';

if (location.search.includes('practice')) {
  screens.show('none');
  const me = { id: 'solo', name: 'You', car: 'race' as const, isHost: true };
  preloadCars(['race'])
    .then(() =>
      Game.create(document.getElementById('game') as HTMLCanvasElement, 'solo', [me], { solo: 0 }, {
        sendState: () => {},
        sendFinished: () => {},
      }),
    )
    .then((game) => game.start(1500));
}
```

- [ ] **Step 7: Verify by driving**

Run: `npx tsc --noEmit` (exit 0), then open http://localhost:5173/?practice
Expected: countdown 1 → GO!, then the car drives with W/A/S/D and arrows: accelerates smoothly to ~135 km/h on the HUD, steers progressively (no jerk), Space slides the rear, S brakes then reverses slowly, hitting a barrier bounces you off and you keep control. Chase camera follows smoothly with a subtle FOV kick at speed. The top-right minimap shows the track outline with a red dot tracing your position; the lap and total timers tick up. 60 fps. If the car model visually drives backwards, set `MODEL_YAW = 0` in `cars.ts`.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: rapier arcade car physics, input, chase camera, drivable practice mode"
```

---

### Task 13: Race logic (TDD) + lap/position/wrong-way integration

**Files:**
- Modify: `client/src/game/raceLogic.ts` (replace stub)
- Test: `client/test/raceLogic.test.ts`
- Modify: `client/src/game/game.ts` (fill `updateRaceLogic`)

- [ ] **Step 1: Write the failing tests** — `client/test/raceLogic.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CheckpointTracker } from '../src/game/raceLogic';

describe('CheckpointTracker (4 checkpoints, 2 laps)', () => {
  const fresh = () => new CheckpointTracker(4, 2);

  it('starts on lap 1 expecting checkpoint 1 (cars start on the line)', () => {
    const t = fresh();
    expect(t.lap).toBe(1);
    expect(t.nextCp).toBe(1);
    expect(t.passed).toBe(0);
  });

  it('only the expected checkpoint counts', () => {
    const t = fresh();
    expect(t.hit(2)).toBe('none'); // skipping ahead ignored
    expect(t.hit(0)).toBe('none'); // start line again ignored
    expect(t.hit(1)).toBe('cp');
    expect(t.passed).toBe(1);
    expect(t.nextCp).toBe(2);
  });

  it('re-hitting the same checkpoint is idempotent', () => {
    const t = fresh();
    t.hit(1);
    expect(t.hit(1)).toBe('none');
    expect(t.passed).toBe(1);
  });

  it('crossing the start line after a full sequence increments the lap', () => {
    const t = fresh();
    for (const i of [1, 2, 3]) t.hit(i);
    expect(t.hit(0)).toBe('lap');
    expect(t.lap).toBe(2);
    expect(t.nextCp).toBe(1);
    expect(t.passed).toBe(4);
  });

  it('finishes after the final lap', () => {
    const t = fresh();
    for (const i of [1, 2, 3]) t.hit(i);
    t.hit(0); // lap 2
    for (const i of [1, 2, 3]) t.hit(i);
    expect(t.hit(0)).toBe('finish');
    expect(t.finished).toBe(true);
    expect(t.passed).toBe(8);
    expect(t.hit(1)).toBe('none'); // inert after finish
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/test/raceLogic.test.ts`
Expected: FAIL — the stub returns 'none' for everything.

- [ ] **Step 3: Replace `client/src/game/raceLogic.ts`**

```ts
/**
 * Tracks checkpoint sequence, laps, and total checkpoints passed.
 * Cars start ON the start line (checkpoint 0 pre-credited), so the first
 * expected gate is 1. Hitting 0 after a complete sequence = lap (or finish).
 */
export class CheckpointTracker {
  lap = 1;
  nextCp = 1;
  passed = 0;
  finished = false;

  constructor(
    public readonly numCps: number,
    public readonly totalLaps: number,
  ) {}

  hit(i: number): 'none' | 'cp' | 'lap' | 'finish' {
    if (this.finished || i !== this.nextCp) return 'none';
    this.passed++;
    this.nextCp = (this.nextCp + 1) % this.numCps;
    if (i === 0) {
      if (this.lap >= this.totalLaps) {
        this.finished = true;
        return 'finish';
      }
      this.lap++;
      return 'lap';
    }
    return 'cp';
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run client/test/raceLogic.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Fill in `updateRaceLogic()` in `client/src/game/game.ts`**

Replace the empty `updateRaceLogic` body with:

```ts
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
```

- [ ] **Step 6: Verify in practice mode**

Run: `npx tsc --noEmit && npx vitest run` (all green), then drive 3 full laps at http://localhost:5173/?practice
Expected: HUD lap counter advances to 2/3 then 3/3 exactly at the start line and the lap timer resets to 0:00.0 each lap while total time keeps running; position shows `1st/1`; turning around and driving backwards shows WRONG WAY; on finishing lap 3, "Finished! Waiting for others…" appears, both timers freeze at their final values, and controls freeze.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: checkpoint/lap tracking, live position, and wrong-way detection"
```

---

### Task 14: Multiplayer state sync wiring

**Files:**
- Modify: `client/src/main.ts` (wire countdown/state/playerLeft/results into Game)

- [ ] **Step 1: Wire the Game into the socket flow in `client/src/main.ts`**

Replace the whole file with:

```ts
import { PlayerInfo, ServerMsg } from '../../shared/src/protocol';
import { preloadCars } from './game/cars';
import { Game } from './game/game';
import { GameSocket } from './net/socket';
import { Screens } from './ui/screens';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const screens = new Screens();
let socket: GameSocket | null = null;
let selfId = '';
let roomCode = '';
let players: PlayerInfo[] = [];
let game: Game | null = null;

function connect(): Promise<GameSocket> {
  if (socket) return Promise.resolve(socket);
  const s = new GameSocket(onMessage, () => {
    socket = null;
    game?.dispose();
    game = null;
    screens.show('menu');
    screens.showError('Disconnected from server');
  });
  return s.ready().then(() => (socket = s));
}

function onMessage(msg: ServerMsg): void {
  switch (msg.type) {
    case 'created':
    case 'joined':
      selfId = msg.selfId;
      roomCode = msg.code;
      players = msg.players;
      screens.renderLobby(roomCode, players, selfId);
      screens.show('lobby');
      preloadCars(); // load all 4 models during lobby so race start is instant
      break;
    case 'lobby':
      players = msg.players;
      if (!game) screens.renderLobby(roomCode, players, selfId);
      break;
    case 'countdown': {
      const racers = players;
      screens.show('none');
      Game.create(canvas, selfId, racers, msg.grid, {
        sendState: (state) => socket?.send({ type: 'state', state }),
        sendFinished: (timeMs) => socket?.send({ type: 'finished', timeMs }),
      }).then((g) => {
        game = g;
        g.start(msg.countdownMs);
      });
      break;
    }
    case 'state':
      game?.onRemoteState(msg.id, msg.state);
      break;
    case 'playerLeft':
      game?.onPlayerLeft(msg.id);
      break;
    case 'results':
      game?.dispose();
      game = null;
      screens.renderResults(msg.standings);
      screens.show('results');
      break;
    case 'error':
      screens.showError(msg.message);
      break;
  }
}

screens.onCreate = (name) =>
  connect().then((s) => s.send({ type: 'create', name })).catch((e) => screens.showError(e.message));
screens.onJoin = (code, name) =>
  connect().then((s) => s.send({ type: 'join', code, name })).catch((e) => screens.showError(e.message));
screens.onPickCar = (car) => socket?.send({ type: 'pickCar', car });
screens.onStart = () => socket?.send({ type: 'start' });
screens.onBack = () => {
  screens.renderLobby(roomCode, players, selfId);
  screens.show('lobby');
};

if (location.search.includes('practice')) {
  const me: PlayerInfo = { id: 'solo', name: 'You', car: 'race', isHost: true };
  screens.show('none');
  preloadCars(['race'])
    .then(() =>
      Game.create(canvas, 'solo', [me], { solo: 0 }, { sendState: () => {}, sendFinished: () => {} }),
    )
    .then((g) => {
      game = g;
      g.start(1500);
    });
} else {
  screens.show('menu');
}
```

- [ ] **Step 2: Manual two-tab race test**

With server + vite running, open two tabs; create + join; host starts.
Expected: both tabs show synchronized countdown then GO; each tab sees the other car driving smoothly (no teleporting/stutter); deliberately ram the other car — your car gets shoved on impact; HUD position flips between 1st/2 and 2nd/2 as you overtake; the minimap shows the other car as a gray dot moving around the outline; closing tab 2 mid-race removes its car (and its minimap dot) in tab 1.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: multiplayer race wiring — remote cars, collisions, live ranking"
```

---

### Task 15: Full race flow — finish, results, return to lobby

- [ ] **Step 1: Manual full-loop test (no new code expected)**

Two tabs: race to completion (both finish 3 laps).
Expected: first finisher sees "Waiting for others…", second finisher triggers the results screen in BOTH tabs showing names + times in finishing order; clicking "Back to Lobby" returns to a working lobby (players intact, host crown correct); host can start a second race and everything works again.

- [ ] **Step 2: DNF path test**

Two tabs: tab 1 finishes all 3 laps, tab 2 closes its tab mid-race.
Expected: tab 1 gets the results screen immediately (all remaining players finished), with only itself listed.

- [ ] **Step 3: Fix anything found, then run the full check suite**

Run: `npx tsc --noEmit && npx vitest run` and the bot script (Task 6 command).
Expected: all green; `PASS — standings: …` from bots.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test: verify full race loop — finish, results, rematch, DNF"
```

---

### Task 16: Polish, README, final checklist

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# Velocity Rush

4-player browser racing: Three.js + Rapier client, Node.js WebSocket relay.

## Run

​```bash
npm install
npm run server   # ws relay on :8080
npm run dev      # client on http://localhost:5173
​```

Open multiple tabs (or send friends your LAN/deployed URL): enter a name,
Create Lobby, share the 4-letter code, host presses Start. First to 3 laps wins.

- Drive: WASD / arrows · Handbrake: Space
- Practice alone: http://localhost:5173/?practice

## Test

​```bash
npm test         # vitest: lobby, results, interpolation, race logic
npm run bots     # 4 headless bots e2e (needs server running)
​```

Car models: [Kenney Car Kit](https://kenney.nl/assets/car-kit) (CC0).
```

(Remove the zero-width characters around the inner code fences — they're only there to nest fences in this plan.)

- [ ] **Step 2: Performance pass**

Open the race with 2 tabs, check the browser performance HUD (`F12` → Performance monitor or FPS meter):
Expected: steady ~60 fps during racing with both cars visible. If below: confirm `setPixelRatio` cap is active, shadow map is 2048 and only the sun casts shadows, and instanced meshes are used for walls/trees (all already in the code — this step verifies, fixes only if needed).

- [ ] **Step 3: Final full verification**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: 0 type errors; all ~21 tests pass. Then one last 2-tab race start-to-results.

- [ ] **Step 4: Commit and push**

```bash
git add -A && git commit -m "docs: README with run/test instructions; final polish"
git push
```

---

## Self-review (done at planning time)

- **Spec coverage:** lobby+codes+host start (Tasks 3,5,8), 4-player cap (T3), car exclusivity (T3,8), countdown+grid (T5,12,14), client physics + kinematic remotes + PvP collision (T12,14), interpolation 120 ms (T9,12), checkpoints/laps/anti-shortcut (T13), HUD speed/lap/position/lap-time/total-time/minimap (T7,12,13), wrong-way (T13), results incl. DNF-by-progress + 60 s timeout (T4,5), disconnect handling (T5,15), solo practice (T12), perf budget (T10,16), bots e2e (T6), README (T16). Draco compression was in the spec; Kenney GLBs are small (<1 MB) so Draco adds no value — consciously dropped (YAGNI).
- **Type consistency:** `Progress {passed,dist}`, `progressScore`, `CarState {p,q,progress}`, `countdown {countdownMs, grid}` used identically in protocol (T2), server (T5), bots (T6), game (T12–14). `CheckpointTracker` fields `lap/nextCp/passed/finished` match between stub (T12), tests and implementation (T13), and `game.ts` usage.
- **Placeholders:** none — every code step contains complete code; manual steps state exact expected behavior.
```
