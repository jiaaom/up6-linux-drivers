// 总览 › 通知: fnOS's notifications, grouped by day (今天, 昨天, 更早). A mark
// leads each row: a hollow diamond for information, an ochre one for a
// warning, a rust icon for anything that needs action. Unread titles are
// bold. They come from fnOS, so they need a sign-in.

import { api } from '../../core/api.js';
import { html, on, painter } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { dayGroup, when } from '../../core/format.js';
import { t } from '../../core/i18n.js';
import { panel } from '../../core/panel.js';
import { poller } from '../../core/resource.js';
import { account, notices } from '../../data/stores.js';
import { toast } from '../../shell/layers.js';
import { lazy, push } from '../../shell/router.js';
import { subpage } from '../../ui/page.js';
import { empty, loadFailed, skeletonRows } from '../../ui/states.js';

const ACCOUNT = lazy(() => import('../settings/account.js'));
const GROUPS = ['today', 'yesterday', 'earlier'];

function mark(level) {
  if (level >= 2) return icon('warning-circle', 'regular', 'rl-note-lv rl-note-lv--err');
  return html`<span class="rl-note-lv" data-level="${level === 1 ? 'warn' : 'info'}"></span>`;
}

function row(n) {
  return html`<div class="rl-set__row ${n.read ? 'is-read' : 'is-unread'}">${mark(n.level)}<span class="rl-set__label">${n.title}<span class="rl-set__sub">${n.content}</span></span><span class="rl-set__time">${when(n.datetime)}</span></div>`;
}

export default function noticesPage(ctx) {
  const paint = painter(ctx.el);
  const live = poller(notices, 15000);

  function render() {
    const signedIn = account.data?.signedIn;
    const n = notices.data;
    let head = '';
    let body;
    if (account.data && !signedIn) {
      body = html`<div style="padding:32px 0">${empty({
        iconName: 'bell',
        title: t('notices.signIn'),
        body: t('notices.signInBody'),
        action: html`<button class="rl-btn rl-btn--primary" data-sign-in>${t('account.signIn')}</button>`,
      })}</div>`;
    } else if (!n) {
      body = notices.status === 'failed' ? loadFailed() : skeletonRows(5);
    } else {
      head = html`<div class="rl-toolbar"><span class="rl-board__updated" style="margin-left:0">${n.unread ? t('notices.unread', { n: n.unread }) : t('notices.allRead')}</span>${n.unread ? html`<button class="rl-textbtn rl-textbtn--ink" style="margin-left:auto" data-read-all>${t('notices.readAll')}</button>` : ''}</div>`;
      const by = Object.fromEntries(GROUPS.map((g) => [g, []]));
      for (const item of n.items ?? []) by[dayGroup(item.datetime)].push(item);
      body = (n.items ?? []).length
        ? html`<div class="rl-set" style="padding-bottom:18px">${GROUPS.filter((g) => by[g].length).map((g) => html`<h2 class="rl-set__sec">${t(`notices.${g}`)}</h2><ul class="rl-set__list">${by[g].map((x) => html`<li>${row(x)}</li>`)}</ul>`)}</div>`
        : html`<div style="padding:32px 0">${empty({ iconName: 'bell', title: t('notices.none'), body: t('notices.noneBody') })}</div>`;
    }
    paint(subpage(ctx, { slip: 'page.notices', head, body, hostName: panel.data?.host?.name }));
  }

  on(ctx.el, 'click', '[data-sign-in]', () => push(ACCOUNT));
  on(ctx.el, 'click', '[data-read-all]', async () => {
    try {
      await api.post('fnos/notifications/read-all');
    } catch (e) {
      toast(t('common.failed', { why: e.message }));
    }
    notices.refresh();
  });
  on(ctx.el, 'click', '[data-retry]', () => notices.refresh());

  ctx.own(notices.changed.on(render));
  ctx.own(account.changed.on(render));
  return {
    title: 'page.notices',
    render,
    show() { account.refresh(); live.start(); },
    hide: live.stop,
  };
}
