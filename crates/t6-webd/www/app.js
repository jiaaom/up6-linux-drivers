// T6 Control Center – front end. Plain JS module, no build step.
// All requests are relative, so the page works under any gateway prefix.
// Theme and language come from the fnOS desktop through the TrimApp SDK
// (web-app.js); strings go through t() with an en-US / zh-CN dictionary.
import { TrimApp } from "./web-app.js";

const $ = (sel, root = document) => root.querySelector(sel);
const HISTORY = 120; // samples kept per zone for the sparkline (1/s)

const state = {
  language: "en-US",
  admin: false,
  activeProfile: null,
  pendingProfile: null,     // optimistic profile selection until the daemon reflects it
  fanEdited: {},   // zone -> working copy of the custom curve points
  fanTemps: {},    // zone -> current temperature
  fanDragging: false,
  limMode: "preset",        // "preset" (buttons) or "custom" (sliders)
  limStaged: null,          // pending charge thresholds {start, end}
  batteryThresholds: null,  // thresholds currently on the device
  blDragging: false,  // user is dragging the brightness slider
  nightDirty: false,  // user is editing the night schedule
  nightSched: "",     // schedule currently running (for dirty + revert)
  history: new Map(), // zone -> [{t, temp, pwm}]
  config: null,
  last: null,         // last /api/status payload (re-render on language change)
};

// ---- i18n -----------------------------------------------------------------

