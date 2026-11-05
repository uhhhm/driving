// First-run "Road School": a short chain of goals that teaches the combo loop (drift → bank →
// boost → risk → chain) and pays credits for each, so the first car is in sight within minutes.
import type { Game } from '../core/Game';
import type { Save } from './Save';
import { bus } from '../core/events';
import { audio } from '../audio/AudioEngine';

interface Goal {
  title: string;
  /** [keyboard, gamepad] instructions */
  hint: [string, string];
  reward: number;
  /** trick names that complete it */
  award?: RegExp;
  event?: 'bank' | 'boostStart';
  /** combo multiplier that completes it */
  mult?: number;
}

const GOALS: Goal[] = [
  { title: 'DRIFT', hint: ['Hold <kbd>SPACE</kbd> and steer into a corner', 'Hold <kbd>A</kbd> or <kbd>RB</kbd> and steer into a corner'], reward: 500, award: /DRIFT/ },
  { title: 'BANK IT', hint: ['Ease off: 3 s without a trick banks the combo as credits', 'Ease off: 3 s without a trick banks the combo as credits'], reward: 500, event: 'bank' },
  { title: 'BOOST', hint: ['Hold <kbd>SHIFT</kbd> to boost. Tricks refill the meter', 'Hold <kbd>X</kbd> to boost. Tricks refill the meter'], reward: 500, event: 'boostStart' },
  { title: 'LIVE A LITTLE', hint: ['Skim past traffic for a near miss, or catch air off a crest', 'Skim past traffic for a near miss, or catch air off a crest'], reward: 1000, award: /NEAR MISS|CLOSE CALL|AIR|FLIP|ROLL|SPIN/ },
  { title: 'CHAIN IT', hint: ['Stack tricks before the bar runs out: reach a <b>×3</b> combo', 'Stack tricks before the bar runs out: reach a <b>×3</b> combo'], reward: 2500, mult: 3 },
];
const FINISH_BONUS = 2500;
export const ROAD_SCHOOL_DONE = GOALS.length;

export class Onboarding {
  private el: HTMLDivElement;
  private active = false;
  private advancing = false;
  /** things that happened during the between-goals pause (e.g. the drift's combo banking) */
  private pending: { kind: 'award' | 'bank' | 'boostStart'; name?: string }[] = [];

  constructor(
    private game: Game,
    private save: Save,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'hud-goal';
    game.hud.root.appendChild(this.el);
    bus.on('award', (e) => this.handle({ kind: 'award', name: e.name }));
    bus.on('bank', () => this.handle({ kind: 'bank' }));
    bus.on('comboLost', () => this.active && !this.advancing && this.render()); // keep the bank hint honest
    bus.on('boostStart', () => this.handle({ kind: 'boostStart' }));
  }

  private handle(e: { kind: 'award' | 'bank' | 'boostStart'; name?: string }) {
    if (!this.active || this.done) return;
    if (this.advancing) {
      this.pending.push(e);
      return;
    }
    const g = this.goal;
    if (!g) return;
    const hit =
      e.kind === 'award' ? (g.award?.test(e.name ?? '') ?? false) || (!!g.mult && this.game.score.mult >= g.mult) : g.event === e.kind;
    if (hit) this.complete();
    else if (e.kind === 'award' && g.event === 'bank') this.render(); // pot is no longer empty: update the hint
  }

  get done() {
    return this.save.data.tutorial >= ROAD_SCHOOL_DONE;
  }

  private get goal(): Goal | undefined {
    return this.advancing ? undefined : GOALS[this.save.data.tutorial];
  }

  /** Start (or resume) when the player takes control. */
  begin() {
    if (this.done) return;
    this.active = true;
    this.game.quietEvents = true; // no surprise events until the basics are down
    this.render();
  }

  /** Attract mode / menus: stop listening, hide. */
  suspend() {
    this.active = false;
    this.game.quietEvents = false;
    this.el.classList.remove('show');
  }

  private render() {
    const g = this.goal;
    if (!this.active || !g) {
      this.el.classList.remove('show');
      return;
    }
    const i = this.save.data.tutorial;
    const pad = this.game.input.lastDevice === 'gamepad' ? 1 : 0;
    // nothing in the pot to bank yet? say so
    const hint = g.event === 'bank' && this.game.score.pot <= 0 ? 'Pull another drift, then ease off for 3 s to bank it as credits' : g.hint[pad];
    this.el.innerHTML = `<small>ROAD SCHOOL · ${i + 1}/${GOALS.length}</small><h3>${g.title}</h3><p>${hint}</p><em>+${g.reward.toLocaleString()} CR</em>`;
    this.el.classList.add('show');
  }

  private complete() {
    const g = this.goal;
    if (!g) return;
    this.advancing = true;
    this.save.addCredits(g.reward);
    this.save.data.tutorial++;
    this.save.write();
    audio.chime(false);
    bus.emit('toast', { text: `✓ ${g.title}`, sub: `+${g.reward.toLocaleString()} CR`, color: '#7dff3d' });
    this.el.classList.add('cleared');
    setTimeout(() => {
      this.el.classList.remove('cleared');
      this.advancing = false;
      if (this.done) return this.finish();
      this.render();
      // replay what happened during the pause against the new goal
      const q = this.pending;
      this.pending = [];
      for (const e of q) this.handle(e);
    }, 1400);
  }

  private finish() {
    this.save.addCredits(FINISH_BONUS);
    this.save.write();
    this.el.classList.remove('show');
    this.game.quietEvents = false;
    this.active = false;
    bus.emit('toast', { text: 'ROAD SCHOOL COMPLETE', sub: `+${FINISH_BONUS.toLocaleString()} CR · spend credits in the GARAGE (pause)`, color: '#ffd23f', big: true });
    audio.chime(true);
  }
}
