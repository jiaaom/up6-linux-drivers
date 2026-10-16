// 连接 › 蓝牙: pair and connect headphones, speakers, keyboards and remotes
// (t6-paneld over BlueZ). Rows show only what BlueZ reports. Phones and
// computers are listed faded: the panel does not pair them.
//
// While the page is up it holds a discovery lease and reads the adapter
// often, because pairing may ask a question: a code to type on a keyboard
// (with diamonds counting the digits), a code to compare, or one to enter.

import { api } from '../../core/api.js';
import { el, html, on, painter } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import { panel } from '../../core/panel.js';
import { poller } from '../../core/resource.js';
import { bluetooth } from '../../data/stores.js';
import { closeLayer, confirm, openLayer, sheet, toast } from '../../shell/layers.js';
import { textField } from '../../ui/fields.js';
import { subpage } from '../../ui/page.js';
import { foot, list, section, switchRow } from '../../ui/settings.js';
import { busyRing } from '../../ui/states.js';

const SCAN_SECS = 60;
const KIND = {
  audio: { iconName: 'headphones', label: 'bt.kind.audio' },
  keyboard: { iconName: 'keyboard', label: 'bt.kind.keyboard' },
  remote: { iconName: 'keyboard', label: 'bt.kind.remote' },
  mouse: { iconName: 'mouse', label: 'bt.kind.mouse' },
  gamepad: { iconName: 'game-controller', label: 'bt.kind.gamepad' },
  phone: { iconName: 'device-mobile', label: 'bt.kind.phone' },
  computer: { iconName: 'laptop', label: 'bt.kind.computer' },
  other: { iconName: 'question', label: 'bt.kind.other' },
};
const kindOf = (d) => KIND[d.kind] ?? KIND.other;
const nameOf = (d) => (d.unnamed || !d.name ? d.address : d.name);

function deviceSub(d) {
  if (d.unnamed || !d.name) return t('bt.unnamed');
  return [t(kindOf(d).label), d.battery != null ? t('bt.battery', { n: d.battery }) : ''].filter(Boolean).join(' · ');
}

function pairedRow(d) {
  return html`<a class="rl-set__row" href="#" data-device="${d.address}">${icon(kindOf(d).iconName, 'light', 'rl-set__icon')}<span class="rl-set__label">${nameOf(d)}<span class="rl-set__sub">${deviceSub(d)}</span></span><span class="rl-set__value">${t(d.connected ? 'net.connected' : 'net.notConnected')}</span>${icon('caret-right', 'regular', 'rl-set__go')}</a>`;
}

function nearbyRow(d, pairing) {
  if (!d.supported) {
    const why = d.kind === 'phone' || d.kind === 'computer' ? 'bt.unsupported' : 'bt.unsupportedOther';
    return html`<div class="rl-set__row rl-set__row--off">${icon(kindOf(d).iconName, 'light', 'rl-set__icon')}<span class="rl-set__label">${nameOf(d)}<span class="rl-set__sub">${t(why)}</span></span></div>`;
  }
  return html`<a class="rl-set__row" href="#" data-pair="${d.address}">${icon(kindOf(d).iconName, 'light', 'rl-set__icon')}<span class="rl-set__label">${nameOf(d)}<span class="rl-set__sub">${deviceSub(d)}</span></span><span class="rl-set__value">${pairing === d.address ? t('bt.pairing') : t('bt.pair')}</span></a>`;
}

// ---------- the pairing question ----------

let ask = null; // { id, entry, node }

function digits(code, entered) {
  const n = (code ?? '').length || 6;
  const dots = Array.from({ length: n }, (_, i) => html`<span${i < (entered ?? 0) ? html` class="is-on"` : ''}></span>`);
  return html`${dots}${t('bt.typed', { n: entered ?? 0 })}`;
}

const spaced = (code) => (code ?? '').replace(/^(\d{3})(\d{3})$/, '$1 $2');

function closeAsk() {
  if (!ask) return;
  closeLayer(ask.entry);
  ask = null;
}

async function answer(p, accept, passkey) {
  closeAsk();
  try {
    await api.post('bluetooth/prompt', { id: p.id, accept, passkey });
  } catch (e) {
    toast(t('common.failed', { why: e.message }));
  }
  bluetooth.refresh();
}

/** Show (or update) the question BlueZ's agent is asking, or close it when it is gone. */
function showPrompt(bt) {
  const p = bt?.prompt;
  if (!p) { closeAsk(); return; }
  const device = (bt.devices ?? []).find((d) => d.address === p.address);
  const name = device ? nameOf(device) : p.address;
  if (ask?.id === p.id) {
    const progress = ask.node.querySelector('.rl-dialog__progress');
    if (progress) progress.innerHTML = String(digits(p.code, p.entered));
    return;
  }
  closeAsk();
  let body;
  let content;
  let actions;
  if (p.kind === 'type') {
    body = t('bt.typeBody');
    content = html`<p class="rl-dialog__code" aria-label="${t('bt.code', { code: p.code })}">${spaced(p.code)}</p><p class="rl-dialog__progress" aria-live="polite">${digits(p.code, p.entered)}</p>`;
    actions = html`<button class="rl-btn rl-btn--secondary" data-no>${t('common.cancel')}</button>`;
  } else if (p.kind === 'confirm') {
    body = t('bt.confirmBody', { name });
    content = html`<p class="rl-dialog__code" aria-label="${t('bt.code', { code: p.code })}">${spaced(p.code)}</p>`;
    actions = html`<button class="rl-btn rl-btn--secondary" data-no>${t('common.cancel')}</button><button class="rl-btn rl-btn--primary" data-yes>${t('bt.pair')}</button>`;
  } else {
    body = t('bt.enterBody', { name });
    content = textField({ id: 't6-bt-code', label: t('bt.codeLabel') });
    actions = html`<button class="rl-btn rl-btn--secondary" data-no>${t('common.cancel')}</button><button class="rl-btn rl-btn--primary" data-yes>${t('bt.pair')}</button>`;
  }
  const node = el(html`<div class="rl-overlay ${p.kind === 'enter' ? 'rl-overlay--top' : 'rl-overlay--center'}">
    <div class="rl-scrim"></div>
    <div class="rl-dialog" role="alertdialog" aria-modal="true" aria-label="${t('bt.pairTitle', { name })}">
      <h2 class="rl-dialog__title">${t('bt.pairTitle', { name })}</h2>
      <p class="rl-dialog__body">${body}</p>
      ${content}
      <div class="rl-dialog__actions">${actions}</div>
    </div>
  </div>`);
  const entry = openLayer(node, () => answer(p, false));
  ask = { id: p.id, entry, node };
  on(node, 'click', '[data-no]', () => answer(p, false));
  on(node, 'click', '[data-yes]', () => {
    const typed = node.querySelector('#t6-bt-code')?.value.trim();
    answer(p, true, typed ? +typed : undefined);
  });
  node.querySelector('#t6-bt-code')?.focus();
}

