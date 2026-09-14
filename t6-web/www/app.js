// T6 Control Center – front end. Plain JS, no build step.
// All requests are relative, so the page works under any gateway prefix.

const $ = (sel, root = document) => root.querySelector(sel);
const HISTORY = 120; // samples kept per zone for the sparkline (1/s)

const state = {
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
};

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

// ---- tabs -----------------------------------------------------------------

$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn || btn.disabled) return;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== btn.dataset.tab));
  if (btn.dataset.tab === "fans") loadCurves();
  if (btn.dataset.tab === "dashboard") loadSystem();
});

// ---- dashboard ------------------------------------------------------------

function renderUser(u) {
  state.admin = !!u.is_admin;
  const el = $("#user");
  el.textContent = state.admin ? "admin" : "read-only";
  el.classList.toggle("admin", state.admin);
}

function renderActiveProfile(fan) {
  const active = fan.running && fan.status ? fan.status.profile : null;
  $("#active-profile").textContent = active ? `profile: ${active}` : "";
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
    box.innerHTML = fan.profiles.map((p) => `<button data-profile="${p}">${p}</button>`).join("");
  }
  box.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.profile === active);
    b.disabled = !state.admin || !fan.running;
  });
  state.activeProfile = active;
  if (typeof updateCurveBar === "function") updateCurveBar();
  const note = $("#profile-note");
  if (!state.admin) note.textContent = "administrator required to change";
  else if (fan.profile_override && fan.profile_override !== fan.config_profile)
    note.textContent = `runtime override (config default: ${fan.config_profile})`;
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
    notice(`Could not switch profile: ${err.message}`, "error");
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
  ctx.fillStyle = "rgba(47,111,237,.15)";
  ctx.beginPath();
  ctx.moveTo(x(0), H);
  h.forEach((s, i) => ctx.lineTo(x(i), H - (s.pwm / 100) * H));
  ctx.lineTo(x(h.length - 1), H);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#d97706";
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
  if (!fan.running || !fan.status) {
    box.innerHTML = "";
    notice("t6-fand is not running – fans are at the driver default (50 %).");
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
    $(".rpm", card).textContent = z.rpm == null ? "" : `${z.rpm} rpm`;
    const big = $(".pwm", card);
    big.textContent = running ? `${z.pwm_percent} %` : "stopped";
    big.classList.toggle("stopped", !running);
    $(".bar > i", card).style.width = `${z.pwm_percent}%`;
    $(".sensors", card).innerHTML = z.sensors
      .map((s) => `<li><span title="${s.name}">${s.name}</span><b>${s.temp_c == null ? "—" : s.temp_c.toFixed(1) + " °C"}</b></li>`)
      .join("");
    drawSpark($(".spark", card), pushHistory(z));
  }
}

async function refresh() {
  try {
    const s = await api("status");
    pollFails = 0;
    clearConnError();
    renderUser(s.user);
    renderActiveProfile(s.fan);
    renderProfiles(s.fan);
    renderZones(s.fan);
    if (s.fan.running && s.fan.status) {
      s.fan.status.zones.forEach((z) => (state.fanTemps[z.zone] = z.temp_c));
      if (!$("#fans").hidden && !state.fanDragging) redrawEditor();
    }
    renderBattery(s.battery);
    renderDisplay(s.display);
    renderLeds(s.leds);
    document.querySelectorAll("#beep-buttons button").forEach((b) => (b.disabled = !state.admin || !s.leds));
    $("#beep-note").textContent = !state.admin ? "administrator required" : "";
    document.querySelectorAll(".beep-events input").forEach((cb) => {
      cb.disabled = !state.admin || !s.leds;
      const beep = s.leds && s.leds.beep;
      if (beep && document.activeElement !== cb) cb.checked = !!beep[cb.dataset.event];
    });
    if (s.fan.running && $("#notice").textContent.startsWith("t6-fand is not running")) notice("");
    maybeLoadSystem();
  } catch (e) {
    // A single miss is almost always a transient blip (mobile webview
    // suspend/resume, a Wi-Fi hiccup, or t6-webd restarting on an upgrade).
    // The loop keeps polling and recovers on its own, so only surface it
    // after a few consecutive failures.
    pollFails++;
    if (pollFails >= 3) setConnError("Reconnecting to the T6\u2026");
  }
}

// ---- battery --------------------------------------------------------------

