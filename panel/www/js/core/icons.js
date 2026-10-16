// Phosphor icons, drawn inline so they inherit currentColor.
// Light for 22px and larger (tab bar, page actions, empty states),
// Regular for 20px and smaller (buttons, inputs, metadata).

import { LIGHT, REGULAR } from './icons.gen.js';
import { raw } from './dom.js';

const TABLES = { light: LIGHT, regular: REGULAR };

/** icon('gear', 'light') → Raw `<svg class="rl-icon">`. */
export function icon(name, weight = 'regular', cls = 'rl-icon') {
  // not in this weight: the other one beats nothing
  const d = TABLES[weight]?.[name] ?? (weight === 'regular' ? LIGHT : REGULAR)[name];
  if (!d) {
    console.warn(`icon: no ${weight} "${name}"`);
    return raw('');
  }
  return raw(`<svg class="${cls}" viewBox="0 0 256 256" aria-hidden="true"><path d="${d}"/></svg>`);
}
