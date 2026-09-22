import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadVault } from '../adapters/fs';
import type { FileEntry } from './model';
import {
  bottomLevel,
  CARD_FIELDS,
  chipLevelLabel,
  DEFAULT_LEVELS,
  type GeneralSettings,
  type Level,
  type ProjectSettings,
  parseLinkKindList,
  removableLevels,
  resolveCardFields,
  resolveColumns,
  resolveLinkKinds,
  resolveProjectSettings,
  settingsFor,
  slugifyStatus,
} from './settings';

const here = dirname(fileURLToPath(import.meta.url));
const VAULT = join(here, '../../../fixtures/vault');

const GENERAL: GeneralSettings = {
  columns: ['Backlog', 'Ready', 'Doing', 'Done', "Won't Do"],
  doneColumns: ['Done', "Won't Do"],
};

function fixtureProject(key: string): ProjectSettings {
  const { projects } = resolveProjectSettings(loadVault(VAULT).entries);
  const project = projects.find((p) => p.key === key);
  if (!project) throw new Error(`Projekt ${key} nicht in den Fixtures`);
  return project;
}

describe('K1 general columns for a project without its own', () => {
  it('delivers exactly the five general columns in this order', () => {
    const columns = resolveColumns(GENERAL, fixtureProject('nimbus'));
    expect(columns.map((c) => c.name)).toEqual(['Backlog', 'Ready', 'Doing', 'Done', "Won't Do"]);
  });
});

describe('K2 project-specific columns override the general ones', () => {
  it('delivers the four columns of the project, not the general ones', () => {
    const columns = resolveColumns(GENERAL, fixtureProject('vortrag'));
    expect(columns.map((c) => c.name)).toEqual(['Todo', 'Doing', 'Review', 'Done']);
  });
});

describe('K3 status slug from the display name', () => {
  it("macht aus 'Won’t Do' den Slug 'wont-do'", () => {
    expect(slugifyStatus('Won’t Do')).toBe('wont-do');
  });

  it('lowercases uppercase letters, removes apostrophe, replaces non-alphanumeric with -', () => {
    expect(slugifyStatus('Backlog')).toBe('backlog');
    expect(slugifyStatus("It's Ready!")).toBe('its-ready');
    expect(slugifyStatus('In Review')).toBe('in-review');
  });
});

describe('K4 completion marker of the columns', () => {
  it('marks exactly Done and Won’t Do as completed', () => {
    const columns = resolveColumns(GENERAL, fixtureProject('quarz'));
    const done = columns.filter((c) => c.done).map((c) => c.status);
    expect(done).toEqual(['done', 'wont-do']);
    expect(columns.filter((c) => !c.done).map((c) => c.status)).toEqual([
      'backlog',
      'ready',
      'doing',
    ]);
  });
});

describe('K5 project note at any path', () => {
  it('recognizes ktm_project regardless of path', () => {
    const entry: FileEntry = {
      path: '99_weird/x.md',
      frontmatter: { ktm_project: 'weird', ktm_root: 'anywhere' },
      body: '',
    };
    const { projects } = resolveProjectSettings([entry]);
    expect(projects.map((p) => p.key)).toEqual(['weird']);
    expect(projects[0].root).toBe('anywhere');
  });
});

const DUPLICATE: FileEntry[] = [
  {
    path: '02_Projects/B/_Kanban.md',
    frontmatter: { ktm_project: 'dup', ktm_name: 'Pfad-zweite', ktm_root: 'B/Deliverables' },
    body: '',
  },
  {
    path: '02_Projects/A/_Kanban.md',
    frontmatter: { ktm_project: 'dup', ktm_name: 'Pfad-erste', ktm_root: 'A/Deliverables' },
    body: '',
  },
];

describe('K6 two notes with the same ktm_project', () => {
  it('takes the values of the path-first note', () => {
    const { projects } = resolveProjectSettings(DUPLICATE);
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('Pfad-erste');
    expect(projects[0].root).toBe('A/Deliverables');
    expect(projects[0].path).toBe('02_Projects/A/_Kanban.md');
  });
});

describe('K7 duplicate is reported as a notice', () => {
  it('names the path of the second note', () => {
    const { notices } = resolveProjectSettings(DUPLICATE);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('02_Projects/B/_Kanban.md');
  });
});

