// Página de prueba del chat 3: la interfaz (chart, panel, alerts, export) con una Session real
// alimentada con datos fijos, sin Bluetooth y sin main.ts. Abre http://localhost:5173/dev/ui.html
//
// Escenarios:
//  - casos: empujón de 4 s de la calibración de CVM (se descarta por D1), una tarea que llega a riesgo
//           y otra que se queda en precaución. Hecho a mano, determinista.
//  - demo:  5 min del generador del chat 2 (createDemoGenerator, semilla 7).
//  - larga: 20 min del mismo generador (prueba la ventana deslizante de 180 s y el rendimiento).
//
// Para pruebas automáticas, window.uiTest expone load/play/jumpEnd/setStatus/snapshot.

import { LineParser } from '../src/core/protocol';
import { Session } from '../src/core/session';
import { createDemoGenerator, DEMO_DETAIL } from '../src/sources/demo';
import { createChart } from '../src/ui/chart';
import { createPanel } from '../src/ui/panel';
import { createAlerts } from '../src/ui/alerts';
import { downloadCsv, toCsv } from '../src/ui/export';
import type { SessionEvent, SourceState, SourceStatus } from '../src/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error('Falta #' + id);
  return el as T;
};

// ---------------------------------------------------------------------------
// Escenarios: arreglos de líneas "IF,%CVM,estado\n", una cada 0.1 s
// ---------------------------------------------------------------------------

/** Simula la máquina de estados del firmware sobre una curva de IF dada (umbrales 1.25 / 1.50). */
function casesScenario(): string[] {
  const lines: string[] = [];
  const push = (n: number, f: (i: number) => [number, number, 0 | 1 | 2]) => {
    for (let i = 0; i < n; i++) { const [IF, pct, st] = f(i); lines.push(`${IF.toFixed(2)},${Math.round(pct)},${st}\n`); }
  };
  const rest = (s: number) => push(s * 10, () => [1, 2, 0]);

  // Tarea con una rampa de IF de ifFrom a ifTo en rampS s, después de 7 s de referencia.
  const task = (rampS: number, ifFrom: number, ifTo: number, pct: number) => {
    push(70, () => [1, pct, 0]);                      // referencia A₀: el parche manda IF 1.00
    let st: 0 | 1 | 2 = 0, over: number | null = null, under: number | null = null;
    push(rampS * 10, (i) => {
      const t = i / 10, IF = ifFrom + (ifTo - ifFrom) * (i / (rampS * 10 - 1));
      if (IF >= 1.5) { if (over === null) over = t; } else over = null;
      if (st !== 2) st = over !== null && t - over >= 2 ? 2 : IF >= 1.25 ? 1 : 0;
      else { if (IF < 1.4) { if (under === null) under = t; } else under = null; if (under !== null && t - under >= 3) { st = 1; under = null; } }
      return [IF, pct + Math.sin(i / 3) * 2, st];
    });
  };

  rest(3);
  push(40, () => [1, 85, 0]);   // empujón de 4 s para la CVM → la sesión lo descarta (D1)
  rest(6);
  task(45, 1.0, 1.72, 45);      // llega a riesgo ≈ 38 s después del inicio
  rest(8);
  task(25, 1.0, 1.38, 40);      // se queda en precaución
  rest(6);
  return lines;
}

function demoScenario(seconds: number, seed = 7): string[] {
  const gen = createDemoGenerator(seed);
  return Array.from({ length: seconds * 10 }, () => gen.next());
}

const SCENARIOS: Record<string, () => string[]> = {
  casos: casesScenario,
  demo: () => demoScenario(5 * 60),
  larga: () => demoScenario(20 * 60),
};

// ---------------------------------------------------------------------------
// Núcleo + interfaz
// ---------------------------------------------------------------------------
const parser = new LineParser();
const session = new Session();
const chart = createChart($<HTMLCanvasElement>('chart'));
const panel = createPanel();
const alerts = createAlerts();

