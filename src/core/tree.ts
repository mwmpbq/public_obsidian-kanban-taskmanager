import { ownRank, rankOf, type LevelContext } from './board';
import { isVisibleUnderSelection, type FilterSelection } from './filter';
import type { BoardElement, Checklist, ElementType } from './model';
import type { Column, ColumnRole, Level } from './settings';
import { roleOf } from './week';

export interface TreeProjectEntry {
  /** Projekt-Kürzel, `undefined` für intern (012 "Baum": "intern für Elemente ohne project"). */
  key?: string;
  name: string;
}

export interface TreeRow {
  /** `project:<key>` für die Projektzeile (leerer Key für intern), sonst `element.id`. */
  id: string;
  kind: 'project' | ElementType;
  /** 0 für die Projektzeile, sonst die Stufe darunter (1 = direktes Kind des Projekts). */
  depth: number;
  /** `id` der Zeile, unter der diese im Baum hängt (Projektzeile oder Vorfahr). */
  parentKey: string;
  title: string;
  project?: string;
  cardId: string;
  status?: string;
  role?: ColumnRole;
  due?: string;
  planned?: string;
  startedDisplay?: string;
  startedDerived?: boolean;
  progress?: Checklist;
  levelRank?: number;
  /** Nur Projektzeilen: Anzahl offener Tasks darunter. */
  openTasks?: number;
  context?: boolean;
  discarded?: boolean;
}

export type TreeSortKey = 'status' | 'started' | 'planned' | 'due' | 'progress';

export interface TreeSort {
  key: TreeSortKey;
  dir: 'asc' | 'desc';
}

const TREE_SORT_KEYS: readonly TreeSortKey[] = ['status', 'started', 'planned', 'due', 'progress'];

/** Liest `settings.treeSort[view]` ein (012 "Baum"): ein Eintrag mit unbekanntem Schlüssel oder unbekannter Richtung fällt weg, statt die ganze Liste zu verwerfen. */
export function parseTreeSort(raw: unknown): TreeSort[] {
  if (!Array.isArray(raw)) return [];
  const result: TreeSort[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.key !== 'string' || !TREE_SORT_KEYS.includes(e.key as TreeSortKey)) continue;
    if (e.dir !== 'asc' && e.dir !== 'desc') continue;
    result.push({ key: e.key as TreeSortKey, dir: e.dir });
  }
  return result;
}

export interface TreeOptions {
  columns: Column[];
  levelContext: LevelContext;
  level: ElementType;
  filterSelection: FilterSelection;
}

function levelsForProject(ctx: LevelContext, project: string | undefined): Level[] {
  return (project ? ctx.projectLevels[project] : undefined) ?? ctx.generalLevels;
}

function bottomTypeFor(ctx: LevelContext, project: string | undefined): ElementType {
  const levels = levelsForProject(ctx, project);
  return levels[levels.length - 1]?.key ?? 'task';
}

function isBottom(el: BoardElement, ctx: LevelContext): boolean {
  return ownRank(el, ctx) === 0;
}

/** Direkte Kinder je Notizpfad, über `parents[0].note` (012 "Baum"/"Roadmap", Wissen #1374). */
export function childrenByNote(elements: readonly BoardElement[]): Map<string, BoardElement[]> {
  const map = new Map<string, BoardElement[]>();
  for (const el of elements) {
    const note = el.parents[0]?.note;
    if (note === undefined) continue;
    const list = map.get(note);
    if (list) list.push(el);
    else map.set(note, [el]);
  }
  return map;
}

