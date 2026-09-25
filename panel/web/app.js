// T6 Front Panel admin page. Talks to t6-paneld's gateway surface: this page
// is /app/t6-panel/admin/, so "../api/..." is the backend and "../" is the
// on-device kiosk UI (opened with "Open panel UI").
import { TrimApp } from "./web-app.js";

// The SDK is only for theme + language: if it can't start in some client
// (desktop app, mobile webview, ...), the page must still work without it.
let sdk = { isWeb: false, isStandaloneWeb: true, getPlatformConfig: () => Promise.reject(new Error("no sdk")), $on() {} };
try {
  sdk = new TrimApp();
} catch (e) {
  console.warn("TrimApp unavailable:", e);
}
// Outside the fnOS desktop the SDK can't report a language: follow the browser.
let platformConfig = { language: navigator.language || "en-US", theme: null };
// The theme the host gave ("dark"/"light", or { theme }), or null. The fnOS
// iOS app's SDK bridge does not answer getPlatformConfig at all (app 1.34.4),
// but its webview's prefers-color-scheme follows the app's dark mode, so
// without an answer the page follows that, live.
const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
function hostTheme(v) {
  const theme = v && typeof v === "object" && "theme" in v ? v.theme : v;
  const s = String(theme || "").toLowerCase();
  return s === "dark" || s === "light" ? s : null;
}
function resolvedTheme() {
  return hostTheme(platformConfig.theme) || (darkQuery && darkQuery.matches ? "dark" : "light");
}
// First paint already in the right theme, before the host answers (or not).
document.documentElement.dataset.theme = resolvedTheme();

const state = { language: "en-US", status: null };

// Front-panel themes, in picker order. A new theme needs an entry here, its
// strings in I18N, a theme-<id>.png preview (240x480, a capture of the home
// screen) and to be allowed in t6-paneld (settings::set_theme) and
// panel/www/theme.js.
// Same choices as the panel's own Settings page (panel/www/settings.js).
const TIMEOUTS = [0, 60, 300, 900, 1800];

const THEMES = [
  { id: "light", img: "theme-light.png" },
  { id: "dark", img: "theme-dark.png" },
];

const I18N = {
  "zh-CN": {
    appTitle: "T6 前面板",
    loading: "正在加载...",
    refresh: "刷新",
    openPanel: "打开面板界面",
    panelApp: "前面板应用",
    panelAppHint: "关闭后停止前面板应用并熄灭屏幕，重启后保持关闭。",
    status: "状态",
    screen: "屏幕",
    version: "版本",
    running: "运行中",
    stopped: "已停止",
    starting: "启动中",
    screenOn: "亮",
    screenOff: "熄灭",
    display: "显示",
    theme: "主题",
    themeHint: "前面板应用的外观，几秒内在屏幕上生效。",
    theme_light: "浅色",
    theme_dark: "深色",
    themeSaved: "主题已更改",
    screenTimeout: "自动关屏",
    screenTimeoutHint: "前面板这么久没被触摸后自动关闭屏幕。",
    never: "从不",
    minutes: "{n} 分钟",
    colorCorrection: "颜色校正",
    colorCorrectionHint: "修正屏幕发白和高光被截断。切换时屏幕会重启几秒。",
    actions: "操作",
    restartPanel: "重启面板应用",
    restartPanelHint: "面板卡住或显示异常时使用，无需重启整台设备。",
    restart: "重启",
    cancel: "取消",
    confirm: "确定",
    summaryOn: "{host} · 前面板应用运行中",
    summaryStarting: "{host} · 前面板应用启动中",
    summaryOff: "{host} · 前面板应用已关闭",
    offTitle: "关闭前面板应用？",
    offBody: "前面板将停止运行并熄灭屏幕，重启设备后也保持关闭。可随时在这里重新开启。",
    turnOff: "关闭",
    ccOnTitle: "开启颜色校正？",
    ccOffTitle: "关闭颜色校正？",
    ccBody: "前面板屏幕会重启几秒以应用此设置。",
    restartTitle: "重启面板应用？",
    restartBody: "前面板会黑屏几秒后重新显示。",
    panelOn: "前面板应用已开启",
    panelOff: "前面板应用已关闭",
    restarting: "正在重启面板应用…",
    saved: "已保存",
    forbidden: "需要管理员账户",
    failed: "操作失败：{msg}",
  },
  "en-US": {
    appTitle: "T6 Front Panel",
    loading: "Loading...",
    refresh: "Refresh",
    openPanel: "Open panel UI",
    panelApp: "Front-panel app",
    panelAppHint: "Off stops the front-panel app and turns the screen off; it stays off after a reboot.",
    status: "Status",
    screen: "Screen",
    version: "Version",
    running: "Running",
    stopped: "Stopped",
    starting: "Starting",
    screenOn: "On",
    screenOff: "Off",
    display: "Display",
    theme: "Theme",
    themeHint: "The look of the front-panel app. It changes on the screen within a few seconds.",
    theme_light: "Light",
    theme_dark: "Dark",
    themeSaved: "Theme changed",
    screenTimeout: "Screen timeout",
    screenTimeoutHint: "Turn the screen off after the front panel has not been touched for this long.",
    never: "Never",
    minutes: "{n} min",
    colorCorrection: "Color correction",
    colorCorrectionHint: "Fixes washed-out colors and clipped highlights. The screen restarts for a few seconds.",
    actions: "Actions",
    restartPanel: "Restart panel app",
    restartPanelHint: "For a frozen or misbehaving panel, without rebooting the OS.",
    restart: "Restart",
    cancel: "Cancel",
    confirm: "OK",
    summaryOn: "{host} · front-panel app running",
    summaryStarting: "{host} · front-panel app starting",
    summaryOff: "{host} · front-panel app turned off",
    offTitle: "Turn off the front-panel app?",
    offBody: "The front panel stops and its screen turns off, and it stays off after a reboot. You can turn it back on here at any time.",
    turnOff: "Turn off",
    ccOnTitle: "Turn on color correction?",
    ccOffTitle: "Turn off color correction?",
    ccBody: "The front-panel screen restarts for a few seconds to apply this.",
    restartTitle: "Restart the panel app?",
    restartBody: "The front panel goes dark for a few seconds, then comes back.",
    panelOn: "Front-panel app turned on",
    panelOff: "Front-panel app turned off",
    restarting: "Restarting the panel app…",
    saved: "Saved",
    forbidden: "An administrator account is required",
    failed: "Failed: {msg}",
  },
};

