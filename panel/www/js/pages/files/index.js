// 文件 — the second tab's landing page: where files live (位置), the last
// three opened (最近), and the drives (设备). Opening a place or a drive goes
// one level down into a folder page. Signed out, the places give way to a
// sign-in prompt; the drives stay (storage pools are read locally) and open
// their 存储池 page instead.

import { api } from '../../core/api.js';
import { html, on, painter } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { size, when } from '../../core/format.js';
import { slipText, t } from '../../core/i18n.js';
import { panel } from '../../core/panel.js';
import { poller, resource } from '../../core/resource.js';
import { favourites, loadFavourites, recents } from '../../data/files.js';
import { account, pools } from '../../data/stores.js';
import { layoutLabel } from '../../data/pools.js';
import { healthIssues } from '../../data/health.js';
import { userForgotten } from '../../data/session.js';
import { confirm, sheet, toast } from '../../shell/layers.js';
import { lazy, push } from '../../shell/router.js';
import { ficon } from '../../ui/files.js';
import { backdrop, hostbar, titledPanel } from '../../ui/page.js';
import { section } from '../../ui/settings.js';
import { empty } from '../../ui/states.js';
import { failed, openFile } from './actions.js';
import folderPage from './folder.js';
import { trashList } from './trash.js';
import { slipHead, wireSlipTabs } from './tabs.js';

const ACCOUNT = lazy(() => import('../settings/account.js'));
const TRASH = lazy(() => import('./trash.js'));
const POOL = lazy(() => import('../overview/storage.js'));

const externals = resource('externals', () => api.get('fnos/externals'), { persist: false });
const home = resource('homeCount', () => api.get('fnos/files').then((d) => (d.files ?? []).filter((f) => !f.name.startsWith('.')).length), { persist: false });
const team = resource('teamCount', () => api.get('fnos/team-files').then((d) => (d.files ?? []).length), { persist: false });
// they belong to the person signed in
userForgotten.on(() => [externals, home, team].forEach((r) => r.reset()));

function placeRow(id, lead, label, sub) {
  return html`<li><a class="rl-set__row" href="#" data-place="${id}">${lead}<span class="rl-set__label">${label}${sub ? html`<span class="rl-set__sub">${sub}</span>` : ''}</span>${icon('caret-right', 'regular', 'rl-set__go')}</a></li>`;
}

// a row's icon on a pigment wash: azurite for your own places, indigo for
// shared ones and drives, muted for the bin
const well = (name, tone) => html`<span class="rl-set__well"${tone ? html` data-tone="${tone}"` : ''}>${icon(name, 'light', 'rl-set__icon')}</span>`;

function places() {
  const trash = trashList.data;
  return html`${section('files.secPlaces')}<ul class="rl-set__list">
    ${placeRow('home', well('folder-user'), t('files.home'), home.data != null ? t('files.count', { n: home.data }) : '')}
    ${placeRow('team', well('users-three', 'indigo'), t('files.team'), team.data != null ? t('files.teamCount', { n: team.data }) : '')}
    ${placeRow('fav', html`<span class="rl-seal rl-seal--bai rl-seal--sm rl-set__seal" role="img" aria-label="${t('files.fav')}"><span class="rl-seal__text">藏</span></span>`, t('files.favs'), favourites.set.size ? t('files.count', { n: favourites.set.size }) : '')}
    ${placeRow('trash', well('trash', 'muted'), t('page.trash'), trash ? (trash.length ? t('files.count', { n: trash.length }) : t('trash.empty')) : '')}
  </ul>`;
}

function recent() {
  const list = recents.list().slice(0, 3);
  if (!list.length) return '';
  return html`${section('files.secRecent')}<ul class="rl-set__list">${list.map((x, i) => html`<li><a class="rl-set__row rl-set__row--file" href="#" data-recent="${i}"><span class="rl-toc__lead">${ficon(x)}</span><span class="rl-set__label">${x.name}<span class="rl-set__sub">${[x.path.split('/').slice(-2, -1)[0], when(x.at)].filter(Boolean).join(' · ')}</span></span></a></li>`)}</ul>`;
}

