import type { BoardElement, ElementType } from './model';

/**
 * Minimal shape {@link toggleFilterSelection} and {@link chainParent} need
 * from an element: its id and its direct parent (`parents[0]`, nearest
 * first, 011/read.ts#resolveParents). `childrenOf` below walks this link,
 * guarding against a cycle in the data with a visited set, never a fixed
 * recursion depth (001, Ergänzung 2026-10-18, S18 "kein Kreis").
 */
type Linked = Pick<BoardElement, 'id' | 'parents'>;

function childrenOf(elements: readonly Linked[], parentId: string): Linked[] {
  return elements.filter((e) => e.parents[0]?.id === parentId);
}

function descendantIds(elements: readonly Linked[], startId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [startId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const child of childrenOf(elements, current)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      stack.push(child.id);
    }
  }
  return seen;
}

function ancestorIds(elements: readonly Linked[], startId: string): string[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const result: string[] = [];
  const seen = new Set<string>([startId]);
  let current = byId.get(startId);
  while (current) {
    const parentId = current.parents[0]?.id;
    if (parentId === undefined || seen.has(parentId)) break;
    seen.add(parentId);
    result.push(parentId);
    current = byId.get(parentId);
  }
  return result;
}

/**
 * The new selection after clicking `id` in the filter list (001, Ergänzung
 * 2026-10-18, S14-S18): anwählen fügt das Element, alle seine Nachkommen und
 * alle seine Vorfahren (nur diese selbst) hinzu; abwählen entfernt das
 * Element und alle seine Nachkommen, die Vorfahren bleiben gewählt. Gilt für
 * jede Zahl von Ebenen und bildet keinen Kreis, auch bei einem zyklischen
 * `parent` in den Eingabedaten (descendantIds/ancestorIds brechen dann über
 * ihre Besucht-Mengen ab, statt endlos zu laufen).
 */
export function toggleFilterSelection(
  selected: ReadonlySet<string>,
  id: string,
  elements: readonly Linked[],
): Set<string> {
  const next = new Set(selected);
  const descendants = descendantIds(elements, id);
  if (selected.has(id)) {
    next.delete(id);
    for (const d of descendants) next.delete(d);
  } else {
    next.add(id);
    for (const d of descendants) next.add(d);
    for (const a of ancestorIds(elements, id)) next.add(a);
  }
  return next;
}

/**
 * Whether `card` shows on the board under the current filter selection (001,
 * Ergänzung 2026-10-18): an empty selection never hides anything, an invalid
 * card always stays hidden once a filter is active. On the project's bottom
 * level (`bottomType`, from `core/settings.ts#bottomLevel`) a card needs its
 * *direct* parent (`parents[0]`, read.ts guarantees it is the nearest valid
 * ancestor) selected — so one without any parent never shows — every level
 * above shows when the element itself is selected.
 */
export function isVisibleUnderFilter(
  card: Pick<BoardElement, 'id' | 'type' | 'parents' | 'invalid'>,
  selected: ReadonlySet<string>,
  bottomType: ElementType,
): boolean {
  if (selected.size === 0) return true;
  if (card.invalid) return false;
  if (card.type === bottomType) {
    const parentId = card.parents[0]?.id;
    return parentId !== undefined && selected.has(parentId);
  }
  return selected.has(card.id);
}

function stripHash(tag: string): string {
  return tag.startsWith('#') ? tag.slice(1) : tag;
}

/**
 * Selection across the filter popover's three sections (001, Ergänzung
 * 2026-10-25): `ids` is the hierarchy selection (Epics und Features, same
 * shape and rules as before), `statuses` the column slugs chosen in the
 * Status section (wirkt nie auf dem Board), `tags` the tags chosen in the
 * Tags section, ohne führendes `#`.
 */
export interface FilterSelection {
  ids: ReadonlySet<string>;
  statuses: ReadonlySet<string>;
  tags: ReadonlySet<string>;
}

