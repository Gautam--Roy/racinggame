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
