// File Manager — dedicated #files screen. This file is the core every other
// files-*.js module builds on: icons, extension categories, roots, the FM
// state + persisted prefs, favorites set, the text prompt, recents/path
// helpers, screen open/close, navigation, render dispatch, header builders,
// and the small DOM helpers. Loaded first; the feature modules are:
//   files-landing.js  — landing page (recents, Devices & volumes card, eject/mount/remote)
//   files-browse.js   — list/grid browser, multi-select, bottom toolbar, menus, Preview
//   files-ops.js      — write ops: rename/favorite/trash/restore/mkdir, clipboard copy/move
//   files-search.js   — finder search
// All share the app's primitives: global #osk keyboard, toast(), esc(), fmtB(),
// showConfirm(). See design: Front Panel Apps.dc.html.

/* ---------- icons (48-grid stroke set, matching the design) ---------- */
function fmSvg(paths, size, opt) {
  opt = opt || {};
  var stroke = opt.stroke || 'currentColor';
  var op = opt.op != null ? opt.op : 1;
  var fill = opt.fill || 'none';
  return '<svg viewBox="0 0 48 48" fill="' + fill + '" stroke="' + stroke +
    '" stroke-width="' + (opt.sw || 3.2) + '" stroke-linecap="round" stroke-linejoin="round" style="width:' +
    size + 'px;height:' + size + 'px;opacity:' + op + (opt.flex ? ';flex:none' : '') + '">' + paths + '</svg>';
}
var FM_ICON = {
  folder: '<path d="M6 16v20a3 3 0 0 0 3 3h30a3 3 0 0 0 3-3V19a3 3 0 0 0-3-3H24l-4-5H9a3 3 0 0 0-3 3z"/>',
  personal: '<path d="M6 16v20a3 3 0 0 0 3 3h30a3 3 0 0 0 3-3V19a3 3 0 0 0-3-3H24l-4-5H9a3 3 0 0 0-3 3z"/><circle cx="24" cy="25" r="4"/><path d="M17 35a7 7 0 0 1 14 0"/>',
  team: '<path d="M6 16v20a3 3 0 0 0 3 3h30a3 3 0 0 0 3-3V19a3 3 0 0 0-3-3H24l-4-5H9a3 3 0 0 0-3 3z"/><circle cx="19" cy="25" r="3.5"/><circle cx="30" cy="25" r="3.5"/><path d="M13 35a6 6 0 0 1 12 0M25 35a6 6 0 0 1 11-1"/>',
  trash: '<path d="M9 15h30"/><path d="M19 15v-4h10v4"/><path d="M13 15l2.5 24a3 3 0 0 0 3 2.7h11a3 3 0 0 0 3-2.7L35 15"/><path d="M21 23v11M27 23v11"/>',
  fav: '<path d="M24 7l5.3 10.8 11.9 1.7-8.6 8.4 2 11.9L24 34.2l-10.6 5.6 2-11.9-8.6-8.4 11.9-1.7L24 7z"/>',
  image: '<rect x="7" y="9" width="34" height="30" rx="4"/><circle cx="17" cy="19" r="3.5"/><path d="M9 33l10-9 7 6 6-5 8 7"/>',
  video: '<rect x="6" y="11" width="36" height="26" rx="4"/><path d="M21 19l9 5-9 5v-10z"/>',
  audio: '<path d="M18 34V13l22-4v21"/><circle cx="13" cy="34" r="5"/><circle cx="35" cy="30" r="5"/>',
  doc: '<path d="M12 42V10a3 3 0 0 1 3-3h13l8 8v27a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z"/><path d="M28 7v8h8"/>',
  code: '<rect x="6" y="8" width="36" height="32" rx="4"/><path d="M17 19l-5 5 5 5"/><path d="M31 19l5 5-5 5"/><path d="M26 17l-4 14"/>',
  archive: '<path d="M6 12a3 3 0 0 1 3-3h30a3 3 0 0 1 3 3v24a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z"/><path d="M24 9v30"/><path d="M20 15h8M20 22h8M20 29h8"/>',
  file: '<path d="M12 42V10a3 3 0 0 1 3-3h13l8 8v27a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3z"/><path d="M28 7v8h8"/>',
  search: '<circle cx="21" cy="21" r="13"/><path d="M31 31l10 10"/>',
  more: '<circle cx="24" cy="11" r="2.6"/><circle cx="24" cy="24" r="2.6"/><circle cx="24" cy="37" r="2.6"/>',
  close: '<path d="M14 14l20 20M34 14L14 34"/>',
  info: '<circle cx="24" cy="24" r="16"/><path d="M24 22v11"/><path d="M24 16h.01"/>',
  list: '<path d="M8 14h32M8 24h32M8 34h32"/>',
  grid: '<rect x="8" y="8" width="14" height="14" rx="3"/><rect x="26" y="8" width="14" height="14" rx="3"/><rect x="8" y="26" width="14" height="14" rx="3"/><rect x="26" y="26" width="14" height="14" rx="3"/>',
  sort: '<path d="M14 10v28"/><path d="M8 32l6 6 6-6"/><path d="M26 14h14M26 24h10M26 34h6"/>',
  refresh: '<path d="M39 24a15 15 0 1 1-4.4-10.6"/><path d="M40 8v10H30"/>',
  usb: '<rect x="14" y="6" width="20" height="14" rx="3"/><path d="M18 20v10M30 20v10M12 30h24v10H12z"/><path d="M20 13h8"/>',
  remote: '<path d="M14 36h20a8 8 0 0 0 1-15.9A11 11 0 0 0 14 22a7 7 0 0 0 0 14z"/><path d="M20 30l4-4 4 4M24 26v10"/>',
  drive: '<rect x="9" y="9" width="30" height="30" rx="2"/><path d="M9 20h30"/><path d="M15 15h4M23 15h3"/>',
  chevron: '<path d="M18 12l12 12-12 12"/>',
  checkCircle: '<circle cx="24" cy="24" r="16"/><path d="M17 24l5 5 10-11"/>',
  rename: '<path d="M8 34l24-24 6 6-24 24H8z"/><path d="M28 14l6 6"/>',
  copy: '<rect x="16" y="16" width="24" height="24" rx="3"/><path d="M32 16V11a3 3 0 0 0-3-3H11a3 3 0 0 0-3 3v18a3 3 0 0 0 3 3h5"/>',
  move: '<path d="M8 12h14l4 4h14v20a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3z"/><path d="M20 30h14M28 24l6 6-6 6"/>',
  paste: '<path d="M18 8h12l3 4h5v28a3 3 0 0 1-3 3H13a3 3 0 0 1-3-3V12h5z"/><path d="M18 8v6h12V8"/><path d="M17 26h14M17 33h10"/>',
  folderPlus: '<path d="M6 16v20a3 3 0 0 0 3 3h30a3 3 0 0 0 3-3V19a3 3 0 0 0-3-3H24l-4-5H9a3 3 0 0 0-3 3z"/><path d="M24 24v10M19 29h10"/>'
};

