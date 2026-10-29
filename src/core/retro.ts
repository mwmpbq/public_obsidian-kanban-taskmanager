import { ownRank, rankOf, type LevelContext } from './board';
import { addDays, dayDiff, mondayOf } from './dates';
import { isVisibleUnderSelection, type FilterSelection } from './filter';
import type { BoardElement, ElementType } from './model';
import type { Column, Level } from './settings';
import { type TreeProjectEntry } from './tree';
import { roleOf } from './week';

export interface RetroEntry {
  id: string;
  kind: ElementType;
  cardId: string;
  title: string;
  completed: string;
  /** Tage von `started` bis `completed`, inklusiv; fehlt ohne `started` (012 "Rückblick"). */
  duration?: number;
  /** Nur Zeilen (kind oberhalb der untersten Ebene): Zahl der Tasks dieser Woche darunter, rekursiv über `children`. */
  taskCount?: number;
  /** Nur Zeilen: ihre in dieser Woche erledigten Kinder, selbst Tasks oder weitere Zeilen. */
  children?: RetroEntry[];
}

export interface RetroProjectGroup {
  key?: string;
  name: string;
  entries: RetroEntry[];
}

export interface RetroWeek {
  monday: string;
  /** Zahl der in dieser Woche erledigten untersten Tasks. */
  taskCount: number;
  /** Erledigte unterste Tasks je Wochentag, Montag zuerst. */
  dayCounts: number[];
  /** Zahl abgeschlossener Elemente je Ebene oberhalb der untersten, bis zur gewählten Ebene. */
  levelCounts: Partial<Record<ElementType, number>>;
  projects: RetroProjectGroup[];
}

export interface RetroOptions {
  columns: Column[];
  levelContext: LevelContext;
  /** Oberste gezeigte Ebene (012 "Ebenen-Schalter = oberste Ebene"), anders als bei Baum/Roadmap. */
  level: ElementType;
  filterSelection: FilterSelection;
  /** Montag der neuesten (obersten) Woche; die drei davor folgen absteigend. */
  weekStart: string;
}

function levelsForProject(ctx: LevelContext, project: string | undefined): Level[] {
  return (project ? ctx.projectLevels[project] : undefined) ?? ctx.generalLevels;
}

function bottomTypeFor(ctx: LevelContext, project: string | undefined): ElementType {
  const levels = levelsForProject(ctx, project);
  return levels[levels.length - 1]?.key ?? 'task';
}

function countLeafTasks(entries: readonly RetroEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += entry.children ? countLeafTasks(entry.children) : 1;
  }
  return total;
}

function compareByCompleted(a: RetroEntry, b: RetroEntry): number {
  if (a.completed !== b.completed) return a.completed < b.completed ? -1 : 1;
  return a.title.localeCompare(b.title, 'de');
}

/**
 * Baut die vier Rückblick-Wochen absteigend ab `weekStart` (012 S32-S35,
 * "Rückblick"): nur Elemente mit der Rolle `done` (`roleOf`, wont-do und
 * ungültige fehlen), nach `completed`. Ein Element zählt nur bis zur
 * gewählten Ebene (`ownRank`/`rankOf`, Wissen #371) — auf Ebene `task` bleibt
 * jede Zeile einer höheren Ebene ganz außen vor. Ein Element oberhalb der
 * untersten Ebene wird nur dann zur Zeile, wenn es selbst in derselben Woche
 * erledigt wurde wie sein jeweiliges Kind (geprüft über den direkten Parent,
 * `parents[0].note`, wie `tree.ts#childrenByNote`); sonst steht das Kind für
 * sich, auch wenn ein weiter entfernter Vorfahr in dieser Woche erledigt
 * wurde. Die Statusauswahl des Filters wirkt nie (012 "Für alle
 * Darstellungen"), ids und tags wie überall (`isVisibleUnderSelection`).
 */
export function buildRetro(
  elements: readonly BoardElement[],
  projects: readonly TreeProjectEntry[],
  options: RetroOptions,
): RetroWeek[] {
  const { columns, levelContext: ctx, level, filterSelection, weekStart } = options;
  // Nur die Projekte der Ansicht (wie buildTree): ein Element eines anderen
  // Projekts zählt nirgends mit, auch nicht in den Wochensummen links.
  const projectKeys = new Set(projects.map((p) => p.key ?? ''));
  const valid = elements.filter((el) => !el.invalid && projectKeys.has(el.project ?? ''));
  const byNote = new Map(valid.map((el) => [el.paths.note, el]));
  const selection: FilterSelection = { ids: filterSelection.ids, statuses: new Set(), tags: filterSelection.tags };

  const isCandidate = (el: BoardElement): boolean => {
    if (el.completed === undefined) return false;
    const rank = ownRank(el, ctx);
    if (rank === undefined) return false;
    const cutoff = rankOf(levelsForProject(ctx, el.project), level) ?? 0;
    if (rank > cutoff) return false;
    if (roleOf(el.status, columns) !== 'done') return false;
    return isVisibleUnderSelection(el, selection, bottomTypeFor(ctx, el.project));
  };
  const candidates = valid.filter(isCandidate);

  const buildWeek = (monday: string): RetroWeek => {
    const inWeek = candidates.filter((el) => mondayOf(el.completed as string) === monday);
    const tasks = inWeek.filter((el) => ownRank(el, ctx) === 0);
    const dayCounts = Array.from({ length: 7 }, (_, i) => {
      const day = addDays(monday, i);
      return tasks.filter((t) => t.completed === day).length;
    });

    const levelCounts: Partial<Record<ElementType, number>> = {};
    for (const el of inWeek) {
      if (ownRank(el, ctx) === 0) continue;
      levelCounts[el.type] = (levelCounts[el.type] ?? 0) + 1;
    }

    const candidateIds = new Set(inWeek.map((el) => el.id));
    const isRoot = (el: BoardElement): boolean => {
      const parentNote = el.parents[0]?.note;
      if (parentNote === undefined) return true;
      const parent = byNote.get(parentNote);
      return !parent || !candidateIds.has(parent.id);
    };
    const directChildren = (note: string): BoardElement[] => inWeek.filter((el) => el.parents[0]?.note === note);

    const buildEntry = (el: BoardElement): RetroEntry => {
      const completed = el.completed as string;
      const duration = el.started !== undefined ? (dayDiff(completed, el.started) ?? 0) + 1 : undefined;
      if (ownRank(el, ctx) === 0) {
        return { id: el.id, kind: el.type, cardId: el.paths.note, title: el.title, completed, duration };
      }
      const children = directChildren(el.paths.note).map(buildEntry).sort(compareByCompleted);
      return {
        id: el.id,
        kind: el.type,
        cardId: el.paths.note,
        title: el.title,
        completed,
        duration,
        taskCount: countLeafTasks(children),
        children,
      };
    };

    const projectGroups: RetroProjectGroup[] = [];
    for (const project of projects) {
      const projectKey = project.key ?? '';
      const roots = inWeek
        .filter((el) => (el.project ?? '') === projectKey && isRoot(el))
        .map(buildEntry)
        .sort(compareByCompleted);
      if (roots.length === 0) continue;
      projectGroups.push({ key: project.key, name: project.name, entries: roots });
    }

    return { monday, taskCount: tasks.length, dayCounts, levelCounts, projects: projectGroups };
  };

  return [0, 1, 2, 3].map((i) => buildWeek(addDays(weekStart, -7 * i)));
}
