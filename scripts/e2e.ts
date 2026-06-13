import { spawn } from 'node:child_process';
import { createGameServer } from '../server/src/server';

const PORT = 8123;
const wss = createGameServer(PORT);
const bots = spawn('npx', ['tsx', 'scripts/bots.ts'], {
  env: { ...process.env, WS_URL: `ws://localhost:${PORT}` },
  stdio: 'inherit',
});
bots.on('exit', (code) => {
  wss.close();
  process.exit(code ?? 1);
});
