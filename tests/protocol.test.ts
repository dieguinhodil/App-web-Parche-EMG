import { describe, expect, it } from 'vitest';
import { LineParser, parseLine } from '../src/core/protocol';

describe('parseLine', () => {
  it('parsea el ejemplo del contrato', () => {
    expect(parseLine('1.32,45,1')).toEqual({ IF: 1.32, pct: 45, estado: 1 });
  });

  it('acepta los tres estados', () => {
    expect(parseLine('1.00,0,0')?.estado).toBe(0);
    expect(parseLine('1.30,40,1')?.estado).toBe(1);
    expect(parseLine('1.62,38,2')?.estado).toBe(2);
  });

  it('tolera \\r final y espacios alrededor de los campos', () => {
    expect(parseLine('1.32,45,1\r')).toEqual({ IF: 1.32, pct: 45, estado: 1 });
    expect(parseLine('  1.32 , 45 , 2  ')).toEqual({ IF: 1.32, pct: 45, estado: 2 });
  });

  it('acepta IF negativo y %CVM con decimales', () => {
    expect(parseLine('-0.05,3.5,0')).toEqual({ IF: -0.05, pct: 3.5, estado: 0 });
  });

  it.each([
    [''],
    ['   '],
    ['1.32,45'],            // faltan campos
    ['1.32,45,1,7'],        // sobran campos
    ['1.32,45,3'],          // estado fuera de rango
    ['1.32,45,-1'],
    ['1.32,45,1.0'],        // estado no entero
    ['1.32,,1'],            // campo vacío
    ['abc,45,1'],
    ['1.32x,45,1'],         // basura pegada al número
    ['1e3,45,1'],           // sin exponentes
    ['1.32;45;1'],          // separador incorrecto
    ['NaN,45,1'],
    ['Infinity,45,1'],
  ])('rechaza %j', (line) => {
    expect(parseLine(line)).toBeNull();
  });
});

describe('LineParser', () => {
  it('devuelve las líneas completas de un fragmento', () => {
    const p = new LineParser();
    expect(p.push('1.00,12,0\n1.10,20,0\n')).toEqual([
      { IF: 1.0, pct: 12, estado: 0 },
      { IF: 1.1, pct: 20, estado: 0 },
    ]);
  });

  it('une líneas partidas entre notificaciones', () => {
    const p = new LineParser();
    expect(p.push('1.3')).toEqual([]);
    expect(p.push('2,4')).toEqual([]);
    expect(p.push('5,1\n1.33,')).toEqual([{ IF: 1.32, pct: 45, estado: 1 }]);
    expect(p.push('46,1\n')).toEqual([{ IF: 1.33, pct: 46, estado: 1 }]);
  });

  it('ignora líneas vacías e inválidas sin perder las buenas', () => {
    const p = new LineParser();
    expect(p.push('\n\nhola\n1.32,45,9\n1.40,50,2\r\n')).toEqual([{ IF: 1.4, pct: 50, estado: 2 }]);
  });

  it('descarta el buffer si pasa de 64 caracteres sin salto de línea, y también la cola de esa línea', () => {
    const p = new LineParser();
    expect(p.push('x'.repeat(65))).toEqual([]);
    // la cola de la línea rota termina con algo que parece válido: no debe colarse
    expect(p.push('xx1.32,45,1\n')).toEqual([]);
    // la siguiente línea ya se lee normal
    expect(p.push('1.50,40,2\n')).toEqual([{ IF: 1.5, pct: 40, estado: 2 }]);
  });

  it('no descarta con exactamente 64 caracteres pendientes', () => {
    const p = new LineParser();
    p.push('y'.repeat(64));
    // la línea de 64 "y" es inválida, pero no activa el descarte: la siguiente se lee
    expect(p.push('\n1.00,0,0\n')).toEqual([{ IF: 1, pct: 0, estado: 0 }]);
  });

  it('reset() descarta lo pendiente', () => {
    const p = new LineParser();
    p.push('1.32,4');
    p.reset();
    expect(p.push('5,1\n')).toEqual([]);          // "5,1" solo no es válido
    expect(p.push('1.10,20,0\n')).toEqual([{ IF: 1.1, pct: 20, estado: 0 }]);
  });

  it('reset() también cancela el descarte de la cola', () => {
    const p = new LineParser();
    p.push('z'.repeat(80));
    p.reset();
    expect(p.push('1.10,20,0\n')).toEqual([{ IF: 1.1, pct: 20, estado: 0 }]);
  });

  it('procesa un flujo largo partido en trozos al azar', () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) lines.push(`${(1 + i / 1000).toFixed(2)},${i % 100},${i % 3}\n`);
    const text = lines.join('');
    const p = new LineParser();
    const got = [];
    let seed = 7;
    for (let i = 0; i < text.length; ) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = 1 + (seed % 20);                     // trozos de 1 a 20 bytes, como BLE
      got.push(...p.push(text.slice(i, i + n)));
      i += n;
    }
    expect(got).toHaveLength(500);
    expect(got[499]).toEqual({ IF: 1.5, pct: 99, estado: 499 % 3 });
  });
});
