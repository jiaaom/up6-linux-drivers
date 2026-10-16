// What can be done to files, shared by the folder pages, 最近 and the preview:
// open (Preview or the player), the item sheet, info, rename, new folder,
// favourite, trash (with 撤销), and the clipboard: copy / move, then paste
// with a conflict sheet when names already exist there.

import { api } from '../../core/api.js';
import { el, html, on } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { day, size } from '../../core/format.js';
import { t } from '../../core/i18n.js';
import { account } from '../../data/stores.js';
import {
  baseName, clipboard, displayPath, favourites, itemsLabel, join, kindOf, parentOf, playable, recents, setFavourite,
} from '../../data/files.js';
import { closeLayer, confirm, openLayer, panelSheet, sheet, toast } from '../../shell/layers.js';
import { startTask } from '../../shell/tasks.js';
import { errorLine, textField } from '../../ui/fields.js';
import { itemHead } from '../../ui/files.js';
import { busyRing } from '../../ui/states.js';
import { openViewer } from './viewer.js';

export const failed = (e) => toast(t('common.failed', { why: e.message }));

/** Open a file: video and music play in mpv; the rest opens in Preview. */
export async function openFile(item, siblings = [item], folderTitle = '') {
  recents.push(item);
  if (playable(item) && window.playerBridge?.open) {
    const r = await window.playerBridge.open(item.path);
    if (r?.ok) return;
  }
  openViewer(item, siblings.filter((x) => !x.dir), folderTitle);
}

/**
 * 文件夹大小: a dialog that counts while it is open. 取消 while counting
 * drops the request (a big folder takes minutes); once the size is in, the
 * one button is 确定.
 */
export function folderSize(path, name) {
  const ctl = new AbortController();
  const node = el(html`<div class="rl-overlay rl-overlay--center">
    <div class="rl-scrim" data-close></div>
    <div class="rl-dialog rl-dialog--size" role="alertdialog" aria-modal="true" aria-label="${t('files.folderSize')}">
      <h2 class="rl-dialog__title">${name}</h2>
      <div data-out aria-live="polite"><p class="rl-dialog__body rl-dialog__count">${busyRing(t('files.measuring'))}${t('files.measuring')}</p>
        <p class="rl-dialog__body">${t('files.measureHint')}</p></div>
      <div class="rl-dialog__actions"><button class="rl-btn rl-btn--secondary" data-close>${t('common.cancel')}</button></div>
    </div>
  </div>`);
  const close = () => { ctl.abort(); closeLayer(entry); };
  const entry = openLayer(node, close);
  on(node, 'click', '[data-close]', close);
  const finish = (markup) => {
    node.querySelector('[data-out]').outerHTML = String(markup);
    node.querySelector('.rl-dialog__actions').innerHTML = String(html`<button class="rl-btn rl-btn--primary" data-close>${t('common.ok')}</button>`);
  };
  api.get(`fnos/folder-size?path=${encodeURIComponent(path)}`, { timeout: 0, signal: ctl.signal }).then((d) => {
    finish(html`<ul class="rl-kv rl-kv--sheet">${[
      ['database', t('files.size'), size(d.fileSizeTotal ?? 0)],
      ['copy', t('files.fileCount'), (d.fileCount ?? 0).toLocaleString()],
      ['folder', t('files.dirCount'), (d.dirCount ?? 0).toLocaleString()],
    ].map(([iconName, label, value]) => html`<li><span>${icon(iconName)}${label}</span><b>${value}</b></li>`)}</ul>`);
  }, (e) => {
    if (!e.aborted) finish(html`<p class="rl-dialog__body rl-field__error">${t('common.failed', { why: e.message })}</p>`);
  });
}

/** The item's info sheet: where it is, what it is, how big, when changed. */
export function showInfo(item) {
  const facts = [
    ['folder', t('files.where'), displayPath(parentOf(item.path), t('files.home'))],
    ['info', t('files.kind'), item.dir ? t('files.kindFolder') : t(`files.kind.${kindOf(item)}`)],
    !item.dir && ['database', t('files.size'), size(item.size)],
    item.mtime && ['clock', t('files.modified'), day(item.mtime)],
  ].filter(Boolean);
  return panelSheet({
    title: item.name,
    closeLabel: t('common.close'),
    head: itemHead(item, t('files.info')),
    mount(body) {
      body.innerHTML = String(html`<ul class="rl-kv rl-kv--sheet">${facts.map(([iconName, label, value]) => html`<li><span>${icon(iconName)}${label}</span><b>${value}</b></li>`)}</ul>`);
    },
  });
}

/** Ask for a name; resolves with it or null. */
async function askName({ title, body, action, value = '' }) {
  let result = null;
  const ok = await confirm({
    title, body, action, top: true,
    content: html`${textField({ id: 't6-name', label: t('files.name'), value })}${errorLine()}`,
    onOpen(node) {
      const input = node.querySelector('#t6-name');
      input.focus();
      const dot = value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : value.length);
    },
    check(node) {
      const v = node.querySelector('#t6-name').value.trim();
      if (!v) return t('files.nameEmpty');
      if (/[/\\]/.test(v)) return t('files.nameSlash');
      result = v;
      return '';
    },
  });
  return ok ? result : null;
}

export async function rename(item) {
  const name = await askName({ title: t('files.rename'), body: '', action: t('files.renameAction'), value: item.name });
  if (!name || name === item.name) return false;
  try {
    await api.post('fnos/files/rename', { path: item.path, newName: name });
    toast(t('files.renamed'));
    return true;
  } catch (e) { failed(e); return false; }
}

