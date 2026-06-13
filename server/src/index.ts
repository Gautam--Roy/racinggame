import { createGameServer } from './server';

const port = Number(process.env.PORT) || 8080;
createGameServer(port);
console.log(`Racing relay server listening on ws://localhost:${port}`);
