import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadVault } from '../adapters/fs';
import {
  allViewLevels,
  buildBoard,
  canChangeLevel,
  offerableLevels,
  orderChildren,
  type LevelContext,
} from './board';
import type { BoardElement } from './model';
import { read, readElements } from './read';
import { type GeneralSettings, type ProjectSettings, resolveColumns, resolveProjectSettings } from './settings';

const here = dirname(fileURLToPath(import.meta.url));
const VAULT = join(here, '../../../fixtures/vault');

const GENERAL: GeneralSettings = {
  columns: ['Backlog', 'Ready', 'Doing', 'Done', "Won't Do"],
  doneColumns: ['Done', "Won't Do"],
};

const VORTRAG_ROOT = '03_Areas/Internal/Vortraege/Deliverables';

let cards: BoardElement[];
let elements: BoardElement[];
let projects: ProjectSettings[];

beforeAll(() => {
  const { entries, roots } = loadVault(VAULT);
  cards = read(entries, roots);
  elements = readElements(entries, roots);
  projects = resolveProjectSettings(entries).projects;
});

function project(key: string): ProjectSettings {
  const found = projects.find((p) => p.key === key);
  if (!found) throw new Error(`Projekt ${key} nicht in den Fixtures`);
  return found;
}

describe('K8 view all: unknown status as notice, invalid note as card', () => {
  it('shows only the five general columns, no waiting column', () => {
    const columns = resolveColumns(GENERAL, project('nimbus'));
    const board = buildBoard(cards, { kind: 'all' }, columns);

    expect(board.columns.map((c) => c.status)).toEqual([
      'backlog',
      'ready',
      'doing',
      'done',
      'wont-do',
    ]);
  });

  it('names the file and the unknown status value in a notice', () => {
    const columns = resolveColumns(GENERAL, project('nimbus'));
    const board = buildBoard(cards, { kind: 'all' }, columns);

    const notice = board.notices.find((n) => n.includes('ungueltiger-status'));
    expect(notice).toBeDefined();
    expect(notice).toContain('waiting');
  });

  it('places the invalid note as an Invalid card last in the first column', () => {
    const columns = resolveColumns(GENERAL, project('nimbus'));
    const board = buildBoard(cards, { kind: 'all' }, columns);

    const first = board.columns[0];
    expect(first.status).toBe('backlog');
    const last = first.cards[first.cards.length - 1];
    expect(last.invalid).toBe(true);
    expect(last.title).toBe('2026-09-01_kaputte-notiz');
  });
});

describe('K9 project view filters to the project', () => {
  it('contains only elements below the project root', () => {
    const columns = resolveColumns(GENERAL, project('vortrag'));
    const board = buildBoard(cards, { kind: 'project', project: 'vortrag' }, columns);

    const boardCards = board.columns.flatMap((c) => c.cards);
    expect(boardCards.length).toBeGreaterThan(0);
    expect(boardCards.some((c) => c.paths.note.endsWith('_2026-09-02_folien.md'))).toBe(true);
    for (const card of boardCards) {
      expect(card.paths.note.startsWith(VORTRAG_ROOT + '/')).toBe(true);
    }
  });
});

function card(over: Partial<BoardElement> & { title: string; status: string }): BoardElement {
  return {
    type: 'task',
    form: 'nested',
    priority: 3,
    tags: [],
    parents: [],
    links: [],
    paths: { note: `${over.title}.md` },
    ...over,
  };
}

function columnCards(board: ReturnType<typeof buildBoard>, status: string): BoardElement[] {
  const column = board.columns.find((c) => c.status === status);
  if (!column) throw new Error(`Spalte ${status} fehlt`);
  return column.cards;
}

