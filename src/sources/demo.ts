// Fuente "demo": genera el mismo texto que el parche ("IF,%CVM,estado\n", 10 mensajes por segundo
// de tiempo virtual) con el modelo sintético del simulador. Es un port fiel del bloque
// "Modo demo" de legacy/index.html: con la misma semilla produce exactamente las mismas líneas.
//
// Tiempo (D2): tAbsS es virtual. Empieza en 0 y avanza 0.1 s por mensaje, también a ×5
// (a ×5 salen 50 mensajes por segundo real, pero cada uno sigue valiendo 0.1 s).
// Si la misma fuente se detiene y se vuelve a iniciar, retoma donde se quedó (mismo "sujeto",
// mismo reloj), como una pausa. Para empezar desde 0, crea una fuente nueva.

import { TASK, THRESHOLDS } from '../config';
import type { SourceStatus } from '../types';
import type { DataSource } from './source';

export interface DemoSource extends DataSource {
  setSpeed(x: 1 | 5): void;
}

/** Texto de estado mientras el demo corre (listo para mostrarse en la barra de conexión). */
export const DEMO_DETAIL = 'Modo demo (datos sintéticos)';

const MSGS_PER_S = 10;  // mensajes por s virtual (10 Hz, igual que el parche): 0.1 s cada uno
const TICK_MS = 100;    // periodo del temporizador real
const MAX_CATCHUP_MS = 1000;   // si la pestaña estuvo dormida, no recupera más de 1 s real

// ---------------------------------------------------------------------------
// Generador puro (sin temporizadores): una línea por llamada
// ---------------------------------------------------------------------------

