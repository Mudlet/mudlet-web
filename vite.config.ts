import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import mudlet from './vite-plugin/vite';
import { buildDefine } from './buildInfo';

// The standalone app build. All mudlet-specific machinery (pcre2 WASM, node
// polyfills incl. workers, the VFS service worker, optimizeDeps/onwarn tweaks)
// lives in the shared `Mudlet Web/vite` plugin — imported here from source — so the
// app build and branded consumer builds can't drift apart. The service-worker
// emission self-skips here because public/vfs-sw.js exists.
export default defineConfig({
    base: './',
    define: buildDefine(),
    plugins: [mudlet(), react()],
});