function fmtHours(h) {
  if (!isFinite(h) || h <= 0) return "";
  const m = Math.round(h * 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

// One-line human summary of the charging state.
function batterySummary(b) {
  if (!b.present) return "no battery";
  const t = b.thresholds;
  const held = t && !(t.start === 0 && t.end === 100) && b.status === "Not charging" && b.ac_online;
  const parts = [b.ac_online ? "on mains" : "on battery"];
  if (b.status === "Charging") {
    parts.push("charging" + (b.power_w > 0.5 ? ` at ${b.power_w.toFixed(1)} W` : ""));
    const target = t ? t.end : 100;
    const eta = b.power_w > 0.5 ? (b.energy_full_wh * target / 100 - b.energy_now_wh) / b.power_w : NaN;
    if (fmtHours(eta)) parts.push(`~${fmtHours(eta)} to ${target} %`);
  } else if (b.status === "Discharging") {
    if (b.power_w > 0.5) parts.push(`${b.power_w.toFixed(1)} W`);
    const eta = b.power_w > 0.5 ? b.energy_now_wh / b.power_w : NaN;
    if (fmtHours(eta)) parts.push(`~${fmtHours(eta)} left`);
  } else if (held) {
    parts.push(`holding between ${t.start}–${t.end} %`);
  } else if (b.status) {
    parts.push(b.status.toLowerCase());
  }
  return parts.join(" · ");
}

function renderBattery(b) {
  const soc = b.capacity == null ? "—" : `${b.capacity} %`;
  const summary = batterySummary(b);
  const limits = b.thresholds ? (b.thresholds.start === 0 && b.thresholds.end === 100 ? "EC policy" : `limits ${b.thresholds.start}–${b.thresholds.end} %`) : "";
  $("#bo-soc").textContent = soc;
  $("#bo-status").textContent = summary;
  $("#bo-limits").textContent = limits;
  $("#bo-bar").style.width = `${b.capacity || 0}%`;

  $("#bat-soc").textContent = soc;
  $("#bat-status").textContent = summary;
  $("#bat-bar").style.width = `${b.capacity || 0}%`;
  $("#bat-model").textContent = [b.manufacturer, b.model].filter(Boolean).join(" ");
  const rows = [
    ["Voltage", b.voltage_v != null ? `${b.voltage_v.toFixed(2)} V` : null],
    ["Energy", b.energy_now_wh != null ? `${b.energy_now_wh.toFixed(1)} / ${b.energy_full_wh.toFixed(1)} Wh` : null],
    ["Health", b.health_percent != null ? `${b.health_percent.toFixed(0)} % of design (${b.energy_full_design_wh.toFixed(1)} Wh)` : null],
    ["Chemistry", b.technology],
  ].filter(([, v]) => v);
  $("#bat-details").innerHTML = rows.map(([k, v]) => `<li><span>${k}</span><b>${v}</b></li>`).join("");

  // Limits form: choices are staged and only committed with Apply.
  state.batteryThresholds = b.thresholds || null;
  const editable = state.admin && !!b.thresholds;
  document.querySelectorAll("#lim-presets button").forEach((p) => (p.disabled = !editable));
  ["#lim-start", "#lim-end"].forEach((id) => ($(id).disabled = !editable));
  $("#lim-note").textContent = !state.admin ? "administrator required to change" : "";
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
  $("#lim-status").textContent = "applying…";
  try {
    const r = await api("battery/thresholds", { method: "PUT", body: { start: s.start, end: s.end } });
    state.batteryThresholds = { start: r.start, end: r.end };
    state.limMode = presetFor(r.start, r.end) ? "preset" : "custom";
    $("#lim-status").textContent = r.ec_policy
      ? "applied — EC policy (charges to ~97 %, tops up from 91 %)"
      : `applied — charging ${r.start}–${r.end} %, kept across reboots`;
    updateLimActions();
  } catch (err) {
    $("#lim-status").textContent = `failed: ${err.message}`;
    notice(`Could not set charge limits: ${err.message}`, "error");
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
  $("#bl-note").textContent = !d.present ? "not available" : !state.admin ? "administrator required to change" : "";
  if (d.max_brightness) $("#bl-slider").max = d.max_brightness;
  if (d.min_on) $("#bl-slider").min = d.min_on;
  if (!state.blDragging) {
    $("#bl-power").checked = d.on;
    $("#bl-power-label").textContent = d.on ? "On" : "Off until next reboot";
    $("#bl-slider").value = d.on ? Math.max(d.brightness || 0, d.min_on || 10) : d.on_level;
    syncBrightnessLabel();
  }
  const ob = $("#bl-off-boot");
  ob.disabled = !editable;
  if (document.activeElement !== ob) ob.checked = !!d.off_after_boot;
}

function syncBrightnessLabel() {
  $("#bl-value").textContent = `${+$("#bl-slider").value} %`;
}

async function setBrightness(v) {
  try {
    await api("display/brightness", { method: "PUT", body: { brightness: v } });
  } catch (err) {
    notice(`Could not set brightness: ${err.message}`, "error");
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
  $("#bl-power-label").textContent = on ? "On" : "Off until next reboot";
  $("#bl-slider").disabled = !on;
  try {
    await api("display/power", { method: "PUT", body: { on } });
    if (on) {
      // Turning the screen on means you want it — cancel "always off after boot".
      $("#bl-off-boot").checked = false;
      await api("display/off-after-boot", { method: "PUT", body: { off_after_boot: false } });
    }
  } catch (err) {
    notice(`Could not switch the backlight: ${err.message}`, "error");
  }
});
$("#bl-off-boot").addEventListener("change", async (e) => {
  try {
    await api("display/off-after-boot", { method: "PUT", body: { off_after_boot: e.target.checked } });
  } catch (err) {
    notice(`Could not change the boot setting: ${err.message}`, "error");
  }
});

// ---- LEDs -----------------------------------------------------------------

// The tray light is an effect controller: single colour breathes, two
// cycle, all three is a rainbow. Friendlier names for its dropdown.
const RGB_LABEL = { off: "off", red: "red", green: "green", blue: "blue",
  yellow: "red + green (cycle)", cyan: "green + blue (cycle)",
  magenta: "red + blue (cycle)", white: "rainbow" };

const LED_SWATCH = {
  off: "#e5e7eb", white: "#f8fafc", red: "#ef4444", green: "#22c55e", blue: "#3b82f6",
  yellow: "#eab308", cyan: "#06b6d4", magenta: "#d946ef", orange: "#f97316",
};

function swatch(color) {
  return `<i class="dot" style="background:${LED_SWATCH[color] || "#e5e7eb"}"></i>`;
}

function renderLeds(l) {
  const notice = $("#leds-notice");
  if (!l) {
    notice.textContent = "t6-ledd is not running – LEDs are unmanaged.";
    notice.hidden = false;
    return;
  }
  notice.hidden = !l.config_error;
  if (l.config_error) notice.textContent = `Configuration problem (defaults in use): ${l.config_error}`;
  const editable = state.admin;
  $("#leds-note").textContent = editable ? "" : "administrator required to change";

  // night mode
  const n = l.night;
  $("#night-state").textContent = n.active ? `active (${n.reason})` : "off";
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
  $("#bay-summary").textContent = present.length ? `drives in bay ${present.join(", ")}` : "no drives detected";
  const faults = l.faults || [];
  const warn = $("#bay-fault-warn");
  warn.hidden = faults.length === 0;
  if (faults.length) warn.textContent = `\u26a0 Drive fault \u2014 bay ${faults.join(", ")} is blinking red`;

  // device rows: rebuild only when the set of devices changes
  const table = $("#led-devices");
  const devs = l.devices.filter((d) => !d.bay);
  const key = devs.map((d) => d.id).join(",");
  if (table.dataset.key !== key) {
    table.dataset.key = key;
    table.innerHTML = devs.map((d) => `
      <tr data-id="${d.id}">
        <td class="name">${d.label}</td>
        <td class="eff"></td>
        <td>${d.colors.length
          ? `<select class="led-color">${d.auto ? `<option value="auto">Automatic – ${d.auto_desc}</option>` : ""}${d.colors.map((c) => `<option value="${c}">${d.id === "rgb" ? RGB_LABEL[c] || c : c}</option>`).join("")}</select>`
          : `<span class="muted">Automatic – ${d.auto_desc}</span>`}${d.id === "rgb"
          ? ` <select class="tray-speed" title="Breathing speed"><option value="slow">slow</option><option value="normal">normal</option><option value="fast">fast</option></select>`
          : ""}</td>
      </tr>`).join("");
  }
  for (const d of devs) {
    const row = table.querySelector(`tr[data-id="${d.id}"]`);
    const forced = n.active;
    const eff = d.effective === "auto" ? "automatic" : (d.id === "rgb" ? (RGB_LABEL[d.effective] || d.effective) : d.effective);
    $(".eff", row).innerHTML = `${swatch(d.effective)}${eff}${forced ? " · forced off" : ""}${d.available ? "" : " · not available"}`;
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
    notice(`Could not set ${id}: ${err.message}`, "error");
  }
});
$("#bays-enabled").addEventListener("change", async (e) => {
  try { await api("leds/bays", { method: "PUT", body: { on: e.target.checked } }); }
  catch (err) { notice(`Could not switch bay LEDs: ${err.message}`, "error"); }
});
$("#bay-fault-blink").addEventListener("change", async (e) => {
  try { await api("leds/bay-fault-blink", { method: "PUT", body: { on: e.target.checked } }); }
  catch (err) { notice(`Could not change fault alert: ${err.message}`, "error"); }
});
$("#night-manual").addEventListener("change", async (e) => {
  try { await api("leds/night", { method: "PUT", body: { on: e.target.checked } }); }
  catch (err) { notice(`Could not switch night mode: ${err.message}`, "error"); }
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
    notice(`Could not set the schedule: ${err.message}`, "error");
  }
});

// ---- system ---------------------------------------------------------------

$("#beep-buttons").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  try { await api("beep", { method: "POST", body: { pattern: +b.dataset.pattern } }); }
  catch (err) { notice(`Beeper: ${err.message}`, "error"); }
});
document.querySelector(".beep-events").addEventListener("change", async (e) => {
  const cb = e.target.closest("input[data-event]");
  if (!cb) return;
  try { await api("beep/event", { method: "PUT", body: { event: cb.dataset.event, enabled: cb.checked } }); }
  catch (err) { notice(`Beep setting: ${err.message}`, "error"); }
});

