// LocalTalk Electron main process.
// Sidecar-host logic lives in ./sidecar-host.js (ported and slimmed from Sokuji's
// electron/native-host-manager.js — the bundle-download and SKU lanes are dropped;
// personal/dev use runs the sidecar from the conda env resolved in sidecar-host).
const path = require('path');
const { app, BrowserWindow, session } = require('electron');
const { SidecarHost } = require('./sidecar-host');

// The renderer's Silero VAD worker (onnxruntime-web) needs SharedArrayBuffer
// without full cross-origin isolation in the packaged app, and Chromium must
// NOT throttle the hidden/minimized renderer — the WASM inference loop's
// setTimeout-based yields get clamped and translation stalls (Sokuji issue #263).
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const sidecarHosts = {
  // dev tree: dist-electron/main.js -> app root -> New/ root -> sidecar
  speaker: new SidecarHost({ sidecarDir: path.join(__dirname, '..', '..', 'sidecar'), lane: 'speaker' }),
  // The participant lane runs its OWN python process: the sidecar's engines are
  // process singletons (last translate_init wins), so two directions cannot share
  // one process. Separate processes = separate VRAM allocations, no eviction.
  participant: new SidecarHost({ sidecarDir: path.join(__dirname, '..', '..', 'sidecar'), lane: 'participant' }),
};

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'LocalTalk',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Forward renderer diagnostics to the dev terminal (stdout) — far easier to
  // read from logs than a detached DevTools window.
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    const text = (e && typeof e.message === 'string') ? e.message : message;
    const lv = (e && e.level) || level;
    const at = (e && e.sourceId) ? `${e.sourceId}:${e.lineNumber}` : (sourceId ? `${sourceId}:${line}` : '');
    console.log(`[renderer ${lv}] ${text}${at ? ` (${at})` : ''}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`));
  win.webContents.on('render-process-gone', (_e, details) =>
    console.error('[renderer] process gone:', JSON.stringify(details)));

  // Dev diagnostic: LT_SHOT=<path> captures the rendered page once loaded and
  // settled — works even when the monitor is off (compositor-backed), unlike
  // a screen grab.
  if (process.env.LT_SHOT) {
    const shotPath = process.env.LT_SHOT;
    const grab = () => win && win.webContents.capturePage()
      .then((img) => {
        require('fs').writeFileSync(shotPath, img.toPNG());
        console.log(`[localtalk] screenshot saved ${shotPath}`);
      })
      .catch((e) => console.error('[localtalk] capturePage failed:', e));
    const probe = () => win && win.webContents.executeJavaScript(`(() => {
      const segs = [...document.querySelectorAll('.seg')];
      const asrSel = document.querySelector('.picker select');
      return JSON.stringify({
        segCount: segs.length,
        seg0: segs[0] ? segs[0].outerHTML.slice(0, 240) : null,
        segH: segs.map((s) => s.getBoundingClientRect().height),
        titles: [...document.querySelectorAll('.section-title')].map((t) => t.textContent),
        asrCount: asrSel ? asrSel.options.length : -1,
        asrHasQwen: asrSel ? [...asrSel.options].some((o) => o.text.includes('Qwen3-ASR')) : false,
        cloneNote: [...document.querySelectorAll('.dim-sm')].some((d) => d.textContent.includes('不支持音色克隆')),
        cloneBtns: !!document.querySelector('.voice-btns'),
        status: (document.querySelector('.status-txt') || {}).textContent || null,
        devRows: document.querySelectorAll('.dev-section .device-option').length,
        aliasRows: [...document.querySelectorAll('.dev-section .device-option > span:first-child')].filter((s) => /^(Default|Communications) - /.test(s.textContent || '')).length,
        cloneOnlyNote: [...document.querySelectorAll('.dim-sm')].some((d) => d.textContent.includes('只能克隆')),
        bar: (() => {
          const b = document.querySelector('.control-bar');
          if (!b) return null;
          const r = b.getBoundingClientRect();
          const cr = (s) => { const e = document.querySelector(s); if (!e) return null; const x = e.getBoundingClientRect(); return [Math.round(x.x), Math.round(x.y), Math.round(x.width)]; };
          return { w: Math.round(r.width), h: Math.round(r.height), wrap: getComputedStyle(b).flexWrap,
            stage: Math.round(b.parentElement.getBoundingClientRect().width), dpr: devicePixelRatio,
            left: cr('.cb-left'), center: cr('.cb-center'), right: cr('.cb-right'), main: cr('.main-btn'), hold: cr('.hold-btn') };
        })(),
      });
    })()`).then((s) => console.log('[probe]', s)).catch((e) => console.error('[probe]', String(e)));
    win.webContents.on('did-stop-loading', () => setTimeout(() => { void grab(); probe(); }, 6000));
    // Mic-pipeline proof: click 开始会话 (loads engines + opens the mic — a
    // broken worklet shows up as a ReferenceError in the forwarded console),
    // then re-probe the status line once the session should be ready.
    if (process.env.LT_CLICK) {
      win.webContents.on('did-stop-loading', () => setTimeout(() => {
        if (!win) return;
        win.webContents.executeJavaScript(`(() => { const b = document.querySelector('.main-btn'); if (b) b.click(); return !!b; })()`)
          .then((ok) => console.log('[probe-click] main-btn clicked:', ok));
        setTimeout(() => { void grab(); probe(); }, 20000);
      }, 7000));
    }
  }

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  sidecarHosts.speaker.registerIpc(sidecarHosts);

  // Microphone (getUserMedia) is the only extra power this app asks for.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media' || permission === 'mediaKeySystem' || permission === 'autoplay');
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) =>
    permission === 'media' || permission === 'audioCapture');

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  for (const h of Object.values(sidecarHosts)) h.stop();
  app.quit();
});

app.on('before-quit', () => { for (const h of Object.values(sidecarHosts)) h.stop(); });