describe('F031 K8 resolveLinkKinds', () => {
  it('delivers the standard list note before ADR without linkKinds', () => {
    expect(resolveLinkKinds()).toEqual([
      { key: 'notes', label: 'Notiz', icon: 'file-text' },
      { key: 'adr', label: 'ADR', icon: 'scale', prefix: 'ADR_' },
    ]);
  });

  it('delivers the configured kinds in file order with their icons', () => {
    const linkKinds = [
      { key: 'adr', label: 'ADR', icon: 'gavel' },
      { key: 'notes', label: 'Notiz', icon: 'sticky-note' },
    ];
    expect(resolveLinkKinds({ linkKinds })).toEqual([
      { key: 'adr', label: 'ADR', icon: 'gavel' },
      { key: 'notes', label: 'Notiz', icon: 'sticky-note' },
    ]);
  });
});

describe('F042 resolveLinkKinds hardening', () => {
  it('discards entries with invalid key format', () => {
    const linkKinds = [
      { key: 'Notes', label: 'Notiz', icon: 'file-text' },
      { key: '1adr', label: 'ADR', icon: 'scale' },
      { key: 'protocol', label: 'Protokoll', icon: 'clipboard-list' },
    ];
    expect(resolveLinkKinds({ linkKinds })).toEqual([
      { key: 'protocol', label: 'Protokoll', icon: 'clipboard-list' },
    ]);
  });

  it('keeps only the first entry on a duplicate key', () => {
    const linkKinds = [
      { key: 'adr', label: 'ADR', icon: 'scale' },
      { key: 'adr', label: 'Zweitfassung', icon: 'gavel' },
    ];
    expect(resolveLinkKinds({ linkKinds })).toEqual([{ key: 'adr', label: 'ADR', icon: 'scale' }]);
  });

  it('falls back to note before ADR when all entries are invalid', () => {
    expect(resolveLinkKinds({ linkKinds: [{ key: 'BAD', label: 'x', icon: 'y' }] })).toEqual([
      { key: 'notes', label: 'Notiz', icon: 'file-text' },
      { key: 'adr', label: 'ADR', icon: 'scale', prefix: 'ADR_' },
    ]);
  });
});

describe('F040 K3 resolveCardFields', () => {
  it('delivers all eight fields in fixed order without cardFields', () => {
    expect(resolveCardFields()).toEqual([...CARD_FIELDS]);
    expect(resolveCardFields({})).toEqual([...CARD_FIELDS]);
  });

  it('delivers a valid subset in fixed order', () => {
    expect(resolveCardFields({ cardFields: ['tags', 'due'] })).toEqual(['due', 'tags']);
  });

  it('discards unknown entries', () => {
    expect(resolveCardFields({ cardFields: ['due', 'unfug'] as never })).toEqual(['due']);
  });

  it('falls back to all eight fields on empty list', () => {
    expect(resolveCardFields({ cardFields: [] })).toEqual([...CARD_FIELDS]);
  });
});

const DANGLING_DONE: FileEntry[] = [
  {
    path: '02_Projects/Schief/_Kanban.md',
    frontmatter: {
      ktm_project: 'schief',
      ktm_name: 'Schief',
      ktm_root: 'Schief/Deliverables',
      ktm_columns: ['Backlog', 'Doing', 'Done'],
      ktm_done_columns: ['Done', 'Erledigt'],
    },
    body: '',
  },
  {
    path: '02_Projects/Sauber/_Kanban.md',
    frontmatter: {
      ktm_project: 'sauber',
      ktm_name: 'Sauber',
      ktm_root: 'Sauber/Deliverables',
      ktm_columns: ['Backlog', 'Doing', 'Done'],
      ktm_done_columns: ['Done'],
    },
    body: '',
  },
];

describe('F016 K7 ktm_done_columns outside ktm_columns', () => {
  it('reports the note and the misplaced name exactly once', () => {
    const { notices } = resolveProjectSettings(DANGLING_DONE);
    const dangling = notices.filter((n) => n.includes('Erledigt'));
    expect(dangling).toHaveLength(1);
    expect(dangling[0]).toContain('02_Projects/Schief/_Kanban.md');
  });

  it('leaves the remaining projects in the list', () => {
    const { projects } = resolveProjectSettings(DANGLING_DONE);
    expect(projects.map((p) => p.key).sort()).toEqual(['sauber', 'schief']);
  });
});