describe('F004 K1 view all across projects', () => {
  it('contains nimbus, quarz and internal card, each in the column of its status', () => {
    const columns = resolveColumns(GENERAL, project('nimbus'));
    const input = [
      card({ title: 'Nimbus-Karte', status: 'doing', project: 'nimbus' }),
      card({ title: 'Quarz-Karte', status: 'backlog', project: 'quarz' }),
      card({ title: 'Interne Karte', status: 'ready' }),
    ];
    const board = buildBoard(input, { kind: 'all' }, columns);

    expect(columnCards(board, 'doing').map((c) => c.title)).toEqual(['Nimbus-Karte']);
    expect(columnCards(board, 'backlog').map((c) => c.title)).toEqual(['Quarz-Karte']);
    expect(columnCards(board, 'ready').map((c) => c.title)).toEqual(['Interne Karte']);
  });
});

describe('F004 K2 order in the column', () => {
  it('sorts by priority, then due date, missing due date last', () => {
    const columns = resolveColumns(GENERAL, project('nimbus'));
    const input = [
      card({ title: 'P3 morgen', status: 'doing', priority: 3, due: '2026-09-10' }),
      card({ title: 'P1 ohne', status: 'doing', priority: 1 }),
      card({ title: 'P3 heute', status: 'doing', priority: 3, due: '2026-09-09' }),
    ];
    const board = buildBoard(input, { kind: 'all' }, columns);

    expect(columnCards(board, 'doing').map((c) => c.title)).toEqual([
      'P1 ohne',
      'P3 heute',
      'P3 morgen',
    ]);
  });

  it('decides on equal priority without due date by title', () => {
    const columns = resolveColumns(GENERAL, project('nimbus'));
    const input = [
      card({ title: 'Bravo', status: 'ready', priority: 2 }),
      card({ title: 'Alpha', status: 'ready', priority: 2 }),
    ];
    const board = buildBoard(input, { kind: 'all' }, columns);

    expect(columnCards(board, 'ready').map((c) => c.title)).toEqual(['Alpha', 'Bravo']);
  });
});

describe('F031 K5 level change down only without children', () => {
  const featureWithChild = card({
    title: 'Datenaufnahme stabilisieren',
    status: 'doing',
    project: 'nimbus',
    type: 'feature',
  });
  const childTask = card({
    title: 'Pipeline-Fehler beheben',
    status: 'doing',
    project: 'nimbus',
    parents: [{ type: 'feature', title: featureWithChild.title, note: featureWithChild.paths.note }],
  });
  const featureWithoutChild = card({
    title: 'Monatsreporting',
    status: 'backlog',
    project: 'nimbus',
    type: 'feature',
  });
  const elements = [featureWithChild, childTask, featureWithoutChild];

  it('rejects feature with task child to task and names the task title', () => {
    const result = canChangeLevel(featureWithChild, 'task', elements);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Pipeline-Fehler beheben');
  });

  it('allows feature without children to task', () => {
    expect(canChangeLevel(featureWithoutChild, 'task', elements)).toEqual({ ok: true });
  });

  it('allows any change up, even with children', () => {
    const task = childTask;
    expect(canChangeLevel(task, 'feature', elements)).toEqual({ ok: true });
    expect(canChangeLevel(task, 'epic', elements)).toEqual({ ok: true });
  });
});

describe('F031 K4 order-aware order in the column', () => {
  it('places cards with order ascending before regular cards, invalid last', () => {
    const columns = resolveColumns(GENERAL, project('nimbus'));
    const input = [
      card({ title: 'Order 30', status: 'backlog', order: 30 }),
      card({ title: 'Order 10', status: 'backlog', order: 10 }),
      card({ title: 'Order 20', status: 'backlog', order: 20 }),
      card({ title: 'Prio 1 mit Faelligkeit', status: 'backlog', priority: 1, due: '2026-09-20' }),
      card({ title: 'Prio 3 ohne', status: 'backlog', priority: 3 }),
      card({ title: '_kaputt', status: '', invalid: true }),
    ];
    const board = buildBoard(input, { kind: 'all' }, columns);

    expect(columnCards(board, 'backlog').map((c) => c.title)).toEqual([
      'Order 10',
      'Order 20',
      'Order 30',
      'Prio 1 mit Faelligkeit',
      'Prio 3 ohne',
      '_kaputt',
    ]);
  });
});

