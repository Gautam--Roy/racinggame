# Design: 4-Player Browser Racing Game

**Date:** 2026-06-12
**Status:** Approved

## Summary

A 3D multiplayer racing game that runs in the browser at a smooth 60 fps. Up to 4
players join a lobby via room code, pick distinct high-quality car models, and race
3 laps on a closed circuit. The host decides when the race starts. Players collide
with each other physically. A HUD shows speed, lap, and live race position.

## Requirements

- Browser-based, smooth (target 60 fps on a mid-range laptop)
- High-quality/fidelity car models
- Smooth, intuitive controls
- Multiplayer over the internet, max 4 players per room
- Player-vs-player collision detection
- HUD with speed and live race positions
- Lobby system with room codes; host-controlled race start

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Networking | Node.js WebSocket relay server (`ws`) | Works over the internet, simple room codes, easy to deploy; no NAT traversal issues |
| Physics authority | Client-side physics, server relays state | Zero input latency — controls feel instant; standard for 4-player casual racers |
| Physics engine | Rapier (WASM) | Fast, deterministic, good Three.js interop |
| Driving feel | Arcade-tuned forces on a dynamic rigid body | Smooth and intuitive; collisions still feel physical |
| Car assets | Free CC0/CC-BY glTF models (Poly Pizza / Kenney / Sketchfab) | Real modeled fidelity at zero cost; 4 distinct cars |
| Race format | One looped circuit, 3 laps | Focused scope; everything polished |
| Renderer | Vanilla Three.js (no React) + Vite + TypeScript | Render loop free of framework overhead |

## Architecture

```
client (browser)                server (Node.js)              other clients
┌──────────────────┐            ┌──────────────────┐
│ Rapier: own car  │─ pos 20Hz ▶│ lobby manager    │──▶ rebroadcast to room
│ (dynamic body)   │            │ race orchestrator│
│ remote cars      │◀─ pos ─────│ state relay      │◀── their pos 20Hz
│ (kinematic)      │            │ (no physics)     │
└──────────────────┘            └──────────────────┘
```

Monorepo layout:

```
racinggame/
├── client/          # Vite + TS + Three.js + Rapier
├── server/          # Node + ws: lobby, relay, results
└── shared/          # message protocol types (imported by both)
```

## Server

### Lobby manager
- `createLobby(name)` → 4-letter room code; creator becomes host.
- `joinLobby(code, name)` → error if room not found or full (max 4).
- Players pick one of 4 cars; picks are exclusive per room.
- Lobby state (player list, car picks, host flag) broadcast on every change.
- Host leaves in lobby → next player promoted to host. Empty room → deleted.

### Race orchestrator
- Only the host may send `startRace`. Solo start allowed (practice/testing).
- On start: broadcast synchronized 3-2-1 countdown, assign grid slots, enter
  racing state.
- Each client reports its own finish (3 laps done) with its local race time;
  server collates into final standings and broadcasts results when all finish
  (or 60 s after the first finisher, whichever comes first; non-finishers are
  ranked by race progress).

### State relay
- Receives each client's car transform + race progress ~20×/s, rebroadcasts to
  the rest of the room. No physics, no validation of movement (trusted clients —
  acceptable for casual play with friends).
- Disconnect mid-race: car removed from everyone's world; race continues.

## Client

### Net layer
- WebSocket client; JSON messages typed by `shared/` protocol.
- Snapshot buffer per remote player; remote cars render ~120 ms in the past,
  interpolating position/quaternion between snapshots to hide jitter.

### Physics
- Rapier world stepped at fixed 60 Hz with an accumulator; rendering
  interpolates between physics states so visuals are smooth at any refresh rate.
- Own car: dynamic rigid body driven by arcade-tuned forces — engine force,
  speed-sensitive steering, lateral grip with forgiving slip, handbrake reduces
  rear grip for slides.
- Remote cars: kinematic position-based bodies at interpolated network
  transforms → bumping a remote car physically shoves the local car.
- Track barriers and ground: static colliders (trimesh/cuboids).

### Track
- One closed circuit from a Catmull-Rom spline: extruded road mesh with curbs,
  start/finish gantry, barriers, instanced environment props (trees,
  grandstands), skybox, ground plane.
- Invisible checkpoint gates distributed along the spline drive lap counting and
  position calculation.

### Cars
- 4 distinct CC0/CC-BY glTF car models, Draco-compressed, preloaded during lobby.
- Each visually distinct (color/style) so players are instantly recognizable.

### Controls
- WASD / arrow keys: throttle, brake/reverse, steer; Space = handbrake.
- Steering input is smoothed (lerped) so keyboard taps don't jerk the car.

### Race logic
- Checkpoints must be crossed in sequence (anti-shortcut); crossing the full
  sequence past start/finish increments the lap (3 laps total).
- Live position = ordering by (lap, checkpoint index, distance to next gate);
  progress is included in the 20 Hz state message so all clients rank
  identically.
- Wrong-way detection from movement direction vs. spline tangent.
- On finishing lap 3: report finish + race time to server; show results screen
  with final standings.

### Camera
- Chase camera with positional lag/lerp and slight FOV increase at high speed.

### UI (HTML/CSS overlay)
- **Title screen:** name entry, Create Lobby, Join Lobby (code input).
- **Lobby screen:** room code display, player list with car picks, car picker,
  Start button (host only; disabled for others).
- **HUD:** speedometer (km/h), lap `n/3`, position `nth/total`, countdown
  overlay, wrong-way indicator.
- **Results screen:** final standings table, back-to-lobby button.

## Performance Budget

- Capped `devicePixelRatio` (max 2), single shadow-casting directional light +
  hemisphere ambient, instanced scenery, compressed textures, no postprocessing.
- Target: 60 fps on a mid-range laptop.

## Error Handling

- Join failures surface friendly messages ("Room not found", "Lobby full",
  "Race already started").
- Server validates capacity and name length; ignores malformed messages.
- Mid-race disconnect removes that player's car everywhere; race continues.
- Host disconnect in lobby promotes next player; in race, no special handling
  (relay continues; results collate among remaining players).
- No reconnect-to-race in v1.

## Testing

- **Vitest unit tests:** server lobby/room state machine (create/join/full/host
  promotion/car-pick exclusivity), race orchestration (start gating, results
  collation), and pure client race logic (checkpoint sequencing, lap counting,
  position ordering).
- **Shared protocol types** prevent client/server message drift.
- **Headless bot script:** drives 4 fake WebSocket clients through
  lobby → race → finish to exercise the server end-to-end.
- **Manual playtesting:** multiple browser tabs against the local server.

## Out of Scope (v1)

- Server-authoritative physics / anti-cheat
- Multiple tracks, reconnection, spectators, mobile/touch controls, audio,
  minimap, postprocessing effects
