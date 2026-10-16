// The sound outputs as settings rows: 设置 › 声音 and the control center's
// output sheet show the same list.

import { html } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { list } from './settings.js';

const KIND = {
  hdmi: { iconName: 'television-simple', tag: 'HDMI' },
  bluetooth: { iconName: 'headphones', tag: 'sound.bluetooth' },
  usb: { iconName: 'speaker-simple-high', tag: 'USB' },
};
export const kindOf = (o) => KIND[o.kind] ?? { iconName: 'speaker-high', tag: '' };
const tagText = (tag) => (tag.startsWith('sound.') ? t(tag) : tag);

/** One row per output; the current one checked. (Also the control center's output sheet.) */
export function outputRows(a) {
  return list((a.outputs || []).map((o) => {
    const k = kindOf(o);
    return html`<button class="rl-set__row${o.default ? ' is-current' : ''}" aria-pressed="${!!o.default}" data-output="${o.id}">${icon(k.iconName, 'light', 'rl-set__icon')}<span class="rl-set__label">${o.name}</span>${k.tag ? html`<span class="rl-tag">${tagText(k.tag)}</span>` : ''}${o.default ? icon('check', 'regular', 'rl-set__check') : ''}</button>`;
  }));
}
