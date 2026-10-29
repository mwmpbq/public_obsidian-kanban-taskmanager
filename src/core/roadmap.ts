import type { LevelContext } from './board';
import { addDays, dayDiff, mondayOf } from './dates';
import type { FilterSelection } from './filter';
import type { BoardElement, ElementType } from './model';
import type { Column } from './settings';
import { buildTree, childrenByNote, earliestStarted, type TreeProjectEntry } from './tree';
import { roleOf } from './week';

export type RoadmapGrid = 'week' | 'month' | 'quarter' | 'year';

export const ROADMAP_GRIDS: readonly RoadmapGrid[] = ['week', 'month', 'quarter', 'year'];

/** Tagesbreite je Raster in px (012 "Roadmap", DESIGN.md Komponente Roadmap). */
export const ROADMAP_DAY_WIDTH: Record<RoadmapGrid, number> = {
  week: 8,
  month: 3.4,
  quarter: 1.25,
  year: 0.45,
};

export interface RoadmapRange {
  start: string;
  end: string;
}

export interface RoadmapState extends RoadmapRange {
  grid: RoadmapGrid;
}

export interface RoadmapBar {
  kind: 'bar';
  start: string;
  end: string;
  startDerived: boolean;
  overdue: boolean;
  openEnd: boolean;
  done: boolean;
}

export interface RoadmapFrame {
  kind: 'frame';
  start: string;
  end: string;
}

export interface RoadmapPoint {
  kind: 'point';
  date: string;
  done: boolean;
  overdue: boolean;
}

export type RoadmapShape = RoadmapBar | RoadmapFrame | RoadmapPoint;

export interface RoadmapShapeInput {
  due?: string;
  planned?: string;
  completed?: string;
}

export interface RoadmapStart {
  date?: string;
  derived: boolean;
}

/**
 * Eigenes `started`, sonst das früheste `started` aller Nachfahren über
 * `parents[0].note` (012 "Roadmap": "beginnt der Balken beim frühesten
 * started seiner Nachfahren"; dieselbe Elternsuche und Herleitung wie im
 * Baum, tree.ts#childrenByNote/earliestStarted). Liest nur, schreibt nichts.
 */
export function deriveStart(
  el: BoardElement,
  elements: readonly BoardElement[],
  byNote: Map<string, BoardElement[]> = childrenByNote(elements),
): RoadmapStart {
  if (el.started !== undefined) return { date: el.started, derived: false };
  const descendants = collectDescendants(el, byNote);
  const date = earliestStarted(descendants);
  return { date, derived: date !== undefined };
}

function collectDescendants(el: BoardElement, byNote: Map<string, BoardElement[]>): BoardElement[] {
  const stack = [...(byNote.get(el.paths.note) ?? [])];
  const descendants: BoardElement[] = [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    descendants.push(current);
    stack.push(...(byNote.get(current.paths.note) ?? []));
  }
  return descendants;
}

/**
 * Abgeleitete Spanne eines Epics/Features ohne eigene Form (012 "Roadmap"):
 * über alle Nachfahren (wie deriveStart), ohne die mit Rolle `wont-do`
 * (week.ts#roleOf, wie buildTree). Ohne Nachfahren mit `due` oder `completed`
 * kommt `null`. Sonst ist `lo` das früheste und `hi` das späteste Datum unter
 * `planned`, `due` und `completed`: bei `lo < hi` ein Rahmen, bei `lo = hi`
 * ein neutraler Punkt (ohne Aussage über erledigt/überfällig, F224
 * "ausserhalb"). Liest nur, schreibt nichts.
 */
export function descendantSpanShape(
  el: BoardElement,
  byNote: Map<string, BoardElement[]>,
  columns: Column[],
): RoadmapShape | null {
  const dated = collectDescendants(el, byNote)
    .filter((d) => roleOf(d.status, columns) !== 'wont-do')
    .filter((d) => d.due !== undefined || d.completed !== undefined);
  if (dated.length === 0) return null;
  let lo: string | undefined;
  let hi: string | undefined;
  for (const d of dated) {
    for (const date of [d.planned, d.due, d.completed]) {
      if (date === undefined) continue;
      if (lo === undefined || date < lo) lo = date;
      if (hi === undefined || date > hi) hi = date;
    }
  }
  if (lo === undefined || hi === undefined) return null;
  if (lo < hi) return { kind: 'frame', start: lo, end: hi };
  return { kind: 'point', date: hi, done: false, overdue: false };
}

