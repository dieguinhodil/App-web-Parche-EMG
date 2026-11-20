// Prueba de la app completa (chat 4): carga src/main.ts tal cual, pero con el parche simulado
// (dev/fake-bluetooth.ts del chat 2) en navigator.bluetooth y un Wake Lock de prueba.
// Abre http://localhost:5173/dev/app.html  ·  con ?real=1 usa el Bluetooth de verdad.
//
// "Prueba automática" recorre D2, D3, D7, D9 y los botones solo con clics en la página
// (caja negra: no toca el código de main.ts) y marca cada comprobación con ✓ o ✗.
// Para Chrome headless: await window.appTest.run() → { ok, passed, failed, lines }.

import { BLE } from '../src/config';
import type { SourceStatus } from '../src/types';
import { createFakeParche, installFakeBluetooth, type ChooserMode } from './fake-bluetooth';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error('Falta #' + id);
  return el as T;
};

const useReal = new URLSearchParams(location.search).get('real') === '1';
const fake = createFakeParche({ seed: 7 });
if (!useReal) installFakeBluetooth(fake);

// ---------------------------------------------------------------------------
// Registro de lo que main.ts le pide al navegador: vibración y Wake Lock
// ---------------------------------------------------------------------------
const vibrations: (number | number[])[] = [];
const realVibrate = typeof navigator.vibrate === 'function' ? navigator.vibrate.bind(navigator) : null;
Object.defineProperty(navigator, 'vibrate', {
  configurable: true,
  value: (p: number | number[]) => {
    vibrations.push(p);
    log(`vibrate(${JSON.stringify(p)})`);
    return realVibrate ? realVibrate(p) : true;
  },
});

let visible = true;
let wakeRequests = 0;
let wakeHeld: FakeSentinel | null = null;

class FakeSentinel extends EventTarget {
  readonly type = 'screen';
  released = false;
  onrelease: ((this: WakeLockSentinel, ev: Event) => unknown) | null = null;
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (wakeHeld === this) wakeHeld = null;
    log('wakeLock: liberado');
    this.dispatchEvent(new Event('release'));
  }
}

if (!useReal) {
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      async request(type: string) {
        await sleep(5);
        if (!visible) throw new DOMException('La página no está visible', 'NotAllowedError');
        wakeRequests++;
        const s = new FakeSentinel();
        wakeHeld = s;
        log(`wakeLock.request('${type}')`);
        return s;
      },
    },
  });
  // Simula ocultar la página: el navegador suelta el Wake Lock solo.
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => !visible });
}

function setVisible(v: boolean): void {
  visible = v;
  if (!v && wakeHeld) void wakeHeld.release();
  log(`página ${v ? 'visible' : 'oculta'}`);
  document.dispatchEvent(new Event('visibilitychange'));
}

// ---------------------------------------------------------------------------
// Bitácora
// ---------------------------------------------------------------------------
const lines: string[] = [];
function log(msg: string, kind: '' | 'ok' | 'bad' = ''): void {
  const t = (performance.now() / 1000).toFixed(2).padStart(7);
  const esc = msg.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  lines.push(kind ? `<span class="${kind}">${t}  ${esc}</span>` : `${t}  ${esc}`);
  if (lines.length > 400) lines.splice(0, lines.length - 400);
  const el = document.getElementById('dLog');
  if (el) { el.innerHTML = lines.join('\n'); el.scrollTop = el.scrollHeight; }
}

// ---------------------------------------------------------------------------
// Cargar la app
// ---------------------------------------------------------------------------
$('dMode').textContent = useReal
  ? 'Bluetooth REAL (sin parche simulado ni Wake Lock de prueba).'
  : 'Parche simulado activo: "Conectar parche" lo encuentra al instante. El Wake Lock y la vibración se registran abajo.';

await import('../src/main');

// Cambios de estado de la app, para la bitácora
let lastSeen = '';
setInterval(() => {
  const s: SourceStatus = window.parche.status();
  const now = `${s.state}${s.source ? ' (' + s.source + ')' : ''} · alarma ${document.body.classList.contains('alarm') ? 'ON' : 'off'} · pausa ${window.parche.paused ? 'sí' : 'no'}`;
  if (now !== lastSeen) { lastSeen = now; log(now); }
}, 30);

