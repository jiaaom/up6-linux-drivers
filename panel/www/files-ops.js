// File Manager — write operations through fnOS's file API: per-item actions
// (rename / favorite / trash / restore / info), batch actions on a selection,
// the copy/move clipboard with collision handling, and mkdir.
// Depends on files.js (core) and files-browse.js (repaint after changes).

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
