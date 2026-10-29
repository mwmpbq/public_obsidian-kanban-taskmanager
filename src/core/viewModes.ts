/**
 * Katalog der acht Darstellungen (012 "Darstellungen"), in Standardreihenfolge:
 * Board, Woche, Agenda, Baum, Roadmap, Matrix, Rückblick, Portfolio. `icon`
 * ist ein Lucide-Icon-Name für `setIcon`.
 */
export interface ViewMode {
  key: string;
  name: string;
  icon: string;
}

export const VIEW_MODES: readonly ViewMode[] = [
  { key: 'board', name: 'Board', icon: 'square-kanban' },
  { key: 'week', name: 'Woche', icon: 'calendar-days' },
  { key: 'agenda', name: 'Agenda', icon: 'list' },
  { key: 'tree', name: 'Baum', icon: 'list-tree' },
  { key: 'roadmap', name: 'Roadmap', icon: 'gantt-chart' },
  // Lucide nennt das Icon in 012 "grid-2x2"; im mit dieser Obsidian-Version
  // (1.13.7) gebündelten Icon-Satz trägt es den Schlüssel "grid-2x-2"
  // (gemessen: grep im obsidian.asar, "grid-2x2" liefert ohne Icon-Element).
  { key: 'matrix', name: 'Matrix', icon: 'grid-2x-2' },
  { key: 'retro', name: 'Rückblick', icon: 'history' },
  { key: 'portfolio', name: 'Portfolio', icon: 'layout-grid' },
];

export const DEFAULT_VIEW_MODE = VIEW_MODES[0].key;

export function isViewModeKey(value: string | undefined): value is string {
  return value !== undefined && VIEW_MODES.some((m) => m.key === value);
}

/**
 * Macht aus dem gespeicherten `viewOrder` (012, "Reihenfolge per Ziehen")
 * eine vollständige Folge der acht Schlüssel: unbekannte und doppelte
 * Einträge fallen weg, fehlende hängen in Standardreihenfolge hinten an. Ein
 * fehlender oder leerer `stored` ergibt die Standardfolge.
 */
export function resolveViewOrder(stored: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of stored ?? []) {
    if (!isViewModeKey(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  for (const mode of VIEW_MODES) {
    if (!seen.has(mode.key)) result.push(mode.key);
  }
  return result;
}

/**
 * Die Darstellung, die eine Ansicht mitbringt (012 "Darstellung und
 * Ansicht"): `mode` der gespeicherten Ansicht (falls `view` eine ist), sonst
 * `viewModes[view]`, sonst `undefined`. Daraus folgt sowohl die Marke
 * „geändert“ (definiert und ungleich der aktuellen Darstellung) als auch die
 * Wahl beim Ansichtswechsel (`rememberedMode(...) ?? aktuelle`).
 */
export function rememberedMode(
  view: string,
  savedViews: readonly { key: string; mode?: string }[],
  viewModes: Record<string, string> | undefined,
): string | undefined {
  const saved = savedViews.find((v) => v.key === view);
  const raw = saved ? saved.mode : viewModes?.[view];
  return isViewModeKey(raw) ? raw : undefined;
}
