// A QR code as Ridgeline's rl-qr: dark squares on white, with a quiet zone,
// so every scanner reads it in either theme. Encoding comes from the vendored
// qrcode-generator (vendor/, loaded by index.html as window.qrcode).

import { html, raw } from '../core/dom.js';

const QUIET = 2; // modules of white around the code

/** qr('WIFI:…', 168, 'label') → Raw <svg class="rl-qr">. */
export function qr(text, size = 168, label = '') {
  const lib = window.qrcode;
  if (!lib) return html``;
  lib.stringToBytes = lib.stringToBytesFuncs['UTF-8'];
  const code = lib(0, 'M');
  code.addData(text);
  code.make();
  const n = code.getModuleCount();
  const u = size / (n + 2 * QUIET);
  let rects = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (code.isDark(y, x)) rects += `<rect x="${((x + QUIET) * u).toFixed(2)}" y="${((y + QUIET) * u).toFixed(2)}" width="${(u + 0.05).toFixed(2)}" height="${(u + 0.05).toFixed(2)}"/>`;
    }
  }
  return html`<svg class="rl-qr" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${label}">${raw(rects)}</svg>`;
}

/** The Wi-Fi join string phones read from a QR code (WPA, with escaping). */
export function wifiJoinText(ssid, password) {
  const esc = (s) => String(s).replace(/([\;,:"])/g, '\\$1');
  return `WIFI:T:WPA;S:${esc(ssid)};P:${esc(password)};;`;
}
