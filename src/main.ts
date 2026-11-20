// main.ts (chat 4): conecta todo.
//   botones → fuente (ble | demo) → LineParser → Session → interfaz (chart, panel, alerts)
//
// Decisiones del coordinador que aplica este archivo (claude/app-arquitectura.md):
// - D2: cambiar de fuente (ble ↔ demo) reinicia la sesión y el parser, y el demo nuevo empieza en 0.
//       Reconectar al mismo parche solo hace parser.reset() (en cada 'connected').
// - D3: con 'reconnecting', 'lost' o 'error' → alarma apagada + pulso de 400 ms.
//       Tras 'connected', la primera muestra vuelve a evaluar la alarma; después, solo los eventos 'state'.
// - D7: panel.render(snap, { ...status, source: src.kind }, paused).
// - D9: pantalla encendida (Wake Lock) con 'connected'; se suelta con 'idle'/'lost'/'error';
//       se vuelve a pedir cuando la página vuelve a ser visible.
//
// Botones (notas del chat 3): texto y disabled de btnConnect, btnDemo (aria-pressed), btnSpeed,
// btnPause, btnClear (confirmación de dos toques), btnCsv, btnMute, btnReconnect, y #bnSupport.

import { LineParser } from './core/protocol';
import { Session } from './core/session';
import { createBleSource, isBleSupported, reconnectBle } from './sources/ble';
import { createDemoSource, type DemoSource } from './sources/demo';
import type { DataSource } from './sources/source';
import { createChart } from './ui/chart';
import { createPanel } from './ui/panel';
import { createAlerts } from './ui/alerts';
import { downloadCsv } from './ui/export';
import type { SessionSnapshot, SourceState, SourceStatus } from './types';

const $ = <T extends HTMLElement = HTMLButtonElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error('main: falta #' + id + ' en index.html');
  return el as T;
};

const btn = {
  connect: $('btnConnect'),
  demo: $('btnDemo'),
  speed: $('btnSpeed'),
  reconnect: $('btnReconnect'),
  pause: $('btnPause'),
  clear: $('btnClear'),
  csv: $('btnCsv'),
  mute: $('btnMute'),
};

// ---------------------------------------------------------------------------
// Núcleo e interfaz
// ---------------------------------------------------------------------------
const parser = new LineParser();
const session = new Session();
const chart = createChart($<HTMLCanvasElement>('chart'));
const panel = createPanel();
const alerts = createAlerts();

const IDLE: SourceStatus = { state: 'idle', detail: 'Sin conexión' };

// ---------------------------------------------------------------------------
// Fuentes
// ---------------------------------------------------------------------------
const bleSupported = isBleSupported();
const ble = createBleSource();
wire(ble);
let demo: DemoSource | null = null;   // se crea al pulsar "Modo demo" (D2: una nueva por cada cambio de fuente)
let speed: 1 | 5 = 1;

/** Última fuente que se inició: la única cuyos datos y estados cuentan. */
let active: DataSource | null = null;
/** Último estado de la fuente activa (sin `source`: se agrega al dibujar, D7). */
let status: SourceStatus = IDLE;
/** D2: la sesión se reinicia cuando la fuente nueva se conecta (si se cancela el selector, no se pierde nada). */
let resetOnConnect = false;
/** D3: tras 'connected', la primera muestra vuelve a evaluar la alarma. */
let reevalAlarm = false;

let paused = false;
let muted = false;
/** Nueva sesión: primer toque arma, segundo (antes de 3 s) borra. */
let clearArmed = false;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

function wire(src: DataSource): void {
  src.onStatus((s) => onStatus(src, s));
  src.onData((chunk, t) => onData(src, chunk, t));
}

function onStatus(src: DataSource, s: SourceStatus): void {
  if (src !== active) return;   // una fuente vieja (ya detenida) no cambia nada
  const prev = status.state;
  status = s;

  switch (s.state) {
    case 'connected':
      if (resetOnConnect) {      // D2: cambio de fuente
        resetOnConnect = false;
        session.reset();
      }
      parser.reset();            // D2: conexión nueva → se descarta lo pendiente
      reevalAlarm = true;        // D3
      setWake(true);             // D9
      break;
    case 'reconnecting':
    case 'lost':
    case 'error':
      reevalAlarm = false;
      alerts.setRisk(false);     // D3
      if (s.state !== prev) alerts.pulse(400);
      if (s.state !== 'reconnecting') setWake(false);   // D9
      break;
    case 'idle':
      reevalAlarm = false;
      alerts.setRisk(false);     // detenida a mano: sin datos en vivo no hay alarma
      setWake(false);            // D9
      break;
    default:                     // searching, connecting
      alerts.setRisk(false);
  }
  schedule();
}