// ---------- the page ----------

export default function bluetoothPage(ctx) {
  const paint = painter(ctx.el);
  const live = poller(bluetooth, 1500);
  let leaseTimer = 0;
  let pairing = null; // address being paired

  const lease = (secs) => api.post('bluetooth/scan', { secs }).catch(() => {});

  function render() {
    const bt = bluetooth.data;
    const on = !!bt?.powered;
    const devices = bt?.devices ?? [];
    const paired = devices.filter((d) => d.paired);
    // nameless devices the panel can't use anyway are only noise
    const nearby = devices.filter((d) => !d.paired && (d.supported || !(d.unnamed || !d.name)))
      .sort((a, b) => Number(b.supported) - Number(a.supported));
    const host = panel.data?.host?.name ?? '';
    const body = html`<div class="rl-set">
      <ul class="rl-set__list" style="margin-top:6px"><li>${switchRow({ label: t('net.bluetooth'), subText: t('bt.switchSub', { host }), checked: on, disabled: bt && !bt.adapter, attrs: html` data-power` })}</li></ul>
      ${on && paired.length ? html`${section('bt.secPaired')}${list(paired.map(pairedRow))}` : ''}
      ${on ? html`${section('bt.secNearby', bt?.scanning ? busyRing(t('wifi.scanning')) : '')}
        ${nearby.length ? list(nearby.map((d) => nearbyRow(d, pairing))) : html`<p class="rl-set__note" style="padding:10px 0 4px">${t('bt.searching')}</p>`}` : ''}
      ${foot(t('bt.foot'), 'margin-bottom:18px')}
    </div>`;
    paint(subpage(ctx, { slip: 'page.bluetooth', body, hostName: host }));
    showPrompt(bt);
  }

  async function pair(address) {
    pairing = address;
    render();
    try {
      await api.post(`bluetooth/device/${address}/pair`);
      toast(t('bt.paired'));
    } catch (e) {
      toast(t('bt.pairFailed', { why: e.message }));
    }
    pairing = null;
    bluetooth.refresh();
  }

  async function manage(d) {
    const actions = [
      d.connected
        ? { id: 'disconnect', icon: 'plugs', label: t('bt.disconnect') }
        : { id: 'connect', icon: 'plugs-connected', label: t('bt.connect') },
      d.kind === 'audio' && d.connected && { id: 'audio', icon: 'speaker-high', label: t('bt.useForSound') },
      { id: 'forget', icon: 'trash', label: t('bt.forget'), danger: true },
    ].filter(Boolean);
    const id = await sheet({ title: nameOf(d), sub: deviceSub(d), actions });
    if (!id) return;
    if (id === 'forget' && !(await confirm({ title: t('bt.forgetTitle', { name: nameOf(d) }), body: t('bt.forgetBody'), action: t('bt.forget'), kind: 'danger' }))) return;
    const path = `bluetooth/device/${d.address}`;
    try {
      if (id === 'forget') await api.del(path);
      else await api.post(`${path}/${id}`);
    } catch (e) {
      toast(t('common.failed', { why: e.message }));
    }
    bluetooth.refresh();
  }

  on(ctx.el, 'change', 'input[data-power]', async (e, input) => {
    try {
      await api.put('bluetooth/power', { on: input.checked });
      if (input.checked) lease(SCAN_SECS);
    } catch (err) {
      input.checked = !input.checked;
      toast(t('common.failed', { why: err.message }));
    }
    bluetooth.refresh();
  });
  on(ctx.el, 'click', '[data-pair]', (e, a) => { e.preventDefault(); if (!pairing) pair(a.dataset.pair); });
  on(ctx.el, 'click', '[data-device]', (e, a) => {
    e.preventDefault();
    const d = (bluetooth.data?.devices ?? []).find((x) => x.address === a.dataset.device);
    if (d) manage(d);
  });

  ctx.own(bluetooth.changed.on(render));
  ctx.own(closeAsk);
  return {
    title: 'page.bluetooth',
    render,
    show() {
      live.start();
      lease(SCAN_SECS);
      leaseTimer = setInterval(() => lease(SCAN_SECS), (SCAN_SECS - 10) * 1000);
    },
    hide() {
      live.stop();
      clearInterval(leaseTimer);
      lease(0);
    },
  };
}