const LEVELS_ENTRY: FileEntry = {
  path: '02_Projects/Nimbus/_Kanban.md',
  frontmatter: {
    ktm_project: 'nimbus',
    ktm_name: 'Nimbus',
    ktm_root: '02_Projects/Nimbus/Deliverables',
    ktm_levels: [
      'epic | Epic | layers',
      'feature | Feature | box',
      'story | User Story | book-open',
      'task | Task | square',
    ],
  },
  body: '',
};

describe('F048 K1 flat level encoding of the project note', () => {
  it('delivers four levels in list order with key, name and icon', () => {
    const { projects } = resolveProjectSettings([LEVELS_ENTRY]);
    const settings = settingsFor(GENERAL, projects[0]);
    expect(settings.levels).toEqual([
      { key: 'epic', name: 'Epic', icon: 'layers' },
      { key: 'feature', name: 'Feature', icon: 'box' },
      { key: 'story', name: 'User Story', icon: 'book-open' },
      { key: 'task', name: 'Task', icon: 'square' },
    ]);
  });
});

describe('F048 K2 doneLimit falls back to the general value without its own', () => {
  it('takes the levels from the note, the doneLimit from data.json', () => {
    const general: GeneralSettings = { ...GENERAL, doneLimit: 5 };
    const { projects } = resolveProjectSettings([LEVELS_ENTRY]);
    const settings = settingsFor(general, projects[0]);
    expect(settings.levels).toHaveLength(4);
    expect(settings.doneLimit).toBe(5);
  });
});

describe('F048 K3 general-only keys remain general', () => {
  it('never reads ktm_ribbon, the general ribbon value applies unchanged', () => {
    const entry: FileEntry = {
      path: '02_Projects/Nimbus/_Kanban.md',
      frontmatter: {
        ktm_project: 'nimbus',
        ktm_name: 'Nimbus',
        ktm_root: '02_Projects/Nimbus/Deliverables',
        ktm_ribbon: false,
      },
      body: '',
    };
    const general: GeneralSettings = { ...GENERAL, ribbon: true };
    const { projects } = resolveProjectSettings([entry]);
    const settings = settingsFor(general, projects[0]);
    expect(settings.ribbon).toBe(true);
  });
});

describe('F048 K4 ktm_levels with wrong separator', () => {
  const entry: FileEntry = {
    path: '02_Projects/Nimbus/_Kanban.md',
    frontmatter: {
      ktm_project: 'nimbus',
      ktm_name: 'Nimbus',
      ktm_root: '02_Projects/Nimbus/Deliverables',
      ktm_levels: ['epic Epic layers'],
      ktm_columns: ['Backlog', 'Doing', 'Done'],
    },
    body: '',
  };

  it('falls back to general levels but takes ktm_columns', () => {
    const { projects } = resolveProjectSettings([entry]);
    const settings = settingsFor(GENERAL, projects[0]);
    expect(settings.levels).toEqual(DEFAULT_LEVELS);
    expect(settings.columns.map((c) => c.name)).toEqual(['Backlog', 'Doing', 'Done']);
  });

  it('reports the note and the key name ktm_levels', () => {
    const { notices } = resolveProjectSettings([entry]);
    const notice = notices.find((n) => n.includes('ktm_levels'));
    expect(notice).toBeDefined();
    expect(notice).toContain(entry.path);
  });
});

describe('F057 K2/K4 bottomLevel and removableLevels', () => {
  it('bottomLevel delivers the last level of the list', () => {
    expect(bottomLevel(DEFAULT_LEVELS)?.key).toBe('task');
  });

  it('removableLevels delivers all levels except the bottom one', () => {
    expect(removableLevels(DEFAULT_LEVELS).map((l) => l.key)).toEqual(['epic', 'feature']);
  });

  it('removableLevels is empty when only one level exists', () => {
    const one: Level[] = [{ key: 'task', name: 'Task', icon: 'square' }];
    expect(removableLevels(one)).toEqual([]);
  });
});