function onData(src: DataSource, chunk: string, tAbsS: number): void {
  if (src !== active || status.state !== 'connected') return;
  for (const r of parser.push(chunk)) session.add(r, tAbsS);
}

/** Detiene la fuente activa si es otra. Si cambia el tipo (ble ↔ demo), la sesión se reinicia al conectar (D2). */
function switchTo(next: DataSource): void {
  if (active && active !== next) {
    void active.stop();          // emite 'idle' (alarma apagada, pantalla liberada)
    if (active.kind !== next.kind) resetOnConnect = true;
  }
  active = next;
  status = IDLE;
}

function setPausedUi(p: boolean): void {
  if (p === paused) return;
  paused = p;
  session.setPaused(p);          // en pausa emite 'state → -1' y la alarma se apaga
  schedule();
}

// ---------------------------------------------------------------------------
// Sesión → alarma y dibujo
// ---------------------------------------------------------------------------
session.subscribe((ev, snap) => {
  if (ev.type === 'state') {
    alerts.setRisk(ev.to === 2);
  } else if (ev.type === 'sample' && reevalAlarm) {
    reevalAlarm = false;
    alerts.setRisk(snap.displayState === 2);   // D3
  }
  schedule();
});

let pending = false;
function schedule(): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; render(); });
}

function render(): void {
  const snap = session.snapshot();
  chart.render(snap);
  const shown: SourceStatus = active ? { ...status, source: active.kind } : status;   // D7
  panel.render(snap, shown, paused);
  updateControls(snap);
}

// ---------------------------------------------------------------------------
// Botones
// ---------------------------------------------------------------------------
const BLE_BUSY: readonly SourceState[] = ['connecting', 'connected', 'reconnecting'];

function setText(b: HTMLElement, t: string): void { if (b.textContent !== t) b.textContent = t; }
function setDisabled(b: HTMLButtonElement, d: boolean): void { if (b.disabled !== d) b.disabled = d; }

function updateControls(snap: SessionSnapshot): void {
  const st = status.state;
  const onBle = active === ble;
  const demoOn = !!demo && active === demo && st === 'connected';

  // Conectar / Desconectar
  if (!bleSupported) {
    setText(btn.connect, 'Conectar parche');
    setDisabled(btn.connect, true);
  } else if (onBle && st === 'searching') {
    setText(btn.connect, 'Buscando…');
    setDisabled(btn.connect, true);          // el selector del navegador está abierto
  } else {
    setText(btn.connect, onBle && BLE_BUSY.includes(st) ? 'Desconectar' : 'Conectar parche');
    setDisabled(btn.connect, false);
  }

  // Modo demo
  setText(btn.demo, demoOn ? 'Detener demo' : 'Modo demo');
  btn.demo.setAttribute('aria-pressed', String(demoOn));
  if (btn.speed.hidden !== !demoOn) btn.speed.hidden = !demoOn;
  setText(btn.speed, '×' + speed);

  // Reconectar (dentro del aviso de conexión perdida, que muestra panel.ts)
  setText(btn.reconnect, onBle && st === 'reconnecting' ? 'Reconectando…' : 'Reconectar');
  setDisabled(btn.reconnect, !(onBle && st === 'lost'));

  // Sesión
  const running = !!active && st !== 'idle' && st !== 'error' && st !== 'lost';
  const hasData = snap.samples.length > 0;
  setDisabled(btn.pause, !(running || paused));
  setText(btn.pause, paused ? '▶ Continuar' : '❚❚ Pausa');
  setDisabled(btn.clear, !hasData && !clearArmed);
  setText(btn.clear, clearArmed ? '¿Borrar? Toca otra vez' : 'Nueva sesión');
  setDisabled(btn.csv, !hasData);
}

