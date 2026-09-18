// File Manager — dedicated #files screen: landing, list/grid browser, search,
// and the system-Preview chrome. Kept in its own module so the home/settings
// code doesn't grow with it. Read-only (navigate + preview + search); write ops
// (copy/move/delete/select) are deferred until fnOS write APIs are verified.
// Reuses the app's shared primitives: global #osk keyboard (native inputs),
// toast(), esc(), fmtB(), showConfirm(). See design: Front Panel Apps.dc.html.

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
  reqSeq: 0,          // guards async listing races
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

/* ---------- LANDING (design 1b) ---------- */
function fmRenderLanding() {
  document.getElementById('fmBar').hidden = true;
  var uid = fnosUser ? fnosUser.uid : '';
  var shortcuts = [
    { root: 'personal', label: 'Personal folder', icon: 'personal', hot: true },
    { root: 'team', label: 'Team folder', icon: 'team' },
    { root: 'trash', label: 'Trash can', icon: 'trash' },
    { root: 'fav', label: 'Favorites', icon: 'fav' }
  ].map(function (s) {
    return '<div class="fm-pin' + (s.hot ? ' hot' : '') + '" data-root="' + s.root + '">' +
      fmSvg(FM_ICON[s.icon], 48, { op: s.hot ? 1 : .85, stroke: s.hot ? 'var(--amber)' : 'currentColor', sw: 3 }) +
      '<div class="fm-pin-l">' + s.label + '</div></div>';
  }).join('');

  var html = fmStatus() +
    fmHeader({ crumb: 'Home', title: 'Files', sub: 'Shortcuts, recent activity & devices',
      actions: [{ id: 'fmSearchBtn', icon: 'search' }, { id: 'fmLandingMore', icon: 'more' }] }) +
    '<div class="scroll" id="filesScroll">' +
    '<div class="fm-sec">Pinned</div><div class="fm-pins">' + shortcuts + '</div>' +
    '<div id="fmRecentWrap"></div>' +
    '<div class="fm-sec">Devices &amp; volumes</div><div class="card" id="fmDevices"><div class="wifi-empty">Loading…</div></div>' +
    '</div>';
  fmSetBody(html);

  fmLoadRecents();
  fmLoadDevices();
  fmBindLanding();
}
function fmLoadRecents() {
  if (!FM.showRecent) { var w0 = document.getElementById('fmRecentWrap'); if (w0) w0.innerHTML = ''; return; }
  fetch('api/fnos/recent', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
    var wrap = document.getElementById('fmRecentWrap'); if (!wrap) return;
    var items = (d.recent || []).filter(function (x) { return x.path && !x.errno; }).slice(0, 8);
    if (!items.length) { wrap.innerHTML = ''; return; }
    var rows = items.map(function (r) {
      var nm = fmBase(r.path), isDir = r.dir === 1 || r.dir === true;
      var when = r.datetime || r.mtim;
      return '<div class="fm-row fm-recent" data-path="' + esc(r.path) + '" data-name="' + esc(nm) + '" data-dir="' + (isDir ? 1 : 0) + '">' +
        fmSvg(FM_ICON[isDir ? 'folder' : fmCat(nm, false)], 26, { op: isDir ? .9 : .6, stroke: isDir ? 'var(--amber2)' : 'currentColor', flex: true }) +
        '<div class="fm-info"><div class="fm-name">' + esc(nm) + '</div><div class="fm-meta">' + esc(fmParentLabel(r.path) + (when ? ' · ' + fmRelTime(when * 1000) : '')) + '</div></div></div>';
    }).join('');
    wrap.innerHTML = '<div class="fm-sec">Recent</div><div class="fm-list">' + rows + '</div>';
    wrap.querySelectorAll('.fm-recent').forEach(function (el) {
      el.addEventListener('click', function () {
        if (el.dataset.dir === '1') fmGo({ mode: 'browse', root: 'personal', path: el.dataset.path, title: el.dataset.name });
        else fmOpenPreview(el.dataset.path, el.dataset.name, 'personal');
      });
    });
  }).catch(function () { var w = document.getElementById('fmRecentWrap'); if (w) w.innerHTML = ''; });
}
function fmParentLabel(path) {
  var s = String(path || '').replace(/\/+$/, '').split('/'); s.pop();
  var parent = s[s.length - 1] || '';
  return parent || 'Files';
}
function fmLoadDevices() {
  fetch('api/storage', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
    var box = document.getElementById('fmDevices'); if (!box) return;
    var rows = [];
    (d.volumes || []).forEach(function (v) {
      var free = (v.total_bytes || 0) - (v.used_bytes || 0);
      rows.push({ path: v.mount, name: v.name, sub: fmtB(free) + ' free of ' + fmtB(v.total_bytes), icon: 'drive', tag: '' });
    });
    (d.disks || []).forEach(function (dk) {
      if (!dk.removable) return;
      (dk.parts || []).forEach(function (p) {
        if (!p.mount) return;
        rows.push({ path: p.mount, name: p.label || dk.model || p.name, sub: fmtB(p.size_bytes) + ' · ' + (p.fstype || 'ext'), icon: 'drive', tag: 'Removable' });
      });
    });
    if (!rows.length) { box.innerHTML = '<div class="setrow"><div class="lbl muted">No mounted volumes</div></div>'; return; }
    box.innerHTML = rows.map(function (r, i) {
      return (i ? '<div class="hairrow"></div>' : '') +
        '<div class="setrow tap fm-dev" data-path="' + esc(r.path) + '" data-name="' + esc(r.name) + '">' +
        '<div class="lbl" style="display:flex;align-items:center;gap:11px">' + fmSvg(FM_ICON[r.icon], 22, { op: .8 }) +
        '<span>' + esc(r.name) + (r.tag ? ' <span class="fm-devtag">' + r.tag + '</span>' : '') + '<div class="edesc">' + esc(r.sub) + '</div></span></div>' +
        '<div class="chev">›</div></div>';
    }).join('');
    document.querySelectorAll('#fmDevices .fm-dev').forEach(function (el) {
      el.addEventListener('click', function () {
        fmGo({ mode: 'browse', root: 'personal', path: el.dataset.path, title: el.dataset.name });
      });
    });
  }).catch(function () { var box = document.getElementById('fmDevices'); if (box) box.innerHTML = '<div class="setrow"><div class="lbl muted">Could not read storage.</div></div>'; });
}
function fmBindLanding() {
  document.querySelectorAll('#files .fm-pin').forEach(function (el) {
    el.addEventListener('click', function () { showFilesFromLanding(el.dataset.root); });
  });
  // .fm-recent rows are bound in fmLoadRecents (populated asynchronously).
  var mb = document.getElementById('fmLandingMore'); if (mb) mb.addEventListener('click', fmLandingMenu);
  var sb = document.getElementById('fmSearchBtn');
  if (sb) sb.addEventListener('click', function () { fmGo({ mode: 'search', root: 'personal', path: fmPersonalRoot(), scope: 'all', title: 'Search' }); });
  fmBindCrumb();
}
// ⋯ menu on the Files landing page: toggles for what the page shows.
function fmLandingMenu() {
  var body =
    '<div class="fm-mrow" data-a="recent"><span>Show recent</span><span class="fm-mcheck">' + (FM.showRecent ? '✓' : '') + '</span></div>';
  fmSheet('Files', body, function (sheet) {
    sheet.querySelectorAll('.fm-mrow').forEach(function (row) {
      row.addEventListener('click', function () {
        var a = row.dataset.a; fmCloseSheet();
        if (a === 'recent') { FM.showRecent = !FM.showRecent; fmSavePrefs(); fmRenderLanding(); toast(FM.showRecent ? 'Recent shown' : 'Recent hidden'); }
      });
    });
  });
}
function showFilesFromLanding(root) {
  fmGo({ mode: 'browse', root: root, path: null, title: FM_ROOTS[root].title });
}