/* ---------- extension → category (icon + label) ---------- */
var FM_EXT = {};
(function () {
  function add(cat, list) { list.split(' ').forEach(function (e) { FM_EXT[e] = cat; }); }
  add('image', 'jpg jpeg png gif webp bmp heic heif avif tiff tif jxl svg ico');
  add('image', 'dng raw arw cr2 cr3 nef raf orf rw2 srw pef'); // RAW
  add('video', 'mp4 mov mkv avi webm m4v wmv flv mpg mpeg ts 3gp');
  add('audio', 'mp3 wav flac aac ogg m4a opus aiff wma');
  add('doc', 'pdf doc docx odt rtf txt md pages xls xlsx csv ods ppt pptx key odp epub');
  add('code', 'sh bash zsh js mjs ts jsx tsx py rs c cc cpp h hpp go java rb php html htm css scss json yaml yml toml xml ini conf cfg log sql lua vue');
  add('archive', 'zip tar gz tgz bz2 xz 7z rar zst iso dmg');
})();
function fmExt(name) { var m = /\.([^.]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
function fmCat(name, dir) {
  if (dir) return 'folder';
  return FM_EXT[fmExt(name)] || 'file';
}

/* ---------- roots ---------- */
var FM_ROOTS = {
  personal: { title: 'Personal folder', icon: 'personal', api: 'api/fnos/files' },
  team: { title: 'Team folder', icon: 'team', api: 'api/fnos/team-files' },
  trash: { title: 'Trash', icon: 'trash', api: 'api/fnos/trash' },
  fav: { title: 'Favorites', icon: 'fav', api: 'api/fnos/favorites' }
};

/* ---------- state ---------- */
var FM = {
  cur: null,          // { mode:'landing'|'browse'|'search', root, path, title }
  stack: [],          // previous frames (back navigation)
  entries: [],        // raw listing of current browse frame
  view: 'list',       // 'list' | 'grid'
  sort: 'name',       // 'name' | 'date' | 'size'
  desc: false,        // sort direction
  hidden: false,      // show dotfiles
  showRecent: true,   // landing: show the Recent section
  reqSeq: 0, devSeq: 0,          // guards async listing races
  searchTimer: null,
  searchSeq: 0,
  prevPath: null      // path currently in the Preview overlay
};
try {
  var sv = localStorage.getItem('t6.files.prefs');
  if (sv) { sv = JSON.parse(sv); FM.view = sv.view || FM.view; FM.sort = sv.sort || FM.sort; FM.desc = !!sv.desc; FM.hidden = !!sv.hidden; if (sv.showRecent === false) FM.showRecent = false; }
} catch (e) {}
function fmSavePrefs() {
  try { localStorage.setItem('t6.files.prefs', JSON.stringify({ view: FM.view, sort: FM.sort, desc: FM.desc, hidden: FM.hidden, showRecent: FM.showRecent })); } catch (e) {}
}

/* ---------- favorites set (for accurate toggle labels) ---------- */
FM.favSet = null; // Set of favorited absolute paths
function fmLoadFav() {
  fetch('api/fnos/favorites', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
    FM.favSet = {};
    (d.files || []).forEach(function (f) { if (f.path) FM.favSet[f.path] = 1; });
  }).catch(function () { FM.favSet = FM.favSet || {}; });
}
function fmIsFav(path) { return !!(FM.favSet && FM.favSet[path]); }

/* ---------- text prompt (New folder / Rename) — uses global #osk ---------- */
function fmPrompt(title, label, initial, okText, cb) {
  var ov = document.getElementById('fmPrompt');
  ov.querySelector('.fm-prompt-title').textContent = title;
  var inp = ov.querySelector('#fmPromptInput');
  inp.placeholder = label || '';
  inp.value = initial || '';
  ov.querySelector('#fmPromptOk').textContent = okText || 'OK';
  var err = ov.querySelector('#fmPromptErr'); err.hidden = true;
  ov.classList.add('show');
  setTimeout(function () { inp.focus(); inp.select(); }, 60); // triggers #osk
  function done(val) { ov.classList.remove('show'); ov._ok = ov._cancel = null; if (val != null) cb(val); }
  ov._ok = function () {
    var v = inp.value.trim();
    if (!v) { err.textContent = 'Enter a name'; err.hidden = false; return; }
    if (/[\/]/.test(v)) { err.textContent = 'Name can’t contain “/”'; err.hidden = false; return; }
    done(v);
  };
  ov._cancel = function () { done(null); };
}

/* ---------- recents (client-side fallback, persisted) ---------- */
function fmRecents() { try { return JSON.parse(localStorage.getItem('t6.files.recents') || '[]'); } catch (e) { return []; } }
function fmPushRecent(item) {
  try {
    var r = fmRecents().filter(function (x) { return x.path !== item.path; });
    r.unshift({ path: item.path, name: item.name, root: item.root, dir: item.dir ? 1 : 0, ts: Date.now() });
    localStorage.setItem('t6.files.recents', JSON.stringify(r.slice(0, 12)));
  } catch (e) {}
}
function fmRelTime(ts) {
  var s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 604800) return Math.floor(s / 86400) + 'd';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmDate(sec) { if (!sec) return ''; return new Date(sec * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }

/* ---------- path helpers ---------- */
function fmJoin(p, n) { return String(p).replace(/\/+$/, '') + '/' + n; }
function fmBase(p) { var s = String(p || '').replace(/\/+$/, '').split('/'); return s[s.length - 1] || ''; }
function fmPersonalRoot() { return fnosUser ? '/vol1/' + fnosUser.uid : null; }

/* ---------- screen open / close ---------- */
var filesScroll = document.getElementById('filesScroll');
function fmOpenScreen() { document.body.classList.add('files-open'); }
function fmClose() {
  fmClosePreview();
  document.body.classList.remove('files-open');
  FM.cur = null; FM.stack = [];
}
// Public entry points ------------------------------------------------------
function showFiles(root) {
  if (!fnosUser) { toast('Sign in to browse files'); showLogin(); return; }
  FM.stack = [];
  FM.cur = null;
  fmLoadFav();
  fmOpenScreen();
  // Personal root starts at null → the aggregated (all-volumes) home listing.
  fmGo({ mode: 'browse', root: root, path: null, title: FM_ROOTS[root].title }, true);
}
function showFilesLanding() {
  if (!fnosUser) { toast('Sign in to browse files'); showLogin(); return; }
  FM.stack = [];
  FM.cur = null;
  fmLoadFav();
  fmOpenScreen();
  fmGo({ mode: 'landing', title: 'Files' }, true);
}

/* ---------- navigation ---------- */
function fmGo(frame, replace) {
  FM.sel = null; // leaving a folder ends selection mode
  fmClosePreview();
  if (FM.cur && !replace) FM.stack.push(FM.cur);
  FM.cur = frame;
  fmRender();
}
function fmBack() {
  if (FM.prevPath) { fmClosePreview(); return; }
  if (FM.stack.length) { FM.cur = FM.stack.pop(); fmRender(); }
  else fmClose();
}

/* ---------- render dispatch ---------- */
function fmRender() {
  if (!FM.cur) return;
  if (FM.cur.mode === 'landing') return fmRenderLanding();
  if (FM.cur.mode === 'search') return fmRenderSearch();
  return fmRenderBrowse();
}

/* ---------- header builders ---------- */
function fmRoundBtn(id, icon) {
  return '<div class="fm-rbtn" id="' + id + '">' + fmSvg(FM_ICON[icon], 22, { op: .85 }) + '</div>';
}
function fmHeader(opts) {
  // opts: {crumb (back destination name), title, sub (counts/desc), actions:[{id,icon}]}
  // Option A (design follow-up): the round Back button sits on the title row and
  // the destination name leads the subtitle ("‹ Workspace · 214 items"), so no
  // separate crumb row is needed and the button matches System/Settings.
  var back = opts.crumb == null ? '' :
    '<div class="fm-back" id="fmBack">' + fmSvg('<path d="M28 12L16 24l12 12"/>', 19, { op: .8, sw: 3.6 }) + '</div>';
  var acts = (opts.actions || []).map(function (a) { return fmRoundBtn(a.id, a.icon); }).join('');
  var sub = '<div class="fm-sub">' +
    (opts.crumb != null ? '<span class="fm-dest">‹ ' + esc(opts.crumb) + '</span>' : '') +
    '<span class="fm-cnt">' + (opts.sub ? (opts.crumb != null ? ' · ' : '') + esc(opts.sub) : '') + '</span></div>';
  return '<div class="fm-head"><div class="fm-hrow">' + back +
    '<div class="fm-htext"><div class="fm-title">' + esc(opts.title) + '</div>' + sub + '</div>' +
    '<div class="fm-acts">' + acts + '</div></div><div class="fm-hair"></div></div>';
}
function fmStatus() {
  return '<div class="fm-status"><span class="clock2"></span><span class="fm-status-r">Files</span></div>';
}

/* ---------- small helpers: body/scroll setters + action sheet ---------- */
function fmSetBody(html) {
  var screen = document.getElementById('files');
  // preserve the preview overlay + bottom bar elements; replace the flow content
  var bar = document.getElementById('fmBar');
  var prev = document.getElementById('fmPrev');
  screen.querySelectorAll('.fm-status,.fm-head,#filesScroll').forEach(function (n) { n.remove(); });
  bar.insertAdjacentHTML('beforebegin', html);
  filesScroll = document.getElementById('filesScroll');
  if (filesScroll) filesScroll.scrollTop = 0;
}
function fmSetScroll(html) { var s = document.getElementById('filesScroll'); if (s) s.innerHTML = html; }
function fmBindHeader() {
  var sb = document.getElementById('fmSearchBtn');
  if (sb) sb.addEventListener('click', function () { fmGo({ mode: 'search', root: FM.cur.root, path: FM.cur.path, scope: FM.cur.path ? 'folder' : 'all', q: '', title: 'Search' }); });
  var mb = document.getElementById('fmMoreBtn');
  if (mb) mb.addEventListener('click', fmMoreMenu);
  fmBindCrumb();
}
function fmBindCrumb() {
  var c = document.getElementById('fmBack');
  if (c) c.addEventListener('click', fmBack);
}
function fmSheet(title, bodyHtml, onMount) {
  var el = document.getElementById('fmSheet');
  el.querySelector('.fm-sheet-title').textContent = title;
  el.querySelector('.fm-sheet-body').innerHTML = bodyHtml;
  document.getElementById('fmSheetScrim').classList.add('show');
  el.classList.add('show');
  if (onMount) onMount(el);
}
function fmCloseSheet() {
  document.getElementById('fmSheet').classList.remove('show');
  document.getElementById('fmSheetScrim').classList.remove('show');
}

/* ---------- static wiring (buttons that live in index.html) ---------- */
document.addEventListener('DOMContentLoaded', function () {
  var back = document.getElementById('fmPrevBack'); if (back) back.addEventListener('click', fmClosePreview);
  var scrim = document.getElementById('fmSheetScrim'); if (scrim) scrim.addEventListener('click', fmCloseSheet);
  var ov = document.getElementById('fmPrompt');
  if (ov) {
    document.getElementById('fmPromptOk').addEventListener('click', function () { if (ov._ok) ov._ok(); });
    document.getElementById('fmPromptCancel').addEventListener('click', function () { if (ov._cancel) ov._cancel(); });
    document.getElementById('fmPromptInput').addEventListener('keydown', function (e) { if (e.key === 'Enter' && ov._ok) ov._ok(); });
  }
});
