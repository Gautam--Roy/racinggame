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
