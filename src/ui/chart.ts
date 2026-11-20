// Gráfica del IF en un <canvas> (chat 3). Sale de draw()/trace() de legacy/index.html.
// Dibuja: bandas normal/precaución/riesgo, umbrales 1.25 y 1.50, el IF válido de cada tarea
// y los marcadores A₀ (fin de la referencia), "alarma" y "fin" de cada tarea.
//
// Uso: const chart = createChart(canvas); chart.render(session.snapshot());
// - render() no guarda el snapshot (es una vista en vivo, ver notas del chat 1).
// - render() detecta solo si el canvas cambió de tamaño o de devicePixelRatio; resize()
//   fuerza el reajuste y vuelve a leer los colores del tema.

import { CHART, TASK, THRESHOLDS } from '../config';
import type { SessionSample, SessionSnapshot } from '../types';

export interface Chart {
  render(s: SessionSnapshot): void;
  resize(): void;
}

interface Colors {
  ink: string; muted: string; line: string; signal: string; warn: string; risk: string;
  okT: string; warnT: string; riskT: string;
}

/** Márgenes del área de trazo, en px CSS (iguales al legacy). */
const PAD = { L: 44, R: 12, T: 14, B: 30 } as const;
/** Hueco entre muestras a partir del cual se corta la línea (desconexión o pausa). */
const GAP_S = 1.5;
const Y_MIN = 0.8;
const Y_MAX_DEFAULT = 2.2;
const Y_MAX_CAP = 4;
const FONT = '11px "IBM Plex Mono", ui-monospace, monospace';

export function createChart(canvas: HTMLCanvasElement): Chart {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('chart: el navegador no tiene Canvas 2D');

  let cssW = 0, cssH = 0, dpr = 0;
  let colors = readColors();
  let colorsDirty = false;

  // Tema claro/oscuro: los colores salen de las variables CSS. Si cambia el tema del sistema,
  // se vuelven a leer en el siguiente render().
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { colorsDirty = true; });
  } catch { /* navegador viejo: se quedan los colores iniciales hasta el próximo resize() */ }

  function resize(): void {
    dpr = window.devicePixelRatio || 1;
    cssW = canvas.clientWidth;
    cssH = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    colors = readColors();
    colorsDirty = false;
  }

  function render(s: SessionSnapshot): void {
    if (canvas.clientWidth !== cssW || canvas.clientHeight !== cssH || (window.devicePixelRatio || 1) !== dpr) resize();
    if (colorsDirty) { colors = readColors(); colorsDirty = false; }
    if (cssW < PAD.L + PAD.R + 10 || cssH < PAD.T + PAD.B + 10) return;   // canvas oculto o muy chico
    draw(ctx!, s, cssW, cssH, colors);
  }

  return { render, resize };
}

// ---------------------------------------------------------------------------

function readColors(): Colors {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, fallback: string) => cs.getPropertyValue(n).trim() || fallback;
  return {
    ink: v('--ink', '#16202A'), muted: v('--muted', '#566371'), line: v('--line', '#D3D9DF'),
    signal: v('--signal', '#0B7480'), warn: v('--warn', '#B57A00'), risk: v('--risk', '#C42B2B'),
    okT: v('--ok-t', 'rgba(44,138,75,.10)'), warnT: v('--warn-t', 'rgba(181,122,0,.12)'), riskT: v('--risk-t', 'rgba(196,43,43,.12)'),
  };
}

