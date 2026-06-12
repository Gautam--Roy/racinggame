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
    if (this.phase !== 'lobby' || !(CAR_MODELS as readonly string[]).includes(car)) return false;
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
