// T6 front-panel Electron shell.
//
// Renderer = the panel UI served by t6-paneld over localhost (so its relative
// /api fetches keep working). The main process only adds what a plain kiosk
// browser can't: GPU acceleration switches and a fullscreen, locked-down window.
//
// fnOS authentication is handled natively by t6-paneld (its Rust WS client at
// /api/fnos), so there is no login/session/network bridge in the shell anymore.

const { app, BrowserWindow } = require('electron');
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
// the NAS's address (e.g. its Tailscale IP) so the UI comes from it.
const NAS = process.env.NAS_HOST || '127.0.0.1';
const PANEL_URL = process.env.PANEL_URL || `http://${NAS}:${process.env.PANEL_PORT || '8901'}/`;
const SIZE = { width: 1080, height: 2160 };

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
