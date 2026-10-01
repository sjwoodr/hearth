import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: { outDir: '../dist/client', emptyOutDir: true },
  // host: true listens on the LAN too, so other devices can reach the dev server;
  // the backend stays on 127.0.0.1 behind this proxy. '.local' admits any mDNS
  // name (Vite blocks unknown Host headers; IPs pass anyway). Public DNS never
  // resolves .local, so this does not reopen DNS rebinding.
  server: {
    host: true,
    allowedHosts: ['.local'],
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
