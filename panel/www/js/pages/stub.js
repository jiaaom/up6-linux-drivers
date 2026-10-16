// A placeholder for a tab whose pages have not moved to the new UI yet.
// It also exercises the shell: a button opens a page one level down.

import { html, on } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { panel } from '../core/panel.js';
import { push } from '../shell/router.js';
import { backdrop, hostbar, pagebar, titledPanel } from '../ui/page.js';
import { empty } from '../ui/states.js';

export function stubPage(ctx, titleId) {
  on(ctx.el, 'click', '[data-child]', () => push((c) => stubPage(c, 'page.stubChild')));
  return {
    title: titleId,
    render() {
      const bar = ctx.parent
        ? pagebar({ back: ctx.parent })
        : hostbar(panel.data?.host?.name);
      ctx.el.innerHTML = String(html`${backdrop()}${bar}${titledPanel({
        slip: titleId,
        body: empty({
          iconName: 'folder-simple-dashed',
          title: t('stub.title'),
          body: t('stub.body'),
          action: html`<button class="rl-btn rl-btn--secondary" data-child>${t('stub.child')}</button>`,
        }),
      })}`);
    },
  };
}
