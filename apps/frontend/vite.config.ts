import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../desktop/frontend-dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
