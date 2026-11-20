// Tests del chat 3 que corren en Node (sin DOM): ids del markup y formato del CSV.
// La parte visual (chart, panel, alerts) se prueba en dev/ui.html.

import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';
import devHtml from '../dev/ui.html?raw';
import { LineParser } from '../src/core/protocol';
import { Session } from '../src/core/session';
import { toCsv } from '../src/ui/export';
import type { SessionSnapshot } from '../src/types';

/** IDs del contrato (claude/app-arquitectura.md): los usan main.ts y panel.ts. */
const CONTRACT_IDS = [
  'btnConnect', 'btnDemo', 'btnSpeed', 'conn', 'connTxt', 'bnSupport', 'bnLost', 'bnLostTxt', 'btnReconnect',
  'chart', 'empty', 'btnPause', 'btnClear', 'btnCsv', 'btnMute', 'oled', 'oTop', 'oIF', 'oPct', 'oBar',
  'oState', 'led', 'vib', 'rA', 'rF', 'rL', 'rM',
];

const idsOf = (html: string) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);

describe('markup', () => {
  for (const [name, html] of [['index.html', indexHtml], ['dev/ui.html', devHtml]] as const) {
    it(`${name} tiene cada id del contrato exactamente una vez`, () => {
      const ids = idsOf(html);
      for (const id of CONTRACT_IDS) expect(ids.filter((x) => x === id), `#${id}`).toHaveLength(1);
    });
    it(`${name} no repite ningún id`, () => {
      const ids = idsOf(html);
      expect(ids.length).toBe(new Set(ids).size);
    });
  }

  it('index.html carga los estilos y main.ts', () => {
    expect(indexHtml).toContain('href="./src/ui/styles.css"');
    expect(indexHtml).toContain('src="./src/main.ts"');
  });

  it('dev/ui.html tiene el mismo markup de la app que index.html', () => {
    const app = (html: string) => {
      const a = html.indexOf('<div class="bar">');
      const b = html.indexOf('</footer>');
      return html.slice(a, b);
    };
    expect(app(devHtml)).toBe(app(indexHtml));
  });
});

// ---------------------------------------------------------------------------

function run(lines: string[]): SessionSnapshot {
  const parser = new LineParser();
  const session = new Session();
  lines.forEach((l, i) => { for (const r of parser.push(l)) session.add(r, i / 10); });
  return session.snapshot();
}
const rep = (n: number, line: string) => Array.from({ length: n }, () => line + '\n');

describe('toCsv', () => {
  it('sesión vacía: solo los encabezados', () => {
    expect(toCsv(run([]))).toBe('t_s,IF,pct_CVM,estado,IF_valido\n\ntarea,inicio_s,alarma_s,fin_s,anticipacion_s,IF_max');
  });

  it('una fila por muestra, con el estado mostrado y si el IF es válido', () => {
    const snap = run([...rep(2, '1.00,2,0'), ...rep(71, '1.33,40,1')]);
    const rows = toCsv(snap).split('\n');
    expect(rows[1]).toBe('0.00,1.00,2,-1,0');
    expect(rows[3]).toBe('0.20,1.33,40,-1,0');          // inicio de la tarea (t = 0.2): aún calculando A₀
    expect(rows[73]).toBe('7.20,1.33,40,1,1');          // t − inicio = 7 s → IF válido
    expect(rows[74]).toBe('');
    expect(rows[76]).toBe('1,0.2,,,,1.33');             // tarea en curso: sin alarma ni fin
  });

  it('tarea cerrada con alarma: tiempos desde el inicio y anticipación', () => {
    // inicio en 1.0 s; IF válido desde 8.0 s; riesgo desde 12.0 s; baja de 5 % en 20.0 s → fin = 19.0 s
    const lines = [
      ...rep(10, '1.00,2,0'),
      ...rep(70, '1.00,40,0'),
      ...rep(40, '1.40,40,1'),
      ...rep(80, '1.62,40,2'),
      ...rep(10, '1.00,2,0'),
    ];
    const rows = toCsv(run(lines)).split('\n');
    expect(rows.at(-1)).toBe('1,1.0,11.0,18.0,7.0,1.62');
  });

  it('D1: el empujón de 4 s de la calibración de CVM no aparece en las tareas', () => {
    const lines = [...rep(10, '1.00,2,0'), ...rep(40, '1.00,85,0'), ...rep(20, '1.00,2,0')];
    const csv = toCsv(run(lines));
    expect(csv.endsWith('tarea,inicio_s,alarma_s,fin_s,anticipacion_s,IF_max')).toBe(true);
    expect(csv.split('\n').filter((r) => r.endsWith(',1'))).toHaveLength(0);   // ninguna muestra válida
  });
});
