// A captive portal's sign-in page (a hotel's or café's "Connect" page) full
// screen, built like the file preview: the panel draws only the bar, with
// 关闭 always there, and the page itself is a separate view Electron places
// under it (portalBridge, panel/app/main.js), which reaches the network
// through t6-paneld's portal proxy over Wi-Fi. The bar names the network and
// shows which site the page is on. After each page load the connectivity is
// checked, and once Wi-Fi reaches the internet the layer closes by itself.
// The panel's keyboard types into the page's fields (typeInto).
//
// Also here: turning t6-paneld's automatic acceptance of a network's page on
// or off (setAutoAccept; on by default for a page it recognises,
// crates/t6-paneld/src/autoaccept.rs), and telling when it accepted one, or
// couldn't (watchAutoAccept).

import { api, request } from '../../core/api.js';
import { el, html, on } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import { panel, refreshPanel } from '../../core/panel.js';
import { closeLayer, openLayer, toast } from '../../shell/layers.js';
import { keyboardChanged, keyboardEl, typeInto } from '../../shell/keyboard.js';

/** Also check this often while the page sits still (a grant can land late). */
const CHECK_EVERY_MS = 10000;
/** After a page loads, wait this long before checking (the grant settling). */
const CHECK_AFTER_LOAD_MS = 1500;

let current = null; // { entry, node, port, timer, checking, offKeyboard }

const sink = {
  insert: (text) => window.portalBridge.type({ text }),
  del: () => window.portalBridge.type({ key: 'Backspace' }),
  enter: () => window.portalBridge.type({ key: 'Enter' }),
};

// One set of listeners for the app's life; they act on the open layer.
window.portalBridge?.onState((s) => {
  if (!current) return;
  const host = current.node.querySelector('[data-host]');
  let site = '';
  try { site = new URL(s.url).host; } catch { /* not a URL yet */ }
  host.textContent = s.error ? t('portal.loadFailed', { why: s.error }) : s.loading && !site ? t('portal.loading') : site;
  current.node.classList.toggle('is-loading', !!s.loading);
  if (!s.loading) scheduleCheck(CHECK_AFTER_LOAD_MS);
});
window.portalBridge?.onFocus((editable) => {
  if (current) typeInto(editable ? sink : null);
});

/**
 * Where the page goes: under the bar, down to the keyboard or the bottom.
 * The keyboard's resting top, not its rect: it is still sliding in when
 * keyboardChanged fires.
 */
function place(node) {
  const stage = node.querySelector('.t6-portal__stage').getBoundingClientRect();
  const kb = keyboardEl();
  const kbTop = kb && (kb.offsetParent ? kb.offsetParent.getBoundingClientRect().top + kb.offsetTop : innerHeight - kb.offsetHeight);
  const bottom = kb ? Math.min(stage.bottom, kbTop) : stage.bottom;
  return { x: Math.round(stage.left), y: Math.round(stage.top), width: Math.round(stage.width), height: Math.round(bottom - stage.top) };
}

function scheduleCheck(ms) {
  if (!current) return;
  clearTimeout(current.timer);
  current.timer = setTimeout(check, ms);
}

async function check() {
  const mine = current;
  if (!mine || mine.checking) return;
  mine.checking = true;
  let wifi = '';
  try {
    // NetworkManager waits for the probe page, up to some 20 s on a bad network
    ({ wifi } = await request('network/connectivity/check', { method: 'POST', timeout: 30000 }));
  } catch { /* try again on the next round */ }
  mine.checking = false;
  if (current !== mine) return;
  if (wifi === 'full') {
    closePortal();
    // accepted by hand on a network whose page could be accepted by itself
    const w = panel.data?.network?.wifi;
    if (w?.portal_auto?.supported && !w.portal_auto.on) {
      toast(t('portal.done'), { action: t('portal.autoAction'), onAction: () => setAutoAccept(w.ssid, true) });
    } else toast(t('portal.done'));
    return;
  }
  scheduleCheck(CHECK_EVERY_MS);
}

