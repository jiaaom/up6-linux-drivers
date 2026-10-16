// A folder page: 我的文件 (every volume merged), 团队文件, 收藏, or a real folder.
// The running head holds the title slip, the 藏 seal (real folders), sort,
// search (in place), 选择 and the list / grid switch. A tap opens; a long
// press opens the item sheet. Selection swaps the tab bar for an action bar;
// the clipboard shows as a bar above the tab bar while it holds something.

import { api } from '../../core/api.js';
import { el, html, on, painter } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { size } from '../../core/format.js';
import { getLang, t } from '../../core/i18n.js';
import { resource } from '../../core/resource.js';
import { load, save } from '../../core/storage.js';
import {
  clipboard, favourites, itemsLabel, listPlace, loadFavourites, pasteBlocked, search as searchAll, setFavourite,
} from '../../data/files.js';
import { sheet, toast } from '../../shell/layers.js';
import { backTo, goTo, lazy, push } from '../../shell/router.js';
import { setDockAbove, setDockInstead } from '../../shell/tabbar.js';
import { taskEnded } from '../../shell/tasks.js';
import { userForgotten } from '../../data/session.js';
import { account } from '../../data/stores.js';
import { row, tile } from '../../ui/files.js';
import { backdrop } from '../../ui/page.js';
import { empty, loadFailed, skeletonRows } from '../../ui/states.js';
import { canOpenTab, openInNewTab, slipHead, wireSlipTabs } from './tabs.js';
import { cut, failed, folderSize, itemSheet, newFolder, openFile, paste, rename, toggleFavourite, trash } from './actions.js';

const LONG_PRESS_MS = 500;
const ACCOUNT = lazy(() => import('../settings/account.js'));
const SORTS = ['date', 'name', 'size'];
const listings = new Map(); // place key → resource, kept while the app runs (or until sign-out)
userForgotten.on(() => listings.clear());

const placeKey = (p) => (p.kind === 'path' ? p.path : p.kind);

function listing(place) {
  const key = placeKey(place);
  if (!listings.has(key)) listings.set(key, resource(`dir.${key}`, () => listPlace(place), { persist: false }));
  return listings.get(key);
}

const prefs = () => ({ view: 'list', sort: 'date', hidden: false, ...(load('files.prefs') ?? {}) });

function sorted(items, sort, hidden) {
  const list = items.filter((i) => hidden || !i.name.startsWith('.'));
  const cmp = {
    date: (a, b) => b.mtime - a.mtime,
    name: (a, b) => a.name.localeCompare(b.name, getLang() === 'zh' ? 'zh-CN' : 'en', { numeric: true }),
    size: (a, b) => b.size - a.size,
  }[sort];
  // by date, folders and files mix (the list is grouped by month); otherwise folders first
  return list.sort((a, b) => (sort === 'date' ? 0 : b.dir - a.dir) || cmp(a, b));
}

