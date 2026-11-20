// Constantes compartidas de la app del Parche EMG.
// Contrato fijo: no cambiar sin pasar por el chat coordinador (ver claude/app-arquitectura.md).

/** Contrato BLE: servicio UART de Nordic (NUS) que anuncia el ESP32-C3. */
export const BLE = {
  deviceName: 'ParcheEMG',
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  tx: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
} as const;

/** Umbrales del IF. Solo para dibujar: el estado (0/1/2) lo decide el parche. */
export const THRESHOLDS = { warn: 1.25, risk: 1.50 } as const;

/** Detección de tareas (misma regla que el firmware). */
export const TASK = {
  onsetPct: 10,        // %CVM: empieza una tarea
  offsetPct: 5,        // %CVM: termina una tarea
  endConfirmS: 0.5,    // s debajo de offsetPct para confirmar el fin
  endBacktrackS: 1.0,  // el parche promedia 1 s: el fin real fue ~1 s antes
  refS: 7,             // s tras el inicio en que el parche calcula A0 (IF no válido)
} as const;

/** Gráfica: tramo mínimo visible y ventana máxima, en s. */
export const CHART = { minSpanS: 60, windowS: 180 } as const;

/** Muestras máximas en memoria: ~1 h a 10 Hz. */
export const MAX_SAMPLES = 36000;
