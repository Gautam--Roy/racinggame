# Polish Pass Implementation Plan — Dynamism, Sound, Spectators, Deployment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the shipped v1 racer feel alive (sound, motion, overtaking, crowd) and deployable as one traefik-ready Docker container.

**Architecture:** All additions layer onto the existing modules; the only cross-cutting changes are small protocol additions (horn/pickup/turbo flag) and a production static-serving mode in the server. Spec: `docs/superpowers/specs/2026-07-02-polish-dynamism-deploy-design.md`.

**Tech stack unchanged:** TypeScript, Vite, Three.js, Rapier, ws, Vitest. New: Web Audio API (no deps), esbuild (already ships inside vite) for the server bundle.

**Working conventions for implementers:** the codebase exists and is reviewed — READ the files you touch first and match their style. Forward is −Z; 1 unit = 1 m; physics fixed 60 Hz; render loop decoupled. `npx tsc --noEmit` and `npx vitest run` must be green before every commit. Vite dev server: `npx vite` (:5173); relay: `npm run server` (:8080); browser checks use puppeteer-core + `/usr/bin/chromium` with `--use-angle=swiftshader`.

---

### Task 1: Protocol + server relay for horn / pickup / turbo flag (TDD)

**Files:** Modify `shared/src/protocol.ts`, `server/src/server.ts`, `server/test/lobby.test.ts` (new describe or new test file `server/test/relay.test.ts`), `scripts/bots.ts`.

- [ ] Protocol: `CAR_MODELS` → 8 entries (`'race','race-future','sedan-sports','suv','hatchback-sports','police','taxi','ambulance'`); `CarState` gains optional `b?: boolean`; `ClientMsg` adds `{ type: 'horn' }` and `{ type: 'pickup'; idx: number }`; `ServerMsg` adds `{ type: 'horn'; id: string }` and `{ type: 'pickup'; idx: number; id: string }`.
- [ ] Server (`handle` switch): `horn` → if room phase `racing`, broadcast `{type:'horn', id: conn.id}` to others; `pickup` → same shape with `idx` passed through (validate `Number.isInteger(msg.idx) && msg.idx >= 0`).
- [ ] Tests first where testable: extract nothing new in lobby.ts (relay is wiring); instead extend `scripts/bots.ts` e2e — after countdown, bot A sends `horn` and `pickup {idx:2}`; assert bots B–D each receive `{type:'horn', id:<A>}` and `{type:'pickup', idx:2, id:<A>}`. Keep the existing standings assertion intact.
- [ ] Note: 8 car models means the lobby default-car assignment test ("distinct default cars") still passes unchanged; verify.
- [ ] Verify `npm run e2e` prints PASS. Commit: `feat: protocol + relay for horn, turbo pickups, and turbo state flag`

### Task 2: Audio system + horn wiring

**Files:** Create `client/src/game/audio.ts`; modify `client/src/game/game.ts`, `client/src/game/input.ts`, `client/src/main.ts`, `client/src/ui/hud.ts`, `client/index.html`, `client/src/ui/style.css`.

- [ ] `audio.ts` exports `class AudioManager` (all Web Audio, one shared `AudioContext` created lazily on first user gesture — call `.unlock()` from a click handler in main.ts):
  - `engine(speedRatio, turbo)` — sawtooth osc (80→340 Hz by speedRatio, +25 % while turbo) + square sub-osc one octave down through a lowpass (400→2600 Hz); gain ~0.08 idle → 0.16 flat out. Update per frame.
  - `countdownBeep(final)` — 880 Hz sine 120 ms (non-final), 1320 Hz 350 ms (final/GO).
  - `horn(distanceRatio)` — dual square oscs 370 + 466 Hz, 400 ms, gain scaled `1/(1+3*distanceRatio)`. `distanceRatio` = dist/120 clamped 0..1; own horn ratio 0.
  - `collision(intensity)` — 80 ms lowpass-filtered white-noise burst, gain ∝ clamp(intensity).
  - `turboWhoosh()` — 600 ms bandpass noise sweep 300→3000 Hz.
  - `crowd(proximityRatio)` — looped pink-noise bed (pre-rendered 2 s AudioBuffer, loop=true) through bandpass ~900 Hz; base gain 0.015, scaled up to 0.09 by proximity; call per frame with `1 - clamp(distToNearestStand/140)`. Random cheer swells: every 3–7 s a short gain envelope ×2. (Grandstand positions injected via `setCrowdSources(Vector3[])` — Task 5 wires real stands; until then pass `[]` and crowd stays at base.)
  - `setMuted(m)` / `toggleMuted()` master gain 0 ⇄ 1; expose `muted`.
