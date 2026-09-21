// Spawns and supervises the Python sidecar (`python -m sokuji_sidecar`).
// Ported from Sokuji's electron/native-host-manager.js (AGPL-3.0), slimmed for
// personal/dev use: no self-contained bundle download, no SKU detection — the
// interpreter comes from one of (in order):
//   1. $LOCALTALK_SIDECAR_PYTHON            (explicit override)
//   2. New/sidecar/.python-path             (written by setup-conda.ps1 / setup.ps1)
//   3. New/sidecar/.venv                    (plain-venv fallback, setup.ps1)
//
// Protocol with the child (same as upstream):
//   - the sidecar binds its WS port on 127.0.0.1 and prints ONE line to stdout:
//       {"port": 12345}
//   - the renderer then opens ws://127.0.0.1:<port> (one socket per stage).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const { app, ipcMain } = require('electron');

// The handshake is fast (~0.2s), but a first launch right after a big pip install
// can fight disk writeback; upstream measured a 30s budget blow up on slow disks.
const HANDSHAKE_TIMEOUT_MS = 90000;

function resolvePython(sidecarDir, env) {
  if (env.LOCALTALK_SIDECAR_PYTHON) return env.LOCALTALK_SIDECAR_PYTHON;
  const marker = path.join(sidecarDir, '.python-path');
  try {
    const p = fs.readFileSync(marker, 'utf8').trim();
    if (p && fs.existsSync(p)) return p;
  } catch (_) { /* no marker — fall through */ }
  const venv = path.join(sidecarDir, '.venv');
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
}


function parseHandshake(line) {
  try {
    const obj = JSON.parse(line);
    return typeof obj.port === 'number' ? obj.port : null;
  } catch {
    return null;
  }
}

class SidecarHost {
  constructor({ sidecarDir, lane = 'speaker' }) {
    this.sidecarDir = sidecarDir;
    this.lane = lane;
    this.proc = null;
    this.port = null;
    this._starting = null;
  }

  start() {
    if (this.port) return Promise.resolve({ port: this.port });
    if (this._starting) return this._starting; // single-flight: never race two boots
    this._starting = new Promise((resolve, reject) => {
      const python = resolvePython(this.sidecarDir, process.env);
      // Keep the user's own env (HF_HOME / HF_ENDPOINT mirrors included), but
      // isolate the model cache under userData unless the user set HF_HOME.
      const hfHome = process.env.HF_HOME || path.join(app.getPath('userData'), 'hf-cache');
      const env = { ...process.env, HF_HOME: hfHome };
      const spawnedAt = Date.now();
      const child = spawn(python, ['-m', 'sokuji_sidecar'], {
        cwd: this.sidecarDir, env, windowsHide: true,
      });
      this.proc = child;

      const rl = readline.createInterface({ input: child.stdout });
      const onLine = (line) => {
        const port = parseHandshake(line);
        if (port) {
          console.log(`[localtalk] sidecar(${this.lane}) handshake in ${Date.now() - spawnedAt} ms (port ${port})`);
          this.port = port;
          rl.off('line', onLine);
          resolve({ port });
        }
      };
      rl.on('line', onLine);
      child.stderr.on('data', (d) => console.error(`[localtalk] [sidecar:${this.lane}]`, d.toString().trim()));
      child.on('exit', (code) => {
        console.warn(`[localtalk] sidecar(${this.lane}) exited`, code);
        const preHandshake = !this.port;
        this.proc = null; this.port = null; this._starting = null;
        // Fail fast — otherwise every renderer connect() would hang to its own timeout.
        if (preHandshake) reject(new Error(`sidecar exited before handshake (code ${code}). Run New/sidecar/setup.ps1 first?`));
      });
      child.on('error', (err) => {
        this.proc = null; this.port = null; this._starting = null;
        reject(err);
      });
      setTimeout(() => {
        if (!this.port) {
          try { child.kill(); } catch (_) { /* ignore */ }
          this.proc = null; this.port = null; this._starting = null;
          reject(new Error('sidecar handshake timeout'));
        }
      }, HANDSHAKE_TIMEOUT_MS);
    });
    return this._starting;
  }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch (_) { /* ignore */ } }
    this.proc = null; this.port = null; this._starting = null;
  }

  status() { return { running: !!this.proc, port: this.port }; }

  // IPC channel names kept identical to Sokuji's so the ported SidecarConnection.ts
  // speaks them unchanged. The renderer passes { lane } to pick which sidecar
  // process serves it — 'speaker' (my mic lane) or 'participant' (their audio lane).
  // Each lane is its own SidecarHost instance with its own Python process, so the
  // two lanes' models load into separate VRAM allocations and never evict each other.
  registerIpc(hosts) {
    const pick = (lane) => hosts[lane] || hosts.speaker;
    ipcMain.handle('native-host:start', async (_e, data) => {
      const host = pick(data && data.lane);
      try { return { ok: true, ...(await host.start()) }; }
      catch (e) { return { ok: false, error: e.message }; }
    });
    ipcMain.handle('native-host:stop', (_e, data) => { pick(data && data.lane).stop(); return { ok: true }; });
    ipcMain.handle('native-host:status', (_e, data) => ({ ok: true, ...pick(data && data.lane).status() }));
  }
}

module.exports = { SidecarHost, resolvePython, parseHandshake, HANDSHAKE_TIMEOUT_MS };
