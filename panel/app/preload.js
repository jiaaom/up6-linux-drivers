// No renderer bridge is needed: the panel talks to t6-paneld directly over HTTP
// (/api/*, including /api/fnos for the authenticated fnOS session). This file is
// kept as an empty, context-isolated preload so webPreferences.preload stays a
// valid path — add a contextBridge.exposeInMainWorld(...) here if the shell ever
// needs to hand the renderer something the daemon can't.