// Alle Nachfahren-Tasks (die unterste Ebene ihres Projekts) eines Elements,
// unabhängig von Ebenen-Schalter und Filter (012 "Baum": Fortschritt und das
// abgeleitete Gestartet gelten für die Daten, nicht für das, was gerade
// sichtbar ist). Geht über `parents[0].note`, wie board.ts#childProgress
// (Wissen #371).
export function descendantTasksOf(el: BoardElement, byNote: Map<string, BoardElement[]>, ctx: LevelContext): BoardElement[] {
  const result: BoardElement[] = [];
  const stack = [...(byNote.get(el.paths.note) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (isBottom(current, ctx)) result.push(current);
    else stack.push(...(byNote.get(current.paths.note) ?? []));
  }
  return result;
}

/** Frühestes `started` einer Liste von Elementen, `undefined` ohne Treffer (012 "Baum"/"Roadmap"). */
export function earliestStarted(tasks: readonly BoardElement[]): string | undefined {
  let earliest: string | undefined;
  for (const t of tasks) {
    if (t.started === undefined) continue;
    if (earliest === undefined || t.started < earliest) earliest = t.started;
  }
  return earliest;
}

/**
 * Baut die flachen Zeilen des Baums (012 S18, "Baum"): eine Projektzeile je
 * Eintrag aus `projects`, in dessen Reihenfolge (sie werden nie
 * umsortiert), darunter rekursiv ihre Kinder über `parents[0].note`. Ein
 * Element, dessen Parent nicht unter den gültigen `elements` liegt, hängt
 * direkt unter seinem Projekt. Die Tiefe begrenzt `options.level`: nur
 * Elemente, deren `ownRank` (board.ts, Wissen #371) mindestens dem Rang
 * dieser Ebene entspricht, erscheinen überhaupt, auch nicht als Kontext —
 * ein Elternteil hat immer einen höheren Rang als sein Kind, also wird nie
 * ein Elternteil verwaist zurückgelassen. Mit einer Filterauswahl
 * (Hierarchie, Status oder Tags) bleiben nur Treffer
 * (`isVisibleUnderSelection`) und ihre Vorfahren übrig; die Vorfahren
 * tragen `context: true`, alles andere fehlt. Fortschritt und das
 * abgeleitete `started` zählen immer über alle tatsächlichen
 * Nachfahren-Tasks, unabhängig von Tiefe und Filter. Ungültige Elemente
 * fehlen ganz (wie buildBoard).
 */
export function buildTree(
  elements: readonly BoardElement[],
  projects: readonly TreeProjectEntry[],
  options: TreeOptions,
): TreeRow[] {
  const { columns, levelContext: ctx, level, filterSelection } = options;
  const valid = elements.filter((el) => !el.invalid);
  const byNoteFull = childrenByNote(valid);
  const byNote = new Map(valid.map((el) => [el.paths.note, el]));

  const cutoffCache = new Map<string, number>();
  const cutoffFor = (project: string | undefined): number => {
    const key = project ?? '';
    const cached = cutoffCache.get(key);
    if (cached !== undefined) return cached;
    const rank = rankOf(levelsForProject(ctx, project), level) ?? 0;
    cutoffCache.set(key, rank);
    return rank;
  };

  const depthEligible = valid.filter((el) => (ownRank(el, ctx) ?? -1) >= cutoffFor(el.project));
  const eligibleIds = new Set(depthEligible.map((el) => el.id));
  const byNoteEligible = childrenByNote(depthEligible);

  const filterActive =
    filterSelection.ids.size > 0 || filterSelection.statuses.size > 0 || filterSelection.tags.size > 0;
  const matchIds = new Set<string>();
  if (filterActive) {
    for (const el of depthEligible) {
      if (isVisibleUnderSelection(el, filterSelection, bottomTypeFor(ctx, el.project))) matchIds.add(el.id);
    }
  }
  const keepIds = new Set(matchIds);
  if (filterActive) {
    for (const el of depthEligible) {
      if (!matchIds.has(el.id)) continue;
      let current = el;
      for (;;) {
        const parentNote = current.parents[0]?.note;
        if (parentNote === undefined) break;
        const parent = byNote.get(parentNote);
        if (!parent || !eligibleIds.has(parent.id)) break;
        if (keepIds.has(parent.id)) break;
        keepIds.add(parent.id);
        current = parent;
      }
    }
  }
  const included = (el: BoardElement): boolean => !filterActive || keepIds.has(el.id);

  const rows: TreeRow[] = [];

  const rowFor = (el: BoardElement, depth: number, parentKey: string): TreeRow => {
    const bottom = isBottom(el, ctx);
    const role = roleOf(el.status, columns);
    let progress: Checklist | undefined;
    let startedDisplay = el.started;
    let startedDerived = false;
    if (bottom) {
      progress = el.checklist;
    } else {
      const descendants = descendantTasksOf(el, byNoteFull, ctx);
      const tasks = descendants.filter((t) => roleOf(t.status, columns) !== 'wont-do');
      progress =
        tasks.length > 0
          ? { done: tasks.filter((t) => roleOf(t.status, columns) === 'done').length, total: tasks.length }
          : undefined;
      if (startedDisplay === undefined) {
        const derived = earliestStarted(descendants);
        if (derived !== undefined) {
          startedDisplay = derived;
          startedDerived = true;
        }
      }
    }
    return {
      id: el.id,
      kind: el.type,
      depth,
      parentKey,
      title: el.title,
      project: el.project,
      cardId: el.paths.note,
      status: el.status,
      role,
      due: el.due,
      planned: el.planned,
      startedDisplay,
      startedDerived,
      progress,
      levelRank: ownRank(el, ctx) ?? 0,
      context: filterActive && !matchIds.has(el.id),
      discarded: role === 'wont-do',
    };
  };

  const visit = (el: BoardElement, depth: number, parentKey: string): void => {
    rows.push(rowFor(el, depth, parentKey));
    const children = (byNoteEligible.get(el.paths.note) ?? []).filter(included);
    for (const child of children) visit(child, depth + 1, el.id);
  };

  for (const project of projects) {
    const projectKey = project.key ?? '';
    const projectId = `project:${projectKey}`;
    const openTasks = valid.filter(
      (el) => (el.project ?? '') === projectKey && isBottom(el, ctx) && roleOf(el.status, columns) === 'open',
    ).length;
    rows.push({
      id: projectId,
      kind: 'project',
      depth: 0,
      parentKey: '',
      title: project.name,
      project: project.key,
      cardId: projectId,
      openTasks,
    });
    const roots = depthEligible.filter((el) => {
      if ((el.project ?? '') !== projectKey) return false;
      const parentNote = el.parents[0]?.note;
      if (parentNote === undefined) return true;
      const parent = byNote.get(parentNote);
      return !parent || !eligibleIds.has(parent.id);
    });
    for (const root of roots.filter(included)) visit(root, 1, projectId);
  }

  return rows;
}

function compareOptionalString(a: string | undefined, b: string | undefined, dir: 1 | -1): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return dir * (a < b ? -1 : a > b ? 1 : 0);
}