export async function newFolder(dir) {
  const name = await askName({ title: t('files.newFolder'), body: '', action: t('files.create'), value: t('files.newFolderName') });
  if (!name) return false;
  try {
    await api.post('fnos/files/mkdir', { path: dir, name });
    return true;
  } catch (e) { failed(e); return false; }
}

export async function toggleFavourite(items) {
  const on = !items.every((i) => favourites.set.has(i.path));
  try {
    for (const i of items) await setFavourite(i.path, on);
    toast(t(on ? 'files.favAdded' : 'files.favRemoved', { what: itemsLabel(items, t) }));
  } catch (e) { failed(e); }
}

/** Where fnOS keeps a trashed item, for 撤销 (restore takes this path). */
function trashPath(item) {
  const m = /^\/vol(\d+)\/(\d+)\//.exec(item.path);
  const v = m?.[1] ?? item.v ?? 1;
  const uid = m?.[2] ?? account.data?.uid;
  return `vol${v}/${uid}/.@#local/trash/${baseName(item.path)}`;
}

/** Move to the recycle bin after a Dialog; a toast offers 撤销. Resolves true when done. */
export async function trash(items, after) {
  const ok = await confirm({
    title: items.length > 1 ? t('files.trashTitleMany', { n: items.length }) : t('files.trashTitle', { name: items[0].name }),
    body: t('files.trashBody'),
    action: t('files.trash'),
    actionIcon: 'trash',
    kind: 'danger',
  });
  if (!ok) return false;
  try {
    await api.post('fnos/files/trash', { paths: items.map((i) => i.path) });
  } catch (e) { failed(e); return false; }
  toast(t('files.trashed', { n: items.length }), {
    iconName: 'trash',
    action: t('files.undo'),
    async onAction() {
      try { await api.post('fnos/trash/restore', { paths: items.map(trashPath) }); after?.(); } catch (e) { failed(e); }
    },
  });
  return true;
}

/** Put items on the clipboard; they paste in another folder. */
export function cut(op, items, from) {
  clipboard.set({ op, items: items.map(({ name, path, dir, size: s }) => ({ name, path, dir, size: s })), from });
  toast(t(op === 'move' ? 'files.toMove' : 'files.toCopy', { what: itemsLabel(items, t) }));
}

/**
 * Paste the clipboard into `dir`, whose current items are `existing`. When
 * names collide, a sheet asks first: keep both, skip them, or replace (the
 * old ones go to the recycle bin). fnOS would silently skip them otherwise.
 */
export async function paste(dir, existing) {
  const c = clipboard.value;
  if (!c) return;
  const names = new Set(existing.map((i) => i.name));
  const clashes = c.items.filter((i) => names.has(i.name));
  let overwrite = 0;
  if (clashes.length) {
    const id = await sheet({
      title: t('files.clashTitle', { n: clashes.length }),
      sub: t('files.clashSub', { what: itemsLabel(clashes, t) }),
      actions: [
        { id: 'both', icon: 'copy', label: t('files.keepBoth'), hint: t('files.keepBothHint') },
        { id: 'skip', icon: 'skip-forward', label: t('files.skip') },
        { id: 'replace', icon: 'arrows-clockwise', label: t('files.replace'), hint: t('files.replaceHint'), danger: true },
      ],
    });
    if (!id) return;
    if (id === 'both') overwrite = 2;
    if (id === 'replace') {
      try { await api.post('fnos/files/trash', { paths: clashes.map((i) => join(dir, i.name)) }); } catch (e) { failed(e); return; }
    }
  }
  try {
    await startTask(c.op, c.items.map((i) => i.path), dir, overwrite);
    if (c.op === 'move') clipboard.set(null);
  } catch (e) { failed(e); }
}

/** The item sheet (a long press): what can be done to one item. */
/** `newTab`: a folder may open in a new tab ({ full: true } at three tabs: shown, not usable). */
export async function itemSheet(item, { refresh, select, canWrite = true, newTab = null } = {}) {
  const fav = favourites.set.has(item.path);
  const openLabel = item.dir ? t('files.open') : playable(item) ? t('files.play') : t('files.preview');
  const id = await sheet({
    title: item.name,
    head: itemHead(item, [item.mtime ? day(item.mtime) : '', item.dir ? '' : size(item.size)].filter(Boolean).join(' · ')),
    actions: [
      { id: 'open', icon: item.dir ? 'folder-open' : playable(item) ? 'play' : 'eye', label: openLabel },
      item.dir && newTab && { id: 'newtab', icon: 'tabs', label: t('files.openNewTab'), hint: newTab.full ? t('tabs.full') : '', disabled: newTab.full },
      { id: 'fav', icon: 'star', label: t(fav ? 'files.unfav' : 'files.fav') },
      canWrite && { id: 'rename', icon: 'pencil-simple', label: t('files.rename') },
      { id: 'copy', icon: 'copy', label: t('files.copy') },
      canWrite && { id: 'move', icon: 'scissors', label: t('files.move') },
      select && { id: 'select', icon: 'check-square', label: t('files.selectMany') },
      { id: 'info', icon: 'info', label: t('files.info') },
      canWrite && { id: 'trash', icon: 'trash', label: t('files.trash'), danger: true },
    ].filter(Boolean),
  });
  switch (id) {
    case 'open': return { open: true };
    case 'newtab': return { newTab: true };
    case 'fav': await toggleFavourite([item]); refresh?.(); break;
    case 'rename': if (await rename(item)) refresh?.(); break;
    case 'copy': cut('copy', [item], parentOf(item.path)); break;
    case 'move': cut('move', [item], parentOf(item.path)); break;
    case 'select': select?.(item); break;
    case 'info': showInfo(item); break;
    case 'trash': await trash([item], refresh); refresh?.(); break;
    default:
  }
  return {};
}
