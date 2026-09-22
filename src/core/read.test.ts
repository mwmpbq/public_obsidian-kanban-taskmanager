import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadVault } from '../adapters/fs';
import type { BoardElement, FileEntry } from './model';
import { read, readElements } from './read';

const here = dirname(fileURLToPath(import.meta.url));
const VAULT = join(here, '../../../fixtures/vault');

const PIPELINE_FOLDER =
  '02_Projects/Nimbus/Deliverables/2026-05-04_pb/2026-08-11_da/2026-09-01_pipeline-fehler-bei-leeren-dateien';

let model: BoardElement[];

beforeAll(() => {
  const { entries, roots } = loadVault(VAULT);
  model = read(entries, roots);
});

function inFolder(folder: string): BoardElement[] {
  return model.filter((e) => e.paths.note.startsWith(folder + '/'));
}

function byNote(suffix: string): BoardElement | undefined {
  return model.find((e) => e.paths.note.endsWith(suffix));
}

describe('K1 task folder with _-note', () => {
  it('creates exactly one task element, title from the note', () => {
    const cards = inFolder(PIPELINE_FOLDER);
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('task');
    expect(cards[0].title).toBe('Pipeline-Fehler bei leeren Dateien beheben');
  });
});

describe('K2 other files in folder', () => {
  it('does not create element for script, CSV or second note without type', () => {
    const cards = inFolder(PIPELINE_FOLDER);
    expect(cards).toHaveLength(1);
    for (const extra of ['analyse.md', 'daten.csv', 'skript.py']) {
      expect(model.some((e) => e.paths.note.endsWith('/' + extra))).toBe(false);
    }
  });
});

describe('K3 task directly under the root folder', () => {
  it('has empty parent chain and the project derived from the root path', () => {
    const card = byNote('2026-09-08_abnahmetermin/_2026-09-08_abnahmetermin.md');
    expect(card).toBeDefined();
    expect(card!.parents).toEqual([]);
    expect(card!.project).toBe('nimbus');
  });
});

describe('K4 epic and feature without task', () => {
  it('does not create element for epic or feature', () => {
    expect(model.every((e) => e.type === 'task')).toBe(true);
    expect(byNote('_2026-05-04_pb.md')).toBeUndefined();
    expect(byNote('_2026-08-11_da.md')).toBeUndefined();
  });

  it('returns empty when only epic and feature without task are present', () => {
    const roots = [{ key: 'demo', root: 'root' }];
    const entries: FileEntry[] = [
      {
        path: 'root/epic/_epic.md',
        frontmatter: { type: 'epic', title: 'Ein Epic', status: 'doing' },
        body: '',
      },
      {
        path: 'root/epic/feature/_feature.md',
        frontmatter: { type: 'feature', title: 'Ein Feature', status: 'doing' },
        body: '',
      },
    ];
    expect(read(entries, roots)).toEqual([]);
  });
});

describe('K5 parent chain from folder hierarchy', () => {
  it('knows feature before epic, without parent field in the note', () => {
    const card = inFolder(PIPELINE_FOLDER)[0];
    expect(card.parents).toEqual([
      {
        type: 'feature',
        title: 'Datenaufnahme stabilisieren',
        note: '02_Projects/Nimbus/Deliverables/2026-05-04_pb/2026-08-11_da/_2026-08-11_da.md',
      },
      {
        type: 'epic',
        title: 'Plattform-Betrieb',
        note: '02_Projects/Nimbus/Deliverables/2026-05-04_pb/_2026-05-04_pb.md',
      },
    ]);
  });
});

describe('K6 atomic task with project', () => {
  it('assigns a dedicated ovb-task without parent to the ovb project', () => {
    const entry: FileEntry = {
      path: '_Tasks/Atomic/2026-09-12_steffi-anrufen.md',
      frontmatter: { type: 'task', status: 'doing', project: 'ovb' },
      body: '',
    };
    const cards = read([entry], []);
    expect(cards).toHaveLength(1);
    expect(cards[0].form).toBe('atomic');
    expect(cards[0].project).toBe('ovb');
    expect(cards[0].parents).toEqual([]);
  });

  it('occupies the same code path in the existing atomic quarz note', () => {
    const card = byNote('_Tasks/Atomic/2026-09-08_ladezeit-startseite.md');
    expect(card).toBeDefined();
    expect(card!.form).toBe('atomic');
    expect(card!.project).toBe('quarz');
    expect(card!.parents).toEqual([]);
  });
});

