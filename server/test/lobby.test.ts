import { describe, expect, it } from 'vitest';
import { progressScore } from '../../shared/src/protocol';
import { LobbyManager, Room } from '../src/lobby';

const seq = (...vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

describe('LobbyManager', () => {
  it('creates a room with a 4-letter code and the creator as host', () => {
    const lm = new LobbyManager(seq(0));
    const room = lm.create('p1', 'Ava');
    expect(room.code).toMatch(/^[A-Z]{4}$/);
    expect(room.players).toHaveLength(1);
    expect(room.players[0]).toMatchObject({ id: 'p1', name: 'Ava', isHost: true });
  });

  it('joins an existing room (case-insensitive code)', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'Ava');
    expect(lm.join(room.code.toLowerCase(), 'p2', 'Ben')).toBe(room);
    expect(room.players.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(room.players[1].isHost).toBe(false);
  });

  it('rejects joining an unknown room', () => {
    const lm = new LobbyManager();
    expect(() => lm.join('ZZZZ', 'p1', 'Ava')).toThrow('Room not found');
  });

  it('rejects a 5th player', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    for (const id of ['p2', 'p3', 'p4']) lm.join(room.code, id, id);
    expect(() => lm.join(room.code, 'p5', 'E')).toThrow('Lobby full');
  });

  it('rejects joining a started race', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    expect(room.start('p1')).toBe(true);
    expect(() => lm.join(room.code, 'p2', 'B')).toThrow('Race already started');
  });

  it('assigns each joiner a distinct default car', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    lm.join(room.code, 'p2', 'B');
    lm.join(room.code, 'p3', 'C');
    const cars = room.players.map((p) => p.car);
    expect(new Set(cars).size).toBe(3);
  });

  it('car picks are exclusive within a room', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    lm.join(room.code, 'p2', 'B');
    const p2car = room.players[1].car;
    expect(room.pickCar('p1', p2car)).toBe(false);
    expect(room.pickCar('p1', 'suv')).toBe(true);
    expect(room.players[0].car).toBe('suv');
  });

  it('only the host can start, and only from the lobby phase', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    lm.join(room.code, 'p2', 'B');
    expect(room.start('p2')).toBe(false);
    expect(room.start('p1')).toBe(true);
    expect(room.phase).toBe('racing');
    expect(room.start('p1')).toBe(false);
  });

  it('promotes the next player when the host leaves; deletes empty rooms', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    lm.join(room.code, 'p2', 'B');
    expect(lm.leave(room.code, 'p1')).toBe(room);
    expect(room.players[0]).toMatchObject({ id: 'p2', isHost: true });
    expect(lm.leave(room.code, 'p2')).toBeNull();
    expect(() => lm.join(room.code, 'p9', 'X')).toThrow('Room not found');
  });

  it('truncates long names and defaults empty names', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'x'.repeat(50));
    expect(room.players[0].name).toHaveLength(16);
    lm.join(room.code, 'p2', '');
    expect(room.players[1].name).toBe('Player');
  });
});

describe('Room results', () => {
  const room4 = () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    for (const id of ['p2', 'p3', 'p4']) lm.join(room.code, id, id.toUpperCase());
    room.start('p1');
    return room;
  };

  it('orders finishers by time', () => {
    const room = room4();
    room.recordFinish('p3', 61000);
    room.recordFinish('p1', 60000);
    room.recordFinish('p2', 62000);
    room.recordFinish('p4', 65000);
    expect(room.allFinished).toBe(true);
    expect(room.standings().map((s) => s.id)).toEqual(['p1', 'p3', 'p2', 'p4']);
  });

  it('ranks non-finishers below finishers, by progress', () => {
    const room = room4();
    room.recordFinish('p2', 60000);
    room.recordProgress('p1', { passed: 40, dist: 10 });
    room.recordProgress('p3', { passed: 39, dist: 5 });
    room.recordProgress('p4', { passed: 40, dist: 50 });
    const ids = room.standings().map((s) => s.id);
    expect(ids).toEqual(['p2', 'p1', 'p4', 'p3']);
    expect(room.standings()[3].timeMs).toBeNull();
  });

  it('ignores duplicate finishes and finishes outside racing phase', () => {
    const room = room4();
    room.recordFinish('p1', 60000);
    room.recordFinish('p1', 1);
    expect(room.finishes.get('p1')).toBe(60000);
    room.resetToLobby();
    room.recordFinish('p2', 5);
    expect(room.finishes.size).toBe(0);
  });

  it('allFinished accounts for players who left mid-race', () => {
    const room = room4();
    room.recordFinish('p1', 60000);
    room.recordFinish('p2', 61000);
    room.recordFinish('p3', 62000);
    expect(room.allFinished).toBe(false);
    room.removePlayer('p4');
    expect(room.allFinished).toBe(true);
  });
});

describe('Room.setLaps', () => {
  it('defaults to 2 laps', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    expect(room.laps).toBe(2);
  });

  it('host can set laps within 1..9', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    expect(room.setLaps('p1', 5)).toBe(true);
    expect(room.laps).toBe(5);
    expect(room.setLaps('p1', 1)).toBe(true);
    expect(room.laps).toBe(1);
    expect(room.setLaps('p1', 9)).toBe(true);
    expect(room.laps).toBe(9);
  });

  it('rejects non-host attempts', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    lm.join(room.code, 'p2', 'B');
    expect(room.setLaps('p2', 4)).toBe(false);
    expect(room.laps).toBe(2);
  });

  it('rejects non-integer, zero, and out-of-range values', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    expect(room.setLaps('p1', 0)).toBe(false);
    expect(room.setLaps('p1', 10)).toBe(false);
    expect(room.setLaps('p1', 2.5)).toBe(false);
    expect(room.setLaps('p1', -1)).toBe(false);
    expect(room.laps).toBe(2);
  });

  it('rejects changes once racing has started', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    room.start('p1');
    expect(room.setLaps('p1', 5)).toBe(false);
    expect(room.laps).toBe(2);
  });

  it('persists the host-chosen lap count through resetToLobby (rematch)', () => {
    const lm = new LobbyManager();
    const room = lm.create('p1', 'A');
    expect(room.setLaps('p1', 7)).toBe(true);
    room.start('p1');
    room.resetToLobby();
    expect(room.laps).toBe(7);
  });
});

describe('progressScore', () => {
  it('a passed checkpoint always outranks any distance advantage', () => {
    expect(progressScore({ passed: 1, dist: 9999 })).toBeGreaterThan(progressScore({ passed: 0, dist: 0 }));
  });

  it('closer to the next gate scores higher at equal checkpoints', () => {
    expect(progressScore({ passed: 5, dist: 10 })).toBeGreaterThan(progressScore({ passed: 5, dist: 50 }));
  });

  it('clamps huge distances so they cannot cross a checkpoint boundary', () => {
    expect(progressScore({ passed: 3, dist: 1e9 })).toBeGreaterThan(progressScore({ passed: 2, dist: 0 }));
  });
});