const I18N = {
  "en-US": {
    appTitle: "T6 Control Center",
    tabDashboard: "Dashboard", tabFans: "Fans", tabLeds: "LEDs", tabDisplay: "Display", tabBattery: "Battery", tabBeeper: "Beeper",
    refresh: "Refresh", admin: "Administrator", readOnly: "Read-only",
    cpuTemp: "CPU temperature", fanProfile: "Fan profile", healthOk: "All running", healthProblems: "{n} problem(s)", repairingShort: "Repairing…",
    access: "Your access", accessAdminNote: "can change every setting", accessReadNote: "changes need an administrator account",
    healthTitle: "Drivers & services", repairDrivers: "Repair drivers", lastRepair: "Last repair",
    builtinBattery: "Built-in battery", software: "Software",
    nightMode: "Night mode",
    nightHelp: "Switches every LED off. Alerts stay on: the battery LED on a power failure, overheating, and drive, Wi-Fi and Bluetooth faults. Turn it on by hand, or give it a daily window.",
    nightNow: "Night mode now", everyDayFrom: "Every day from", to: "to", revert: "Revert", apply: "Apply",
    bayLeds: "Bay LEDs", bayHelp: "Bays light white when a drive is present. A drive reported faulty blinks red.",
    showDrives: "Show drives (white)", blinkFault: "Blink red on drive fault", perLed: "Advanced — per-LED control",
    beepStartup: "Beep once on startup", beepAcLoss: "Beep once on AC power loss", beepDriveFault: "Beep on drive fault (RAID degraded)",
    testPatterns: "Advanced — test patterns", testHelp: "Play an EC beeper pattern now. Continuous keeps sounding until stopped.",
    beepShort: "Short", beepLong: "Long", beepDouble: "Double", beepContinuous: "Continuous", beepStop: "Stop",
    backlight: "Backlight", backlightHelp: "Front LCD backlight. The level is applied immediately and remembered across reboots.",
    on: "On", off: "Off", offUntilReboot: "Off until next reboot", level: "Level", advanced: "Advanced",
    offAfterBoot: "Always turn off the built-in display after boot",
    powerButtonScreen: "The power button switches the screen on and off",
    powerButtonHelp: "Like a phone's side button. The screen reacts about a second after you let go. A desktop running on the screen also locks its session.",
    powerButtonFail: "Could not change the power button: {e}",
    offAfterBootHelp: "For a headless setup. When on, the screen stays dark after every reboot until you turn it on here.",
    status: "Status", chargeLimits: "Charge limits",
    limitsHelp: "Charging starts when the level drops below the lower bound and stops at the upper one. Choose a range, then Apply.",
    choice7585: "Recommended for staying on mains all day", choice5070: "Longest battery life, less backup runtime",
    choiceNone: "No constraint", choiceNoneSub: "EC default: charges to ~97 %, tops up from 91 %",
    choiceCustom: "Custom", choiceCustomSub: "Pick your own start and end",
    start: "Start", end: "End", profile: "Profile", curves: "Curves", from: "from",
    // dynamic
    adminRequired: "administrator required", adminRequiredChange: "administrator required to change",
    adminRequiredEdit: "administrator required to edit",
    runtimeOverride: "runtime override (config default: {p})",
    switchProfileFail: "Could not switch profile: {e}",
    fandDown: "t6-fand is not running – fans are at the driver default (50 %).",
    stopped: "stopped", rpm: "{n} rpm", reconnecting: "Reconnecting to the T6…",
    noBattery: "no battery", onMains: "on mains", onBattery: "on battery", charging: "charging", atW: " at {w} W",
    toTarget: "~{eta} to {t} %", left: "~{eta} left", holding: "holding between {a}–{b} %",
    batNotCharging: "not charging", batFull: "full", batUnknown: "unknown",
    ecPolicy: "EC policy", limits: "limits {a}–{b} %",
    voltage: "Voltage", energy: "Energy", health: "Health", chemistry: "Chemistry", ofDesign: "{p} % of design ({w} Wh)",
    minutes: "{m} min", hoursMin: "{h} h {m} min",
    applying: "applying…", appliedEc: "applied — EC policy (charges to ~97 %, tops up from 91 %)",
    appliedRange: "applied — charging {a}–{b} %, kept across reboots", failed: "failed: {e}",
    limitsFail: "Could not set charge limits: {e}",
    notAvailable: "not available", brightnessFail: "Could not set brightness: {e}",
    backlightFail: "Could not switch the backlight: {e}", bootFail: "Could not change the boot setting: {e}",
    ledsDown: "t6-ledd is not running – LEDs are unmanaged.", ledsConfig: "Configuration problem (defaults in use): {e}",
    nightActive: "active ({r})", drivesIn: "drives in bay {b}", noDrives: "no drives detected",
    driveFault: "⚠ Drive fault — bay {b} is blinking red", automatic: "Automatic – {d}", automaticShort: "automatic",
    forcedOff: " · forced off", ledNA: " · not available", setFail: "Could not set {id}: {e}",
    bayFail: "Could not switch bay LEDs: {e}", faultFail: "Could not change fault alert: {e}",
    nightFail: "Could not switch night mode: {e}", schedFail: "Could not set the schedule: {e}",
    beepFail: "Beeper: {e}", beepSetFail: "Beep setting: {e}",
    slow: "slow", normal: "normal", fast: "fast", breathSpeed: "Breathing speed",
    running: "running", notRunning: "not running", loaded: "loaded", loadedV: "loaded, {v}", notLoaded: "not loaded",
    thisApp: "this app", linuxVersion: "Linux version", platformDesc: "fans, LEDs, backlight & battery driver",
    touchDesc: "touchscreen driver", bridgeDesc: "HDMI-to-DSI front-panel bridge", fandDesc: "fan control service", leddDesc: "LED & beeper service", kernel: "Kernel",
    kernelV: "kernel {k}", repairing: "Repairing — building and loading the drivers (about 30 s)…",
    problems: "Problems detected", allGood: "All drivers and services are running",
    updateDrivers: "Update the T6 Drivers package to repair from here.",
    dpkgBusy: "A system update is in progress; repair once it has finished.",
    needHeaders: "Install the kernel headers first.",
    repairRunning: "running", repairOk: "succeeded", repairFailed: "failed", repairNoop: "nothing needed fixing",
    repairFailNotice: "Driver repair failed; see its log below.", repairedNotice: "Drivers repaired.", repairFail: "Repair: {e}",
    unsaved: "Unsaved changes", dragHint: "Drag the purple dots to edit",
    sensorsLbl: "sensors", filterLbl: "filter τ {s} s", hystLbl: "hysteresis {h} °C", rampLbl: "ramp {u}/{d} %/s",
    floorLbl: "floor {f} %", kickLbl: "start {p} % for {s} s",
    curvesFail: "Could not apply curves: {e}", configFail: "Could not load fan configuration: {e}",
    silent: "Silent", balance: "Balanced", performance: "Performance", custom: "Custom",
    rgbRed: "red", rgbGreen: "green", rgbBlue: "blue", rgbYellow: "red + green (cycle)", rgbCyan: "green + blue (cycle)",
    rgbMagenta: "red + blue (cycle)", rgbWhite: "rainbow", colorOff: "off", colorWhite: "white", colorOrange: "orange",
    colorYellow: "yellow", colorCyan: "cyan", colorMagenta: "magenta", fxBlink: "{c}, blinking", fxHeartbeat: "{c}, heartbeat",
    wifiLegend: "Blue: online · cyan: weak signal · cyan blinking: connecting · blue heartbeat: hotspot · yellow: on but not usable · red: fault (also at night) · off: Wi-Fi off or not set up",
    "wifi.connected": "Connected to {c}{s}", "wifi.weak-signal": "Weak signal on {c}{s}", "wifi.connecting": "Connecting to {c}…",
    "wifi.hotspot": "Hotspot {c} is on", "wifi.not-connected": "Not connected to a saved network",
    "wifi.no-ip": "Connected to {c}, but no IP address", "wifi.portal": "{c} needs a sign-in page",
    "wifi.no-internet": "Connected to {c}, but no internet", "wifi.driver-missing": "Wi-Fi card found, but no driver is loaded",
    "wifi.no-interface": "Wi-Fi driver loaded, but the card did not start (firmware?)", "wifi.hard-blocked": "Wi-Fi is blocked in hardware",
    "wifi.unavailable": "The Wi-Fi card is not responding", "wifi.nm-down": "NetworkManager is not running",
    "wifi.disabled": "Wi-Fi is turned off", "wifi.no-hardware": "No Wi-Fi card", "wifi.not-configured": "No Wi-Fi network saved",
    "wifi.not-managed": "Not managed by NetworkManager", "wifi.starting": "Starting…",
    radioLeds: "Status LEDs", radioHelp: "These LEDs show what the machine is doing. Red is an alarm and stays on in night mode.",
    showPower: "Show power status", powerLegend: "Power button — off while the screen is on · white while the screen is off · red blinking: overheating (also at night)",
    "power.screenOn": "Screen is on", "power.screenOff": "Screen is off", "power.hot": "Overheating: {s} at {t} °C", bayN: "bay {n}",
    showWifi: "Show Wi-Fi status", showBt: "Show Bluetooth status", ledKeptOff: "LED kept off", nightOff: "off for night mode",
    btLegend: "Blue: a device is connected · blue heartbeat: discoverable (pairing) · red: fault (also at night) · off: idle, off or no Bluetooth",
    "bt.connected": "{n} device(s) connected", "bt.discoverable": "Discoverable — waiting for a device to pair",
    "bt.idle": "On, no device connected", "bt.powered-off": "Adapter is off (is BlueZ installed?)",
    "bt.disabled": "Bluetooth is turned off", "bt.no-hardware": "No Bluetooth adapter",
    "bt.driver-missing": "Bluetooth hardware found, but no driver is loaded",
    "bt.no-adapter": "Bluetooth driver loaded, but the adapter did not start (firmware?)",
    "bt.hard-blocked": "Bluetooth is blocked in hardware", "bt.starting": "Starting…",
  },
  "zh-CN": {
    appTitle: "T6 控制中心",
    tabDashboard: "概览", tabFans: "风扇", tabLeds: "指示灯", tabDisplay: "显示屏", tabBattery: "电池", tabBeeper: "蜂鸣器",
    refresh: "刷新", admin: "管理员", readOnly: "只读",
    cpuTemp: "CPU 温度", fanProfile: "风扇模式", healthOk: "全部正常", healthProblems: "{n} 个问题", repairingShort: "正在修复…",
    access: "你的权限", accessAdminNote: "可以修改所有设置", accessReadNote: "修改设置需要管理员账户",
    healthTitle: "驱动与服务", repairDrivers: "修复驱动", lastRepair: "上次修复",
    builtinBattery: "内置电池", software: "软件",
    nightMode: "夜间模式",
    nightHelp: "关闭所有指示灯。警示仍会亮：断电时的电池灯、过热，以及硬盘、Wi-Fi、蓝牙故障。可手动开启，或设定每天的时段。",
    nightNow: "立即开启夜间模式", everyDayFrom: "每天从", to: "到", revert: "还原", apply: "应用",
    bayLeds: "硬盘位指示灯", bayHelp: "有硬盘时硬盘位亮白灯；硬盘报告故障时闪红灯。",
    showDrives: "显示硬盘（白灯）", blinkFault: "硬盘故障时闪红灯", perLed: "高级 — 单个指示灯控制",
    beepStartup: "开机时响一声", beepAcLoss: "断开交流电时响一声", beepDriveFault: "硬盘故障时鸣响（RAID 降级）",
    testPatterns: "高级 — 测试音型", testHelp: "立即播放一种 EC 蜂鸣音型。“持续”会一直响到停止为止。",
    beepShort: "短音", beepLong: "长音", beepDouble: "双响", beepContinuous: "持续", beepStop: "停止",
    backlight: "背光", backlightHelp: "前面板液晶屏背光。亮度立即生效，重启后保留。",
    on: "开", off: "关", offUntilReboot: "关闭（直到下次重启）", level: "亮度", advanced: "高级",
    offAfterBoot: "开机后始终关闭内置显示屏",
    powerButtonScreen: "按电源键开关屏幕",
    powerButtonHelp: "就像手机的锁屏键。松开按键约一秒后屏幕才会响应。如果屏幕上运行着桌面环境，它也会同时锁屏。",
    powerButtonFail: "无法更改电源键设置：{e}",
    offAfterBootHelp: "适用于无屏使用。开启后每次重启屏幕都保持熄灭，直到在这里打开。",
    status: "状态", chargeLimits: "充电范围",
    limitsHelp: "电量低于下限时开始充电，达到上限时停止。选好范围后点击“应用”。",
    choice7585: "推荐：适合长期接电", choice5070: "电池寿命最长，停电续航较短",
    choiceNone: "不限制", choiceNoneSub: "EC 默认：充到约 97 %，低于 91 % 时补电",
    choiceCustom: "自定义", choiceCustomSub: "自行设定开始和结束电量",
    start: "开始", end: "结束", profile: "模式", curves: "曲线", from: "来自",
    adminRequired: "需要管理员", adminRequiredChange: "需要管理员才能修改",
    adminRequiredEdit: "需要管理员才能编辑",
    runtimeOverride: "运行时覆盖（配置默认：{p}）",
    switchProfileFail: "无法切换模式：{e}",
    fandDown: "t6-fand 未运行 — 风扇处于驱动默认转速（50 %）。",
    stopped: "停转", rpm: "{n} 转/分", reconnecting: "正在重新连接 T6…",
    noBattery: "无电池", onMains: "交流供电", onBattery: "电池供电", charging: "充电中", atW: "，{w} W",
    toTarget: "约 {eta} 充到 {t} %", left: "约剩 {eta}", holding: "保持在 {a}–{b} %",
    batNotCharging: "未充电", batFull: "已充满", batUnknown: "未知",
    ecPolicy: "EC 策略", limits: "范围 {a}–{b} %",
    voltage: "电压", energy: "电量", health: "健康度", chemistry: "类型", ofDesign: "设计容量的 {p} %（{w} Wh）",
    minutes: "{m} 分钟", hoursMin: "{h} 小时 {m} 分钟",
    applying: "正在应用…", appliedEc: "已应用 — EC 策略（充到约 97 %，低于 91 % 补电）",
    appliedRange: "已应用 — 充电范围 {a}–{b} %，重启后保留", failed: "失败：{e}",
    limitsFail: "无法设置充电范围：{e}",
    notAvailable: "不可用", brightnessFail: "无法设置亮度：{e}",
    backlightFail: "无法开关背光：{e}", bootFail: "无法修改开机设置：{e}",
    ledsDown: "t6-ledd 未运行 — 指示灯不受管理。", ledsConfig: "配置有问题（正在使用默认值）：{e}",
    nightActive: "已开启（{r}）", drivesIn: "硬盘位 {b} 有硬盘", noDrives: "未检测到硬盘",
    driveFault: "⚠ 硬盘故障 — 硬盘位 {b} 正在闪红灯", automatic: "自动 – {d}", automaticShort: "自动",
    forcedOff: " · 强制关闭", ledNA: " · 不可用", setFail: "无法设置 {id}：{e}",
    bayFail: "无法开关硬盘位指示灯：{e}", faultFail: "无法修改故障提示：{e}",
    nightFail: "无法开关夜间模式：{e}", schedFail: "无法设置时段：{e}",
    beepFail: "蜂鸣器：{e}", beepSetFail: "蜂鸣设置：{e}",
    slow: "慢", normal: "中", fast: "快", breathSpeed: "呼吸速度",
    running: "运行中", notRunning: "未运行", loaded: "已加载", loadedV: "已加载，{v}", notLoaded: "未加载",
    thisApp: "本应用", linuxVersion: "Linux 版本", platformDesc: "风扇、指示灯、背光与电池驱动",
    touchDesc: "触摸屏驱动", bridgeDesc: "前面板 HDMI-to-DSI 桥接驱动", fandDesc: "风扇控制服务", leddDesc: "指示灯与蜂鸣器服务", kernel: "内核",
    kernelV: "内核 {k}", repairing: "正在修复 — 编译并加载驱动（约 30 秒）…",
    problems: "发现问题", allGood: "所有驱动和服务都在运行",
    updateDrivers: "请更新 T6 Drivers 套件后再从这里修复。",
    dpkgBusy: "系统正在更新，请在更新完成后再修复。",
    needHeaders: "请先安装内核头文件。",
    repairRunning: "进行中", repairOk: "成功", repairFailed: "失败", repairNoop: "检查正常，无需修复",
    repairFailNotice: "驱动修复失败，请查看下方日志。", repairedNotice: "驱动已修复。", repairFail: "修复：{e}",
    unsaved: "有未保存的修改", dragHint: "拖动紫色圆点编辑",
    sensorsLbl: "传感器", filterLbl: "滤波 τ {s} 秒", hystLbl: "回差 {h} °C", rampLbl: "升降速 {u}/{d} %/秒",
    floorLbl: "最低 {f} %", kickLbl: "启动 {p} %，持续 {s} 秒",
    curvesFail: "无法应用曲线：{e}", configFail: "无法加载风扇配置：{e}",
    silent: "静音", balance: "均衡", performance: "性能", custom: "自定义",
    rgbRed: "红", rgbGreen: "绿", rgbBlue: "蓝", rgbYellow: "红 + 绿（循环）", rgbCyan: "绿 + 蓝（循环）",
    rgbMagenta: "红 + 蓝（循环）", rgbWhite: "彩虹", colorOff: "关", colorWhite: "白", colorOrange: "橙",
    colorYellow: "黄", colorCyan: "青", colorMagenta: "品红", fxBlink: "{c}，闪烁", fxHeartbeat: "{c}，心跳",
    wifiLegend: "蓝：已联网 · 青：信号弱 · 青色闪烁：正在连接 · 蓝色心跳：热点 · 黄：已开启但不可用 · 红：故障（夜间也亮） · 熄灭：Wi-Fi 已关闭或未配置",
    "wifi.connected": "已连接 {c}{s}", "wifi.weak-signal": "{c} 信号弱{s}", "wifi.connecting": "正在连接 {c}…",
    "wifi.hotspot": "热点 {c} 已开启", "wifi.not-connected": "未连接到已保存的网络",
    "wifi.no-ip": "已连接 {c}，但没有 IP 地址", "wifi.portal": "{c} 需要网页登录",
    "wifi.no-internet": "已连接 {c}，但无法访问互联网", "wifi.driver-missing": "检测到 Wi-Fi 网卡，但驱动未加载",
    "wifi.no-interface": "Wi-Fi 驱动已加载，但网卡未能启动（固件？）", "wifi.hard-blocked": "Wi-Fi 被硬件屏蔽",
    "wifi.unavailable": "Wi-Fi 网卡无响应", "wifi.nm-down": "NetworkManager 未运行",
    "wifi.disabled": "Wi-Fi 已关闭", "wifi.no-hardware": "没有 Wi-Fi 网卡", "wifi.not-configured": "未保存任何 Wi-Fi 网络",
    "wifi.not-managed": "不受 NetworkManager 管理", "wifi.starting": "正在启动…",
    radioLeds: "状态指示灯", radioHelp: "这些灯显示机器当前的状态。红色是警报，夜间模式下也会亮。",
    showPower: "显示电源状态", powerLegend: "电源键 — 屏幕亮时熄灭 · 屏幕关闭时白色 · 红色闪烁：过热（夜间也亮）",
    "power.screenOn": "屏幕已开启", "power.screenOff": "屏幕已关闭", "power.hot": "过热：{s} {t} °C", bayN: "硬盘位 {n}",
    showWifi: "显示 Wi-Fi 状态", showBt: "显示蓝牙状态", ledKeptOff: "指示灯保持关闭", nightOff: "夜间模式已关闭",
    btLegend: "蓝：有设备连接 · 蓝色心跳：可被发现（配对中） · 红：故障（夜间也亮） · 熄灭：空闲、已关闭或没有蓝牙",
    "bt.connected": "已连接 {n} 个设备", "bt.discoverable": "可被发现，等待设备配对",
    "bt.idle": "已开启，没有设备连接", "bt.powered-off": "适配器未开启（是否已安装 BlueZ？）",
    "bt.disabled": "蓝牙已关闭", "bt.no-hardware": "没有蓝牙适配器",
    "bt.driver-missing": "检测到蓝牙硬件，但驱动未加载",
    "bt.no-adapter": "蓝牙驱动已加载，但适配器未能启动（固件？）",
    "bt.hard-blocked": "蓝牙被硬件屏蔽", "bt.starting": "正在启动…",
  },
};

