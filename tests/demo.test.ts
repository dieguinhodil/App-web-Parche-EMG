import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoGenerator, createDemoSource, DEMO_DETAIL } from '../src/sources/demo';
import { TASK } from '../src/config';
import { LineParser } from '../src/core/protocol';
import { Session } from '../src/core/session';
import type { SourceStatus } from '../src/types';

const LINE_RE = /^\d+\.\d{2},\d+,[012]\n$/;

// ---------------------------------------------------------------------------
// Copia del generador demo de claude/app-legacy-index.html (versión con D10 y D10b, 17 nov).
// Sirve para comprobar que demo.ts produce exactamente las mismas líneas.
// Si el legacy cambia, se actualiza esta copia y demo.ts a la vez.
// ---------------------------------------------------------------------------
function legacyLines(seed0: number, count: number): string[] {
  const ONSET = 10, REF_S = 7, TH_WARN = 1.25, TH_RISK = 1.50;
  const rng = (s: number) => () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const gauss = (r: () => number) => { const u = r() || 1e-9, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const newSubject = (seed: number) => {
    const r = rng(seed * 9973 + 17);
    const load = 35 + Math.round(r() * 20);
    const k = 0.0045 * Math.pow(load / 30, 2);
    const g = (u: number) => 1 + u + 0.6 * Math.pow(Math.max(0, u - 0.35), 2);
    let tt = 0; while (g(k * tt) < 2 && tt < 400) tt += 0.05;
    return { r, load, k, g, rest: 5, tFail: 5 + tt, end: 5 + tt + 8 };
  };
  const out: string[] = [];
  const B = 2.4, W = 10;
  let seed = seed0, subj = newSubject(seed);
  let ts = 0, ring: number[] = [], a0: number | null = null, acc = 0, n = 0, IF = 1, state = 0;
  let tOver: number | null = null, tUnder: number | null = null, inTask = false, taskT = 0;
  for (let i = 0; i < count; i++) {
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
      if (pct < ONSET / 2) { inTask = false; state = 0; IF = 1; }
    }
    out.push(IF.toFixed(2) + ',' + pct.toFixed(0) + ',' + state + '\n');
    ts += 0.1;
    if (ts >= s.end) { seed++; subj = newSubject(seed); ts = 0; ring = []; }
  }
  return out;
}

describe('createDemoGenerator', () => {
  it('produce líneas con el formato del parche', () => {
    const g = createDemoGenerator(3);
    for (let i = 0; i < 6000; i++) expect(g.next()).toMatch(LINE_RE);
  });

  it('es determinista con la misma semilla y cambia con otra', () => {
    const a = createDemoGenerator(42), b = createDemoGenerator(42), c = createDemoGenerator(43);
    const la = Array.from({ length: 2000 }, () => a.next());
    const lb = Array.from({ length: 2000 }, () => b.next());
    const lc = Array.from({ length: 2000 }, () => c.next());
    expect(la).toEqual(lb);
    expect(la).not.toEqual(lc);
  });

  it('produce exactamente las mismas líneas que el legacy (con D10 y D10b)', () => {
    for (const seed of [0, 1, 17, 123, 500, 999]) {
      const g = createDemoGenerator(seed);
      const mine = Array.from({ length: 12000 }, () => g.next());   // 20 min virtuales
      expect(mine).toEqual(legacyLines(seed, 12000));
    }
  });

  it('D10: manda IF = 1.00 desde que empieza cada tarea hasta que hay A₀ (sin el IF viejo)', () => {
    for (const seed of [1, 250, 999]) {
      const g = createDemoGenerator(seed), parser = new LineParser(), session = new Session();
      let tasksSeen = 0;
      for (let i = 0; i < 12000; i++) {
        const line = g.next();
        for (const r of parser.push(line)) {
          session.add(r, i / 10);
          const snap = session.snapshot();
          const cur = snap.current, last = snap.last!;
          if (cur && last.t < cur.start + 7 - 1e-6) expect(line.startsWith('1.00,')).toBe(true);
          if (cur && last.t === cur.start) tasksSeen++;
          // primera muestra válida de cada tarea: sin pico falso hacia abajo
          if (cur && last.valid && Math.abs(last.t - (cur.start + 7)) < 1e-6) expect(last.IF).toBeGreaterThan(0.8);
        }
      }
      expect(tasksSeen).toBeGreaterThanOrEqual(3);
    }
  });

  it('D10b: entre tareas todas las líneas llevan IF 1.00, salvo el tramo final que la sesión recorta', () => {
    // La sesión marca el fin real 1 s antes de la primera muestra baja (endBacktrackS). Ese tramo
    // sí trae IF reales de la contracción; el generador vuelve a "listo" (IF = 1.00) justo en la
    // primera muestra baja, así que el tramo de confirmación (endConfirmS) ya sale en 1.00.
    for (const seed of [1, 250, 999]) {
      const g = createDemoGenerator(seed), parser = new LineParser(), session = new Session();
      for (let i = 0; i < 12000; i++) for (const r of parser.push(g.next())) session.add(r, i / 10);
      const snap = session.snapshot();
      const done = snap.tasks.filter((t) => t.end !== null);
      expect(done.length).toBeGreaterThanOrEqual(3);
      const limit = snap.current ? snap.current.start : Infinity;   // la tarea en curso no cuenta
      let between = 0;
      for (const x of snap.samples) {
        if (x.t >= limit - 1e-6) continue;
        if (done.some((t) => x.t >= t.start - 1e-6 && x.t <= t.end! + 1e-6)) continue;
        between++;
        if (x.IF === 1) continue;
        const prev = done.filter((t) => t.end! < x.t).at(-1);
        expect(prev, `IF ${x.IF} en t = ${x.t} antes de la primera tarea`).toBeDefined();
        expect(x.t - prev!.end!, `IF ${x.IF} en t = ${x.t}, ${(x.t - prev!.end!).toFixed(1)} s después del fin`).toBeLessThan(TASK.endBacktrackS);
      }
      expect(between).toBeGreaterThan(1000);
    }
  });

  it('con el núcleo genera tareas completas, con alarma e IF máximo ≥ 1.5', () => {
    for (const seed of [1, 250, 999]) {
      const g = createDemoGenerator(seed), parser = new LineParser(), session = new Session();
      for (let i = 0; i < 12000; i++) {               // 20 min virtuales
        for (const r of parser.push(g.next())) session.add(r, i / 10);
      }
      const done = session.snapshot().tasks.filter((t) => t.end !== null);
      expect(done.length).toBeGreaterThanOrEqual(3);
      for (const t of done) {
        expect(t.alarm).not.toBeNull();
        expect(t.maxIF!).toBeGreaterThanOrEqual(1.5);
        expect(t.end! - t.start).toBeGreaterThan(7);
      }
    }
  });
});

