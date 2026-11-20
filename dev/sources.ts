// Página de prueba del chat 2: fuentes BLE y demo, sin la interfaz del chat 3.
// También sirve de referencia para main.ts (chat 4): aplica D2 igual que la app.

import { createBleSource, isBleSupported, reconnectBle } from '../src/sources/ble';
import { createDemoSource, type DemoSource } from '../src/sources/demo';
import type { DataSource } from '../src/sources/source';
import { LineParser } from '../src/core/protocol';
import { Session } from '../src/core/session';
import type { DisplayState, SessionEvent, SourceStatus } from '../src/types';
import { createFakeParche, installFakeBluetooth, type ChooserMode } from './fake-bluetooth';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error('Falta #' + id);
  return el as T;
};

// ---------------------------------------------------------------------------
// Núcleo
// ---------------------------------------------------------------------------
const parser = new LineParser();
const session = new Session();

// ---------------------------------------------------------------------------
// Fuentes
// ---------------------------------------------------------------------------
const fake = createFakeParche();
let uninstallFake: (() => void) | null = null;

const ble = createBleSource();
wire(ble);
let speed: 1 | 5 = 1;
let demo: DemoSource = makeDemo();
/** Fuente que se inició por última vez (la que manda datos). */
let active: DataSource | null = null;

function makeDemo(): DemoSource {
  const v = $<HTMLInputElement>('iSeed').value.trim();
  const seed = v === '' ? undefined : Math.max(0, Math.floor(Number(v)) || 0);
  const d = createDemoSource(seed === undefined ? { speed } : { speed, seed });
  wire(d);
  return d;
}

function wire(src: DataSource): void {
  src.onStatus((s) => onStatus(src, s));
  src.onData((chunk, t) => onData(src, chunk, t));
}

/** D2: si la nueva fuente es otra, se detiene la anterior y se reinician sesión y parser. */
async function switchTo(src: DataSource): Promise<void> {
  if (active && active !== src) {
    await active.stop();
    session.reset();
    parser.reset();
    resetStats();
    logEvent(`D2: cambio de fuente (${active.kind} → ${src.kind}) → session.reset() + parser.reset()`);
  }
  active = src;
  $('vKind').textContent = src.kind;
}

// ---------------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------------
let chunks = 0, linesOk = 0, linesAll = 0, lastT: number | null = null, lastDt: number | null = null;
const arrivals: number[] = [];
const logLines: string[] = [];
const LOG_MAX = 200;

function resetStats(): void {
  chunks = linesOk = linesAll = 0; lastT = lastDt = null; arrivals.length = 0; logLines.length = 0;
  schedule();
}

function onData(src: DataSource, chunk: string, tAbsS: number): void {
  if (src !== active) { logEvent(`(dato ignorado de ${src.kind}: no es la fuente activa)`); return; }
  chunks++;
  linesAll += (chunk.match(/\n/g) ?? []).length;
  const readings = parser.push(chunk);
  linesOk += readings.length;
  for (const r of readings) session.add(r, tAbsS);

  if (lastT !== null) lastDt = tAbsS - lastT;
  lastT = tAbsS;
  const now = performance.now();
  arrivals.push(now);
  while (arrivals.length && now - arrivals[0]! > 2000) arrivals.shift();

  if (!$<HTMLInputElement>('cFreeze').checked) {
    const parsed = readings.map((r) => `IF ${r.IF.toFixed(2)} · ${r.pct}% · e${r.estado}`).join(' | ');
    logLines.push(`${tAbsS.toFixed(2).padStart(9)}  ${JSON.stringify(chunk).padEnd(16)} ${parsed ? '→ ' + parsed : ''}`);
    if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
  }
  schedule();
}

function onStatus(src: DataSource, s: SourceStatus): void {
  logEvent(`[${src.kind}] ${s.state}${s.detail ? ' · ' + s.detail : ''}`);
  if (src !== active) return;
  // D2: tras conectar o reconectar llega una conexión nueva → se descarta lo pendiente del parser.
  if (s.state === 'connected') parser.reset();
  const b = $('vState');
  b.textContent = s.state;
  b.className = 'badge s-' + s.state;
  $('vDetail').textContent = s.detail ?? '';
}

// ---------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------
session.subscribe((ev: SessionEvent) => {
  if (ev.type === 'sample') return;
  if (ev.type === 'state') logEvent(`sesión: estado ${ev.from} → ${ev.to}`);
  else if (ev.type === 'reset') logEvent('sesión: reset');
  else logEvent(`sesión: ${ev.type} (inicio ${ev.task.start.toFixed(1)} s${ev.task.end !== null ? ', fin ' + ev.task.end.toFixed(1) + ' s' : ''})`);
  schedule();
});