function t(key, params = {}) {
  const text = (I18N[state.language] || I18N["en-US"])[key] ?? I18N["en-US"][key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? "");
}
const profileName = (p) => (["silent", "balance", "performance", "custom"].includes(p) ? t(p) : p);

// ---- theme + language from the fnOS desktop --------------------------------

// The SDK is only for theme + language: if it can't start in some client
// (desktop app, mobile webview, ...), the page must still work without it.
let sdk = { isWeb: false, isStandaloneWeb: true, getPlatformConfig: () => Promise.reject(new Error("no sdk")), $on() {} };
try {
  sdk = new TrimApp();
} catch (e) {
  console.warn("TrimApp unavailable:", e);
}
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


function applyPreferences() {
  const lang = String(platformConfig.language || "").replace("_", "-");
  const next = lang.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
  const langChanged = next !== state.language;
  state.language = next;
  document.documentElement.lang = next;
  document.documentElement.dataset.theme = resolvedTheme();
  document.querySelectorAll("[data-i18n]").forEach((n) => (n.textContent = t(n.dataset.i18n)));
  $("#pageTitle").textContent = t($(".nav-item.active").querySelector("[data-i18n]").dataset.i18n);
  if (langChanged) {
    // strings built in JS: re-render from the last data
    $("#led-devices").dataset.key = "";
    $("#profiles").dataset.key = "";
    if (state.last) renderAll(state.last);
    loadSystem();
    loadHealth();
    if (state.config) loadCurves();
  }
  redrawEditor(); // canvas colours follow the theme
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

// Never let the SDK block the page: it is only for theme + language.
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
      sdk.$on("os/theme", (theme) => { platformConfig = { ...platformConfig, theme }; applyPreferences(); });
      sdk.$on("os/language", (language) => { platformConfig = { ...platformConfig, language }; applyPreferences(); });
    } catch {
      // no live updates; the initial values still apply
    }
  }
}

// canvas colours come from the CSS tokens
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---- backend --------------------------------------------------------------

async function api(path, opts = {}) {
  if (opts.body !== undefined) {
    opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 8000);
  try {
    const res = await fetch(`api/${path}`, { ...opts, signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${path}: HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

let connErrorActive = false;
let pollFails = 0;
function notice(msg, kind = "") {
  connErrorActive = false;
  const el = $("#notice");
  el.textContent = msg || "";
  el.className = `notice ${kind}`;
  el.hidden = !msg;
}
function setConnError(msg) { notice(msg, "error"); connErrorActive = true; }
function clearConnError() { if (connErrorActive) { connErrorActive = false; notice(""); } }

// ---- navigation ------------------------------------------------------------

$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-item");
  if (!btn || btn.disabled) return;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".page").forEach((p) => (p.hidden = p.id !== btn.dataset.tab));
  $("#pageTitle").textContent = t(btn.querySelector("[data-i18n]").dataset.i18n);
  if (btn.dataset.tab === "fans") loadCurves();
  if (btn.dataset.tab === "dashboard") { loadSystem(); loadHealth(); }
});
$("#refreshBtn").addEventListener("click", () => {
  pollLoop();
  loadSystem();
  loadHealth();
  if (!$("#fans").hidden) loadCurves();
});

// ---- dashboard ------------------------------------------------------------

function renderUser(u) {
  state.admin = !!u.is_admin;
  const el = $("#user");
  el.textContent = state.admin ? t("admin") : t("readOnly");
  el.classList.toggle("admin", state.admin);
  $("#access-note").textContent = state.admin ? t("accessAdminNote") : t("accessReadNote");
}


function renderProfiles(fan) {
  const box = $("#profiles");
  let active = fan.profile_override || (fan.status ? fan.status.profile : null);
  if (state.pendingProfile) {
    if (active === state.pendingProfile) state.pendingProfile = null;  // confirmed
    else active = state.pendingProfile;                                // hold optimistic
  }
  const key = fan.profiles.join("|");
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = fan.profiles.map((p) => `<button type="button" data-profile="${p}">${profileName(p)}</button>`).join("");
  }
  box.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.profile === active);
    b.disabled = !state.admin || !fan.running;
  });
  state.activeProfile = active;
  $("#hero-profile").textContent = active ? profileName(active) : "—";
  updateCurveBar();
  const note = $("#profile-note");
  if (!state.admin) note.textContent = t("adminRequiredChange");
  else if (fan.profile_override && fan.profile_override !== fan.config_profile)
    note.textContent = t("runtimeOverride", { p: profileName(fan.config_profile) });
  else note.textContent = "";
}

