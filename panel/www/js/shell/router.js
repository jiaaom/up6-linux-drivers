// Tabs and the pages below them.
//
// Each tab keeps its own stack of pages. Switching tabs cross-fades (tabs are
// siblings); going one level down slides the new page in from the right over
// the current one, and back reverses it. A page below a tab keeps the tab bar.
//
// 文件 may hold up to three stacks at once, shown as title slips (Ridgeline
// Files › Tabs, "slip tabs"): each slip is its own stack, hidden pages keep
// their state, and switching cross-fades like the tab bar. Every other tab
// has exactly one stack.
//
// A page module's default export is a factory:
//
//   export default function myPage(ctx) {
//     return { title: 'page.x', render() {…}, show() {…}, hide() {…}, destroy() {…} };
//   }
//
//   ctx.el      the page's own scroller (.rl-scroller), to render into
//   ctx.params  whatever push() was given
//   ctx.parent  title id of the page below (for the back link), or null at a tab root
//   ctx.own(f)  run f when the page is destroyed (unsubscribe, clear timers)
//
// render() must be safe to call again: it runs on mount and on a language change.
//
// push() takes a factory, or lazy(() => import('…')) to load the page's module
// only when it is first opened. A tap never waits for a module: the page
// slides in at once as a placeholder (sky, back link, skeleton) and renders
// when its module arrives. After start-up every lazy module is loaded in the
// background (warm()), so usually there is nothing to wait for.

import { afterAnimation, html, on } from '../core/dom.js';
import { langChanged, t } from '../core/i18n.js';
import { emitter } from '../core/events.js';
import { backdrop, pagebar, titledPanel } from '../ui/page.js';
import { skeleton, skeletonRows } from '../ui/states.js';

const lazies = []; // every lazy() made so far, for warm()

/** A page whose module is loaded the first time it opens (or by warm()). */
export function lazy(load) {
  const f = { lazy: load, mod: null };
  f.ready = () => (f.mod ? Promise.resolve(f.mod) : load().then((m) => (f.mod = m)));
  lazies.push(f);
  return f;
}

/** Load every lazy page module, one at a time, while nothing else is going on. */
function warm() {
  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 50));
  let i = 0;
  const next = () => {
    while (i < lazies.length && lazies[i].mod) i++;
    if (i >= lazies.length) return;
    lazies[i].ready().catch(() => {}).finally(() => idle(next));
  };
  idle(next);
}

/** What a page shows while its module is still loading. */
const placeholder = (parent) => html`${backdrop()}${parent ? pagebar({ back: parent }) : html`<div class="rl-pagebar"></div>`}${titledPanel({ slipMarkup: skeleton('title', '3.5em'), body: skeletonRows(4) })}`;

export const TABS = [
  { id: 'overview', icon: 'gauge', title: 'page.overview', page: lazy(() => import('../pages/overview/index.js')) },
  { id: 'files', icon: 'folder-open', title: 'page.files', page: lazy(() => import('../pages/files/index.js')) },
  { id: 'network', icon: 'plugs-connected', title: 'page.network', page: lazy(() => import('../pages/network/index.js')) },
  { id: 'settings', icon: 'gear', title: 'page.settings', page: lazy(() => import('../pages/settings/index.js')) },
];

const stacks = new Map(); // stack id → [entry]; entry = { el, page, cleanups }
// tab id → { ids: [stack id], cur: stack id }: a tab's stacks, in slip order
const books = new Map();
let stackSeq = 0;
let screen = null;
let before = null; // pages are inserted before this node (the dock)
let current = null; // tab id
let busy = false;
let pendingTab = null; // a tab tapped while busy

/** Clear busy and run a tab switch that waited for it. */
function done() {
  busy = false;
  const tab = pendingTab;
  pendingTab = null;
  if (tab) go(tab);
}

export const routeChanged = emitter();

export function currentTab() {
  return current;
}

function book(tabId) {
  if (!books.has(tabId)) books.set(tabId, { ids: [tabId], cur: tabId });
  return books.get(tabId);
}

/** The stack on screen in a tab (its current slip). */
const stackOf = (tabId = current) => stacks.get(book(tabId).cur);

/** The page on top of the current tab: { el, page } or null. */
export function topEntry() {
  const s = stackOf();
  return s?.[s.length - 1] ?? null;
}

export function depth() {
  return stackOf()?.length ?? 0;
}

function create(factory, params, parent) {
  const el = document.createElement('div');
  el.className = 'rl-scroller rl-backdrop-host rl-silk';
  el.hidden = true;
  screen.insertBefore(el, before);
  const entry = { el, page: null, cleanups: [], shown: false, dead: false };
  const mount = (make) => {
    entry.page = make({ el, params, parent, own: (f) => entry.cleanups.push(f) });
    entry.page.render();
  };
  const make = factory.lazy ? factory.mod?.default : factory;
  if (make) {
    mount(make);
  } else {
    entry.page = { title: null, render() {} };
    el.innerHTML = String(placeholder(parent));
    factory.ready().then((m) => {
      if (entry.dead) return;
      mount(m.default);
      if (entry.shown) entry.page.show?.();
    });
  }
  return entry;
}

