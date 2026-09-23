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
let platformConfig = { language: navigator.language || "en-US", theme: "light" };
const state = { language: "en-US", status: null, dragging: false };

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
    brightness: "亮度",
    version: "版本",
    running: "运行中",
    stopped: "已停止",
    starting: "启动中",
    screenOn: "亮",
    screenOff: "熄灭",
    turnOffScreen: "关闭屏幕",
    wakeScreen: "唤醒屏幕",
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
    brightness: "Brightness",
    version: "Version",
    running: "Running",
    stopped: "Stopped",
    starting: "Starting",
    screenOn: "On",
    screenOff: "Off",
    turnOffScreen: "Turn off screen",
    wakeScreen: "Wake screen",
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
  statBrightness: $("statBrightness"),
  statVersion: $("statVersion"),
  screenPanel: $("screenPanel"),
  power: $("powerBtn"),
  bri: $("briRange"),
  briOut: $("briOut"),
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
  // the host may hand back { theme: "dark" } instead of "dark"
  const v = platformConfig.theme;
  const theme = v && typeof v === "object" && "theme" in v ? v.theme : v;
  document.documentElement.dataset.theme = String(theme || "").toLowerCase() === "dark" ? "dark" : "light";
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
  els.statBrightness.textContent = d.on && d.brightness != null ? `${d.brightness}%` : "-";
  els.statVersion.textContent = s.version || "-";

  // Screen controls only make sense while the panel app runs.
  els.screenPanel.classList.toggle("off", !on);
  els.power.disabled = !on || !d.present;
  els.power.textContent = t(d.on ? "turnOffScreen" : "wakeScreen");
  els.bri.disabled = !on || !d.present;
  els.bri.min = d.min_on ?? 10;
  if (!state.dragging) {
    els.bri.value = d.on ? d.brightness : d.on_level;
    els.briOut.textContent = `${els.bri.value}%`;
  }
  els.cc.disabled = !on;
  els.cc.checked = !!s.color_correction;
  els.restart.disabled = !on;
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

els.power.addEventListener("click", () => {
  const on = !!(state.status && state.status.display.on);
  run(() => api("display/power", "PUT", { on: !on }));
});

let briTimer = 0;
els.bri.addEventListener("input", () => {
  state.dragging = true;
  els.briOut.textContent = `${els.bri.value}%`;
  clearTimeout(briTimer);
  briTimer = setTimeout(() => api("display/brightness", "PUT", { value: Number(els.bri.value) }).catch((e) => showToast(t("failed", { msg: e.message }), true)), 150);
});
els.bri.addEventListener("change", () => {
  state.dragging = false;
  setTimeout(load, 400);
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
    // opened outside the fnOS desktop, or no reply: keep the browser defaults
  }
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
  if (!state.dragging && els.modal.classList.contains("hidden")) load();
}, 5000);
