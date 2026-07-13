// vite.config.js (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 8000, // Increase limit to accommodate large Babylon.js 3D engine bundles
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // Group Babylon.js modules into their own separate code-split chunk
            if (id.includes('@babylonjs')) {
              return 'babylon';
            }
            return 'vendor';
          }
        }
      }
    }
  }
});