function show(entry) {
  entry.shown = true;
  entry.page.show?.();
}

function hide(entry) {
  entry.shown = false;
  entry.page.hide?.();
}

function destroy(entry) {
  entry.dead = true;
  entry.page.destroy?.();
  entry.cleanups.forEach((f) => f());
  entry.el.remove();
}

function setTop(entry) {
  for (const el of screen.querySelectorAll(':scope > .rl-scroller.is-top')) el.classList.remove('is-top');
  entry.el.hidden = false;
  entry.el.classList.add('is-top');
}

/**
 * Between tabs (and slips): the new page fades in whole over the old one
 * (rl-tabpane--in), which stays on screen under it (rl-tabpane--out) until
 * the fade ends. Both carry the same sky, so only the paper changes.
 */
function crossFade(old, next) {
  setTop(next);
  if (!old || old === next) return;
  next.el.classList.remove('rl-tabpane--out'); // straight back during a fade
  old.el.classList.remove('rl-tabpane--in');
  next.el.classList.add('rl-tabpane--in');
  old.el.classList.add('rl-tabpane--out');
  afterAnimation(next.el, 200).then(() => {
    next.el.classList.remove('rl-tabpane--in');
    old.el.classList.remove('rl-tabpane--out');
    if (!old.el.classList.contains('is-top')) old.el.hidden = true; // unless we came straight back
  });
}

function ensureRoot(tabId) {
  const id = book(tabId).cur;
  if (!stacks.has(id)) {
    const tab = TABS.find((t) => t.id === tabId);
    stacks.set(id, [create(tab.page, {}, null)]);
  }
  return stacks.get(id);
}

/** Switch to a tab. Tapping the tab you are on goes back to its first page. */
export async function go(tabId) {
  // a tab tapped while a page is sliding is not dropped: it runs right after
  if (busy) { pendingTab = tabId; return; }
  if (tabId === current) return popToRoot();
  busy = true;
  try {
    const old = topEntry();
    const stack = ensureRoot(tabId);
    const next = stack[stack.length - 1];
    if (old) hide(old);
    current = tabId;
    crossFade(old, next);
    show(next);
    routeChanged.emit();
  } finally {
    done();
  }
}

/** Open a page one level down. */
export async function push(factory, params = {}) {
  if (busy) return;
  busy = true;
  try {
    const stack = stackOf();
    const under = stack[stack.length - 1];
    const entry = create(factory, params, under.page.title);
    stack.push(entry);
    hide(under);
    setTop(entry);
    under.el.classList.add('rl-page--under');
    entry.el.classList.add('rl-page--enter');
    await afterAnimation(entry.el);
    under.el.classList.remove('rl-page--under');
    under.el.hidden = true;
    entry.el.classList.remove('rl-page--enter');
    show(entry);
    routeChanged.emit();
  } finally {
    done();
  }
}

/** Go back one level. Returns false at the first page of a tab. */
export async function back() {
  const stack = stackOf();
  if (busy || !stack || stack.length < 2) return false;
  busy = true;
  try {
    const top = stack.pop();
    const under = stack[stack.length - 1];
    hide(top);
    under.el.hidden = false;
    under.el.classList.add('rl-page--return');
    top.el.classList.add('rl-page--exit');
    await afterAnimation(top.el);
    destroy(top);
    under.el.classList.remove('rl-page--return');
    setTop(under);
    show(under);
    routeChanged.emit();
  } finally {
    done();
  }
  return true;
}

/** Back to the page at `level` (1 = the tab's first page); pages in between leave without a slide. */
export async function backTo(level) {
  const stack = stackOf();
  if (!stack || stack.length <= level) return;
  while (stack.length > level + 1) destroy(stack.splice(level, 1)[0]);
  await back();
}

/** Back to the first page of the current tab (pages in between leave without a slide). */
export async function popToRoot() {
  const stack = stackOf();
  if (!stack || stack.length < 2) return;
  while (stack.length > 2) destroy(stack.splice(1, 1)[0]);
  await back();
}

/**
 * Sign-out: a tab's extra slips close and its first stack goes back to its
 * first page (without a slide, unless the tab is on screen).
 */
