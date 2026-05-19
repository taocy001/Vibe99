import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  base: '',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: 'src/index.html',
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
  test: {
    root: '.',
    include: ['src/**/*.test.{js,ts}'],
    environment: 'node',
  },
});