$("#profiles").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn || btn.disabled || btn.classList.contains("active")) return;
  const profile = btn.dataset.profile;
  // Update the UI immediately; the curves don't change on a profile switch,
  // only which one is highlighted (and whether custom is editable).
  state.pendingProfile = profile;
  state.activeProfile = profile;
  document.querySelectorAll("#profiles button").forEach((b) => b.classList.toggle("active", b === btn));
  redrawEditor();
  updateCurveBar();
  try {
    await api("fan/profile", { method: "PUT", body: { profile } });
    notice("");
  } catch (err) {
    state.pendingProfile = null;
    notice(t("switchProfileFail", { e: err.message }), "error");
  }
});

function pushHistory(z) {
  let h = state.history.get(z.zone);
  if (!h) state.history.set(z.zone, (h = []));
  h.push({ temp: z.temp_c, pwm: z.pwm_percent });
  if (h.length > HISTORY) h.shift();
  return h;
}

function drawSpark(canvas, h) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (h.length < 2) return;
  const x = (i) => (i / (HISTORY - 1)) * W;
  // PWM 0–100 % as a filled area, temperature as a line scaled 20–100 °C.
  ctx.fillStyle = cssVar("--accent-soft");
  ctx.beginPath();
  ctx.moveTo(x(0), H);
  h.forEach((s, i) => ctx.lineTo(x(i), H - (s.pwm / 100) * H));
  ctx.lineTo(x(h.length - 1), H);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = cssVar("--warn");
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  h.forEach((s, i) => {
    if (s.temp == null) return;
    const y = H - Math.min(1, Math.max(0, (s.temp - 20) / 80)) * H;
    i === 0 ? ctx.moveTo(x(i), y) : ctx.lineTo(x(i), y);
  });
  ctx.stroke();
}

function renderZones(fan) {
  const box = $("#zones");
  const cpu = fan.running && fan.status ? (fan.status.zones.find((z) => z.zone === "cpu") || fan.status.zones[0]) : null;
  $("#hero-cpu").textContent = cpu && cpu.temp_c != null ? `${cpu.temp_c.toFixed(1)} °C` : "—";
  if (!fan.running || !fan.status) {
    box.innerHTML = "";
    notice(t("fandDown"));
    return;
  }
  const tpl = $("#zone-card");
  for (const z of fan.status.zones) {
    let card = box.querySelector(`[data-zone="${z.zone}"]`);
    if (!card) {
      card = tpl.content.firstElementChild.cloneNode(true);
      card.dataset.zone = z.zone;
      box.appendChild(card);
    }
    const running = z.pwm_percent > 0;
    $(".name", card).textContent = z.fan;
    $(".rpm", card).textContent = z.rpm == null ? "" : t("rpm", { n: z.rpm });
    const big = $(".pwm", card);
    big.textContent = running ? `${z.pwm_percent} %` : t("stopped");
    big.classList.toggle("stopped", !running);
    $(".bar > i", card).style.width = `${z.pwm_percent}%`;
    $(".sensors", card).innerHTML = z.sensors
      .map((s) => `<li><span title="${s.name}">${s.name}</span><b>${s.temp_c == null ? "—" : s.temp_c.toFixed(1) + " °C"}</b></li>`)
      .join("");
    drawSpark($(".spark", card), pushHistory(z));
  }
}

function renderAll(s) {
  renderUser(s.user);
  renderProfiles(s.fan);
  renderBattery(s.battery);
  renderDisplay(s.display);
  renderPowerButton(s.leds);
  renderLeds(s.leds);
  document.querySelectorAll("#beep-buttons button").forEach((b) => (b.disabled = !state.admin || !s.leds));
  $("#beep-note").textContent = !state.admin ? t("adminRequired") : "";
  document.querySelectorAll(".beep-events input").forEach((cb) => {
    cb.disabled = !state.admin || !s.leds;
    const beep = s.leds && s.leds.beep;
    if (beep && document.activeElement !== cb) cb.checked = !!beep[cb.dataset.event];
  });
}

async function refresh() {
  try {
    const s = await api("status");
    pollFails = 0;
    clearConnError();
    state.last = s;
    renderAll(s);
    renderZones(s.fan);
    if (s.fan.running && s.fan.status) {
      s.fan.status.zones.forEach((z) => (state.fanTemps[z.zone] = z.temp_c));
      if (!$("#fans").hidden && !state.fanDragging) redrawEditor();
    }
    if (s.fan.running && $("#notice").textContent === t("fandDown")) notice("");
    maybeLoadSystem();
  } catch (e) {
    // A single miss is almost always a transient blip (mobile webview
    // suspend/resume, a Wi-Fi hiccup, or t6-webd restarting on an upgrade).
    // The loop keeps polling and recovers on its own, so only surface it
    // after a few consecutive failures.
    pollFails++;
    if (pollFails >= 3) setConnError(t("reconnecting"));
  }
}

// ---- battery --------------------------------------------------------------

function fmtHours(h) {
  if (!isFinite(h) || h <= 0) return "";
  const m = Math.round(h * 60);
  return m < 60 ? t("minutes", { m }) : t("hoursMin", { h: Math.floor(m / 60), m: String(m % 60).padStart(2, "0") });
}

const BAT_STATUS = { "Not charging": "batNotCharging", Full: "batFull", Unknown: "batUnknown", Charging: "charging" };

// One-line human summary of the charging state.
function batterySummary(b) {
  if (!b.present) return t("noBattery");
  const th = b.thresholds;
  const held = th && !(th.start === 0 && th.end === 100) && b.status === "Not charging" && b.ac_online;
  const parts = [b.ac_online ? t("onMains") : t("onBattery")];
  if (b.status === "Charging") {
    parts.push(t("charging") + (b.power_w > 0.5 ? t("atW", { w: b.power_w.toFixed(1) }) : ""));
    const target = th ? th.end : 100;
    const eta = b.power_w > 0.5 ? (b.energy_full_wh * target / 100 - b.energy_now_wh) / b.power_w : NaN;
    if (fmtHours(eta)) parts.push(t("toTarget", { eta: fmtHours(eta), t: target }));
  } else if (b.status === "Discharging") {
    if (b.power_w > 0.5) parts.push(`${b.power_w.toFixed(1)} W`);
    const eta = b.power_w > 0.5 ? b.energy_now_wh / b.power_w : NaN;
    if (fmtHours(eta)) parts.push(t("left", { eta: fmtHours(eta) }));
  } else if (held) {
    parts.push(t("holding", { a: th.start, b: th.end }));
  } else if (b.status) {
    parts.push(BAT_STATUS[b.status] ? t(BAT_STATUS[b.status]) : b.status.toLowerCase());
  }
  return parts.join(" · ");
}

function renderBattery(b) {
  const soc = b.capacity == null ? "—" : `${b.capacity} %`;
  const summary = batterySummary(b);
  const limits = b.thresholds ? (b.thresholds.start === 0 && b.thresholds.end === 100 ? t("ecPolicy") : t("limits", { a: b.thresholds.start, b: b.thresholds.end })) : "";
  $("#hero-battery").textContent = soc;
  $("#hero-battery-sub").textContent = b.present ? limits : "";

  $("#bat-soc").textContent = soc;
  $("#bat-status").textContent = summary;
  $("#bat-bar").style.width = `${b.capacity || 0}%`;
  $("#bat-model").textContent = [b.manufacturer, b.model].filter(Boolean).join(" ");
  const rows = [
    [t("voltage"), b.voltage_v != null ? `${b.voltage_v.toFixed(2)} V` : null],
    [t("energy"), b.energy_now_wh != null ? `${b.energy_now_wh.toFixed(1)} / ${b.energy_full_wh.toFixed(1)} Wh` : null],
    [t("health"), b.health_percent != null ? t("ofDesign", { p: b.health_percent.toFixed(0), w: b.energy_full_design_wh.toFixed(1) }) : null],
    [t("chemistry"), b.technology],
  ].filter(([, v]) => v);
  $("#bat-details").innerHTML = rows.map(([k, v]) => `<li><span>${k}</span><b>${v}</b></li>`).join("");

  // Limits form: choices are staged and only committed with Apply.
  state.batteryThresholds = b.thresholds || null;
  const editable = state.admin && !!b.thresholds;
  document.querySelectorAll("#lim-presets button").forEach((p) => (p.disabled = !editable));
  ["#lim-start", "#lim-end"].forEach((id) => ($(id).disabled = !editable));
  $("#lim-note").textContent = !state.admin ? t("adminRequiredChange") : "";
  if (b.thresholds && state.limMode === "preset" && (!state.limStaged || !limDirty())) {
    // preset mode, no pending edit: reflect what the device currently holds
    stageLimits(b.thresholds.start, b.thresholds.end, true);
  }
  updateLimActions();
}