function rng(s: number): () => number {
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function gauss(r: () => number): number {
  const u = r() || 1e-9, v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface Subject {
  r: () => number;
  load: number;             // %CVM sostenido (35–55)
  k: number;                // velocidad de fatiga
  g: (u: number) => number; // crecimiento de la amplitud con la fatiga
  rest: number;             // s de reposo antes de la tarea
  tFail: number;            // s en que el sujeto suelta la carga
  end: number;              // s en que termina este sujeto y empieza otro
}

function newSubject(seed: number): Subject {
  const r = rng(seed * 9973 + 17);
  const load = 35 + Math.round(r() * 20);
  const k = 0.0045 * Math.pow(load / 30, 2);
  const g = (u: number) => 1 + u + 0.6 * Math.pow(Math.max(0, u - 0.35), 2);
  let tt = 0; while (g(k * tt) < 2 && tt < 400) tt += 0.05;
  return { r, load, k, g, rest: 5, tFail: 5 + tt, end: 5 + tt + 8 };
}

export interface DemoGenerator {
  /** Devuelve la siguiente línea, con '\n' al final. Cada llamada equivale a 0.1 s. */
  next(): string;
}

/**
 * Generador determinista del demo. Simula al sujeto (reposo → contracción sostenida
 * con fatiga → suelta la carga) y la máquina de estados del firmware (A₀ entre 2 y 7 s,
 * precaución IF ≥ 1.25, riesgo IF ≥ 1.50 sostenido 2 s, sale de riesgo con IF < 1.40 durante 3 s).
 * Al terminar un sujeto empieza otro con semilla + 1.
 */
export function createDemoGenerator(seed: number): DemoGenerator {
  const B = 2.4, W = 10;                       // línea base y 1 s de promedio a 10 Hz
  const ONSET = TASK.onsetPct, REF_S = TASK.refS;
  const TH_WARN = THRESHOLDS.warn, TH_RISK = THRESHOLDS.risk;

  let subj = newSubject(seed);
  let ts = 0, ring: number[] = [], a0: number | null = null, acc = 0, n = 0;
  let IF = 1, state: 0 | 1 | 2 = 0, tOver: number | null = null, tUnder: number | null = null;
  let inTask = false, taskT = 0;

  return {
    next(): string {
      const s = subj, ti = ts;
      let e: number;
      if (ti < s.rest) e = 2 + Math.abs(gauss(s.r)) * 0.7;
      else if (ti < s.tFail) {
        const u = s.k * (ti - s.rest);
        const trem = u > 0.45 ? Math.sin(ti * 11.3) * s.load * 0.12 * (u - 0.45) : 0;
        e = s.load * s.g(u) * (1 + 0.09 * gauss(s.r)) + trem;
      } else e = 3 + Math.abs(gauss(s.r)) * 1.2;
      e = Math.max(0, e);
      ring.push(e); if (ring.length > W) ring.shift();
      const sm = ring.reduce((a, b) => a + b, 0) / ring.length;
      const pct = Math.max(0, (sm - B) / (100 - B) * 100);

      // máquina de estados (igual que el firmware)
      // D10: durante la referencia el parche manda IF = 1.00 (no el IF viejo de la tarea anterior)
      if (!inTask && pct > ONSET) { inTask = true; taskT = 0; a0 = null; acc = 0; n = 0; state = 0; tOver = tUnder = null; IF = 1; }
      if (inTask) {
        taskT += 0.1;
        if (a0 === null) {
          if (taskT > 2) { acc += sm; n++; }
          if (taskT > REF_S) a0 = acc / n;
        } else {
          IF = (sm - B) / (a0 - B);
          if (IF >= TH_RISK) { if (tOver === null) tOver = taskT; } else tOver = null;
          if (state !== 2) {
            if (tOver !== null && taskT - tOver >= 2) state = 2;
            else state = IF >= TH_WARN ? 1 : 0;
          } else {
            if (IF < TH_RISK - 0.10) { if (tUnder === null) tUnder = taskT; } else tUnder = null;
            if (tUnder !== null && taskT - tUnder >= 3) { state = 1; tUnder = null; }
          }
        }
        if (pct < ONSET / 2) { inTask = false; state = 0; IF = 1; }   // D10b: de vuelta en "listo", IF = 1.00
      }
      const line = IF.toFixed(2) + ',' + pct.toFixed(0) + ',' + state + '\n';
      ts += 0.1;
      if (ts >= s.end) { seed++; subj = newSubject(seed); ts = 0; ring = []; }   // siguiente "sujeto"
      return line;
    },
  };
}

// ---------------------------------------------------------------------------
// Fuente con temporizador
// ---------------------------------------------------------------------------

type DataFn = (chunk: string, tAbsS: number) => void;
type StatusFn = (s: SourceStatus) => void;

class DemoDataSource implements DemoSource {
  readonly kind = 'demo' as const;
  private readonly gen: DemoGenerator;
  private speed: 1 | 5;
  private sent = 0;                      // mensajes enviados: tAbsS = sent × 0.1
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private debtMs = 0;                    // tiempo real acumulado aún sin convertir en mensajes
  private readonly dataFns: DataFn[] = [];
  private readonly statusFns: StatusFn[] = [];

  constructor(speed: 1 | 5, seed: number) {
    this.speed = speed;
    this.gen = createDemoGenerator(seed);
  }

  async start(): Promise<void> {
    if (this.timer !== null) return;
    this.lastTick = Date.now();
    this.debtMs = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.emitStatus({ state: 'connected', detail: DEMO_DETAIL });
  }

  async stop(): Promise<void> {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    this.emitStatus({ state: 'idle', detail: 'Sin conexión' });
  }

  setSpeed(x: 1 | 5): void {
    this.speed = x === 5 ? 5 : 1;
  }

  onData(fn: DataFn): void { this.dataFns.push(fn); }
  onStatus(fn: StatusFn): void { this.statusFns.push(fn); }

  private tick(): void {
    // Cuenta el tiempo real transcurrido (no los disparos del temporizador): así la tasa
    // es exacta aunque setInterval se retrase, y si el navegador frenó la pestaña en segundo
    // plano se recupera como mucho 1 s de golpe.
    const now = Date.now();
    this.debtMs += Math.min(Math.max(0, now - this.lastTick), MAX_CATCHUP_MS);
    this.lastTick = now;
    while (this.debtMs >= TICK_MS && this.timer !== null) {
      this.debtMs -= TICK_MS;
      for (let i = 0; i < this.speed && this.timer !== null; i++) this.emitOne();
    }
  }

  private emitOne(): void {
    const line = this.gen.next();
    const t = this.sent / MSGS_PER_S;   // 0, 0.1, 0.2… sin error acumulado
    this.sent++;
    for (const fn of this.dataFns) fn(line, t);
  }

  private emitStatus(s: SourceStatus): void {
    for (const fn of this.statusFns) fn(s);
  }
}

/**
 * Crea la fuente demo. `speed` por defecto 1; `seed` por defecto al azar (0–999, como el legacy).
 * Con la misma semilla las líneas son siempre las mismas (útil para pruebas).
 */
export function createDemoSource(opts?: { speed?: 1 | 5; seed?: number }): DemoSource {
  const speed = opts?.speed === 5 ? 5 : 1;
  const seed = opts?.seed ?? Math.floor(Math.random() * 1000);
  return new DemoDataSource(speed, seed);
}
