// Interfaz común de las fuentes de datos. El chat 1 la declara; ble.ts y demo.ts (chat 2) la implementan.
// Contrato fijo: no cambiar sin pasar por el chat coordinador (ver claude/app-arquitectura.md).

import type { SourceStatus } from '../types';

export type { SourceState, SourceStatus } from '../types';

export interface DataSource {
  readonly kind: 'ble' | 'demo';
  /** ble: abre el selector de dispositivo (requiere clic del usuario). */
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Texto crudo tal como llega (puede traer líneas incompletas o varias juntas)
   * y su tiempo absoluto en s: performance.now()/1000 en BLE, virtual en demo.
   * El texto se pasa a LineParser.push(); cada Reading resultante, a Session.add(r, tAbsS).
   */
  onData(fn: (chunk: string, tAbsS: number) => void): void;
  onStatus(fn: (s: SourceStatus) => void): void;
}
