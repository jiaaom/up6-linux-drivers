// 设置 › 关于 › a licence: the full text shipped next to the icons or font.

import { html } from '../../core/dom.js';
import { resource } from '../../core/resource.js';
import { subpage } from '../../ui/page.js';
import { panel } from '../../core/panel.js';
import { loadFailed } from '../../ui/states.js';

const RL = 'ridgeline/1.12.0'; // the vendored Ridgeline, as in index.html

export const LICENCES = [
  { id: 'phosphor', name: 'Phosphor Icons', licence: 'MIT', file: `${RL}/icons/LICENSE.txt` },
  { id: 'garamond', name: 'EB Garamond', licence: 'SIL OFL 1.1', file: `${RL}/fonts/EBGaramond-OFL.txt` },
  { id: 'sourcesans', name: 'Source Sans 3', licence: 'SIL OFL 1.1', file: `${RL}/fonts/SourceSans3-OFL.txt` },
  { id: 'huiwen', name: '汇文明朝体', licence: 'CC0 1.0', file: `${RL}/fonts/HuiwenMinchoGBK-CC0.txt` },
  { id: 'qrcode', name: 'QR Code Generator', licence: 'MIT', file: 'vendor/qrcode-generator-1.4.4/LICENSE.txt' },
];

/** Licence files are wrapped at ~72 columns; rejoin each paragraph so it flows to the screen's width. */
function paragraphs(text) {
  return text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
}

async function readText(file) {
  const r = await fetch(file);
  if (!r.ok) throw new Error(r.statusText);
  return r.text();
}

export default function licencePage(ctx) {
  const l = LICENCES.find((x) => x.id === ctx.params.id);
  const text = resource(`licence.${l.id}`, () => readText(l.file), { persist: false });
  const render = () => {
    const body = text.data != null
      ? html`<div class="rl-licence">${paragraphs(text.data).map((p) => html`<p>${p}</p>`)}</div>`
      : text.status === 'failed' ? loadFailed() : '';
    ctx.el.innerHTML = String(subpage(ctx, { slipMarkup: html`<span>${l.name}</span><span class="rl-slip__sub">${l.licence}</span>`, body, hostName: panel.data?.host?.name }));
  };
  ctx.own(text.changed.on(render));
  return { title: 'page.licence', render, show: () => text.refresh() };
}
