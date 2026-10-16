// 设置 › 声音: the outputs the sound server (appliance-compositor's PipeWire,
// through /api/audio) has right now, and the current one's volume. Outputs
// come and go as they are plugged in or paired, so the page re-reads every
// few seconds. Repairing the sound server is an admin action on the fnOS web
// page, never here.

import { api } from '../../core/api.js';
import { html, on } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import { poller } from '../../core/resource.js';
import { toast } from '../../shell/layers.js';
import { audio, chooseOutput, defaultOutput, soundProblem } from '../../data/stores.js';
import { kindOf, outputRows } from '../../ui/outputs.js';
import { resourceSubpage } from '../../ui/page.js';
import { foot, list, section, sliderRow, trackSlider } from '../../ui/settings.js';

function body(a) {
  const problem = soundProblem(a);
  if (problem) {
    return html`<div class="rl-notice rl-notice--danger" role="alert" style="margin-top:14px">${icon('warning-circle')}<div class="rl-notice__body"><strong class="rl-notice__title">${t(`sound.${problem}`)}</strong>${t(`sound.${problem}Body`)}</div></div>
      ${section('sound.secOutput')}
      <div class="rl-empty rl-empty--inline">${icon('speaker-slash', 'light')}<p class="rl-empty__body">${t('sound.waiting')}</p></div>`;
  }
  const out = defaultOutput(a);
  const v = Math.round((out?.volume ?? 0) * 100);
  return html`
    ${section('sound.secOutput')}
    ${(a.outputs || []).length ? outputRows(a) : html`<div class="rl-empty rl-empty--inline">${icon('speaker-slash', 'light')}<p class="rl-empty__body">${t('sound.none')}</p></div>`}
    ${foot(t('sound.outputFoot'))}
    ${out ? html`${section('sound.secVolume')}
      ${list([sliderRow({ iconName: kindOf(out).iconName, label: out.name, value: v, valueText: `${v}%`, attrs: html` data-volume="${out.id}"` })])}
      ${foot(t('sound.volumeFoot'), 'margin-bottom:18px')}` : ''}`;
}

export default function soundPage(ctx) {
  const page = resourceSubpage(ctx, { slip: 'page.sound', res: audio, body });
  const live = poller(audio);

  on(ctx.el, 'click', '[data-output]', async (e, btn) => {
    if (btn.getAttribute('aria-pressed') === 'true') return;
    live.hold(5000);
    try {
      await chooseOutput(btn.dataset.output);
    } catch (err) {
      toast(t('common.failed', { why: err.message }));
    }
    live.hold(0);
    audio.refresh();
  });

  let volTimer = 0;
  on(ctx.el, 'input', 'input[data-volume]', (e, input) => {
    trackSlider(input);
    live.hold(2000);
    const out = defaultOutput(audio.data);
    if (out) out.volume = +input.value / 100; // what a repaint shows until the next read
    clearTimeout(volTimer);
    volTimer = setTimeout(() => {
      api.put('audio/volume', { id: +input.dataset.volume, volume: +input.value / 100 }).catch((err) => toast(t('common.failed', { why: err.message })));
    }, 150);
  });

  return { title: 'page.sound', render: page.render, show: live.start, hide: live.stop };
}