/** Month groups for a list sorted by date: [{ label, items }]. */
function byMonth(items) {
  const fmt = new Intl.DateTimeFormat(getLang() === 'zh' ? 'zh-CN' : 'en-GB', { month: 'long', year: 'numeric' });
  const groups = [];
  for (const i of items) {
    const label = i.mtime ? fmt.format(new Date(i.mtime * 1000)) : t('files.undated');
    if (groups[groups.length - 1]?.label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(i);
  }
  return groups;
}

export default function folderPage(ctx) {
  const { place, title, crumbs = [] } = ctx.params;
  const res = listing(place);
  const paint = painter(ctx.el);
  const p = prefs();
  let view = p.view;
  let sort = p.sort;
  let hidden = p.hidden;
  let selecting = false;
  const chosen = new Set();
  let query = null; // null: not searching
  let found = null; // results from the index (我的文件), or null
  let searchTimer = 0;
  let shown = false;
  const level = crumbs.length + 1;

  const savePrefs = () => save('files.prefs', { view, sort, hidden });
  const items = () => res.data ?? [];
  const visible = () => {
    if (query == null || query === '') return sorted([...items()], sort, hidden);
    if (found) return found;
    const q = query.toLowerCase();
    return sorted(items().filter((i) => i.name.toLowerCase().includes(q)), sort, true);
  };
  const byPath = (path) => visible().find((i) => i.path === path) ?? items().find((i) => i.path === path);
  const isReal = place.kind === 'path';
  const signedOut = () => account.data && !account.data.signedIn;

  // ---------- markup ----------

  function crumbsBar() {
    const all = [...crumbs, { label: title }];
    return html`<div class="rl-pagebar"><ol class="rl-crumbs">${all.map((c, i) => (i < all.length - 1
      ? html`<li><a href="#" data-level="${i + 1}">${c.label}</a></li>`
      : html`<li>${c.label}</li>`))}</ol>
      <p class="rl-pagebar__meta">${res.data && !signedOut() ? t('files.count', { n: visible().length }) : ''}</p>
      <button class="rl-btn rl-btn--secondary rl-btn--icon rl-glass" data-more aria-label="${t('files.more')}">${icon('dots-three')}</button></div>`;
  }

  function selectBar() {
    const bytes = [...chosen].reduce((s, path) => s + (byPath(path)?.size ?? 0), 0);
    const all = chosen.size === visible().length && chosen.size > 0;
    return html`<div class="rl-pagebar rl-pagebar--select"><button class="rl-textbtn" data-end-select>${t('common.cancel')}</button>
      <p class="rl-pagebar__meta">${bytes ? size(bytes) : ''}</p><button class="rl-textbtn" data-all>${t(all ? 'files.none' : 'files.all')}</button></div>`;
  }

  function head() {
    const slip = slipHead(selecting
      ? html`<span>${t('files.selected', { n: chosen.size })}</span>${getLang() === 'zh' ? html`<span class="rl-slip__sub">Selected</span>` : ''}`
      : html`<span>${title}</span>`, { locked: selecting });
    const faved = isReal && favourites.set.has(place.path);
    const seal = !selecting && isReal
      ? html`<button class="rl-seal-toggle rl-panel__seal" data-seal aria-pressed="${faved}" aria-label="${t('files.favFolder')}"><span class="rl-seal"><span class="rl-seal__text">藏</span></span></button>` : '';
    return html`<div class="rl-panel__head${query != null ? ' is-searching' : ''}">${slip}${seal}
      <div class="rl-toolbar">
        <button class="rl-sortbtn" data-sort>${t(`files.sort.${sort}`)}${icon('caret-down')}</button>
        ${selecting ? '' : html`<button class="rl-btn rl-btn--secondary rl-btn--icon rl-btn--sm" data-search aria-label="${t('files.searchHere')}">${icon('magnifying-glass')}</button>
        <button class="rl-btn rl-btn--secondary rl-btn--sm" data-select>${t('files.choose')}</button>`}
        <div class="rl-seg" role="group" aria-label="${t('files.view')}">
          <button class="rl-seg__btn" data-view="list" aria-label="${t('files.list')}" aria-pressed="${view === 'list'}">${icon('list-bullets', 'light')}</button>
          <button class="rl-seg__btn" data-view="grid" aria-label="${t('files.grid')}" aria-pressed="${view === 'grid'}">${icon('squares-four', 'light')}</button>
        </div>
      </div>
      <div class="rl-panel__find"><label class="rl-search">${icon('magnifying-glass')}<input type="search" data-query value="${query ?? ''}" placeholder="${t(place.kind === 'home' ? 'files.searchAll' : 'files.searchHere')}" aria-label="${t('files.searchHere')}"></label>
        <button class="rl-textbtn" data-end-search>${t('common.cancel')}</button></div>
    </div>`;
  }

  function body() {
    // a lapsed session: say so rather than keep showing the listing (the tabs stay)
    if (signedOut()) {
      return html`<div style="padding:12px 0 8px">${empty({ iconName: 'lock-simple', title: t('files.expired'), body: t('files.expiredBody'), error: false,
        action: html`<button class="rl-btn rl-btn--primary" data-sign-in>${t('account.signIn')}</button>` })}</div>`;
    }
    if (!res.data) {
      return res.status === 'failed'
        ? (res.error?.status === 502 && /sign in|登录/i.test(res.error.message) ? empty({ iconName: 'folder-user', title: t('files.signIn'), error: false }) : loadFailed())
        : skeletonRows(6);
    }
    const list = visible();
    if (!list.length) {
      if (query) return empty({ iconName: 'magnifying-glass', title: t('files.notFound', { q: query }), body: t(place.kind === 'home' ? 'files.notFoundAll' : 'files.notFoundHere') });
      return empty({ iconName: 'folder-simple-dashed', title: t(place.kind === 'fav' ? 'files.noFavs' : 'files.emptyFolder'), body: place.kind === 'fav' ? t('files.noFavsBody') : '' });
    }
    const opts = (i) => ({ select: selecting, checked: chosen.has(i.path), fav: favourites.set.has(i.path) });
    if (view === 'grid') return html`<div class="rl-tiles">${list.map((i) => tile(i, opts(i)))}</div>`;
    const sub = (i) => (found ? i.path.replace(/\/[^/]*$/, '').replace(/^\/vol\d+\/\d+/, t('files.home')) : undefined);
    if (sort === 'date' && !query) {
      return html`<ul class="rl-toc" style="border-top:0">${byMonth(list).map((g) => html`<li class="rl-toc__section">${g.label}<small>${t('files.count', { n: g.items.length })}</small></li>${g.items.map((i) => row(i, opts(i)))}`)}</ul>`;
    }
    return html`<ul class="rl-toc" style="border-top:0">${list.map((i) => row(i, { ...opts(i), sub: sub(i) }))}</ul>`;
  }

  function render() {
    paint(html`${backdrop()}${selecting ? selectBar() : crumbsBar()}<section class="rl-panel rl-panel--titled">${head()}<div data-body>${body()}</div></section>`);
    if (shown) dockBars();
  }

  /** Only the list and the count: while typing in the search field (the painter holds a full paint back then). */
  function renderList() {
    const box = ctx.el.querySelector('[data-body]');
    if (box) box.innerHTML = String(body());
    const meta = ctx.el.querySelector('.rl-pagebar__meta');
    if (meta && res.data) meta.textContent = t('files.count', { n: visible().length });
  }

  // ---------- dock: clipboard bar, selection action bar ----------

  function clipBar() {
    const c = clipboard.value;
    if (!c || selecting) return null;
    const blocked = pasteBlocked(place);
    const subKey = blocked === 'sameFolder' ? 'files.clipSame' : blocked ? 'files.clipGoTo' : 'files.clipHere';
    const node = el(html`<div class="rl-clipbar rl-glass rl-frame" role="region" aria-label="${t('files.clipboard')}">
      <span class="rl-clipbar__icon">${icon('clipboard-text', 'light')}</span>
      <span class="rl-clipbar__text"><b>${t(c.op === 'move' ? 'files.clipMove' : 'files.clipCopy', { n: c.items.length })}</b><small>${itemsLabel(c.items, t)} · ${t(subKey)}</small></span>
      <button class="rl-btn rl-btn--secondary rl-btn--icon rl-btn--sm" data-clip-clear aria-label="${t('files.clipClear')}">${icon('x')}</button>
      <button class="rl-btn rl-btn--primary rl-btn--sm" data-paste${blocked ? html` disabled` : ''}>${t(c.op === 'move' ? 'files.moveHere' : 'files.paste')}</button>
    </div>`);
    on(node, 'click', '[data-clip-clear]', () => clipboard.set(null));
    on(node, 'click', '[data-paste]', () => paste(place.path, items()));
    return node;
  }

  function actionBar() {
    const node = el(html`<div class="rl-actionbar rl-glass"><button class="rl-btn rl-btn--primary rl-btn--block" data-act${chosen.size ? '' : html` disabled`}>${chosen.size ? t('files.actOn', { n: chosen.size }) : t('files.pickSome')}</button></div>`);
    on(node, 'click', '[data-act]', selectionSheet);
    return node;
  }

  function dockBars() {
    setDockAbove(clipBar());
    setDockInstead(selecting ? actionBar() : null);
  }

  // ---------- selection ----------

  function startSelect(first) {
    selecting = true;
    chosen.clear();
    if (first) chosen.add(first.path);
    render();
  }

  function endSelect() {
    selecting = false;
    chosen.clear();
    render();
  }

  async function selectionSheet() {
    const picked = [...chosen].map(byPath).filter(Boolean);
    if (!picked.length) return;
    const canWrite = place.kind !== 'team' || crumbs.length > 1;
    const id = await sheet({
      title: t('files.selected', { n: picked.length }),
      sub: [itemsLabel(picked, t), picked.some((i) => !i.dir) ? size(picked.reduce((s, i) => s + i.size, 0)) : ''].filter(Boolean).join(' · '),
      actions: [
        { id: 'fav', icon: 'star', label: t(picked.every((i) => favourites.set.has(i.path)) ? 'files.unfav' : 'files.fav') },
        { id: 'copy', icon: 'copy', label: t('files.copy'), hint: t('files.pasteElsewhere') },
        canWrite && { id: 'move', icon: 'scissors', label: t('files.move'), hint: t('files.pasteElsewhere') },
        canWrite && { id: 'rename', icon: 'pencil-simple', label: t('files.rename'), disabled: picked.length !== 1, hint: picked.length !== 1 ? t('files.renameOne') : '' },
        canWrite && { id: 'trash', icon: 'trash', label: t('files.trash'), danger: true },
      ].filter(Boolean),
    });
    const from = isReal ? place.path : picked[0].path.replace(/\/[^/]*$/, '');
    if (id === 'fav') { await toggleFavourite(picked); endSelect(); }
    else if (id === 'copy' || id === 'move') { cut(id, picked, from); endSelect(); }
    else if (id === 'rename') { if (await rename(picked[0])) { endSelect(); refresh(); } }
    else if (id === 'trash') { if (await trash(picked, refresh)) { endSelect(); refresh(); } }
  }

  // ---------- the 更多 sheet ----------

  async function moreSheet() {
    const c = clipboard.value;
    const blocked = pasteBlocked(place);
    const id = await sheet({
      title,
      sub: t('files.count', { n: visible().length }),
      actions: [
        c && { id: 'paste', icon: 'clipboard-text', label: t('files.pasteN', { n: c.items.length }), disabled: !!blocked, hint: blocked ? t(blocked === 'sameFolder' ? 'files.clipSame' : 'files.clipGoTo') : '' },
        c && { id: 'clear', icon: 'x', label: t('files.clipClear') },
        isReal && { id: 'mkdir', icon: 'folder-plus', label: t('files.newFolder') },
        { id: 'refresh', icon: 'arrows-clockwise', label: t('board.refresh') },
        { id: 'hidden', icon: hidden ? 'eye' : 'eye-slash', label: t(hidden ? 'files.hideHidden' : 'files.showHidden') },
        isReal && { id: 'size', icon: 'ruler', label: t('files.folderSize'), hint: t('files.folderSizeHint') },
      ].filter(Boolean),
    });
    if (id === 'paste') paste(place.path, items());
    else if (id === 'clear') clipboard.set(null);
    else if (id === 'mkdir') { if (await newFolder(place.path)) refresh(); }
    else if (id === 'refresh') refresh();
    else if (id === 'hidden') { hidden = !hidden; savePrefs(); render(); }
    else if (id === 'size') folderSize(place.path, title);
  }

  // ---------- events ----------

  const refresh = () => res.refresh();

  function open(item) {
    if (item.dir) {
      push(folderPage, { place: { kind: 'path', path: item.path }, title: item.name, crumbs: [...crumbs, { label: title }] });
    } else {
      openFile(item, visible(), title);
    }
  }

  // tap / long press on an item
  let press = null;
  on(ctx.el, 'pointerdown', '[data-item]', (e, n) => {
    if (selecting) return;
    press = { path: n.dataset.item, x: e.clientX, y: e.clientY, fired: 0, timer: setTimeout(async () => {
      press.fired = Date.now();
      const item = byPath(press.path);
      if (!item) return;
      const r = await itemSheet(item, { refresh, select: (i) => startSelect(i), canWrite: place.kind !== 'team' || crumbs.length > 1, newTab: { full: !canOpenTab() } });
      if (r.open) open(item);
      if (r.newTab) openInNewTab(folderPage, { place: { kind: 'path', path: item.path }, title: item.name, crumbs: [{ label: t('page.files') }] });
    }, LONG_PRESS_MS) };
  });
  const cancelPress = () => { if (press) clearTimeout(press.timer); };
  ctx.el.addEventListener('pointerup', () => { cancelPress(); if (press?.fired) press.upAt = Date.now(); });
  ctx.el.addEventListener('pointercancel', cancelPress);
  ctx.el.addEventListener('pointermove', (e) => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) cancelPress(); });
  on(ctx.el, 'click', 'a[data-item], [data-item] > a', (e, a) => {
    e.preventDefault();
    // the click that ends a long press (and only that one) is swallowed
    if (press?.upAt && Date.now() - press.upAt < 400) { press = null; return; }
    press = null;
    const path = a.dataset.item ?? a.parentElement.dataset.item;
    const item = byPath(path);
    if (!item) return;
    if (selecting) { chosen.has(path) ? chosen.delete(path) : chosen.add(path); render(); return; }
    open(item);
  });
  // selection checkboxes (rows are labels; tiles carry their own box)
  on(ctx.el, 'change', '[data-item] input[type=checkbox]', (e, box) => {
    const path = box.closest('[data-item]').dataset.item;
    if (box.checked) chosen.add(path); else chosen.delete(path);
    render();
  });

  on(ctx.el, 'click', '[data-level]', (e, a) => { e.preventDefault(); backTo(+a.dataset.level); });
  on(ctx.el, 'click', '[data-more]', moreSheet);
  on(ctx.el, 'click', '[data-select]', () => startSelect());
  on(ctx.el, 'click', '[data-end-select]', endSelect);
  on(ctx.el, 'click', '[data-all]', () => {
    const list = visible();
    if (chosen.size === list.length) chosen.clear(); else list.forEach((i) => chosen.add(i.path));
    render();
  });
  on(ctx.el, 'click', '[data-view]', (e, b) => { view = b.dataset.view; savePrefs(); render(); });
  on(ctx.el, 'click', '[data-sort]', async () => {
    const id = await sheet({ title: t('files.sortTitle'), actions: SORTS.map((s) => ({ id: s, icon: s === sort ? 'check-square' : 'list-bullets', label: t(`files.sort.${s}`) })) });
    if (id) { sort = id; savePrefs(); render(); }
  });
  on(ctx.el, 'click', '[data-seal]', async () => {
    const on_ = !favourites.set.has(place.path);
    try {
      await setFavourite(place.path, on_);
      const seal = ctx.el.querySelector('[data-seal]');
      if (on_) seal?.classList.add('is-stamping');
      toast(t(on_ ? 'files.favAdded' : 'files.favRemoved', { what: title }));
    } catch (e) { failed(e); }
  });
  on(ctx.el, 'click', '[data-search]', () => {
    query = '';
    found = null;
    render();
    ctx.el.querySelector('[data-query]')?.focus();
  });
  on(ctx.el, 'click', '[data-end-search]', () => { query = null; found = null; render(); });
  on(ctx.el, 'input', '[data-query]', (e, input) => {
    query = input.value.trim();
    clearTimeout(searchTimer);
    if (place.kind === 'home' && query) {
      // the merged home is searched in fnOS's index, across every volume
      searchTimer = setTimeout(async () => {
        try { found = await searchAll(query); } catch { found = []; }
        renderList();
      }, 400);
    } else {
      found = null;
      renderList();
    }
  });
  on(ctx.el, 'click', '[data-retry]', refresh);

  wireSlipTabs(ctx, render, () => shown);
  on(ctx.el, 'click', '[data-sign-in]', () => goTo('settings', ACCOUNT));
  ctx.own(res.changed.on(render));
  ctx.own(favourites.changed.on(render));
  // signed back in after a lapse: list again
  let wasOut = signedOut();
  ctx.own(account.changed.on(() => {
    const out = signedOut();
    if (wasOut && !out && shown) res.refresh();
    wasOut = out;
    render();
  }));
  ctx.own(clipboard.changed.on(() => { if (shown) dockBars(); }));
  ctx.own(taskEnded.on((task) => { if (task.to === place.path || place.kind !== 'path') refresh(); }));

  return {
    title: 'page.files',
    slip: () => title,
    render,
    show() {
      shown = true;
      res.refresh();
      if (!favourites.set.size) loadFavourites();
      dockBars();
    },
    hide() {
      shown = false;
      setDockAbove(null);
      setDockInstead(null);
    },
  };
}
