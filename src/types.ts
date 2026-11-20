// Tipos compartidos entre módulos.
// Contrato fijo: no cambiar sin pasar por el chat coordinador (ver claude/app-arquitectura.md).

export type Estado = 0 | 1 | 2;              // 0 normal · 1 precaución · 2 riesgo
export type DisplayState = Estado | -1;      // -1 = sin estado válido (fuera de tarea o calculando A0)

export interface Reading { IF: number; pct: number; estado: Estado; }   // una línea parseada

export interface SessionSample extends Reading {
  t: number;              // s desde el inicio de la sesión
  valid: boolean;         // true si el IF cuenta (dentro de una tarea y después de refS)
  st: DisplayState;
}

export interface Task {
  start: number;          // s de sesión
  end: number | null;     // null = en curso
  alarm: number | null;   // primer instante con estado 2 (válido)
  maxIF: number | null;
}

export type Phase = 'sin-datos' | 'listo' | 'referencia' | 'tarea';

export interface SessionSnapshot {
  samples: readonly SessionSample[];
  tasks: readonly Task[];
  current: Task | null;
  last: SessionSample | null;
  phase: Phase;
  displayState: DisplayState;
}

export type SessionEvent =
  | { type: 'sample' }
  | { type: 'state'; from: DisplayState; to: DisplayState }
  | { type: 'task-start'; task: Task }
  | { type: 'task-end'; task: Task }
  | { type: 'task-discard'; task: Task }   // D1: tarea < refS, se quitó de tasks
  | { type: 'reset' };

export type SourceState = 'idle' | 'searching' | 'connecting' | 'connected' | 'reconnecting' | 'lost' | 'error';
export interface SourceStatus {
  state: SourceState;
  detail?: string;              // D6: texto en español para mostrar
  source?: 'ble' | 'demo';      // D7: lo llena main.ts con src.kind (lo agrega el chat 3)
}
