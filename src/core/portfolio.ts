import { ownRank, type LevelContext } from './board';
import { addDays, mondayOf } from './dates';
import { isVisibleUnderSelection, type FilterSelection } from './filter';
import type { BoardElement, ElementType } from './model';
import type { Column, ColumnRole, Level } from './settings';
import { childrenByNote, descendantTasksOf, type TreeProjectEntry } from './tree';
import { roleOf, statusTone, type WeekTone } from './week';

export type PortfolioScope = 'project' | 'epic' | 'feature';
export type PortfolioTileKind = PortfolioScope | 'loose';

export interface PortfolioDistributionSegment {
  tone: WeekTone;
  count: number;
}

export interface PortfolioProgressRow {
  cardId: string;
  title: string;
  done: number;
  total: number;
}

export interface PortfolioTile {
  kind: PortfolioTileKind;
  /** `ktm_id` eines Epics/Features, Projekt-Kürzel (leer für Intern) sonst. */
  id: string;
  /** Notizpfad des Elements; fehlt bei Projekt- und Ohne-Kacheln, die keine eigene Notiz haben. */
  cardId?: string;
  title: string;
  /** Projekt-Kürzel, `undefined` für Intern (012 "Portfolio": Projektname bei Epics/Features in "Alle Aufgaben"). */
  project?: string;
  due?: string;
  openCount: number;
  distribution: PortfolioDistributionSegment[];
  overdue: number;
  dueToday: number;
  restOfWeek: number;
  progress: PortfolioProgressRow[];
  /** Cardpfade, höchstens zwei, aufsteigend nach (planned||due). */
  upcoming: string[];
}

export interface PortfolioOptions {
  columns: Column[];
  levelContext: LevelContext;
  kind: PortfolioScope;
  filterSelection: FilterSelection;
  today: string;
}

const DISTRIBUTION_TONES: readonly WeekTone[] = ['done', 'active', 'ready', 'open'];

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

/**
 * Baut die Portfolio-Kacheln (012 S36-S39, "Portfolio"): `projects` wie bei
 * `buildTree`/`buildRetro` (Intern + alle Projekte, oder nur das Projekt der
 * Ansicht). `kind` wählt die Granularität der Kacheln; auf Ebene `project`
 * entsteht genau eine Kachel je Eintrag aus `projects`, auf `epic`/`feature`
 * eine je offenem, gültigem Element dieser Ebene (erledigte und verworfene
 * fehlen, Wissen #1099/#1315), dazu je Projekt mit offenen Tasks ohne
 * Vorfahren dieser Ebene eine Kachel `loose` ("Ohne Epic"/"Ohne Feature"). Die
 * Verteilung, die drei Signale, "Als Nächstes" und die Zahl "offen" einer
 * Kachel zählen nur über nicht verworfene, gültige, unter dem Filter
 * sichtbare Tasks (`isVisibleUnderSelection`); der Fortschritt darunter (die
 * nächste Ebene) zählt wie `tree.ts`s Fortschrittsbalken unabhängig vom
 * Filter, nur ohne verworfene.
 */
