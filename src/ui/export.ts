// Exportar la sesión a CSV (chat 3). Mismo formato que exportCsv() del legacy:
//
//   t_s,IF,pct_CVM,estado,IF_valido          ← una fila por muestra (estado = el mostrado, -1..2)
//   ...
//   (línea vacía)
//   tarea,inicio_s,alarma_s,fin_s,anticipacion_s,IF_max   ← una fila por tarea
//
// Los tiempos de alarma y fin se miden desde el inicio de su tarea; los campos sin valor van vacíos.
// toCsv() es una función pura (sirve en Node para los tests); downloadCsv() usa el DOM.

import type { SessionSnapshot } from '../types';

export function toCsv(s: SessionSnapshot): string {
  const rows = ['t_s,IF,pct_CVM,estado,IF_valido'];
  for (const x of s.samples) {
    rows.push([x.t.toFixed(2), x.IF.toFixed(2), Math.round(x.pct), x.st, x.valid ? 1 : 0].join(','));
  }
  rows.push('', 'tarea,inicio_s,alarma_s,fin_s,anticipacion_s,IF_max');
  s.tasks.forEach((tk, i) => rows.push([
    i + 1,
    tk.start.toFixed(1),
    tk.alarm === null ? '' : (tk.alarm - tk.start).toFixed(1),
    tk.end === null ? '' : (tk.end - tk.start).toFixed(1),
    tk.alarm !== null && tk.end !== null ? (tk.end - tk.alarm).toFixed(1) : '',
    tk.maxIF === null ? '' : tk.maxIF.toFixed(2),
  ].join(',')));
  return rows.join('\n');
}

/** Descarga parche-emg_AAAA-MM-DD_HHMM.csv. No hace nada si la sesión no tiene muestras. */
export function downloadCsv(s: SessionSnapshot): void {
  if (!s.samples.length) return;
  const blob = new Blob([toCsv(s)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName(new Date());
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function fileName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `parche-emg_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.csv`;
}
