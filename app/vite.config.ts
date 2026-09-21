import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';

// Some launchers (CI runners, harnesses, Electron-embedded terminals) export
// ELECTRON_RUN_AS_NODE=1, which silently turns electron.exe into a plain Node
// process — the main script then sees require('electron') return the binary
// PATH (a string) and dies on `app.whenReady()`. Delete it right before the
// spawn so the dev launcher works everywhere; a plain user terminal is unaffected.
function withoutRunAsNode(): void {
  delete process.env.ELECTRON_RUN_AS_NODE;
}

/**
 * Serve onnxruntime-web's runtime files from node_modules (ported from Sokuji's
 * vite.config.ts, AGPL-3.0). Covers (1) explicit wasmPaths requests under
 * /wasm/ort/ and (2) ORT's dynamic sibling imports of ort-wasm-*.mjs from
 * bundled chunks. Under cross-origin isolation ORT loads the threaded runtime
 * as nested pthread worker scripts, so these responses need COEP + CORP.
 */
function serveOrtWasm(): Plugin {
  return {
    name: 'serve-ort-wasm',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.replace(/\?.*$/, '') || '';
        let filename: string | null = null;
        if (url.startsWith('/wasm/ort/')) {
          filename = decodeURIComponent(url.replace('/wasm/ort/', ''));
        } else {
          const match = url.match(/(ort-wasm[^/]*\.(?:mjs|js|wasm))$/);
          if (match) filename = match[1];
        }
        if (!filename) return next();
        const filePath = path.join(process.cwd(), 'node_modules/onnxruntime-web/dist', filename);
        if (!fs.existsSync(filePath)) return next();
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return next();
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Content-Length', stat.size);
        if (filename.endsWith('.mjs') || filename.endsWith('.js')) {
          res.setHeader('Content-Type', 'application/javascript');
        } else if (filename.endsWith('.wasm')) {
          res.setHeader('Content-Type', 'application/wasm');
        } else {
          res.setHeader('Content-Type', 'application/octet-stream');
        }
        fs.createReadStream(filePath).pipe(res);
      });
    },
  };
}

/**
 * Dev-only: stamp cross-origin isolation headers on EVERY response. Electron's
 * Chromium requires COEP for ES-module workers even with SharedArrayBuffer
 * enabled via command-line switch, and Vite's `server.headers` does not reach
 * all worker-script responses — a top-of-stack middleware covers them all.
 * (Ported from Sokuji's vite.config.ts.)
 */
function crossOriginIsolationHeaders(): Plugin {
  return {
    name: 'cross-origin-isolation-headers',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        next();
      });
    },
  };
}

/**
 * Rollup emits hashed ort-wasm-*.wasm assets because onnxruntime-web uses
 * `new URL('...wasm', import.meta.url)`. Our worker sets ORT's `wasmPaths` to
 * the canonical files under wasm/ort/, so those emitted assets are unreachable
 * duplicates of the files in public/wasm/ort/ (ported from Sokuji's
 * vite.drop-duplicate-ort-wasm.ts).
 */
function dropDuplicateOrtWasm(): Plugin {
  return {
    name: 'drop-duplicate-ort-wasm',
    generateBundle(_options, bundle) {
      for (const key of Object.keys(bundle)) {
        if (key.includes('ort-wasm') && key.endsWith('.wasm')) {
          delete bundle[key];
        }
      }
    },
  };
}

// dev: `npm run dev` boots Vite AND launches Electron (vite-plugin-electron).
// build: renderer -> dist/, main+preload -> dist-electron/.
export default defineConfig({
  // Relative base so the packaged renderer works from file://.
  base: './',
  plugins: [
    react(),
    serveOrtWasm(),
    crossOriginIsolationHeaders(),
    dropDuplicateOrtWasm(),
    electron({
      main: {
        entry: 'electron/main.js',
        onstart: (args) => {
          withoutRunAsNode();
          void args.startup();   // default argv: ['.', '--no-sandbox']
        },
      },
      preload: {
        input: 'electron/preload.js',
      },
    }),
  ],
  // The VAD worker must stay an ES module (it imports onnxruntime-web).
  worker: { format: 'es' },
  server: { port: 5273, strictPort: false },
});