function devices(signedIn) {
  const rows = [];
  for (const p of pools.data ?? []) {
    const pct = p.total_bytes ? Math.round((p.used_bytes / p.total_bytes) * 100) : 0;
    rows.push(html`<li><div class="rl-set__row rl-set__row--split"><a class="rl-set__main" href="#" data-pool="${rows.length}">${well('hard-drives', 'indigo')}<span class="rl-set__label">${p.name}<span class="rl-set__sub">${size(p.used_bytes)} / ${size(p.total_bytes)} · ${layoutLabel(p)}</span><span class="rl-meter__track rl-set__meter" style="--v:${pct}"></span></span></a>${icon('caret-right', 'regular', 'rl-set__go')}</div></li>`);
  }
  if (signedIn) {
    for (const d of externals.data?.disks ?? []) {
      const parts = d.parts.filter((x) => x.mounted && x.fssize);
      const free = parts.reduce((s, x) => s + (x.frsize ?? 0), 0);
      const total = parts.reduce((s, x) => s + (x.fssize ?? 0), 0);
      const pct = total ? Math.round(((total - free) / total) * 100) : 0;
      const what = html`${well('usb', 'indigo')}<span class="rl-set__label">${d.model}<span class="rl-set__sub">${size(d.size)}${total ? ` · ${t('files.freeOf', { free: size(free) })}` : ''}</span>${total ? html`<span class="rl-meter__track rl-set__meter" style="--v:${pct}"></span>` : ''}</span>`;
      // mounted, the drive opens (the link takes the row, 弹出 stays its own button)
      rows.push(html`<li><div class="rl-set__row rl-set__row--split">${d.mounted && parts.length ? html`<a class="rl-set__main" href="#" data-usb="${d.name}">${what}</a>` : html`<span class="rl-set__main">${what}</span>`}
        <button class="rl-btn rl-btn--secondary rl-btn--sm" data-disk="${d.name}" data-mounted="${d.mounted}">${d.mounted ? html`${icon('eject')}${t('files.eject')}` : t('files.mount')}</button></div></li>`);
    }
    for (const r of externals.data?.remote ?? []) {
      rows.push(html`<li><div class="rl-set__row">${well('globe-hemisphere-west', 'indigo')}<span class="rl-set__label">${r.label}<span class="rl-set__sub">${[r.protocol?.toUpperCase(), r.host, r.connected ? '' : t('files.disconnected')].filter(Boolean).join(' · ')}</span></span>
        <button class="rl-btn rl-btn--secondary rl-btn--sm" data-remote="${r.id}" data-connected="${r.connected}">${t(r.connected ? 'files.disconnect' : 'files.connect')}</button></div></li>`);
    }
  }
  if (!rows.length) return '';
  return html`${section('files.secDevices')}<ul class="rl-set__list">${rows}</ul>`;
}

/**
 * 文件's status line: is the storage all right? Signed out first (nothing to
 * browse), then a volume that is full, failing or degraded (opens 存储池),
 * else the free space across the volumes and any USB drives.
 */
function status(d, signedIn) {
  if (account.data && !signedIn) return { level: 'warn', iconName: 'user', text: t('files.status.signedOut'), attrs: html` data-sign-in` };
  const issue = healthIssues(d, pools.data, null).find((x) => x.open === 'storage');
  if (issue) return { level: issue.level, text: issue.text, attrs: html` data-pool-status` };
  const ps = pools.data ?? [];
  if (!ps.length) return null;
  const free = ps.reduce((s, p) => s + Math.max(0, (p.total_bytes ?? 0) - (p.used_bytes ?? 0)), 0);
  const usb = signedIn ? (externals.data?.disks ?? []).filter((x) => x.mounted).length : 0;
  return { text: [t('files.freeOf', { free: size(free) }), usb && t('files.status.usb', { n: usb })].filter(Boolean).join(' · ') };
}

