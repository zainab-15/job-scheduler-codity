import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev integration without CORS: the API has no CORS headers, so instead of
// touching the backend we proxy /api from the Vite dev server to the API on
// :3000. The frontend calls same-origin `/api/v1/*`; Vite forwards it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
