// vite.config.js (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

import { defineConfig } from 'vite';

import fs from 'fs';
import path from 'path';

function serveAssetsPlugin() {
  return {
    name: 'serve-assets',
    configureServer(server) {
      server.middlewares.use('/assets', (req, res, next) => {
        const filePath = path.join(__dirname, 'server/assets', req.url.split('?')[0]);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          res.setHeader('Access-Control-Allow-Origin', '*');
          if (filePath.endsWith('.png')) res.setHeader('Content-Type', 'image/png');
          else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) res.setHeader('Content-Type', 'image/jpeg');
          else if (filePath.endsWith('.ktx2')) res.setHeader('Content-Type', 'image/ktx2');
          
          const stream = fs.createReadStream(filePath);
          stream.pipe(res);
        } else {
          next();
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [serveAssetsPlugin()],
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
