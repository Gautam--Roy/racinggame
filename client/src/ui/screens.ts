import { CAR_MODELS, CarModel, PlayerInfo, Standing } from '../../../shared/src/protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class Screens {
  onCreate: (name: string) => void = () => {};
  onJoin: (code: string, name: string) => void = () => {};
  onPickCar: (car: CarModel) => void = () => {};
  onStart: () => void = () => {};
  onBack: () => void = () => {};

  constructor() {
    $('create-btn').addEventListener('click', () => this.onCreate(this.name()));
    $('join-btn').addEventListener('click', () =>
      this.onJoin(($('code-input') as HTMLInputElement).value.trim().toUpperCase(), this.name()),
    );
    $('start-btn').addEventListener('click', () => this.onStart());
    $('back-btn').addEventListener('click', () => this.onBack());
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

  renderLobby(code: string, players: PlayerInfo[], selfId: string): void {
    $('lobby-code').textContent = code;
    $('player-list').innerHTML = players
      .map((p) => `<li>${p.isHost ? '👑 ' : ''}${esc(p.name)} — ${p.car}${p.id === selfId ? ' (you)' : ''}</li>`)
      .join('');
    const me = players.find((p) => p.id === selfId);
    const picker = $('car-picker');
    picker.innerHTML = '';
    for (const car of CAR_MODELS) {
      const btn = document.createElement('button');
      btn.textContent = car;
      const owner = players.find((p) => p.car === car);
      if (owner?.id === selfId) btn.classList.add('mine');
      else if (owner) btn.classList.add('taken');
      btn.addEventListener('click', () => this.onPickCar(car));
      picker.appendChild(btn);
    }
    const startBtn = $('start-btn') as HTMLButtonElement;
    startBtn.disabled = !me?.isHost;
    $('lobby-hint').textContent = me?.isHost ? 'You are the host — start when ready.' : 'Waiting for the host to start…';
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