export function buildPortfolio(
  elements: readonly BoardElement[],
  projects: readonly TreeProjectEntry[],
  options: PortfolioOptions,
): PortfolioTile[] {
  const { columns, levelContext: ctx, kind, filterSelection, today } = options;
  const projectKeys = new Set(projects.map((p) => p.key ?? ''));
  const valid = elements.filter((el) => !el.invalid && projectKeys.has(el.project ?? ''));
  const byNoteFull = childrenByNote(valid);
  const sunday = addDays(mondayOf(today), 6);

  const roleFor = (el: BoardElement): ColumnRole => roleOf(el.status, columns);
  const isOpenish = (el: BoardElement): boolean => {
    const role = roleFor(el);
    return role === 'open' || role === 'active';
  };
  const isDiscarded = (el: BoardElement): boolean => roleFor(el) === 'wont-do';
  const isVisible = (el: BoardElement): boolean =>
    isVisibleUnderSelection(el, filterSelection, bottomTypeFor(ctx, el.project));

  const progressRow = (el: BoardElement): PortfolioProgressRow => {
    const tasks = descendantTasksOf(el, byNoteFull, ctx).filter((t) => !isDiscarded(t));
    const done = tasks.filter((t) => roleFor(t) === 'done').length;
    return { cardId: el.paths.note, title: el.title, done, total: tasks.length };
  };

  // "überfällig" zuerst (ein Datum in der Vergangenheit sticht ein anderes
  // in der Zukunft), dann "heute", dann "Rest der Woche" (Umsetzung F203):
  // jeder Task zählt in höchstens ein Signal.
  const signalBucket = (t: BoardElement): 'overdue' | 'today' | 'week' | undefined => {
    const due = t.due;
    const planned = t.planned;
    if ((due !== undefined && due < today) || (planned !== undefined && planned < today)) return 'overdue';
    if (planned === today || due === today) return 'today';
    const ref = planned ?? due;
    if (ref !== undefined && ref > today && ref <= sunday) return 'week';
    return undefined;
  };

  const tileFromTasks = (
    base: Pick<PortfolioTile, 'kind' | 'id' | 'cardId' | 'title' | 'project' | 'due'>,
    descendants: readonly BoardElement[],
    progress: PortfolioProgressRow[],
  ): PortfolioTile => {
    const tasks = descendants.filter((t) => !isDiscarded(t) && isVisible(t));
    const openCount = tasks.filter(isOpenish).length;
    const distribution = DISTRIBUTION_TONES.map((tone) => ({
      tone,
      count: tasks.filter((t) => statusTone(t.status, columns) === tone).length,
    }));
    const signalTasks = tasks.filter((t) => roleFor(t) !== 'done');
    let overdue = 0;
    let dueToday = 0;
    let restOfWeek = 0;
    const candidates: BoardElement[] = [];
    for (const t of signalTasks) {
      const bucket = signalBucket(t);
      if (bucket === 'overdue') overdue++;
      else if (bucket === 'today') dueToday++;
      else if (bucket === 'week') restOfWeek++;
      if (t.planned !== undefined || t.due !== undefined) candidates.push(t);
    }
    const upcoming = [...candidates]
      .sort((a, b) => {
        const da = (a.planned ?? a.due) as string;
        const db = (b.planned ?? b.due) as string;
        return da < db ? -1 : da > db ? 1 : 0;
      })
      .slice(0, 2)
      .map((t) => t.paths.note);
    return { ...base, openCount, distribution, overdue, dueToday, restOfWeek, progress, upcoming };
  };

  const tiles: PortfolioTile[] = [];

  if (kind === 'project') {
    for (const project of projects) {
      const key = project.key ?? '';
      const descendants = valid.filter((el) => isBottom(el, ctx) && (el.project ?? '') === key);
      const openEpics = valid.filter((el) => el.type === 'epic' && (el.project ?? '') === key && isOpenish(el));
      tiles.push(
        tileFromTasks(
          { kind: 'project', id: key, cardId: undefined, title: project.name, project: project.key, due: undefined },
          descendants,
          openEpics.map(progressRow),
        ),
      );
    }
    return tiles;
  }

  for (const project of projects) {
    const key = project.key ?? '';
    const owners = valid.filter((el) => el.type === kind && (el.project ?? '') === key && isOpenish(el));
    for (const owner of owners) {
      const descendants = descendantTasksOf(owner, byNoteFull, ctx);
      let progress: PortfolioProgressRow[] = [];
      if (kind === 'epic') {
        const features = valid.filter(
          (el) => el.type === 'feature' && el.parents[0]?.note === owner.paths.note && !isDiscarded(el),
        );
        progress = features.map(progressRow);
      }
      tiles.push(
        tileFromTasks(
          { kind, id: owner.id, cardId: owner.paths.note, title: owner.title, project: owner.project, due: owner.due },
          descendants,
          progress,
        ),
      );
    }

    const orphanCandidates = valid.filter(
      (el) => isBottom(el, ctx) && (el.project ?? '') === key && !el.parents.some((p) => p.type === kind),
    );
    if (orphanCandidates.length > 0) {
      const looseTile = tileFromTasks(
        {
          kind: 'loose',
          id: `${key}:loose`,
          cardId: undefined,
          title: kind === 'epic' ? 'Ohne Epic' : 'Ohne Feature',
          project: project.key,
          due: undefined,
        },
        orphanCandidates,
        [],
      );
      if (looseTile.openCount > 0) tiles.push(looseTile);
    }
  }

  return tiles;
}
