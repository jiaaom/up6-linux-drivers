// Files: fnOS listings normalised to one item shape, the clipboard, recently
// opened files and favourites. No markup here.
//
//   item = { name, path, dir, size, mtime, v }   (path is absolute: /vol2/1000/Photos)
//
// Places (what a folder page lists):
//   { kind: 'home' }            我的文件: the merged home of every volume (no paste here)
//   { kind: 'team' }            团队文件: the team folders
//   { kind: 'fav' }             收藏
//   { kind: 'path', path }      a real folder

import { api } from '../core/api.js';
import { emitter } from '../core/events.js';
import { load, save } from '../core/storage.js';
import { account } from './stores.js';

const EXT = {};
for (const [kind, list] of Object.entries({
  image: 'jpg jpeg png gif webp bmp heic heif avif tiff tif jxl svg ico dng raw arw cr2 cr3 nef raf orf rw2 srw pef',
  video: 'mp4 mov mkv avi webm m4v wmv flv mpg mpeg ts 3gp',
  audio: 'mp3 wav flac aac ogg m4a opus aiff wma',
  pdf: 'pdf',
  text: 'txt md rtf log',
  doc: 'doc docx odt pages epub',
  sheet: 'xls xlsx csv ods numbers',
  slides: 'ppt pptx key odp',
  code: 'sh bash zsh js mjs ts jsx tsx py rs c cc cpp h hpp go java rb php html htm css scss json yaml yml toml xml ini conf cfg sql lua vue',
  archive: 'zip tar gz tgz bz2 xz 7z rar zst iso dmg',
})) for (const e of list.split(' ')) EXT[e] = kind;

const ICON = {
  folder: 'folder', image: 'file-image', video: 'file-video', audio: 'file-audio', pdf: 'file-pdf', text: 'file-text',
  doc: 'file-doc', sheet: 'file-xls', slides: 'file-ppt', code: 'file-code', archive: 'file-zip', other: 'file',
};

export const extOf = (name) => (/\.([^.]+)$/.exec(name || '')?.[1] ?? '').toLowerCase();

/** The file-icon kind (Ridgeline FileIcon data-kind). */
export const kindOf = (item) => (item.dir ? 'folder' : EXT[extOf(item.name)] ?? 'other');
export const iconOf = (item) => ICON[kindOf(item)];
/** Plays in mpv rather than opening in Preview. */
export const playable = (item) => ['video', 'audio'].includes(kindOf(item));

export const join = (dir, name) => `${String(dir).replace(/\/+$/, '')}/${name}`;
export const baseName = (p) => String(p).replace(/\/+$/, '').split('/').pop();
export const parentOf = (p) => String(p).replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';

/** "我的文件 / Photos / 2026" for a path under a home folder. */
export function displayPath(path, homeLabel) {
  const m = /^\/vol\d+\/\d+(\/.*)?$/.exec(path);
  if (m) return [homeLabel, ...(m[1] ?? '').split('/').filter(Boolean)].join(' / ');
  return path;
}

function normalise(raw, dirPath) {
  const uid = account.data?.uid;
  return (raw ?? []).map((f) => ({
    name: f.name,
    dir: !!f.dir,
    size: f.size ?? 0,
    mtime: f.mtim ?? 0,
    v: f.v,
    path: f.path ?? (dirPath ? join(dirPath, f.name) : f.v != null && uid != null ? `/vol${f.v}/${uid}/${f.name}` : f.name),
  }));
}

/** The items of a place. */
export async function listPlace(place) {
  switch (place.kind) {
    case 'home': return normalise((await api.get('fnos/files')).files);
    case 'team': return normalise((await api.get('fnos/team-files')).files);
    case 'fav': return normalise((await api.get('fnos/favorites')).files);
    default: return normalise((await api.get(`fnos/files?path=${encodeURIComponent(place.path)}`)).files, place.path);
  }
}

/** Search every volume (fnOS's index), or one folder when `path` is given. */
export async function search(q, path) {
  const d = await api.get(`fnos/search?q=${encodeURIComponent(q)}${path ? `&path=${encodeURIComponent(path)}` : ''}`);
  return normalise(d.files);
}

// ---------- favourites ----------

export const favourites = { set: new Set(), changed: emitter() };

export async function loadFavourites() {
  try {
    const d = await api.get('fnos/favorites');
    favourites.set = new Set((d.files ?? []).map((f) => f.path));
    favourites.changed.emit();
  } catch { /* signed out */ }
}

export async function setFavourite(path, on) {
  await api.post('fnos/files/fav', { path, on });
  if (on) favourites.set.add(path); else favourites.set.delete(path);
  favourites.changed.emit();
}

// ---------- recently opened (kept here: fnOS's own list stays empty for the panel) ----------

export const recents = {
  list: () => load('files.recent') ?? [],
  push(item) {
    const list = recents.list().filter((x) => x.path !== item.path);
    list.unshift({ name: item.name, path: item.path, dir: item.dir, size: item.size, mtime: item.mtime, at: Date.now() / 1000 });
    save('files.recent', list.slice(0, 12));
  },
  clear() { save('files.recent', null); },
};

// ---------- clipboard: copy / move, then paste in another folder ----------

export const clipboard = {
  /** { op: 'copy' | 'move', items: [item], from: folder path } or null */
  value: load('files.clip'),
  changed: emitter(),
  set(v) { clipboard.value = v; save('files.clip', v); clipboard.changed.emit(v); },
};

/** Why a paste can't land in `place`, or '' when it can. */
export function pasteBlocked(place) {
  const c = clipboard.value;
  if (!c) return 'empty';
  if (place.kind !== 'path') return 'notFolder';
  if (c.op === 'move' && c.from === place.path) return 'sameFolder';
  if (c.items.some((i) => i.dir && (place.path === i.path || place.path.startsWith(`${i.path}/`)))) return 'intoItself';
  return '';
}

/** "北坡清晨.jpg 等 3 项" */
export function itemsLabel(items, t) {
  if (items.length === 1) return items[0].name;
  return t('files.andMore', { name: items[0].name, n: items.length });
}