/* ---------- BROWSE (design 2a list / 2b grid) ---------- */
function fmFetchUrl(frame) {
  if (frame.path == null) {
    if (frame.root === 'team') return 'api/fnos/team-files';
    if (frame.root === 'trash') return 'api/fnos/trash';
    if (frame.root === 'fav') return 'api/fnos/favorites';
    // Personal root, no path → aggregated home across all volumes.
    if (frame.root === 'personal') return 'api/fnos/files';
  }
  if (frame.root === 'team' && frame.path != null) return 'api/fnos/team-files?path=' + encodeURIComponent(frame.path);
  return 'api/fnos/files?path=' + encodeURIComponent(frame.path);
}
function fmSortEntries(files) {
  var arr = files.slice();
  arr.sort(function (a, b) {
    var ad = a.dir ? 1 : 0, bd = b.dir ? 1 : 0;
    if (ad !== bd) return bd - ad; // folders first, always
    var r = 0;
    if (FM.sort === 'date') r = (a.mtim || 0) - (b.mtim || 0);
    else if (FM.sort === 'size') r = (a.size || 0) - (b.size || 0);
    else r = String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
    return FM.desc ? -r : r;
  });
  return arr;
}
function fmVisible(files) {
  return FM.hidden ? files : files.filter(function (f) { return String(f.name || '')[0] !== '.'; });
}
// Listing cache (stale-while-revalidate). fnOS occasionally stalls a request
// for 0.3–4 s (backend latency variance, and it serializes requests on the
// connection), which showed as a long "Loading…" — worst when going BACK to a
// folder we'd already listed. Cached folders now paint instantly and refresh in
// the background; only a genuinely new folder does a cold fetch.
FM.cache = {};
function fmCacheKey(f) { return f.root + '|' + (f.path == null ? '' : f.path); }
function fmCachePut(key, files) {
  FM.cache[key] = { files: files, ts: Date.now() };
  var keys = Object.keys(FM.cache);
  if (keys.length > 60) { // bound it: drop the oldest
    keys.sort(function (a, b) { return FM.cache[a].ts - FM.cache[b].ts; });
    delete FM.cache[keys[0]];
  }
}
function fmSameListing(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].mtim !== b[i].mtim || a[i].size !== b[i].size || !!a[i].dir !== !!b[i].dir) return false;
  }
  return true;
}
function fmRenderBrowse() {
  var f = FM.cur;
  var atRoot = FM.stack.length === 0 || (f.path === fmPersonalRoot() && f.root === 'personal');
  var backLabel = FM.stack.length ? (fmBase(FM.stack[FM.stack.length - 1].title) || 'Back') : 'Files';
  var key = fmCacheKey(f);
  var cached = FM.cache[key];
  var html = fmStatus() +
    fmHeader({ crumb: backLabel, title: f.title || FM_ROOTS[f.root].title, sub: '…',
      actions: [{ id: 'fmSearchBtn', icon: 'search' }, { id: 'fmMoreBtn', icon: 'more' }] }) +
    '<div class="scroll" id="filesScroll">' + (cached ? '' : '<div class="wifi-empty">Loading…</div>') + '</div>';
  fmSetBody(html);
  fmRenderBar();
  fmBindHeader();
  if (cached) { FM.entries = cached.files; fmPaint(); } // instant paint, then revalidate

  var seq = ++FM.reqSeq;
  fetch(fmFetchUrl(f), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
    if (seq !== FM.reqSeq) return; // navigated away
    // A dead fnOS session comes back either as our {error} (backend cleared it)
    // or a raw {result:"fail"} with no files — show a sign-in prompt, never a
    // misleading "empty folder".
    if (fmIsAuthError(d)) { fmAuthPrompt(); return; }
    if (d.error) { if (!cached) fmSetScroll('<div class="wifi-empty">' + esc(d.error) + '</div>'); return; }
    if (!d.files && !(d.data && d.data.files) && d.result === 'fail') {
      if (!cached) fmSetScroll('<div class="wifi-empty">Could not load this folder.</div>'); return;
    }
    var files = d.files || (d.data && d.data.files) || [];
    // trash entries aren't reachable at their shown path
    if (f.root === 'trash') files = files.map(function (x) { return Object.assign({}, x, { noLink: true }); });
    var changed = !cached || !fmSameListing(cached.files, files);
    fmCachePut(key, files);
    if (changed) { FM.entries = files; fmPaint(); } // skip repaint if identical (no flicker)
  }).catch(function () { if (seq === FM.reqSeq && !cached) fmSetScroll('<div class="wifi-empty">Could not list folder.</div>'); });
}
// A not-signed-in response: our backend's session-expired error, or a raw fnOS
// "not logged in" (errno 4224) fail frame.
function fmIsAuthError(d) {
  if (d && d.error && /sign in|session expired|not signed/i.test(d.error)) return true;
  return !!(d && d.result === 'fail' && d.errno === 4224);
}
function fmAuthPrompt() {
  if (window.refreshFnos) window.refreshFnos(); // flip the home account chip to signed-out
  fmSetScroll('<div class="fm-authwarn"><div class="fm-authtitle">Signed out</div>' +
    '<div class="fm-authsub">Your fnOS session expired. Sign in again to see your files.</div>' +
    '<div class="fm-authbtn" id="fmAuthSignin">Sign in</div></div>');
  var b = document.getElementById('fmAuthSignin');
  if (b) b.addEventListener('click', function () {
    fmClose();
    showLogin();
  });
}
function fmPaint() {
  var f = FM.cur;
  var vis = fmVisible(FM.entries);
  var sorted = fmSortEntries(vis);
  var nDir = vis.filter(function (x) { return x.dir; }).length;
  var nFile = vis.length - nDir;
  var sub = vis.length ? (vis.length + ' item' + (vis.length === 1 ? '' : 's') +
    (nDir && nFile ? ' · ' + nDir + ' folder' + (nDir === 1 ? '' : 's') : '')) : 'Empty';
  var cntEl = document.querySelector('#files .fm-sub .fm-cnt'); if (cntEl) cntEl.textContent = ' · ' + sub;

  if (!sorted.length) { fmSetScroll('<div class="wifi-empty">' + (f.root === 'trash' ? 'Trash is empty' : f.root === 'team' ? 'No team folders' : f.root === 'fav' ? 'No favorites yet' : 'Empty folder') + '</div>'); return; }
  fmSetScroll(FM.view === 'grid' ? fmGridHtml(sorted, f) : fmListHtml(sorted, f));
  fmBindRows();
}
function fmRowMeta(e) {
  if (e.rmTime) return 'Deleted ' + fmDate(e.rmTime);
  if (e.dir) return e.mtim ? fmDate(e.mtim) : '';
  return (e.size != null ? fmtB(e.size) : '') + (e.mtim ? ' · ' + fmDate(e.mtim) : '');
}
function fmPathFor(e, f) {
  if (e.path) return e.path;
  // Aggregated personal root: entries carry a volume number `v`; the real path
  // is /vol{v}/{uid}/{name} (fnOS merges homes from all volumes at the root).
  if (f.root === 'personal' && f.path == null && fnosUser) {
    return '/vol' + (e.v != null ? e.v : 1) + '/' + fnosUser.uid + '/' + e.name;
  }
  return f.path != null ? fmJoin(f.path, e.name) : e.name;
}
/* ---------- multi-select ----------
   Entered from the bottom-bar "Select" pill (design 2a/2b) or a long-press →
   "Select". In selection mode every row/tile shows the design's check-circle,
   a tap toggles instead of opening, and the bottom bar becomes the action bar
   (Cancel · N selected · all · Copy · Move · Favorite · Trash / Restore) — the
   header stays a plain breadcrumb, per the design note. FM.sel = null when not
   selecting, else an object used as a set of selected paths. */
