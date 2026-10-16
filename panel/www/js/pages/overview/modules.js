// The modules on 总览, in the order they appear. Settings › 总览模块 turns
// them on and off; the ids are what settings.json keeps in dashboard.hidden.
// The health banner is not a module: it always shows.

export const MODULES = [
  { id: 'device', label: 'module.device' },
  { id: 'storage', label: 'module.storage' },
  { id: 'system', label: 'module.system' },
  { id: 'thermals', label: 'module.thermals' },
  { id: 'network', label: 'module.network' },
  { id: 'containers', label: 'module.containers' },
  { id: 'transfers', label: 'module.transfers' },
  { id: 'battery', label: 'module.battery', sub: 'module.batterySub' },
  { id: 'notices', label: 'module.notices' },
];

/** Ids hidden in settings.json, keeping only modules that exist. */
export const hiddenModules = (panelData) =>
  (panelData?.dashboard?.hidden ?? []).filter((id) => MODULES.some((m) => m.id === id));