let lastSystemLoad = 0;
async function loadSystem() {
  try {
    const s = await api("system");
    lastSystemLoad = Date.now();
    const yes = (b) => (b ? "running" : "not running");
    const mod = (m) => (m.loaded ? `loaded${m.version ? ", " + m.version : ""}` : "not loaded");
    $("#sys-info").innerHTML = [
      ["T6 Control Center", "this app", s.app_version],
      ["Kernel", "Linux version", s.kernel],
      ["t6_platform", "fans, LEDs, backlight & battery driver", mod(s.modules.t6_platform)],
      ["ft8722_ts", "touchscreen driver", mod(s.modules.ft8722_ts)],
      ["t6-fand", "fan control service", yes(s.daemons["t6-fand"])],
      ["t6-ledd", "LED & beeper service", yes(s.daemons["t6-ledd"])],
    ].map(([k, d, v]) => `<li><span class="sw-name"><b>${k}</b><small>${d}</small></span><b>${v}</b></li>`).join("");
  } catch (e) {
    // Transient (e.g. the gateway not warm yet at startup). The poll retries
    // it and it self-heals, so don't raise a banner.
  }
}

// Refresh the software card at most every 15 s from the (recovering) poll.
function maybeLoadSystem() {
  if (Date.now() - lastSystemLoad > 15000) loadSystem();
}

