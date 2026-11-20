// Alertas (chat 3): pitido, vibración del teléfono y borde rojo parpadeante.
// Sale de unlockAudio()/beep()/setAlarm() del legacy.
//
// Uso:
//   const alerts = createAlerts();
//   alerts.unlock();                 // en el primer clic (también se desbloquea solo con el primer toque)
//   alerts.setRisk(ev.to === 2);     // con cada evento 'state' de la sesión
//   alerts.setRisk(false); alerts.pulse(400);   // D3: al perder la conexión
//
// - setRisk(true): pitido doble cada 0.9 s, vibración [250,150,250,150,250] y body.alarm (borde rojo).
// - setRisk es idempotente: llamarlo dos veces con el mismo valor no reinicia el pitido ni la vibración.
// - setMuted(true) solo calla el pitido; la vibración y el borde siguen.
// - Ningún error (sin audio, sin vibración) se propaga: el monitor sigue funcionando.

export interface Alerts {
  unlock(): void;
  setRisk(on: boolean): void;
  setMuted(m: boolean): void;
  pulse(ms: number): void;
}

const BEEP_EVERY_MS = 900;
const RISK_VIBRATION = [250, 150, 250, 150, 250];

type AudioCtor = typeof AudioContext;

export function createAlerts(): Alerts {
  let audio: AudioContext | null = null;
  let muted = false;
  let risk = false;
  let beepTimer: ReturnType<typeof setInterval> | null = null;

  function unlock(): void {
    try {
      if (!audio) {
        const Ctor: AudioCtor | undefined =
          window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
        if (!Ctor) return;
        audio = new Ctor();
      }
      if (audio.state === 'suspended') void audio.resume().catch(() => {});
    } catch { /* sin audio: solo vibración y borde */ }
  }

  // Red de seguridad: el navegador solo deja sonar audio después de un gesto del usuario.
  // Si main.ts olvida llamar unlock(), el primer toque o tecla lo hace.
  const onGesture = () => {
    unlock();
    if (audio && audio.state === 'running') {
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
    }
  };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);

  function beep(): void {
    if (muted || !audio) return;
    try {
      if (audio.state === 'suspended') void audio.resume().catch(() => {});
      const now = audio.currentTime;
      for (const d of [0, 0.18]) {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'square'; o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, now + d);
        g.gain.exponentialRampToValueAtTime(0.25, now + d + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, now + d + 0.12);
        o.connect(g).connect(audio.destination);
        o.start(now + d); o.stop(now + d + 0.13);
      }
    } catch { /* ignorar */ }
  }

  function vibrate(p: number | number[]): void {
    try { if (typeof navigator.vibrate === 'function') navigator.vibrate(p); } catch { /* ignorar */ }
  }

  function setRisk(on: boolean): void {
    on = !!on;
    if (on === risk) return;
    risk = on;
    document.body.classList.toggle('alarm', on);
    if (beepTimer !== null) { clearInterval(beepTimer); beepTimer = null; }
    if (on) {
      beep();
      beepTimer = setInterval(beep, BEEP_EVERY_MS);
      vibrate(RISK_VIBRATION);
    } else {
      vibrate(0);   // corta lo que quede del patrón de riesgo
    }
  }

  function setMuted(m: boolean): void {
    muted = !!m;
  }

  function pulse(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) vibrate(Math.round(ms));
  }

  return { unlock, setRisk, setMuted, pulse };
}