function compareOptionalNumber(a: number | undefined, b: number | undefined, dir: 1 | -1): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return dir * (a - b);
}

function progressRatio(row: TreeRow): number | undefined {
  if (!row.progress || row.progress.total === 0) return undefined;
  return row.progress.done / row.progress.total;
}

function compareByKey(spec: TreeSort, a: TreeRow, b: TreeRow, statusRank: Map<string, number>): number {
  const dir = spec.dir === 'asc' ? 1 : -1;
  if (spec.key === 'status') {
    return compareOptionalNumber(
      a.status !== undefined ? statusRank.get(a.status) : undefined,
      b.status !== undefined ? statusRank.get(b.status) : undefined,
      dir,
    );
  }
  if (spec.key === 'started') return compareOptionalString(a.startedDisplay, b.startedDisplay, dir);
  if (spec.key === 'planned') return compareOptionalString(a.planned, b.planned, dir);
  if (spec.key === 'due') return compareOptionalString(a.due, b.due, dir);
  return compareOptionalNumber(progressRatio(a), progressRatio(b), dir);
}

// Standardordnung (012 "Baum"): höhere Ebene vor niedrigerer (levelRank
// zählt von unten, also absteigend sortiert), offen/aktiv vor
// abgeschlossen, dann Titel. Gilt ohne Sortierung und als Gleichstand-Regel
// jeder aktiven Sortierung.
function defaultCompare(a: TreeRow, b: TreeRow): number {
  const rankA = a.levelRank ?? 0;
  const rankB = b.levelRank ?? 0;
  if (rankA !== rankB) return rankB - rankA;
  const closedA = a.role === 'done' || a.role === 'wont-do' ? 1 : 0;
  const closedB = b.role === 'done' || b.role === 'wont-do' ? 1 : 0;
  if (closedA !== closedB) return closedA - closedB;
  return a.title.localeCompare(b.title, 'de');
}

/**
 * Ordnet die Geschwister jedes Elternteils (012 S19/S20, "Baum"):
 * Projektzeilen bleiben in der übergebenen Reihenfolge stehen, sie werden
 * nie umsortiert; jede Ebene darunter sortiert rekursiv je Elternteil,
 * mehrere Schlüssel nacheinander in der Reihenfolge aus `sort`, bei
 * Gleichstand die Standardordnung. `rows` kommt unsortiert aus buildTree,
 * ein leeres `sort` ergibt die reine Standardordnung.
 */
export function sortTree(rows: readonly TreeRow[], sort: readonly TreeSort[], columns: Column[]): TreeRow[] {
  const statusRank = new Map(columns.map((c, i) => [c.status, i]));
  const byParent = new Map<string, TreeRow[]>();
  const projectRows: TreeRow[] = [];
  for (const row of rows) {
    if (row.kind === 'project') {
      projectRows.push(row);
      continue;
    }
    const list = byParent.get(row.parentKey);
    if (list) list.push(row);
    else byParent.set(row.parentKey, [row]);
  }
  const compare = (a: TreeRow, b: TreeRow): number => {
    for (const spec of sort) {
      const cmp = compareByKey(spec, a, b, statusRank);
      if (cmp !== 0) return cmp;
    }
    return defaultCompare(a, b);
  };
  const emit = (row: TreeRow): TreeRow[] => {
    const children = [...(byParent.get(row.id) ?? [])].sort(compare);
    return [row, ...children.flatMap(emit)];
  };
  return projectRows.flatMap(emit);
}

/**
 * Klick auf einen Spaltenkopf (012 S19/S20, "Baum"): nicht sortiert → asc
 * (hinten angehängt), asc → desc (Rang bleibt gleich), desc → entfernt.
 */
export function cycleTreeSort(current: readonly TreeSort[], key: TreeSortKey): TreeSort[] {
  const idx = current.findIndex((s) => s.key === key);
  if (idx === -1) return [...current, { key, dir: 'asc' }];
  if (current[idx].dir === 'asc') {
    const next = [...current];
    next[idx] = { key, dir: 'desc' };
    return next;
  }
  return current.filter((s) => s.key !== key);
}