// ---- fan curve editor (custom profile) ------------------------------------

const EDIT_PROFILE = "custom";
const COLORS = { silent: "#16a34a", balance: "#2f6fed", performance: "#dc2626", custom: "#7c3aed" };
const colorFor = (name) => COLORS[name] || "#6b7280";

// plot geometry
const PLOT = { L: 34, R: 10, T: 12, B: 24, tMin: 20, tMax: 100 };

function interp(points, t) {
  if (t <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [t0, p0] = points[i - 1], [t1, p1] = points[i];
    if (t <= t1) return p0 + (p1 - p0) * (t - t0) / (t1 - t0);
  }
  return last[1];
}

function plotMap(canvas) {
  const { L, R, T, B, tMin, tMax } = PLOT, W = canvas.width, H = canvas.height;
  return {
    x: (t) => L + ((t - tMin) / (tMax - tMin)) * (W - L - R),
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
  ctx.fillStyle = "#9ca3af"; ctx.strokeStyle = "#eef0f3"; ctx.lineWidth = 1;
  for (let p = 0; p <= 100; p += 25) {
    ctx.beginPath(); ctx.moveTo(L, m.y(p)); ctx.lineTo(W - R, m.y(p)); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText(`${p}%`, L - 4, m.y(p) + 4);
  }
  for (let t = tMin; t <= tMax; t += 20) {
    ctx.beginPath(); ctx.moveTo(m.x(t), T); ctx.lineTo(m.x(t), H - B); ctx.stroke();
    ctx.textAlign = "center"; ctx.fillText(`${t}\u00b0`, m.x(t), H - 8);
  }

  const drawLine = (pts, color, width, alpha, dots) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.moveTo(m.x(tMin), m.y(pts[0][1]));
    pts.forEach(([t, p]) => ctx.lineTo(m.x(t), m.y(p)));
    ctx.lineTo(m.x(tMax), m.y(pts[pts.length - 1][1])); ctx.stroke();
    if (dots) {
      ctx.fillStyle = color;
      pts.forEach(([t, p]) => { ctx.beginPath(); ctx.arc(m.x(t), m.y(p), 4.5, 0, 2 * Math.PI); ctx.fill();
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke(); });
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
    const cx = m.x(Math.max(tMin, Math.min(tMax, temp)));
    ctx.strokeStyle = "#f59e0b"; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, T); ctx.lineTo(cx, H - B); ctx.stroke(); ctx.setLineDash([]);
    const duty = interp(edited, temp);
    ctx.fillStyle = "#f59e0b";
    ctx.beginPath(); ctx.arc(cx, m.y(duty), 3.5, 0, 2 * Math.PI); ctx.fill();
  }
}

