# Panel UI

The front panel's interface (t6-panel 2.0 and later), built on the Ridgeline
design system.

Plain ES modules, no build step: t6-paneld serves this folder as it is
(`--www`), and Electron loads it like any page.

## Layout

```
index.html            the one page: Ridgeline CSS, app.css, js/main.js
css/app.css           the panel's own CSS on top of Ridgeline (shell, page additions)
ridgeline/<version>/  Ridgeline, vendored: tokens.css, bundle.css, fonts, icons. Never edited.
vendor/               other third-party code, one folder per library and version, with its licence
js/
  main.js             boot: theme, language, shell, live state
  core/               no UI: api, live panel state, cached resources, i18n, theme,
                      icons (+ icons.gen.js), DOM helpers, storage, events
  data/               backend data more than one place shows (cached stores)
  shell/              what stays on screen: router (tabs + page stack), status bar,
                      tab bar, layers (sheet, dialog, toast), control center,
                      keyboard, remote focus, edge swipe, offline page
  ui/                 markup helpers for Ridgeline parts pages share (page bar, QR code,
                      titled panel, empty / error / skeleton states)
  pages/<tab>/        one folder per tab: overview, files, network, settings
  strings/            zh.js (source) and en.js
```

Development tools live outside this folder, in `panel/tools/`, so they never ship:

| Tool | What |
| --- | --- |
| `dev-server.py` | serves this folder and passes `/api` to the running t6-paneld; `--set language=en` / `--set theme=dark` to try a variant |
| `shoot.sh` | headless screenshots (390 × 780) with the bundled Electron, optionally after scripted steps |
| `gen-icons.py` | regenerates `js/core/icons.gen.js` from the vendored icons |
| `dev-deploy.sh` | (root) puts this tree's backend, kiosk script and UI on this machine's panel, without an .fpk |

## Rules

- **Ridgeline is vendored, not forked.** Use its classes and markup (see
  Ridgeline's boards); anything extra goes in `css/app.css`, and goes back to
  Ridgeline so the next release can carry it. A new Ridgeline release goes in
  a new `ridgeline/<version>/` folder (t6-paneld serves `ridgeline/` as
  immutable) with the files `bundle.css` loads next to it (the 本机 drawing,
  `Dashboard/device-up6.png`), then run `gen-icons.py`.
- **Every string has an id** in `strings/zh.js` and `strings/en.js`. Title
  slips use `page.*` ids: Chinese shows the English name as the subtitle,
  English shows the English title only.
- **Pages show cached data first** (`core/resource.js`): a skeleton only when
  nothing is cached and only after 300 ms; a failed refresh keeps what is on
  screen.
- **A page is a factory** `(ctx) => ({ title, render, show, hide, destroy })`
  (see `shell/router.js`). `render()` runs again on a language change.
- **Markup is built with `html`** (`core/dom.js`), which escapes every value.
