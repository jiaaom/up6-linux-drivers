// File Manager — the browser (design 2a list / 2b grid): fetching + caching
// listings, painting rows/tiles, multi-select, long-press, the bottom toolbar
// and its menus, and the system Preview chrome (design 2c).
// Depends on files.js (core); actions it triggers live in files-ops.js.

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
