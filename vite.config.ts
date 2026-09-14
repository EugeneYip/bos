import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';

export default defineConfig({
  base: process.env.VITE_BASE ?? '/bos/',
  plugins: [glsl({ compress: false })],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2400,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          rapier: ['@dimforge/rapier3d-compat'],
        },
      },
    },
  },
  server: { port: 5173, host: true },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