- [ ] game.ts integration: create AudioManager in `Game.create`; countdown tick plays beeps (final on GO); per-frame `engine(speed/MAX_SPEED, turboActive)`; collision detection = drop in own horizontal speed > 6 m/s between consecutive fixed steps while racing → `collision((drop-6)/12)`; dispose() closes/stops audio.
- [ ] Horn: input.ts adds `hornPressed` edge-detect on `KeyH`; game.ts on edge → `cb.sendHorn()` (new GameCallbacks member) + local `audio.horn(0)`. main.ts wires `sendHorn: () => socket?.send({type:'horn'})` (no-op in practice). New Game method `onHorn(id)` → look up remote car distance → `audio.horn(clamp(dist/120))`; main.ts routes the `horn` ServerMsg to it.
- [ ] Mute: `M` key (input edge) + HUD button `#mute-btn` (add to index.html inside #hud, pointer-events auto, styled top-left under #pos) toggling 🔊/🔇 via `hud.setMuted(bool)`.
- [ ] Browser check: practice mode — page evaluate that `AudioContext` state becomes `running` after a synthetic click + key press, no page errors. Commit: `feat: web-audio soundscape — engine, horn, countdown, collisions, crowd bed`

### Task 3: Feel pass — wheels, body tilt, particles, camera shake

**Files:** Create `client/src/game/effects.ts`; modify `client/src/game/cars.ts`, `client/src/game/game.ts`, `client/src/game/camera.ts`.

- [ ] cars.ts: after normalize, collect wheel nodes by name (`wheel-front-left`, `wheel-front-right`, `wheel-back-left`, `wheel-back-right` — confirmed present in the GLBs) into `userData.wheels = {fl, fr, bl, br}` on the returned group (clone(true) preserves hierarchy; re-find by name on each instantiated clone via a helper `findWheels(group)` exported for game.ts). Fallback car: build wheels as named meshes so the same helper works.
- [ ] game.ts per-frame car animation (own + remotes):
  - wheel spin: rotate each wheel mesh around X by `(speed/wheelRadius)*dt` (approx radius 0.34; direction from signed forward speed — remotes: estimate speed from interpolated position delta).
  - front-wheel steer: set fl/fr `rotation.y = steer * 0.45` (own car uses input.steer; remotes skip steer).
  - body tilt: wrap the visual model in an inner `tiltGroup` (cars.ts normalize already returns wrapper→inner; reuse inner): target roll `= -lateralAccel * 0.02` clamp ±0.09 rad, pitch `= longAccel * 0.012` clamp ±0.06, lerped at 8/s. Compute accels from per-step velocity deltas (own) / position 2nd-derivative (remotes, heavily smoothed, half amplitude).
- [ ] effects.ts: one `THREE.Points` pool (400 particles, additive, size attenuation, vertex alpha fade) with `spawn(pos, vel, life, size, color)` + `update(dt)`; used for
  - drift smoke: gray puffs at rear wheel world positions while handbrake && speed > 8 (own car; remotes when their |lateral drift| inferred > threshold — skip if noisy, own-only acceptable),
  - turbo flames: orange/yellow short-lived jets from the rear while `b` (own or remote state flag) — 6/frame.
- [ ] camera.ts: add positional shake — `cam.position += randomInSphere * 0.05 * (speed/MAX_SPEED)^2` after placement, plus +50 % briefly while turbo (hook via update param `turbo: boolean`).
- [ ] Browser check: practice — screenshot during handbrake slide shows smoke pixels near car (sample gray-ish cluster) or at minimum `effects.count > 0` exposed via a debug hook; wheels rotate (evaluate a wheel node's rotation.x changes over 500 ms). No page errors, fps floor unchanged (frame counter ≥ prior ~20 fps under swiftshader). Commit: `feat: motion feel — spinning/steering wheels, body tilt, drift smoke, turbo flames, camera shake`

### Task 4: Turbo pickups + slipstream + HUD indicator

**Files:** Create `client/src/game/pickups.ts`, `client/test/pickups.test.ts`; modify `client/src/game/physics.ts`, `client/src/game/game.ts`, `client/src/game/input.ts`, `client/src/ui/hud.ts`, `client/index.html`, `client/src/ui/style.css`, `client/src/main.ts`.

- [ ] pickups.ts (TDD the pure state machine first):
  ```ts
  export const PICKUP_US = [0.12, 0.31, 0.55, 0.68, 0.86]; // spline u positions, center of road
  export const RESPAWN_MS = 10_000;
  export class PickupBoard {
    takenAt = new Map<number, number>();
    available(idx: number, now: number): boolean;
    take(idx: number, now: number): boolean; // false if already taken & not respawned
  }
  ```
  Tests: fresh board all available; take → unavailable; available again at `now + RESPAWN_MS`; double-take rejected; independent indices.
  Visuals: spinning icosahedron (r 0.9, emissive cyan) floating 1.2 m over `curve.getPointAt(u)`, bobbing; hidden while taken, reappears on respawn — `buildPickups(scene)` returns `{meshes, board}` and an `update(now, dt)` that spins/bobs/toggles visibility.
- [ ] game.ts: own-car overlap test (horizontal dist < 3 m, available) → `board.take` + `cb.sendPickup(idx)` + bank charge (`charges = min(charges+1, 2)`) + `audio.turboWhoosh()` half-gain; `onPickup(idx, id)` from network → `board.take(idx, now)` (mirror). `Shift` edge (input.ts `turboPressed`) with charges > 0 → `charges--`, `turboUntil = now + 2500`, whoosh full. Expose `turboActive` getter; include `b: turboActive` in outgoing CarState; remote flames read `state.b`.
- [ ] physics.ts `driveCar` gains an `opts: {turbo: boolean; slipBonus: number}` param: effective `maxSpeed = MAX_SPEED * (turbo ? 1.4 : 1 + slipBonus)`, `engineAccel = ENGINE_ACCEL * (turbo ? 1.6 : 1 + slipBonus)`.
- [ ] Slipstream (pure function in pickups.ts or physics.ts, unit-tested): for each remote, if it is 4–14 m AHEAD of own car (positive projection on own forward), lateral offset < 2.2 m, and own speed > 15 → target bonus 0.15, else 0; smooth current bonus toward target at 1.2/s. `slipstreamTarget(ownPos, ownFwd, ownSpeed, remotes[]) : number` — tests: in-window remote → 0.15; too far/lateral/slow → 0.
- [ ] HUD: `#turbo` element (bottom-right above laptime): shows `⚡×N` charges, pulses while boost active (`hud.setTurbo(charges, active)`); style consistent with existing HUD.
- [ ] main.ts: wire `sendPickup` callback + route `pickup` ServerMsg → `game.onPickup`.
- [ ] Browser check: practice — drive to first pickup (autopilot or scripted straight if reachable; simpler: temporarily evaluate distance and use existing pure-pursuit snippet from prior E2E), assert `#turbo` shows ⚡×1, press Shift, sample speed exceeding 140 km/h (>38 m/s base cap). Commit: `feat: turbo pickups with respawn, slipstream draft, boost HUD`

### Task 5: Spectators, grandstands, TV cameras

**Files:** Create `client/src/game/spectators.ts`; modify `client/src/game/game.ts` (add group + per-frame update + crowd audio source wiring), `client/src/game/track.ts` (export a helper `trackFrame(u)` returning {pos, tangent, side} if not already derivable).

- [ ] `buildSpectators(curve)` returns `{ group, stands: Vector3[], update(t, carPositions) }`:
  - 4 grandstands at u ≈ 0.02, 0.3, 0.55, 0.8, placed `side * (ROAD_WIDTH/2 + 7)` from the road, rotated to face it: 3 tiered steps (BoxGeometry rows 14 m wide), roof slab on 4 corner posts, side panels, saturated awning color per stand.
  - crowd: merged capsule-ish body (cylinder+sphere head) geometry in ONE `InstancedMesh` per stand (~110 instances/stand, `setColorAt` varied via HSL), each row seated on a tier with jitter.
  - cheer animation: per-instance phase array; `update(t)` recomposes instance matrices with `y += |sin(t*2.2 + phase)| * 0.18` and small alternating arm-less body sway (rotZ ±0.06) — update every other frame to halve cost; `instanceMatrix.needsUpdate = true`.
  - TV cameras: `buildCamera()` prop (tripod legs = 3 thin cylinders, camera = box + lens cylinder, ~1.7 m tall); place 1 at each stand's front corner + 3 ground spots (u ≈ 0.15, 0.45, 0.7, off-road opposite side); `update` yaw-lerps each camera head toward the nearest car position (slerp 3/s).
- [ ] game.ts: add to scene; call `update(nowSec, [own + remote positions])` each frame; pass `stands` to `audio.setCrowdSources(...)`; crowd proximity per frame = nearest-stand distance.
- [ ] Guard perf: total added draw calls ≤ ~12 (4 stands × structure merged + 4 instanced crowds + camera props merged where possible); no per-frame allocations in `update` (preallocate Matrix4/Vector3 scratch).
- [ ] Browser check: `?track` orbit — object count/pixel checks (stands visible: sample expected awning colors present in screenshot); practice drive past a stand with audio unlocked → no errors; fps floor unchanged. Commit: `feat: animated grandstand crowds and track-side TV cameras`

### Task 6: 8-car roster + lobby picker grid + UI polish

**Files:** Modify `client/src/game/cars.ts` (ACCENT + DISPLAY names for 8), `client/src/ui/screens.ts` (picker grid), `client/src/ui/style.css`, `client/index.html` (controls hint element in #lobby), copy 4 new GLBs.

- [ ] Assets: from `/tmp/carkit/Models/GLB format/` copy `hatchback-sports.glb`, `police.glb`, `taxi.glb`, `ambulance.glb` into `client/public/models/cars/` (re-download the kit per Task 11 of the v1 plan if /tmp is gone; texture `Textures/colormap.png` already shipped).
- [ ] cars.ts: extend `ACCENT` for the 4 new models (police 0x2a4ad8, taxi 0xd8b02a, ambulance 0xd84a4a, hatchback-sports 0x8a2ad8) and add `CAR_DISPLAY: Record<CarModel, string>` (`Racer, Future GP, Sport Sedan, SUV, Hot Hatch, Police, Taxi, Ambulance`).
- [ ] screens.ts renderLobby: picker becomes a 4×2 grid of buttons, each with a color swatch dot (ACCENT via inline style) + display name; keep `mine`/`taken` classes and exclusivity flow; lobby hint line: `Drive WASD/arrows · Space handbrake · Shift turbo · H horn · M mute`.
- [ ] Verify default-assignment still distinct (protocol order gives first-free), two-tab manual/automated lobby check: 8 buttons, picking updates both tabs. Commit: `feat: 8-car roster with display names and swatch picker grid`

### Task 7: Production serving, Docker, traefik compose, docs, final verification

**Files:** Modify `server/src/index.ts` (static serving), `client/src/net/socket.ts` (URL logic), `package.json` (scripts), `README.md`; create `server/src/static.ts`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`.

- [ ] `server/src/static.ts`: ~50-line static file handler (root dir param): maps extensions {html,js,css,png,glb,json,txt,ico,wasm} to content-types, resolves within root (reject `..`), serves `index.html` for `/`, 404 otherwise. `server/src/index.ts`: if `process.env.STATIC_DIR` set (or `client/dist` exists), create `http.createServer(staticHandler)`, attach `new WebSocketServer({ server })` (refactor `createGameServer` to accept `{port} | {server}`), listen once. Dev behavior unchanged (`npm run server` → ws-only :8080 when no dist).
- [ ] socket.ts URL: `location.port === '5173' ? ws://hostname:8080 : (https ? wss : ws)://location.host`.
- [ ] `Dockerfile` (multi-stage):
  ```dockerfile
  FROM node:22-alpine AS build
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci
  COPY . .
  RUN npx vite build \
   && npx esbuild server/src/index.ts --bundle --platform=node --format=esm \
      --outfile=server-dist/index.mjs --external:bufferutil --external:utf-8-validate

  FROM node:22-alpine
  WORKDIR /app
  ENV NODE_ENV=production PORT=8080 STATIC_DIR=/app/public
  COPY --from=build /app/client/dist ./public
  COPY --from=build /app/server-dist/index.mjs ./index.mjs
  EXPOSE 8080
  USER node
  CMD ["node", "index.mjs"]
  ```
  (vite build outputs `client/dist` because vite root is `client`.)
- [ ] `docker-compose.yml` — traefik-ready, no host ports:
  ```yaml
  services:
    racinggame:
      build: .
      restart: unless-stopped
      networks: [traefik]
      labels:
        - traefik.enable=true
        - traefik.http.routers.racinggame.rule=Host(`${RACING_DOMAIN:?set RACING_DOMAIN in .env}`)
        - traefik.http.routers.racinggame.entrypoints=${TRAEFIK_ENTRYPOINT:-websecure}
        - traefik.http.routers.racinggame.tls.certresolver=${CERT_RESOLVER:-letsencrypt}
        - traefik.http.services.racinggame.loadbalancer.server.port=8080
  networks:
    traefik:
      external: true
      name: ${TRAEFIK_NETWORK:-traefik}
  ```
  plus `.env.example` documenting RACING_DOMAIN / TRAEFIK_ENTRYPOINT / CERT_RESOLVER / TRAEFIK_NETWORK.
- [ ] `.dockerignore`: node_modules, client/dist, server-dist, docs, logs, .git, *.md keep README? (exclude docs+.git+node_modules at minimum).
- [ ] package.json scripts: `"build": "vite build && esbuild server/src/index.ts --bundle --platform=node --format=esm --outfile=server-dist/index.mjs --external:bufferutil --external:utf-8-validate"`, `"start": "STATIC_DIR=client/dist PORT=8080 node server-dist/index.mjs"` (approx; keep consistent).
- [ ] README: Deploy section (docker compose up -d behind traefik, env vars, local test via `docker run -p 8080:8080` then http://localhost:8080).
- [ ] Verification suite: `npx tsc --noEmit`; `npx vitest run`; `npm run e2e`; production smoke — `npm run build && STATIC_DIR=client/dist PORT=8090 node server-dist/index.mjs &` then curl / (200 html), curl a glb (200), ws handshake via bots with WS_URL=ws://localhost:8090, THEN kill; `docker build -t racinggame .` and `docker run -d -p 8091:8080` + same curl/ws smoke + `docker rm -f` (skip gracefully with a report note if the docker daemon is unavailable); full autopilot browser race against the production container. Commit: `feat: production static serving + traefik-ready Docker deployment`

---

## Self-review

- Spec coverage: sound (T2), dynamism (T3), turbo/slipstream/overtaking + HUD (T4, protocol T1), horn (T1+T2), spectators/booths/cheer/cameras (T5), 8 cars + picker (T1 protocol + T6), Docker/traefik/static prod serving (T7), quality/perf guards in each task. Crowd audio bridges T2→T5 via `setCrowdSources` (explicit stub contract).
- Type consistency: `CarState.b` optional (old clients irrelevant — same build ships both sides); GameCallbacks grows `sendHorn`/`sendPickup` (T2/T4 both touch — T4 reads T2's shape as committed, both defined here).
- No placeholders: concrete constants everywhere; Docker/compose given verbatim.
