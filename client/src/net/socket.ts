import { ClientMsg, ServerMsg } from '../../../shared/src/protocol';

export class GameSocket {
  private ws: WebSocket;

  constructor(
    private readonly onMessage: (msg: ServerMsg) => void,
    private readonly onClose: () => void = () => {},
    // Port 5173 is the Vite dev-server default; in dev the client and the
    // game relay run on different ports, so we hardcode the relay's port.
    // This heuristic only covers `vite dev` — `vite preview` runs on a
    // different port and isn't detected here. Production builds are served
    // same-origin (client and relay share a host/port), so the ws(s) branch
    // below is used instead and no heuristic is needed.
    url = location.port === '5173'
      ? `ws://${location.hostname}:8080`
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`,
  ) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', (e) => {
      try {
        this.onMessage(JSON.parse(e.data) as ServerMsg);
      } catch {
        /* ignore malformed frames */
      }
    });
    this.ws.addEventListener('close', () => this.onClose());
  }

  ready(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.ws.readyState !== WebSocket.CONNECTING)
      return Promise.reject(new Error('Cannot reach game server'));
    return new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true });
      this.ws.addEventListener('error', () => rej(new Error('Cannot reach game server')), { once: true });
    });
  }

  send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