describe('F051 orderChildren: column order, done columns last', () => {
  const columns = resolveColumns(GENERAL);

  it('sorts by column order and places done at the end, not by title', () => {
    const doing = card({ title: 'Pipeline-Fehler beheben', status: 'doing' });
    const done = card({ title: 'Aaa erledigt', status: 'done' });
    const backlog = card({ title: 'Zzz offen', status: 'backlog' });
    const result = orderChildren([done, doing, backlog], columns);
    expect(result.map((c) => c.title)).toEqual(['Zzz offen', 'Pipeline-Fehler beheben', 'Aaa erledigt']);
  });

  it('falls back to title on a tie', () => {
    const b = card({ title: 'B', status: 'doing' });
    const a = card({ title: 'A', status: 'doing' });
    expect(orderChildren([b, a], columns).map((c) => c.title)).toEqual(['A', 'B']);
  });
});

describe('F004 K3 internal view', () => {
  it('contains only cards without project', () => {
    const columns = resolveColumns(GENERAL, project('nimbus'));
    const input = [
      card({ title: 'Nimbus-Karte', status: 'doing', project: 'nimbus' }),
      card({ title: 'Quarz-Karte', status: 'doing', project: 'quarz' }),
      card({ title: 'Interne Karte', status: 'doing' }),
    ];
    const board = buildBoard(input, { kind: 'internal' }, columns);

    const boardCards = board.columns.flatMap((c) => c.cards);
    expect(boardCards.map((c) => c.title)).toEqual(['Interne Karte']);
    expect(boardCards.every((c) => !c.project)).toBe(true);
  });
});

describe('F004 K4 project view', () => {
  it('contains only cards of the chosen project', () => {
    const columns = resolveColumns(GENERAL, project('nimbus'));
    const input = [
      card({ title: 'Nimbus A', status: 'doing', project: 'nimbus' }),
      card({ title: 'Nimbus B', status: 'backlog', project: 'nimbus' }),
      card({ title: 'Quarz A', status: 'doing', project: 'quarz' }),
    ];
    const board = buildBoard(input, { kind: 'project', project: 'nimbus' }, columns);

    const boardCards = board.columns.flatMap((c) => c.cards);
    expect(boardCards.every((c) => c.project === 'nimbus')).toBe(true);
    expect(boardCards.map((c) => c.title).sort()).toEqual(['Nimbus A', 'Nimbus B']);
  });
});

describe('F004 K5 feature level', () => {
  it('shows exactly the two features of the Nimbus hierarchy, no task', () => {
    const columns = resolveColumns(GENERAL, project('nimbus'));
    const board = buildBoard(elements, { kind: 'project', project: 'nimbus' }, columns, {
      level: 'feature',
    });

    const boardCards = board.columns.flatMap((c) => c.cards);
    expect(boardCards).toHaveLength(2);
    expect(boardCards.every((c) => c.type === 'feature')).toBe(true);
    expect(boardCards.map((c) => c.title).sort()).toEqual([
      'Datenaufnahme stabilisieren',
      'Monatsreporting',
    ]);
  });
});

describe('F004 K6 epic level', () => {
  it('shows exactly the one epic of the Nimbus hierarchy', () => {
    const columns = resolveColumns(GENERAL, project('nimbus'));
    const board = buildBoard(elements, { kind: 'project', project: 'nimbus' }, columns, {
      level: 'epic',
    });

    const boardCards = board.columns.flatMap((c) => c.cards);
    expect(boardCards).toHaveLength(1);
    expect(boardCards[0].type).toBe('epic');
    expect(boardCards[0].title).toBe('Plattform-Betrieb');
  });
});

