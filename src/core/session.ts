// Sesión de medición: guarda las muestras, detecta tareas (misma regla que el firmware),
// marca qué IF es válido, registra la alarma y avisa a la interfaz con eventos.
// Comportamiento idéntico a ingestLine() de legacy/index.html, salvo D1 (tareas < refS se descartan).

import { MAX_SAMPLES, TASK } from '../config';
import type {
  DisplayState,
  Phase,
  Reading,
  SessionEvent,
  SessionSample,
  SessionSnapshot,
  Task,
} from '../types';

type Listener = (ev: SessionEvent, snap: SessionSnapshot) => void;

/** Tolerancia para comparar tiempos (0.1 + 0.1 + … no da exacto en coma flotante). */
const EPS = 1e-6;
/** Al pasar de MAX_SAMPLES se borran de golpe las más viejas (igual que el legacy). */
const TRIM = 6000;

export class Session {
  private samples: SessionSample[] = [];
  private tasks: Task[] = [];
  private cur: Task | null = null;
  private lowSince: number | null = null;   // t en que %CVM bajó de offsetPct (tarea en curso)
  private t0: number | null = null;         // tiempo absoluto de la primera muestra
  private paused = false;
  private state: DisplayState = -1;
  private listeners = new Set<Listener>();

  /**
   * Agrega una lectura. tAbsS: tiempo absoluto en s (performance.now()/1000 o virtual).
   * Orden de eventos emitidos en una misma llamada: task-start → task-end/task-discard → state → sample.
   */
  add(r: Reading, tAbsS: number): void {
    if (this.paused || !Number.isFinite(tAbsS)) return;
    if (this.t0 === null) this.t0 = tAbsS;
    const t = tAbsS - this.t0;
    const { IF, pct, estado } = r;
    const events: SessionEvent[] = [];

    // Inicio de tarea
    if (!this.cur && pct > TASK.onsetPct) {
      this.cur = { start: t, end: null, alarm: null, maxIF: null };
      this.tasks.push(this.cur);
      this.lowSince = null;
      events.push({ type: 'task-start', task: this.cur });
    }

    let valid = false;
    const cur = this.cur;
    if (cur) {
      valid = t - cur.start >= TASK.refS - EPS;
      if (valid) {
        cur.maxIF = cur.maxIF === null ? IF : Math.max(cur.maxIF, IF);
        if (estado === 2 && cur.alarm === null) cur.alarm = t;
      }

      // Fin de tarea: %CVM < offsetPct sostenido endConfirmS
      if (pct < TASK.offsetPct) { if (this.lowSince === null) this.lowSince = t; }
      else this.lowSince = null;

      if (this.lowSince !== null && t - this.lowSince >= TASK.endConfirmS - EPS) {
        const kept = this.closeTask(cur, this.lowSince);
        events.push({ type: kept ? 'task-end' : 'task-discard', task: cur });
        valid = false;
      }
    }

    const sample: SessionSample = { t, IF, pct, estado, st: valid ? estado : -1, valid };
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, TRIM);

    if (sample.st !== this.state) {
      events.push({ type: 'state', from: this.state, to: sample.st });
      this.state = sample.st;
    }
    events.push({ type: 'sample' });
    this.emit(events);
  }

  /**
   * En pausa se ignoran las lecturas. Al pausar, displayState pasa a -1
   * (emite 'state' si estaba en otro valor) para que se apague la alarma.
   */
  setPaused(p: boolean): void {
    if (p === this.paused) return;
    this.paused = p;
    if (p && this.state !== -1) {
      const from = this.state;
      this.state = -1;
      this.emit([{ type: 'state', from, to: -1 }]);
    }
  }

  /** Borra todo (nueva sesión). No cambia la pausa. Emite 'state' (si hacía falta) y 'reset'. */
  reset(): void {
    this.samples = [];
    this.tasks = [];
    this.cur = null;
    this.lowSince = null;
    this.t0 = null;
    const events: SessionEvent[] = [];
    if (this.state !== -1) {
      events.push({ type: 'state', from: this.state, to: -1 });
      this.state = -1;
    }
    events.push({ type: 'reset' });
    this.emit(events);
  }

  /**
   * Vista del estado actual. Los arreglos y objetos son los internos (no se copian
   * por rendimiento): solo lectura, y pueden cambiar en la siguiente llamada a add().
   */
  snapshot(): SessionSnapshot {
    const last = this.samples.length ? this.samples[this.samples.length - 1]! : null;
    let phase: Phase;
    if (!last) phase = 'sin-datos';
    else if (!this.cur) phase = 'listo';
    else phase = last.valid ? 'tarea' : 'referencia';
    return {
      samples: this.samples,
      tasks: this.tasks,
      current: this.cur,
      last,
      phase,
      displayState: this.state,
    };
  }

  /** Suscribe un oyente. Devuelve la función para desuscribirlo. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  // ------------------------------------------------------------------

  /**
   * Cierra la tarea. El parche promedia 1 s, así que la caída empezó ~endBacktrackS
   * antes de cruzar offsetPct: end = lowSince − endBacktrackS.
   * - D1: si end < start + refS, la tarea no tuvo ningún IF válido (p. ej. el empujón de
   *   la calibración de CVM): se quita de tasks y devuelve false (→ 'task-discard').
   * - Si no, las muestras posteriores a end dejan de ser válidas; alarm y maxIF se
   *   recalculan, y devuelve true (→ 'task-end').
   */
  private closeTask(task: Task, lowSince: number): boolean {
    const rawEnd = lowSince - TASK.endBacktrackS;
    this.cur = null;
    this.lowSince = null;

    if (rawEnd < task.start + TASK.refS - EPS) {
      this.discardTask(task, rawEnd);
      return false;
    }

    const end = Math.max(task.start + TASK.refS, rawEnd);   // el max solo absorbe la tolerancia EPS
    task.end = end;

    for (let i = this.samples.length - 1; i >= 0; i--) {
      const s = this.samples[i]!;
      if (s.t <= end) break;
      s.valid = false;
      s.st = -1;
    }

    if (task.alarm !== null && task.alarm > end) task.alarm = null;

    task.maxIF = null;
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const s = this.samples[i]!;
      if (s.t < task.start) break;
      if (s.valid && s.t <= end) task.maxIF = task.maxIF === null ? s.IF : Math.max(task.maxIF, s.IF);
    }
    return true;
  }

  /** D1: quita la tarea de tasks y deja inválidas todas sus muestras. */
  private discardTask(task: Task, rawEnd: number): void {
    const i = this.tasks.lastIndexOf(task);
    if (i >= 0) this.tasks.splice(i, 1);

    for (let k = this.samples.length - 1; k >= 0; k--) {
      const s = this.samples[k]!;
      if (s.t < task.start - EPS) break;
      s.valid = false;
      s.st = -1;
    }

    // El objeto viaja en el evento solo como referencia: end = fin real estimado (sin el piso de refS).
    task.end = Math.max(task.start, rawEnd);
    task.alarm = null;
    task.maxIF = null;
  }

  private emit(events: SessionEvent[]): void {
    if (!this.listeners.size || !events.length) return;
    const snap = this.snapshot();
    const fns = [...this.listeners];   // copia: permite desuscribirse dentro del oyente
    for (const ev of events) {
      for (const fn of fns) {
        try { fn(ev, snap); }
        catch (err) { console.error('[Session] error en un oyente', err); }
      }
    }
  }
}
