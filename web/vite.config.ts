import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';

/** Inlined into the bundle so the sidebar shows the version without a startup request. */
const appVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
})();

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
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
            // Higher priority claims shared deps (e.g. react/jsx-runtime) before lower groups pull them in.
            { name: 'react-vendor', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 4 },
            { name: 'router-query', test: /node_modules[\\/](react-router|@tanstack[\\/]react-query)[\\/]/, priority: 3 },
            // Slot (Button asChild) is needed at startup; keep it apart so the dialog and
            // switch primitives only load with the screens that use them.
            { name: 'radix-slot', test: /node_modules[\\/]@radix-ui[\\/]react-(slot|compose-refs)[\\/]/, priority: 2 },
            { name: 'radix-ui', test: /node_modules[\\/]@radix-ui[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
});