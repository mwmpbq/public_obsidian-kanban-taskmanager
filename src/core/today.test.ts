import { describe, expect, it } from 'vitest';
import type { BoardElement } from './model';
import { DEFAULT_TODAY_SORT, orderTodayTiles, today, type TodayTile } from './today';

const TODAY = '2026-09-09';
const DONE = new Set(['done', 'wont-do']);
const isDone = (task: BoardElement): boolean => DONE.has(task.status);

function task(overrides: Partial<BoardElement> & { title: string }): BoardElement {
  return {
    type: 'task',
    form: 'nested',
    status: 'doing',
    priority: 3,
    tags: [],
    parents: [],
    links: [],
    paths: { note: `${overrides.title}.md` },
    ...overrides,
  };
}

describe('today', () => {
  it('reports a task planned for today under planned (K1)', () => {
    const t = task({ title: 'planned today', planned: TODAY });
    const result = today([t], TODAY, isDone, true);
    expect(result.planned).toContain(t);
    expect(result.overdue).toEqual([]);
  });

  it('reports a task due yesterday under overdue (K2)', () => {
    const t = task({ title: 'due yesterday', due: '2026-09-08' });
    const result = today([t], TODAY, isDone, true);
    expect(result.overdue).toContain(t);
    expect(result.planned).toEqual([]);
  });

  it('leaves out a done task that is overdue (K3)', () => {
    const t = task({ title: 'done overdue', status: 'done', due: '2026-09-08' });
    const result = today([t], TODAY, isDone, true);
    expect(result.overdue).toEqual([]);
    expect(result.planned).toEqual([]);
  });

  it('reports neither overdue nor planned when nothing is due (K5)', () => {
    const future = task({ title: 'future', planned: '2026-09-20', due: '2026-09-25' });
    const result = today([future], TODAY, isDone, true);
    expect(result.overdue).toEqual([]);
    expect(result.planned).toEqual([]);
  });

  it('drops planned tasks when the planned report is off (K6)', () => {
    const t = task({ title: 'planned today', planned: TODAY });
    const result = today([t], TODAY, isDone, false);
    expect(result.planned).toEqual([]);
  });

  it('keeps overdue tasks when the planned report is off (K7)', () => {
    const t = task({ title: 'overdue', due: '2026-09-08' });
    const result = today([t], TODAY, isDone, false);
    expect(result.overdue).toContain(t);
  });

  it('reports an overdue task from another project (K8)', () => {
    const b = task({ title: 'from B', project: 'projectB', due: '2026-09-08' });
    const result = today([b], TODAY, isDone, true);
    expect(result.overdue).toContain(b);
    expect(result.overdue[0]?.project).toBe('projectB');
  });

  it('reports only tasks, regardless of the board level (K10)', () => {
    const feature = task({ title: 'overdue feature', type: 'feature', due: '2026-09-08' });
    const epic = task({ title: 'overdue epic', type: 'epic', due: '2026-09-08' });
    const t = task({ title: 'overdue task', due: '2026-09-08' });
    const result = today([feature, epic, t], TODAY, isDone, true);
    expect(result.overdue).toEqual([t]);
  });

  it('leaves out an invalid task even when it carries an overdue date', () => {
    const t = task({ title: 'broken', due: '2026-09-08', invalid: true });
    const result = today([t], TODAY, isDone, true);
    expect(result.overdue).toEqual([]);
  });
});

function tile(overrides: Partial<TodayTile> & { title: string; date: string }): TodayTile {
  const { title, date, kind, element } = overrides;
  return {
    kind: kind ?? 'overdue',
    date,
    element: element ?? task({ title, due: date }),
  };
}

function titles(tiles: TodayTile[]): string[] {
  return tiles.map((t) => t.element.title);
}

describe('orderTodayTiles', () => {
  it('orders by project, then due, with internal first (K1)', () => {
    const tiles = [
      tile({ title: 'quarz', date: '2026-09-05', element: task({ title: 'quarz', project: 'quarz', due: '2026-09-05' }) }),
      tile({ title: 'nimbus-08', date: '2026-09-08', element: task({ title: 'nimbus-08', project: 'nimbus', due: '2026-09-08' }) }),
      tile({ title: 'intern', date: '2026-09-06' }),
      tile({ title: 'nimbus-07', date: '2026-09-07', element: task({ title: 'nimbus-07', project: 'nimbus', due: '2026-09-07' }) }),
    ];
    const ordered = orderTodayTiles(tiles, DEFAULT_TODAY_SORT, ['nimbus', 'quarz']);
    expect(titles(ordered)).toEqual(['intern', 'nimbus-07', 'nimbus-08', 'quarz']);
  });

  it('breaks a project-and-due tie by priority ascending (K2)', () => {
    const tiles = [
      tile({ title: 'prio-3', date: '2026-09-08', element: task({ title: 'prio-3', project: 'nimbus', due: '2026-09-08', priority: 3 }) }),
      tile({ title: 'prio-1', date: '2026-09-08', element: task({ title: 'prio-1', project: 'nimbus', due: '2026-09-08', priority: 1 }) }),
    ];
    const ordered = orderTodayTiles(tiles, DEFAULT_TODAY_SORT, ['nimbus']);
    expect(titles(ordered)).toEqual(['prio-1', 'prio-3']);
  });

  it('orders by due first when the sort order leads with due (K3)', () => {
    const tiles = [
      tile({ title: 'nimbus', date: '2026-09-08', element: task({ title: 'nimbus', project: 'nimbus', due: '2026-09-08' }) }),
      tile({ title: 'quarz', date: '2026-09-06', element: task({ title: 'quarz', project: 'quarz', due: '2026-09-06' }) }),
      tile({ title: 'intern', date: '2026-09-07' }),
    ];
    const ordered = orderTodayTiles(tiles, ['due', 'project', 'priority'], ['nimbus', 'quarz']);
    expect(titles(ordered)).toEqual(['quarz', 'intern', 'nimbus']);
  });
});
