// 设置 › 指示灯 › 灯效: what the tray light does. One colour breathes, two
// take turns, all three make a rainbow. Choosing one applies it and goes back.

import { api } from '../../core/api.js';
import { html, on } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import { toast } from '../../shell/layers.js';
import { back } from '../../shell/router.js';
import { resourceSubpage } from '../../ui/page.js';
import { foot, list, section } from '../../ui/settings.js';
import { leds } from '../../data/stores.js';

export const TRAY_EFFECTS = [
  { id: 'off', label: 'tray.off' },
  { id: 'red', label: 'tray.red' },
  { id: 'green', label: 'tray.green' },
  { id: 'blue', label: 'tray.blue' },
  { id: 'yellow', label: 'tray.yellow' },
  { id: 'cyan', label: 'tray.cyan' },
  { id: 'magenta', label: 'tray.magenta' },
  { id: 'white', label: 'tray.white' },
];

/** The tray light's effect id (a colour, or off). */
export function trayEffect(s) {
  const rgb = (s.devices || []).find((d) => d.id === 'rgb');
  return rgb?.mode === 'manual' && rgb.color ? rgb.color : 'off';
}

function body(s) {
  const current = trayEffect(s);
  return html`
    ${section('tray.sec')}
    ${list(TRAY_EFFECTS.map((e) => html`<button class="rl-set__row${e.id === current ? ' is-current' : ''}" aria-pressed="${e.id === current}" data-effect="${e.id}"><span class="rl-set__label">${t(e.label)}</span>${e.id === current ? icon('check', 'regular', 'rl-set__check') : ''}</button>`))}
    ${foot(t('tray.foot'), 'margin-bottom:18px')}`;
}

export default function trayEffectPage(ctx) {
  const page = resourceSubpage(ctx, { slip: 'page.trayEffect', res: leds, body });
  on(ctx.el, 'click', '[data-effect]', async (e, btn) => {
    try {
      await api.put('leds/rgb', { value: btn.dataset.effect });
      await leds.refresh();
      back();
    } catch (err) {
      toast(t('common.failed', { why: err.message }));
    }
  });
  return { title: 'page.trayEffect', render: page.render };
}
