import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBleSource, isBleSupported, reconnectBle } from '../src/sources/ble';
import { createDemoSource } from '../src/sources/demo';
import { LineParser } from '../src/core/protocol';
import { createFakeParche, type FakeParche } from '../dev/fake-bluetooth';
import type { SourceState, SourceStatus } from '../src/types';
import type { DataSource } from '../src/sources/source';

let fake: FakeParche;

function setup() {
  const src = createBleSource();
  const status: SourceStatus[] = [];
  const chunks: Array<[string, number]> = [];
  src.onStatus((s) => status.push(s));
  src.onData((c, t) => chunks.push([c, t]));
  const states = () => status.map((s) => s.state);
  return { src, status, chunks, states };
}

beforeEach(() => {
  vi.useFakeTimers();
  fake = createFakeParche({ seed: 11, connectDelayMs: 300 });
  vi.stubGlobal('navigator', { bluetooth: fake.bluetooth });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function startAndConnect(src: DataSource) {
  const p = src.start();
  await vi.advanceTimersByTimeAsync(1000);
  await p;
}

describe('isBleSupported', () => {
  it('false sin navigator.bluetooth, true con él', () => {
    expect(isBleSupported()).toBe(true);
    vi.stubGlobal('navigator', {});
    expect(isBleSupported()).toBe(false);
  });
});

describe('createBleSource', () => {
  it('start: searching → connecting → connected y luego llegan datos', async () => {
    const { src, status, chunks, states } = setup();
    expect(src.kind).toBe('ble');
    await startAndConnect(src);
    expect(states()).toEqual(['searching', 'connecting', 'connected']);
    expect(status[2]!.detail).toBe('Conectado · ParcheEMG');
    const before = chunks.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(chunks.length - before).toBeGreaterThanOrEqual(9);
    expect(chunks.length - before).toBeLessThanOrEqual(11);
    const parser = new LineParser();
    const readings = chunks.flatMap(([c]) => parser.push(c));
    expect(readings).toHaveLength(chunks.length);
    for (const [, t] of chunks) expect(typeof t).toBe('number');
    await src.stop();
  });

  it('sin Web Bluetooth: error con un mensaje para el usuario', async () => {
    vi.stubGlobal('navigator', {});
    const { src, status } = setup();
    await src.start();
    expect(status).toHaveLength(1);
    expect(status[0]!.state).toBe('error');
    expect(status[0]!.detail).toMatch(/Chrome/);
  });

  it('si el usuario cierra el selector vuelve a idle (no es error)', async () => {
    fake.chooser = 'cancel';
    const { src, states } = setup();
    await startAndConnect(src);
    expect(states()).toEqual(['searching', 'idle']);
  });

  it('Bluetooth apagado: error', async () => {
    fake.chooser = 'no-adapter';
    const { src, status, states } = setup();
    await startAndConnect(src);
    expect(states()).toEqual(['searching', 'error']);
    expect(status[1]!.detail).toMatch(/Bluetooth no disponible/);
  });

  it('parche apagado al conectar: error y la conexión no queda abierta', async () => {
    fake.reachable = false;
    const { src, states } = setup();
    await startAndConnect(src);
    expect(states()).toEqual(['searching', 'connecting', 'error']);
    expect(fake.connected).toBe(false);
  });

  it('fragmentos partidos: el parser los junta', async () => {
    fake.splitLines = true;
    const { src, chunks } = setup();
    await startAndConnect(src);
    await vi.advanceTimersByTimeAsync(2000);
    const parser = new LineParser();
    const readings = chunks.flatMap(([c]) => parser.push(c));
    expect(chunks.length).toBeGreaterThan(30);
    expect(readings.length).toBeGreaterThanOrEqual(Math.floor(chunks.length / 2) - 1);
    await src.stop();
  });

  it('se cae y vuelve: un solo reconnecting y de nuevo connected; los datos no se duplican', async () => {
    const { src, chunks, states } = setup();
    await startAndConnect(src);
    fake.drop();
    await vi.advanceTimersByTimeAsync(100);
    expect(states().at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(2000);   // 1.5 s de espera + 0.3 s del connect
    expect(states()).toEqual(['searching', 'connecting', 'connected', 'reconnecting', 'connected']);
    const before = chunks.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(chunks.length - before).toBeGreaterThanOrEqual(9);
    expect(chunks.length - before).toBeLessThanOrEqual(11);   // sin oyentes duplicados
    await src.stop();
  });

  it('no vuelve: 3 intentos cada 1.5 s y luego lost (una sola vez)', async () => {
    const { src, states } = setup();
    await startAndConnect(src);
    const before = fake.connectAttempts;
    fake.reachable = false;
    fake.drop();
    await vi.advanceTimersByTimeAsync(4000);
    expect(states().at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.connectAttempts - before).toBe(3);
    expect(states()).toEqual(['searching', 'connecting', 'connected', 'reconnecting', 'lost']);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fake.connectAttempts - before).toBe(3);
  });

  it('reconnectBle tras lost: reintenta de inmediato con el mismo parche', async () => {
    const { src, states } = setup();
    await startAndConnect(src);
    fake.reachable = false;
    fake.drop();
    await vi.advanceTimersByTimeAsync(6000);
    expect(states().at(-1)).toBe('lost');
    fake.reachable = true;
    const p = reconnectBle(src);
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(states().slice(-2)).toEqual(['reconnecting', 'connected']);
    expect(states().filter((s) => s === 'searching')).toHaveLength(1);   // no abrió el selector
    await src.stop();
  });

  it('stop durante la reconexión: idle y no emite nada más', async () => {
    const { src, states } = setup();
    await startAndConnect(src);
    fake.drop();
    await vi.advanceTimersByTimeAsync(100);
    await src.stop();
    const n = states().length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(states().at(-1)).toBe('idle');
    expect(states()).toHaveLength(n);
    expect(fake.connected).toBe(false);
  });

  it('stop desconecta sin intentar reconectar', async () => {
    const { src, chunks, states } = setup();
    await startAndConnect(src);
    await src.stop();
    const n = chunks.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(states()).toEqual(['searching', 'connecting', 'connected', 'idle']);
    expect(chunks.length).toBe(n);
    expect(fake.connected).toBe(false);
  });

  it('un intento que se cuelga se aborta a los 10 s', async () => {
    const { src, states } = setup();
    fake.bluetooth.requestDevice = (async () => {
      const dev = new EventTarget() as unknown as BluetoothDevice;
      (dev as unknown as { name: string }).name = 'ParcheEMG';
      (dev as unknown as { gatt: unknown }).gatt = { connected: false, connect: () => new Promise(() => {}), disconnect() {} };
      return dev;
    }) as Bluetooth['requestDevice'];
    const p = src.start();
    await vi.advanceTimersByTimeAsync(9000);
    expect(states().at(-1)).toBe('connecting');
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(states().at(-1)).toBe('error');
  });

  it('reconnectBle rechaza una fuente que no es BLE', async () => {
    await expect(reconnectBle(createDemoSource())).rejects.toThrow(TypeError);
  });

  it('cada estado trae un texto en español', async () => {
    const { src, status } = setup();
    await startAndConnect(src);
    fake.reachable = false;
    fake.drop();
    await vi.advanceTimersByTimeAsync(6000);
    await src.stop();
    const seen = new Set<SourceState>(status.map((s) => s.state));
    expect([...seen].sort()).toEqual(['connected', 'connecting', 'idle', 'lost', 'reconnecting', 'searching']);
    for (const s of status) expect(s.detail && s.detail.length).toBeTruthy();
  });
});
