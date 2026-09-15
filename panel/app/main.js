// T6 front-panel Electron shell.
//
// Renderer = the existing panel UI (served by t6-paneld over localhost, so its
// relative /api fetches keep working). Main process adds what a plain kiosk
// browser can't: a fullscreen locked-down window, and a hidden-window login
// that drives fnOS's own login page (their RSA/AES/gRPC crypto stays theirs)
// and captures the session cookie on a persistent partition.

const { app, BrowserWindow, session, ipcMain } = require('electron');
const fs = require('fs');

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
// the NAS's address (e.g. its Tailscale IP) so both the UI and fnOS come from it.
const NAS = process.env.NAS_HOST || '127.0.0.1';
const PANEL_URL = process.env.PANEL_URL || `http://${NAS}:${process.env.PANEL_PORT || '8901'}/`;
// fnOS login + gateway live on the plain-http origin (port 80 → login portal :5666).
const FNOS_ORIGIN = process.env.FNOS_ORIGIN || `http://${NAS}`;
const SIZE = { width: 1080, height: 2160 };

// Shared, persisted session so the login cookie survives reboots and is visible
// to every window (main UI + hidden login).
const fnosSession = () => session.fromPartition('persist:fnos');

let currentUser = null; // { username, uid, is_admin } or null

// ---- hidden-window login -------------------------------------------------

const fillJs = (u, p) => `(() => {
  const setVal = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const un = document.querySelector('#username'), pw = document.querySelector('#password');
  if (!un || !pw) return false;
  setVal(un, ${JSON.stringify(u)}); setVal(pw, ${JSON.stringify(p)});
  const cb = document.querySelector('input[type=checkbox]'); if (cb && !cb.checked) cb.click();
  return true;
})()`;

const clickJs = `(() => {
  const b = [...document.querySelectorAll('button,input[type=submit]')]
    .find(x => /log ?in|sign ?in/i.test((x.innerText || x.value || '')));
  if (b) { b.click(); return true; }
  const f = document.querySelector('form'); if (f) { f.requestSubmit ? f.requestSubmit() : f.submit(); return true; }
  return false;
})()`;

async function waitFor(wc, js, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await wc.executeJavaScript(js).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Resolve the signed-in identity from the current session (via the gateway
// whoami — the session cookie carries the identity).
async function resolveUser(wc) {
  // Relative URL so it resolves against whatever fnOS origin the window is on
  // (login lands on :5666; the boot probe is on :80). Both proxy /app/t6panel.
  const txt = await wc
    .executeJavaScript(`fetch('/app/t6panel/api/session',{cache:'no-store'}).then(r=>r.ok?r.text():'null').catch(()=>'null')`)
    .catch(() => 'null');
  try {
    const j = JSON.parse(txt);
    return j && j.username ? j : null;
  } catch {
    return null;
  }
}

async function doLogin(user, password) {
  const win = new BrowserWindow({
    ...SIZE,
    show: false,
    webPreferences: { session: fnosSession() },
  });
  try {
    await win.loadURL(`${FNOS_ORIGIN}/`);
    const hasForm = await waitFor(win.webContents, `!!document.querySelector('#username')&&!!document.querySelector('#password')`);
    if (!hasForm) return { ok: false, error: 'login form not found' };
    if (!(await win.webContents.executeJavaScript(fillJs(user, password)))) return { ok: false, error: 'could not fill form' };
    await new Promise((r) => setTimeout(r, 300));
    await win.webContents.executeJavaScript(clickJs);
    const left = await waitFor(win.webContents, `!/\\/login/.test(location.href)`);
    if (!left) return { ok: false, error: 'login failed (wrong password?)' };
    const u = await resolveUser(win.webContents);
    if (!u) return { ok: false, error: 'logged in but identity unresolved' };
    currentUser = u;
    return { ok: true, user: u };
  } finally {
    win.destroy();
  }
}

async function logout() {
  currentUser = null;
  await fnosSession().clearStorageData({ storages: ['cookies'] });
  return { ok: true };
}

ipcMain.handle('fnos:login', (_e, { user, password }) => doLogin(user, password));
ipcMain.handle('fnos:session', () => currentUser);
ipcMain.handle('fnos:logout', () => logout());

// ---- main window ---------------------------------------------------------

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
      session: fnosSession(),
    },
  });
  win.loadURL(PANEL_URL);

  // On-panel verification: screenshot once after load, but keep running so the
  // app stays on the physical screen for interactive testing.
  if (process.env.PANEL_SHOT) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 4000));
      fs.writeFileSync(process.env.PANEL_SHOT, (await win.webContents.capturePage()).toPNG());
      console.log('PANEL_SHOT written');
    });
  }

  // Headless self-test: screenshot logged-out, log in, screenshot logged-in.
  if (process.env.SELFTEST) {
    const shot = async (n) => fs.writeFileSync(`${process.env.SELFTEST}-${n}.png`, (await win.webContents.capturePage()).toPNG());
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 2500));
      await shot('1out');
      // Drive the real login screen: open it, fill the fields, submit.
      await win.webContents.executeJavaScript(
        `(function(){showLogin();var u=document.getElementById('loginUser');u.value=${JSON.stringify(process.env.FNOS_USER)};document.getElementById('loginPass').value=${JSON.stringify(process.env.FNOS_PASS)};u.focus();u.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));})()`
      );
      await new Promise((r) => setTimeout(r, 800));
      await shot('2form');
      await win.webContents.executeJavaScript(`document.getElementById('loginSubmit').click()`);
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const done = await win.webContents
          .executeJavaScript(`!document.getElementById('login').classList.contains('on') && !document.getElementById('acct').classList.contains('signin')`)
          .catch(() => false);
        if (done) break;
      }
      await new Promise((r) => setTimeout(r, 800));
      await shot('3in');
      console.log('SELFTEST session:', JSON.stringify(currentUser));
      app.quit();
    });
  }
  return win;
}

app.whenReady().then(async () => {
  if (process.env.SELFTEST) {
    await fnosSession().clearStorageData({ storages: ['cookies'] });
    createWindow();
    return;
  }
  if (process.env.NO_PROBE) {
    createWindow();
    return;
  }
  // On boot, recover identity if the persisted session is still valid. Create
  // the main window first (so the app never sits with zero windows), then probe.
  const win = createWindow();
  const probe = new BrowserWindow({ ...SIZE, show: false, webPreferences: { session: fnosSession() } });
  probe
    .loadURL(`${FNOS_ORIGIN}/app/t6panel/`)
    .then(async () => {
      currentUser = await resolveUser(probe.webContents);
      probe.destroy();
      if (currentUser) win.webContents.executeJavaScript('window.refreshFnos && window.refreshFnos()').catch(() => {});
    })
    .catch(() => probe.destroy());
});
app.on('window-all-closed', () => app.quit());