export function resetTab(tabId) {
  const b = book(tabId);
  for (const id of b.ids.slice(1)) dropStack(id);
  const first = b.ids[0];
  const wasCur = b.cur === first;
  b.ids = [first];
  b.cur = first;
  const stack = ensureRoot(tabId);
  if (tabId === current && !wasCur) {
    const root = stack[0];
    while (stack.length > 1) destroy(stack.pop());
    setTop(root);
    show(root);
    routeChanged.emit();
  } else if (tabId === current) {
    popToRoot();
  } else {
    while (stack.length > 1) destroy(stack.pop());
  }
  slipTabsChanged.emit(tabId);
}

/** Go to a tab's first page and, if given, open `page` one level below it. */
export async function goTo(tabId, page, params) {
  await go(tabId);
  await popToRoot();
  if (page) await push(page, params);
}

/** The next tab along the tab bar, wrapping from 设置 back to 总览 (the remote's Home key). */
export function nextTab() {
  const i = TABS.findIndex((x) => x.id === (pendingTab ?? current));
  return go(TABS[(i + 1) % TABS.length].id);
}

/** Home: the first page of 总览. */
export async function home() {
  if (current === 'overview') return popToRoot();
  const stack = stackOf();
  await go('overview');
  // the tab left behind starts from its first page next time
  if (stack) while (stack.length > 1) destroy(stack.pop());
}

// ---------- slip tabs (文件) ----------

/** Fired with the tab id when a tab's slips change (opened, closed, switched, relabelled). */
export const slipTabsChanged = emitter();
routeChanged.on(() => slipTabsChanged.emit(current));

export const MAX_SLIP_TABS = 3;

function dropStack(id) {
  for (const entry of stacks.get(id) ?? []) {
    if (entry.shown) hide(entry);
    destroy(entry);
  }
  stacks.delete(id);
}

/**
 * A tab's slips, in order: { id, label, current }. The label is the slip's
 * title: the top page's slip() (a folder's name), else its page title.
 */
export function slipTabs(tabId = current) {
  const b = book(tabId);
  return b.ids.map((id) => {
    const top = stacks.get(id)?.at(-1)?.page;
    return { id, label: top?.slip?.() ?? (top?.title ? t(top.title) : ''), current: id === b.cur };
  });
}

/** Show another slip of the current tab: the content cross-fades, as between tabs. */
export async function switchSlipTab(id) {
  const b = book(current);
  if (busy || id === b.cur || !b.ids.includes(id)) return;
  busy = true;
  try {
    const old = topEntry();
    if (old) hide(old);
    b.cur = id;
    const stack = ensureRoot(current);
    const next = stack[stack.length - 1];
    crossFade(old, next);
    show(next);
    routeChanged.emit();
  } finally {
    done();
  }
}

/** A new slip in the current tab, at the tab's first page; then `factory` one level down if given. */
export async function openSlipTab(factory, params) {
  const b = book(current);
  if (busy || b.ids.length >= MAX_SLIP_TABS) return false;
  const id = `${current}#${++stackSeq}`;
  b.ids.push(id);
  await switchSlipTab(id);
  if (factory) await push(factory, params);
  return true;
}

/** Close a slip of the current tab; closing the one on screen shows its neighbour. */
export async function closeSlipTab(id) {
  const b = book(current);
  const i = b.ids.indexOf(id);
  if (busy || i < 0 || b.ids.length < 2) return;
  if (id === b.cur) await switchSlipTab(b.ids[i + 1] ?? b.ids[i - 1]);
  b.ids = b.ids.filter((x) => x !== id);
  slipTabsChanged.emit(current);
  // after the cross-fade: the closed page is still on screen under the new one
  setTimeout(() => dropStack(id), 200);
}

/** Close every slip of the current tab but `id` (and show it). */
export async function closeOtherSlipTabs(id) {
  const b = book(current);
  if (busy || !b.ids.includes(id)) return;
  await switchSlipTab(id);
  const others = b.ids.filter((x) => x !== id);
  b.ids = [id];
  slipTabsChanged.emit(current);
  setTimeout(() => others.forEach(dropStack), 200);
}

/**
 * Called by the edge swipe once it has moved the pages by hand: finish
 * going back without the slide animation.
 */
export function finishSwipeBack() {
  const stack = stackOf();
  const top = stack.pop();
  const under = stack[stack.length - 1];
  hide(top);
  destroy(top);
  setTop(under);
  show(under);
  routeChanged.emit();
}

/** The page under the top one (for the edge swipe), or null. */
export function underEntry() {
  const s = stackOf();
  return s && s.length > 1 ? s[s.length - 2] : null;
}

export function isBusy() {
  return busy;
}

export function startRouter(screenEl, dockEl, firstTab) {
  screen = screenEl;
  before = dockEl;
  on(screen, 'click', '[data-back]', (e) => { e.preventDefault(); back(); });
  langChanged.on(() => {
    for (const stack of stacks.values()) for (const entry of stack) entry.page.render();
  });
  return go(firstTab).then(warm);
}
