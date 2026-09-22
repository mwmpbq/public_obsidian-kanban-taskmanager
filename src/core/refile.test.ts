import { describe, expect, it } from 'vitest';
import type { BoardElement } from './model';
import { planRefile, type RefileElement } from './refile';

function child(parentNote: string, title = 'Kind-Task'): BoardElement {
  return {
    type: 'task',
    form: 'nested',
    title,
    status: 'doing',
    priority: 3,
    tags: [],
    parents: [{ type: 'feature', title: 'Elternfeature', note: parentNote }],
    links: [],
    paths: { note: `X/${title}/_${title}.md`, folder: `X/${title}` },
  };
}

describe('F034 K1 rename title', () => {
  it('moves folder and note by the new title, in the same parent folder', () => {
    const element: RefileElement = {
      form: 'nested',
      type: 'task',
      notePath: '03_Areas/Internal/Vortraege/Deliverables/2026-09-02_folien/_2026-09-02_folien.md',
      folderPath: '03_Areas/Internal/Vortraege/Deliverables/2026-09-02_folien',
    };
    const plan = planRefile(element, { title: 'Folien fuers Meetup bauen' }, []);
    expect(plan.move).toEqual({
      from: '03_Areas/Internal/Vortraege/Deliverables/2026-09-02_folien',
      to: '03_Areas/Internal/Vortraege/Deliverables/2026-09-02_folien-fuers-meetup-bauen',
      parent: '03_Areas/Internal/Vortraege/Deliverables',
    });
    expect(plan.notePath).toBe(
      '03_Areas/Internal/Vortraege/Deliverables/2026-09-02_folien-fuers-meetup-bauen/_2026-09-02_folien-fuers-meetup-bauen.md',
    );
    expect(plan.frontmatter).toEqual({ title: 'Folien fuers Meetup bauen' });
    expect(plan.notice).toBeUndefined();
  });

  it('appends -2 when the new name is already taken at the target location', () => {
    const element: RefileElement = {
      form: 'nested',
      type: 'task',
      notePath: 'X/2026-09-02_a/_2026-09-02_a.md',
      folderPath: 'X/2026-09-02_a',
    };
    const plan = planRefile(element, { title: 'B' }, [], ['2026-09-02_b']);
    expect(plan.move?.to).toBe('X/2026-09-02_b-2');
  });
});

describe('F034 K2 atomic project', () => {
  it('writes project without moving the task', () => {
    const element: RefileElement = {
      form: 'atomic',
      type: 'task',
      notePath: '_Tasks/Atomic/2026-09-08_ladezeit-startseite.md',
    };
    const plan = planRefile(element, { project: 'quarz' }, []);
    expect(plan.move).toBeUndefined();
    expect(plan.frontmatter).toEqual({ project: 'quarz' });
    expect(plan.notePath).toBe(element.notePath);
  });
});

describe('F034 K3 project of a nested task', () => {
  it('moves to the root of the new project, without frontmatter field', () => {
    const element: RefileElement = {
      form: 'nested',
      type: 'task',
      notePath:
        '02_Projects/Nimbus/Deliverables/2026-05-04_pb/2026-08-11_da/2026-09-01_pipeline-fehler-bei-leeren-dateien/_2026-09-01_pipeline-fehler-bei-leeren-dateien.md',
      folderPath:
        '02_Projects/Nimbus/Deliverables/2026-05-04_pb/2026-08-11_da/2026-09-01_pipeline-fehler-bei-leeren-dateien',
    };
    const plan = planRefile(element, { parentFolder: '02_Projects/Quarz/Deliverables' }, []);
    expect(plan.move).toEqual({
      from: element.folderPath,
      to: '02_Projects/Quarz/Deliverables/2026-09-01_pipeline-fehler-bei-leeren-dateien',
      parent: '02_Projects/Quarz/Deliverables',
    });
    expect(plan.frontmatter).toEqual({});
  });
});

describe('F034 K4 level without children', () => {
  it('writes type without touching the folder', () => {
    const element: RefileElement = {
      form: 'nested',
      type: 'task',
      notePath: '02_Projects/Nimbus/Deliverables/2026-09-08_abnahmetermin/_2026-09-08_abnahmetermin.md',
      folderPath: '02_Projects/Nimbus/Deliverables/2026-09-08_abnahmetermin',
    };
    const plan = planRefile(element, { type: 'feature' }, []);
    expect(plan.frontmatter).toEqual({ type: 'feature' });
    expect(plan.move).toBeUndefined();
    expect(plan.notice).toBeUndefined();
  });
});

describe('F034 K5 level with child is rejected', () => {
  it('keeps type and names the child in notice, other fields proceed', () => {
    const element: RefileElement = {
      form: 'nested',
      type: 'feature',
      notePath: 'X/_feature.md',
      folderPath: 'X',
    };
    const kids = [child('X/_feature.md', 'Pipeline-Task darunter')];
    const plan = planRefile(element, { type: 'task', title: 'Neuer Titel' }, kids);
    expect(plan.frontmatter.type).toBeUndefined();
    expect(plan.notice).toContain('Pipeline-Task darunter');
    expect(plan.frontmatter.title).toBe('Neuer Titel');
  });
});

describe('F034 K6 change parent', () => {
  it('moves the folder under the chosen feature, name stays', () => {
    const element: RefileElement = {
      form: 'nested',
      type: 'task',
      notePath: '02_Projects/Nimbus/Deliverables/2026-09-08_abnahmetermin/_2026-09-08_abnahmetermin.md',
      folderPath: '02_Projects/Nimbus/Deliverables/2026-09-08_abnahmetermin',
    };
    const plan = planRefile(
      element,
      { parentFolder: '02_Projects/Nimbus/Deliverables/2026-05-04_pb/2026-08-11_da' },
      [],
    );
    expect(plan.move).toEqual({
      from: element.folderPath,
      to: '02_Projects/Nimbus/Deliverables/2026-05-04_pb/2026-08-11_da/2026-09-08_abnahmetermin',
      parent: '02_Projects/Nimbus/Deliverables/2026-05-04_pb/2026-08-11_da',
    });
    expect(plan.frontmatter).toEqual({});
  });
});

describe('without changed fields', () => {
  it('stays without move and without frontmatter', () => {
    const element: RefileElement = {
      form: 'nested',
      type: 'task',
      notePath: 'X/2026-09-02_a/_2026-09-02_a.md',
      folderPath: 'X/2026-09-02_a',
    };
    const plan = planRefile(element, {}, []);
    expect(plan.move).toBeUndefined();
    expect(plan.frontmatter).toEqual({});
    expect(plan.notePath).toBe(element.notePath);
  });
});