const STATE_NAME: Record<DisplayState, string> = { [-1]: '— (sin estado)', 0: 'normal', 1: 'precaución', 2: 'RIESGO' };

// ---------------------------------------------------------------------------
// Dibujo (una vez por cuadro)
// ---------------------------------------------------------------------------
const events: string[] = [];
function logEvent(msg: string): void {
  const d = new Date();
  events.push(`${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, '0')}  ${msg}`);
  if (events.length > 200) events.splice(0, events.length - 200);
  schedule();
}

let pending = false;
function schedule(): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; render(); });
}

function render(): void {
  $('vChunks').textContent = String(chunks);
  $('vOk').textContent = String(linesOk);
  $('vBad').textContent = String(Math.max(0, linesAll - linesOk));
  $('vRate').textContent = (arrivals.length / 2).toFixed(1);
  $('vT').textContent = lastT === null ? '—' : lastT.toFixed(2) + ' s';
  $('vDt').textContent = lastDt === null ? '—' : (lastDt * 1000).toFixed(0) + ' ms';

  const snap = session.snapshot();
  $('vPhase').textContent = snap.phase;
  $('vDisp').textContent = STATE_NAME[snap.displayState];
  $('vSamples').textContent = String(snap.samples.length);
  $('vTasks').textContent = String(snap.tasks.length);
  const tk = snap.tasks[snap.tasks.length - 1];
  $('vLastTask').textContent = !tk ? '—' : [
    `inicio ${tk.start.toFixed(1)} s`,
    tk.alarm === null ? 'sin alarma' : `alarma +${(tk.alarm - tk.start).toFixed(1)} s`,
    tk.end === null ? 'en curso' : `fin +${(tk.end - tk.start).toFixed(1)} s`,
    tk.maxIF === null ? '' : `IF máx ${tk.maxIF.toFixed(2)}`,
  ].filter(Boolean).join(' · ');

  const log = $('log');
  if (!$<HTMLInputElement>('cFreeze').checked) { log.textContent = logLines.join('\n'); log.scrollTop = log.scrollHeight; }
  const ev = $('events');
  ev.textContent = events.join('\n');
  ev.scrollTop = ev.scrollHeight;
}

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------
function updateSupport(): void {
  $('support').textContent = isBleSupported()
    ? (uninstallFake ? 'Web Bluetooth: parche SIMULADO activo.' : 'Web Bluetooth: disponible en este navegador.')
    : 'Web Bluetooth: NO disponible (usa Chrome en Android o Windows, o activa el parche simulado).';
}

$('bConnect').addEventListener('click', async () => { await switchTo(ble); await ble.start(); });
$('bReconnect').addEventListener('click', async () => {
  await switchTo(ble);
  try { await reconnectBle(ble); } catch (e) { logEvent('reconnectBle: ' + String(e)); }
});
$('bStopBle').addEventListener('click', () => { void ble.stop(); });

$('cFake').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked;
  if (on && !uninstallFake) uninstallFake = installFakeBluetooth(fake);
  if (!on && uninstallFake) { void ble.stop(); uninstallFake(); uninstallFake = null; }
  $('simBox').hidden = !on;
  updateSupport();
});
$<HTMLSelectElement>('sChooser').addEventListener('change', (e) => { fake.chooser = (e.target as HTMLSelectElement).value as ChooserMode; });
$('bDrop').addEventListener('click', () => { fake.drop(); logEvent('simulador: conexión cortada'); });
$<HTMLInputElement>('cReach').addEventListener('change', (e) => { fake.reachable = (e.target as HTMLInputElement).checked; });
$<HTMLInputElement>('cSplit').addEventListener('change', (e) => { fake.splitLines = (e.target as HTMLInputElement).checked; });

$('bDemo').addEventListener('click', async () => {
  if (active && active !== demo && active.kind !== 'demo') demo = makeDemo();   // D2: el demo empieza en 0
  await switchTo(demo);
  await demo.start();
});
$('bStopDemo').addEventListener('click', () => { void demo.stop(); });
$('bSpeed').addEventListener('click', () => {
  speed = speed === 1 ? 5 : 1;
  demo.setSpeed(speed);
  $('bSpeed').textContent = 'Velocidad ×' + speed;
});
$('bNewDemo').addEventListener('click', async () => {
  const wasRunning = active === demo;
  if (wasRunning) await demo.stop();
  demo = makeDemo();
  logEvent('fuente demo nueva (tiempo virtual en 0)');
  if (wasRunning) { await switchTo(demo); await demo.start(); }
});
$('bReset').addEventListener('click', () => { session.reset(); parser.reset(); resetStats(); });

updateSupport();
render();

// Para la consola: dev.session.snapshot(), dev.fake.drop(), etc.
(window as unknown as Record<string, unknown>)['dev'] = {
  ble, get demo() { return demo; }, session, parser, fake,
};
