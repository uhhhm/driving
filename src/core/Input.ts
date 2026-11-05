// Keyboard + gamepad input, merged into a single analog control state.

export interface Controls {
  throttle: number; // 0..1
  brake: number; // 0..1
  steer: number; // -1..1 (right positive)
  handbrake: boolean;
  boost: boolean;
  lookBack: boolean;
  // edge-triggered
  reset: boolean;
  camera: boolean;
  pause: boolean;
  photo: boolean;
  horn: boolean;
}

const KEYMAP: Record<string, string> = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'handbrake',
  ShiftLeft: 'boost', ShiftRight: 'boost', KeyN: 'boost',
  KeyR: 'reset',
  KeyC: 'camera',
  KeyB: 'lookBack',
  Escape: 'pause', KeyP: 'pause',
  KeyF: 'photo',
  KeyH: 'horn',
};

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  readonly keysDown = new Set<string>(); // raw codes, for photo mode etc.
  private steerSmooth = 0;
  gamepadActive = false;
  lastDevice: 'keyboard' | 'gamepad' = 'keyboard';
  enabled = true;
  private prevPad: boolean[] = [];

  constructor() {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keysDown.add(e.code);
      const a = KEYMAP[e.code];
      if (a) {
        if (!this.down.has(a)) this.pressed.add(a);
        this.down.add(a);
        e.preventDefault();
      }
      this.lastDevice = 'keyboard';
    });
    window.addEventListener('keyup', (e) => {
      this.keysDown.delete(e.code);
      const a = KEYMAP[e.code];
      if (a) this.down.delete(a);
    });
    window.addEventListener('blur', () => {
      this.down.clear();
      this.keysDown.clear();
    });
  }

  /** Consume an edge-triggered action. */
  consume(a: string): boolean {
    const had = this.pressed.has(a);
    this.pressed.delete(a);
    return had;
  }

  /** Programmatic input (tests / attract mode). */
  setVirtual(a: string, on: boolean) {
    if (on) {
      if (!this.down.has(a)) this.pressed.add(a);
      this.down.add(a);
    } else this.down.delete(a);
  }

  isDown(a: string) {
    return this.down.has(a);
  }

  poll(dt: number, speedKmh: number): Controls {
    let throttle = this.down.has('up') ? 1 : 0;
    let brake = this.down.has('down') ? 1 : 0;
    let steerTarget = (this.down.has('right') ? 1 : 0) - (this.down.has('left') ? 1 : 0);
    let handbrake = this.down.has('handbrake');
    let boost = this.down.has('boost');
    let lookBack = this.down.has('lookBack');

    // keyboard steering: ramp in, faster return, and less lock at speed
    const rate = steerTarget === 0 ? 7 : Math.sign(steerTarget) !== Math.sign(this.steerSmooth) ? 9 : 4.2;
    const d = steerTarget - this.steerSmooth;
    this.steerSmooth += Math.sign(d) * Math.min(Math.abs(d), rate * dt);
    let steer = this.steerSmooth;

    // ---- gamepad ----
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const btn = (i: number) => (p.buttons[i] ? p.buttons[i].value : 0);
      const pressedNow = (i: number) => btn(i) > 0.5;
      const edge = (i: number, action: string) => {
        const now = pressedNow(i);
        if (now && !this.prevPad[i]) this.pressed.add(action);
        this.prevPad[i] = now;
      };
      const ax = p.axes[0] ?? 0;
      const sx = Math.abs(ax) > 0.12 ? Math.sign(ax) * ((Math.abs(ax) - 0.12) / 0.88) : 0;
      const rt = btn(7);
      const lt = btn(6);
      if (Math.abs(sx) > 0.01 || rt > 0.05 || lt > 0.05) {
        this.gamepadActive = true;
        this.lastDevice = 'gamepad';
      }
      if (this.lastDevice === 'gamepad') {
        steer = Math.sign(sx) * Math.pow(Math.abs(sx), 1.5);
        throttle = Math.max(throttle, rt);
        brake = Math.max(brake, lt);
        handbrake = handbrake || pressedNow(0) || pressedNow(5); // A / RB
        boost = boost || pressedNow(2) || pressedNow(1); // X / B
        lookBack = lookBack || pressedNow(4) || pressedNow(10);
      }
      edge(3, 'camera'); // Y
      edge(9, 'pause'); // start
      edge(8, 'reset'); // back/select
      edge(12, 'photo'); // dpad up
      edge(11, 'horn');
      edge(13, 'reset'); // dpad down
      break;
    }
    // speed-sensitive steering limit (keyboard only, gamepad gets a softer one)
    const lim = 1 - Math.min(0.55, Math.max(0, (speedKmh - 40) / 260)) * (this.lastDevice === 'keyboard' ? 1 : 0.6);
    steer *= lim;

    if (!this.enabled) {
      throttle = brake = steer = 0;
      handbrake = boost = false;
    }

    return {
      throttle,
      brake,
      steer,
      handbrake,
      boost,
      lookBack,
      reset: this.consume('reset'),
      camera: this.consume('camera'),
      pause: this.consume('pause'),
      photo: this.consume('photo'),
      horn: this.isDown('horn'),
    };
  }

  rumble(strong: number, weak: number, ms: number) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      const act = (p as unknown as { vibrationActuator?: { playEffect: (t: string, o: object) => void } })?.vibrationActuator;
      if (act) {
        try {
          act.playEffect('dual-rumble', { duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) });
        } catch {
          /* ignore */
        }
      }
    }
  }
}
