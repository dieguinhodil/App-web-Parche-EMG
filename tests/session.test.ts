import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SAMPLES, TASK } from '../src/config';
import { Session } from '../src/core/session';
import type { Estado, Reading, SessionEvent, SessionSnapshot } from '../src/types';

/** Alimenta la sesión a 10 Hz con tiempo absoluto arbitrario (T0 ≠ 0 para probar el reloj relativo). */
class Feeder {
  i = 0;
  constructor(readonly s: Session, readonly T0 = 1234.5) {}
  /** n muestras; r puede ser fija o depender del tiempo de sesión t. */
  push(n: number, r: Partial<Reading> | ((t: number) => Partial<Reading>)): this {
    for (let k = 0; k < n; k++) {
      const t = this.i / 10;
      const p = typeof r === 'function' ? r(t) : r;
      this.s.add({ IF: p.IF ?? 1, pct: p.pct ?? 0, estado: (p.estado ?? 0) as Estado }, this.T0 + t);
      this.i++;
    }
    return this;
  }
  /** Tiempo de sesión de la próxima muestra. */
  get next(): number { return this.i / 10; }
}

/** Escenario base: reposo 2 s → tarea al 40 % desde t=2.0 hasta 16.9 → %CVM 2 desde t=17.0. */
function scenario(s: Session, opts: { during?: (t: number) => Partial<Reading>; after?: Partial<Reading> } = {}) {
  const f = new Feeder(s);
  f.push(20, { pct: 0 });                                          // t 0.0 – 1.9
  f.push(150, (t) => ({ pct: 40, ...(opts.during?.(t) ?? {}) }));  // t 2.0 – 16.9
  f.push(6, { pct: 2, ...(opts.after ?? {}) });                    // t 17.0 – 17.5 → confirma fin
  return f;
}

function record(s: Session) {
  const events: SessionEvent[] = [];
  const snaps: SessionSnapshot[] = [];
  s.subscribe((ev, snap) => { events.push(ev); snaps.push(snap); });
  return { events, snaps, types: () => events.map((e) => e.type) };
}

let s: Session;
beforeEach(() => { s = new Session(); });

describe('reloj y estado inicial', () => {
  it('empieza vacío', () => {
    const snap = s.snapshot();
    expect(snap.samples).toHaveLength(0);
    expect(snap.tasks).toHaveLength(0);
    expect(snap.current).toBeNull();
    expect(snap.last).toBeNull();
    expect(snap.phase).toBe('sin-datos');
    expect(snap.displayState).toBe(-1);
  });

  it('el tiempo de sesión empieza en 0 con la primera muestra', () => {
    s.add({ IF: 1, pct: 0, estado: 0 }, 5000);
    s.add({ IF: 1, pct: 0, estado: 0 }, 5000.1);
    const { samples } = s.snapshot();
    expect(samples[0]!.t).toBe(0);
    expect(samples[1]!.t).toBeCloseTo(0.1, 9);
  });

  it('ignora tiempos no finitos', () => {
    s.add({ IF: 1, pct: 0, estado: 0 }, NaN);
    s.add({ IF: 1, pct: 0, estado: 0 }, Infinity);
    expect(s.snapshot().samples).toHaveLength(0);
  });

  it('guarda el estado crudo del parche en "estado" y el mostrado en "st"', () => {
    s.add({ IF: 1.6, pct: 0, estado: 2 }, 0);   // fuera de tarea
    const last = s.snapshot().last!;
    expect(last.estado).toBe(2);
    expect(last.st).toBe(-1);
    expect(last.valid).toBe(false);
  });
});

