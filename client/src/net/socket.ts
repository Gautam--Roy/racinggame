import { ClientMsg, ServerMsg } from '../../../shared/src/protocol';

export class GameSocket {
  private ws: WebSocket;

  constructor(
    private readonly onMessage: (msg: ServerMsg) => void,
    private readonly onClose: () => void = () => {},
    url = `ws://${location.hostname}:8080`,
  ) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', (e) => this.onMessage(JSON.parse(e.data) as ServerMsg));
    this.ws.addEventListener('close', () => this.onClose());
  }

  ready(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true });
      this.ws.addEventListener('error', () => rej(new Error('Cannot reach game server')), { once: true });
    });
  }

  send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
