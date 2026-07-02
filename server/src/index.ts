import fs from 'node:fs';
import http from 'node:http';
import { createGameServer } from './server';
import { createStaticHandler } from './static';

// Defense-in-depth: this relay keeps all room state in memory, so an
// uncaught error would otherwise crash the process and drop every
// connected player. Log-and-survive is the correct behavior here.
process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));

const port = Number(process.env.PORT) || 8080;
const staticDir = process.env.STATIC_DIR ?? (fs.existsSync('client/dist') ? 'client/dist' : null);

if (staticDir) {
  const handler = createStaticHandler(staticDir);
  const server = http.createServer(handler);
  createGameServer({ server });
  server.listen(port, () => {
    console.log(`Racing server listening on http://localhost:${port} (static: ${staticDir})`);
    console.log(`WebSocket relay on ws://localhost:${port}`);
  });
} else {
  createGameServer({ port });
  console.log(`Racing relay server listening on ws://localhost:${port}`);
}
