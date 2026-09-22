// File Manager — search (design 2d) via fnOS finder. Depends on files.js (core).

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
      fmSvg(FM_ICON[cat], 26, { op: e.dir ? .9 : .6, stroke: e.dir ? 'var(--accent-text)' : 'currentColor', flex: true }) +
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