export function closePortal() {
  if (!current) return;
  const { entry, timer, offKeyboard } = current;
  current = null;
  clearTimeout(timer);
  offKeyboard();
  typeInto(null);
  window.portalBridge?.close();
  api.del('network/portal/proxy').catch(() => {});
  document.getElementById('app').classList.remove('is-portal');
  closeLayer(entry, { animate: false });
  refreshPanel();
}

/** Accept `ssid`'s sign-in page automatically, or not. False when that failed. */
export async function setAutoAccept(ssid, on) {
  try {
    await api.put('network/portal/auto', { ssid, on });
  } catch (e) {
    toast(t('common.failed', { why: e.message }));
    return false;
  } finally {
    refreshPanel();
  }
  if (on) toast(t('portal.autoOn', { ssid }));
  return true;
}

/**
 * A toast when t6-paneld accepted a sign-in page by itself, or couldn't:
 * a new `last` in /api/panel's wifi.portal_auto. What the first reading
 * already holds happened before and isn't news.
 */
export function watchAutoAccept() {
  let seen;
  panel.changed.on(() => {
    const w = panel.data?.network?.wifi;
    const last = w?.portal_auto?.last;
    const key = last ? `${w.ssid}|${last.at}|${last.ok}|${last.why}` : '';
    if (seen === undefined) { seen = key; return; }
    if (!key || key === seen) return;
    seen = key;
    toast(last.ok ? t('wifi.autoDone', { ssid: w.ssid }) : t('wifi.autoFailedToast', { ssid: w.ssid, why: t(`wifi.autoWhy.${last.why}`) }));
  });
}

/** 重新加载: the proxy may have stopped (10 min without a request); start it again if so. */
async function reload() {
  const mine = current;
  let port;
  try {
    ({ port } = await api.post('network/portal/proxy'));
  } catch (e) {
    toast(t('portal.failed', { why: e.message }));
    return;
  }
  if (current !== mine) return;
  if (port === mine.port) { window.portalBridge.reload(); return; }
  mine.port = port;
  window.portalBridge.open(port, place(mine.node));
}

/** Open the sign-in page of the Wi-Fi network the panel is on. */
export async function openPortal() {
  if (!window.portalBridge) { toast(t('portal.panelOnly')); return; }
  closePortal();
  let port;
  try {
    ({ port } = await api.post('network/portal/proxy'));
  } catch (e) {
    toast(t('portal.failed', { why: e.message }));
    return;
  }
  const ssid = panel.data?.network?.wifi?.ssid ?? 'Wi-Fi';
  const node = el(html`<div class="t6-portal" role="dialog" aria-label="${t('portal.title', { ssid })}">
    <div class="t6-portal__bar">
      <a class="rl-backlink" href="#" data-close>${icon('caret-left')}${t('portal.close')}</a>
      <span class="t6-portal__title"><b>${ssid}</b><small data-host>${t('portal.loading')}</small></span>
      <button class="rl-btn rl-btn--secondary rl-btn--icon" data-reload aria-label="${t('portal.reload')}">${icon('arrow-clockwise')}</button>
    </div>
    <div class="t6-portal__stage"></div>
  </div>`);
  const entry = openLayer(node, closePortal);
  current = {
    entry, node, port, timer: 0, checking: false,
    offKeyboard: keyboardChanged.on(() => { if (current?.node === node) window.portalBridge.place(place(node)); }),
  };
  document.getElementById('app').classList.add('is-portal');
  on(node, 'click', '[data-close]', (e) => { e.preventDefault(); closePortal(); });
  on(node, 'click', '[data-reload]', reload);
  requestAnimationFrame(() => { if (current?.node === node) window.portalBridge.open(port, place(node)); });
  scheduleCheck(CHECK_EVERY_MS);
}