function limDirty() {
  const d = state.batteryThresholds, s = state.limStaged;
  return !!(d && s && (s.start !== d.start || s.end !== d.end));
}

// Stage a selection (no write). `synced` = came from the device, so it
// clears any status message.
function stageLimits(start, end, synced) {
  state.limStaged = { start, end };
  setLimitForm(start, end);
  const preset = presetFor(start, end);
  markPreset(preset);
  $("#lim-custom").hidden = !!preset;
  if (synced) $("#lim-status").textContent = "";
  updateLimActions();
}

function updateLimActions() {
  const dirty = limDirty();
  const show = state.limMode === "custom" || dirty;
  $("#lim-actions").hidden = !show;
  $("#lim-apply").disabled = !state.admin || !dirty;
  $("#lim-revert").disabled = !state.admin || !show;
}

function presetFor(start, end) {
  return [...document.querySelectorAll("#lim-presets button[data-start]")]
    .find((p) => +p.dataset.start === start && +p.dataset.end === end) || null;
}

function markPreset(btn) {
  document.querySelectorAll("#lim-presets button").forEach((p) => p.classList.toggle("active", p === btn));
  if (!btn) $("#lim-presets button[data-custom]").classList.add("active");
}

function setLimitForm(start, end) {
  $("#lim-start").value = start;
  $("#lim-end").value = end;
  syncLimitLabels();
}

function syncLimitLabels() {
  $("#lim-start-v").textContent = `${+$("#lim-start").value} %`;
  $("#lim-end-v").textContent = `${+$("#lim-end").value} %`;
}

async function applyLimits() {
  const s = state.limStaged;
  if (!s) return;
  $("#lim-apply").disabled = true;
  $("#lim-status").textContent = t("applying");
  try {
    const r = await api("battery/thresholds", { method: "PUT", body: { start: s.start, end: s.end } });
    state.batteryThresholds = { start: r.start, end: r.end };
    state.limMode = presetFor(r.start, r.end) ? "preset" : "custom";
    $("#lim-status").textContent = r.ec_policy ? t("appliedEc") : t("appliedRange", { a: r.start, b: r.end });
    updateLimActions();
  } catch (err) {
    $("#lim-status").textContent = t("failed", { e: err.message });
    notice(t("limitsFail", { e: err.message }), "error");
    updateLimActions();
  }
}

// keep start < end while dragging; stage (do not apply)
function stageFromSliders() {
  if (+$("#lim-start").value >= +$("#lim-end").value) $("#lim-end").value = +$("#lim-start").value + 1;
  syncLimitLabels();
  state.limStaged = { start: +$("#lim-start").value, end: +$("#lim-end").value };
  markPreset(null);
  updateLimActions();
}
$("#lim-start").addEventListener("input", () => {
  if (+$("#lim-end").value <= +$("#lim-start").value) $("#lim-end").value = +$("#lim-start").value + 1;
  stageFromSliders();
});
$("#lim-end").addEventListener("input", () => {
  if (+$("#lim-start").value >= +$("#lim-end").value) $("#lim-start").value = +$("#lim-end").value - 1;
  stageFromSliders();
});
$("#lim-presets").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  if (b.dataset.custom) {
    state.limMode = "custom";
    $("#lim-custom").hidden = false;
    markPreset(null);
    updateLimActions();
  } else {
    state.limMode = "preset";
    stageLimits(+b.dataset.start, +b.dataset.end, false);
  }
});
$("#lim-apply").addEventListener("click", applyLimits);
$("#lim-revert").addEventListener("click", () => {
  const d = state.batteryThresholds;
  if (!d) return;
  state.limMode = "preset";
  stageLimits(d.start, d.end, true);
});

// ---- display --------------------------------------------------------------

function renderDisplay(d) {
  const editable = state.admin && d.present;
  $("#bl-power").disabled = !editable;
  $("#bl-slider").disabled = !editable || !d.on;
  $("#bl-note").textContent = !d.present ? t("notAvailable") : !state.admin ? t("adminRequiredChange") : "";
  if (d.max_brightness) $("#bl-slider").max = d.max_brightness;
  if (d.min_on) $("#bl-slider").min = d.min_on;
  if (!state.blDragging) {
    $("#bl-power").checked = d.on;
    $("#bl-power-label").textContent = d.on ? t("on") : t("offUntilReboot");
    $("#bl-slider").value = d.on ? Math.max(d.brightness || 0, d.min_on || 10) : d.on_level;
    syncBrightnessLabel();
  }
  const ob = $("#bl-off-boot");
  ob.disabled = !editable;
  if (document.activeElement !== ob) ob.checked = !!d.off_after_boot;
}

// The button is t6-ledd's (it keeps running without the front panel).
function renderPowerButton(l) {
  const cb = $("#bl-button");
  cb.disabled = !state.admin || !l;
  if (l && document.activeElement !== cb) cb.checked = l.power_button_screen !== false;
}

function syncBrightnessLabel() {
  $("#bl-value").textContent = `${+$("#bl-slider").value} %`;
}

async function setBrightness(v) {
  try {
    await api("display/brightness", { method: "PUT", body: { brightness: v } });
  } catch (err) {
    notice(t("brightnessFail", { e: err.message }), "error");
  }
}

// Live while dragging (rate limited), final value on release.
let blTimer = null;
$("#bl-slider").addEventListener("input", () => {
  state.blDragging = true;
  syncBrightnessLabel();
  if (!blTimer) blTimer = setTimeout(() => { blTimer = null; setBrightness(+$("#bl-slider").value); }, 150);
});
$("#bl-slider").addEventListener("change", () => {
  state.blDragging = false;
  setBrightness(+$("#bl-slider").value);
});
$("#bl-power").addEventListener("change", async (e) => {
  const on = e.target.checked;
  $("#bl-power-label").textContent = on ? t("on") : t("offUntilReboot");
  $("#bl-slider").disabled = !on;
  try {
    await api("display/power", { method: "PUT", body: { on } });
    if (on) {
      // Turning the screen on means you want it — cancel "always off after boot".
      $("#bl-off-boot").checked = false;
      await api("display/off-after-boot", { method: "PUT", body: { off_after_boot: false } });
    }
  } catch (err) {
    notice(t("backlightFail", { e: err.message }), "error");
  }
});
$("#bl-button").addEventListener("change", async (e) => {
  try {
    await api("leds/power-button", { method: "PUT", body: { on: e.target.checked } });
  } catch (err) {
    notice(t("powerButtonFail", { e: err.message }), "error");
  }
});
$("#bl-off-boot").addEventListener("change", async (e) => {
  try {
    await api("display/off-after-boot", { method: "PUT", body: { off_after_boot: e.target.checked } });
  } catch (err) {
    notice(t("bootFail", { e: err.message }), "error");
  }
});

// ---- LEDs -----------------------------------------------------------------

// The tray light is an effect controller: single colour breathes, two
// cycle, all three is a rainbow. Friendlier names for its dropdown.
const RGB_LABEL = { off: "colorOff", red: "rgbRed", green: "rgbGreen", blue: "rgbBlue",
  yellow: "rgbYellow", cyan: "rgbCyan", magenta: "rgbMagenta", white: "rgbWhite" };
const COLOR_LABEL = { off: "colorOff", white: "colorWhite", red: "rgbRed", green: "rgbGreen", blue: "rgbBlue", orange: "colorOrange",
  yellow: "colorYellow", cyan: "colorCyan", magenta: "colorMagenta" };
const colorName = (id, c) => (id === "rgb" ? (RGB_LABEL[c] ? t(RGB_LABEL[c]) : c) : (COLOR_LABEL[c] ? t(COLOR_LABEL[c]) : c));
// t6-ledd reports animated effects as "blink red" / "heartbeat blue".
const splitEffect = (e) => {
  const m = /^(blink|heartbeat) (\w+)$/.exec(e || "");
  return m ? { fx: m[1], color: m[2] } : { fx: "", color: e };
};
const effectName = (id, e) => {
  const { fx, color } = splitEffect(e);
  const c = colorName(id, color);
  return fx === "blink" ? t("fxBlink", { c }) : fx === "heartbeat" ? t("fxHeartbeat", { c }) : c;
};