// Controles del simulador
$('dDrop').addEventListener('click', () => { fake.drop(); log('simulador: conexión cortada'); });
$<HTMLInputElement>('dReach').addEventListener('change', (e) => { fake.reachable = (e.target as HTMLInputElement).checked; });
$<HTMLInputElement>('dSplit').addEventListener('change', (e) => { fake.splitLines = (e.target as HTMLInputElement).checked; });
$<HTMLSelectElement>('dChooser').addEventListener('change', (e) => { fake.chooser = (e.target as HTMLSelectElement).value as ChooserMode; });
$('dHide').addEventListener('click', () => setVisible(!visible));
for (const id of ['dDrop', 'dReach', 'dSplit', 'dChooser', 'dHide', 'dAuto']) ($(id) as HTMLButtonElement).disabled = useReal;

// ---------------------------------------------------------------------------
// Prueba automática
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

async function waitFor(what: string, cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await sleep(20);
  }
  log(`(se agotó la espera: ${what})`, 'bad');
  return false;
}

const btn = (id: string) => $<HTMLButtonElement>(id);
const text = (id: string): string => ($(id).textContent ?? '').trim();
const state = () => window.parche.status().state;
const samples = () => window.parche.snapshot().samples;
const alarm = () => document.body.classList.contains('alarm');

type Ch = BluetoothRemoteGATTCharacteristic & { value: DataView | undefined };
const enc = new TextEncoder();

/** Toma la característica del parche simulado y detiene su generador: los datos los manda la prueba. */
async function takeControl(): Promise<{ ch: Ch; restore(): Promise<void> }> {
  const device = await fake.bluetooth.requestDevice({ acceptAllDevices: true });
  const svc = await device.gatt!.getPrimaryService(BLE.service);
  const ch = (await svc.getCharacteristic(BLE.tx)) as Ch;
  await ch.stopNotifications();
  const orig = ch.startNotifications.bind(ch);
  ch.startNotifications = async () => ch;   // al reconectar, ble.ts no vuelve a encender el generador
  return { ch, async restore() { ch.startNotifications = orig; if (fake.connected) await orig(); } };
}
function inject(ch: Ch, line: string): void {
  const b = enc.encode(line);
  ch.value = new DataView(b.buffer, b.byteOffset, b.byteLength);
  ch.dispatchEvent(new Event('characteristicvaluechanged'));
}