describe('F016 K5 invalid note without type/status', () => {
  it('emits for a Deliverables-_-note without type an invalid element with filename as title', () => {
    const entry: FileEntry = {
      path: '02_Projects/Nimbus/Deliverables/2026-09-01_kaputt/_2026-09-01_kaputt.md',
      frontmatter: { priority: 2 },
      body: 'Ohne type und status.',
    };
    const cards = read([entry], NIMBUS_ROOT);
    expect(cards).toHaveLength(1);
    expect(cards[0].invalid).toBe(true);
    expect(cards[0].title).toBe('_2026-09-01_kaputt');
  });

  it('treats the atomic broken-note of the fixtures as invalid', () => {
    const card = byNote('_Tasks/Atomic/2026-09-01_kaputte-notiz.md');
    expect(card).toBeDefined();
    expect(card!.invalid).toBe(true);
    expect(card!.title).toBe('2026-09-01_kaputte-notiz');
  });

  it('makes a _-note with type but without status into an invalid card', () => {
    const cards = read([nimbusNote('2026-09-01_ohne-status', { type: 'task' })], NIMBUS_ROOT);
    expect(cards).toHaveLength(1);
    expect(cards[0].invalid).toBe(true);
    expect(cards[0].title).toBe('_2026-09-01_ohne-status');
  });

  it('makes a _-note with empty status into an invalid card', () => {
    const cards = read(
      [nimbusNote('2026-09-01_leerer-status', { type: 'task', status: '' })],
      NIMBUS_ROOT,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].invalid).toBe(true);
  });
});

describe('K7 Archive is ignored', () => {
  it('creates no element below Archive and no error', () => {
    expect(model.some((e) => e.paths.note.includes('/Archive/'))).toBe(false);
  });
});

describe('K8 task in Done mirror', () => {
  it('derives the parent chain from the folder names in the Done mirror', () => {
    const card = byNote('2026-08-28_staging-zugriff/_2026-08-28_staging-zugriff.md');
    expect(card).toBeDefined();
    expect(card!.paths.note).toContain('/Done/');
    expect(card!.parents).toEqual([
      {
        type: 'feature',
        title: 'Datenaufnahme stabilisieren',
        note: '02_Projects/Nimbus/Deliverables/2026-05-04_pb/2026-08-11_da/_2026-08-11_da.md',
      },
      {
        type: 'epic',
        title: 'Plattform-Betrieb',
        note: '02_Projects/Nimbus/Deliverables/2026-05-04_pb/_2026-05-04_pb.md',
      },
    ]);
  });
});

describe('F031 K1 free links with kind and target in file order', () => {
  const withLinks = () =>
    nimbusNote('2026-09-01_mit-links', {
      type: 'task',
      status: 'doing',
      notes: ['[[Wochenplan]]', '[[Messprotokoll]]'],
      adr: ['[[ADR_2026-09-10_parser-strategie]]'],
    });
  const EXPECTED = [
    { kind: 'notes', target: 'Wochenplan' },
    { kind: 'notes', target: 'Messprotokoll' },
    { kind: 'adr', target: 'ADR_2026-09-10_parser-strategie' },
  ];

  it('reads notes before adr in list order; a note without the fields has none', () => {
    const without = nimbusNote('2026-09-02_ohne-links', { type: 'task', status: 'doing' });
    const cards = read([withLinks(), without], NIMBUS_ROOT);
    const mit = cards.find((c) => c.paths.note.includes('mit-links'));
    const ohne = cards.find((c) => c.paths.note.includes('ohne-links'));
    expect(mit?.links).toEqual(EXPECTED);
    expect(ohne?.links).toEqual([]);
  });

  it('returns the same order via readElements', () => {
    const els = readElements([withLinks()], NIMBUS_ROOT);
    expect(els[0].links).toEqual(EXPECTED);
  });
});

