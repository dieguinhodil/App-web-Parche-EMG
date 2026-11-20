// Parche simulado: imita navigator.bluetooth con un "ParcheEMG" que manda las líneas del
// generador demo por notificaciones, para probar ble.ts sin hardware (página dev y tests).
// Se comporta como Chrome en lo que importa a ble.ts: errores con los mismos nombres,
// el mismo objeto característica en cada reconexión y 'gattserverdisconnected' al cortarse.
// Solo para desarrollo: no se publica.

import { BLE } from '../src/config';
import { createDemoGenerator } from '../src/sources/demo';

export type ChooserMode = 'pick' | 'cancel' | 'no-adapter';

export interface FakeParche {
  /** Va en lugar de navigator.bluetooth. */
  readonly bluetooth: Bluetooth;
  /** Qué hace el selector del navegador: elegir el parche, cancelar o "Bluetooth apagado". */
  chooser: ChooserMode;
  /** Si es false, connect() falla con NetworkError (parche apagado o lejos). */
  reachable: boolean;
  /** Parte cada línea en dos notificaciones (prueba que el parser junta fragmentos). */
  splitLines: boolean;
  /** Corta la conexión desde el lado del parche (como alejarse o quitar la batería). */
  drop(): void;
  /** Intentos de connect() hechos hasta ahora. */
  readonly connectAttempts: number;
  /** true si hay conexión GATT abierta. */
  readonly connected: boolean;
}

function domError(name: string, message: string): Error {
  if (typeof DOMException !== 'undefined') return new DOMException(message, name);
  const e = new Error(message); e.name = name; return e;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createFakeParche(opts: { seed?: number; connectDelayMs?: number } = {}): FakeParche {
  const gen = createDemoGenerator(opts.seed ?? 7);
  const connectDelayMs = opts.connectDelayMs ?? 300;
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  let attempts = 0;

  const char = new EventTarget() as EventTarget & {
    value: DataView | undefined;
    startNotifications(): Promise<unknown>;
    stopNotifications(): Promise<unknown>;
  };
  char.value = undefined;

  const notify = (text: string) => {
    const bytes = enc.encode(text);
    char.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    char.dispatchEvent(new Event('characteristicvaluechanged'));
  };
  const stopTimer = () => { if (timer !== null) { clearInterval(timer); timer = null; } };

  char.startNotifications = async () => {
    if (!gatt.connected) throw domError('NetworkError', 'GATT Server is disconnected.');
    stopTimer();
    timer = setInterval(() => {
      if (!gatt.connected) return;
      const line = gen.next();
      if (fake.splitLines) {
        const k = Math.max(1, Math.floor(line.length / 2));
        notify(line.slice(0, k)); notify(line.slice(k));
      } else notify(line);
    }, 100);
    return char;
  };
  char.stopNotifications = async () => { stopTimer(); return char; };

  const service = {
    uuid: BLE.service,
    async getCharacteristic(uuid: string) {
      if (uuid.toLowerCase() !== BLE.tx) throw domError('NotFoundError', 'No Characteristics matching UUID found in Service.');
      return char;
    },
  };

  const device = new EventTarget() as EventTarget & { id: string; name: string; gatt: typeof gatt };

  // Corte de la conexión (lo usan disconnect() y drop()): el evento llega en otra tarea, como en Chrome.
  const sever = () => {
    if (!gatt.connected) return;
    gatt.connected = false;
    stopTimer();
    setTimeout(() => device.dispatchEvent(new Event('gattserverdisconnected')), 0);
  };

  const gatt = {
    device: null as unknown,
    connected: false,
    async connect() {
      attempts++;
      await wait(connectDelayMs);
      if (!fake.reachable) throw domError('NetworkError', 'Connection attempt failed.');
      gatt.connected = true;
      return gatt;
    },
    disconnect() { sever(); },
    async getPrimaryService(uuid: string) {
      if (!gatt.connected) throw domError('NetworkError', 'GATT Server is disconnected.');
      if (uuid.toLowerCase() !== BLE.service) throw domError('NotFoundError', 'No Services matching UUID found in Device.');
      return service;
    },
  };
  device.id = 'fake-parche';
  device.name = BLE.deviceName;
  device.gatt = gatt;
  gatt.device = device;

  const bluetooth = {
    async requestDevice() {
      await wait(200);   // el usuario tarda un poco en elegir
      if (fake.chooser === 'cancel') throw domError('NotFoundError', 'User cancelled the requestDevice() chooser.');
      if (fake.chooser === 'no-adapter') throw domError('NotFoundError', 'Bluetooth adapter not available.');
      return device;
    },
    async getAvailability() { return fake.chooser !== 'no-adapter'; },
  };

  const fake: FakeParche = {
    bluetooth: bluetooth as unknown as Bluetooth,
    chooser: 'pick',
    reachable: true,
    splitLines: false,
    drop: sever,
    get connectAttempts() { return attempts; },
    get connected() { return gatt.connected; },
  };
  return fake;
}

/** Pone el parche simulado en navigator.bluetooth (navegador). Devuelve la función para quitarlo. */
export function installFakeBluetooth(fake: FakeParche): () => void {
  Object.defineProperty(navigator, 'bluetooth', { value: fake.bluetooth, configurable: true, writable: true });
  return () => { delete (navigator as unknown as Record<string, unknown>)['bluetooth']; };
}
