import { describe, expect, it } from 'vitest';
import {
  adrTarget,
  atomicNotePath,
  baseName,
  embedAtomicTarget,
  linkFolder,
  nestedPaths,
  noteContent,
  noteTarget,
  renameTarget,
  slugify,
  uniqueName,
} from './create';

describe('slugify', () => {
  it('lower-cases and hyphenates a title', () => {
    expect(slugify('Steffi morgen anrufen')).toBe('steffi-morgen-anrufen');
  });

  it('drops apostrophes and collapses runs of punctuation', () => {
    expect(slugify("Won't Do — jetzt!")).toBe('wont-do-jetzt');
  });

  it('keeps umlauts and trims stray hyphens', () => {
    expect(slugify('  Fällig heute  ')).toBe('fällig-heute');
  });
});

describe('nested paths', () => {
  it('places folder and _-note below the parent by convention', () => {
    const { folder, note } = nestedPaths(
      '02_Projects/Nimbus/Deliverables',
      'Neue Aufgabe',
      '2026-09-09',
    );
    expect(folder).toBe('02_Projects/Nimbus/Deliverables/2026-09-09_neue-aufgabe');
    expect(note).toBe(
      '02_Projects/Nimbus/Deliverables/2026-09-09_neue-aufgabe/_2026-09-09_neue-aufgabe.md',
    );
  });

  it('nests below an epic folder', () => {
    const { note } = nestedPaths(
      '02_Projects/Nimbus/Deliverables/2026-05-04_pb',
      'Datenaufnahme stabilisieren',
      '2026-09-09',
    );
    expect(note).toBe(
      '02_Projects/Nimbus/Deliverables/2026-05-04_pb/2026-09-09_datenaufnahme-stabilisieren/_2026-09-09_datenaufnahme-stabilisieren.md',
    );
  });
});

describe('atomic note path', () => {
  it('is a single note in _Tasks/Atomic with no folder', () => {
    expect(atomicNotePath('Steffi morgen anrufen', '2026-09-09')).toBe(
      '_Tasks/Atomic/2026-09-09_steffi-morgen-anrufen.md',
    );
  });
});

describe('noteContent', () => {
  it('writes type, title and status without a ticket', () => {
    const out = noteContent({ type: 'task', title: 'Neue Aufgabe', status: 'backlog' });
    expect(out).toBe('---\ntype: task\ntitle: Neue Aufgabe\nstatus: backlog\n---\n');
    expect(out).not.toMatch(/ticket/);
  });

  it('adds project only when given', () => {
    expect(noteContent({ type: 'feature', title: 'X', status: 'doing' })).not.toMatch(/project/);
    expect(noteContent({ type: 'task', title: 'X', status: 'backlog', project: 'nimbus' })).toMatch(
      /\nproject: nimbus\n/,
    );
  });
});

describe('embedAtomicTarget', () => {
  it('keeps the base name and turns the note into a folder with a _-note', () => {
    const { folder, note } = embedAtomicTarget(
      '_Tasks/Atomic/2026-09-04_angebot-workshop.md',
      '02_Projects/Nimbus/Deliverables/2026-05-04_pb/2026-08-11_da',
    );
    expect(folder).toBe(
      '02_Projects/Nimbus/Deliverables/2026-05-04_pb/2026-08-11_da/2026-09-04_angebot-workshop',
    );
    expect(note).toBe(
      '02_Projects/Nimbus/Deliverables/2026-05-04_pb/2026-08-11_da/2026-09-04_angebot-workshop/_2026-09-04_angebot-workshop.md',
    );
  });
});

describe('baseName', () => {
  it('joins the date and the slug', () => {
    expect(baseName('Neue Aufgabe', '2026-09-09')).toBe('2026-09-09_neue-aufgabe');
  });
});

describe('F031 K2 renameTarget', () => {
  it('keeps the date, only the slug follows the new title', () => {
    expect(
      renameTarget('2026-09-02_folien/_2026-09-02_folien.md', 'Folien fuers Meetup bauen'),
    ).toEqual({
      folder: '2026-09-02_folien-fuers-meetup-bauen',
      note: '2026-09-02_folien-fuers-meetup-bauen/_2026-09-02_folien-fuers-meetup-bauen.md',
    });
  });

  it('keeps date and ticket prefix', () => {
    expect(
      renameTarget(
        '2026-06-09_OVB-1234_tooltip/_2026-06-09_OVB-1234_tooltip.md',
        'Tooltip verbessern',
      ),
    ).toEqual({
      folder: '2026-06-09_OVB-1234_tooltip-verbessern',
      note: '2026-06-09_OVB-1234_tooltip-verbessern/_2026-06-09_OVB-1234_tooltip-verbessern.md',
    });
  });

  it('renames an atomic task as a file only, without folder', () => {
    expect(renameTarget('_Tasks/Atomic/2026-09-10_steffi.md', 'Steffi anrufen')).toEqual({
      note: '_Tasks/Atomic/2026-09-10_steffi-anrufen.md',
    });
  });
});

describe('F031 K3 uniqueName', () => {
  it('appends -2 when the base is already taken', () => {
    expect(uniqueName('2026-09-14_abnahme', new Set(['2026-09-14_abnahme']))).toBe(
      '2026-09-14_abnahme-2',
    );
  });

  it('assigns -3 when -2 is also taken', () => {
    expect(
      uniqueName('2026-09-14_abnahme', new Set(['2026-09-14_abnahme', '2026-09-14_abnahme-2'])),
    ).toBe('2026-09-14_abnahme-3');
  });

  it('leaves a free base unchanged', () => {
    expect(uniqueName('2026-09-14_abnahme', new Set())).toBe('2026-09-14_abnahme');
  });
});

describe('F031 K6 adrTarget and noteTarget', () => {
  it('creates an ADR file with skeleton in the element folder', () => {
    const { path, content } = adrTarget('X', 'Speicherformat', '2026-09-14');
    expect(path).toBe('X/ADR_2026-09-14_speicherformat.md');
    expect(content).toBe('# Speicherformat\n\n## Kontext\n\n## Entscheidung\n\n## Folgen\n');
  });

  it('names a new note by its title, without prefix', () => {
    expect(noteTarget('X', 'Messprotokoll')).toBe('X/Messprotokoll.md');
  });
});

describe('F031 K7 attachments of an atomic task reside in _Tasks/Notes', () => {
  const folder = linkFolder('_Tasks/Atomic/2026-09-10_steffi.md');

  it('places Rueckruf note in _Tasks/Notes', () => {
    expect(noteTarget(folder, 'Rueckruf')).toBe('_Tasks/Notes/Rueckruf.md');
  });

  it('places the ADR in _Tasks/Notes', () => {
    expect(adrTarget(folder, 'Rueckruf', '2026-09-14').path).toBe(
      '_Tasks/Notes/ADR_2026-09-14_rueckruf.md',
    );
  });

  it('places no path under _Tasks/Atomic', () => {
    expect(noteTarget(folder, 'Rueckruf').startsWith('_Tasks/Atomic/')).toBe(false);
    expect(adrTarget(folder, 'Rueckruf', '2026-09-14').path.startsWith('_Tasks/Atomic/')).toBe(
      false,
    );
  });

  it('places attachments of a nested element in its own folder', () => {
    const nested = linkFolder(
      '02_Projects/Nimbus/Deliverables/2026-09-01_pipeline/_2026-09-01_pipeline.md',
    );
    expect(noteTarget(nested, 'Messreihe')).toBe(
      '02_Projects/Nimbus/Deliverables/2026-09-01_pipeline/Messreihe.md',
    );
  });
});
