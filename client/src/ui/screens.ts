import { CAR_MODELS, CarModel, CAR_STATS, MAX_LAPS, PlayerInfo, Standing } from '../../../shared/src/protocol';
import { ACCENT, CAR_DISPLAY } from '../game/cars';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class Screens {
  onCreate: (name: string) => void = () => {};
  onJoin: (code: string, name: string) => void = () => {};
  onPickCar: (car: CarModel) => void = () => {};
  onSetLaps: (laps: number) => void = () => {};
  onStart: () => void = () => {};
  onBack: () => void = () => {};

  private laps = 0;

  constructor() {
    $('create-btn').addEventListener('click', () => this.onCreate(this.name()));
    $('join-btn').addEventListener('click', () =>
      this.onJoin(($('code-input') as HTMLInputElement).value.trim().toUpperCase(), this.name()),
    );
    $('start-btn').addEventListener('click', () => this.onStart());
    $('back-btn').addEventListener('click', () => this.onBack());
    $('laps-dec').addEventListener('click', () => this.onSetLaps(this.laps - 1));
    $('laps-inc').addEventListener('click', () => this.onSetLaps(this.laps + 1));
  }

  private name(): string {
    return ($('name-input') as HTMLInputElement).value.trim() || 'Player';
  }

  show(name: 'menu' | 'lobby' | 'results' | 'none'): void {
    for (const id of ['menu', 'lobby', 'results']) $(id).classList.toggle('hidden', id !== name);
  }

  showError(message: string): void {
    $('menu-error').textContent = message;
  }

  renderLobby(code: string, players: PlayerInfo[], selfId: string, laps: number): void {
    $('lobby-code').textContent = code;
    this.laps = laps;
    $('player-list').innerHTML = players
      .map(
        (p) =>
          `<li>${p.isHost ? '👑 ' : ''}${esc(p.name)} — ${CAR_DISPLAY[p.car]}${p.id === selfId ? ' (you)' : ''}</li>`,
      )
      .join('');
    const me = players.find((p) => p.id === selfId);
    const picker = $('car-picker');
    picker.innerHTML = '';
    for (const car of CAR_MODELS) {
      const btn = document.createElement('button');
      const hex = ACCENT[car].toString(16).padStart(6, '0');
      const stats = CAR_STATS[car];
      const spdPct = Math.round(((stats.speed - 0.9) / 0.25) * 100);
      const accPct = Math.round(((stats.accel - 0.9) / 0.25) * 100);
      btn.title = 'Top speed / Acceleration';
      btn.innerHTML = `
        <span class="swatch" style="background: #${hex}"></span>${CAR_DISPLAY[car]}
        <span class="stat-bars">
          <span class="stat-bar"><span class="stat-fill spd" style="width:${spdPct}%"></span></span>
          <span class="stat-bar"><span class="stat-fill acc" style="width:${accPct}%"></span></span>
        </span>`;
      const owner = players.find((p) => p.car === car);
      if (owner?.id === selfId) btn.classList.add('mine');
      else if (owner) btn.classList.add('taken');
      btn.addEventListener('click', () => this.onPickCar(car));
      picker.appendChild(btn);
    }
    const startBtn = $('start-btn') as HTMLButtonElement;
    startBtn.disabled = !me?.isHost;
    $('lobby-hint').textContent = me?.isHost ? 'You are the host — start when ready.' : 'Waiting for the host to start…';
    $('laps-value').textContent = String(laps);
    const decBtn = $('laps-dec') as HTMLButtonElement;
    const incBtn = $('laps-inc') as HTMLButtonElement;
    decBtn.disabled = !me?.isHost || laps <= 1;
    incBtn.disabled = !me?.isHost || laps >= MAX_LAPS;
  }

  renderResults(standings: Standing[]): void {
    const fmt = (ms: number | null) => (ms === null ? 'DNF' : `${(ms / 1000).toFixed(2)}s`);
    $('results-table').innerHTML = standings
      .map((s, i) => `<tr><td>#${i + 1}</td><td>${esc(s.name)}</td><td>${fmt(s.timeMs)}</td></tr>`)
      .join('');
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