describe('F018 K2 child progress on the feature card', () => {
  it('shows four children, one done, as 1/4', () => {
    const columns = resolveColumns(GENERAL, project('nimbus'));
    const feature = card({ title: 'Feature X', status: 'doing', project: 'nimbus', type: 'feature' });
    const ref = { type: 'feature' as const, title: feature.title, note: feature.paths.note };
    const kids = ['backlog', 'ready', 'doing', 'done'].map((status, i) =>
      card({ title: `Kind ${i}`, status, project: 'nimbus', parents: [ref] }),
    );
    const board = buildBoard([feature, ...kids], { kind: 'project', project: 'nimbus' }, columns, {
      level: 'feature',
    });

    const featureCard = board.columns.flatMap((c) => c.cards).find((c) => c.title === 'Feature X');
    expect(featureCard?.checklist).toEqual({ done: 1, total: 4 });
  });
});

describe('F018 K3 feature stays in doing, no auto-complete', () => {
  it('two children both done: card stays in doing, checklist 2/2', () => {
    const columns = resolveColumns(GENERAL, project('nimbus'));
    const feature = card({ title: 'Feature Y', status: 'doing', project: 'nimbus', type: 'feature' });
    const ref = { type: 'feature' as const, title: feature.title, note: feature.paths.note };
    const kids = [0, 1].map((i) =>
      card({ title: `Kind ${i}`, status: 'done', project: 'nimbus', parents: [ref] }),
    );
    const board = buildBoard([feature, ...kids], { kind: 'project', project: 'nimbus' }, columns, {
      level: 'feature',
    });

    expect(columnCards(board, 'doing').map((c) => c.title)).toEqual(['Feature Y']);
    expect(columnCards(board, 'doing')[0].checklist).toEqual({ done: 2, total: 2 });
  });
});

describe('F007 K7 view all at the feature level', () => {
  it('shows features from two projects in the general columns, each with its project', () => {
    const columns = resolveColumns(GENERAL);
    const input = [
      card({ title: 'Feature A', status: 'doing', project: 'nimbus', type: 'feature' }),
      card({ title: 'Feature B', status: 'backlog', project: 'quarz', type: 'feature' }),
    ];
    const board = buildBoard(input, { kind: 'all' }, columns, { level: 'feature' });

    expect(board.columns.map((c) => c.status)).toEqual([
      'backlog',
      'ready',
      'doing',
      'done',
      'wont-do',
    ]);
    expect(columnCards(board, 'doing').map((c) => c.title)).toEqual(['Feature A']);
    expect(columnCards(board, 'backlog').map((c) => c.title)).toEqual(['Feature B']);
    expect(
      board.columns
        .flatMap((c) => c.cards)
        .map((c) => c.project)
        .sort(),
    ).toEqual(['nimbus', 'quarz']);
  });
});

describe('F004 K7 task level restricted to one epic', () => {
  it('contains tasks below both feature folders, no task outside the epic', () => {
    const columns = resolveColumns(GENERAL, project('nimbus'));
    const board = buildBoard(elements, { kind: 'project', project: 'nimbus' }, columns, {
      level: 'task',
      epic: 'Plattform-Betrieb',
    });

    const boardCards = board.columns.flatMap((c) => c.cards);
    expect(boardCards.length).toBeGreaterThan(0);
    for (const c of boardCards) {
      expect(c.parents.some((p) => p.type === 'epic' && p.title === 'Plattform-Betrieb')).toBe(true);
    }
    expect(boardCards.some((c) => c.paths.note.includes('/2026-08-11_da/'))).toBe(true);
    expect(boardCards.some((c) => c.paths.note.includes('/2026-08-25_reporting/'))).toBe(true);
    expect(boardCards.some((c) => c.paths.note.includes('2026-09-08_abnahmetermin'))).toBe(false);
  });
});

const NIMBUS_LEVELS = [
  { key: 'epic', name: 'Epic', icon: 'layers' },
  { key: 'feature', name: 'Feature', icon: 'box' },
  { key: 'story', name: 'User Story', icon: 'book-open' },
  { key: 'task', name: 'Task', icon: 'square' },
];
const GENERAL_LEVELS = [
  { key: 'epic', name: 'Epic', icon: 'layers' },
  { key: 'feature', name: 'Feature', icon: 'box' },
  { key: 'task', name: 'Task', icon: 'square' },
];

