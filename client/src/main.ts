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
    selfId = ''; roomCode = ''; players = [];
    screens.show('menu');
    screens.showError('Disconnected from server');
  });
  return s.ready().then(() => (socket = s));
}

function onMessage(msg: ServerMsg): void {
  switch (msg.type) {
    case 'created':
    case 'joined':
      screens.showError('');
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
