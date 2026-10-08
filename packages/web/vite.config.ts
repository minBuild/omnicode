import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_ORIGIN = 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_ORIGIN, changeOrigin: false },
      '/oauth': { target: API_ORIGIN, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    // CSP(16.3)는 script-src 'self' 뿐이다. 인라인 스크립트가 나오지 않도록 폴리필 주입을 끈다.
    modulePreload: { polyfill: false },
  },
});
