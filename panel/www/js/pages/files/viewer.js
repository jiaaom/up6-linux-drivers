// The full-screen preview: a near-black layer over everything but the status
// bar (whose text turns light). The picture itself is drawn by fnOS's Preview
// app in a separate view Electron places over the stage (previewBridge); the
// panel draws only the bar above it, which always stays (Preview takes the
// taps, so they can't hide it). No foot: the name and date are in 信息, and
// the room goes to the picture.

import { el, html, on } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import { closeLayer, openLayer, sheet, toast } from '../../shell/layers.js';

let current = null; // { entry, node }

// Where the Preview view goes: below the bar, to the bottom of the screen.
// Ridgeline floats the bar over the stage (an <img> under it), but the
// Preview view is a separate surface stacked above the whole page, so over
// the full stage it hid the bar, and with it the way back.
function place(node) {
  const stage = node.querySelector('.rl-viewer__stage').getBoundingClientRect();
  const top = node.querySelector('.rl-viewer__bar').getBoundingClientRect().bottom + 4;
  return { x: Math.round(stage.left), y: Math.round(top), width: Math.round(stage.width), height: Math.round(stage.bottom - top) };
}

export function closeViewer() {
  if (!current) return;
  window.previewBridge?.close?.();
  document.getElementById('app').classList.remove('is-viewer');
  closeLayer(current.entry, { animate: false });
  current = null;
}

/** Open `item` full screen; `siblings` are the files around it (for "3 / 24"). */
export function openViewer(item, siblings, folderTitle) {
  if (!window.previewBridge?.open) { toast(t('files.previewPanelOnly')); return; }
  closeViewer();
  const i = siblings.findIndex((x) => x.path === item.path);
  const node = el(html`<div class="rl-viewer rl-viewer--external" role="dialog" aria-label="${item.name}">
    <div class="rl-viewer__bar"><a class="rl-backlink" href="#" data-close>${icon('caret-left')}${folderTitle || t('page.files')}</a><span class="rl-viewer__index">${siblings.length > 1 ? `${i + 1} / ${siblings.length}` : ''}</span>
      <button class="rl-btn rl-btn--secondary rl-btn--icon rl-glass" data-info aria-label="${t('files.info')}">${icon('info')}</button>
      <button class="rl-btn rl-btn--secondary rl-btn--icon rl-glass" data-more aria-label="${t('files.more')}">${icon('dots-three')}</button></div>
    <div class="rl-viewer__stage"></div>
  </div>`);
  const entry = openLayer(node, closeViewer);
  current = { entry, node };
  document.getElementById('app').classList.add('is-viewer');
  on(node, 'click', '[data-close]', (e) => { e.preventDefault(); closeViewer(); });
  // the actions live in actions.js, which imports this file; load it when asked
  on(node, 'click', '[data-info]', async () => {
    window.previewBridge.close?.();
    const a = await import('./actions.js');
    await a.showInfo(item);
    if (current?.node === node) window.previewBridge.open(item.path, place(node));
  });
  on(node, 'click', '[data-more]', async () => {
    window.previewBridge.close?.();
    const a = await import('./actions.js');
    const id = await sheet({
      title: item.name,
      actions: [
        { id: 'fav', icon: 'star', label: t('files.fav') },
        { id: 'copy', icon: 'copy', label: t('files.copy') },
        { id: 'move', icon: 'scissors', label: t('files.move') },
        { id: 'rename', icon: 'pencil-simple', label: t('files.rename') },
        { id: 'trash', icon: 'trash', label: t('files.trash'), danger: true },
      ],
    });
    const parent = item.path.replace(/\/[^/]*$/, '');
    if (id === 'fav') await a.toggleFavourite([item]);
    else if (id === 'copy' || id === 'move') { a.cut(id, [item], parent); closeViewer(); return; }
    else if (id === 'rename') { if (await a.rename(item)) { closeViewer(); return; } }
    else if (id === 'trash') { if (await a.trash([item])) { closeViewer(); return; } }
    if (current?.node === node) window.previewBridge.open(item.path, place(node));
  });
  requestAnimationFrame(() => window.previewBridge.open(item.path, place(node)));
}
