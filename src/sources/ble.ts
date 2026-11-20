// Fuente BLE: Web Bluetooth contra el parche (servicio UART de Nordic, característica TX con notify).
// Basado en el bloque "Web Bluetooth" de legacy/index.html.
//
// Estados que emite (detail = texto en español listo para mostrarse):
//   start():  searching → connecting → connected            (o idle si cancela el selector, o error)
//   se cae:   reconnecting → connected                      (hasta 3 intentos, cada 1.5 s)
//                          → lost                           (si los 3 fallan)
//   stop():   idle
// 'reconnecting' y 'lost' se emiten una sola vez cada uno (no uno por intento), para que la
// vibración de D3 suene una vez al perder la conexión y otra si ya no se recupera.
//
// Los datos se entregan tal como llegan (una notificación = un fragmento) con
// tAbsS = performance.now() / 1000. Tras cada 'connected' llegan datos de una conexión nueva:
// main.ts debe hacer parser.reset() (D2).

/// <reference types="web-bluetooth" />

import { BLE } from '../config';
import type { SourceState, SourceStatus } from '../types';
import type { DataSource } from './source';

const RETRIES = 3;               // intentos de reconexión automática
const RETRY_DELAY_MS = 1500;     // espera antes de cada intento
const CONNECT_TIMEOUT_MS = 10000;   // si un intento tarda más, se aborta

const TXT = {
  idle: 'Sin conexión',
  searching: 'Buscando el parche…',
  connecting: (name: string) => `Conectando con ${name}…`,
  connected: (name: string) => `Conectado · ${name}`,
  reconnecting: 'Se perdió la conexión con el parche. Intentando reconectar…',
  lost: 'Se perdió la conexión con el parche. Revisa que esté encendido y cerca.',
  unsupported: 'Este navegador no tiene Web Bluetooth. Abre la página en Chrome (Android o Windows).',
} as const;

/** true si el navegador tiene Web Bluetooth (Chrome/Edge en Android, Windows, macOS; no iPhone). */
export function isBleSupported(): boolean {
  return typeof navigator !== 'undefined'
    && 'bluetooth' in navigator
    && !!navigator.bluetooth
    && typeof navigator.bluetooth.requestDevice === 'function';
}

/** Señal interna: la operación quedó obsoleta (stop() o un start()/reconectar más nuevo). */
class Stale extends Error {}