FM.sel = null;
function fmSelecting() { return FM.sel !== null; }
function fmSelStart(path) {
  if (!FM.cur || FM.cur.mode !== 'browse') return;
  FM.sel = {};
  if (path) FM.sel[path] = 1;
  fmPaint(); fmRenderBar();
}
function fmSelEnd() { if (!fmSelecting()) return; FM.sel = null; fmPaint(); fmRenderBar(); }
function fmSelToggle(path) {
  if (!fmSelecting()) return;
  if (FM.sel[path]) delete FM.sel[path]; else FM.sel[path] = 1;
  fmSelPaintRow(path); fmRenderBar();
}
function fmSelPaintRow(path) {
  document.querySelectorAll('#files .fm-row, #files .fm-gcell').forEach(function (el) {
    if (el.dataset.path !== path) return;
    var on = !!FM.sel[path];
    el.classList.toggle('sel', on);
    var c = el.querySelector('.fm-check'); if (c) c.classList.toggle('on', on);
  });
}
function fmSelItems() {
  var f = FM.cur, out = [];
  (FM.entries || []).forEach(function (e) {
    var p = fmPathFor(e, f);
    if (FM.sel && FM.sel[p]) out.push({ path: p, name: e.name, dir: !!e.dir, entry: e });
  });
  return out;
}
function fmSelCount() { return FM.sel ? Object.keys(FM.sel).length : 0; }
function fmSelAll(on) {
  var f = FM.cur; FM.sel = {};
  if (on) fmVisible(FM.entries || []).forEach(function (e) { FM.sel[fmPathFor(e, f)] = 1; });
  fmPaint(); fmRenderBar();
}
function fmCheckHtml(on) {
  return '<span class="fm-check' + (on ? ' on' : '') + '">' + fmSvg(FM_ICON.checkCircle, 24, { op: 1 }) + '</span>';
}

