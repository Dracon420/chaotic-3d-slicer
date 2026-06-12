import { defineConfig } from 'vite';

// During `npm run client:dev`, the Vite dev server proxies API / upload /
// socket traffic to the Express backend on port 3000, so the frontend and
// backend feel like one origin (no CORS headaches on your phone).
const BACKEND = 'http://localhost:3000';

export default defineConfig({
  server: {
    host: true, // listen on 0.0.0.0 so your phone can reach the dev server
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/uploads': { target: BACKEND, changeOrigin: true },
      '/output': { target: BACKEND, changeOrigin: true },
      '/socket.io': { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