const $ = (id) => document.getElementById(id);
const els = {
  summary: $("summary"),
  refresh: $("refreshBtn"),
  open: $("openBtn"),
  panelSwitch: $("panelSwitch"),
  statStatus: $("statStatus"),
  statScreen: $("statScreen"),
  statVersion: $("statVersion"),
  displayPanel: $("displayPanel"),
  themeGrid: $("themeGrid"),
  timeout: $("timeoutSel"),
  cc: $("ccSwitch"),
  restart: $("restartBtn"),
  modal: $("modal"),
  modalTitle: $("modalTitle"),
  modalBody: $("modalBody"),
  modalOk: $("modalOk"),
  modalCancel: $("modalCancel"),
  toast: $("toast"),
};

function t(key, params = {}) {
  const text = (I18N[state.language] || I18N["en-US"])[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? "");
}

// ---- platform (language + theme from the fnOS desktop) ----
function applyPreferences() {
  const lang = String(platformConfig.language || "").replace("_", "-");
  state.language = lang.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
  document.documentElement.lang = state.language;
  document.documentElement.dataset.theme = resolvedTheme();
  document.querySelectorAll("[data-i18n]").forEach((n) => (n.textContent = t(n.dataset.i18n)));
  render();
}

// ---- backend ----
async function api(path, method = "GET", body) {
  const res = await fetch(`../api/${path}`, {
    method,
    cache: "no-store",
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 403) throw new Error(t("forbidden"));
  if (!res.ok) throw new Error((await res.text()).trim() || `HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  return type.includes("json") ? res.json() : null;
}

async function load() {
  try {
    state.status = await api("admin/status");
  } catch (e) {
    state.status = null;
    els.summary.textContent = e.message;
  }
  render();
}

// ---- render ----
function render() {
  const s = state.status;
  if (!s) return;
  const on = s.panel.enabled;
  const d = s.display || {};
  els.summary.textContent = t(on ? (s.panel.active ? "summaryOn" : "summaryStarting") : "summaryOff", { host: s.host || "T6" });
  els.panelSwitch.disabled = false;
  els.panelSwitch.checked = on;
  els.statStatus.textContent = t(on ? (s.panel.active ? "running" : "starting") : "stopped");
  els.statStatus.classList.toggle("ok", on && s.panel.active);
  els.statScreen.textContent = t(d.on ? "screenOn" : "screenOff");
  els.statVersion.textContent = s.version || "-";

  // Display settings only make sense while the panel app runs.
  els.displayPanel.classList.toggle("off", !on);
  renderThemes(s.theme, !on);
  renderTimeout(s.screen_timeout_s ?? 0, !on);
  els.cc.disabled = !on;
  els.cc.checked = !!s.color_correction;
  els.restart.disabled = !on;
}

// Cards are built once (and again on a language change); later renders only
// move the selection.
function renderThemes(current, disabled) {
  if (els.themeGrid.dataset.lang !== state.language) {
    els.themeGrid.dataset.lang = state.language;
    els.themeGrid.innerHTML = THEMES.map((th) => `
      <button class="theme-card" type="button" role="radio" data-theme-id="${th.id}">
        <img src="${th.img}" alt="" width="110" height="220" loading="lazy">
        <span class="theme-name">${t("theme_" + th.id)}</span>
      </button>`).join("");
  }
  for (const card of els.themeGrid.querySelectorAll(".theme-card")) {
    card.setAttribute("aria-checked", String(card.dataset.themeId === current));
    card.disabled = disabled;
  }
}

function renderTimeout(current, disabled) {
  const sel = els.timeout;
  if (sel.dataset.lang !== state.language) {
    sel.dataset.lang = state.language;
    sel.innerHTML = TIMEOUTS.map((v) => `<option value="${v}">${v ? t("minutes", { n: v / 60 }) : t("never")}</option>`).join("");
  }
  // A value set elsewhere that is not in the list still shows.
  if (!TIMEOUTS.includes(current) && !sel.querySelector(`option[value="${current}"]`)) {
    sel.insertAdjacentHTML("beforeend", `<option value="${current}">${t("minutes", { n: Math.round(current / 60) })}</option>`);
  }
  if (document.activeElement !== sel) sel.value = String(current);
  sel.disabled = disabled;
}

// ---- dialog + toast ----
function confirmDialog(title, body, okText) {
  return new Promise((resolve) => {
    els.modalTitle.textContent = title;
    els.modalBody.textContent = body;
    els.modalOk.textContent = okText || t("confirm");
    els.modal.classList.remove("hidden");
    const done = (v) => {
      els.modal.classList.add("hidden");
      els.modalOk.onclick = els.modalCancel.onclick = null;
      resolve(v);
    };
    els.modalOk.onclick = () => done(true);
    els.modalCancel.onclick = () => done(false);
  });
}

let toastTimer = 0;
function showToast(msg, error = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle("error", error);
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2600);
}

async function run(fn, okMsg) {
  try {
    await fn();
    if (okMsg) showToast(okMsg);
  } catch (e) {
    showToast(t("failed", { msg: e.message }), true);
  }
  await load();
}

// ---- actions ----
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

els.refresh.addEventListener("click", load);
els.open.addEventListener("click", () => window.open(new URL("../", location.href).href, "_blank", "noopener"));

els.panelSwitch.addEventListener("change", async () => {
  const want = els.panelSwitch.checked;
  if (!want && !(await confirmDialog(t("offTitle"), t("offBody"), t("turnOff")))) {
    els.panelSwitch.checked = true;
    return;
  }
  els.panelSwitch.disabled = true;
  await run(() => api("admin/panel", "PUT", { enabled: want }), t(want ? "panelOn" : "panelOff"));
});

els.themeGrid.addEventListener("click", (e) => {
  const card = e.target.closest(".theme-card");
  if (!card || card.disabled || card.getAttribute("aria-checked") === "true") return;
  // Selected at once; the next load() confirms (or reverts on failure).
  renderThemes(card.dataset.themeId, false);
  run(() => api("settings/theme", "PUT", { theme: card.dataset.themeId }), t("themeSaved"));
});

els.timeout.addEventListener("change", () => {
  run(() => api("settings/screen-timeout", "PUT", { seconds: Number(els.timeout.value) }), t("saved"));
});

els.cc.addEventListener("change", async () => {
  const want = els.cc.checked;
  if (!(await confirmDialog(t(want ? "ccOnTitle" : "ccOffTitle"), t("ccBody"), t("restart")))) {
    els.cc.checked = !want;
    return;
  }
  await run(() => api("settings/color-correction", "PUT", { on: want }), t("restarting"));
});

els.restart.addEventListener("click", async () => {
  if (!(await confirmDialog(t("restartTitle"), t("restartBody"), t("restart")))) return;
  await run(() => api("admin/panel/restart", "POST"), t("restarting"));
});

// ---- start ----
// The page must not depend on the SDK answering: render and load first, then
// pick up the fnOS language/theme when (if) the desktop replies.

async function initPlatform() {
  try {
    platformConfig = { ...platformConfig, ...(await withTimeout(sdk.getPlatformConfig(), 2000)) };
    applyPreferences();
  } catch {
    // opened outside the fnOS desktop, or no reply (the iOS app): follow the
    // browser's language and dark-mode setting
    applyPreferences();
  }
  // The system setting only counts while the host has not named a theme.
  darkQuery?.addEventListener?.("change", () => { if (!hostTheme(platformConfig.theme)) applyPreferences(); });
  if (sdk.isWeb === true && sdk.isStandaloneWeb === false) {
    try {
      sdk.$on("os/theme", (theme) => {
        platformConfig = { ...platformConfig, theme };
        applyPreferences();
      });
      sdk.$on("os/language", (language) => {
        platformConfig = { ...platformConfig, language };
        applyPreferences();
      });
    } catch {
      // no live updates; the initial values still apply
    }
  }
}

applyPreferences();
load();
initPlatform();
setInterval(() => {
  if (els.modal.classList.contains("hidden")) load();
}, 5000);