/**
 * Splits the stored list `filters[view]` (001, Ergänzung 2026-10-25) back
 * into the three sections: a `status:`/`tag:` prefix names its section, every
 * other entry is a ktm_id (ids.ts#ID_PATTERN forbids a colon there, so the
 * prefixes never collide with one).
 */
export function parseFilterEntries(entries: readonly string[]): FilterSelection {
  const ids = new Set<string>();
  const statuses = new Set<string>();
  const tags = new Set<string>();
  for (const entry of entries) {
    if (entry.startsWith('status:')) statuses.add(entry.slice('status:'.length));
    else if (entry.startsWith('tag:')) tags.add(entry.slice('tag:'.length));
    else ids.add(entry);
  }
  return { ids, statuses, tags };
}

/** Gegenstück zu {@link parseFilterEntries}: ids, dann `status:`, dann `tag:` (001, Ergänzung 2026-10-25). */
export function filterEntries(selection: FilterSelection): string[] {
  return [
    ...selection.ids,
    ...[...selection.statuses].map((s) => `status:${s}`),
    ...[...selection.tags].map((t) => `tag:${t}`),
  ];
}

/**
 * Whether `card` shows under the combined filter selection (001, Ergänzung
 * 2026-10-25): the hierarchy rule of {@link isVisibleUnderFilter} applies
 * only when `ids` carries a selection, a status match only when `statuses`
 * does, a tag match (ohne `#`, ohne Unterschied der Schreibung) only when
 * `tags` does. Every section with a selection must match; a section without
 * one never narrows. An invalid card is hidden as soon as any section has a
 * selection; with none at all, everything shows.
 */
export function isVisibleUnderSelection(
  card: Pick<BoardElement, 'id' | 'type' | 'parents' | 'invalid' | 'status' | 'tags'>,
  selection: FilterSelection,
  bottomType: ElementType,
): boolean {
  if (selection.ids.size === 0 && selection.statuses.size === 0 && selection.tags.size === 0) return true;
  if (card.invalid) return false;
  if (selection.ids.size > 0 && !isVisibleUnderFilter(card, selection.ids, bottomType)) return false;
  if (selection.statuses.size > 0 && !selection.statuses.has(card.status)) return false;
  if (selection.tags.size > 0) {
    const cardTags = new Set(card.tags.map((t) => stripHash(t).toLowerCase()));
    if (![...selection.tags].some((t) => cardTags.has(stripHash(t).toLowerCase()))) return false;
  }
  return true;
}

/**
 * Whether `card` falls under the spotlight on `value` (001, Ergänzung
 * 2026-10-18, erweitert 2026-10-25): die bisherige Form ist eine Element-ID
 * (die Karte selbst oder ein Nachkomme, gelesen aus `card.parents`, der
 * *vollen* Vorfahrenkette, nicht nur dem direkten Parent). Neu dazu kommen
 * `tag:<tag>` (die Karte trägt den Tag, ohne `#`, ohne Unterschied der
 * Schreibung), `status:<key>` (`card.status`) und `project:<key>` (ein
 * leerer Schlüssel trifft eine Karte ohne `project`, wie der intern-Chip,
 * Wissen #390). Eine ungültige Karte trifft nie, auch nicht über `status:`
 * oder `project:` (S30 "eine ungültige Karte wird nie hervorgehoben").
 */
export function isUnderSpotlight(
  card: Pick<BoardElement, 'id' | 'parents' | 'invalid' | 'tags' | 'status' | 'project'>,
  value: string,
): boolean {
  if (card.invalid) return false;
  if (value.startsWith('tag:')) {
    const tag = stripHash(value.slice('tag:'.length)).toLowerCase();
    return card.tags.some((t) => stripHash(t).toLowerCase() === tag);
  }
  if (value.startsWith('status:')) return card.status === value.slice('status:'.length);
  if (value.startsWith('project:')) return (card.project ?? '') === value.slice('project:'.length);
  return card.id === value || card.parents.some((p) => p.id === value);
}