describe('F052 per-Projekt linkKindsFor', () => {
  const QUARZ_ROOT = [
    { key: 'nimbus', root: '02_Projects/Nimbus/Deliverables' },
    { key: 'quarz', root: '02_Projects/Quarz/Deliverables' },
  ];
  const quarzNote = (slug: string, frontmatter: Record<string, unknown>): FileEntry => ({
    path: `02_Projects/Quarz/Deliverables/${slug}/_${slug}.md`,
    frontmatter,
    body: '',
  });

  it('parses a protocol-link on nimbus, but not on quarz', () => {
    const nimbusEntry = nimbusNote('2026-09-01_mit-protocol', {
      type: 'task',
      status: 'doing',
      protocol: ['[[Messreihe Q3]]'],
    });
    const quarzEntry = quarzNote('2026-09-01_mit-protocol', {
      type: 'task',
      status: 'doing',
      protocol: ['[[Messreihe Q3]]'],
    });
    const linkKindsFor = (project: string) =>
      project === 'nimbus'
        ? [{ key: 'protocol', label: 'Protokoll', icon: 'clipboard-list' }]
        : [{ key: 'notes', label: 'Notiz', icon: 'file-text' }];
    const els = readElements([nimbusEntry, quarzEntry], QUARZ_ROOT, linkKindsFor);
    const nimbus = els.find((e) => e.paths.note === nimbusEntry.path);
    const quarz = els.find((e) => e.paths.note === quarzEntry.path);
    expect(nimbus?.links).toEqual([{ kind: 'protocol', target: 'Messreihe Q3' }]);
    expect(quarz?.links).toEqual([]);
  });
});

const NIMBUS_ROOT = [{ key: 'nimbus', root: '02_Projects/Nimbus/Deliverables' }];

function nimbusNote(
  slug: string,
  frontmatter: Record<string, unknown>,
  body = '',
): FileEntry {
  return {
    path: `02_Projects/Nimbus/Deliverables/${slug}/_${slug}.md`,
    frontmatter,
    body,
  };
}

describe('F002 K1 all fields unchanged', () => {
  it('takes title, status, project, priority, planned, due, ticket, summary, tags byte-identical', () => {
    const fm = {
      type: 'task',
      title: 'Tooltip verbessern',
      status: 'doing',
      project: 'ovb',
      priority: 2,
      planned: '2026-09-10',
      due: '2026-09-12',
      ticket: 1234,
      summary: 'Tooltip im Radar-Chart zeigt Rohwerte statt Prozent.',
      tags: ['st/termin', 'd/angebot'],
    };
    const cards = read([nimbusNote('2026-06-09_tooltip', fm)], NIMBUS_ROOT);
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.title).toBe(fm.title);
    expect(card.status).toBe(fm.status);
    expect(card.project).toBe(fm.project);
    expect(card.priority).toBe(fm.priority);
    expect(card.planned).toBe(fm.planned);
    expect(card.due).toBe(fm.due);
    expect(card.ticket).toBe(fm.ticket);
    expect(card.summary).toBe(fm.summary);
    expect(card.tags).toEqual(fm.tags);
  });
});

describe('F002 K2 title from H1', () => {
  it('takes the first H1 of the text when title field is missing', () => {
    const cards = read(
      [nimbusNote('2026-06-09_ohne-titel', { type: 'task', status: 'doing' }, '# Titel aus H1\n\nText.')],
      NIMBUS_ROOT,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('Titel aus H1');
  });
});

describe('F002 K3 title from filename without date prefix', () => {
  it('falls back to the folder name without date when no title and no H1', () => {
    const cards = read(
      [nimbusNote('2026-09-01_beispiel-task', { type: 'task', status: 'doing' }, 'Nur Text, keine Ueberschrift.')],
      NIMBUS_ROOT,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('beispiel-task');
  });
});

describe('F002 K4 project from note takes precedence', () => {
  it('takes project from frontmatter instead of from the root path', () => {
    const cards = read(
      [nimbusNote('2026-06-09_abweichend', { type: 'task', status: 'doing', project: 'quarz' })],
      NIMBUS_ROOT,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].project).toBe('quarz');
  });
});

describe('F002 K5 default priority', () => {
  it('sets priority 3 when the field is missing', () => {
    const cards = read(
      [nimbusNote('2026-06-09_ohne-prio', { type: 'task', status: 'doing' })],
      NIMBUS_ROOT,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].priority).toBe(3);
  });
});

describe('F002 K6 checkbox progress', () => {
  it('counts five checkbox lines, of which two checked', () => {
    const card = inFolder(PIPELINE_FOLDER)[0];
    expect(card.checklist).toEqual({ done: 2, total: 5 });
  });
});

describe('F002 K7 checkbox lines are not elements', () => {
  it('creates exactly one element for the folder, none from a checkbox line', () => {
    const cards = inFolder(PIPELINE_FOLDER);
    expect(cards).toHaveLength(1);
    expect(model.every((e) => !e.paths.note.includes('['))).toBe(true);
  });
});