function wifiWhy(w) {
  if (!w) return "";
  const c = escapeHtml(w.connection || w.iface || "Wi-Fi");
  const sig = w.signal_dbm != null && ["connected", "weak-signal"].includes(w.reason) ? ` · ${w.signal_dbm} dBm` : "";
  return t(`wifi.${w.reason}`, { c, s: sig });
}

const btWhy = (b) => (b ? t(`bt.${b.reason}`, { n: b.connections }) : "");
// Status LEDs: shown in their own card (on = automatic, off = kept dark),
// not in the per-LED table.
function powerWhy(p) {
  if (!p) return "";
  if (p.overheat) {
    const s = p.overheat.sensor.replace(/^bay (\d)$/, (_, n) => `${t("bayN", { n })}`);
    return t("power.hot", { s: escapeHtml(s), t: Math.round(p.overheat.temp_c) });
  }
  return t(p.screen_on ? "power.screenOn" : "power.screenOff");
}

const LED_STATUS = {
  power: { why: (l) => powerWhy(l.power), fault: (l) => !!l.power?.overheat },
  wifi: { why: (l) => wifiWhy(l.wifi), fault: (l) => l.wifi?.state === "fault" },
  bt: { why: (l) => btWhy(l.bluetooth), fault: (l) => l.bluetooth?.state === "fault" },
};

function renderRadioLeds(l, editable) {
  for (const box of document.querySelectorAll(".radio-led")) {
    const id = box.dataset.id;
    const d = l.devices.find((x) => x.id === id);
    box.hidden = !d || !d.available;
    if (!d) continue;
    const on = d.mode === "auto";
    const cb = $(".radio-show", box);
    if (document.activeElement !== cb) cb.checked = on;
    cb.disabled = !editable;
    const st = LED_STATUS[id];
    const night = l.night?.active && on && !st.fault(l);
    const tail = !on ? ` · ${t("ledKeptOff")}` : night ? ` · ${t("nightOff")}` : "";
    $(".led-status", box).innerHTML = `${swatch(on && !night ? d.effective : "off")}${st.why(l)}${tail}`;
  }
}

const LED_SWATCH = {
  off: "#e5e7eb", white: "#f8fafc", red: "#ef4444", green: "#22c55e", blue: "#3b82f6",
  yellow: "#eab308", cyan: "#06b6d4", magenta: "#d946ef", orange: "#f97316",
};

function swatch(effect) {
  const { fx, color } = splitEffect(effect);
  return `<i class="dot${fx ? ` fx-${fx}` : ""}" style="background:${LED_SWATCH[color] || "#e5e7eb"}"></i>`;
}

function renderLeds(l) {
  const box = $("#leds-notice");
  if (!l) {
    box.textContent = t("ledsDown");
    box.hidden = false;
    return;
  }
  box.hidden = !l.config_error;
  if (l.config_error) box.textContent = t("ledsConfig", { e: l.config_error });
  const editable = state.admin;
  $("#leds-note").textContent = editable ? "" : t("adminRequiredChange");

  // night mode
  const n = l.night;
  $("#night-state").textContent = n.active ? t("nightActive", { r: n.reason }) : t("off");
  state.nightSched = n.schedule || "";
  if (!state.nightDirty) {
    $("#night-manual").checked = !!n.manual;
    $("#night-sched").checked = !!n.schedule;
    if (n.schedule) {
      const [a, b] = n.schedule.split("-");
      $("#night-start").value = a;
      $("#night-end").value = b;
    }
  }
  ["#night-manual", "#night-sched", "#night-start", "#night-end", "#night-apply", "#night-revert"].forEach((id) => ($(id).disabled = !editable));
  updateNightActions();

  // bay LEDs: automatic (present -> white, fault -> blink red)
  $("#bays-enabled").checked = !!l.bays_enabled;
  $("#bays-enabled").disabled = !editable;
  $("#bay-fault-blink").checked = !!l.bay_fault_blink;
  $("#bay-fault-blink").disabled = !editable;
  const present = l.bays_present || [];
  $("#bay-summary").textContent = present.length ? t("drivesIn", { b: present.join(", ") }) : t("noDrives");
  const faults = l.faults || [];
  const warn = $("#bay-fault-warn");
  warn.hidden = faults.length === 0;
  if (faults.length) warn.textContent = t("driveFault", { b: faults.join(", ") });

  // device rows: rebuild only when the set of devices changes
  const table = $("#led-devices");
  renderRadioLeds(l, editable);
  const devs = l.devices.filter((d) => !d.bay && !LED_STATUS[d.id]);
  const key = devs.map((d) => d.id).join(",");
  if (table.dataset.key !== key) {
    table.dataset.key = key;
    table.innerHTML = devs.map((d) => `
      <tr data-id="${d.id}">
        <td class="name">${d.label}</td>
        <td class="eff"></td>
        <td>${d.colors.length
          ? `<select class="led-color">${d.auto ? `<option value="auto">${t("automatic", { d: d.auto_desc })}</option>` : ""}${d.colors.map((c) => `<option value="${c}">${colorName(d.id, c)}</option>`).join("")}</select>`
          : `<span class="meta">${t("automatic", { d: d.auto_desc })}</span>`}${d.id === "rgb"
          ? ` <select class="tray-speed" title="${t("breathSpeed")}"><option value="slow">${t("slow")}</option><option value="normal">${t("normal")}</option><option value="fast">${t("fast")}</option></select>`
          : ""}</td>
      </tr>`).join("");
  }
  for (const d of devs) {
    const row = table.querySelector(`tr[data-id="${d.id}"]`);
    const forced = n.active;
    const eff = d.effective === "auto" ? t("automaticShort") : effectName(d.id, d.effective);
    $(".eff", row).innerHTML = `${swatch(d.effective)}${eff}${forced ? t("forcedOff") : ""}${d.available ? "" : t("ledNA")}`;
    const sel = $(".led-color", row);
    if (sel) {
      const want = d.mode === "auto" ? "auto" : d.color;
      if (document.activeElement !== sel && sel.value !== want) sel.value = want;
      sel.disabled = !editable;
    }
    const spd = $(".tray-speed", row);
    if (spd) {
      if (document.activeElement !== spd && l.tray_speed) spd.value = l.tray_speed;
      spd.disabled = !editable;
    }
  }
}

$("#led-devices").addEventListener("change", async (e) => {
  const sel = e.target.closest("select");
  if (!sel) return;
  const id = sel.closest("tr").dataset.id;
  try {
    if (sel.classList.contains("tray-speed")) {
      await api("leds/tray-speed", { method: "PUT", body: { speed: sel.value } });
    } else {
      await api(`leds/${id}`, { method: "PUT", body: { value: sel.value } });
    }
    notice("");
  } catch (err) {
    notice(t("setFail", { id, e: err.message }), "error");
  }
});
$("#radio-leds").addEventListener("change", async (e) => {
  const cb = e.target.closest(".radio-show");
  if (!cb) return;
  const id = cb.closest(".radio-led").dataset.id;
  try {
    await api(`leds/${id}`, { method: "PUT", body: { value: cb.checked ? "auto" : "off" } });
    notice("");
  } catch (err) {
    notice(t("setFail", { id, e: err.message }), "error");
  }
});
$("#bays-enabled").addEventListener("change", async (e) => {
  try { await api("leds/bays", { method: "PUT", body: { on: e.target.checked } }); }
  catch (err) { notice(t("bayFail", { e: err.message }), "error"); }
});
$("#bay-fault-blink").addEventListener("change", async (e) => {
  try { await api("leds/bay-fault-blink", { method: "PUT", body: { on: e.target.checked } }); }
  catch (err) { notice(t("faultFail", { e: err.message }), "error"); }
});
$("#night-manual").addEventListener("change", async (e) => {
  try { await api("leds/night", { method: "PUT", body: { on: e.target.checked } }); }
  catch (err) { notice(t("nightFail", { e: err.message }), "error"); }
});
function nightSchedInput() {
  return $("#night-sched").checked ? `${$("#night-start").value}-${$("#night-end").value}` : "";
}
// Apply/Revert appear only when the schedule differs from what is running.
function updateNightActions() {
  const dirty = nightSchedInput() !== (state.nightSched || "");
  $("#night-actions").hidden = !dirty;
  $("#night-apply").disabled = !state.admin || !dirty;
  $("#night-revert").disabled = !state.admin || !dirty;
}
["#night-sched", "#night-start", "#night-end"].forEach((id) => $(id).addEventListener("input", () => {
  state.nightDirty = true;
  updateNightActions();
}));
$("#night-revert").addEventListener("click", () => {
  const sched = state.nightSched;
  $("#night-sched").checked = !!sched;
  if (sched) { const [a, b] = sched.split("-"); $("#night-start").value = a; $("#night-end").value = b; }
  state.nightDirty = false;
  updateNightActions();
});
$("#night-apply").addEventListener("click", async () => {
  const schedule = nightSchedInput();
  try {
    await api("leds/night", { method: "PUT", body: { schedule } });
    state.nightSched = schedule;
    state.nightDirty = false;
    updateNightActions();
    notice("");
  } catch (err) {
    notice(t("schedFail", { e: err.message }), "error");
  }
});

