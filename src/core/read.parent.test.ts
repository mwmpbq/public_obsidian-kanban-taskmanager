import { describe, expect, it } from 'vitest';
import type { FileEntry, ProjectRoot } from './model';
import { type LevelsFor, read, readElements } from './read';
import { DEFAULT_LEVELS, type Level } from './settings';

// Covers K1-K7 of F049 with inline fixtures, independent of the shared vault
// under fixtures/vault (008, addendum 2026-09-20: parent field, own-folder
// elements, project-scoped levels, short).

const ROOT: ProjectRoot[] = [{ key: 'demo', root: 'root' }];

function note(path: string, frontmatter: Record<string, unknown>): FileEntry {
  return { path, frontmatter, body: '' };
}

describe('K1 parent from frontmatter', () => {
  it('nests the task under the linked feature and adds feature and epic ancestors', () => {
    const epic = note('root/epic/_epic.md', { type: 'epic', title: 'Epic X', status: 'doing' });
    const feature = note('root/epic/feature/_feature.md', {
      type: 'feature',
      title: 'Feature X',
      status: 'doing',
    });
    const task = note('root/anderswo/_task.md', {
      type: 'task',
      status: 'doing',
      project: 'demo',
      parent: '[[_feature]]',
    });

    const cards = read([epic, feature, task], ROOT);
    expect(cards).toHaveLength(1);
    expect(cards[0].parents).toEqual([
      { type: 'feature', title: 'Feature X', note: feature.path },
      { type: 'epic', title: 'Epic X', note: epic.path },
    ]);
  });
});

describe('K2 field wins against folder', () => {
  it('takes Feature B as parent, stays valid and carries the folder notice', () => {
    const featureA = note('root/featureA/_featureA.md', {
      type: 'feature',
      title: 'Feature A',
      status: 'doing',
    });
    const featureB = note('root/featureB/_featureB.md', {
      type: 'feature',
      title: 'Feature B',
      status: 'doing',
    });
    const task = note('root/featureA/task/_task.md', {
      type: 'task',
      status: 'doing',
      parent: '[[_featureB]]',
    });

    const cards = read([featureA, featureB, task], ROOT);
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.parents[0]).toMatchObject({ type: 'feature', title: 'Feature B' });
    expect(card.invalid).not.toBe(true);
    expect(card.notice).toContain('Ordner passt nicht zum Parent');
  });
});

describe('K3 without parent, folder applies', () => {
  it('takes Feature A as parent when the task is in its folder', () => {
    const featureA = note('root/featureA/_featureA.md', {
      type: 'feature',
      title: 'Feature A',
      status: 'doing',
    });
    const task = note('root/featureA/task/_task.md', { type: 'task', status: 'doing' });

    const cards = read([featureA, task], ROOT);
    expect(cards).toHaveLength(1);
    expect(cards[0].parents[0]).toMatchObject({ type: 'feature', title: 'Feature A' });
    expect(cards[0].notice).toBeUndefined();
  });
});

describe('K4 element with own folder', () => {
  it('reads a note with type, status and project outside any root folder as an element', () => {
    const owned = note('elsewhere/sandbox/_owned.md', {
      type: 'task',
      status: 'doing',
      project: 'demo',
    });

    const cards = read([owned], []);
    expect(cards).toHaveLength(1);
    expect(cards[0].ownFolder).toBe(true);
  });

  it('does not read the same note without project', () => {
    const withoutProject = note('elsewhere/sandbox/_owned.md', { type: 'task', status: 'doing' });

    expect(read([withoutProject], [])).toEqual([]);
  });
});

describe('K5 project level list decides on validity', () => {
  const levelsWithStory: Level[] = [
    { key: 'epic', name: 'Epic', icon: 'layers' },
    { key: 'feature', name: 'Feature', icon: 'box' },
    { key: 'story', name: 'User Story', icon: 'book-open' },
    { key: 'task', name: 'Task', icon: 'square' },
  ];
  const levelsFor: LevelsFor = (project) => (project === 'withStory' ? levelsWithStory : DEFAULT_LEVELS);
  const roots: ProjectRoot[] = [
    { key: 'plain', root: 'rootA' },
    { key: 'withStory', root: 'rootB' },
  ];

  it('makes a story note under a project without story into an invalid card', () => {
    const storyNote = note('rootA/story1/_story1.md', {
      type: 'story',
      status: 'doing',
      project: 'plain',
    });
    const cards = readElements([storyNote], roots, undefined, levelsFor);
    expect(cards).toHaveLength(1);
    expect(cards[0].invalid).toBe(true);
  });

  it('leaves the same note under a project with story valid', () => {
    const storyNote = note('rootB/story1/_story1.md', {
      type: 'story',
      status: 'doing',
      project: 'withStory',
    });
    const cards = readElements([storyNote], roots, undefined, levelsFor);
    expect(cards).toHaveLength(1);
    expect(cards[0].invalid).toBeUndefined();
    expect(cards[0].type).toBe('story');
  });
});

describe('K6 level order for the parent', () => {
  it('rejects a task as parent of a feature', () => {
    const task = note('root/task1/_task1.md', { type: 'task', status: 'doing' });
    const featureRejected = note('root/feature1/_feature1.md', {
      type: 'feature',
      status: 'doing',
      parent: '[[_task1]]',
    });

    const cards = readElements([task, featureRejected], ROOT);
    const featureCard = cards.find((c) => c.type === 'feature');
    expect(featureCard?.parents).toEqual([]);
  });

  it('allows a feature as parent of a task', () => {
    const featureOk = note('root/feature2/_feature2.md', { type: 'feature', status: 'doing' });
    const taskAccepted = note('root/elsewhere/_task2.md', {
      type: 'task',
      status: 'doing',
      parent: '[[_feature2]]',
    });

    const cards = read([featureOk, taskAccepted], ROOT);
    expect(cards).toHaveLength(1);
    expect(cards[0].parents[0]).toMatchObject({ type: 'feature', title: 'feature2' });
  });

  it('rejects a peer feature as parent of a feature', () => {
    const otherFeature = note('root/andereFeature/_andereFeature.md', {
      type: 'feature',
      status: 'doing',
    });
    const featureWithPeerParent = note('root/feature3/_feature3.md', {
      type: 'feature',
      status: 'doing',
      parent: '[[_andereFeature]]',
    });

    const cards = readElements([otherFeature, featureWithPeerParent], ROOT);
    const childCard = cards.find((c) => c.title === 'feature3');
    expect(childCard?.parents).toEqual([]);
  });
});

describe('K7 short name in feature chip, full title otherwise', () => {
  it('carries the ancestor short name in ParentRef, the full title on the task card', () => {
    const feature = note('root/feature/_feature.md', {
      type: 'feature',
      title: 'Datenaufnahme stabilisieren',
      short: 'Datenaufnahme',
      status: 'doing',
    });
    const task = note('root/feature/task/_task.md', {
      type: 'task',
      title: 'Task voll ausgeschrieben',
      status: 'doing',
    });

    const cards = read([feature, task], ROOT);
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.title).toBe('Task voll ausgeschrieben');
    const featureParent = card.parents.find((p) => p.type === 'feature');
    expect(featureParent?.short).toBe('Datenaufnahme');
    expect(featureParent?.title).toBe('Datenaufnahme stabilisieren');
    expect(featureParent?.short ?? featureParent?.title).toBe('Datenaufnahme');
  });
});