describe('detección de tareas', () => {
  it('fuera de tarea (%CVM ≤ onsetPct) no hay tareas ni IF válido', () => {
    new Feeder(s).push(50, { pct: TASK.onsetPct, estado: 1 });
    const snap = s.snapshot();
    expect(snap.tasks).toHaveLength(0);
    expect(snap.phase).toBe('listo');
    expect(snap.samples.every((x) => !x.valid && x.st === -1)).toBe(true);
    expect(snap.displayState).toBe(-1);
  });

  it('inicia con %CVM > onsetPct y el IF es válido desde start + refS', () => {
    const f = new Feeder(s).push(20, { pct: 0 }).push(1, { pct: 11 });
    let snap = s.snapshot();
    expect(snap.tasks).toHaveLength(1);
    expect(snap.current).toBe(snap.tasks[0]);
    expect(snap.current!.start).toBeCloseTo(2.0, 9);
    expect(snap.current!.end).toBeNull();
    expect(snap.phase).toBe('referencia');

    f.push(69, { pct: 40 });                       // t 2.1 – 8.9: aún calculando A0
    snap = s.snapshot();
    expect(snap.last!.t).toBeCloseTo(8.9, 9);
    expect(snap.last!.valid).toBe(false);
    expect(snap.phase).toBe('referencia');

    f.push(1, { pct: 40 });                        // t 9.0 = start + refS
    snap = s.snapshot();
    expect(snap.last!.valid).toBe(true);
    expect(snap.last!.st).toBe(0);
    expect(snap.phase).toBe('tarea');
  });

  it('termina tras endConfirmS debajo de offsetPct, con end = primerBajo − endBacktrackS', () => {
    const f = new Feeder(s).push(20, { pct: 0 }).push(150, { pct: 40 });
    f.push(5, { pct: 2 });                         // t 17.0 – 17.4: todavía no confirma
    expect(s.snapshot().current).not.toBeNull();

    f.push(1, { pct: 2 });                         // t 17.5: confirma
    const snap = s.snapshot();
    expect(snap.current).toBeNull();
    expect(snap.phase).toBe('listo');
    const tk = snap.tasks[0]!;
    expect(tk.end).toBeCloseTo(17.0 - TASK.endBacktrackS, 9);   // 16.0

    // muestras después de end: inválidas; hasta end: válidas
    for (const x of snap.samples) {
      if (x.t > 16.0 + 1e-9) { expect(x.valid).toBe(false); expect(x.st).toBe(-1); }
      else if (x.t >= 9.0 - 1e-9) expect(x.valid).toBe(true);
    }
  });

  it('una bajada corta (< endConfirmS) no termina la tarea', () => {
    const f = new Feeder(s).push(20, { pct: 0 }).push(100, { pct: 40 });
    f.push(4, { pct: 2 }).push(10, { pct: 40 });   // 0.4 s abajo y vuelve
    f.push(5, { pct: 2 });                         // 0.5 s abajo (5 muestras = 0.4 s de lapso)
    expect(s.snapshot().current).not.toBeNull();
    expect(s.snapshot().tasks).toHaveLength(1);
  });

  it('%CVM entre offsetPct y onsetPct mantiene la tarea abierta', () => {
    new Feeder(s).push(20, { pct: 0 }).push(100, { pct: 40 }).push(50, { pct: 7 });
    expect(s.snapshot().current).not.toBeNull();
  });

  it('detecta varias tareas seguidas', () => {
    scenario(s);
    const f = new Feeder(s, 1234.5);
    f.i = 176;                                     // continúa el reloj
    f.push(30, { pct: 0 }).push(120, { pct: 50 }).push(6, { pct: 1 });
    const { tasks, current } = s.snapshot();
    expect(tasks).toHaveLength(2);
    expect(current).toBeNull();
    expect(tasks[1]!.start).toBeCloseTo(20.6, 9);
    expect(tasks[1]!.end).toBeCloseTo(31.6, 9);
  });
});

