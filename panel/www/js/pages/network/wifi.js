// 连接 › Wi-Fi: the radio, the network it is on, and the ones nearby.
// A protected network asks for its password in a dialog above the keyboard;
// an enterprise (802.1X) one for a user name and password, with 认证方式.
// Wi-Fi and the hotspot share the card: turning Wi-Fi on stops the hotspot.

import { api, request } from '../../core/api.js';
import { html, on, painter } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import { panel, refreshPanel } from '../../core/panel.js';
import { poller } from '../../core/resource.js';
import { blocked } from '../../data/network.js';
import { openPortal, setAutoAccept } from './portal.js';
import { wifiScan } from '../../data/stores.js';
import { confirm, sheet, toast } from '../../shell/layers.js';
import { signalIcon } from '../../shell/statusbar.js';
import { errorLine, passwordField, textField, wireReveal } from '../../ui/fields.js';
import { subpage } from '../../ui/page.js';
import { foot, list, section, switchRow } from '../../ui/settings.js';
import { busyRing } from '../../ui/states.js';

const EAP_METHODS = [
  { eap: 'peap', phase2: 'mschapv2', label: 'PEAP · MSCHAPv2' },
  { eap: 'ttls', phase2: 'mschapv2', label: 'TTLS · MSCHAPv2' },
  { eap: 'ttls', phase2: 'pap', label: 'TTLS · PAP' },
];

const enterprise = (ap) => /802\.1X/i.test(ap.security ?? '');
const secured = (ap) => !!ap.security;
const signal = (n) => signalIcon(n ?? 0, t('wifi.signal', { n: n ?? 0 }));

function apRow(ap, sub) {
  return html`<a class="rl-set__row" href="#" data-ssid="${ap.ssid}">${signal(ap.signal)}<span class="rl-set__label">${ap.ssid}${sub ? html`<span class="rl-set__sub">${sub}</span>` : ''}</span>${secured(ap) ? icon('lock-simple', 'regular', 'rl-set__lock') : ''}${icon('caret-right', 'regular', 'rl-set__go')}</a>`;
}

function nearbySub(ap) {
  if (enterprise(ap)) return t('wifi.enterprise');
  if (!secured(ap)) return t('wifi.open');
  if (ap.saved) return t('wifi.saved');
  return '';
}

/** The password dialog for a protected network; resolves when joined or cancelled. */
function joinDialog(ap) {
  return confirm({
    title: t('wifi.join'),
    body: t('wifi.joinBody', { ssid: ap.ssid }),
    action: t('wifi.joinAction'),
    top: true,
    content: html`${passwordField({ id: 't6-wifi-pass', label: t('account.password') })}${errorLine()}`,
    onOpen(node) { wireReveal(node); node.querySelector('#t6-wifi-pass').focus(); },
    async check(node, btn) {
      const password = node.querySelector('#t6-wifi-pass').value;
      if (password.length < 8) return t('wifi.shortPassword');
      btn.textContent = t('wifi.joining');
      try {
        await api.post('network/wifi/connect', { ssid: ap.ssid, password });
        return '';
      } catch (e) {
        btn.textContent = t('wifi.joinAction');
        return e.unreachable ? t('account.noAnswer') : t('wifi.joinFailed');
      }
    },
  });
}

/** A hidden network: its name and password. */
function otherDialog() {
  return confirm({
    title: t('wifi.other'),
    body: t('wifi.otherBody'),
    action: t('wifi.joinAction'),
    top: true,
    content: html`${textField({ id: 't6-wifi-ssid', label: t('wifi.name') })}${passwordField({ id: 't6-wifi-pass', label: t('wifi.passwordOptional') })}${errorLine()}`,
    onOpen(node) { wireReveal(node); node.querySelector('#t6-wifi-ssid').focus(); },
    async check(node) {
      const ssid = node.querySelector('#t6-wifi-ssid').value.trim();
      const password = node.querySelector('#t6-wifi-pass').value;
      if (!ssid) return t('wifi.needName');
      if (password && password.length < 8) return t('wifi.shortPassword');
      try {
        await api.post('network/wifi/connect', { ssid, password });
        return '';
      } catch (e) {
        return e.unreachable ? t('account.noAnswer') : t('wifi.joinFailed');
      }
    },
  });
}

