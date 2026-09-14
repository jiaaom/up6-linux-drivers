// T6 Control Center – front end. Plain JS, no build step.
// All requests are relative, so the page works under any gateway prefix.

const $ = (sel, root = document) => root.querySelector(sel);
const HISTORY = 120; // samples kept per zone for the sparkline (1/s)

const state = {
  admin: false,
  limitsDirty: false, // user is editing the charge-limit form
  blDragging: false,  // user is dragging the brightness slider
  nightDirty: false,  // user is editing the night schedule
  history: new Map(), // zone -> [{t, temp, pwm}]
  config: null,
};

async function api(path, opts = {}) {
  if (opts.body !== undefined) {
    opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(`api/${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${path}: HTTP ${res.status}`);
  return data;
}

function notice(msg, kind = "") {
  const el = $("#notice");
  el.textContent = msg || "";
  el.className = `notice ${kind}`;
  el.hidden = !msg;
}

// ---- tabs -----------------------------------------------------------------

$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn || btn.disabled) return;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== btn.dataset.tab));
  if (btn.dataset.tab === "fans") loadCurves();
  if (btn.dataset.tab === "system") loadSystem();
});

// ---- dashboard ------------------------------------------------------------

function renderUser(u) {
  state.admin = !!u.is_admin;
  const el = $("#user");
  el.textContent = u.username ? `${u.username}${u.is_admin ? " · admin" : ""}` : "—";
  el.classList.toggle("admin", state.admin);
}

function renderActiveProfile(fan) {
  const active = fan.running && fan.status ? fan.status.profile : null;
  $("#active-profile").textContent = active ? `profile: ${active}` : "";
}

function renderProfiles(fan) {
  const box = $("#profiles");
  const active = fan.status ? fan.status.profile : null;
  const key = fan.profiles.join("|");
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = fan.profiles.map((p) => `<button data-profile="${p}">${p}</button>`).join("");
  }
  box.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.profile === active);
    b.disabled = !state.admin || !fan.running;
  });
  const note = $("#profile-note");
  if (!state.admin) note.textContent = "administrator required to change";
  else if (fan.profile_override && fan.profile_override !== fan.config_profile)
    note.textContent = `runtime override (config default: ${fan.config_profile})`;
  else note.textContent = "";
}

