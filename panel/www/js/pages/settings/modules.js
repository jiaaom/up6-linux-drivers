// 设置 › 总览模块: which modules 总览 shows. Each switch saves at once.

import { api } from '../../core/api.js';
import { html, on, painter } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { panel, refreshPanel } from '../../core/panel.js';
import { toast } from '../../shell/layers.js';
import { subpage } from '../../ui/page.js';
import { list, note, section, switchRow } from '../../ui/settings.js';
import { MODULES, hiddenModules } from '../overview/modules.js';

export default function modulesPage(ctx) {
  const paint = painter(ctx.el);

  function render() {
    const hidden = hiddenModules(panel.data);
    const body = html`<div class="rl-set">
      ${note(t('modules.note'))}
      ${section('modules.sec')}
      ${list(MODULES.map((m) => switchRow({
        label: t(m.label),
        subText: m.sub && t(m.sub),
        checked: !hidden.includes(m.id),
        attrs: html` data-module="${m.id}"`,
      })))}
      <div style="height:18px"></div>
    </div>`;
    paint(subpage(ctx, { slip: 'page.modules', body, hostName: panel.data?.host?.name }));
  }

  on(ctx.el, 'change', 'input[data-module]', async (e, input) => {
    const d = panel.data;
    const hidden = new Set(hiddenModules(d));
    if (input.checked) hidden.delete(input.dataset.module);
    else hidden.add(input.dataset.module);
    const body = { order: d?.dashboard?.order ?? [], hidden: [...hidden] };
    if (d) d.dashboard = body; // shown at once; the next poll confirms it
    try {
      await api.put('settings/dashboard', body);
    } catch (err) {
      toast(t('common.failed', { why: err.message }));
    }
    refreshPanel();
  });

  ctx.own(panel.changed.on(render));
  return { title: 'page.modules', render };
}