/** An enterprise network: user name, password and how it signs in. */
function enterpriseDialog(ap) {
  let method = EAP_METHODS[0];
  return confirm({
    title: t('wifi.join'),
    body: t('wifi.enterpriseBody', { ssid: ap.ssid }),
    action: t('wifi.joinAction'),
    top: true,
    content: html`${textField({ id: 't6-eap-user', label: t('account.user') })}${passwordField({ id: 't6-eap-pass', label: t('account.password') })}
      <button class="rl-sortbtn rl-dialog__more" type="button" data-eap>${t('wifi.eap', { method: method.label })}${icon('caret-down')}</button>${errorLine()}`,
    onOpen(node) {
      wireReveal(node);
      node.querySelector('#t6-eap-user').focus();
      on(node, 'click', '[data-eap]', async (e, b) => {
        const id = await sheet({ title: t('wifi.eapTitle'), actions: EAP_METHODS.map((m, i) => ({ id: String(i), icon: m === method ? 'check-square' : 'lock-simple', label: m.label })) });
        if (id == null) return;
        method = EAP_METHODS[+id];
        b.firstChild.textContent = t('wifi.eap', { method: method.label });
      });
    },
    async check(node) {
      const identity = node.querySelector('#t6-eap-user').value.trim();
      const password = node.querySelector('#t6-eap-pass').value;
      if (!identity || !password) return t('account.missing');
      try {
        await api.post('network/wifi/connect', { ssid: ap.ssid, identity, password, eap: method.eap, phase2: method.phase2 });
        return '';
      } catch (e) {
        return e.unreachable ? t('account.noAnswer') : t('wifi.joinFailed');
      }
    },
  });
}

/** The connected network's second line: what is wrong, else band and address. */
function connectedSub(w) {
  const issue = blocked(w.connectivity);
  return issue ? t(`wifi.${issue}Sub`) : [w.band, w.ip].filter(Boolean).join(' · ');
}

/** Under a network that doesn't reach the internet: open its sign-in page. */
function portalRow(w) {
  const issue = blocked(w.connectivity);
  if (!issue) return null;
  return html`<a class="rl-set__row" href="#" data-portal>${icon('globe-hemisphere-west', 'light', 'rl-set__icon')}<span class="rl-set__label">${t('wifi.openPortal')}<span class="rl-set__sub">${t(issue === 'portal' ? 'wifi.openPortalSub' : 'wifi.openPortalMaybe')}</span></span>${icon('caret-right', 'regular', 'rl-set__go')}</a>`;
}

/** 自动确认登录页, for a network whose sign-in page t6-paneld recognised as one tap. */
function autoRow(w) {
  const a = w.portal_auto;
  if (!a?.supported) return null;
  const last = a.last;
  let sub = t(a.on ? 'wifi.autoOnSub' : 'wifi.autoOffSub');
  if (a.on && last) sub = last.ok ? t('wifi.autoLast', { at: last.at }) : t('wifi.autoFailed', { at: last.at, why: t(`wifi.autoWhy.${last.why}`) });
  return switchRow({ label: t('wifi.autoAccept'), subText: sub, checked: a.on, attrs: html` data-autoaccept` });
}

