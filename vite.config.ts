import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Rutas relativas: la misma build funciona en https://<usuario>.github.io/<repo>/
  // sin tener que escribir el nombre del repositorio aquí.
  base: './',
  server: {
    port: 5173,
    strictPort: true, // si 5173 está ocupado, falla en vez de cambiar de puerto
  },
  build: {
    // Por defecto Vite solo construye index.html: las páginas de dev/ no se publican.
    outDir: 'dist',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