describe('F048 K5 view all maps rank from below', () => {
  const ctx: LevelContext = {
    generalLevels: GENERAL_LEVELS,
    projectLevels: { nimbus: NIMBUS_LEVELS },
    allLevels: 'rank',
  };
  const nimbusEpic = card({ title: 'Epic N', status: 'doing', project: 'nimbus', type: 'epic' });
  const epicRef = { type: 'epic' as const, title: nimbusEpic.title, note: nimbusEpic.paths.note };
  const nimbusStory = card({
    title: 'Story N',
    status: 'doing',
    project: 'nimbus',
    type: 'story',
    parents: [epicRef],
  });
  const columns = resolveColumns(GENERAL);
  const elements = [nimbusEpic, nimbusStory];

  it('shows the story element on the general level feature (same rank from below)', () => {
    const board = buildBoard(elements, { kind: 'all' }, columns, { level: 'feature', levelContext: ctx });
    const boardCards = board.columns.flatMap((c) => c.cards);
    expect(boardCards.map((c) => c.title)).toEqual(['Story N']);
  });

  it('when Nimbus rank (epic, rank 3) extends above the general list (ranks 0-2), lands on the top general level', () => {
    const board = buildBoard(elements, { kind: 'all' }, columns, { level: 'epic', levelContext: ctx });
    const boardCards = board.columns.flatMap((c) => c.cards);
    expect(boardCards.map((c) => c.title)).toEqual(['Epic N']);
  });

  it('allViewLevels(rank) delivers the general list', () => {
    expect(allViewLevels('rank', GENERAL_LEVELS)).toEqual(GENERAL_LEVELS);
  });
});

describe('F048 K6 view all shows only the bottom level per project', () => {
  const ctx: LevelContext = {
    generalLevels: GENERAL_LEVELS,
    projectLevels: {
      nimbus: NIMBUS_LEVELS,
      quarz: [
        { key: 'epic', name: 'Epic', icon: 'layers' },
        { key: 'task', name: 'Task', icon: 'square' },
      ],
    },
    allLevels: 'bottom',
  };
  const nimbusTask = card({ title: 'Nimbus Task', status: 'doing', project: 'nimbus', type: 'task' });
  const nimbusStory = card({ title: 'Nimbus Story', status: 'doing', project: 'nimbus', type: 'story' });
  const nimbusEpic = card({ title: 'Nimbus Epic', status: 'doing', project: 'nimbus', type: 'epic' });
  const quarzTask = card({ title: 'Quarz Task', status: 'doing', project: 'quarz', type: 'task' });
  const quarzEpic = card({ title: 'Quarz Epic', status: 'doing', project: 'quarz', type: 'epic' });
  const columns = resolveColumns(GENERAL);
  const elements = [nimbusTask, nimbusStory, nimbusEpic, quarzTask, quarzEpic];

  it('contains only the task cards of both projects', () => {
    const board = buildBoard(elements, { kind: 'all' }, columns, { levelContext: ctx });
    const boardCards = board.columns.flatMap((c) => c.cards);
    expect(boardCards.map((c) => c.title).sort()).toEqual(['Nimbus Task', 'Quarz Task']);
  });

  it('allViewLevels(bottom) delivers an empty list, no switcher', () => {
    expect(allViewLevels('bottom', GENERAL_LEVELS)).toEqual([]);
  });
});

describe('F056 K4 offerableLevels: level field respects parent and children', () => {
  it('task under a story offers only task', () => {
    expect(offerableLevels(NIMBUS_LEVELS, 'story', [])).toEqual([
      { key: 'task', name: 'Task', icon: 'square' },
    ]);
  });

  it('task without parent offers all four levels', () => {
    expect(offerableLevels(NIMBUS_LEVELS, undefined, [])).toEqual(NIMBUS_LEVELS);
  });

  it('feature under an epic with a task child offers only the intermediate levels', () => {
    expect(offerableLevels(NIMBUS_LEVELS, 'epic', ['task'])).toEqual([
      { key: 'feature', name: 'Feature', icon: 'box' },
      { key: 'story', name: 'User Story', icon: 'book-open' },
    ]);
  });
});