let lines: string[] = [];
let pos = 0;               // siguiente línea a mandar
let playTimer: ReturnType<typeof setInterval> | null = null;
let paused = false;
let muted = false;
let status: SourceStatus = { state: 'connected', detail: DEMO_DETAIL, source: 'demo' };
let reevalAlarm = false;   // D3: tras 'connected', la primera muestra re-evalúa la alarma

const DETAIL: Record<SourceState, (src: 'ble' | 'demo' | undefined) => string> = {
  idle: () => 'Sin conexión',
  searching: () => 'Buscando el parche…',
  connecting: () => 'Conectando con ParcheEMG…',
  connected: (src) => (src === 'demo' ? DEMO_DETAIL : 'Conectado · ParcheEMG'),
  reconnecting: () => 'Se perdió la conexión con el parche. Intentando reconectar…',
  lost: () => 'Se perdió la conexión con el parche. Revisa que esté encendido y cerca.',
  error: () => 'Bluetooth está apagado o no disponible en este equipo.',
};

function setStatus(state: SourceState, source?: 'ble' | 'demo'): void {
  const next: SourceStatus = { state, detail: DETAIL[state](source) };
  if (source) next.source = source;
  const prevState = status.state;
  status = next;
  if (state !== prevState) {
    log(`conexión: ${prevState} → ${state}${source ? ' (' + source + ')' : ''}`);
    if (state === 'reconnecting' || state === 'lost' || state === 'error') { alerts.setRisk(false); alerts.pulse(400); }
    if (state === 'connected') { parser.reset(); reevalAlarm = true; }
  }
  schedule();
}

session.subscribe((ev: SessionEvent, snap) => {
  if (ev.type === 'sample') {
    if (reevalAlarm) { reevalAlarm = false; alerts.setRisk(snap.displayState === 2); }
  } else if (ev.type === 'state') {
    alerts.setRisk(ev.to === 2);
    log(`sesión: estado ${ev.from} → ${ev.to}`);
  } else if (ev.type === 'reset') {
    log('sesión: reset');
  } else {
    const t = ev.task;
    log(`sesión: ${ev.type} · inicio ${t.start.toFixed(1)} s${t.end !== null ? ' · fin ' + t.end.toFixed(1) + ' s' : ''}`);
  }
  schedule();
});

/** Manda n líneas (si hay conexión). Devuelve cuántas mandó. */
function feed(n: number): number {
  if (status.state !== 'connected') return 0;
  let k = 0;
  for (; k < n && pos < lines.length; k++, pos++) {
    for (const r of parser.push(lines[pos]!)) session.add(r, pos / 10);
  }
  if (pos >= lines.length) stop();
  schedule();
  return k;
}

function play(): void {
  if (playTimer !== null) return;
  if (pos >= lines.length) return;
  playTimer = setInterval(() => feed(Number($<HTMLSelectElement>('dSpeed').value)), 100);
  $('dPlay').textContent = '⏸ Detener';
}
function stop(): void {
  if (playTimer !== null) { clearInterval(playTimer); playTimer = null; }
  $('dPlay').textContent = '▶ Reproducir';
}

function load(name: string): void {
  stop();
  lines = (SCENARIOS[name] ?? SCENARIOS.casos!)();
  pos = 0;
  session.reset();
  parser.reset();
  $('dCsv').hidden = true;
  log(`escenario "${name}": ${lines.length} líneas (${(lines.length / 10).toFixed(0)} s)`);
}

// ---------------------------------------------------------------------------
// Dibujo: una vez por cuadro, como lo hará main.ts
// ---------------------------------------------------------------------------
let pending = false;
function schedule(): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; renderAll(); });
}
function renderAll(): void {
  const snap = session.snapshot();
  chart.render(snap);
  panel.render(snap, status, paused);
  $('dPos').textContent = `${(pos / 10).toFixed(1)} / ${(lines.length / 10).toFixed(1)} s · ${snap.samples.length} muestras · ${snap.tasks.length} tareas`;
}

