# Design: Polish Pass — Dynamism, Sound, Spectators, Deployment

**Date:** 2026-07-02
**Status:** Approved
**Builds on:** `2026-06-12-multiplayer-racing-game-design.md` (v1 shipped)

## Summary

v1 plays correctly but feels static. This pass adds sound, motion feel,
overtaking mechanics (turbo pickups + slipstream + horn), an animated spectator
atmosphere with TV cameras, doubles the car roster to 8, and makes the game
deployable as a single Docker container behind traefik.

## Requirements

1. **Sound** — engine (speed-pitched), countdown beeps, collision thumps,
   horn (`H`, heard by all players, distance-attenuated), turbo whoosh, crowd
   ambience swelling near grandstands. Mute via `M` + HUD button. All sounds
   synthesized with Web Audio (no binary assets; CC0-clean).
2. **Dynamism** — wheels spin with speed and front wheels steer visually; car
   body rolls in corners and pitches under accel/brake; drift smoke on
   handbrake slides; turbo exhaust flames; speed-scaled camera shake.
3. **Overtaking** — turbo pickup pads on the road (bank up to 2 charges,
   `Shift` to fire: ~2.5 s of +40 % top speed / +60 % accel; pads respawn 10 s
   after taken; pickup events relayed so all clients agree). Slipstream: close
   behind another car builds a draft speed bonus.
4. **Spectators** — 4 roofed, tiered grandstand booths at viewing corners with
   hundreds of instanced low-poly spectators in varied colors, bobbing/waving;
   cheering audio swells when cars pass. TV camera props (tripod + camera box)
   in stands and around the track that pan toward the nearest car.
5. **Cars** — 8 selectable models (add `hatchback-sports`, `police`, `taxi`,
   `ambulance`); lobby picker becomes a grid with color swatches and display
   names; picks remain exclusive; controls hint shown in lobby; HUD turbo
   charge indicator.
6. **Deployment** — production mode: the Node server serves the built client
   statics AND the WebSocket on one port. Client connects same-origin
   (`wss://` under https) in production, `:8080` in dev. Multi-stage
   Dockerfile (vite build + esbuild-bundled server → `node:22-alpine`),
   `docker-compose.yml` with traefik labels (Host rule, websecure entrypoint,
   cert resolver, external traefik network — all env-configurable), no host
   ports. `.dockerignore`. README deploy section. No existing Docker
   conventions on the user's remotes to inherit (verified).

## Protocol additions (shared/src/protocol.ts)

- `CAR_MODELS` grows to 8: `['race','race-future','sedan-sports','suv','hatchback-sports','police','taxi','ambulance']`
- `CarState` gains `b?: boolean` (turbo active — drives remote flame visuals)
- `ClientMsg` adds `{type:'horn'}` and `{type:'pickup'; idx:number}`
- `ServerMsg` adds `{type:'horn'; id:string}` and `{type:'pickup'; idx:number; id:string}`
- Server relays both only while the room phase is `racing` (same trust model as state relay)

## Non-goals

Anti-cheat, real audio samples, postprocessing, mobile controls, multiple
tracks, spectator-mode clients. Performance budget unchanged (60 fps target,
capped DPR, instancing, one shadow light).

## Testing

- Vitest: protocol relay additions (server), pickup-respawn timing logic and
  slipstream math where extracted as pure functions.
- Bot e2e extended: horn + pickup relay assertions.
- Headless-browser verification: audio manager constructs without error
  (context state), turbo pickup → charge → boost speed delta, spectators/
  cameras render (pixel + object-count checks), full drive still passes.
- `docker build` + container smoke test (serves client, ws handshake works).