/**
 * Balken-/Rahmen-/Punktform eines Elements (012 "Roadmap", S23-S25): mit
 * `start.date` ein Balken von dort bis `completed` (erledigt), sonst bis
 * `due` (wenn das noch in der Zukunft liegt) oder bis `today` (sonst,
 * überfällig; ohne `due` ebenfalls bis `today`, offenes Ende). Ohne
 * `start.date`: `completed` ergibt einen erledigten Punkt, sonst `planned`
 * und `due` einen Rahmen, nur `due` einen Punkt, sonst keine Form. Liest nur,
 * schreibt nichts.
 */
export function roadmapShape(el: RoadmapShapeInput, start: RoadmapStart, today: string): RoadmapShape | null {
  if (start.date !== undefined) {
    if (el.completed !== undefined) {
      return {
        kind: 'bar',
        start: start.date,
        end: el.completed,
        startDerived: start.derived,
        overdue: false,
        openEnd: false,
        done: true,
      };
    }
    if (el.due !== undefined) {
      const future = (dayDiff(el.due, today) ?? 0) >= 0;
      return future
        ? { kind: 'bar', start: start.date, end: el.due, startDerived: start.derived, overdue: false, openEnd: false, done: false }
        : { kind: 'bar', start: start.date, end: today, startDerived: start.derived, overdue: true, openEnd: false, done: false };
    }
    return { kind: 'bar', start: start.date, end: today, startDerived: start.derived, overdue: false, openEnd: true, done: false };
  }
  if (el.completed !== undefined) return { kind: 'point', date: el.completed, done: true, overdue: false };
  if (el.planned !== undefined && el.due !== undefined) return { kind: 'frame', start: el.planned, end: el.due };
  if (el.due !== undefined) return { kind: 'point', date: el.due, done: false, overdue: (dayDiff(el.due, today) ?? 0) < 0 };
  return null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function firstOfMonth(year: number, month: number): string {
  return `${year}-${pad2(month)}-01`;
}

/** Montag sechs Wochen vor heute, 27 Wochen lang (012 "Roadmap", Standard). */
export function defaultRoadmapRange(today: string): RoadmapRange {
  const start = mondayOf(addDays(today, -42));
  return { start, end: addDays(start, 27 * 7 - 1) };
}

/** Pfeile verschieben den Zeitraum um ein Viertel seiner Länge (012 S26); die Länge selbst bleibt gleich. */
export function shiftRoadmapRange(range: RoadmapRange, dir: 1 | -1): RoadmapRange {
  const length = (dayDiff(range.end, range.start) ?? 0) + 1;
  const delta = dir * Math.round(length / 4);
  return { start: addDays(range.start, delta), end: addDays(range.end, delta) };
}

/**
 * Monatswahl (012 S26): vom 1. des früheren bis zum letzten Tag des späteren
 * der beiden gewählten Monate, unabhängig von der Klickreihenfolge.
 */
export function monthRange(a: { year: number; month: number }, b: { year: number; month: number }): RoadmapRange {
  const ord = (m: { year: number; month: number }): number => m.year * 12 + m.month;
  const [lo, hi] = ord(a) <= ord(b) ? [a, b] : [b, a];
  const start = firstOfMonth(lo.year, lo.month);
  const next = hi.month === 12 ? { year: hi.year + 1, month: 1 } : { year: hi.year, month: hi.month + 1 };
  const end = addDays(firstOfMonth(next.year, next.month), -1);
  return { start, end };
}

/** "Heute" (012 S26): gleiche Länge wie zuvor, heute im ersten Viertel des Zeitraums. */
export function todayRange(range: RoadmapRange, today: string): RoadmapRange {
  const length = (dayDiff(range.end, range.start) ?? 0) + 1;
  const start = addDays(today, -Math.floor(length / 4));
  return { start, end: addDays(start, length - 1) };
}

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function isRoadmapGrid(v: unknown): v is RoadmapGrid {
  return v === 'week' || v === 'month' || v === 'quarter' || v === 'year';
}

/**
 * Liest `settings.roadmap[view]` ein (012 "Roadmap": "Zeitraum und Raster
 * gelten je Ansicht und überstehen Neuladen"): ein unbekannter oder kaputter
 * Eintrag fällt auf den Standard zurück, statt die View unbrauchbar zu
 * machen (Muster tree.ts#parseTreeSort).
 */
export function parseRoadmapState(raw: unknown, today: string): RoadmapState {
  const fallback: RoadmapState = { ...defaultRoadmapRange(today), grid: 'week' };
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Record<string, unknown>;
  if (!isIsoDate(r.start) || !isIsoDate(r.end) || !isRoadmapGrid(r.grid) || r.start >= r.end) return fallback;
  return { start: r.start, end: r.end, grid: r.grid };
}

export interface RoadmapDiamond {
  id: string;
  date: string;
  done: boolean;
}

export interface RoadmapRow {
  id: string;
  kind: 'project' | ElementType | 'orphan';
  depth: number;
  parentKey: string;
  title: string;
  project?: string;
  cardId: string;
  context?: boolean;
  shape?: RoadmapShape;
  progress?: { done: number; total: number };
  diamonds?: RoadmapDiamond[];
}

export interface RoadmapOptions {
  columns: Column[];
  levelContext: LevelContext;
  level: ElementType;
  filterSelection: FilterSelection;
  today: string;
}

function bottomTypeFor(ctx: LevelContext, project: string | undefined): ElementType {
  const levels = (project ? ctx.projectLevels[project] : undefined) ?? ctx.generalLevels;
  return levels[levels.length - 1]?.key ?? 'task';
}

function pushDiamond(map: Map<string, RoadmapDiamond[]>, key: string, diamond: RoadmapDiamond): void {
  const list = map.get(key);
  if (list) list.push(diamond);
  else map.set(key, [diamond]);
}

/**
 * Zeilen der Roadmap (012 S23-S28, "Roadmap"): Hierarchie, Tiefe und Filter
 * mit Kontext kommen aus buildTree, wie im Baum (dieselbe Projektliste, die
 * Ebene als Tiefe). Verworfene fallen weg. Eine Zeile der untersten Ebene
 * (ein Task) wird nicht selbst gezeigt, sondern — sofern sie Fällig oder
 * Abschluss trägt — zur Raute ihres Elternteils; ohne eigenen Elternteil zur
 * Raute der Zeile "Tasks ohne Parent" ihres Projekts (wissen #1371:
 * `parentKey` trägt die `ktm_id`, nicht den Notizpfad).
 */
export function roadmapRows(
  elements: readonly BoardElement[],
  projects: readonly TreeProjectEntry[],
  options: RoadmapOptions,
): RoadmapRow[] {
  const treeRows = buildTree(elements, projects, {
    columns: options.columns,
    levelContext: options.levelContext,
    level: options.level,
    filterSelection: options.filterSelection,
  });
  const kept = treeRows.filter((row) => !row.discarded);
  const byCardId = new Map(elements.map((el) => [el.paths.note, el]));
  const byNote = childrenByNote(elements);

  const diamondsByParent = new Map<string, RoadmapDiamond[]>();
  const orphansByProject = new Map<string, RoadmapDiamond[]>();
  const rows: RoadmapRow[] = [];

  for (const row of kept) {
    if (row.kind === 'project') {
      rows.push({ id: row.id, kind: 'project', depth: 0, parentKey: '', title: row.title, project: row.project, cardId: row.cardId });
      continue;
    }
    const bottomType = bottomTypeFor(options.levelContext, row.project);
    if (row.kind === bottomType) {
      const el = byCardId.get(row.cardId);
      const date = el?.completed ?? el?.due;
      if (el === undefined || date === undefined) continue;
      const diamond: RoadmapDiamond = { id: row.id, date, done: el.completed !== undefined };
      if (row.parentKey.startsWith('project:')) pushDiamond(orphansByProject, row.project ?? '', diamond);
      else pushDiamond(diamondsByParent, row.parentKey, diamond);
      continue;
    }
    const el = byCardId.get(row.cardId);
    const start = el ? deriveStart(el, elements, byNote) : { date: undefined, derived: false };
    const shape = el
      ? (roadmapShape(el, start, options.today) ?? descendantSpanShape(el, byNote, options.columns))
      : null;
    rows.push({
      id: row.id,
      kind: row.kind,
      depth: row.depth,
      parentKey: row.parentKey,
      title: row.title,
      project: row.project,
      cardId: row.cardId,
      context: row.context,
      shape: shape ?? undefined,
      progress: row.progress,
    });
  }

  for (const row of rows) {
    const diamonds = diamondsByParent.get(row.id);
    if (diamonds) row.diamonds = diamonds;
  }

  const output: RoadmapRow[] = [];
  let currentProjectKey: string | undefined;
  const flushOrphan = (): void => {
    if (currentProjectKey === undefined) return;
    const diamonds = orphansByProject.get(currentProjectKey);
    if (!diamonds || diamonds.length === 0) return;
    output.push({
      id: `orphan:${currentProjectKey}`,
      kind: 'orphan',
      depth: 1,
      parentKey: `project:${currentProjectKey}`,
      title: 'Tasks ohne Parent',
      project: currentProjectKey || undefined,
      cardId: `orphan:${currentProjectKey}`,
      diamonds,
    });
  };
  for (const row of rows) {
    if (row.kind === 'project') {
      flushOrphan();
      currentProjectKey = row.project ?? '';
    }
    output.push(row);
  }
  flushOrphan();
  return output;
}