const logLines: string[] = [];
function log(msg: string): void {
  logLines.push(msg);
  if (logLines.length > 60) logLines.splice(0, logLines.length - 60);
  const el = $('dLog');
  el.textContent = logLines.join('\n');
  el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------------------
// Controles de la página de prueba
// ---------------------------------------------------------------------------
$('dLoad').addEventListener('click', () => { load($<HTMLSelectElement>('dScenario').value); });
$('dPlay').addEventListener('click', () => { alerts.unlock(); if (playTimer) stop(); else play(); });
$('dStep').addEventListener('click', () => { feed(10); });
$('dEnd').addEventListener('click', () => { feed(lines.length); });
const pickStatus = () => {
  const src = $<HTMLSelectElement>('dSource').value;
  setStatus($<HTMLSelectElement>('dState').value as SourceState, src === 'ble' || src === 'demo' ? src : undefined);
};
$('dState').addEventListener('change', pickStatus);
$('dSource').addEventListener('change', pickStatus);
$('dAlarm').addEventListener('click', () => { alerts.unlock(); alerts.setRisk(true); setTimeout(() => alerts.setRisk(session.snapshot().displayState === 2), 3000); });
$('dPulse').addEventListener('click', () => { alerts.pulse(400); });
$('dCsvShow').addEventListener('click', () => {
  const pre = $('dCsv');
  const csv = toCsv(session.snapshot()).split('\n');
  const blank = csv.indexOf('');
  pre.textContent = [...csv.slice(0, 12), `… (${Math.max(0, blank - 1)} filas de muestras)`, ...csv.slice(blank)].join('\n');
  pre.hidden = false;
});

// Controles de la app que dependen solo de la interfaz (los demás los conecta main.ts en el chat 4)
for (const id of ['btnPause', 'btnClear', 'btnCsv']) $<HTMLButtonElement>(id).disabled = false;
for (const id of ['btnConnect', 'btnDemo']) {
  const b = $<HTMLButtonElement>(id);
  b.disabled = true;
  b.title = 'Lo conecta main.ts (chat 4). Usa el selector "Conexión" de arriba.';
}
$('btnPause').addEventListener('click', () => {
  paused = !paused;
  session.setPaused(paused);
  $('btnPause').textContent = paused ? '▶ Continuar' : '❚❚ Pausa';
  schedule();
});
$('btnClear').addEventListener('click', () => { session.reset(); parser.reset(); });
$('btnCsv').addEventListener('click', () => { downloadCsv(session.snapshot()); });
$('btnMute').addEventListener('click', () => {
  alerts.unlock();
  muted = !muted;
  alerts.setMuted(muted);
  $('btnMute').textContent = muted ? '🔕 Silencio' : '🔔 Sonido';
  $('btnMute').setAttribute('aria-pressed', String(muted));
});
$('btnReconnect').addEventListener('click', () => {
  $<HTMLSelectElement>('dState').value = 'connected';
  pickStatus();
});

window.addEventListener('resize', () => { chart.resize(); renderAll(); });
if (document.fonts?.ready) void document.fonts.ready.then(() => schedule());

load('casos');
renderAll();

// Ganchos para pruebas automáticas (Chrome headless)
declare global {
  interface Window {
    uiTest: {
      load(name: string): void;
      play(): void;
      feed(n: number): number;
      jumpEnd(): void;
      setStatus(state: SourceState, source?: 'ble' | 'demo'): void;
      setPaused(p: boolean): void;
      snapshot(): ReturnType<Session['snapshot']>;
      csv(): string;
      renderNow(): void;
    };
  }
}
window.uiTest = {
  load,
  play,
  feed,
  jumpEnd: () => { feed(lines.length); },
  setStatus,
  setPaused: (p) => { if (p !== paused) $('btnPause').click(); },
  snapshot: () => session.snapshot(),
  csv: () => toCsv(session.snapshot()),
  renderNow: renderAll,
};
