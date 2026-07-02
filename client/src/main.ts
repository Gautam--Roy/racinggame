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
    selfId = ''; roomCode = ''; players = [];
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
      screens.showError('');
      selfId = msg.selfId;
      roomCode = msg.code;
      players = msg.players;
      screens.renderLobby(roomCode, players, selfId);
      screens.show('lobby');
      preloadCars().catch(() => {}); // warm all 4 models during lobby; missing models fall back per-car
      break;
    case 'lobby':
      players = msg.players;
      if (!game) screens.renderLobby(roomCode, players, selfId);
      break;
    case 'countdown': {
      const racers = players;
      game?.dispose(); // defensive: never leak a prior race's world/renderer/RAF if a second countdown arrives
      game = null;
      screens.show('none');
      // state frames arriving before Game.create() resolves are dropped (game is null);
      // benign — cars spawn at their grid pose and 120ms interpolation absorbs the gap.
      Game.create(canvas, selfId, racers, msg.grid, {
        sendState: (state) => socket?.send({ type: 'state', state }),
        sendFinished: (timeMs) => socket?.send({ type: 'finished', timeMs }),
        sendHorn: () => socket?.send({ type: 'horn' }),
      }).then((g) => {
        game = g;
        g.audio.unlock();
        g.start(msg.countdownMs);
      });
      break;
    }
    case 'state':
      game?.onRemoteState(msg.id, msg.state);
      break;
    case 'horn':
      game?.onHorn(msg.id);
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
      Game.create(canvas, 'solo', [me], { solo: 0 }, {
        sendState: () => {},
        sendFinished: () => {},
        sendHorn: () => {},
      }),
    )
    .then((g) => {
      game = g;
      g.audio.unlock();
      g.start(1500);
    });
} else {
  screens.show('menu');
}

// Autoplay policies require a user gesture before AudioContext can start; unlock once,
// for whichever Game instance is live at the time.
function unlockAudioOnce(): void {
  game?.audio.unlock();
  document.removeEventListener('click', unlockAudioOnce);
  document.removeEventListener('keydown', unlockAudioOnce);
}
document.addEventListener('click', unlockAudioOnce);
document.addEventListener('keydown', unlockAudioOnce);
