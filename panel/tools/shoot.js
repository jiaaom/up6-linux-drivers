// Screenshot the panel UI at 390 x 780 (2×) without a display, and print the
// page's console errors. Uses the Electron the kiosk bundles:
//
//   panel/app/node_modules/electron/dist/electron --ozone-platform=headless \
//     panel/tools/shoot.js <url> <out.png> [steps.js]
//
// steps.js (optional) is run in the page before the shot; it may return a
// promise. Several shots: give out as name-%d.png and have steps.js call
// `await shot()` between steps. `await key('ArrowDown')` sends a real
// (trusted) key press, as the remote does.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');

const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('shoot.js')) + 1);
const [url, out, stepsFile] = args;

app.commandLine.appendSwitch('force-device-scale-factor', '2');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 390, height: 780, show: false, useContentSize: true,
    webPreferences: { offscreen: true },
  });
  // offscreen rendering: keep the last painted frame
  let frame = null;
  win.webContents.setFrameRate(30);
  win.webContents.on('paint', (e, dirty, image) => { frame = image; });
  let n = 0;
  const save = async () => {
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 150));
    const img = frame;
    const file = out.includes('%d') ? out.replace('%d', String(n++)) : out;
    fs.writeFileSync(file, img.toPNG());
    console.log('wrote', file);
  };
  win.webContents.on('console-message', (e, level, message, line, source) => {
    if (level >= 2) console.log(`[page ${level === 3 ? 'error' : 'warn'}] ${message} (${source}:${line})`);
  });
  await win.loadURL(url);
  win.webContents.focus(); // so fields get focus events (the keyboard opens on them)
  await new Promise((r) => setTimeout(r, 1500));
  if (stepsFile) {
    const steps = fs.readFileSync(stepsFile, 'utf8');
    // a page-side shot() that asks us to capture, via a polled flag
    await win.webContents.executeJavaScript(`window.__shots = 0; window.shot = () => { window.__shots++; return new Promise(r => setTimeout(r, 1200)); };
      window.__keys = []; window.key = (k) => { window.__keys.push(k); return new Promise(r => setTimeout(r, 400)); }; 0;`);
    const run = win.webContents.executeJavaScript(`(async () => { ${steps} })()`);
    let taken = 0;
    let done = false;
    run.then(() => { done = true; }, (e) => { console.log('[steps error]', e.message); done = true; });
    while (!done) {
      const want = await win.webContents.executeJavaScript('window.__shots');
      while (taken < want) { await new Promise((r) => setTimeout(r, 500)); await save(); taken++; }
      for (const k of await win.webContents.executeJavaScript('window.__keys.splice(0)')) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k });
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  await save();
  app.quit();
});
