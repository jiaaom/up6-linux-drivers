// UI strings. Chinese is the source; English is the second table. Every
// string has an id ("tab.files", "offline.title"); `t` falls back to Chinese,
// then to the id, so a missing translation shows up but never breaks a page.
//
// The language lives in settings.json (PUT api/settings/language) and is
// echoed in storage so the first paint is already in the right language.

import zh from '../strings/zh.js';
import en from '../strings/en.js';
import { api } from './api.js';
import { emitter } from './events.js';
import { html } from './dom.js';
import { load, save } from './storage.js';

const TABLES = { zh, en };
const SETTLE_MS = 4000; // a poll that left before our PUT landed may still report the old language
let chosenAt = 0;
let lang = TABLES[load('lang')] ? load('lang') : 'zh';

export const langChanged = emitter();

export function getLang() {
  return lang;
}

/** Whether a string id exists (for labels that fall back to backend text). */
export const has = (id) => id in zh;

/** t('files.count', { n: 3 }) → "3 项"; {name} placeholders are filled from vars. */
export function t(id, vars) {
  let s = TABLES[lang][id] ?? zh[id];
  if (s == null) {
    console.warn(`i18n: missing "${id}"`);
    return id;
  }
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

/**
 * The inside of a title slip: in Chinese the title with its English name as
 * the subtitle (or `<id>.sub` when the slip wants a different one, as Wi-Fi ·
 * Wireless does); in English the English title alone.
 */
export function slipText(id) {
  if (lang === 'en') return html`<span>${t(id)}</span>`;
  const sub = zh[`${id}.sub`] ?? en[id];
  return html`<span>${zh[id] ?? id}</span>${sub ? html`<span class="rl-slip__sub">${sub}</span>` : ''}`;
}

/** Apply a language reported by the backend or chosen here (no request). */
export function applyLang(code) {
  if (!TABLES[code] || code === lang) return;
  lang = code;
  document.documentElement.lang = code === 'zh' ? 'zh-CN' : 'en';
  save('lang', code);
  langChanged.emit(code);
}

/** The language /api/panel reports: follow it unless the user just chose one here. */
export function langFromBackend(code) {
  if (Date.now() - chosenAt > SETTLE_MS) applyLang(code);
}

/** Choose a language: apply it now and store it in settings.json. */
export function setLang(code) {
  chosenAt = Date.now();
  applyLang(code);
  return api.put('settings/language', { code });
}