describe('D1 · tareas de menos de refS se descartan', () => {
  it('el empujón de 4 s de la calibración de CVM no deja tarea: emite task-discard, no task-end', () => {
    const rec = record(s);
    const f = new Feeder(s).push(20, { pct: 0 });
    f.push(40, { pct: 100, IF: 1, estado: 2 });    // t 2.0 – 5.9: 4 s al 100 % CVM
    f.push(6, { pct: 0 });                         // t 6.0 – 6.5: confirma el fin

    expect(rec.types()).not.toContain('task-end');
    const discards = rec.events.filter((e) => e.type === 'task-discard');
    expect(discards).toHaveLength(1);
    const ev = discards[0]!;
    expect(ev.type === 'task-discard' && ev.task.start).toBeCloseTo(2.0, 9);
    expect(ev.type === 'task-discard' && ev.task.end).toBeCloseTo(5.0, 9);   // fin real estimado

    const snap = s.snapshot();
    expect(snap.tasks).toHaveLength(0);
    expect(snap.current).toBeNull();
    expect(snap.phase).toBe('listo');
    expect(snap.displayState).toBe(-1);
    expect(snap.samples.every((x) => !x.valid && x.st === -1)).toBe(true);
    expect(rec.types().filter((t) => t === 'state')).toHaveLength(0);   // nunca hubo estado válido
  });

  it('las lecturas siguen mostrando la última tarea real', () => {
    scenario(s);                                   // tarea real: t 2.0 – 16.0
    const real = s.snapshot().tasks[0]!;
    const f = new Feeder(s);
    f.i = 176;
    f.push(20, { pct: 0 }).push(40, { pct: 100 }).push(6, { pct: 0 });   // empujón de 4 s
    const { tasks } = s.snapshot();
    expect(tasks).toEqual([real]);
    expect(tasks[0]).toBe(real);
    expect(real.end).toBeCloseTo(16.0, 9);
  });

  it('se descarta aunque haya alcanzado a tener muestras válidas, y apaga el estado', () => {
    // tarea desde t 2.0; IF válido desde 9.0 con estado 2; baja en t 9.6 → fin real 8.6 < 9.0
    const rec = record(s);
    const f = new Feeder(s).push(20, { pct: 0 }).push(76, { pct: 40, estado: 2 });   // t 2.0 – 9.5
    expect(s.snapshot().displayState).toBe(2);
    expect(s.snapshot().current!.alarm).toBeCloseTo(9.0, 9);

    f.push(5, { pct: 2, estado: 2 });              // t 9.6 – 10.0
    rec.events.length = 0;
    f.push(1, { pct: 2, estado: 2 });              // t 10.1: confirma
    expect(rec.types()).toEqual(['task-discard', 'state', 'sample']);
    expect(rec.events[1]).toEqual({ type: 'state', from: 2, to: -1 });

    const snap = s.snapshot();
    expect(snap.tasks).toHaveLength(0);
    expect(snap.samples.every((x) => !x.valid && x.st === -1)).toBe(true);
  });

  it('límite: si el fin real cae justo en start + refS, la tarea se conserva', () => {
    const rec = record(s);
    const f = new Feeder(s).push(20, { pct: 0 });
    f.push(80, (t) => ({ pct: 40, IF: 1 + (t - 2) / 100 }));   // t 2.0 – 9.9
    f.push(6, { pct: 2, IF: 5 });                  // baja en t 10.0 → fin real 9.0 = start + refS
    expect(rec.types()).toContain('task-end');
    expect(rec.types()).not.toContain('task-discard');
    const tk = s.snapshot().tasks[0]!;
    expect(tk.end).toBeCloseTo(9.0, 9);
    expect(tk.maxIF).toBeCloseTo(1.07, 9);         // única muestra válida: t = 9.0
  });

  it('una décima antes del límite ya se descarta', () => {
    const f = new Feeder(s).push(20, { pct: 0 });
    f.push(79, { pct: 40 });                       // t 2.0 – 9.8
    f.push(6, { pct: 2 });                         // baja en t 9.9 → fin real 8.9 < 9.0
    expect(s.snapshot().tasks).toHaveLength(0);
  });
});