function fmListHtml(files, f) {
  var selecting = fmSelecting();
  return '<div class="fm-list">' + files.map(function (e) {
    var cat = fmCat(e.name, e.dir);
    var ic = fmSvg(FM_ICON[cat], 26, { op: e.dir ? .9 : .6, stroke: e.dir ? 'var(--amber2)' : 'currentColor', flex: true });
    var noLink = e.noLink, p = fmPathFor(e, f), on = selecting && !!FM.sel[p];
    return '<div class="fm-row' + (noLink ? ' nolink' : '') + (on ? ' sel' : '') + '" data-path="' + esc(p) + '" data-name="' + esc(e.name) + '" data-dir="' + (e.dir ? 1 : 0) + '">' +
      ic + '<div class="fm-info"><div class="fm-name">' + esc(e.name) + '</div><div class="fm-meta">' + esc(fmRowMeta(e)) + '</div></div>' +
      (selecting ? fmCheckHtml(on) : (e.dir && !noLink ? '<span class="fm-chev">›</span>' : '')) + '</div>';
  }).join('') + '</div>';
}
function fmGridHtml(files, f) {
  var selecting = fmSelecting();
  return '<div class="fm-grid">' + files.map(function (e) {
    var cat = fmCat(e.name, e.dir);
    var badge = e.dir ? '' : (fmExt(e.name).toUpperCase() || 'FILE');
    var p = fmPathFor(e, f), on = selecting && !!FM.sel[p];
    var tile = '<div class="fm-gtile"><div class="fm-gthumb' + (e.dir ? ' dir' : '') + '">' +
      fmSvg(FM_ICON[cat], e.dir ? 46 : 40, { op: e.dir ? .85 : .3, stroke: e.dir ? 'var(--amber2)' : 'currentColor', sw: e.dir ? 3 : 3.2 }) +
      (badge ? '<div class="fm-gbadge">' + esc(badge) + '</div>' : '') +
      (selecting ? '<span class="fm-gcheck">' + fmCheckHtml(on) + '</span>' : '') + '</div>' +
      '<div class="fm-gname">' + esc(e.name) + '</div><div class="fm-gmeta">' + esc(e.dir ? (e.mtim ? fmDate(e.mtim) : 'Folder') : (e.size != null ? fmtB(e.size) : '')) + '</div></div>';
    return '<div class="fm-gcell' + (on ? ' sel' : '') + '" data-path="' + esc(p) + '" data-name="' + esc(e.name) + '" data-dir="' + (e.dir ? 1 : 0) + '">' + tile + '</div>';
  }).join('') + '</div>';
}
function fmFindEntry(path, name) {
  return (FM.entries || []).filter(function (e) {
    return (e.path && e.path === path) || e.name === name;
  })[0];
}
// Long-press opens the per-item action sheet; a normal tap opens/previews.
// Trash rows are ".nolink" (not navigable) but still get the long-press so you
// can Restore them.
function fmBindLongPress(el, onTap, onHold) {
  var timer = null, held = false, sx = 0, sy = 0;
  function start(x, y) {
    held = false; sx = x; sy = y;
    timer = setTimeout(function () { held = true; if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} } onHold(); }, 480);
  }
  function move(x, y) { if (timer && (Math.abs(x - sx) > 10 || Math.abs(y - sy) > 10)) { clearTimeout(timer); timer = null; } }
  function end() { if (timer) { clearTimeout(timer); timer = null; } }
  el.addEventListener('touchstart', function (e) { start(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  el.addEventListener('touchmove', function (e) { move(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  el.addEventListener('touchend', end);
  el.addEventListener('mousedown', function (e) { start(e.clientX, e.clientY); });
  el.addEventListener('mousemove', function (e) { move(e.clientX, e.clientY); });
  el.addEventListener('mouseup', end);
  el.addEventListener('click', function () { if (held) { held = false; return; } onTap(); });
}
function fmBindRows() {
  document.querySelectorAll('#files .fm-row, #files .fm-gcell').forEach(function (el) {
    var name = el.dataset.name, path = el.dataset.path, isDir = el.dataset.dir === '1';
    fmBindLongPress(el,
      function () { // tap
        if (fmSelecting()) { fmSelToggle(path); return; }
        if (el.classList.contains('nolink')) { fmItemActions(fmFindEntry(path, name), path, name, isDir); return; }
        if (isDir) { fmPushRecent({ path: path, name: name, root: FM.cur.root, dir: 1 }); fmGo({ mode: 'browse', root: FM.cur.root, path: path, title: name }); }
        else fmOpenPreview(path, name, FM.cur.root);
      },
      function () { // hold
        if (fmSelecting()) { fmSelToggle(path); return; }
        fmItemActions(fmFindEntry(path, name), path, name, isDir);
      }
    );
  });
}

/* ---------- per-item actions (Rename / Favorite / Trash / Restore / Info) ---------- */
function fmItemActions(entry, path, name, isDir) {
  entry = entry || {};
  var rows = [];
  if (FM.cur.root === 'trash') {
    rows.push(['restore', 'Restore', FM_ICON.refresh]);
  } else {
    rows.push(['open', isDir ? 'Open' : 'Preview', isDir ? FM_ICON.folder : FM_ICON.info]);
    var faved = fmIsFav(path) || FM.cur.root === 'fav';
    rows.push(['fav', faved ? 'Remove from Favorites' : 'Add to Favorites', FM_ICON.fav]);
    rows.push(['rename', 'Rename', FM_ICON.rename || FM_ICON.file]);
    rows.push(['copy', 'Copy', FM_ICON.copy]);
    rows.push(['move', 'Move', FM_ICON.move]);
    rows.push(['select', 'Select…', FM_ICON.checkCircle]);
    if (isDir) rows.push(['size', 'Folder size', FM_ICON.info]);
    rows.push(['trash', 'Move to Trash', FM_ICON.trash, true]);
  }
  var body = rows.map(function (r) {
    return '<div class="fm-mrow' + (r[3] ? ' danger' : '') + '" data-a="' + r[0] + '"><span>' + r[1] + '</span>' + fmSvg(r[2], 20, { op: .7 }) + '</div>';
  }).join('');
  fmSheet(name, body, function (sheet) {
    sheet.querySelectorAll('.fm-mrow').forEach(function (row) {
      row.addEventListener('click', function () {
        var a = row.dataset.a; fmCloseSheet();
        if (a === 'open') { if (isDir) fmGo({ mode: 'browse', root: FM.cur.root, path: path, title: name }); else fmOpenPreview(path, name, FM.cur.root); }
        else if (a === 'fav') fmDoFav(path, !(fmIsFav(path) || FM.cur.root === 'fav'));
        else if (a === 'rename') fmDoRename(path, name);
        else if (a === 'copy') fmClipSet('copy', { path: path, name: name, dir: isDir });
        else if (a === 'move') fmClipSet('move', { path: path, name: name, dir: isDir });
        else if (a === 'select') fmSelStart(path);
        else if (a === 'size') fmDoSize(path, name);
        else if (a === 'trash') fmDoTrash(path, name);
        else if (a === 'restore') fmDoRestore(entry, name);
      });
    });
  });
}
function fmRefreshCurrent() {
  // After a write op, drop the cached listing so we don't flash stale rows.
  if (FM.cur && FM.cur.mode === 'browse') { delete FM.cache[fmCacheKey(FM.cur)]; fmRenderBrowse(); }
}

/* ---------- clipboard: Copy / Move (cut) → Paste, via fnOS file.cp / file.mv ----------
   fnOS's copy/move are tasks; the backend streams them to completion and reports
   real success/failure. IMPORTANT: on a name collision fnOS's default strategy is
   SKIP — it silently skips the file yet still reports "succ". So we pre-check
   collisions against the destination listing and ask (Replace / Keep both / Skip),
   sending the numeric strategy: 0=Skip, 1=Replace, 2=Rename(keep both). */
FM.clip = null;    // { op:'copy'|'move', items:[{path,name,dir}], from:<srcFolder> }
FM.pasting = false;
function fmClipSet(op, item) {
  FM.clip = { op: op, items: [{ path: item.path, name: item.name, dir: !!item.dir }], from: (FM.cur && FM.cur.path) || null };
  toast((op === 'copy' ? 'Copied “' : 'Move “') + item.name + '” — open a folder and Paste');
  fmRenderBar();
}
function fmClipClear() { FM.clip = null; fmRenderBar(); }
function fmClipSetMany(op, items) {
  if (!items.length) return;
  FM.clip = { op: op, items: items.map(function (i) { return { path: i.path, name: i.name, dir: !!i.dir }; }), from: (FM.cur && FM.cur.path) || null };
  var what = items.length === 1 ? '“' + items[0].name + '”' : items.length + ' items';
  toast((op === 'copy' ? 'Copied ' : 'Move ') + what + ' — open a folder and Paste');
}

/* ---------- batch actions on the current selection ---------- */
function fmSelTrash() {
  var items = fmSelItems(); if (!items.length) return;
  var what = items.length === 1 ? '“' + items[0].name + '”' : items.length + ' items';
  showConfirm('Move to Trash', what + ' will be moved to Trash. You can restore them later.', 'Move to Trash', true, function () {
    fetch('api/fnos/files/trash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: items.map(function (i) { return i.path; }) }) })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (fmIsAuthError(d)) { fmAuthPrompt(); return; }
        if (d.error) { toast(d.error); return; }
        items.forEach(function (i) { if (FM.favSet) delete FM.favSet[i.path]; });
        toast('Moved ' + what + ' to Trash'); FM.sel = null; fmRefreshCurrent();
      }).catch(function () { toast('Failed'); });
  });
}
function fmSelFav() {
  var items = fmSelItems(); if (!items.length) return;
  // If everything selected is already a favorite, remove; otherwise add all.
  var allFav = items.every(function (i) { return fmIsFav(i.path) || FM.cur.root === 'fav'; });
  var on = !allFav, done = 0, failed = 0;
  (function next(k) {
    if (k >= items.length) {
      toast((on ? 'Added ' : 'Removed ') + (items.length === 1 ? '“' + items[0].name + '”' : items.length + ' items') + (on ? ' to Favorites' : ' from Favorites') + (failed ? ' (' + failed + ' failed)' : ''));
      fmSelEnd(); if (FM.cur.root === 'fav') fmRefreshCurrent(); return;
    }
    var p = items[k].path;
    fetch('api/fnos/files/fav', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p, on: on }) })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (d && !d.error) { done++; if (FM.favSet) { if (on) FM.favSet[p] = 1; else delete FM.favSet[p]; } } else failed++;
        next(k + 1);
      }).catch(function () { failed++; next(k + 1); });
  })(0);
}
function fmSelRestore() {
  var items = fmSelItems(); if (!items.length) return;
  var paths = items.map(function (i) { return fmTrashInternalPath(i.entry, i.name); });
  fetch('api/fnos/trash/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: paths }) })
    .then(function (r) { return r.json(); }).then(function (d) {
      if (fmIsAuthError(d)) { fmAuthPrompt(); return; }
      if (d.error) { toast(d.error); return; }
      toast('Restored ' + (items.length === 1 ? '“' + items[0].name + '”' : items.length + ' items'));
      FM.sel = null; setTimeout(fmRefreshCurrent, 400);
    }).catch(function () { toast('Restore failed'); });
}
// Paste is allowed only in a concrete folder. The Personal root is the
// aggregated all-volumes view (no real directory) — fnOS's own file browser
// disallows pasting there too. Trash / flat roots are never targets.
function fmCanPaste() {
  return !!(FM.clip && !fmSelecting() && FM.cur && FM.cur.mode === 'browse' && FM.cur.path && FM.cur.root !== 'trash');
}
var FM_ERR = {
  4100: 'File or folder no longer exists',
  4224: 'Session expired — sign in again',
  327685: 'Can’t move a folder into itself',
  100000002: 'Invalid request'
};
function fmErrMsg(errno, fallback) { return (errno != null && FM_ERR[errno]) || fallback || ('Error ' + (errno != null ? errno : '')); }
function fmDoPaste() {
  if (!fmCanPaste() || FM.pasting) return;
  var clip = FM.clip, dest = FM.cur.path;
  var items = clip.items;
  // moving into the folder it's already in is a no-op
  if (clip.op === 'move' && clip.from === dest) { toast('Already in this folder'); return; }
  // moving a folder into itself / its own subtree — fnOS rejects (errno 327685); say so up front
  for (var i = 0; i < items.length; i++) {
    if (items[i].dir && clip.op === 'move' && (dest === items[i].path || dest.indexOf(items[i].path + '/') === 0)) { toast('Can’t move a folder into itself'); return; }
  }
  // collision pre-check against the current (destination) listing
  var here = {}; (FM.entries || []).forEach(function (e) { here[e.name] = 1; });
  var clashes = items.filter(function (it) { return here[it.name]; });
  if (!clashes.length) { fmPasteSend(clip, dest, 0); return; }
  var body = '<div class="fm-sheet-note">' + (clashes.length === 1 ? '“' + esc(clashes[0].name) + '” already exists here.' : clashes.length + ' items already exist here.') + '</div>' +
    '<div class="fm-mrow" data-s="1"><span>Replace</span>' + fmSvg(FM_ICON.refresh, 20, { op: .7 }) + '</div>' +
    '<div class="fm-mrow" data-s="2"><span>Keep both</span>' + fmSvg(FM_ICON.folderPlus, 20, { op: .7 }) + '</div>' +
    '<div class="fm-mrow" data-s="0"><span>Skip existing</span>' + fmSvg(FM_ICON.close, 20, { op: .7 }) + '</div>';
  fmSheet(clip.op === 'copy' ? 'Copy conflict' : 'Move conflict', body, function (sheet) {
    sheet.querySelectorAll('.fm-mrow').forEach(function (row) {
      row.addEventListener('click', function () { var s = +row.dataset.s; fmCloseSheet(); fmPasteSend(clip, dest, s); });
    });
  });
}
function fmPasteSend(clip, dest, strategy) {
  FM.pasting = true;
  var verb = clip.op === 'copy' ? 'Copying' : 'Moving';
  toast(verb + '…');
  fetch('api/fnos/files/' + clip.op, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: clip.items.map(function (i) { return i.path; }), to: dest, overwrite: strategy }) })
    .then(function (r) { return r.json(); }).then(function (d) {
      FM.pasting = false;
      if (fmIsAuthError(d)) { fmAuthPrompt(); return; }
      if (d.error) { fmPasteFail(clip, d.error); return; }
      if (d.pending) { toast(verb + ' in the background — refresh in a moment'); fmRefreshCurrent(); return; }
      if (!d.ok) {
        var failed = d.failedFiles || [];
        var msg = failed.length
          ? (failed.length === 1 ? fmErrMsg(failed[0].errno, 'Failed') + ': ' + fmBase(failed[0].file || '')
                                 : failed.length + ' items failed (' + fmErrMsg(failed[0].errno, 'error') + ')')
          : fmErrMsg(d.errno, clip.op === 'copy' ? 'Copy failed' : 'Move failed');
        fmPasteFail(clip, msg); return;
      }
      var n = clip.items.length;
      toast((clip.op === 'copy' ? 'Copied ' : 'Moved ') + (n === 1 ? '“' + clip.items[0].name + '”' : n + ' items') + (strategy === 0 && d.failedFilesCount ? ' (some skipped)' : ''));
      // the source folder's listing changed on move; the destination's on both
      Object.keys(FM.cache).forEach(function (k) { if (k.endsWith('|' + dest) || (clip.from && k.endsWith('|' + clip.from))) delete FM.cache[k]; });
      if (clip.op === 'move') fmClipClear(); // a copy stays on the clipboard for re-pasting
      fmRefreshCurrent();
    }).catch(function () { FM.pasting = false; fmPasteFail(clip, 'Network error'); });
}
function fmPasteFail(clip, msg) {
  showConfirm(clip.op === 'copy' ? 'Copy failed' : 'Move failed', msg, 'OK', false, function () {});
  fmRefreshCurrent();
}
function fmDoRename(path, name) {
  fmPrompt('Rename', 'New name', name, 'Rename', function (newName) {
    if (newName === name) return;
    fetch('api/fnos/files/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path, newName: newName }) })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (d.error) { toast(d.error); return; }
        toast('Renamed'); if (FM.favSet) fmLoadFav(); fmRefreshCurrent();
      }).catch(function () { toast('Rename failed'); });
  });
}
function fmDoFav(path, on) {
  fetch('api/fnos/files/fav', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path, on: on }) })
    .then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { toast(d.error); return; }
      if (FM.favSet) { if (on) FM.favSet[path] = 1; else delete FM.favSet[path]; }
      toast(on ? 'Added to Favorites' : 'Removed from Favorites');
      if (FM.cur.root === 'fav') fmRefreshCurrent();
    }).catch(function () { toast('Failed'); });
}
function fmDoTrash(path, name) {
  showConfirm('Move to Trash', '“' + name + '” will be moved to Trash. You can restore it later.', 'Move to Trash', true, function () {
    fetch('api/fnos/files/trash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [path] }) })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (d.error) { toast(d.error); return; }
        toast('Moved to Trash'); if (FM.favSet) delete FM.favSet[path]; fmRefreshCurrent();
      }).catch(function () { toast('Failed'); });
  });
}
function fmTrashInternalPath(entry, name) {
  // fnOS restores by the trash-internal path vol{v}/{uid}/.@#local/trash/{name}
  var v = entry && entry.v != null ? entry.v : 1;
  var uid = entry && entry.uid != null ? entry.uid : (fnosUser ? fnosUser.uid : 0);
  return 'vol' + v + '/' + uid + '/.@#local/trash/' + name;
}
function fmDoRestore(entry, name) {
  var ip = fmTrashInternalPath(entry, name);
  fetch('api/fnos/trash/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [ip] }) })
    .then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { toast(d.error); return; }
      toast('Restored'); setTimeout(fmRefreshCurrent, 400);
    }).catch(function () { toast('Restore failed'); });
}
function fmDoSize(path, name) {
  showDetail(name, [['Calculating…', '']]);
  fetch('api/fnos/folder-size?path=' + encodeURIComponent(path), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
    if (d.error) { showDetail(name, [['Error', d.error]]); return; }
    showDetail(name, [
      ['Size', fmtB(d.fileSizeTotal != null ? d.fileSizeTotal : d.space)],
      ['Files', d.fileCount != null ? String(d.fileCount) : '—'],
      ['Folders', d.dirCount != null ? String(d.dirCount) : '—'],
      ['Path', path]
    ]);
  }).catch(function () { showDetail(name, [['Error', 'Could not calculate size']]); });
}
function fmDoMkdir() {
  var base = FM.cur.path || fmPersonalRoot();
  if (!base) { toast('Can’t create here'); return; }
  fmPrompt('New folder', 'Folder name', 'Untitled folder', 'Create', function (nm) {
    fetch('api/fnos/files/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: base, name: nm }) })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (d.error) { toast(d.error); return; }
        toast('Folder created'); fmRefreshCurrent();
      }).catch(function () { toast('Could not create folder'); });
  });
}

