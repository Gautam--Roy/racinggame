export const MAX_PLAYERS = 4;
export const DEFAULT_LAPS = 2;
export const MAX_LAPS = 9;
export const STATE_HZ = 20;
export const PICKUP_COUNT = 5;

export const CAR_MODELS = [
  'race',
  'race-future',
  'sedan-sports',
  'suv',
  'hatchback-sports',
  'police',
  'taxi',
  'ambulance',
] as const;
export type CarModel = (typeof CAR_MODELS)[number];

/** Per-vehicle performance character: multipliers applied to the base MAX_SPEED/ENGINE_ACCEL.
 * Higher top speed trades off against acceleration, and vice versa. */
export const CAR_STATS: Record<CarModel, { speed: number; accel: number }> = {
  race: { speed: 1.05, accel: 0.97 },
  'race-future': { speed: 1.08, accel: 0.92 },
  'sedan-sports': { speed: 1.02, accel: 1.0 },
  suv: { speed: 0.95, accel: 1.04 },
  'hatchback-sports': { speed: 0.97, accel: 1.12 },
  police: { speed: 1.03, accel: 1.02 },
  taxi: { speed: 0.96, accel: 1.06 },
  ambulance: { speed: 0.93, accel: 1.08 },
};

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
  b?: boolean; // turbo boost active
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
  | { type: 'setLaps'; laps: number }
  | { type: 'start' }
  | { type: 'state'; state: CarState }
  | { type: 'finished'; timeMs: number }
  | { type: 'horn' }
  | { type: 'pickup'; idx: number };

export type ServerMsg =
  | { type: 'created'; code: string; selfId: string; players: PlayerInfo[]; laps: number }
  | { type: 'joined'; code: string; selfId: string; players: PlayerInfo[]; laps: number }
  | { type: 'error'; message: string }
  | { type: 'lobby'; players: PlayerInfo[]; laps: number }
  | { type: 'countdown'; countdownMs: number; grid: Record<string, number>; laps: number }
  | { type: 'state'; id: string; state: CarState }
  | { type: 'playerLeft'; id: string }
  | { type: 'results'; standings: Standing[] }
  | { type: 'horn'; id: string }
  | { type: 'pickup'; idx: number; id: string };