btn.connect.addEventListener('click', () => {
  alerts.unlock();
  if (active === ble && BLE_BUSY.includes(status.state)) { void ble.stop(); return; }
  setPausedUi(false);
  switchTo(ble);
  void ble.start();   // directo desde el clic: abre el selector del navegador
  schedule();
});

btn.reconnect.addEventListener('click', () => {
  alerts.unlock();
  if (active !== ble) return;
  void reconnectBle(ble).catch((e) => console.error('[main] reconectar', e));
});

btn.demo.addEventListener('click', () => {
  alerts.unlock();
  if (demo && active === demo && status.state === 'connected') { void demo.stop(); return; }
  setPausedUi(false);
  if (!demo || active !== demo) {
    // D2: viniendo de BLE (o la primera vez), un demo nuevo con su tiempo virtual en 0.
    // Si la última fuente ya era este demo, se reanuda donde se quedó.
    demo = createDemoSource({ speed });
    wire(demo);
  }
  switchTo(demo);
  void demo.start();
  schedule();
});

btn.speed.addEventListener('click', () => {
  speed = speed === 1 ? 5 : 1;
  demo?.setSpeed(speed);
  schedule();
});

btn.pause.addEventListener('click', () => { setPausedUi(!paused); });

// Nueva sesión: sin diálogos bloqueantes; el segundo toque en 3 s confirma (igual que el legacy).
btn.clear.addEventListener('click', () => {
  if (session.snapshot().samples.length && !clearArmed) {
    clearArmed = true;
    clearTimer = setTimeout(() => { clearArmed = false; schedule(); }, 3000);
    schedule();
    return;
  }
  clearArmed = false;
  clearTimeout(clearTimer);
  session.reset();
  parser.reset();
  schedule();
});

btn.csv.addEventListener('click', () => { downloadCsv(session.snapshot()); });

btn.mute.addEventListener('click', () => {
  alerts.unlock();
  muted = !muted;
  alerts.setMuted(muted);
  btn.mute.textContent = muted ? '🔕 Silencio' : '🔔 Sonido';
  btn.mute.setAttribute('aria-pressed', String(muted));
});

// ---------------------------------------------------------------------------
// D9: mantener la pantalla encendida mientras se mide
// ---------------------------------------------------------------------------
let wakeWanted = false;
let wakeLock: WakeLockSentinel | null = null;
let wakeQueue: Promise<void> = Promise.resolve();

function setWake(on: boolean): void {
  wakeWanted = on;
  syncWake();
}

/** Pide o suelta el Wake Lock según wakeWanted. En cola para que dos llamadas seguidas no se crucen. */
function syncWake(): void {
  wakeQueue = wakeQueue.then(async () => {
    if (!('wakeLock' in navigator) || !navigator.wakeLock) return;
    try {
      if (wakeWanted && !wakeLock && document.visibilityState === 'visible') {
        const lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
        wakeLock = lock;
        if (!wakeWanted) syncWake();   // se soltó mientras se pedía
      } else if (!wakeWanted && wakeLock) {
        const lock = wakeLock;
        wakeLock = null;
        await lock.release();
      }
    } catch (e) {
      console.warn('[main] Wake Lock', e);   // sin permiso o batería baja: el monitor sigue igual
    }
  });
}

// El navegador suelta el Wake Lock al ocultar la página: se vuelve a pedir al regresar.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncWake();
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
$('bnSupport').hidden = bleSupported;
if (!bleSupported) btn.connect.title = 'Este navegador no tiene Web Bluetooth';

window.addEventListener('resize', () => { chart.resize(); render(); });
if (document.fonts?.ready) void document.fonts.ready.then(() => { chart.resize(); render(); });

render();

// Para la consola y las pruebas (dev/app.html): parche.snapshot(), parche.status()
declare global {
  interface Window {
    parche: {
      snapshot(): SessionSnapshot;
      status(): SourceStatus;
      readonly paused: boolean;
      readonly wakeLock: boolean;
    };
  }
}
window.parche = {
  snapshot: () => session.snapshot(),
  status: () => (active ? { ...status, source: active.kind } : status),
  get paused() { return paused; },
  get wakeLock() { return wakeLock !== null; },
};
