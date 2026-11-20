// Panel (chat 3): pantalla OLED, LED, VIB, lecturas de la última tarea, estado de conexión,
// aviso de conexión perdida y el letrero "Esperando datos…". Sale de panel() y setConn() del legacy.
//
// Uso: const panel = createPanel(); panel.render(session.snapshot(), status, paused);
// - Toma los elementos por id de index.html (falla al crearse si falta alguno).
// - No guarda el snapshot ni el status: dibuja con lo que recibe en cada llamada.
// - Los botones (texto, disabled, aria-pressed) y el aviso #bnSupport los maneja main.ts.
//
// Decisiones aplicadas:
// - D6: status.detail se muestra tal cual en #connTxt y, con 'reconnecting'/'lost', en #bnLostTxt.
// - D7: el punto azul de demo (.conn.demo) sale de status.source === 'demo' (lo llena main.ts).

import type { DisplayState, SessionSnapshot, SourceState, SourceStatus } from '../types';

export interface Panel {
  render(s: SessionSnapshot, status: SourceStatus, paused: boolean): void;
}

/** Texto de respaldo si una fuente no manda detail (las del chat 2 siempre lo mandan). */
const FALLBACK: Record<SourceState, string> = {
  idle: 'Sin conexión',
  searching: 'Buscando el parche…',
  connecting: 'Conectando…',
  connected: 'Conectado',
  reconnecting: 'Se perdió la conexión con el parche. Intentando reconectar…',
  lost: 'Se perdió la conexión con el parche. Revisa que esté encendido y cerca.',
  error: 'Error de conexión',
};

/** Textos del OLED (sin acentos, como la pantalla del parche). */
const STATE_NAMES = ['NORMAL', 'PRECAUCION', 'RIESGO DE LESION'] as const;
const LED_CLASS = ['ok', 'warn', 'risk'] as const;

const IDS = ['conn', 'connTxt', 'bnLost', 'bnLostTxt', 'empty',
  'oled', 'oTop', 'oIF', 'oPct', 'oBar', 'oState', 'led', 'vib', 'rA', 'rF', 'rL', 'rM'] as const;
type Id = typeof IDS[number];

export function createPanel(): Panel {
  const missing = IDS.filter((id) => !document.getElementById(id));
  if (missing.length) throw new Error('panel: faltan elementos en index.html: #' + missing.join(', #'));
  const el = Object.fromEntries(IDS.map((id) => [id, document.getElementById(id)!])) as Record<Id, HTMLElement>;

  // Solo se toca el DOM si el valor cambió (render() puede llamarse 10–60 veces por segundo).
  const prev = new Map<string, string | boolean>();
  const text = (id: Id, v: string) => { if (prev.get(id) !== v) { prev.set(id, v); el[id].textContent = v; } };
  const cls = (id: Id, v: string) => { const k = id + '.class'; if (prev.get(k) !== v) { prev.set(k, v); el[id].className = v; } };
  const toggle = (id: Id, c: string, on: boolean) => { const k = id + '.' + c; if (prev.get(k) !== on) { prev.set(k, on); el[id].classList.toggle(c, on); } };
  const hide = (id: Id, h: boolean) => { const k = id + '.hidden'; if (prev.get(k) !== h) { prev.set(k, h); el[id].hidden = h; } };
  const width = (id: Id, v: string) => { const k = id + '.width'; if (prev.get(k) !== v) { prev.set(k, v); el[id].style.width = v; } };

  function render(s: SessionSnapshot, status: SourceStatus, paused: boolean): void {
    const st = status.state;
    const live = st === 'connected';
    const detail = status.detail ?? FALLBACK[st] ?? '';

    // --- Conexión (D6, D7) ---
    let connCls = 'conn';
    if (live) connCls += status.source === 'demo' ? ' demo' : ' on';
    else if (st === 'reconnecting' || st === 'lost' || st === 'error') connCls += ' lost';
    cls('conn', connCls);
    text('connTxt', detail);
    const showLost = st === 'reconnecting' || st === 'lost';
    hide('bnLost', !showLost);
    if (showLost) text('bnLostTxt', detail);

    // --- Letrero sobre la gráfica vacía ---
    hide('empty', s.samples.length > 0);

    // --- OLED ---
    const last = s.last;
    let top: string, ifTxt = 'IF --', stTxt = '—';
    if (!last) {
      top = live ? 'ESPERANDO DATOS' : 'SIN CONEXION';
    } else if (s.phase === 'tarea' && s.current) {
      top = 'TAREA · t ' + mmss(last.t - s.current.start);
      ifTxt = 'IF ' + last.IF.toFixed(2);
      stTxt = last.st >= 0 ? STATE_NAMES[last.st as 0 | 1 | 2] : '—';
    } else if (s.phase === 'referencia' && s.current) {
      top = 'REF A0... · t ' + mmss(last.t - s.current.start);
      stTxt = 'calibrando referencia';
    } else {
      top = 'LISTO';
      stTxt = 'sosten la carga';
    }
    if (paused) top = 'PAUSA';
    else if (last && !live) top = 'PAUSA · ' + top;   // datos congelados: no llega nada de la fuente
    text('oTop', top);
    text('oIF', ifTxt);
    const pct = last ? last.pct : null;
    text('oPct', (pct === null ? '--' : Math.round(pct)) + '% CVM');
    width('oBar', (pct === null ? 0 : Math.min(100, Math.max(0, pct))) + '%');
    text('oState', stTxt);

    // --- Indicadores: solo con datos en vivo (si no, la alarma está apagada: D3 y pausa) ---
    const shown: DisplayState = live && !paused ? s.displayState : -1;
    toggle('oled', 'inv', shown === 2);
    cls('led', 'ledd' + (shown >= 0 ? ' ' + LED_CLASS[shown as 0 | 1 | 2] : ''));
    toggle('vib', 'on', shown === 2);

    // --- Lecturas de la tarea más reciente (D1: las descartadas ya no están en tasks) ---
    const tk = s.tasks.length ? s.tasks[s.tasks.length - 1]! : null;
    if (!tk) {
      text('rA', '—'); text('rF', '—'); text('rL', '—'); text('rM', '—');
    } else {
      text('rA', tk.alarm === null ? (tk.end === null ? 'aún no' : 'no se activó') : (tk.alarm - tk.start).toFixed(1) + ' s');
      text('rF', tk.end === null ? 'en curso' : (tk.end - tk.start).toFixed(1) + ' s');
      text('rL', tk.alarm !== null && tk.end !== null ? (tk.end - tk.alarm).toFixed(1) + ' s antes del fin' : '—');
      text('rM', tk.maxIF === null ? '—' : tk.maxIF.toFixed(2));
    }
  }

  return { render };
}

/** mm:ss para el reloj de la tarea en el OLED. */
function mmss(s: number): string {
  s = Math.max(0, Math.floor(s + 1e-6));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
