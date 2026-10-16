// Backend data that more than one place shows (pages, the control center),
// besides the live /api/panel state. Each is cached, so whatever shows it
// opens with the last answer; each place refreshes what it shows when it appears.

import { api } from '../core/api.js';
import { resource } from '../core/resource.js';

export const fan = resource('fan', () => api.get('fan'));
export const audio = resource('audio', () => api.get('audio'));
export const leds = resource('leds', () => api.get('leds'));
export const account = resource('account', () => api.get('fnos/status'));
export const firmware = resource('firmware', () => api.get('firmware'));
export const about = resource('about', () => api.get('about'));
export const bluetooth = resource('bluetooth', () => api.get('bluetooth'));
export const thunderbolt = resource('thunderbolt', () => api.get('thunderbolt'));
export const sharing = resource('sharing', () => api.get('sharing'));
export const wifiScan = resource('wifiScan', () => api.get('network/wifi/scan?rescan=true'));
export const sysmon = resource('sysmon', () => api.get('sysmon'));
export const pools = resource('pools', () => api.get('storage/pools'));
export const storage = resource('storage', () => api.get('storage'));
export const containers = resource('containers', () => api.get('containers'));
export const notices = resource('notices', () => api.get('fnos/notifications?limit=30'));
// holds the hotspot password: kept in memory only
export const hotspot = resource('hotspot', () => api.get('network/hotspot'), { persist: false });

/** The output sound plays on now, or null. */
export const defaultOutput = (a) => (a?.outputs || []).find((o) => o.default) ?? null;

/** Why there is no sound, or null when the sound server works. */
export function soundProblem(a) {
  if (!a) return null;
  if (a.pulseaudio) return 'pulseaudio';
  if (!a.running) return 'stopped';
  return null;
}

/** Choose the output sound plays on. */
export const chooseOutput = (id) => api.put('audio/default', { id: +id });

/** The time ranges 总览 and 系统 offer, and how long each is. */
export const BOARD_RANGES = ['1h', '24h', '7d'];
export const RANGE_SECONDS = { '1h': 3600, '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400, '90d': 90 * 86400, '1y': 365 * 86400 };

const histories = new Map();
/** A metric over a range from /api/history, e.g. history('system/cpu', '1h'). */
export function history(metric, range) {
  const key = `${metric}@${range}`;
  if (!histories.has(key)) {
    histories.set(key, resource(`hist.${key}`, () => api.get(`history?metric=${encodeURIComponent(metric)}&range=${range}`)));
  }
  return histories.get(key);
}