/* ---------- bottom toolbar: view toggle + sort + Select, or the selection action bar ---------- */
function fmRenderBar() {
  var bar = document.getElementById('fmBar');
  bar.hidden = false;
  if (fmSelecting()) { fmRenderSelBar(bar); return; }
  var sortLabel = { name: 'Name', date: 'Date', size: 'Size' }[FM.sort] + (FM.desc ? ' ↓' : ' ↑');
  var canSelect = (FM.entries || []).length > 0;
  bar.innerHTML =
    '<div class="fm-seg">' +
      '<div class="fm-segb' + (FM.view === 'list' ? ' on' : '') + '" data-v="list">' + fmSvg(FM_ICON.list, 22, { op: FM.view === 'list' ? .9 : .5 }) + '</div>' +
      '<div class="fm-segb' + (FM.view === 'grid' ? ' on' : '') + '" data-v="grid">' + fmSvg(FM_ICON.grid, 22, { op: FM.view === 'grid' ? .9 : .5 }) + '</div>' +
    '</div><div class="fm-barspace"></div>' +
    (fmCanPaste() ? '<div class="fm-pill fm-pill-hot" id="fmPastePill">' + fmSvg(FM_ICON.paste, 20, { op: .9 }) + '<span>' + (FM.clip.op === 'copy' ? 'Paste' : 'Move here') + '</span></div>' : '') +
    '<div class="fm-pill" id="fmSortPill">' + fmSvg(FM_ICON.sort, 20, { op: .75 }) + '<span>' + sortLabel + '</span></div>' +
    (canSelect ? '<div class="fm-pill" id="fmSelectPill">' + fmSvg(FM_ICON.checkCircle, 20, { op: .75 }) + '<span>Select</span></div>' : '');
  var pp = document.getElementById('fmPastePill'); if (pp) pp.addEventListener('click', fmDoPaste);
  var sp = document.getElementById('fmSelectPill'); if (sp) sp.addEventListener('click', function () { fmSelStart(); });
  bar.querySelectorAll('.fm-segb').forEach(function (b) {
    b.addEventListener('click', function () { if (FM.view !== b.dataset.v) { FM.view = b.dataset.v; fmSavePrefs(); fmRenderBar(); fmPaint(); } });
  });
  document.getElementById('fmSortPill').addEventListener('click', fmSortMenu);
}
// Selection action bar: Cancel · "N selected" · select-all · then the batch
// actions available in this view (Trash view only offers Restore).
function fmRenderSelBar(bar) {
  var n = fmSelCount(), total = fmVisible(FM.entries || []).length, inTrash = FM.cur.root === 'trash';
  function btn(id, icon, label, danger) {
    return '<div class="fm-selbtn' + (n ? '' : ' off') + (danger ? ' danger' : '') + '" id="' + id + '">' + fmSvg(FM_ICON[icon], 21, { op: .9 }) + '<span>' + label + '</span></div>';
  }
  bar.innerHTML =
    '<div class="fm-pill" id="fmSelCancel">Cancel</div>' +
    '<div class="fm-selcount">' + (n ? n + ' selected' : 'Select items') + '</div>' +
    '<div class="fm-barspace"></div>' +
    '<div class="fm-selbtn" id="fmSelAll">' + fmSvg(FM_ICON.checkCircle, 21, { op: n === total && total ? 1 : .6 }) + '<span>' + (n === total && total ? 'None' : 'All') + '</span></div>' +
    (inTrash
      ? btn('fmSelRestore', 'refresh', 'Restore')
      : btn('fmSelCopy', 'copy', 'Copy') + btn('fmSelMove', 'move', 'Move') + btn('fmSelFav', 'fav', 'Favorite') + btn('fmSelTrash', 'trash', 'Trash', true));
  document.getElementById('fmSelCancel').addEventListener('click', fmSelEnd);
  document.getElementById('fmSelAll').addEventListener('click', function () { fmSelAll(!(n === total && total)); });
  function on(id, fn) { var el = document.getElementById(id); if (el) el.addEventListener('click', function () { if (fmSelCount()) fn(); }); }
  on('fmSelCopy', function () { fmClipSetMany('copy', fmSelItems()); fmSelEnd(); });
  on('fmSelMove', function () { fmClipSetMany('move', fmSelItems()); fmSelEnd(); });
  on('fmSelFav', fmSelFav);
  on('fmSelTrash', fmSelTrash);
  on('fmSelRestore', fmSelRestore);
}
function fmSortMenu() {
  var opts = [['name', 'Name'], ['date', 'Date modified'], ['size', 'Size']];
  var body = opts.map(function (o) {
    return '<div class="fm-mrow" data-s="' + o[0] + '"><span>' + o[1] + '</span>' + (FM.sort === o[0] ? fmSvg(FM_ICON.chevron, 18, { op: 0 }) + '<span class="fm-mcheck">' + (FM.desc ? '↓' : '↑') + '</span>' : '') + '</div>';
  }).join('') + '<div class="hairrow"></div>' +
    '<div class="fm-mrow" data-s="dir"><span>Reverse order</span></div>' +
    '<div class="fm-mrow" data-s="hidden"><span>Show hidden files</span><span class="fm-mcheck">' + (FM.hidden ? '✓' : '') + '</span></div>';
  fmSheet('Sort & view', body, function (sheet) {
    sheet.querySelectorAll('.fm-mrow').forEach(function (row) {
      row.addEventListener('click', function () {
        var s = row.dataset.s;
        if (s === 'dir') FM.desc = !FM.desc;
        else if (s === 'hidden') FM.hidden = !FM.hidden;
        else { if (FM.sort === s) FM.desc = !FM.desc; else { FM.sort = s; FM.desc = false; } }
        fmSavePrefs(); fmCloseSheet(); fmRenderBar(); fmPaint();
      });
    });
  });
}