function redrawEditor() {
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
  $("#curve-hint").textContent = dirty ? "Unsaved changes" : (state.admin ? "Drag the purple dots to edit" : "administrator required to edit");
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

  const clampPoint = (i, t, p) => {
    const pts = state.fanEdited[zone];
    const lo = i > 0 ? pts[i - 1][0] + 1 : -20;
    const hi = i < pts.length - 1 ? pts[i + 1][0] - 1 : 150;
    return [Math.max(lo, Math.min(hi, Math.round(t))), Math.max(0, Math.min(100, Math.round(p)))];
  };
  const show = (i) => {
    if (readout) readout.textContent = i >= 0 ? `${state.fanEdited[zone][i][0]} \u00b0C \u2192 ${state.fanEdited[zone][i][1]} %` : "";
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (!state.admin || state.activeProfile !== EDIT_PROFILE) return;
    const m = plotMap(canvas), pts = state.fanEdited[zone];
    const { cx, cy } = pointerPos(canvas, e);
    // nearest existing point
    let best = -1, bestD = 14 * 14;
    pts.forEach(([t, p], i) => { const dx = m.x(t) - cx, dy = m.y(p) - cy, d = dx * dx + dy * dy; if (d < bestD) { bestD = d; best = i; } });
    if (best < 0) {
      // add a point where clicked (clamped, sorted), then drag it
      const t = Math.round(Math.max(PLOT.tMin - 10, Math.min(PLOT.tMax + 10, m.tAt(cx))));
      const p = Math.round(Math.max(0, Math.min(100, m.pAt(cy))));
      if (pts.some((q) => q[0] === t)) return; // avoid duplicate temp
      pts.push([t, p]); pts.sort((a, b) => a[0] - b[0]);
      best = pts.findIndex((q) => q[0] === t);
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
    const m = plotMap(canvas), { cy } = pointerPos(canvas, e);
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
    notice(`Could not apply curves: ${e.message}`, "error");
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
      card.className = "card";
      card.dataset.zoneCard = zone;
      const legend = ["silent", "balance", "performance", "custom"]
        .filter((n) => z.curves[n]).map((n) => `<span><i style="background:${colorFor(n)}"></i>${n}</span>`).join("");
      card.innerHTML = `
        <div class="title"><span>${z.fan}</span><span class="muted curve-readout"></span></div>
        <canvas class="curve" width="360" height="180" data-zone="${zone}"></canvas>
        <div class="legend">${legend}</div>
        <div class="params">
          sensors: ${z.sensors.join(", ")}<br>
          filter \u03c4 ${z.tau_secs ?? 0} s \u00b7 hysteresis ${z.hysteresis ?? 3} \u00b0C \u00b7
          ramp ${z.ramp_up ?? 25}/${z.ramp_down ?? 5} %/s \u00b7 floor ${z.min_pwm ?? 8} % \u00b7
          start ${z.start_pwm ?? 12} % for ${z.kick_secs ?? 3} s
        </div>`;
      box.appendChild(card);
      const canvas = $(".curve", card);
      drawZone(canvas, zone);
      attachEditing(canvas);
    }
    updateCurveBar();
  } catch (e) {
    notice(`Could not load fan configuration: ${e.message}`, "error");
  }
}

$("#curve-apply").addEventListener("click", applyAll);
$("#curve-revert").addEventListener("click", revertAll);

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

pollLoop();
