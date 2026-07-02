import WebSocket from 'ws';
import { ClientMsg, ServerMsg } from '../shared/src/protocol';

const URL = process.env.WS_URL ?? 'ws://localhost:8080';
const fail = (m: string) => {
  console.error('FAIL:', m);
  process.exit(1);
};

class Bot {
  ws = new WebSocket(URL);
  private msgs: ServerMsg[] = [];
  private waiters: ((m: ServerMsg) => boolean)[] = [];

  constructor(public name: string) {
    this.ws.on('message', (d) => {
      const msg = JSON.parse(d.toString()) as ServerMsg;
      this.msgs.push(msg);
      this.waiters = this.waiters.filter((w) => !w(msg));
    });
    this.ws.on('error', (e) => fail(`${this.name}: ${e.message}`));
  }

  send(m: ClientMsg) {
    this.ws.send(JSON.stringify(m));
  }

  open() {
    return new Promise((res) => this.ws.on('open', res));
  }

  received(type: ServerMsg['type']): boolean {
    return this.msgs.some((m) => m.type === type);
  }

  expect<T extends ServerMsg['type']>(type: T, timeoutMs = 5000): Promise<Extract<ServerMsg, { type: T }>> {
    const found = this.msgs.find((m) => m.type === type);
    if (found) return Promise.resolve(found as Extract<ServerMsg, { type: T }>);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`${this.name}: timeout waiting for '${type}'`)), timeoutMs);
      this.waiters.push((m) => {
        if (m.type !== type) return false;
        clearTimeout(timer);
        res(m as Extract<ServerMsg, { type: T }>);
        return true;
      });
    });
  }
}

async function main() {
  const bots = ['Ava', 'Ben', 'Cyd', 'Dee'].map((n) => new Bot(n));
  await Promise.all(bots.map((b) => b.open()));

  bots[0].send({ type: 'create', name: bots[0].name });
  const created = await bots[0].expect('created');
  console.log('room code:', created.code);

  for (const b of bots.slice(1)) {
    b.send({ type: 'join', code: created.code, name: b.name });
    await b.expect('joined');
  }

  bots[0].send({ type: 'start' });
  await Promise.all(bots.map((b) => b.expect('countdown')));
  console.log('countdown received by all 4 bots');

  // relay checks: horn + pickup broadcast to everyone except the sender
  bots[0].send({ type: 'horn' });
  bots[0].send({ type: 'pickup', idx: 2 });
  const [hornB, hornC, hornD] = await Promise.all(bots.slice(1).map((b) => b.expect('horn')));
  const [pickupB, pickupC, pickupD] = await Promise.all(bots.slice(1).map((b) => b.expect('pickup')));
  const hornIds = [hornB.id, hornC.id, hornD.id];
  const pickupIds = [pickupB.id, pickupC.id, pickupD.id];
  if (new Set(hornIds).size !== 1) fail(`horn id mismatch across bots: ${hornIds.join(',')}`);
  if (new Set(pickupIds).size !== 1) fail(`pickup id mismatch across bots: ${pickupIds.join(',')}`);
  if (pickupB.idx !== 2 || pickupC.idx !== 2 || pickupD.idx !== 2)
    fail(`pickup idx mismatch: ${[pickupB.idx, pickupC.idx, pickupD.idx].join(',')}`);
  if (hornIds[0] !== pickupIds[0]) fail(`horn/pickup sender id mismatch: ${hornIds[0]} vs ${pickupIds[0]}`);
  await new Promise((res) => setTimeout(res, 500));
  if (bots[0].received('horn') || bots[0].received('pickup')) fail('sender received its own relayed message');
  console.log('relay checks OK');

  // simulate state traffic, then staggered finishes (Ava wins)
  bots.forEach((b, i) => {
    b.send({
      type: 'state',
      state: { p: [0, 0.5, 0], q: [0, 0, 0, 1], progress: { passed: i, dist: 10 } },
    });
    setTimeout(() => b.send({ type: 'finished', timeMs: 60_000 + i * 1500 }), 300 + i * 100);
  });

  const results = await Promise.all(bots.map((b) => b.expect('results')));
  const order = results[0].standings.map((s) => s.name);
  if (order[0] !== 'Ava' || order[3] !== 'Dee') fail(`bad standings: ${order.join(' > ')}`);
  console.log('PASS — standings:', order.join(' > '));
  bots.forEach((b) => b.ws.close());
  process.exit(0);
}

main().catch((e) => fail(e.message));