describe('createDemoSource', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function collect(speed: 1 | 5 = 1) {
    const src = createDemoSource({ speed, seed: 5 });
    const data: Array<[string, number]> = [];
    const status: SourceStatus[] = [];
    src.onData((c, t) => data.push([c, t]));
    src.onStatus((s) => status.push(s));
    return { src, data, status };
  }

  it('kind demo; start → connected, stop → idle', async () => {
    const { src, status } = collect();
    expect(src.kind).toBe('demo');
    await src.start();
    expect(status.at(-1)).toEqual({ state: 'connected', detail: DEMO_DETAIL });
    await src.stop();
    expect(status.at(-1)?.state).toBe('idle');
    expect(status).toHaveLength(2);
  });

  it('×1: 10 mensajes por segundo; el tiempo virtual empieza en 0 y avanza 0.1 s', async () => {
    const { src, data } = collect(1);
    await src.start();
    vi.advanceTimersByTime(1000);
    expect(data).toHaveLength(10);
    expect(data.map(([, t]) => t)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    for (const [c] of data) expect(c).toMatch(LINE_RE);   // una línea completa por fragmento
    await src.stop();
  });

  it('×5: 50 mensajes por segundo real, pero cada uno sigue valiendo 0.1 s', async () => {
    const { src, data } = collect(5);
    await src.start();
    vi.advanceTimersByTime(1000);
    expect(data).toHaveLength(50);
    expect(data.at(-1)![1]).toBeCloseTo(4.9, 9);
    src.setSpeed(1);
    vi.advanceTimersByTime(1000);
    expect(data).toHaveLength(60);
    expect(data.at(-1)![1]).toBeCloseTo(5.9, 9);
    await src.stop();
  });

  it('stop detiene los datos; start de nuevo retoma el mismo reloj y el mismo sujeto', async () => {
    const { src, data } = collect(1);
    const ref = createDemoGenerator(5);
    await src.start();
    vi.advanceTimersByTime(500);
    await src.stop();
    vi.advanceTimersByTime(3000);
    expect(data).toHaveLength(5);
    await src.start();
    vi.advanceTimersByTime(500);
    expect(data).toHaveLength(10);
    expect(data.map(([, t]) => t)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    expect(data.map(([c]) => c)).toEqual(Array.from({ length: 10 }, () => ref.next()));
    await src.stop();
  });

  it('start dos veces no duplica el temporizador', async () => {
    const { src, data, status } = collect(1);
    await src.start(); await src.start();
    vi.advanceTimersByTime(1000);
    expect(data).toHaveLength(10);
    expect(status).toHaveLength(1);
    await src.stop();
  });

  it('si la pestaña se frena, recupera como mucho 1 s de golpe', async () => {
    const { src, data } = collect(1);
    await src.start();
    vi.setSystemTime(Date.now() + 30_000);   // 30 s sin que corra el temporizador
    vi.advanceTimersByTime(100);
    expect(data.length).toBeLessThanOrEqual(11);
    await src.stop();
  });
});
