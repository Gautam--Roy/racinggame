export class Input {
  throttle = 0; // -1..1
  steer = 0; // -1..1, smoothed
  handbrake = false;
  /** true for exactly one update() call per physical KeyH press (edge-detected). */
  hornPressed = false;
  /** true for exactly one update() call per physical KeyM press (edge-detected). */
  mutePressed = false;
  /** true for exactly one update() call per physical ShiftLeft/ShiftRight press (edge-detected). */
  turboPressed = false;
  private keys = new Set<string>();
  private prevHorn = false;
  private prevMute = false;
  private prevTurbo = false;
  private onKey = (e: KeyboardEvent) => {
    if (e.type === 'keydown') this.keys.add(e.code);
    else this.keys.delete(e.code);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  };
  private onBlur = () => this.keys.clear();

  constructor() {
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', this.onBlur);
  }

  update(dt: number): void {
    const k = this.keys;
    const up = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    const down = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    const left = k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0;
    const right = k.has('KeyD') || k.has('ArrowRight') ? 1 : 0;
    this.throttle = up - down;
    const target = left - right;
    this.steer += (target - this.steer) * Math.min(1, dt * 9);
    if (Math.abs(this.steer) < 0.01 && target === 0) this.steer = 0;
    this.handbrake = k.has('Space');

    const horn = k.has('KeyH');
    this.hornPressed = horn && !this.prevHorn;
    this.prevHorn = horn;

    const mute = k.has('KeyM');
    this.mutePressed = mute && !this.prevMute;
    this.prevMute = mute;

    const turbo = k.has('ShiftLeft') || k.has('ShiftRight');
    this.turboPressed = turbo && !this.prevTurbo;
    this.prevTurbo = turbo;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
  }
}