$("#profiles").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn || btn.disabled || btn.classList.contains("active")) return;
  try {
    await api("fan/profile", { method: "PUT", body: { profile: btn.dataset.profile } });
    notice("");
    refresh();
    loadCurves();
  } catch (err) {
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
    renderUser(s.user);
    renderActiveProfile(s.fan);
    renderProfiles(s.fan);
    renderZones(s.fan);
    renderBattery(s.battery);
    renderDisplay(s.display);
    renderLeds(s.leds);
    document.querySelectorAll("#beep-buttons button").forEach((b) => (b.disabled = !state.admin || !s.leds));
    $("#beep-note").textContent = !state.admin ? "administrator required" : "";
    if (s.fan.running && $("#notice").textContent.startsWith("t6-fand is not running")) notice("");
  } catch (e) {
    notice(`Backend unreachable: ${e.message}`, "error");
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

  // Limits form: presets apply directly; "Custom" reveals the sliders.
  const editable = state.admin && !!b.thresholds;
  document.querySelectorAll("#lim-presets button").forEach((p) => (p.disabled = !editable));
  ["#lim-start", "#lim-end", "#lim-apply"].forEach((id) => ($(id).disabled = !editable));
  $("#lim-note").textContent = !state.admin ? "administrator required to change" : "";
  if (b.thresholds && !state.limitsDirty) {
    setLimitForm(b.thresholds.start, b.thresholds.end);
    const preset = presetFor(b.thresholds.start, b.thresholds.end);
    markPreset(preset);
    $("#lim-custom").hidden = !!preset;
  }
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

async function applyLimits(start, end) {
  $("#lim-status").textContent = "applying…";
  try {
    const r = await api("battery/thresholds", { method: "PUT", body: { start, end } });
    state.limitsDirty = false;
    $("#lim-status").textContent = r.ec_policy
      ? "EC policy: charges to ~97 %, tops up from 91 %"
      : `charging between ${r.start}–${r.end} %, kept across reboots`;
  } catch (err) {
    $("#lim-status").textContent = "";
    notice(`Could not set charge limits: ${err.message}`, "error");
  }
}

// keep start < end while dragging
$("#lim-start").addEventListener("input", () => {
  state.limitsDirty = true;
  if (+$("#lim-start").value >= +$("#lim-end").value) $("#lim-end").value = +$("#lim-start").value + 1;
  syncLimitLabels();
});
$("#lim-end").addEventListener("input", () => {
  state.limitsDirty = true;
  if (+$("#lim-end").value <= +$("#lim-start").value) $("#lim-start").value = +$("#lim-end").value - 1;
  syncLimitLabels();
});
$("#lim-presets").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  markPreset(b.dataset.custom ? null : b);
  if (b.dataset.custom) {
    state.limitsDirty = true;
    $("#lim-custom").hidden = false;
  } else {
    $("#lim-custom").hidden = true;
    setLimitForm(+b.dataset.start, +b.dataset.end);
    applyLimits(+b.dataset.start, +b.dataset.end);
  }
});
$("#lim-apply").addEventListener("click", () => applyLimits(+$("#lim-start").value, +$("#lim-end").value));

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
    $("#bl-power-label").textContent = d.on ? "On" : "Off";
    $("#bl-slider").value = d.on ? Math.max(d.brightness || 0, d.min_on || 10) : d.on_level;
    syncBrightnessLabel();
  }
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
  $("#bl-power-label").textContent = on ? "On" : "Off";
  $("#bl-slider").disabled = !on;
  try {
    await api("display/power", { method: "PUT", body: { on } });
  } catch (err) {
    notice(`Could not switch the backlight: ${err.message}`, "error");
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
  if (!state.nightDirty) {
    $("#night-manual").checked = !!n.manual;
    $("#night-sched").checked = !!n.schedule;
    if (n.schedule) {
      const [a, b] = n.schedule.split("-");
      $("#night-start").value = a;
      $("#night-end").value = b;
    }
  }
  ["#night-manual", "#night-sched", "#night-start", "#night-end", "#night-apply"].forEach((id) => ($(id).disabled = !editable));

  // bays master switch
  $("#bays-enabled").checked = !!l.bays_enabled;
  $("#bays-enabled").disabled = !editable;
  $("#bays-label").textContent = l.bays_enabled ? "On" : "Off";

  // device rows: rebuild only when the set of devices changes
  const table = $("#led-devices");
  const key = l.devices.map((d) => d.id).join(",");
  if (table.dataset.key !== key) {
    table.dataset.key = key;
    table.innerHTML = l.devices.map((d) => `
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
  for (const d of l.devices) {
    const row = table.querySelector(`tr[data-id="${d.id}"]`);
    const forced = n.active || (d.bay && !l.bays_enabled);
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
  $("#bays-label").textContent = e.target.checked ? "On" : "Off";
  try { await api("leds/bays", { method: "PUT", body: { on: e.target.checked } }); }
  catch (err) { notice(`Could not switch bay LEDs: ${err.message}`, "error"); }
});
$("#night-manual").addEventListener("change", async (e) => {
  try { await api("leds/night", { method: "PUT", body: { on: e.target.checked } }); }
  catch (err) { notice(`Could not switch night mode: ${err.message}`, "error"); }
});
["#night-sched", "#night-start", "#night-end"].forEach((id) => $(id).addEventListener("input", () => (state.nightDirty = true)));
$("#night-apply").addEventListener("click", async () => {
  const schedule = $("#night-sched").checked ? `${$("#night-start").value}-${$("#night-end").value}` : "";
  try {
    await api("leds/night", { method: "PUT", body: { schedule } });
    state.nightDirty = false;
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

async function loadSystem() {
  try {
    const s = await api("system");
    const yes = (b) => (b ? "running" : "not running");
    const mod = (m) => (m.loaded ? `loaded${m.version ? ", " + m.version : ""}` : "not loaded");
    $("#sys-info").innerHTML = [
      ["T6 Control Center", s.app_version],
      ["Kernel", s.kernel],
      ["t6_platform", mod(s.modules.t6_platform)],
      ["ft8722_ts", mod(s.modules.ft8722_ts)],
      ["t6-fand", yes(s.daemons["t6-fand"])],
      ["t6-ledd", yes(s.daemons["t6-ledd"])],
    ].map(([k, v]) => `<li><span>${k}</span><b>${v}</b></li>`).join("");
  } catch (e) {
    notice(`Could not load system info: ${e.message}`, "error");
  }
}

// ---- fan curves -----------------------------------------------------------

const COLORS = { silent: "#16a34a", balance: "#2f6fed", performance: "#dc2626" };
const colorFor = (name) => COLORS[name] || "#6b7280";

function drawCurves(canvas, curves, activeProfile) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const L = 34, R = 10, T = 10, B = 24;
  const tMin = 20, tMax = 100;
  const x = (t) => L + ((t - tMin) / (tMax - tMin)) * (W - L - R);
  const y = (p) => T + (1 - p / 100) * (H - T - B);
  ctx.clearRect(0, 0, W, H);
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = "#9ca3af";
  ctx.strokeStyle = "#eef0f3";
  ctx.lineWidth = 1;
  for (let p = 0; p <= 100; p += 25) {
    ctx.beginPath(); ctx.moveTo(L, y(p)); ctx.lineTo(W - R, y(p)); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText(`${p}%`, L - 4, y(p) + 4);
  }
  for (let t = tMin; t <= tMax; t += 20) {
    ctx.beginPath(); ctx.moveTo(x(t), T); ctx.lineTo(x(t), H - B); ctx.stroke();
    ctx.textAlign = "center"; ctx.fillText(`${t}°`, x(t), H - 8);
  }
  for (const [name, pts] of Object.entries(curves)) {
    ctx.strokeStyle = colorFor(name);
    ctx.lineWidth = name === activeProfile ? 2.5 : 1.25;
    ctx.globalAlpha = name === activeProfile ? 1 : 0.6;
    ctx.beginPath();
    ctx.moveTo(x(tMin), y(pts[0][1]));
    pts.forEach(([t, p]) => ctx.lineTo(x(t), y(p)));
    ctx.lineTo(x(tMax), y(pts[pts.length - 1][1]));
    ctx.stroke();
    ctx.fillStyle = colorFor(name);
    pts.forEach(([t, p]) => { ctx.beginPath(); ctx.arc(x(t), y(p), 2.5, 0, Math.PI * 2); ctx.fill(); });
  }
  ctx.globalAlpha = 1;
}

async function loadCurves() {
  try {
    const data = await api("fan/config");
    state.config = data.config;
    $("#config-path").textContent = data.path;
    const active = data.config.profile;
    const box = $("#curves");
    box.innerHTML = "";
    for (const [name, z] of Object.entries(data.config.zones)) {
      const card = document.createElement("div");
      card.className = "card";
      const legend = Object.keys(z.curves)
        .map((p) => `<span><i style="background:${colorFor(p)}"></i>${p}</span>`).join("");
      card.innerHTML = `
        <div class="title"><span>${z.fan}</span><span class="muted">${name}</span></div>
        <canvas class="curve" width="360" height="180"></canvas>
        <div class="legend">${legend}</div>
        <div class="params">
          sensors: ${z.sensors.join(", ")}<br>
          filter τ ${z.tau_secs ?? 0} s · hysteresis ${z.hysteresis ?? 3} °C ·
          ramp ${z.ramp_up ?? 25}/${z.ramp_down ?? 5} %/s · floor ${z.min_pwm ?? 8} % ·
          start ${z.start_pwm ?? 12} % for ${z.kick_secs ?? 3} s ·
          emergency ≥ ${z.emergency_temp ?? 90} °C for ${z.emergency_secs ?? 8} s
        </div>`;
      box.appendChild(card);
      drawCurves($(".curve", card), z.curves, active);
    }
  } catch (e) {
    notice(`Could not load fan configuration: ${e.message}`, "error");
  }
}

refresh();
setInterval(refresh, 1000);