describe('alarma e IF máximo', () => {
  it('ignora el estado 2 durante el cálculo de A0', () => {
    scenario(s, { during: (t) => ({ estado: t < 9 ? 2 : 0 }) });
    expect(s.snapshot().tasks[0]!.alarm).toBeNull();
  });

  it('la alarma es el primer instante válido con estado 2', () => {
    scenario(s, { during: (t) => ({ estado: t >= 12 - 1e-9 ? 2 : t >= 10 - 1e-9 ? 1 : 0 }) });
    const tk = s.snapshot().tasks[0]!;
    expect(tk.alarm).toBeCloseTo(12.0, 9);
  });

  it('la alarma posterior al fin recalculado se anula', () => {
    // estado 2 aparece en t=16.5 (después de end=16.0, antes de confirmar el fin)
    scenario(s, { during: (t) => ({ estado: t >= 16.5 - 1e-9 ? 2 : 0 }), after: { estado: 2 } });
    expect(s.snapshot().tasks[0]!.alarm).toBeNull();
  });

  it('IF máximo solo cuenta muestras válidas hasta el fin recalculado', () => {
    // IF sube con el tiempo; después de 16.0 y en la bajada el IF es enorme, pero no cuenta
    scenario(s, { during: (t) => ({ IF: t > 16.0 + 1e-9 ? 9 : 1 + (t - 2) / 100 }), after: { IF: 9 } });
    const tk = s.snapshot().tasks[0]!;
    expect(tk.maxIF).toBeCloseTo(1 + 14 / 100, 9);   // IF en t = 16.0
  });

  it('mientras la tarea está en curso, maxIF y alarm se actualizan en vivo', () => {
    const f = new Feeder(s).push(20, { pct: 0 });
    f.push(100, (t) => ({ pct: 40, IF: 1 + (t - 2) / 10, estado: t >= 10 - 1e-9 ? 2 : 0 })); // t 2.0 – 11.9
    const cur = s.snapshot().current!;
    expect(cur.maxIF).toBeCloseTo(1 + 9.9 / 10, 9);
    expect(cur.alarm).toBeCloseTo(10.0, 9);
  });
});

