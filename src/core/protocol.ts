// Parser del protocolo del parche: líneas de texto "IF,%CVM,estado\n" a 10 Hz.
// Ejemplo: "1.32,45,1"  →  { IF: 1.32, pct: 45, estado: 1 }

import type { Estado, Reading } from '../types';

/** Si el buffer pasa de este largo sin '\n', es basura y se descarta. */
const MAX_PENDING = 64;

/** Número decimal simple: "1", "1.32", "-0.05", ".5", "45." (sin exponentes, sin espacios internos). */
const NUM_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const ESTADO_RE = /^[012]$/;

/**
 * Parsea una línea completa (sin el '\n').
 * Devuelve null si la línea está vacía o no cumple el formato "IF,%CVM,estado".
 * Tolera espacios y '\r' alrededor de cada campo.
 */
export function parseLine(line: string): Reading | null {
  const parts = line.trim().split(',');
  if (parts.length !== 3) return null;

  const [ifTxt, pctTxt, stTxt] = parts.map((p) => p.trim()) as [string, string, string];
  if (!NUM_RE.test(ifTxt) || !NUM_RE.test(pctTxt) || !ESTADO_RE.test(stTxt)) return null;

  const IF = Number(ifTxt);
  const pct = Number(pctTxt);
  if (!Number.isFinite(IF) || !Number.isFinite(pct)) return null;

  return { IF, pct, estado: Number(stTxt) as Estado };
}

/**
 * Acumula fragmentos de texto (las notificaciones BLE pueden cortar o juntar líneas)
 * y devuelve las lecturas de las líneas completas.
 */
export class LineParser {
  private buf = '';
  /** true tras descartar basura: se ignora todo hasta el siguiente '\n' (la cola de esa línea rota). */
  private skipping = false;

  push(chunk: string): Reading[] {
    const out: Reading[] = [];
    if (!chunk) return out;
    this.buf += chunk;

    let k: number;
    while ((k = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, k);
      this.buf = this.buf.slice(k + 1);
      if (this.skipping) { this.skipping = false; continue; }
      const r = parseLine(line);
      if (r) out.push(r);
    }

    if (this.buf.length > MAX_PENDING) {
      this.buf = '';
      this.skipping = true;
    }
    return out;
  }

  /** Descarta lo pendiente (llamar al reconectar o al cambiar de fuente). */
  reset(): void {
    this.buf = '';
    this.skipping = false;
  }
}
