// 设置 › 夜间时段: with 主题 on 跟随夜间, the panel is dark inside this
// window (t6-paneld night.rs). 从 and 到 move in 30-minute steps and may cross
// midnight. While 夜案 holds the other theme, the foot says until when and a
// row goes back to the window now. Separate from the LEDs' night mode.

import { html, on, painter } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import { panel } from '../../core/panel.js';
import { nightInfo, setNightWindow, setThemeHold } from '../../core/theme.js';
import { toast } from '../../shell/layers.js';
import { subpage } from '../../ui/page.js';
import { actionRow, foot, list, note } from '../../ui/settings.js';

const STEP_MIN = 30;
const minutes = (hhmm) => { const m = /^(\d\d):(\d\d)$/.exec(hhmm || ''); return m ? +m[1] * 60 + +m[2] : 0; };
const hhmm = (m) => { m = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

function stepper(which, time) {
  const btn = (delta, label, name) => html`<button class="rl-btn rl-btn--secondary rl-btn--icon rl-btn--sm rl-glass" data-step="${which}" data-delta="${delta}" aria-label="${label}">${icon(name)}</button>`;
  return html`<span class="rl-stepper">${btn(-STEP_MIN, t('leds.earlier'), 'minus')}<span class="rl-stepper__value" data-time="${which}">${time}</span>${btn(STEP_MIN, t('leds.later'), 'plus')}</span>`;
}

/** The foot line: which theme is on now and when that changes. */
function nowLine(n) {
  if (n.hold) return t(n.hold.theme === 'dark' ? 'night.footHoldDark' : 'night.footHoldLight', { time: n.hold.until });
  return t(n.dark ? 'night.footDark' : 'night.footLight', { time: n.next_change });
}

export default function nightPage(ctx) {
  const paint = painter(ctx.el);
  let pending = false; // a stepper change not sent yet: don't paint the old times back

  function render() {
    if (pending) return;
    const n = nightInfo() ?? { from: '22:00', to: '07:00', dark: false, next_change: '22:00', hold: null };
    const body = html`<div class="rl-set">
      ${note(t('night.note'))}
      ${list([
        html`<div class="rl-set__row"><span class="rl-set__label">${t('night.from')}</span>${stepper('from', n.from)}</div>`,
        html`<div class="rl-set__row"><span class="rl-set__label">${t('night.to')}</span>${stepper('to', n.to)}</div>`,
      ])}
      ${foot(nowLine(n))}
      ${n.hold ? list([actionRow({ iconName: 'arrow-counter-clockwise', label: t('night.resume'), attrs: html` data-resume` })]) : ''}
      ${foot(t('night.leds'), 'margin-bottom:18px')}
    </div>`;
    paint(subpage(ctx, { slip: 'page.night', body, hostName: panel.data?.host?.name }));
  }

  // The window is sent once the taps settle.
  let stepTimer = 0;
  on(ctx.el, 'click', '[data-step]', (e, btn) => {
    const out = ctx.el.querySelector(`[data-time="${btn.dataset.step}"]`);
    out.textContent = hhmm(minutes(out.textContent) + +btn.dataset.delta);
    pending = true;
    clearTimeout(stepTimer);
    stepTimer = setTimeout(async () => {
      const from = ctx.el.querySelector('[data-time="from"]').textContent;
      const to = ctx.el.querySelector('[data-time="to"]').textContent;
      pending = false;
      if (from === to) { toast(t('leds.sameTimes')); render(); return; }
      try {
        await setNightWindow(from, to);
      } catch (err) {
        toast(t('common.failed', { why: err.message }));
        render();
      }
    }, 700);
  });

  on(ctx.el, 'click', '[data-resume]', async () => {
    try {
      await setThemeHold(false);
    } catch (err) {
      toast(t('common.failed', { why: err.message }));
    }
  });

  ctx.own(panel.changed.on(render));
  ctx.own(() => clearTimeout(stepTimer));
  return { title: 'page.night', render };
}