export default function filesPage(ctx) {
  const paint = painter(ctx.el);
  const live = [poller(pools, 30000), poller(externals, 15000)];
  let shown = false;

  function render() {
    const d = panel.data ?? {};
    const signedIn = account.data?.signedIn;
    let body;
    if (account.data && !signedIn) {
      body = html`<div class="rl-set" style="padding-bottom:18px"><div style="padding:28px 0 20px">${empty({
        iconName: 'folder-user', title: t('files.signIn'), body: t('files.signInBody'),
        action: html`<button class="rl-btn rl-btn--primary" data-sign-in>${t('account.signIn')}</button>`,
      })}</div>${devices(false)}<p class="rl-set__foot">${t('files.signedOutFoot')}</p></div>`;
    } else {
      body = html`<div class="rl-set" style="padding-bottom:18px">${places()}${recent()}${devices(true)}</div>`;
    }
    paint(html`${backdrop()}${hostbar(d.host?.name, status(d, signedIn))}${titledPanel({ slipHead: slipHead(slipText('page.files')), body })}`);
  }

  const openPlace = (kind) => {
    if (kind === 'trash') { push(TRASH); return; }
    const title = { home: t('files.home'), team: t('files.team'), fav: t('files.favs') }[kind];
    push(folderPage, { place: { kind }, title, crumbs: [{ label: t('page.files') }] });
  };

  on(ctx.el, 'click', '[data-place]', (e, a) => { e.preventDefault(); openPlace(a.dataset.place); });
  on(ctx.el, 'click', '[data-recent]', (e, a) => {
    e.preventDefault();
    const x = recents.list()[+a.dataset.recent];
    if (x) openFile(x, [x], '');
  });
  on(ctx.el, 'click', '[data-sign-in]', () => push(ACCOUNT));
  on(ctx.el, 'click', '[data-pool-status]', (e) => { e.preventDefault(); push(POOL); });
  on(ctx.el, 'click', '[data-pool]', (e, a) => {
    e.preventDefault();
    const p = pools.data?.[+a.dataset.pool];
    if (!p) return;
    if (account.data?.signedIn && p.mount) push(folderPage, { place: { kind: 'path', path: p.mount }, title: p.name, crumbs: [{ label: t('page.files') }] });
    else push(POOL, { pick: +a.dataset.pool });
  });
  // a USB drive: its folder, or first which partition when it has several
  on(ctx.el, 'click', '[data-usb]', async (e, row) => {
    e.preventDefault();
    const d = externals.data?.disks?.find((x) => x.name === row.dataset.usb);
    const parts = d?.parts.filter((x) => x.mounted && x.path) ?? [];
    if (!parts.length) return;
    let part = parts[0];
    if (parts.length > 1) {
      const id = await sheet({ title: d.model, sub: t('files.pickPart'), actions: parts.map((x) => ({ id: x.name, icon: 'hard-drive', label: x.mount_name ?? x.name, hint: [x.fstype, x.fssize && size(x.fssize)].filter(Boolean).join(' · ') })) });
      part = parts.find((x) => x.name === id);
      if (!part) return;
    }
    push(folderPage, { place: { kind: 'path', path: part.path }, title: parts.length > 1 ? part.mount_name ?? part.name : d.model, crumbs: [{ label: t('page.files') }] });
  });
  on(ctx.el, 'click', '[data-disk]', async (e, b) => {
    const mounted = b.dataset.mounted === 'true';
    if (mounted && !(await confirm({ title: t('files.ejectTitle'), body: t('files.ejectBody'), action: t('files.eject'), actionIcon: 'eject' }))) return;
    try {
      await api.post(`fnos/disk/${mounted ? 'eject' : 'mount'}`, { disk: b.dataset.disk });
      toast(t(mounted ? 'files.ejected' : 'files.mounted'));
    } catch (err) { failed(err); }
    externals.refresh();
  });
  on(ctx.el, 'click', '[data-remote]', async (e, b) => {
    const connected = b.dataset.connected === 'true';
    try {
      await api.post(`fnos/remote/${connected ? 'disconnect' : 'connect'}`, { name: b.dataset.remote });
    } catch (err) { failed(err); }
    externals.refresh();
  });

  wireSlipTabs(ctx, render, () => shown);
  for (const r of [account, pools, externals, home, team, trashList]) ctx.own(r.changed.on(render));
  ctx.own(favourites.changed.on(render));
  ctx.own(panel.changed.on(render));

  return {
    title: 'page.files',
    render,
    async show() {
      shown = true;
      live.forEach((p) => p.start());
      await account.refresh();
      if (account.data?.signedIn) {
        [home, team, trashList].forEach((r) => r.refresh());
        loadFavourites();
      }
      render();
    },
    hide() { shown = false; live.forEach((p) => p.stop()); },
  };
}

