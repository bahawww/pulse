import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev server proxies /api to the Express backend so the SPA and API share an
// origin. In production Express serves dist/client directly — no proxy needed.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          // The renderer (react-dom/client) too: React only changes on upgrades,
          // so this chunk keeps its hash across deploys and stays in the
          // service worker's cache while the app chunk changes.
          react: ['react', 'react-dom', 'react-dom/client'],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8081',
        changeOrigin: false,
        ws: true,
      },
    },
  },
});