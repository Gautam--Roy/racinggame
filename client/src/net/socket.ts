import { ClientMsg, ServerMsg } from '../../../shared/src/protocol';

export class GameSocket {
  private ws: WebSocket;

  constructor(
    private readonly onMessage: (msg: ServerMsg) => void,
    private readonly onClose: () => void = () => {},
    url = `ws://${location.hostname}:8080`,
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