/** Drops ids from `selected` that no longer name an element in `elements` (001, "fällt still aus Auswahl"). */
export function pruneSelection(
  selected: ReadonlySet<string>,
  elements: readonly Pick<BoardElement, 'id'>[],
): Set<string> {
  const ids = new Set(elements.map((e) => e.id));
  return new Set([...selected].filter((id) => ids.has(id)));
}

/**
 * The deepest element of a selection that forms a single chain (every
 * element has at most one selected child), above `belowType` — the level
 * the new draft itself will sit on, excluded from consideration so a
 * selected sibling-level element never becomes its own parent. `undefined`
 * when the selection is empty, branches, or has more than one root (001,
 * Ergänzung 2026-10-18, "Neue Aufgabe bei aktivem Filter").
 */
export function chainParent(
  selected: ReadonlySet<string>,
  elements: readonly BoardElement[],
  belowType?: ElementType,
): BoardElement | undefined {
  if (selected.size === 0) return undefined;
  const chosen = elements.filter((e) => selected.has(e.id) && e.type !== belowType);
  if (chosen.length === 0) return undefined;
  const roots = chosen.filter((e) => !e.parents[0] || !selected.has(e.parents[0].id));
  if (roots.length !== 1) return undefined;
  let current = roots[0];
  const visited = new Set<string>([current.id]);
  while (true) {
    const kids = childrenOf(chosen, current.id);
    if (kids.length === 0) return current;
    if (kids.length > 1) return undefined;
    const next = kids[0] as BoardElement;
    if (visited.has(next.id)) return current;
    visited.add(next.id);
    current = next;
  }
}

export interface FilterSummary {
  /** Closed field text, e.g. "Plattform-Betrieb › …, Datenplattform › …"; empty when nothing is selected. */
  text: string;
  count: number;
  /** Full selection for the tooltip, never abbreviated with "…". */
  tooltip: string;
}

/**
 * The closed filter field's text, badge count and tooltip (001, Ergänzung
 * 2026-10-18, "Das geschlossene Feld"). `extra` (001, Ergänzung 2026-10-25):
 * die gewählten Status-Namen und Tags in Anzeigereihenfolge, werden nach den
 * obersten Hierarchie-Elementen mit Komma angehängt und zu `count` addiert.
 * Ohne `extra` gilt das alte Verhalten unverändert.
 */
export function filterSummary(
  selected: ReadonlySet<string>,
  elements: readonly BoardElement[],
  extra: readonly string[] = [],
): FilterSummary {
  const chosen = elements.filter((e) => selected.has(e.id));
  if (chosen.length === 0 && extra.length === 0) return { text: '', count: 0, tooltip: '' };
  const isRoot = (e: BoardElement): boolean => !e.parents[0] || !selected.has(e.parents[0].id);
  const roots = chosen.filter(isRoot).sort((a, b) => a.title.localeCompare(b.title, 'de'));
  const descendantsOf = (root: BoardElement): BoardElement[] =>
    chosen.filter((e) => e.id !== root.id && e.parents.some((p) => p.id === root.id));
  const hierarchyText = roots.map((r) => (descendantsOf(r).length > 0 ? `${r.title} › …` : r.title)).join(', ');
  const hierarchyTooltip = roots
    .map((r) => {
      const d = descendantsOf(r);
      return d.length > 0 ? `${r.title} › ${d.map((x) => x.title).join(', ')}` : r.title;
    })
    .join(', ');
  const text = [hierarchyText, ...extra].filter(Boolean).join(', ');
  const tooltip = [hierarchyTooltip, ...extra].filter(Boolean).join(', ');
  return { text, count: chosen.length + extra.length, tooltip };
}

export type FilterRowState = 'selected' | 'partial' | 'none';

