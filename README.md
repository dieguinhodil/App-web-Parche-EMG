# Parche EMG · Monitor web

Página web que se conecta al **Parche EMG** por Bluetooth (Web Bluetooth) y muestra en vivo el índice de fatiga (IF), el estado (normal / precaución / riesgo) y una alarma con pitido, vibración y borde rojo. Tiene **modo demo** con datos sintéticos para desarrollar y presentar sin el parche.

Proyecto de Electrofisiología Molecular 2. Hecho con TypeScript + Vite, sin frameworks.

- **Versión modular** (esta): `index.html` + `src/`.
- **Versión de un archivo** (plan B): `legacy/index.html`. Funciona sola, sin build.

## Abrir la app publicada

- `https://<usuario>.github.io/<repo>/` → versión modular
- `https://<usuario>.github.io/<repo>/legacy/` → versión de un archivo

Funciona en **Chrome de Android y de Windows** (y en Chrome/Edge de macOS). **No funciona con el parche en iPhone** (ningún navegador de iOS tiene Web Bluetooth); ahí solo sirve el modo demo.

En Android, la primera vez Chrome pide el permiso de **Dispositivos cercanos** (en Android 11 o anterior, **Ubicación**). El Bluetooth del teléfono debe estar encendido.

## Uso

1. **Conectar parche** → en el selector del navegador elegir `ParcheEMG`.
2. La gráfica empieza a dibujar el IF cuando hay una tarea (más de 10 %CVM) y pasan los 7 s de la referencia A₀.
3. Si se pierde la conexión, la app reintenta sola 3 veces. Si no vuelve, aparece **Reconectar**.
4. **Modo demo** genera datos falsos con el mismo formato (botón ×1 / ×5 para acelerar).
5. **Pausa**, **Nueva sesión** (toca dos veces para confirmar), **Exportar CSV** y **Sonido**.

Mientras mide, la app mantiene la pantalla encendida. Cambiar entre el parche y el demo empieza una sesión nueva.

> **Seguridad:** mientras alguien tenga electrodos puestos, el parche funciona **solo con batería**.

## Desarrollo

Requisito: **Node 22 LTS (≥ 22.12)**. En Windows se instala desde nodejs.org; comprobar con `node -v`.

```bash
npm install          # una vez
npm run dev          # http://localhost:5173
npm test             # tests (Vitest)
npm run typecheck    # revisa tipos
npm run build        # genera dist/ (lo mismo que se publica)
npm run preview      # sirve dist/ en http://localhost:4173
```

En `localhost` Chrome permite Web Bluetooth sin HTTPS.

### Páginas de prueba (no se publican)

| Página | Para qué |
| --- | --- |
| `/dev/app.html` | **La app completa** (`main.ts`) con el parche simulado. Botón **Prueba automática** (~25 s, 59 comprobaciones). Con `?real=1` usa el Bluetooth de verdad. |
| `/dev/sources.html` | Fuentes BLE y demo solas (chat 2). |
| `/dev/ui.html` | Interfaz sola con escenarios fijos (chat 3). |

### Estructura

```
index.html              markup de la app; carga src/ui/styles.css y src/main.ts
src/main.ts             conecta todo: botones → fuente → parser → sesión → interfaz
src/config.ts           UUID, umbrales, tiempos
src/types.ts            tipos compartidos
src/core/               protocol.ts (parser "IF,%CVM,estado"), session.ts (tareas, alarma)
src/sources/            ble.ts (Web Bluetooth), demo.ts (datos sintéticos)
src/ui/                 chart.ts, panel.ts, alerts.ts, export.ts, styles.css
dev/                    páginas de prueba y parche simulado
tests/                  Vitest
legacy/index.html       versión de un archivo (plan B)
.github/workflows/deploy.yml   publicación en GitHub Pages
```

Las interfaces entre módulos y las decisiones de diseño están en `claude/app-arquitectura.md` (proyecto de Claude).

## Contrato de datos (lo que manda el parche)

Nombre `ParcheEMG`, servicio UART de Nordic:

| | UUID |
| --- | --- |
| Servicio | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` |
| TX (notify, parche → app) | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` |

10 mensajes por segundo, texto terminado en `\n`: `IF,%CVM,estado` (ejemplo `1.32,45,1`). Estado: `0` normal, `1` precaución, `2` riesgo. Mientras no hay IF válido (espera, calibración, "listo" y los 7 s de A₀) el parche manda `IF = 1.00`.

Para ver los datos del parche sin la app: **Bluefruit Connect** (UART / Plotter) o **nRF Connect**.

## Publicar en GitHub Pages

Una sola vez:

1. Subir el proyecto a un repositorio de GitHub (rama `main`). No subir `node_modules/` ni `dist/` (ya están en `.gitignore`).
2. En el repositorio: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

Después, cada `git push` a `main` corre `.github/workflows/deploy.yml`: instala, corre los tests, hace el build, agrega `legacy/` y publica. Se ve el avance en la pestaña **Actions**; si fallan los tests o el build, no se publica nada y queda la versión anterior. También se puede lanzar a mano con **Actions → Publicar en GitHub Pages → Run workflow**.

## Si algo falla

- **"Este navegador no tiene Web Bluetooth"**: abrir en Chrome (no en Firefox, Safari ni el navegador de Samsung), y por HTTPS (GitHub Pages) o `localhost`.
- **El selector no muestra `ParcheEMG`**: revisar que el parche esté encendido, cerca, y que no esté conectado a otro teléfono o a Bluefruit Connect.
- **"El dispositivo no tiene el servicio UART esperado"**: los UUID del firmware no coinciden con los de arriba.
- **No suena la alarma**: tocar la página una vez (el navegador no deja sonar audio sin un toque) y revisar el botón Sonido y el volumen del teléfono.
- **Plan B**: abrir `/legacy/`. Si tampoco conecta, usar Bluefruit Connect (UART + Plotter).
