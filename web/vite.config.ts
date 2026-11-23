import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      // Doujin cover media proxy (Hitomi CDN requires a hitomi.la Referer).
      '/media': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react-vendor', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'router-query', test: /node_modules[\\/](react-router|@tanstack[\\/]react-query)[\\/]/ },
            { name: 'radix-ui', test: /node_modules[\\/]@radix-ui[\\/]/ },
          ],
        },
      },
    },
  },
});