export interface FilterRow {
  id: string;
  title: string;
  type: ElementType;
  depth: number;
  state: FilterRowState;
  closed: boolean;
  /** The element's precomputed right-hand label: "gewählte/alle" Kinder, die Zahl der Kinder, oder der Statusname (DESIGN.md Filter-Popover). */
  right: string;
  project?: string;
}

/**
 * The filter popover's flat row list (001, Ergänzung 2026-10-18, "Die
 * Liste"): `elements` is already narrowed to the levels above the bottom one
 * and to the view's own scope — a project view's own elements, every
 * project's for "Alle Aufgaben" (then `projectOrder` groups and separates
 * them, in that order; omit it for a single, ungrouped project view).
 * Siblings sort alphabetically, closed ones (`isClosed`) after the open
 * ones. With `search` only elements whose title contains it, plus their
 * ancestors as context, are emitted.
 */
export function filterRows(
  elements: readonly BoardElement[],
  selected: ReadonlySet<string>,
  isClosed: (element: BoardElement) => boolean,
  statusNameFor: (element: BoardElement) => string,
  search: string,
  projectOrder?: readonly string[],
): FilterRow[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const kids = (id: string): BoardElement[] => childrenOf(elements, id) as BoardElement[];

  const fullySelectedCache = new Map<string, boolean>();
  const isFullySelected = (el: BoardElement): boolean => {
    const cached = fullySelectedCache.get(el.id);
    if (cached !== undefined) return cached;
    fullySelectedCache.set(el.id, true); // provisional: guards a cycle in the data
    const result = selected.has(el.id) && kids(el.id).every(isFullySelected);
    fullySelectedCache.set(el.id, result);
    return result;
  };
  const stateOf = (el: BoardElement): FilterRowState => {
    if (!selected.has(el.id)) return 'none';
    return isFullySelected(el) ? 'selected' : 'partial';
  };

  const needle = search.trim().toLowerCase();
  let keepIds: Set<string> | undefined;
  if (needle) {
    keepIds = new Set<string>();
    for (const m of elements.filter((e) => e.title.toLowerCase().includes(needle))) {
      let current: BoardElement | undefined = m;
      while (current && !keepIds.has(current.id)) {
        keepIds.add(current.id);
        current = current.parents[0] ? byId.get(current.parents[0].id) : undefined;
      }
    }
  }

  const rightLabel = (el: BoardElement): string => {
    if (isClosed(el)) return statusNameFor(el);
    const children = kids(el.id);
    if (children.length === 0) return statusNameFor(el);
    if (stateOf(el) === 'none') return String(children.length);
    const chosen = children.filter((c) => selected.has(c.id)).length;
    return `${chosen}/${children.length}`;
  };

  const byTitle = (a: BoardElement, b: BoardElement): number => a.title.localeCompare(b.title, 'de');
  const sortSiblings = (list: BoardElement[]): BoardElement[] => {
    const open = list.filter((e) => !isClosed(e)).sort(byTitle);
    const closed = list.filter((e) => isClosed(e)).sort(byTitle);
    return [...open, ...closed];
  };

  const rows: FilterRow[] = [];
  const emit = (el: BoardElement, depth: number): void => {
    if (keepIds && !keepIds.has(el.id)) return;
    rows.push({
      id: el.id,
      title: el.title,
      type: el.type,
      depth,
      state: stateOf(el),
      closed: isClosed(el),
      right: rightLabel(el),
      project: el.project,
    });
    for (const child of sortSiblings(kids(el.id))) emit(child, depth + 1);
  };

  const groupKeys = projectOrder ?? [undefined];
  for (const key of groupKeys) {
    const group = key === undefined ? elements : elements.filter((e) => e.project === key);
    const roots = (group as BoardElement[]).filter((e) => !e.parents[0]);
    for (const root of sortSiblings(roots)) emit(root, 0);
  }

  return rows;
}