/* ---------- header "more" menu ---------- */
function fmMoreMenu() {
  var canCreate = !!(FM.cur.path || (FM.cur.root === 'personal'));
  var pasteRow = '';
  if (FM.clip) {
    var n = FM.clip.items.length, what = n === 1 ? '“' + esc(FM.clip.items[0].name) + '”' : n + ' items';
    var label = (FM.clip.op === 'copy' ? 'Paste ' : 'Move here ') + what;
    if (fmCanPaste()) pasteRow = '<div class="fm-mrow" data-a="paste"><span>' + label + '</span>' + fmSvg(FM_ICON.paste, 20, { op: .7 }) + '</div>';
    else pasteRow = '<div class="fm-mrow disabled"><span>' + label + '</span><span class="fm-mhint">' + (FM.cur.path ? 'not here' : 'open a folder') + '</span></div>';
    pasteRow += '<div class="fm-mrow" data-a="clearclip"><span>Clear clipboard</span>' + fmSvg(FM_ICON.close, 20, { op: .7 }) + '</div><div class="hairrow"></div>';
  }
  var body = pasteRow +
    (canCreate ? '<div class="fm-mrow" data-a="mkdir"><span>New folder</span>' + fmSvg(FM_ICON.folderPlus || FM_ICON.folder, 20, { op: .7 }) + '</div>' : '') +
    '<div class="fm-mrow" data-a="refresh"><span>Refresh</span>' + fmSvg(FM_ICON.refresh, 20, { op: .7 }) + '</div>' +
    '<div class="fm-mrow" data-a="hidden"><span>Show hidden files</span><span class="fm-mcheck">' + (FM.hidden ? '✓' : '') + '</span></div>' +
    (FM.cur.path ? '<div class="fm-mrow" data-a="info"><span>Folder size</span>' + fmSvg(FM_ICON.info, 20, { op: .7 }) + '</div>' : '');
  fmSheet(FM.cur.title || 'Folder', body, function (sheet) {
    sheet.querySelectorAll('.fm-mrow').forEach(function (row) {
      row.addEventListener('click', function () {
        var a = row.dataset.a;
        if (!a) return; // disabled row
        fmCloseSheet();
        if (a === 'paste') fmDoPaste();
        else if (a === 'clearclip') { fmClipClear(); toast('Clipboard cleared'); }
        else if (a === 'mkdir') fmDoMkdir();
        else if (a === 'refresh') fmRefreshCurrent();
        else if (a === 'hidden') { FM.hidden = !FM.hidden; fmSavePrefs(); fmPaint(); }
        else if (a === 'info') fmDoSize(FM.cur.path, FM.cur.title || 'Folder');
      });
    });
  });
}

