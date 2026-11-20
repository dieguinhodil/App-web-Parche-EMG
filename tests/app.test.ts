// Tests del chat 4 que corren en Node. La integración de main.ts (botones, D2, D3, D7, D9)
// se prueba en el navegador con dev/app.html → "Prueba automática".

import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';
import appHtml from '../dev/app.html?raw';
import legacyHtml from '../legacy/index.html?raw';
import mainTs from '../src/main.ts?raw';
import workflow from '../.github/workflows/deploy.yml?raw';

const appMarkup = (html: string) => html.slice(html.indexOf('<header>'), html.indexOf('</footer>'));

describe('páginas', () => {
  it('dev/app.html tiene el mismo markup de la app que index.html', () => {
    expect(appMarkup(appHtml).length).toBeGreaterThan(1000);
    expect(appMarkup(appHtml)).toBe(appMarkup(indexHtml));
  });

  it('dev/app.html carga los mismos estilos y dev/app.ts (que importa src/main.ts)', () => {
    expect(appHtml).toContain('href="../src/ui/styles.css"');
    expect(appHtml).toContain('src="./app.ts"');
  });

  it('index.html carga main.ts como módulo', () => {
    expect(indexHtml).toContain('<script type="module" src="./src/main.ts"></script>');
  });

  it('legacy/index.html es la versión de un archivo (plan B) y no depende de src/', () => {
    expect(legacyHtml).toContain('ingestLine');
    expect(legacyHtml).not.toContain('src/main.ts');
  });
});

describe('main.ts', () => {
  it('abre el selector de Bluetooth directo desde el clic (sin await antes de ble.start)', () => {
    const a = mainTs.indexOf("btn.connect.addEventListener('click'");
    const b = mainTs.indexOf('ble.start()', a);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(mainTs.slice(a, b)).not.toMatch(/\bawait\b|async/);
  });

  it('aplica D7: agrega source = kind de la fuente activa al status del panel', () => {
    expect(mainTs).toMatch(/\{\s*\.\.\.status,\s*source:\s*active\.kind\s*\}/);
  });
});

describe('workflow de GitHub Pages', () => {
  it('prueba, construye, agrega el legacy y publica', () => {
    for (const s of ['npm ci', 'npm test', 'npm run build', 'cp -r legacy dist/legacy', 'actions/deploy-pages']) {
      expect(workflow).toContain(s);
    }
  });
});