describe('F057 K3 chipLevelLabel', () => {
  it('joins two level names with German ellipsis ("Epic- und Feature-Chips")', () => {
    expect(chipLevelLabel(DEFAULT_LEVELS)).toBe('Kurzname in Epic- und Feature-Chips');
  });

  it('follows a rename without changing the key', () => {
    const renamed: Level[] = [
      { key: 'epic', name: 'Initiative', icon: 'layers' },
      { key: 'feature', name: 'Feature', icon: 'box' },
      { key: 'task', name: 'Task', icon: 'square' },
    ];
    expect(chipLevelLabel(renamed)).toBe('Kurzname in Initiative- und Feature-Chips');
  });

  it('lists three level names before the bottom one with comma and "and"', () => {
    const four: Level[] = [
      { key: 'epic', name: 'Epic', icon: 'layers' },
      { key: 'feature', name: 'Feature', icon: 'box' },
      { key: 'story', name: 'User Story', icon: 'book-open' },
      { key: 'task', name: 'Task', icon: 'square' },
    ];
    expect(chipLevelLabel(four)).toBe('Kurzname in Epic-, Feature- und User Story-Chips');
  });

  it('names only one level when exactly two levels exist', () => {
    const two: Level[] = [
      { key: 'epic', name: 'Epic', icon: 'layers' },
      { key: 'task', name: 'Task', icon: 'square' },
    ];
    expect(chipLevelLabel(two)).toBe('Kurzname in Epic-Chips');
  });
});

describe('F052 parseLinkKindList flat link kind encoding', () => {
  it('parses key, label, icon and optional prefix in list order', () => {
    expect(
      parseLinkKindList(['notes | Notiz | file-text', 'adr | ADR | scale | ADR_']),
    ).toEqual([
      { key: 'notes', label: 'Notiz', icon: 'file-text' },
      { key: 'adr', label: 'ADR', icon: 'scale', prefix: 'ADR_' },
    ]);
  });

  it('delivers null on wrong separator, invalid key or duplicate', () => {
    expect(parseLinkKindList(['notes Notiz file-text'])).toBeNull();
    expect(parseLinkKindList(['1notes | Notiz | file-text'])).toBeNull();
    expect(parseLinkKindList(['notes | Notiz | file-text', 'notes | Zweit | scale'])).toBeNull();
  });

  it('delivers null for an empty or missing list', () => {
    expect(parseLinkKindList(undefined)).toBeNull();
    expect(parseLinkKindList([])).toBeNull();
  });
});

const LINK_KINDS_ENTRY: FileEntry = {
  path: '02_Projects/Nimbus/_Kanban.md',
  frontmatter: {
    ktm_project: 'nimbus',
    ktm_name: 'Nimbus',
    ktm_root: '02_Projects/Nimbus/Deliverables',
    ktm_link_kinds: ['notes | Notiz | file-text', 'protocol | Protokoll | clipboard-list'],
  },
  body: '',
};

describe('F052 K5 ktm_link_kinds of the project note', () => {
  it('settingsFor delivers the project-specific link kinds instead of the general ones', () => {
    const { projects } = resolveProjectSettings([LINK_KINDS_ENTRY]);
    const settings = settingsFor(GENERAL, projects[0]);
    expect(settings.linkKinds).toEqual([
      { key: 'notes', label: 'Notiz', icon: 'file-text' },
      { key: 'protocol', label: 'Protokoll', icon: 'clipboard-list' },
    ]);
  });

  it('a project without ktm_link_kinds falls back to the general ones', () => {
    const project = fixtureProject('quarz');
    expect(settingsFor(GENERAL, project).linkKinds).toEqual(resolveLinkKinds());
  });

  it('reports an invalid list and falls back to the general kinds', () => {
    const entry: FileEntry = {
      ...LINK_KINDS_ENTRY,
      frontmatter: { ...LINK_KINDS_ENTRY.frontmatter, ktm_link_kinds: ['notes Notiz file-text'] },
    };
    const { projects, notices } = resolveProjectSettings([entry]);
    expect(settingsFor(GENERAL, projects[0]).linkKinds).toEqual(resolveLinkKinds());
    const notice = notices.find((n) => n.includes('ktm_link_kinds'));
    expect(notice).toBeDefined();
    expect(notice).toContain(entry.path);
  });
});
