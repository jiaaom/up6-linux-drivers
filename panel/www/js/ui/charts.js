// Charts (Ridgeline components/Chart): the sparkline on boards, and the full
// chart on detail pages — one series in `ridge`, clean ticks, a few dates, an
// optional reference line, and a crosshair readout while a finger is down.
// The page draws the points; the classes do the styling, so both themes work.

import { capture, html, raw } from '../core/dom.js';

const f1 = (n) => n.toFixed(1);

/** Clean ticks from 0 to just above `top`: 4–5 steps of 1, 2, 2.5 or 5 × 10ⁿ. */
export function niceTicks(top) {
  if (!(top > 0)) return [0, 1];
  const raw0 = top / 4;
  const mag = 10 ** Math.floor(Math.log10(raw0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw0);
  const ticks = [];
  for (let v = 0; v < top + step * 0.999; v += step) ticks.push(+v.toPrecision(6));
  return ticks;
}

/**
 * A sparkline: points [[t, v], …] over [t0, t1]. The area is drawn only when
 * the axis stands on zero (`base` 0, the default); give `base` for readings
 * like temperatures, which then draw the line alone.
 */
export function spark(points, { width, height, label, t0, t1, base = 0, top, area = true }) {
  const pad = 2;
  const vs = points.map((p) => p[1]);
  if (!points.length) return html`<svg class="rl-spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${label}"></svg>`;
  const lo = base ?? Math.min(...vs);
  const hi = Math.max(top ?? 0, ...vs, lo + 1e-9) * (top ? 1 : 1.15);
  const a = t0 ?? points[0][0];
  const b = Math.max(t1 ?? points[points.length - 1][0], a + 1);
  const x = (t) => pad + ((t - a) / (b - a)) * (width - 2 * pad);
  const y = (v) => height - pad - ((v - lo) / (hi - lo)) * (height - 2 * pad);
  const line = points.map(([t, v]) => `${f1(x(t))},${f1(y(v))}`).join(' ');
  const [lt, lv] = points[points.length - 1];
  const withArea = area && base === 0;
  return html`<svg class="rl-spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${label}">${withArea
    ? raw(`<polygon class="rl-spark__area" points="${f1(x(points[0][0]))},${height} ${line} ${f1(x(lt))},${height}"/>`) : ''}${raw(`<polyline class="rl-spark__line" points="${line}"/><circle class="rl-spark__dot" cx="${f1(x(lt))}" cy="${f1(y(lv))}" r="3.5"/>`)}</svg>`;
}

/**
 * The full chart. Returns { markup, at(clientX, svgRect) } so the page can
 * move a crosshair: `at` gives the nearest point and its position.
 *   points  [[t, v], …]      values already in display units
 *   unit    shown above the value axis
 *   ref     { value, label } a threshold line (提醒线 90%)
 *   dates   (t) => label     for start, middle and today
 *   t0, t1  the span the time axis covers (default: the points' own)
 */
export function chart(points, { width = 318, height = 176, label, unit, ref, dates, top, t0, t1 }) {
  const left = 30;
  const right = width - 8;
  const y0 = height - 22;
  const y1 = 18;
  const vs = points.map((p) => p[1]);
  const ticks = niceTicks(Math.max(top ?? 0, ...vs, ref?.value ?? 0));
  const hi = ticks[ticks.length - 1] || 1;
  const a = t0 ?? points[0]?.[0] ?? 0;
  const b = Math.max(t1 ?? points[points.length - 1]?.[0] ?? 1, a + 1);
  const x = (t) => left + ((t - a) / (b - a)) * (right - left);
  const y = (v) => y0 - (v / hi) * (y0 - y1);
  const parts = [];
  for (const v of ticks) {
    parts.push(`<line class="rl-chart__grid" x1="${left}" x2="${right}" y1="${f1(y(v))}" y2="${f1(y(v))}"/><text class="rl-chart__tick" x="${left - 6}" y="${f1(y(v) + 4)}" text-anchor="end">${+v.toPrecision(3)}</text>`);
  }
  if (unit) parts.push(`<text class="rl-chart__tick" x="${left - 6}" y="8" text-anchor="end" style="font-size:10px">${unit}</text>`);
  if (ref) parts.push(`<line class="rl-chart__ref" x1="${left}" x2="${right}" y1="${f1(y(ref.value))}" y2="${f1(y(ref.value))}"/><text class="rl-chart__reflabel" x="${right}" y="${f1(y(ref.value) - 5)}" text-anchor="end">${ref.label}</text>`);
  if (points.length && dates) {
    const mid = a + (b - a) / 2;
    parts.push(`<text class="rl-chart__tick" x="${left}" y="${height - 5}" text-anchor="start">${dates(a)}</text><text class="rl-chart__tick" x="${f1(x(mid))}" y="${height - 5}" text-anchor="middle">${dates(mid)}</text><text class="rl-chart__tick" x="${right}" y="${height - 5}" text-anchor="end">${dates(b)}</text>`);
  }
  if (points.length) {
    const line = points.map(([t, v]) => `${f1(x(t))},${f1(y(v))}`).join(' ');
    const [lt, lv] = points[points.length - 1];
    parts.push(`<polygon class="rl-spark__area" points="${f1(x(points[0][0]))},${y0} ${line} ${f1(x(lt))},${y0}"/><polyline class="rl-spark__line" points="${line}"/><g data-cross></g><circle class="rl-spark__dot" cx="${f1(x(lt))}" cy="${f1(y(lv))}" r="4"/>`);
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const markup = html`<div class="rl-chart-wrap" data-chart><svg class="rl-spark rl-chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${label}">${raw(parts.join('').replace(/>([^<]+)<\/text>/g, (m, txt) => `>${esc(txt)}</text>`))}</svg><div class="rl-chart__tip" hidden><b></b><span></span></div></div>`;
  /** The point nearest a finger at clientX, with its place in CSS px of the svg. */
  const at = (clientX, rect) => {
    if (!points.length) return null;
    const sx = ((clientX - rect.left) / rect.width) * width;
    const t = a + ((sx - left) / (right - left)) * (b - a);
    let best = points[0];
    for (const p of points) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    return { point: best, x: x(best[0]), y: y(best[1]), scale: rect.width / width, y1, y0 };
  };
  return { markup, at };
}

/**
 * Make a chart's crosshair follow a finger: press and drag; the readout sits
 * above the finger. `format(point)` → { value, date }.
 */
export function followCrosshair(wrap, chartApi, format) {
  const svg = wrap.querySelector('svg');
  const cross = svg.querySelector('[data-cross]');
  const tip = wrap.querySelector('.rl-chart__tip');
  if (!cross) return;
  const show = (e) => {
    const hit = chartApi.at(e.clientX, svg.getBoundingClientRect());
    if (!hit) return;
    cross.innerHTML = `<line class="rl-chart__cross" x1="${f1(hit.x)}" x2="${f1(hit.x)}" y1="${hit.y1}" y2="${hit.y0}"/><circle class="rl-spark__dot" cx="${f1(hit.x)}" cy="${f1(hit.y)}" r="4"/>`;
    const { value, date } = format(hit.point);
    tip.querySelector('b').textContent = value;
    tip.querySelector('span').textContent = date;
    tip.hidden = false;
    const px = hit.x * hit.scale;
    tip.style.left = `${px}px`;
    tip.style.top = `${Math.max(0, hit.y * hit.scale - 64)}px`;
    tip.style.transform = px > wrap.clientWidth / 2 ? 'translateX(-100%)' : 'none';
  };
  const hide = () => { cross.innerHTML = ''; tip.hidden = true; };
  wrap.addEventListener('pointerdown', (e) => { capture(wrap, e.pointerId); show(e); });
  wrap.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') show(e); });
  wrap.addEventListener('pointerup', hide);
  wrap.addEventListener('pointercancel', hide);
}
