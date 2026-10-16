// Markup for files (Ridgeline List, Tile, FileIcon, Seal): a row in the
// contents list, a tile in the grid, the file-type icon, the 藏 seal.

import { html } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { day, sizeParts } from '../core/format.js';
import { t } from '../core/i18n.js';
import { iconOf, kindOf } from '../data/files.js';

/** The file-type icon (rl-ficon), 32px in a row, 52px on a tile. */
export const ficon = (item) => html`<span class="rl-ficon" data-kind="${kindOf(item)}">${icon(iconOf(item), 'light')}</span>`;

/** The small 藏 (favourite) seal. */
export const favSeal = () => html`<span class="rl-seal rl-seal--bai rl-seal--sm" role="img" aria-label="${t('files.faved')}"><span class="rl-seal__text">藏</span></span>`;

function value(item) {
  if (item.dir) return ['', ''];
  return sizeParts(item.size);
}

/** One row of the contents list. `select`: a checkbox row (a label) instead of a link. */
export function row(item, { select = false, checked = false, fav = false, sub } = {}) {
  const [v, unit] = value(item);
  const subLine = sub ?? (item.mtime ? day(item.mtime) : '');
  const inner = html`<span class="rl-toc__lead">${ficon(item)}</span><span class="rl-toc__main"><span class="rl-toc__title">${item.name}</span>${subLine ? html`<span class="rl-toc__sub">${subLine}</span>` : ''}</span><span class="rl-toc__leader"></span>${fav ? favSeal() : ''}<span class="rl-toc__value">${v}</span><span class="rl-toc__unit">${unit}</span>`;
  if (select) {
    return html`<li><label class="rl-toc__item${checked ? ' is-selected' : ''}" data-item="${item.path}"><input class="rl-check__input" type="checkbox"${checked ? html` checked` : ''} aria-label="${t('files.select', { name: item.name })}">${inner}</label></li>`;
  }
  return html`<li><a class="rl-toc__item" href="#" data-item="${item.path}">${inner}</a></li>`;
}

/** One tile of the grid. */
export function tile(item, { select = false, checked = false, fav = false } = {}) {
  const meta = item.dir ? (item.mtime ? day(item.mtime) : '') : sizeParts(item.size).join(' ');
  return html`<div class="rl-tile${checked ? ' is-selected' : ''}" data-item="${item.path}">
    <a class="rl-tile__link" href="#"><span class="rl-tile__plate">${ficon(item)}${!item.dir ? html`<span class="rl-tile__ext">${(item.name.split('.').pop() || '').slice(0, 5).toUpperCase()}</span>` : ''}</span>${fav ? favSeal() : ''}<span class="rl-tile__name">${item.name}</span><span class="rl-tile__meta">${meta}</span></a>
    ${select ? html`<input class="rl-check__input" type="checkbox"${checked ? html` checked` : ''} aria-label="${t('files.select', { name: item.name })}">` : ''}
  </div>`;
}

/** The head of an item sheet: icon, name and a line under it. */
export const itemHead = (item, sub) => html`<div class="rl-sheet__head rl-sheet__head--item"><span class="rl-toc__lead">${ficon(item)}</span><div><h2 class="rl-sheet__title">${item.name}</h2><p class="rl-sheet__sub">${sub}</p></div></div>`;
