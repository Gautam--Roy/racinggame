# Velocity Rush

A 3D, 4-player browser racing game. Three.js + Rapier physics on the client,
a lightweight Node.js WebSocket relay for lobbies and state sync. Each browser
simulates its own car at full fidelity (zero input latency); the server relays
positions ~20×/sec and remote cars are interpolated, so player-vs-player
collisions feel physical.

> **3 laps · up to 4 players · host decides when to start.**

## Run

```bash
npm install
npm run server   # WebSocket relay on ws://localhost:8080
npm run dev      # client on http://localhost:5173
```

Open the client, enter a name, and **Create Lobby** — you'll get a 4-letter room
code. Share it; up to 3 friends **Join** with the code (same machine in another
tab, your LAN, or a deployed URL). The host presses **Start Race**. First to
complete 3 laps wins; the results screen shows final standings.

- **Drive:** `W`/`A`/`S`/`D` or arrow keys · **Handbrake:** `Space` · **Turbo:** `Shift` (grab the glowing pickups) · **Horn:** `H` · **Mute:** `M`
- **Practice solo:** http://localhost:5173/?practice

The HUD shows speed, lap, live position, current lap time, total race time, and
a track map with live car dots.

## Test

```bash
npm test         # vitest: lobby state machine, results collation,
                 #   snapshot interpolation, car normalization, race logic
npm run e2e      # self-contained: boots a server + 4 headless bots through
                 #   lobby → race → results end-to-end
```

## How it works

| Layer | Where | Notes |
|-------|-------|-------|
| Lobby / rooms | `server/src/lobby.ts` | room codes, 4-player cap, host promotion, exclusive car picks |
| Relay + orchestration | `server/src/server.ts` | countdown, 20 Hz state rebroadcast, results (incl. 60 s DNF timeout) |
| Message protocol | `shared/src/protocol.ts` | typed `ClientMsg`/`ServerMsg`, shared by both sides |
| Physics + game loop | `client/src/game/` | Rapier world, arcade car controller, fixed 60 Hz step with render interpolation |
| Track | `client/src/game/track.ts` | Catmull-Rom circuit, barriers, 16 checkpoints, deterministic scenery |
| Networking | `client/src/net/` | WebSocket client + snapshot buffer (remote cars rendered ~120 ms in the past) |
| UI | `client/src/ui/` | title / lobby / HUD / results screens + canvas minimap |

Architecture and design rationale: `docs/superpowers/specs/2026-06-12-multiplayer-racing-game-design.md`.
Implementation plan: `docs/superpowers/plans/2026-06-12-racing-game.md`.

## Deploy

The server can serve the built client itself (single container, no separate
static host needed). `server/src/index.ts` picks static-serving mode when
`STATIC_DIR` is set (or `client/dist` exists); otherwise it falls back to the
plain WebSocket-only relay used in development.

### Docker Compose behind an existing Traefik

```bash
cp .env.example .env    # set RACING_DOMAIN (and any Traefik overrides)
docker compose up -d --build
```

`docker-compose.yml` publishes no host ports — it joins the external
`traefik` network and lets Traefik route to it via labels.

| Variable | Default | Purpose |
|---|---|---|
| `RACING_DOMAIN` | *(required)* | Hostname Traefik routes to this service |
| `TRAEFIK_ENTRYPOINT` | `websecure` | Traefik entrypoint name |
| `CERT_RESOLVER` | `letsencrypt` | Traefik ACME cert resolver name |
| `TRAEFIK_NETWORK` | `traefik` | External Docker network Traefik listens on |

### Local container test (no Traefik)

```bash
docker build -t racinggame .
docker run --rm -p 8080:8080 racinggame
```

Open http://localhost:8080.

### Plain Node production (no Docker)

```bash
npm run build                                    # vite build + esbuild server bundle
STATIC_DIR=client/dist PORT=8080 node server-dist/index.mjs
```

## Credits

Car models: [Kenney Car Kit](https://kenney.nl/assets/car-kit) (CC0). License
included at `client/public/models/cars/License.txt`.