// ---- beeper ---------------------------------------------------------------

$("#beep-buttons").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  try { await api("beep", { method: "POST", body: { pattern: +b.dataset.pattern } }); }
  catch (err) { notice(t("beepFail", { e: err.message }), "error"); }
});
document.querySelector(".beep-events").addEventListener("change", async (e) => {
  const cb = e.target.closest("input[data-event]");
  if (!cb) return;
  try { await api("beep/event", { method: "PUT", body: { event: cb.dataset.event, enabled: cb.checked } }); }
  catch (err) { notice(t("beepSetFail", { e: err.message }), "error"); }
});

// ---- system ---------------------------------------------------------------

let lastSystemLoad = 0;
async function loadSystem() {
  try {
    const s = await api("system");
    lastSystemLoad = Date.now();
    if (s.hostname) $("#hero-host").textContent = s.hostname;
    const yes = (b) => (b ? t("running") : t("notRunning"));
    const mod = (m) => (m.loaded ? (m.version ? t("loadedV", { v: m.version }) : t("loaded")) : t("notLoaded"));
    $("#sys-info").innerHTML = [
      [t("appTitle"), t("thisApp"), s.app_version],
      [t("kernel"), t("linuxVersion"), s.kernel],
      ["t6_platform", t("platformDesc"), mod(s.modules.t6_platform)],
      ["ft8722_ts", t("touchDesc"), mod(s.modules.ft8722_ts)],
      ["ite_it6616", t("bridgeDesc"), mod(s.modules.ite_it6616)],
      ["t6-fand", t("fandDesc"), yes(s.daemons["t6-fand"])],
      ["t6-ledd", t("leddDesc"), yes(s.daemons["t6-ledd"])],
    ].map(([k, d, v]) => `<li><span class="sw-name"><b>${k}</b><small>${d}</small></span><b>${v}</b></li>`).join("");
  } catch (e) {
    // Transient (e.g. the gateway not warm yet at startup). The poll retries
    // it and it self-heals, so don't raise a banner.
  }
}

// Refresh the software card at most every 15 s from the (recovering) poll.
function maybeLoadSystem() {
  if (Date.now() - lastSystemLoad > 15000) { loadSystem(); loadHealth(); }
}

// ---- drivers & services health --------------------------------------------

let healthTimer = null;
let repairRequested = false; // show the log of the run we started as it streams in

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

