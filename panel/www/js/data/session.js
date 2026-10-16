// Whose data the panel holds. Listings, recent files, the clipboard,
// favourites, the recycle bin and fnOS notices belong to the person signed in
// to fnOS. When they sign out here, or someone else signs in, the panel
// forgets all of it, so the next person at the screen sees none of it (the
// recent files and the clipboard are kept in local storage across restarts).
// A session that only lapses keeps it: the same person signs back in.

import { emitter } from '../core/events.js';
import { load, save } from '../core/storage.js';
import { clipboard, favourites, recents } from './files.js';
import { account, notices } from './stores.js';

/** Emitted after forgetting: modules with their own per-person caches drop them. */
export const userForgotten = emitter();

export function forgetUser() {
  save('session.owner', null);
  clipboard.set(null);
  recents.clear();
  favourites.set = new Set();
  favourites.changed.emit();
  notices.reset();
  userForgotten.emit();
}

/** Someone else signed in than the person whose data is kept: forget theirs first. */
function check(res) {
  const a = res.data;
  if (res.status !== 'idle' || !a?.signedIn || !a.username) return;
  const owner = load('session.owner');
  if (owner && owner !== a.username) forgetUser();
  if (owner !== a.username) save('session.owner', a.username);
}

export function watchSession() {
  account.changed.on(check);
}
