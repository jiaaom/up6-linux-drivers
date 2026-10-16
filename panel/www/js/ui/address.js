// An IPv4 address as Ridgeline fact rows (rl-kv--set), or as underlined
// inputs (rl-kv__input) when set by hand: 有线 ports and Thunderbolt links.

import { html } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export const maskOf = (prefix) => (prefix == null ? null
  : [0, 8, 16, 24].map((s) => (((0xffffffff << (32 - prefix)) >>> 0) >>> (24 - s)) & 255).join('.'));
export function prefixOf(mask) {
  if (!IPV4.test(mask)) return null;
  const bits = mask.split('.').map((n) => (+n).toString(2).padStart(8, '0')).join('');
  return /^1*0*$/.test(bits) ? bits.indexOf('0') === -1 ? 32 : bits.indexOf('0') : null;
}

/** IP, mask, gateway and DNS as fact rows, or as inputs when `edit`. */
export function addressRows(a, edit) {
  const rows = [
    { key: 'ip', iconName: 'map-pin', label: t('wired.ip'), value: a.ip, hint: t('wired.ipHint') },
    { key: 'mask', iconName: 'grid-four', label: t('wired.mask'), value: a.mask, hint: '255.255.255.0' },
    { key: 'gateway', iconName: 'signpost', label: t('wired.gateway'), value: a.gateway, hint: t('wired.optional') },
    { key: 'dns', iconName: 'address-book', label: 'DNS', value: a.dns, hint: t('wired.optional') },
  ];
  return html`<ul class="rl-kv rl-kv--set">${rows.map((r) => html`<li><span>${icon(r.iconName)}${r.label}</span>${edit
    ? html`<input class="rl-kv__input" data-field="${r.key}" value="${r.value ?? ''}" placeholder="${r.hint}" inputmode="decimal" aria-label="${r.label}">`
    : html`<b>${r.value || '—'}</b>`}</li>`)}</ul>`;
}

/** What the inputs hold, as the backend's body, or an error message. */
export function readAddress(root) {
  const v = (k) => root.querySelector(`[data-field="${k}"]`)?.value.trim() ?? '';
  const ip = v('ip');
  const prefix = prefixOf(v('mask') || '255.255.255.0');
  const gateway = v('gateway');
  const dns = v('dns').split(/[\s,·]+/).filter(Boolean);
  if (!IPV4.test(ip)) return { error: t('wired.badIp') };
  if (prefix == null) return { error: t('wired.badMask') };
  if (gateway && !IPV4.test(gateway)) return { error: t('wired.badGateway') };
  if (dns.some((d) => !IPV4.test(d))) return { error: t('wired.badDns') };
  return { body: { method: 'manual', address: `${ip}/${prefix}`, gateway: gateway || null, dns } };
}
