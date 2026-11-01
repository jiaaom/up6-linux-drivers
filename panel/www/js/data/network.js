// How each connection stands, from /api/panel's network part and the
// Bluetooth and Thunderbolt stores. The 连接 tab's map and list read these
// (and 总览's 接口 module can too). No markup here.
//
// Each returns { state, short, sub, value } or null when there is no hardware:
//   state  'on' | 'wait' | 'off'   (the map's spoke and node)
//   short  the few words under the map node
//   sub    the list row's second line
//   value  the list row's value
//   tag    (instead of value) something to look at, e.g. 需要登录
// A wired or Wi-Fi link that is up but doesn't reach the internet is 'wait'.

import { t } from '../core/i18n.js';

/** 2500 → "2.5G" for the map; "2.5 Gb/s" for rows. */
export const speedShort = (mbps) => (!mbps ? '' : mbps >= 1000 ? `${+(mbps / 1000).toFixed(1)}G` : `${mbps}M`);
export const speedLong = (mbps) => (!mbps ? '' : mbps >= 1000 ? `${+(mbps / 1000).toFixed(1)} Gb/s` : `${mbps} Mb/s`);

const join = (...parts) => parts.filter(Boolean).join(' · ');

/**
 * A connected link that doesn't reach the internet, by NetworkManager's
 * connectivity check: 'portal' (a sign-in page is in the way), 'offline', or
 * '' (fine, or not known: trust the link).
 */
export function blocked(connectivity) {
  if (connectivity === 'portal') return 'portal';
  return connectivity === 'none' || connectivity === 'limited' ? 'offline' : '';
}

export function wired(net) {
  const ports = net?.ethernet_ports ?? [];
  if (!ports.length) return null;
  const up = ports.filter((p) => p.connected);
  if (!up.length) {
    return { state: 'off', short: t('net.unplugged'), sub: t(ports.length > 1 ? 'net.unpluggedAll' : 'net.unplugged'), value: t('net.notConnected') };
  }
  const fastest = up.reduce((a, b) => ((b.speed_mbps ?? 0) > (a.speed_mbps ?? 0) ? b : a));
  // a port sharing the NAS's internet has no uplink of its own to judge
  const shared = up.filter((p) => p.share?.active);
  if (shared.length === up.length) {
    const n = shared.reduce((m, p) => m + (p.share.clients ?? 0), 0);
    return { state: 'on', short: t('net.sharingShort'), sub: t('net.sharingWired', { n }), value: t('net.connected') };
  }
  // blocked only when no connected port reaches the internet
  const issues = up.filter((p) => !p.share?.active).map((p) => blocked(p.connectivity));
  const issue = issues.every(Boolean) ? (issues.includes('portal') ? 'portal' : 'offline') : '';
  if (issue) return { state: 'wait', short: t(`net.issue.${issue}`), sub: join(speedLong(fastest.speed_mbps), fastest.ip), tag: t(`net.issue.${issue}`) };
  return { state: 'on', short: speedShort(fastest.speed_mbps), sub: join(speedLong(fastest.speed_mbps), fastest.ip), value: t('net.connected') };
}

/** Wi-Fi or the hotspot: they share the card, and the map's top-right spoke. */
export function wireless(net, hotspotClients) {
  if (!net?.wireless?.wifi_available) return null;
  const h = net.hotspot ?? {};
  if (h.active) {
    const n = hotspotClients?.length;
    return { hotspot: true, state: 'on', short: n ? t('net.devices', { n }) : h.ssid, sub: '', value: '' };
  }
  const w = net.wifi ?? {};
  const issue = w.connected && blocked(w.connectivity);
  if (issue) return { state: 'wait', short: t(`net.issue.${issue}`), sub: join(w.ssid, w.ip), tag: t(`net.issue.${issue}`) };
  if (w.connected) return { state: 'on', short: w.ssid, sub: join(w.band, w.ip), value: t('net.connected') };
  if (w.enabled) return { state: 'off', short: t('net.notConnected'), sub: t('net.wifiSearching'), value: t('net.notConnected') };
  return { state: 'off', short: t('net.off'), sub: t('net.wifiOff'), value: t('net.off') };
}

export function wifiRow(net) {
  if (!net?.wireless?.wifi_available) return null;
  if (net.hotspot?.active) return { state: 'off', sub: t('net.wifiBlockedByHotspot'), value: t('net.off') };
  return wireless(net);
}

export function hotspotRow(net, clients) {
  if (!net?.wireless?.hotspot_available) return null;
  const h = net.hotspot ?? {};
  if (!h.active) return { state: 'off', sub: t('net.hotspotOff'), value: t('net.off') };
  return { state: 'on', sub: join(h.ssid, clients?.length ? t('net.devices', { n: clients.length }) : ''), value: t('net.on') };
}

export function bluetooth(bt) {
  if (!bt || !bt.adapter) return null;
  if (bt.prompt) return { state: 'wait', short: t('net.btPairing'), sub: t('net.btPairing'), value: '' };
  if (!bt.powered) return { state: 'off', short: t('net.off'), sub: t('net.btOff'), value: t('net.off') };
  const on = (bt.devices ?? []).filter((d) => d.connected);
  if (!on.length) return { state: 'off', short: t('net.on'), sub: t('net.btNone'), value: t('net.on') };
  const names = on.map((d) => d.name || d.address);
  return {
    state: 'on',
    short: on.length > 1 ? t('net.devices', { n: on.length }) : names[0],
    sub: names.join(' · '),
    value: on.length > 1 ? t('net.count', { n: on.length }) : t('net.connected'),
  };
}

export function thunderbolt(tb) {
  if (!tb?.supported) return null;
  const devices = (tb.devices ?? []).filter((d) => !d.host);
  if (devices.some((d) => d.pending)) return { state: 'wait', short: t('net.tbWaiting'), sub: t('net.tbWaitingSub'), value: '', tag: t('net.tbTag') };
  const on = devices.filter((d) => d.authorized);
  if (!on.length) return { state: 'off', short: t('net.tbNone'), sub: t('net.tbNone'), value: t('net.notConnected') };
  return {
    state: 'on',
    short: on.length > 1 ? t('net.devices', { n: on.length }) : on[0].name,
    sub: join(on.map((d) => d.name).join(' · '), speedLinkText(on[0].link)),
    value: t('net.connected'),
  };
}

/** Thunderbolt's link speed as the backend reports it ("40 Gb/s" passes through). */
export const speedLinkText = (link) => link ?? '';

/** The address people reach the NAS on: wired first, then Wi-Fi, then the hotspot's. */
export function mainAddress(net) {
  const eth = (net?.ethernet_ports ?? []).find((p) => p.connected && p.ip && !p.share?.active);
  if (eth) return { ip: eth.ip, gateway: eth.gateway, dns: eth.dns };
  if (net?.wifi?.connected) return { ip: net.wifi.ip, gateway: net.wifi.gateway, dns: net.wifi.dns };
  return null;
}
