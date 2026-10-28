import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The web app. `index.html` at the repo root is the entry; the bundle goes to
// dist/web, next to the tsc output for the server (dist/cli.js, dist/server).
// In dev, Vite serves the app and proxies /api to the local pr-tour server.
const apiPort = process.env.PR_TOUR_PORT ?? '4317';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
});