describe('eventos', () => {
  it('emite task-start y task-end con la tarea', () => {
    const rec = record(s);
    scenario(s);
    const start = rec.events.find((e) => e.type === 'task-start');
    const end = rec.events.find((e) => e.type === 'task-end');
    expect(start && start.type === 'task-start' && start.task).toBe(s.snapshot().tasks[0]);
    expect(end && end.type === 'task-end' && end.task.end).toBeCloseTo(16.0, 9);
  });

  it('emite un "sample" por lectura', () => {
    const rec = record(s);
    new Feeder(s).push(37, { pct: 0 });
    expect(rec.types().filter((t) => t === 'sample')).toHaveLength(37);
  });

  it('emite "state" en cada cambio de displayState', () => {
    const rec = record(s);
    scenario(s, { during: (t) => ({ estado: t >= 13 - 1e-9 ? 2 : t >= 11 - 1e-9 ? 1 : 0 }), after: { estado: 2 } });
    const states = rec.events.flatMap((e) => (e.type === 'state' ? [[e.from, e.to]] : []));
    expect(states).toEqual([[-1, 0], [0, 1], [1, 2], [2, -1]]);
    expect(s.snapshot().displayState).toBe(-1);
  });

  it('orden dentro de una lectura: task-start → task-end → state → sample', () => {
    const rec = record(s);
    const f = new Feeder(s).push(20, { pct: 0 });
    rec.events.length = 0;
    f.push(1, { pct: 40 });
    expect(rec.types()).toEqual(['task-start', 'sample']);

    f.push(149, { pct: 40, estado: 2 });
    f.push(5, { pct: 2, estado: 2 });
    rec.events.length = 0;
    f.push(1, { pct: 2, estado: 2 });              // confirma el fin estando en riesgo
    expect(rec.types()).toEqual(['task-end', 'state', 'sample']);
  });

  it('todos los oyentes reciben el mismo snapshot, ya actualizado', () => {
    const rec = record(s);
    new Feeder(s).push(20, { pct: 0 }).push(1, { pct: 40 });
    const i = rec.events.findIndex((e) => e.type === 'task-start');
    expect(rec.snaps[i]!.current).not.toBeNull();
    expect(rec.snaps[i]!.samples).toHaveLength(21);
  });

  it('unsubscribe deja de avisar', () => {
    const fn = vi.fn();
    const off = s.subscribe(fn);
    new Feeder(s).push(3, { pct: 0 });
    off();
    new Feeder(s).push(3, { pct: 0 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('un oyente que lanza un error no rompe a los demás', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = vi.fn();
    s.subscribe(() => { throw new Error('boom'); });
    s.subscribe(ok);
    new Feeder(s).push(2, { pct: 0 });
    expect(ok).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('pausa', () => {
  it('en pausa ignora lecturas y no emite nada', () => {
    const f = new Feeder(s).push(10, { pct: 0 });
    const rec = record(s);
    s.setPaused(true);
    f.push(10, { pct: 40 });
    expect(s.snapshot().samples).toHaveLength(10);
    expect(rec.events).toHaveLength(0);
  });

  it('al pausar en riesgo emite state → -1, y al continuar vuelve con la siguiente lectura', () => {
    const f = new Feeder(s).push(20, { pct: 0 }).push(100, { pct: 40, estado: 2 });
    expect(s.snapshot().displayState).toBe(2);
    const rec = record(s);

    s.setPaused(true);
    expect(rec.events).toEqual([{ type: 'state', from: 2, to: -1 }]);
    expect(s.snapshot().displayState).toBe(-1);

    s.setPaused(true);                              // repetido: no hace nada
    expect(rec.events).toHaveLength(1);

    s.setPaused(false);
    expect(rec.events).toHaveLength(1);             // continuar no emite por sí solo
    f.push(1, { pct: 40, estado: 2 });
    expect(rec.events.slice(1)).toEqual([{ type: 'state', from: -1, to: 2 }, { type: 'sample' }]);
  });
});

describe('reset', () => {
  it('borra todo, reinicia el reloj y emite state (si hacía falta) y reset', () => {
    const f = new Feeder(s).push(20, { pct: 0 }).push(100, { pct: 40, estado: 1 });
    const rec = record(s);
    s.reset();
    expect(rec.events).toEqual([{ type: 'state', from: 1, to: -1 }, { type: 'reset' }]);
    const snap = s.snapshot();
    expect(snap.samples).toHaveLength(0);
    expect(snap.tasks).toHaveLength(0);
    expect(snap.current).toBeNull();
    expect(snap.phase).toBe('sin-datos');

    f.push(1, { pct: 0 });
    expect(s.snapshot().samples[0]!.t).toBe(0);    // reloj nuevo
  });

  it('sin estado activo solo emite reset', () => {
    new Feeder(s).push(5, { pct: 0 });
    const rec = record(s);
    s.reset();
    expect(rec.types()).toEqual(['reset']);
  });

  it('no cambia la pausa', () => {
    s.setPaused(true);
    s.reset();
    new Feeder(s).push(5, { pct: 0 });
    expect(s.snapshot().samples).toHaveLength(0);
  });
});

describe('memoria', () => {
  it(`al pasar de MAX_SAMPLES (${MAX_SAMPLES}) borra las 6000 más viejas`, () => {
    new Feeder(s).push(MAX_SAMPLES + 1, { pct: 0 });
    const { samples } = s.snapshot();
    expect(samples).toHaveLength(MAX_SAMPLES + 1 - 6000);
    expect(samples[0]!.t).toBeCloseTo(600.0, 6);
  });
});