let passed = 0, failed = 0;
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) passed++; else failed++;
  log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`, ok ? 'ok' : 'bad');
}

async function run(): Promise<{ ok: boolean; passed: number; failed: number; lines: string[] }> {
  passed = failed = 0;
  fake.chooser = 'pick'; fake.reachable = true; fake.splitLines = true;   // líneas partidas: prueba el parser
  log('=== Prueba automática ===');

  // A · Estado inicial
  check('A1 Sin aviso de Web Bluetooth (parche simulado)', $('bnSupport').hidden === true);
  check('A2 Conectar habilitado', !btn('btnConnect').disabled && text('btnConnect') === 'Conectar parche');
  check('A3 Pausa y CSV desactivados sin datos', btn('btnPause').disabled && btn('btnCsv').disabled);

  // B · Demo
  btn('btnDemo').click();
  await frame();
  check('B1 Demo conectado con source = demo (D7)', state() === 'connected' && window.parche.status().source === 'demo');
  check('B2 Punto azul de demo', $('conn').classList.contains('demo'));
  check('B3 Botón "Detener demo" con aria-pressed', text('btnDemo') === 'Detener demo' && btn('btnDemo').getAttribute('aria-pressed') === 'true');
  check('B4 Botón de velocidad visible ×1', !btn('btnSpeed').hidden && text('btnSpeed') === '×1');
  check('B5 Wake Lock pedido con connected (D9)', await waitFor('wake', () => window.parche.wakeLock, 500));
  check('B6 Llegan muestras del demo', await waitFor('muestras', () => samples().length > 0, 800));
  btn('btnSpeed').click();
  await frame();
  const n0 = samples().length;
  await sleep(1000);
  const rate = samples().length - n0;
  check('B7 Velocidad ×5', text('btnSpeed') === '×5' && rate > 35, `${rate} muestras en 1 s`);
  check('B8 Pausa, Nueva sesión y CSV activos', !btn('btnPause').disabled && !btn('btnClear').disabled && !btn('btnCsv').disabled);

  // C · Demo → BLE (D2)
  btn('btnConnect').click();
  await frame();
  check('C1 El demo se detuvo', text('btnDemo') === 'Modo demo' && btn('btnSpeed').hidden === true);
  check('C2 Buscando: botón desactivado mientras el selector está abierto', state() === 'searching' && btn('btnConnect').disabled);
  check('C3 Los datos del demo siguen hasta conectar', samples().length > 0);
  check('C4 BLE conectado', await waitFor('connected', () => state() === 'connected', 3000));
  await waitFor('muestras BLE', () => samples().length > 0 && samples().length < 40, 1500);
  const s0 = samples()[0];
  check('C5 Sesión reiniciada al conectar (D2): empieza en t = 0', !!s0 && s0.t === 0 && samples().length < 40, `${samples().length} muestras`);
  await frame();
  check('C6 Punto verde y texto del parche (D6/D7)', $('conn').classList.contains('on') && text('connTxt') === 'Conectado · ParcheEMG');
  check('C7 Botón "Desconectar"', text('btnConnect') === 'Desconectar' && !btn('btnConnect').disabled);
  check('C8 Wake Lock activo', window.parche.wakeLock);

  // D · Alarma con datos controlados
  const ctl = await takeControl();
  log('inyectando 8 s de referencia A₀ y luego riesgo…');
  for (let i = 0; i < 80; i++) { inject(ctl.ch, '1.00,50,0\n'); await sleep(100); }
  for (let i = 0; i < 3; i++) { inject(ctl.ch, '1.60,55,2\n'); await sleep(100); }
  await frame();
  check('D1 Riesgo → alarma (borde rojo)', alarm());
  check('D2 LED rojo, VIB y OLED invertido', $('led').classList.contains('risk') && $('vib').classList.contains('on') && $('oled').classList.contains('inv'));

  // E · Se cae la conexión y vuelve (D3)
  vibrations.length = 0;
  fake.drop();
  check('E1 reconnecting', await waitFor('reconnecting', () => state() === 'reconnecting', 1000));
  await frame();
  check('E2 Alarma apagada al perder la conexión (D3)', !alarm());
  check('E3 Pulso de 400 ms (D3)', vibrations.includes(400));
  check('E4 Aviso visible, botón "Reconectando…" desactivado', !$('bnLost').hidden && text('btnReconnect') === 'Reconectando…' && btn('btnReconnect').disabled);
  check('E5 Indicadores apagados sin conexión', !$('led').classList.contains('risk') && !$('vib').classList.contains('on'));
  check('E6 Reconecta solo', await waitFor('connected', () => state() === 'connected', 4000));
  await frame();
  check('E7 Aviso oculto y sin alarma antes del primer dato', $('bnLost').hidden && !alarm());
  check('E8 Wake Lock se mantuvo durante la reconexión', window.parche.wakeLock);
  inject(ctl.ch, '1.62,55,2\n');
  await frame();
  check('E9 Primera muestra tras reconectar re-evalúa la alarma (D3)', alarm() && window.parche.snapshot().displayState === 2);

  // F · Pausa
  btn('btnPause').click();
  await frame();
  check('F1 Pausa apaga la alarma', !alarm() && text('btnPause') === '▶ Continuar' && text('oTop') === 'PAUSA');
  const np = samples().length;
  inject(ctl.ch, '1.63,55,2\n');
  await frame();
  check('F2 En pausa no entran datos', samples().length === np);
  btn('btnPause').click();
  inject(ctl.ch, '1.64,55,2\n');
  await frame();
  check('F3 Al continuar vuelve la alarma', alarm() && text('btnPause') === '❚❚ Pausa');

  // G · Parche fuera de alcance → lost
  vibrations.length = 0;
  fake.reachable = false;
  fake.drop();
  check('G1 lost tras 3 intentos', await waitFor('lost', () => state() === 'lost', 9000));
  await frame();
  check('G2 Dos pulsos: al perder y al rendirse (D3)', vibrations.filter((v) => v === 400).length === 2, JSON.stringify(vibrations));
  check('G3 Wake Lock liberado con lost (D9)', await waitFor('wake off', () => !window.parche.wakeLock, 500));
  check('G4 Botón Reconectar habilitado y texto de lost (D6)', !btn('btnReconnect').disabled && text('btnReconnect') === 'Reconectar' && text('bnLostTxt').includes('Revisa'));
  check('G5 Alarma apagada', !alarm());

  // H · Botón Reconectar
  fake.reachable = true;
  btn('btnReconnect').click();
  check('H1 Reconecta con el botón', await waitFor('connected', () => state() === 'connected', 3000));
  check('H2 Wake Lock de nuevo', await waitFor('wake', () => window.parche.wakeLock, 500));

  // I · Página oculta y visible (D9)
  setVisible(false);
  check('I1 Al ocultar, el navegador suelta el Wake Lock', await waitFor('wake off', () => !window.parche.wakeLock, 500));
  setVisible(true);
  check('I2 Al volver, main.ts lo pide otra vez', await waitFor('wake', () => window.parche.wakeLock, 500));

  // J · Desconectar
  for (let i = 0; i < 3; i++) { inject(ctl.ch, '1.00,2,0\n'); await sleep(100); }
  const nj = samples().length;
  btn('btnConnect').click();
  await frame();
  check('J1 Desconectar → idle', state() === 'idle' && text('btnConnect') === 'Conectar parche');
  check('J2 Wake Lock liberado con idle (D9)', await waitFor('wake off', () => !window.parche.wakeLock, 500));
  check('J3 Los datos se conservan', samples().length === nj && nj > 0);
  await ctl.restore();

  // K · BLE → demo (D2)
  btn('btnDemo').click();
  await frame();
  check('K1 Demo nuevo: sesión reiniciada', samples().length < 10, `${samples().length} muestras`);
  check('K2 La velocidad elegida se conserva (×5)', text('btnSpeed') === '×5');
  await waitFor('muestras', () => samples().length > 5, 1000);
  check('K3 Empieza en t = 0', samples()[0]?.t === 0);

  // L · Nueva sesión (dos toques)
  await sleep(1000);
  const nl = samples().length;
  btn('btnClear').click();
  await frame();
  check('L1 Primer toque solo pide confirmación', text('btnClear') === '¿Borrar? Toca otra vez' && samples().length >= nl);
  btn('btnClear').click();
  await frame();
  check('L2 Segundo toque borra', samples().length < Math.min(nl, 11) && text('btnClear') === 'Nueva sesión');

  // M · Detener demo
  await sleep(300);
  btn('btnDemo').click();
  await frame();
  check('M1 Detener demo → idle, sin velocidad', state() === 'idle' && btn('btnSpeed').hidden && text('btnDemo') === 'Modo demo');
  check('M2 Wake Lock liberado', await waitFor('wake off', () => !window.parche.wakeLock, 500));
  const nm = samples().length;
  btn('btnDemo').click();
  await sleep(400);
  check('M3 Reanudar el mismo demo no borra la sesión', samples().length > nm, `${nm} → ${samples().length}`);
  btn('btnDemo').click();

  // N · Selector cancelado: no se pierden los datos (D2 se aplica al conectar)
  fake.chooser = 'cancel';
  const nn = samples().length;
  btn('btnConnect').click();
  check('N1 Selector cancelado → idle', await waitFor('idle', () => state() === 'idle', 1500));
  check('N2 Los datos del demo siguen ahí', samples().length === nn && nn > 0);
  fake.chooser = 'no-adapter';
  vibrations.length = 0;
  btn('btnConnect').click();
  check('N3 Bluetooth apagado → error con texto (D6)', await waitFor('error', () => state() === 'error', 1500) && text('connTxt').startsWith('Bluetooth'));
  check('N4 Pulso con error (D3)', vibrations.includes(400));
  fake.chooser = 'pick';

  // O · Sonido
  btn('btnMute').click();
  check('O1 Silencio', text('btnMute') === '🔕 Silencio' && btn('btnMute').getAttribute('aria-pressed') === 'true');
  btn('btnMute').click();
  check('O2 Sonido', text('btnMute') === '🔔 Sonido' && btn('btnMute').getAttribute('aria-pressed') === 'false');

  fake.splitLines = false;
  log(`=== ${failed ? '✗' : '✓'} ${passed} de ${passed + failed} comprobaciones ===`, failed ? 'bad' : 'ok');
  const plain = lines.map((l) => l.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  return { ok: failed === 0, passed, failed, lines: plain };
}

let running = false;
$('dAuto').addEventListener('click', async () => {
  if (running) return;
  running = true;
  btn('dAuto').disabled = true;
  try { await run(); } catch (e) { log('error en la prueba: ' + String(e), 'bad'); }
  finally { running = false; btn('dAuto').disabled = false; }
});

declare global {
  interface Window { appTest: { run: typeof run; vibrations: typeof vibrations; wakeRequests(): number }; }
}
window.appTest = { run, vibrations, wakeRequests: () => wakeRequests };
log('Listo. Usa los botones de la app o "Prueba automática".');
