// T6 front-panel Electron shell.
//
// Renderer = the panel UI served by t6-paneld over localhost (so its relative
// /api fetches keep working). The main process only adds what a plain kiosk
// browser can't: GPU acceleration switches, a fullscreen locked-down window,
// applying the fnOS Preview cookie, and hosting the Preview micro-app itself
// in its own WebContentsView (below — the one thing that needs the privileged
// session/view APIs, not IPC/RPC plumbing).
//
// fnOS authentication for everything else is handled natively by t6-paneld
// (its Rust WS client at /api/fnos) — no login/session/network bridge here.

const { app, BrowserWindow, WebContentsView, session, ipcMain } = require('electron');
const fs = require('fs');

// Where Chromium keeps this app's profile (localStorage = the UI's prefs such as
// file-browser view/sort and "show recent", cookies, caches). Under the systemd
// kiosk unit there is no $HOME, and Chromium then silently falls back to the
// temp dir — /tmp/.config/t6-panel — which systemd-tmpfiles wipes on every boot,
// so every pref was lost on reboot. The unit sets PANEL_DATA_DIR to a real
// state dir (/var/lib/t6-paneld/kiosk, removed with "remove settings" on
// uninstall); desktop/dev runs without it keep Electron's default ~/.config.
if (process.env.PANEL_DATA_DIR) {
  fs.mkdirSync(process.env.PANEL_DATA_DIR, { recursive: true });
  app.setPath('userData', process.env.PANEL_DATA_DIR);
}

// GPU acceleration (panel/Linux only). The Meteor Lake iGPU (PCI 0x7d55) needs
// Mesa >= 23 to drive iris; with a new-enough system Mesa, ANGLE's GLES backend
// composites on the iGPU (~10% CPU vs ~9 cores pegged under SwiftShader). We
// pick the GLES backend explicitly (the most reliable path on Mesa) and turn
// off the GPU blocklist so rasterization/compositing stay on hardware.
//
// NOTE: --ozone-platform=wayland is NOT set here on purpose — Electron reads the
// ozone platform from the real command line before this module runs, so
// appendSwitch can't set it. The panel launcher (run-kiosk.sh) passes it on the
// CLI. These GPU switches, by contrast, are consumed by the later-spawned GPU
// process, so setting them here takes effect.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('use-angle', 'gles');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
}

// On the panel/kiosk NAS_HOST is localhost; for a remote dev machine set it to
// the NAS's address (e.g. its Tailscale IP) so the UI comes from it.
const NAS = process.env.NAS_HOST || '127.0.0.1';
const PANEL_URL = process.env.PANEL_URL || `http://${NAS}:${process.env.PANEL_PORT || '8901'}/`;
// fnOS's own gateway (the Preview micro-app and its cookie both live here —
// see refs/fnos-preview-app.md), separate from the panel's own PANEL_URL above.
const FNOS_ORIGIN = process.env.FNOS_ORIGIN || `http://${NAS}:5666`;
const SIZE = { width: 1080, height: 2160 };

// Apply the fnOS `ost` session cookie (minted by t6-paneld from our native WS
// login's ticket — GET /api/fnos/preview-cookie) to this app's own cookie jar,
// so the Preview view at FNOS_ORIGIN/app/trim-preview/ authenticates without
// any separate browser-based login. httpOnly cookies can only be set via this
// privileged main-process API, not from renderer JS. previewView shares this
// app's default session (no partition given below), so the cookie applies to
// it too.
async function ensurePreviewCookie() {
  const res = await fetch(new URL('api/fnos/preview-cookie', PANEL_URL));
  const { cookie } = await res.json();
  if (!cookie) return false;
  await session.defaultSession.cookies.set({
    url: FNOS_ORIGIN, name: 'ost', value: cookie,
    httpOnly: true, sameSite: 'lax', path: '/',
  });
  return true;
}

// File preview (fnOS's "Preview" trim-preview micro-app) renders in its own
// WebContentsView, layered over the renderer's subpage content area (below
// the title/Done header, which stays part of the renderer's own DOM) rather
// than an <iframe> inside the renderer's page. Two reasons: it's genuinely a
// different origin with its own cookie-based auth, so it gets a real separate
// web-contents boundary instead of sharing the renderer's DOM/CSP; and the
// file-listing page underneath is never touched while Preview is open, so
// closing it is an instant bounds change, not a reload/refetch of the folder.
let previewView = null;
ipcMain.handle('preview:open', async (event, { path, bounds }) => {
  if (!previewView) return { ok: false, reason: 'no window' };
  previewView.setBounds(bounds);
  previewView.setVisible(true); // show immediately (themed bg) while it loads
  try { await ensurePreviewCookie(); } catch (e) { /* best-effort; the preview app surfaces its own auth error if this fails */ }
  previewView.webContents.loadURL(`${FNOS_ORIGIN}/app/trim-preview/?path=${encodeURIComponent(path)}&theme=dark`);
  return { ok: true };
});
ipcMain.handle('preview:close', async () => {
  if (!previewView) return { ok: false };
  previewView.setVisible(false);
  previewView.webContents.loadURL('about:blank'); // release the loaded page
  return { ok: true };
});

function createWindow() {
  const windowed = !!process.env.WINDOWED;
  const win = new BrowserWindow({
    // The UI scales to the window, so a smaller framed window is fine for
    // desktop testing; the panel itself runs fullscreen kiosk at native size.
    width: windowed ? 540 : SIZE.width,
    height: windowed ? 1040 : SIZE.height,
    fullscreen: !windowed,
    frame: windowed,
    kiosk: !windowed,
    backgroundColor: '#0d1420',
    webPreferences: {
      preload: `${__dirname}/preload.js`,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(PANEL_URL);
  // No more Preview-toolbar geometry hack here: the weston compositor scale
  // (panel/app/weston.ini) plus a genuinely responsive panel UI (no more fixed
  // 1080x2160 canvas + JS transform, see style.css) means the Preview view
  // now sees the real, correctly-scaled viewport on its own — see
  // refs/linux-wayland-dpi.md.

  previewView = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  previewView.setBackgroundColor('#0d1420'); // matches --bg; avoids a white flash while loading
  win.contentView.addChildView(previewView);
  previewView.setVisible(false); // hidden until preview:open

  // On-panel verification: screenshot once after load, but keep running so the
  // app stays on the physical screen for interactive testing.
  if (process.env.PANEL_SHOT) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 4000));
      fs.writeFileSync(process.env.PANEL_SHOT, (await win.webContents.capturePage()).toPNG());
      console.log('PANEL_SHOT written');
    });
  }
  return win;
}

app.whenReady().then(() => {
  createWindow();
});
app.on('window-all-closed', () => app.quit());
