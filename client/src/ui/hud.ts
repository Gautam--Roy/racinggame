const $ = (id: string) => document.getElementById(id)!;
const ORDINALS = ['1st', '2nd', '3rd', '4th'];

function fmtTime(ms: number): string {
  const clamped = Math.max(0, ms);
  const m = Math.floor(clamped / 60000);
  const s = (clamped % 60000) / 1000;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export class Hud {
  private map: CanvasRenderingContext2D | null = null;
  private mapScale = 1;
  private mapOff = { x: 0, y: 0 };
  private mapPath = new Path2D();
  private boundMuteClick = () => this.onMuteClick?.();

  /** Set by game.ts; fired when the mute button is clicked. */
  onMuteClick: (() => void) | null = null;

  constructor() {
    $('mute-btn').addEventListener('click', this.boundMuteClick);
  }

  show(): void {
    $('hud').classList.remove('hidden');
  }

  hide(): void {
    $('hud').classList.add('hidden');
    for (const id of ['countdown', 'wrongway', 'waiting']) $(id).classList.add('hidden');
  }

  setSpeed(ms: number): void {
    $('speed').textContent = `${Math.round(Math.abs(ms) * 3.6)} km/h`;
  }

  setLap(lap: number, total: number): void {
    $('lap').textContent = `Lap ${Math.min(lap, total)}/${total}`;
  }

  setPosition(rank: number, total: number): void {
    $('pos').textContent = `${ORDINALS[rank - 1] ?? `${rank}th`}/${total}`;
  }

  setTimes(lapMs: number, totalMs: number): void {
    $('laptime').textContent = `Lap ${fmtTime(lapMs)}`;
    $('totaltime').textContent = `Total ${fmtTime(totalMs)}`;
  }

  /** points: world-space (x,z) samples of the track centerline, in order. */
  initMinimap(points: { x: number; z: number }[]): void {
    const canvas = $('minimap') as HTMLCanvasElement;
    this.map = canvas.getContext('2d');
    const xs = points.map((p) => p.x);
    const zs = points.map((p) => p.z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const pad = 14;
    this.mapScale = Math.min(
      (canvas.width - pad * 2) / (maxX - minX),
      (canvas.height - pad * 2) / (maxZ - minZ),
    );
    this.mapOff = {
      x: pad + (canvas.width - pad * 2 - (maxX - minX) * this.mapScale) / 2 - minX * this.mapScale,
      y: pad + (canvas.height - pad * 2 - (maxZ - minZ) * this.mapScale) / 2 - minZ * this.mapScale,
    };
    this.mapPath = new Path2D();
    points.forEach((p, i) => {
      const m = this.world2map(p.x, p.z);
      if (i === 0) this.mapPath.moveTo(m.x, m.y);
      else this.mapPath.lineTo(m.x, m.y);
    });
    this.mapPath.closePath();
  }

  updateMinimap(self: { x: number; z: number }, others: { x: number; z: number }[]): void {
    const ctx = this.map;
    if (!ctx) return;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke(this.mapPath);
    for (const o of others) this.dot(o, '#9fb2c8', 4);
    this.dot(self, '#e8463c', 5.5);
  }

  private dot(p: { x: number; z: number }, color: string, r: number): void {
    const ctx = this.map!;
    const m = this.world2map(p.x, p.z);
    ctx.beginPath();
    ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  private world2map(x: number, z: number): { x: number; y: number } {
    return { x: x * this.mapScale + this.mapOff.x, y: z * this.mapScale + this.mapOff.y };
  }

  setCountdown(text: string | null): void {
    $('countdown').classList.toggle('hidden', text === null);
    if (text !== null) $('countdown').textContent = text;
  }

  setWrongWay(on: boolean): void {
    $('wrongway').classList.toggle('hidden', !on);
  }

  setWaiting(on: boolean): void {
    $('waiting').classList.toggle('hidden', !on);
  }

  setMuted(m: boolean): void {
    $('mute-btn').textContent = m ? '🔇' : '🔊';
  }

  /** Remove the mute-button listener so repeated Game/Hud construction across races doesn't accumulate listeners. */
  dispose(): void {
    $('mute-btn').removeEventListener('click', this.boundMuteClick);
    this.onMuteClick = null;
  }
}
