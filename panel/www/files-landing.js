// File Manager — landing page (design 1b): quick roots, recents, and the
// "Devices & volumes" card with Eject / Mount / Connect / Disconnect / Reconnect.
// Depends on files.js (core).

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
      fmSvg(FM_ICON[s.icon], 48, { op: s.hot ? 1 : .85, stroke: s.hot ? 'var(--accent-text)' : 'currentColor', sw: 3 }) +
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
        fmSvg(FM_ICON[isDir ? 'folder' : fmCat(nm, false)], 26, { op: isDir ? .9 : .6, stroke: isDir ? 'var(--accent-text)' : 'currentColor', flex: true }) +
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
/* ---------- Devices & volumes card ----------
   Local volumes always come from t6-paneld's own statvfs (works signed out).
   External (USB) drives and fnOS "Remote Mount" connections come from fnOS
   itself when signed in (api/fnos/externals → stor.listDisk/listRemovable,
   appcgi.mountmgr.list), which is what enables Eject / Mount / Connect /
   Disconnect. Signed out, externals fall back to the local lsblk view
   (browse only). Format is deliberately not offered anywhere. */
var FM_DEV = { disks: [], remote: [] };
// Disks ejected from this panel, by USB serial → model. fnOS's Eject is a real
// safe-removal (media stopped, disk gone from fnOS) meant to be followed by
// unplugging; for a reader built into the chassis that's impossible, so we keep
// a Reconnect row (local USB re-enumeration via api/usb/reconnect) until the
// disk shows up again with media.
function fmEjectedLoad() { try { return JSON.parse(localStorage.getItem('t6.files.ejected') || '{}') || {}; } catch (e) { return {}; } }
function fmEjectedSave(m) { try { localStorage.setItem('t6.files.ejected', JSON.stringify(m)); } catch (e) {} }
function fmLoadDevices() {
  var seq = ++FM.devSeq;
  var local = fetch('api/storage', { cache: 'no-store' }).then(function (r) { return r.json(); });
  var ext = fetch('api/fnos/externals', { cache: 'no-store' }).then(function (r) { return r.json(); }).catch(function () { return null; });
  Promise.all([local, ext]).then(function (res) {
    if (seq !== FM.devSeq) return; // a newer load superseded this one
    var d = res[0], x = res[1];
    var box = document.getElementById('fmDevices'); if (!box) return;
    var live = !!(x && !x.error && Array.isArray(x.disks));
    FM_DEV = live ? x : { disks: [], remote: [] };
    var rows = [];
    (d.volumes || []).forEach(function (v) {
      var free = (v.total_bytes || 0) - (v.used_bytes || 0);
      rows.push({ kind: 'vol', path: v.mount, name: v.name, sub: fmtB(free) + ' free of ' + fmtB(v.total_bytes), icon: 'drive', tag: '' });
    });
    if (live) {
      x.disks.forEach(function (dk) {
        var n = dk.parts.length, m = dk.parts.filter(function (p) { return p.mounted; }).length;
        rows.push({ kind: 'disk', disk: dk.name, serial: dk.serial, name: dk.model, icon: 'usb', tag: (dk.interface || 'USB') + (dk.usb_version ? ' ' + dk.usb_version : ''),
          sub: fmtB(dk.size) + ' · ' + (n ? (n === 1 ? '1 partition' : n + ' partitions') + (m < n ? ' · ' + (n - m) + ' not mounted' : '') : 'no partitions'),
          btn: dk.mounted ? 'Eject' : 'Mount', act: dk.mounted ? 'eject' : 'mount' });
        dk.parts.forEach(function (p) {
          rows.push({ kind: 'part', sub2: true, disk: dk.name, path: p.mounted ? p.path : null, name: p.mount_name || p.name, icon: 'folder',
            sub: p.mounted ? fmtB(p.frsize) + ' free of ' + fmtB(p.fssize) + (p.fstype ? ' · ' + p.fstype : '') : fmtB(p.size) + (p.fstype ? ' · ' + p.fstype : '') + ' · not mounted' });
        });
      });
      x.remote.forEach(function (r) {
        rows.push({ kind: 'remote', id: r.id, path: r.connected ? r.mount_point : null, name: r.label || r.mount_point || 'Remote mount', icon: 'remote', tag: 'Remote',
          sub: [r.protocol ? String(r.protocol).toUpperCase() : null, r.host, r.connected ? null : (r.state || 'Disconnected')].filter(Boolean).join(' · '),
          btn: r.connected ? 'Disconnect' : 'Connect', act: r.connected ? 'disconnect' : 'connect' });
      });
    } else {
      (d.disks || []).forEach(function (dk) {
        if (!dk.removable) return;
        (dk.parts || []).forEach(function (p) {
          if (!p.mount) return;
          rows.push({ kind: 'part', path: p.mount, name: p.label || dk.model || p.name, sub: fmtB(p.size_bytes) + ' · ' + (p.fstype || 'ext'), icon: 'drive', tag: 'Removable' });
        });
      });
    }
    var ej = fmEjectedLoad(), ejChanged = false;
    (d.disks || []).forEach(function (dk) {
      if (!dk.serial || !(dk.serial in ej)) return;
      if (dk.size_bytes > 0) { delete ej[dk.serial]; ejChanged = true; return; } // it's back (plugged in or reconnected)
      rows.push({ kind: 'ejected', serial: dk.serial, name: ej[dk.serial] || dk.model, icon: 'usb', tag: 'Ejected',
        sub: 'Safe to unplug · or reconnect to use it again', btn: 'Reconnect', act: 'reconnect' });
    });
    if (ejChanged) fmEjectedSave(ej);
    if (!rows.length) { box.innerHTML = '<div class="setrow"><div class="lbl muted">No mounted volumes</div></div>'; return; }
    box.innerHTML = rows.map(function (r, i) {
      var tappable = !!r.path;
      return (i ? '<div class="hairrow"></div>' : '') +
        '<div class="setrow fm-dev' + (tappable ? ' tap' : '') + (r.sub2 ? ' fm-devsub' : '') + '" data-i="' + i + '">' +
        '<div class="lbl" style="display:flex;align-items:center;gap:11px">' + fmSvg(FM_ICON[r.icon] || FM_ICON.drive, 22, { op: r.sub2 ? .55 : .8 }) +
        '<span>' + esc(r.name) + (r.tag ? ' <span class="fm-devtag">' + esc(r.tag) + '</span>' : '') + '<div class="edesc">' + esc(r.sub) + '</div></span></div>' +
        (r.btn ? '<div class="fm-devbtn' + (r.act === 'eject' || r.act === 'disconnect' ? ' warn' : '') + '" data-act="' + r.act + '">' + r.btn + '</div>' : (tappable ? '<div class="chev">›</div>' : '')) +
        '</div>';
    }).join('');
    box.querySelectorAll('.fm-dev').forEach(function (el) {
      var r = rows[+el.dataset.i];
      var btn = el.querySelector('.fm-devbtn');
      if (btn) btn.addEventListener('click', function (e) { e.stopPropagation(); fmDevAction(r); });
      if (r.path) el.addEventListener('click', function () {
        fmGo({ mode: 'browse', root: 'personal', path: r.path, title: r.name });
      });
    });
  }).catch(function () { var box = document.getElementById('fmDevices'); if (box) box.innerHTML = '<div class="setrow"><div class="lbl muted">Could not read storage.</div></div>'; });
}
// Eject / Mount (external disks) and Disconnect / Connect (remote mounts).
// The two that take something away confirm first; all four go through fnOS's
// own APIs and then reload the card.
function fmDevAction(r) {
  var run = function (url, body, doing, done) {
    toast(doing);
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) { return res.json(); })
      .then(function (d) {
        if (d && d.ok) { toast(done); setTimeout(fmLoadDevices, 4000); } // fnOS's own inventory lags a moment behind the kernel
        else if (fmIsAuthError(d)) { toast('Signed out — sign in again'); if (window.refreshFnos) refreshFnos(); }
        else { showConfirm('Failed', (d && d.error) || 'fnOS refused the request.', 'OK', false, function () {}); }
        fmLoadDevices();
      })
      .catch(function () { toast('Failed'); fmLoadDevices(); });
  };
  if (r.act === 'eject') {
    showConfirm('Eject ' + r.name + '?', 'Make sure no file transfers are using it. Once ejected it disappears from fnOS until it is unplugged and plugged back in — or reconnected from here.', 'Eject', true,
      function () {
        if (r.serial) { var ej = fmEjectedLoad(); ej[r.serial] = r.name; fmEjectedSave(ej); }
        run('api/fnos/disk/eject', { disk: r.disk }, 'Ejecting…', 'Ejected — safe to unplug');
      });
  } else if (r.act === 'reconnect') {
    run('api/usb/reconnect', { serial: r.serial }, 'Reconnecting…', 'Reconnected');
  } else if (r.act === 'mount') {
    run('api/fnos/disk/mount', { disk: r.disk }, 'Mounting…', 'Mounted');
  } else if (r.act === 'disconnect') {
    showConfirm('Disconnect ' + r.name + '?', 'Ongoing file tasks on this remote mount will be interrupted. The connection stays saved and can be reconnected here.', 'Disconnect', true,
      function () { run('api/fnos/remote/disconnect', { name: r.id }, 'Disconnecting…', 'Disconnected'); });
  } else if (r.act === 'connect') {
    run('api/fnos/remote/connect', { name: r.id }, 'Connecting…', 'Connected');
  }
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
