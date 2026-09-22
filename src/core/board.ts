import type { BoardElement, Checklist, ElementType } from './model';
import type { Column, Level } from './settings';

export type BoardView =
  | { kind: 'all' }
  | { kind: 'internal' }
  | { kind: 'project'; project: string };

/**
 * What the `all` view needs to map an element's level, defined in its own
 * project's level list, onto the general level list (006, addendum
 * 2026-09-20; S24, S25). `projectLevels` is keyed by `BoardElement.project`;
 * an element whose project is missing from it falls back to `generalLevels`.
 */
export interface LevelContext {
  generalLevels: Level[];
  projectLevels: Record<string, Level[]>;
  allLevels: 'rank' | 'bottom';
}

export interface BoardOptions {
  level?: ElementType;
  epic?: string;
  levelContext?: LevelContext;
}

/**
 * Levels the `all` view's level switcher offers: the general list in `rank`
 * mode, none in `bottom` mode, since there the switcher itself is absent.
 */
export function allViewLevels(mode: 'rank' | 'bottom', generalLevels: Level[]): Level[] {
  return mode === 'rank' ? generalLevels : [];
}

/**
 * Levels the field "Ebene" may offer for an element, from `levels` (top
 * first, as stored): deeper than its immediate parent, shallower than every
 * direct child, so the level order with both stays intact (008 S23/S40, 009
 * addendum 2026-09-20). Without a parent, every level up to the shallowest
 * child's is offered; without children, every level below the parent is.
 */
export function offerableLevels(
  levels: Level[],
  parentType: ElementType | undefined,
  childTypes: ElementType[],
): Level[] {
  const indexOf = (key: ElementType): number => levels.findIndex((l) => l.key === key);
  const parentIndex = parentType !== undefined ? indexOf(parentType) : -1;
  const childBarrier = childTypes.reduce((min, type) => {
    const idx = indexOf(type);
    return idx === -1 ? min : Math.min(min, idx);
  }, levels.length);
  return levels.filter((_, i) => i > parentIndex && i < childBarrier);
}

// Rank from the bottom of `list` (bottom = 0), or undefined if `key` is not
// in the list at all.
function rankOf(list: Level[], key: string): number | undefined {
  const idx = list.findIndex((l) => l.key === key);
  return idx === -1 ? undefined : list.length - 1 - idx;
}

// An element's rank from the bottom of its own project's level list, or the
// general list for an element without a project or one missing from the
// context.
function ownRank(el: BoardElement, ctx: LevelContext): number | undefined {
  const list = (el.project ? ctx.projectLevels[el.project] : undefined) ?? ctx.generalLevels;
  return rankOf(list, el.type);
}

export interface BoardColumn extends Column {
  cards: BoardElement[];
}

export interface Board {
  columns: BoardColumn[];
  notices: string[];
}

/**
 * Groups elements of the requested level (default `task`) into the resolved
 * columns by status slug. The view narrows the set: `internal` keeps only cards
 * without a project, `project` only that project's cards. An `epic` scope keeps
 * only cards below that epic, across feature folders. A valid card whose status
 * matches no column gets no card and no extra column; instead it is named in a
 * notice. Invalid cards carry no status and stand last in the first column.
 * Within each column cards sort by priority, then due date (missing last), then
 * title. On a container level (feature, epic) each card's `checklist` is
 * replaced by the progress of its direct children: how many of them sit in a
 * done column out of the total. The container's own status is never derived
 * from its children.
 */