/** Primer índice con t ≥ tMin (las muestras están ordenadas por t). */
function firstIndexFrom(samples: readonly SessionSample[], tMin: number): number {
  let lo = 0, hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid]!.t < tMin) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function draw(ctx: CanvasRenderingContext2D, s: SessionSnapshot, w: number, h: number, c: Colors): void {
  const { L, R, T: Tp, B: Bt } = PAD;
  const pw = w - L - R, ph = h - Tp - Bt;
  const samples = s.samples;
  const tLast = s.last ? s.last.t : 0;

  // Eje X: empieza en 0 y crece de 30 en 30 s; pasada la ventana, se desliza.
  let tMin = 0, tMax = Math.max(CHART.minSpanS, Math.ceil((tLast + 5) / 30) * 30);
  if (tMax > CHART.windowS) { tMax = tLast + 5; tMin = tMax - CHART.windowS; }
  const i0 = firstIndexFrom(samples, tMin);

  // Eje Y: de 0.8 hasta el IF válido más alto visible (mín. 2.2, máx. 4), en pasos de 0.25.
  let maxV = Y_MAX_DEFAULT;
  for (let i = i0; i < samples.length; i++) {
    const p = samples[i]!;
    if (p.valid && p.IF > maxV) maxV = p.IF;
  }
  const yMax = Math.min(Y_MAX_CAP, Math.ceil((maxV + 0.1) * 4) / 4);
  const X = (t: number) => L + (t - tMin) / (tMax - tMin) * pw;
  const Y = (v: number) => Tp + (1 - (v - Y_MIN) / (yMax - Y_MIN)) * ph;

  ctx.clearRect(0, 0, w, h);

  // Bandas de estado
  ctx.fillStyle = c.okT;   ctx.fillRect(L, Y(THRESHOLDS.warn), pw, Y(Y_MIN) - Y(THRESHOLDS.warn));
  ctx.fillStyle = c.warnT; ctx.fillRect(L, Y(THRESHOLDS.risk), pw, Y(THRESHOLDS.warn) - Y(THRESHOLDS.risk));
  ctx.fillStyle = c.riskT; ctx.fillRect(L, Tp, pw, Y(THRESHOLDS.risk) - Tp);

  // Ejes y rejilla
  ctx.font = FONT; ctx.fillStyle = c.muted; ctx.strokeStyle = c.line; ctx.lineWidth = 1;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = 1.0; v <= yMax + 1e-6; v += 0.25) {
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
    ctx.fillText(v.toFixed(2), L - 6, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const span = tMax - tMin, stepX = span > 150 ? 30 : span > 70 ? 20 : 10;
  for (let t = Math.ceil(tMin / stepX) * stepX; t <= tMax; t += stepX) ctx.fillText(fmtT(t), X(t), Tp + ph + 8);
  ctx.save();
  ctx.translate(12, Tp + ph / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('IF', 0, 0);
  ctx.restore();

  // Umbrales
  ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2;
  ctx.strokeStyle = c.warn; ctx.beginPath(); ctx.moveTo(L, Y(THRESHOLDS.warn)); ctx.lineTo(L + pw, Y(THRESHOLDS.warn)); ctx.stroke();
  ctx.strokeStyle = c.risk; ctx.beginPath(); ctx.moveTo(L, Y(THRESHOLDS.risk)); ctx.lineTo(L + pw, Y(THRESHOLDS.risk)); ctx.stroke();
  ctx.setLineDash([]);

  // IF válido (recortado al área de trazo)
  ctx.save();
  ctx.beginPath(); ctx.rect(L, Tp, pw, ph); ctx.clip();
  ctx.strokeStyle = c.signal; ctx.lineWidth = 2.2; ctx.lineJoin = 'round';
  ctx.beginPath();
  let on = false, prevT: number | null = null;
  for (let i = i0; i < samples.length; i++) {
    const p = samples[i]!;
    if (!p.valid) { on = false; continue; }
    if (prevT !== null && p.t - prevT > GAP_S) on = false;   // hueco (desconexión o pausa)
    const x = X(p.t), y = Y(p.IF);
    if (!on) { ctx.moveTo(x, y); on = true; } else ctx.lineTo(x, y);
    prevT = p.t;
  }
  ctx.stroke();
  ctx.restore();

  // Marcadores de cada tarea
  ctx.font = FONT; ctx.textBaseline = 'top';
  for (const tk of s.tasks) {
    const ref = tk.start + TASK.refS;
    if (ref >= tMin && ref <= tLast) {
      ctx.fillStyle = c.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText('A₀', X(ref) + 2, Y(1.0) - 4);
      ctx.textBaseline = 'top';
    }
    if (tk.alarm !== null && tk.alarm >= tMin) {
      ctx.strokeStyle = c.risk; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(X(tk.alarm), Tp); ctx.lineTo(X(tk.alarm), Tp + ph); ctx.stroke();
      ctx.fillStyle = c.risk; ctx.textAlign = 'right'; ctx.fillText('alarma', X(tk.alarm) - 4, Tp + 4);
    }
    if (tk.end !== null && tk.end >= tMin) {
      ctx.strokeStyle = c.ink; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(X(tk.end), Tp); ctx.lineTo(X(tk.end), Tp + ph); ctx.stroke();
      ctx.fillStyle = c.ink; ctx.textAlign = 'left'; ctx.fillText('fin', X(tk.end) + 4, Tp + 4);
    }
  }
}

/** Etiqueta del eje X: "45 s" hasta 2 min, luego "m:ss". */
function fmtT(s: number): string {
  s = Math.max(0, s);
  return s < 120 ? Math.round(s) + ' s' : Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
}