export default function wifiPage(ctx) {
  const paint = painter(ctx.el);
  const scan = poller(wifiScan, 12000);

  function render() {
    const d = panel.data ?? {};
    const w = d.network?.wifi ?? {};
    const hotspotOn = d.network?.hotspot?.active;
    const on = w.enabled && !hotspotOn;
    const aps = wifiScan.data ?? [];
    const current = aps.find((a) => a.in_use) ?? (w.connected ? { ssid: w.ssid, signal: w.signal, security: w.security } : null);
    const nearby = aps.filter((a) => !a.in_use && a.ssid);
    const scanning = wifiScan.status === 'loading' || wifiScan.status === 'refreshing';
    const body = html`<div class="rl-set">
      <ul class="rl-set__list" style="margin-top:6px"><li>${switchRow({ label: 'Wi-Fi', subText: t('wifi.switchSub'), checked: on, attrs: html` data-radio` })}</li></ul>
      ${on && w.connected && current ? html`${section('wifi.secConnected')}${list([apRow(current, connectedSub(w)), portalRow(w), autoRow(w)])}` : ''}
      ${on ? html`${section('wifi.secNearby', scanning ? busyRing(t('wifi.scanning')) : '')}
        ${list([
          ...nearby.map((ap) => apRow(ap, nearbySub(ap))),
          html`<a class="rl-set__row" href="#" data-other>${icon('plus', 'light', 'rl-set__icon')}<span class="rl-set__label">${t('wifi.other')}<span class="rl-set__sub">${t('wifi.otherSub')}</span></span>${icon('caret-right', 'regular', 'rl-set__go')}</a>`,
        ])}` : ''}
      ${hotspotOn ? html`<p class="rl-set__note" style="padding-top:12px">${t('wifi.hotspotOn')}</p>` : ''}
      ${foot(t('wifi.foot'), 'margin-bottom:18px')}
    </div>`;
    paint(subpage(ctx, { slip: 'page.wifi', body, hostName: d.host?.name }));
  }

  async function setRadio(input) {
    const want = input.checked;
    const net = panel.data?.network ?? {};
    if (want && net.hotspot?.active) {
      input.checked = false;
      if (!(await confirm({ title: t('cc.wifiOverHotspot'), body: t('cc.wifiOverHotspotBody'), action: t('cc.wifiOverHotspotAction') }))) return;
      input.checked = true;
      await api.post('network/hotspot', { enabled: false }).catch(() => {});
    }
    try {
      await api.put('network/wifi/radio', { on: want });
    } catch (e) {
      input.checked = !want;
      toast(t('common.failed', { why: e.message }));
    }
    refreshPanel();
    if (want) setTimeout(() => wifiScan.refresh(), 2500);
  }

  async function connected(ap) {
    const w = panel.data?.network?.wifi ?? {};
    const id = await sheet({
      title: ap.ssid,
      sub: [w.band, w.ip, w.rate].filter(Boolean).join(' · '),
      actions: [
        ...(blocked(w.connectivity) ? [
          { id: 'portal', icon: 'globe-hemisphere-west', label: t('wifi.openPortal') },
          { id: 'check', icon: 'arrows-clockwise', label: t('wifi.check') },
        ] : []),
        { id: 'disconnect', icon: 'wifi-slash', label: t('wifi.disconnect') },
        { id: 'forget', icon: 'trash', label: t('wifi.forget'), danger: true },
      ],
    });
    if (id === 'portal') { openPortal(); return; }
    if (id === 'check') {
      try {
        // NetworkManager waits for the probe page, up to some 20 s on a bad network
        const r = await request('network/connectivity/check', { method: 'POST', timeout: 30000 });
        const issue = blocked(r.wifi);
        toast(t(issue ? `wifi.check${issue === 'portal' ? 'Portal' : 'Offline'}` : 'wifi.checkOk'));
      } catch (e) {
        toast(t('wifi.checkFailed', { why: e.message }));
      }
    }
    if (id === 'disconnect') await api.post('network/wifi/disconnect').catch((e) => toast(t('common.failed', { why: e.message })));
    if (id === 'forget') {
      if (!(await confirm({ title: t('wifi.forgetTitle', { ssid: ap.ssid }), body: t('wifi.forgetBody'), action: t('wifi.forget'), kind: 'danger' }))) return;
      await api.post('network/wifi/forget', { ssid: ap.ssid }).catch((e) => toast(t('common.failed', { why: e.message })));
    }
    refreshPanel();
    wifiScan.refresh();
  }

  async function choose(ap) {
    if (ap.in_use) { connected(ap); return; }
    let joined;
    if (ap.saved || !secured(ap)) {
      toast(t('wifi.joiningName', { ssid: ap.ssid }));
      joined = await api.post('network/wifi/connect', { ssid: ap.ssid }).then(() => true, () => { toast(t('wifi.joinFailed')); return false; });
    } else if (enterprise(ap)) joined = await enterpriseDialog(ap);
    else joined = await joinDialog(ap);
    if (joined) { toast(t('wifi.joined', { ssid: ap.ssid })); refreshPanel(); wifiScan.refresh(); }
  }

  on(ctx.el, 'change', 'input[data-radio]', (e, input) => setRadio(input));
  on(ctx.el, 'click', '[data-ssid]', (e, a) => {
    e.preventDefault();
    const ap = (wifiScan.data ?? []).find((x) => x.ssid === a.dataset.ssid)
      ?? { ssid: a.dataset.ssid, in_use: true };
    choose(ap);
  });
  on(ctx.el, 'click', '[data-portal]', (e) => { e.preventDefault(); openPortal(); });
  on(ctx.el, 'change', 'input[data-autoaccept]', async (e, input) => {
    const ssid = panel.data?.network?.wifi?.ssid;
    if (!ssid || !(await setAutoAccept(ssid, input.checked))) input.checked = !input.checked;
  });
  on(ctx.el, 'click', '[data-other]', async (e) => {
    e.preventDefault();
    if (await otherDialog()) { refreshPanel(); wifiScan.refresh(); }
  });

  ctx.own(panel.changed.on(render));
  ctx.own(wifiScan.changed.on(render));
  return { title: 'page.wifi', render, show: scan.start, hide: scan.stop };
}

