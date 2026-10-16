// localStorage that never throws: the panel must render without it.

const PREFIX = 't6ui.'; // distinct from the old UI's plain-string keys

// The 1.x UI's keys (t6.files.recents and the like, some holding file paths)
// are never read again: drop them once.
try {
  for (const k of Object.keys(localStorage)) if (!k.startsWith(PREFIX)) localStorage.removeItem(k);
} catch { /* unavailable */ }

export function load(key, fallback = null) {
  try {
    const s = localStorage.getItem(PREFIX + key);
    return s == null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* full or unavailable: the next refresh fills it again */
  }
}