/** Traduce un error de Web Bluetooth a un texto para la interfaz. null = el usuario canceló. */
function describeError(err: unknown): string | null {
  const name = (err as { name?: string } | null)?.name ?? '';
  const msg = String((err as { message?: string } | null)?.message ?? err ?? '');
  if (name === 'NotFoundError' && /cancel/i.test(msg)) return null;
  if (name === 'NotFoundError' && /service|characteristic/i.test(msg))
    return 'El dispositivo no tiene el servicio UART esperado. Revisa los UUID del firmware.';
  if (name === 'NotFoundError')
    return 'Bluetooth no disponible. Enciéndelo e inténtalo de nuevo.';
  if (name === 'SecurityError')
    return 'El navegador bloqueó Bluetooth. Abre la página con HTTPS (o localhost) y usa el botón.';
  if (name === 'NotSupportedError')
    return 'Este navegador no permite usar Bluetooth con este dispositivo.';
  if (name === 'NetworkError' || name === 'AbortError')
    return 'No se pudo conectar. Acerca el parche y revisa que esté encendido.';
  if (name === 'TimeoutError')
    return 'El parche no respondió a tiempo.';
  return 'No se pudo conectar: ' + (msg || 'error desconocido');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type DataFn = (chunk: string, tAbsS: number) => void;
type StatusFn = (s: SourceStatus) => void;

class BleDataSource implements DataSource {
  readonly kind = 'ble' as const;

  private device: BluetoothDevice | null = null;
  private char: BluetoothRemoteGATTCharacteristic | null = null;
  private state: SourceState = 'idle';
  /** Sube con cada start/stop/reconectar: el trabajo asíncrono viejo se reconoce y se descarta. */
  private gen = 0;
  /** Sube con cada intento de conexión: un intento que ya expiró no puede tocar la característica. */
  private attempt = 0;
  /** true solo cuando las notificaciones ya fluyen y se anunció 'connected'. */
  private live = false;
  private decoder = new TextDecoder();
  private readonly dataFns: DataFn[] = [];
  private readonly statusFns: StatusFn[] = [];

  // Manejadores fijos: addEventListener no los duplica aunque se registren dos veces.
  private readonly onNotify = (e: Event): void => {
    if (!this.live) return;
    const value = (e.target as BluetoothRemoteGATTCharacteristic | null)?.value;
    if (!value) return;
    const chunk = this.decoder.decode(value, { stream: true });
    if (!chunk) return;
    const t = performance.now() / 1000;
    for (const fn of this.dataFns) fn(chunk, t);
  };

  private readonly onDisconnected = (): void => {
    this.live = false;
    // Solo se reconecta si estaba conectado. Si el corte viene de stop(), de un intento fallido
    // o de un ciclo de reconexión ya en marcha, el estado no es 'connected' y se ignora.
    if (this.state !== 'connected') return;
    this.detachChar();
    void this.reconnectLoop(++this.gen, RETRY_DELAY_MS);
  };

  onData(fn: DataFn): void { this.dataFns.push(fn); }
  onStatus(fn: StatusFn): void { this.statusFns.push(fn); }

  async start(): Promise<void> {
    if (!isBleSupported()) {
      this.setStatus('error', TXT.unsupported);
      return;
    }
    // Nada de await antes de requestDevice: el navegador exige que venga directo del clic.
    const g = ++this.gen;
    this.dropConnection();
    this.setStatus('searching', TXT.searching);

    let device: BluetoothDevice;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ name: BLE.deviceName }, { services: [BLE.service] }],
        optionalServices: [BLE.service],
      });
    } catch (err) {
      if (g !== this.gen) return;
      const why = describeError(err);
      if (why === null) this.setStatus('idle', TXT.idle);   // cerró el selector
      else { console.error('[ble] requestDevice', err); this.setStatus('error', why); }
      return;
    }
    if (g !== this.gen) return;

    if (this.device && this.device !== device)
      this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.onDisconnected);

    this.setStatus('connecting', TXT.connecting(this.deviceName()));
    try {
      await this.openGatt(g);
    } catch (err) {
      if (g !== this.gen || err instanceof Stale) return;
      console.error('[ble] conexión', err);
      this.dropConnection();
      this.setStatus('error', describeError(err) ?? TXT.idle);
    }
  }

  async stop(): Promise<void> {
    this.gen++;                 // cancela conexiones y reintentos en curso
    this.dropConnection();
    if (this.state !== 'idle') this.setStatus('idle', TXT.idle);
  }

  /** Botón "Reconectar": un ciclo nuevo de 3 intentos, el primero de inmediato. */
  async reconnect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting' || this.state === 'searching') return;
    if (!this.device) return this.start();   // nunca se eligió un parche: abre el selector
    const g = ++this.gen;
    this.dropConnection();
    await this.reconnectLoop(g, 0);
  }

  // -------------------------------------------------------------------------

  private async reconnectLoop(g: number, firstDelayMs: number): Promise<void> {
    this.setStatus('reconnecting', TXT.reconnecting);
    for (let i = 0; i < RETRIES; i++) {
      await sleep(i === 0 ? firstDelayMs : RETRY_DELAY_MS);
      if (g !== this.gen) return;
      try {
        await this.openGatt(g);
        return;                                 // openGatt ya emitió 'connected'
      } catch (err) {
        if (g !== this.gen || err instanceof Stale) return;
        console.warn(`[ble] reintento ${i + 1}/${RETRIES}`, err);
        this.dropConnection();
      }
    }
    if (g === this.gen) this.setStatus('lost', TXT.lost);
  }

  /** Conecta GATT, suscribe a TX y anuncia 'connected'. Lanza Stale si quedó obsoleta. */
  private async openGatt(g: number): Promise<void> {
    const device = this.device;
    const gatt = device?.gatt;
    if (!device || !gatt) throw new Error('No hay dispositivo');

    const a = ++this.attempt;
    const check = () => { if (g !== this.gen || a !== this.attempt) throw new Stale(); };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error('El parche no respondió a tiempo'); e.name = 'TimeoutError';
        this.attempt++;   // el intento colgado ya no puede suscribirse si termina tarde
        try { gatt.disconnect(); } catch { /* nada */ }
        reject(e);
      }, CONNECT_TIMEOUT_MS);
    });

    try {
      await Promise.race([timeout, (async () => {
        const server = await gatt.connect(); check();
        const svc = await server.getPrimaryService(BLE.service); check();
        const ch = await svc.getCharacteristic(BLE.tx); check();
        this.detachChar();
        this.char = ch;
        this.decoder = new TextDecoder();
        ch.addEventListener('characteristicvaluechanged', this.onNotify);
        await ch.startNotifications(); check();
      })()]);
    } finally {
      clearTimeout(timer);
    }

    // Las notificaciones que llegaron antes de este punto se descartaron (live = false):
    // así 'connected' siempre llega antes que el primer dato de la conexión nueva.
    this.live = true;
    this.setStatus('connected', TXT.connected(this.deviceName()));
  }

  private detachChar(): void {
    if (this.char) this.char.removeEventListener('characteristicvaluechanged', this.onNotify);
    this.char = null;
  }

  /** Corta la conexión actual sin emitir estados. */
  private dropConnection(): void {
    this.live = false;
    this.detachChar();
    try { if (this.device?.gatt?.connected) this.device.gatt.disconnect(); } catch { /* nada */ }
  }

  private deviceName(): string {
    return this.device?.name || BLE.deviceName;
  }

  private setStatus(state: SourceState, detail: string): void {
    this.state = state;
    const s: SourceStatus = { state, detail };
    for (const fn of this.statusFns) fn(s);
  }
}

/** Crea la fuente BLE. start() debe llamarse desde un clic (abre el selector del navegador). */
export function createBleSource(): DataSource {
  return new BleDataSource();
}

/**
 * Botón "Reconectar" (banner de conexión perdida): vuelve a intentar con el mismo parche
 * (3 intentos, el primero de inmediato). Si nunca se eligió uno, abre el selector.
 * Debe llamarse desde un clic. No hace nada si ya está conectado o conectando.
 */
export function reconnectBle(src: DataSource): Promise<void> {
  if (!(src instanceof BleDataSource)) return Promise.reject(new TypeError('reconnectBle: la fuente no es BLE'));
  return src.reconnect();
}