/* ---------- SEARCH (design 2d) ---------- */
function fmRenderSearch() {
  document.getElementById('fmBar').hidden = true;
  var f = FM.cur;
  var scopeChips = [['folder', 'This folder'], ['all', 'Personal'], ['fav', 'Favorites']]
    .map(function (c) { return '<div class="fm-chip' + (f.scope === c[0] ? ' on' : '') + '" data-s="' + c[0] + '">' + c[1] + '</div>'; }).join('');
  var html = fmStatus() +
    '<div class="fm-head"><div class="fm-searchrow">' +
      '<div class="fm-searchbox">' + fmSvg(FM_ICON.search, 22, { op: .7 }) +
        '<input id="fmSearchInput" class="fm-searchinput" type="text" placeholder="Search files" autocapitalize="none" autocomplete="off" spellcheck="false">' +
        '<span class="fm-searchclear" id="fmSearchClear">' + fmSvg(FM_ICON.close, 18, { op: .5 }) + '</span></div>' +
      '<div class="fm-cancel" id="fmSearchCancel">Cancel</div></div>' +
      '<div class="fm-chips">' + scopeChips + '</div><div class="fm-hair"></div></div>' +
    '<div class="scroll" id="filesScroll"><div class="wifi-empty">Type to search this NAS.</div></div>';
  fmSetBody(html);
  var input = document.getElementById('fmSearchInput');
  input.value = f.q || '';
  document.getElementById('fmSearchCancel').addEventListener('click', fmBack);
  document.getElementById('fmSearchClear').addEventListener('click', function () { input.value = ''; f.q = ''; input.focus(); fmDoSearch(); });
  document.querySelectorAll('#files .fm-chip').forEach(function (c) {
    c.addEventListener('click', function () { f.scope = c.dataset.s; document.querySelectorAll('#files .fm-chip').forEach(function (x) { x.classList.toggle('on', x === c); }); fmDoSearch(); });
  });
  input.addEventListener('input', function () { f.q = input.value; if (FM.searchTimer) clearTimeout(FM.searchTimer); FM.searchTimer = setTimeout(fmDoSearch, 280); });
  setTimeout(function () { input.focus(); }, 60); // triggers global #osk
  if (f.q) fmDoSearch();
}
function fmSearchFolderPath() {
  // the nearest browse frame with a concrete path (the folder we came from)
  for (var i = FM.stack.length - 1; i >= 0; i--) if (FM.stack[i].mode === 'browse' && FM.stack[i].path) return FM.stack[i].path;
  return null;
}
function fmDoSearch() {
  var f = FM.cur;
  var q = (f.q || '').trim();
  if (q.length < 2) { fmSetScroll('<div class="wifi-empty">' + (q ? 'Keep typing…' : 'Type to search this NAS.') + '</div>'); return; }
  var seq = ++FM.searchSeq;
  fmSetScroll('<div class="wifi-empty">Searching…</div>');
  // Favorites: filter the flat fav list client-side (no walk needed).
  if (f.scope === 'fav') {
    fetch('api/fnos/favorites', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      if (seq !== FM.searchSeq) return;
      var hits = (d.files || []).filter(function (x) { return String(x.name || '').toLowerCase().indexOf(q.toLowerCase()) >= 0; });
      fmPaintSearch(hits, false, q);
    }).catch(function () { if (seq === FM.searchSeq) fmSetScroll('<div class="wifi-empty">Search failed.</div>'); });
    return;
  }
  // Indexed finder search (all volumes). "This folder" restricts to the current
  // subtree; "Personal" searches all the user's files.
  var url = 'api/fnos/search?scope=my-files&q=' + encodeURIComponent(q);
  if (f.scope === 'folder') {
    var p = fmSearchFolderPath();
    if (p) url += '&path=' + encodeURIComponent(p);
  }
  fetch(url, { cache: 'no-store' })
    .then(function (r) { return r.json(); }).then(function (d) {
      if (seq !== FM.searchSeq) return;
      if (fmIsAuthError(d)) { fmAuthPrompt(); return; }
      if (d.error) { fmSetScroll('<div class="wifi-empty">' + esc(d.error) + '</div>'); return; }
      fmPaintSearch(d.files || [], d.capped, q);
    }).catch(function () { if (seq === FM.searchSeq) fmSetScroll('<div class="wifi-empty">Search failed.</div>'); });
}
function fmPaintSearch(files, capped, q) {
  if (!files.length) { fmSetScroll('<div class="wifi-empty">No matches for “' + esc(q) + '”.</div>'); return; }
  var head = '<div class="fm-results-head">' + files.length + (capped ? '+' : '') + ' match' + (files.length === 1 ? '' : 'es') + '</div>';
  var rows = files.map(function (e) {
    var cat = fmCat(e.name, e.dir);
    var loc = e.loc ? fmBase(e.loc) || e.loc : '';
    var meta = (loc ? loc : '') + (e.dir ? '' : (e.size != null ? ' · ' + fmtB(e.size) : ''));
    return '<div class="fm-row" data-path="' + esc(e.path || e.name) + '" data-name="' + esc(e.name) + '" data-dir="' + (e.dir ? 1 : 0) + '" data-loc="' + esc(e.loc || '') + '">' +
      fmSvg(FM_ICON[cat], 26, { op: e.dir ? .9 : .6, stroke: e.dir ? 'var(--amber2)' : 'currentColor', flex: true }) +
      '<div class="fm-info"><div class="fm-name">' + esc(e.name) + '</div><div class="fm-meta">' + esc(meta) + '</div></div>' +
      (e.dir ? '<span class="fm-chev">›</span>' : '') + '</div>';
  }).join('');
  fmSetScroll(head + '<div class="fm-list">' + rows + '</div>');
  document.querySelectorAll('#files .fm-row').forEach(function (el) {
    el.addEventListener('click', function () {
      var name = el.dataset.name, path = el.dataset.path;
      if (el.dataset.dir === '1') { FM.stack.push(FM.cur); FM.cur = { mode: 'browse', root: 'personal', path: path, title: name }; fmRender(); }
      else fmOpenPreview(path, name, 'personal');
    });
  });
}

/* ---------- PREVIEW (design 2c) — system Preview app in the viewport ---------- */
function fmOpenPreview(path, name, root) {
  fmPushRecent({ path: path, name: name, root: root || (FM.cur && FM.cur.root) || 'personal', dir: 0 });
  if (!(window.previewBridge && window.previewBridge.open)) { toast('Preview is only available on the panel'); return; }
  var ov = document.getElementById('fmPrev');
  ov.querySelector('.fm-prev-name').textContent = name || 'Preview';
  ov.querySelector('.fm-prev-view').innerHTML = '';
  ov.hidden = false;
  FM.prevPath = path;
  FM._prevName = name; FM._prevActualPath = path;
  requestAnimationFrame(function () {
    var r = ov.querySelector('.fm-prev-view').getBoundingClientRect();
    window.previewBridge.open(path, { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
  });
}
function fmClosePreview() {
  var ov = document.getElementById('fmPrev');
  if (!ov || ov.hidden) return;
  if (window.previewBridge && window.previewBridge.close) window.previewBridge.close();
  ov.hidden = true;
  FM.prevPath = null;
}
function fmPreviewInfo() {
  showDetail(FM._prevName || 'File', [['Name', FM._prevName], ['Path', FM._prevActualPath]]);
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
