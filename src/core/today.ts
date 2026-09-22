import { dueState } from './dates';
import type { BoardElement } from './model';

export interface TodayTasks {
  overdue: BoardElement[];
  planned: BoardElement[];
}

export type TodayKey = 'project' | 'due' | 'priority';

export const DEFAULT_TODAY_SORT: TodayKey[] = ['project', 'due', 'priority'];

export interface TodayTile {
  element: BoardElement;
  kind: 'overdue' | 'planned';
  // Overdue tiles carry their due date, planned tiles their planned date; this
  // is the date that both the ordering and the tile's signal read.
  date: string;
}

/**
 * Selects the tasks the "Heute" area reports, across every project: open tasks
 * whose due date lies in the past (overdue) and — unless the planned report is
 * switched off — open tasks planned for today. Only tasks qualify; features and
 * epics never appear, so the board's level does not narrow the set. Done and
 * invalid tasks are left out. Ordering is left to the caller (F020).
 */
export function today(
  elements: BoardElement[],
  todayISO: string,
  isDone: (task: BoardElement) => boolean,
  notifyPlanned: boolean,
): TodayTasks {
  const tasks = elements.filter((el) => el.type === 'task' && !el.invalid && !isDone(el));
  const overdue = tasks.filter((el) => el.due !== undefined && dueState(el.due, todayISO) === 'overdue');
  const planned = notifyPlanned
    ? tasks.filter((el) => el.planned !== undefined && dueState(el.planned, todayISO) === 'today')
    : [];
  return { overdue, planned };
}

/**
 * Orders the "Heute" tiles by the three keys in `sortOrder`, the sequence the
 * general settings choose (default project, then due, then priority). The
 * project key ranks internal tiles (no project) first, then the projects in the
 * order the view lists them; a project not in that order sorts after the known
 * ones. The due key compares the tile's relevant date ascending. Ties fall back
 * to the title so the order is deterministic. Pure and Obsidian-free (F020).
 */
export function orderTodayTiles(
  tiles: TodayTile[],
  sortOrder: TodayKey[],
  projectOrder: string[],
): TodayTile[] {
  const rank = new Map(projectOrder.map((key, index) => [key, index]));
  const projectRank = (tile: TodayTile): number =>
    tile.element.project === undefined ? -1 : rank.get(tile.element.project) ?? projectOrder.length;
  const compareKey = (key: TodayKey, a: TodayTile, b: TodayTile): number => {
    if (key === 'project') return projectRank(a) - projectRank(b);
    if (key === 'due') return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    return a.element.priority - b.element.priority;
  };
  return [...tiles].sort((a, b) => {
    for (const key of sortOrder) {
      const cmp = compareKey(key, a, b);
      if (cmp !== 0) return cmp;
    }
    return a.element.title.localeCompare(b.element.title);
  });
}