export function buildBoard(
  elements: BoardElement[],
  view: BoardView,
  columns: Column[],
  options: BoardOptions = {},
): Board {
  const level = options.level ?? 'task';
  let visible = elements.filter((c) => c.type === level);

  const ctx = options.levelContext;
  if (view.kind === 'all' && ctx) {
    visible =
      ctx.allLevels === 'bottom'
        ? elements.filter((c) => ownRank(c, ctx) === 0)
        : elements.filter((c) => {
            const rank = ownRank(c, ctx);
            if (rank === undefined) return false;
            const mapped = Math.min(rank, ctx.generalLevels.length - 1);
            return mapped === (rankOf(ctx.generalLevels, level) ?? 0);
          });
  }

  if (view.kind === 'project') visible = visible.filter((c) => c.project === view.project);
  else if (view.kind === 'internal') visible = visible.filter((c) => !c.project);

  if (options.epic) {
    visible = visible.filter((c) =>
      c.parents.some((p) => p.type === 'epic' && p.title === options.epic),
    );
  }

  if (level !== 'task') {
    const doneStatuses = new Set(columns.filter((c) => c.done).map((c) => c.status));
    visible = visible.map((card) => ({
      ...card,
      checklist: childProgress(card, elements, doneStatuses),
    }));
  }

  const result: BoardColumn[] = columns.map((c) => ({ ...c, cards: [] }));
  const byStatus = new Map<string, BoardColumn>();
  for (const col of result) byStatus.set(col.status, col);

  const notices: string[] = [];
  const invalidCards: BoardElement[] = [];

  for (const card of visible) {
    if (card.invalid) {
      invalidCards.push(card);
      continue;
    }
    if (card.notice) notices.push(card.notice);
    const col = byStatus.get(card.status);
    if (!col) {
      notices.push(unknownStatusNotice(card));
      continue;
    }
    col.cards.push(card);
  }

  for (const col of result) col.cards.sort(compareCards);

  if (invalidCards.length > 0 && result.length > 0) {
    invalidCards.sort((a, b) => a.title.localeCompare(b.title));
    result[0].cards.push(...invalidCards);
  }

  return { columns: result, notices };
}

const LEVEL_RANK: Record<ElementType, number> = { epic: 0, feature: 1, task: 2 };

/**
 * Whether an element may change to `target`. A move up or unchanged (toward
 * epic) is always allowed; a move down (toward task) only without children,
 * since the lower level carries none. On refusal the first child's title is the
 * reason (008 S23, addendum level change).
 */
export function canChangeLevel(
  element: Pick<BoardElement, 'type' | 'paths'>,
  target: ElementType,
  elements: BoardElement[],
): { ok: true } | { ok: false; reason: string } {
  if (LEVEL_RANK[target] <= LEVEL_RANK[element.type]) return { ok: true };
  const child = elements.find((el) => el.parents[0]?.note === element.paths.note);
  if (!child) return { ok: true };
  return { ok: false, reason: `„${child.title}“ ist ein untergeordnetes Element.` };
}

function childProgress(
  parent: BoardElement,
  elements: BoardElement[],
  doneStatuses: Set<string>,
): Checklist | undefined {
  let done = 0;
  let total = 0;
  for (const el of elements) {
    if (el.parents[0]?.note !== parent.paths.note) continue;
    total++;
    if (doneStatuses.has(el.status)) done++;
  }
  return total === 0 ? undefined : { done, total };
}

function unknownStatusNotice(card: BoardElement): string {
  return `Unbekannter Status „${card.status}“: ${card.paths.note} erscheint auf keiner Spalte.`;
}

/**
 * Sorts an element's children for the enlarged card's link list: by
 * column order, done columns last (DESIGN.md data shape "children"),
 * on a tie by title. A child in an unknown column stands behind all
 * known ones.
 */
export function orderChildren(children: BoardElement[], columns: Column[]): BoardElement[] {
  const rank = new Map(columns.map((c, i) => [c.status, i]));
  const doneStatuses = new Set(columns.filter((c) => c.done).map((c) => c.status));
  return [...children].sort((a, b) => {
    const doneA = doneStatuses.has(a.status) ? 1 : 0;
    const doneB = doneStatuses.has(b.status) ? 1 : 0;
    if (doneA !== doneB) return doneA - doneB;
    const rankA = rank.get(a.status) ?? Number.MAX_SAFE_INTEGER;
    const rankB = rank.get(b.status) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return a.title.localeCompare(b.title);
  });
}

// Manually ordered cards (field `order`, Spec 003) come first in ascending
// order; the rest follow the default rule of priority, then due date, then
// title (DESIGN.md, data shape "order within column").
function compareCards(a: BoardElement, b: BoardElement): number {
  if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
  if (a.order !== undefined) return -1;
  if (b.order !== undefined) return 1;
  if (a.priority !== b.priority) return a.priority - b.priority;
  const byDue = compareDue(a.due, b.due);
  if (byDue !== 0) return byDue;
  return a.title.localeCompare(b.title);
}

function compareDue(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : 1;
}