async function loadHealth() {
  clearTimeout(healthTimer);
  let h;
  try { h = await api("health"); } catch (e) { return; }
  const card = $("#health");
  const running = h.repair.running;
  const last = h.repair.last;
  const failed = !running && last && last.ok === false;
  // The hero tile carries the everyday "all running"; the full card (problems,
  // Repair button, log) only shows when there is something to act on.
  card.hidden = !(h.problems.length || running || failed);
  const tile = $("#hero-health");
  tile.textContent = running ? t("repairingShort") : h.problems.length ? t("healthProblems", { n: h.problems.length }) : failed ? t("repairFailed") : t("healthOk");
  tile.className = running ? "" : h.problems.length || failed ? "warn" : "ok";
  card.classList.toggle("bad", h.problems.length > 0 || failed);
  card.classList.toggle("ok", !h.problems.length && !running && !failed);
  $("#health-kernel").textContent = t("kernelV", { k: h.kernel });

  let status;
  if (running) status = t("repairing");
  else if (h.problems.length) status = t("problems");
  else status = t("allGood");
  $("#health-status").textContent = status;
  // Messages (from the backend, English) may quote a command in backticks.
  $("#health-problems").innerHTML = h.problems
    .map((p) => `<li>${escapeHtml(p).replace(/`([^`]+)`/g, "<code>$1</code>")}</li>`).join("");

  const actions = $("#health-actions");
  actions.hidden = !(h.problems.length || running);
  const btn = $("#health-repair");
  btn.hidden = !h.repair.available;
  btn.disabled = !state.admin || !h.can_repair;
  let note = "";
  if (!h.repair.available) note = t("updateDrivers");
  else if (!state.admin) note = t("adminRequired");
  else if (h.dpkg_busy) note = t("dpkgBusy");
  else if (h.modules.some((m) => !m.built) && !h.headers) note = t("needHeaders");
  $("#health-note").textContent = running ? "" : note;

  const wrap = $("#health-log-wrap");
  wrap.hidden = !last || !last.log.length;
  if (last) {
    const when = last.time_us ? new Date(last.time_us / 1000).toLocaleString(state.language) : "";
    // A repair run checks first and only rebuilds/loads/restarts what is
    // missing; a run that did none of that just confirmed things were fine.
    const acted = last.log.some((l) => /^==> (building|loading|restarting|installing|removing) /.test(l));
    const outcome = running ? t("repairRunning")
      : last.ok === false ? t("repairFailed")
      : last.ok === true ? (acted ? t("repairOk") : t("repairNoop")) : "";
    $("#health-log-title").textContent = `${t("lastRepair")}${outcome ? " · " + outcome : ""}${when ? " · " + when : ""}`;
    $("#health-log").textContent = last.log.join("\n");
    if (running || (repairRequested && failed)) wrap.open = true;
  }
  if (!running && repairRequested) {
    repairRequested = false;
    notice(failed ? t("repairFailNotice") : t("repairedNotice"), failed ? "error" : "");
    loadSystem();
  }
  if (running) healthTimer = setTimeout(loadHealth, 2000);
}

$("#health-repair").addEventListener("click", async () => {
  const btn = $("#health-repair");
  btn.disabled = true;
  try {
    await api("health/repair", { method: "POST" });
    repairRequested = true;
    notice("");
    // systemd needs a moment to report the unit as activating.
    setTimeout(loadHealth, 500);
  } catch (err) {
    notice(t("repairFail", { e: err.message }), "error");
    loadHealth();
  }
});

// ---- fan curve editor (custom profile) ------------------------------------

const EDIT_PROFILE = "custom";
const COLORS = { silent: "#16a34a", balance: "#1677ff", performance: "#dc2626", custom: "#7c3aed" };
const colorFor = (name) => COLORS[name] || "#6b7280";

// plot geometry
const PLOT = { L: 34, R: 10, T: 12, B: 24, tMin: 20, tMax: 100 };

function interp(points, temp) {
  if (temp <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (temp >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [t0, p0] = points[i - 1], [t1, p1] = points[i];
    if (temp <= t1) return p0 + (p1 - p0) * (temp - t0) / (t1 - t0);
  }
  return last[1];
}

function plotMap(canvas) {
  const { L, R, T, B, tMin, tMax } = PLOT, W = canvas.width, H = canvas.height;
  return {
    x: (v) => L + ((v - tMin) / (tMax - tMin)) * (W - L - R),
    y: (p) => T + (1 - p / 100) * (H - T - B),
    tAt: (cx) => tMin + ((cx - L) / (W - L - R)) * (tMax - tMin),
    pAt: (cy) => (1 - (cy - T) / (H - T - B)) * 100,
    W, H, T, B,
  };
}

function drawZone(canvas, zone) {
  const cfg = state.config.zones[zone];
  const edited = state.fanEdited[zone];
  const m = plotMap(canvas);
  const ctx = canvas.getContext("2d");
  const { L, R, T, B, tMin, tMax } = PLOT, W = m.W, H = m.H;
  ctx.clearRect(0, 0, W, H);

  // grid
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = cssVar("--subtle"); ctx.strokeStyle = cssVar("--grid"); ctx.lineWidth = 1;
  for (let p = 0; p <= 100; p += 25) {
    ctx.beginPath(); ctx.moveTo(L, m.y(p)); ctx.lineTo(W - R, m.y(p)); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText(`${p}%`, L - 4, m.y(p) + 4);
  }
  for (let v = tMin; v <= tMax; v += 20) {
    ctx.beginPath(); ctx.moveTo(m.x(v), T); ctx.lineTo(m.x(v), H - B); ctx.stroke();
    ctx.textAlign = "center"; ctx.fillText(`${v}°`, m.x(v), H - 8);
  }

  const ring = cssVar("--panel");
  const drawLine = (pts, color, width, alpha, dots) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.moveTo(m.x(tMin), m.y(pts[0][1]));
    pts.forEach(([v, p]) => ctx.lineTo(m.x(v), m.y(p)));
    ctx.lineTo(m.x(tMax), m.y(pts[pts.length - 1][1])); ctx.stroke();
    if (dots) {
      ctx.fillStyle = color;
      pts.forEach(([v, p]) => { ctx.beginPath(); ctx.arc(m.x(v), m.y(p), 4.5, 0, 2 * Math.PI); ctx.fill();
        ctx.strokeStyle = ring; ctx.lineWidth = 1.5; ctx.stroke(); });
    }
    ctx.globalAlpha = 1;
  };

  // The selected profile's curve is highlighted; custom is draggable only
  // while it is the selected profile.
  const active = state.activeProfile;
  const editing = active === EDIT_PROFILE;
  for (const name of ["silent", "balance", "performance"]) {
    if (!cfg.curves[name]) continue;
    const on = name === active;
    drawLine(cfg.curves[name], colorFor(name), on ? 2.5 : 1.25, on ? 1 : 0.3, false);
  }
  drawLine(edited, colorFor(EDIT_PROFILE), editing ? 2.5 : 1.25, editing ? 1 : 0.3, editing);

  // "now" marker: vertical line at current temp, dot on the custom curve
  const temp = state.fanTemps[zone];
  if (temp != null) {
    const warn = cssVar("--warn");
    const cx = m.x(Math.max(tMin, Math.min(tMax, temp)));
    ctx.strokeStyle = warn; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, T); ctx.lineTo(cx, H - B); ctx.stroke(); ctx.setLineDash([]);
    const duty = interp(edited, temp);
    ctx.fillStyle = warn;
    ctx.beginPath(); ctx.arc(cx, m.y(duty), 3.5, 0, 2 * Math.PI); ctx.fill();
  }
}

function redrawEditor() {
  if (!state.config) return;
  document.querySelectorAll("#curves canvas").forEach((c) => drawZone(c, c.dataset.zone));
}

function zoneDirty(zone) {
  return state.config && state.config.zones[zone] &&
    JSON.stringify(state.fanEdited[zone]) !== JSON.stringify(state.config.zones[zone].curves[EDIT_PROFILE]);
}

function anyDirty() {
  return Object.keys(state.fanEdited).some(zoneDirty);
}

// The two page-level buttons: shown only while Custom is selected, enabled
// only when there are unsaved edits.
function updateCurveBar() {
  const bar = $("#curve-bar");
  if (!bar) return;
  const custom = state.activeProfile === EDIT_PROFILE;
  bar.hidden = !custom;
  if (!custom) return;
  const dirty = anyDirty();
  $("#curve-apply").disabled = !state.admin || !dirty;
  $("#curve-revert").disabled = !dirty;
  $("#curve-hint").textContent = dirty ? t("unsaved") : (state.admin ? t("dragHint") : t("adminRequiredEdit"));
}

// --- pointer interaction ---
function pointerPos(canvas, e) {
  const r = canvas.getBoundingClientRect();
  return { cx: (e.clientX - r.left) * (canvas.width / r.width), cy: (e.clientY - r.top) * (canvas.height / r.height) };
}

function attachEditing(canvas) {
  const zone = canvas.dataset.zone;
  let drag = -1;
  const readout = canvas.parentElement.querySelector(".curve-readout");

  const clampPoint = (i, v, p) => {
    const pts = state.fanEdited[zone];
    const lo = i > 0 ? pts[i - 1][0] + 1 : -20;
    const hi = i < pts.length - 1 ? pts[i + 1][0] - 1 : 150;
    return [Math.max(lo, Math.min(hi, Math.round(v))), Math.max(0, Math.min(100, Math.round(p)))];
  };
  const show = (i) => {
    if (readout) readout.textContent = i >= 0 ? `${state.fanEdited[zone][i][0]} °C → ${state.fanEdited[zone][i][1]} %` : "";
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (!state.admin || state.activeProfile !== EDIT_PROFILE) return;
    const m = plotMap(canvas), pts = state.fanEdited[zone];
    const { cx, cy } = pointerPos(canvas, e);
    // nearest existing point
    let best = -1, bestD = 14 * 14;
    pts.forEach(([v, p], i) => { const dx = m.x(v) - cx, dy = m.y(p) - cy, d = dx * dx + dy * dy; if (d < bestD) { bestD = d; best = i; } });
    if (best < 0) {
      // add a point where clicked (clamped, sorted), then drag it
      const v = Math.round(Math.max(PLOT.tMin - 10, Math.min(PLOT.tMax + 10, m.tAt(cx))));
      const p = Math.round(Math.max(0, Math.min(100, m.pAt(cy))));
      if (pts.some((q) => q[0] === v)) return; // avoid duplicate temp
      pts.push([v, p]); pts.sort((a, b) => a[0] - b[0]);
      best = pts.findIndex((q) => q[0] === v);
    }
    drag = best;
    state.fanDragging = true;
    canvas.setPointerCapture(e.pointerId);
    show(drag); drawZone(canvas, zone);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (drag < 0) return;
    const m = plotMap(canvas), { cx, cy } = pointerPos(canvas, e);
    state.fanEdited[zone][drag] = clampPoint(drag, m.tAt(cx), m.pAt(cy));
    show(drag); drawZone(canvas, zone);
  });

  const end = (e) => {
    if (drag < 0) return;
    const { cy } = pointerPos(canvas, e);
    // drag above the top edge deletes the point (keep at least two)
    if (cy < PLOT.T - 4 && state.fanEdited[zone].length > 2) {
      state.fanEdited[zone].splice(drag, 1);
    }
    drag = -1; state.fanDragging = false; show(-1);
    drawZone(canvas, zone); updateCurveBar();
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
}

async function applyAll() {
  const zones = Object.keys(state.fanEdited).filter(zoneDirty);
  try {
    for (const zone of zones) {
      await api("fan/curve", { method: "PUT", body: { zone, profile: EDIT_PROFILE, points: state.fanEdited[zone] } });
      state.config.zones[zone].curves[EDIT_PROFILE] = state.fanEdited[zone].map((p) => p.slice());
    }
    updateCurveBar();
    notice("");
  } catch (e) {
    notice(t("curvesFail", { e: e.message }), "error");
  }
}

function revertAll() {
  for (const zone of Object.keys(state.fanEdited)) {
    state.fanEdited[zone] = state.config.zones[zone].curves[EDIT_PROFILE].map((p) => p.slice());
  }
  redrawEditor();
  updateCurveBar();
}

async function loadCurves() {
  try {
    const data = await api("fan/config");
    state.config = data.config;
    $("#config-path").textContent = data.path;
    const box = $("#curves");
    box.innerHTML = "";
    for (const [zone, z] of Object.entries(data.config.zones)) {
      if (!z.curves[EDIT_PROFILE]) continue;
      state.fanEdited[zone] = z.curves[EDIT_PROFILE].map((p) => p.slice());
      const card = document.createElement("div");
      card.className = "panel";
      card.dataset.zoneCard = zone;
      const legend = ["silent", "balance", "performance", "custom"]
        .filter((n) => z.curves[n]).map((n) => `<span><i style="background:${colorFor(n)}"></i>${profileName(n)}</span>`).join("");
      card.innerHTML = `
        <div class="section-head"><h3>${z.fan}</h3><span class="meta curve-readout"></span></div>
        <canvas class="curve" width="360" height="180" data-zone="${zone}"></canvas>
        <div class="legend">${legend}</div>
        <div class="params">
          ${t("sensorsLbl")}: ${z.sensors.join(", ")}<br>
          ${t("filterLbl", { s: z.tau_secs ?? 0 })} · ${t("hystLbl", { h: z.hysteresis ?? 3 })} ·
          ${t("rampLbl", { u: z.ramp_up ?? 25, d: z.ramp_down ?? 5 })} · ${t("floorLbl", { f: z.min_pwm ?? 8 })} ·
          ${t("kickLbl", { p: z.start_pwm ?? 12, s: z.kick_secs ?? 3 })}
        </div>`;
      box.appendChild(card);
      const canvas = $(".curve", card);
      drawZone(canvas, zone);
      attachEditing(canvas);
    }
    updateCurveBar();
  } catch (e) {
    notice(t("configFail", { e: e.message }), "error");
  }
}

$("#curve-apply").addEventListener("click", applyAll);
$("#curve-revert").addEventListener("click", revertAll);

// ---- polling ---------------------------------------------------------------

let pollTimer = null;
let polling = false;

function pollLoop() {
  clearTimeout(pollTimer);
  if (polling) return;          // avoid overlapping requests on slow links
  polling = true;
  refresh().finally(() => {
    polling = false;
    pollTimer = setTimeout(pollLoop, 1000);
  });
}

// Reconnect promptly when the tab/app is brought back or the network returns,
// instead of waiting for the next tick.
document.addEventListener("visibilitychange", () => { if (!document.hidden) pollLoop(); });
window.addEventListener("focus", pollLoop);
window.addEventListener("online", pollLoop);

applyPreferences();
pollLoop();
initPlatform();
