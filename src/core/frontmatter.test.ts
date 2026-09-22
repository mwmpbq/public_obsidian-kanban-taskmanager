import { describe, expect, it } from 'vitest';
import { applyFrontmatter, flowList } from './frontmatter';

const NOTE = ['---', 'type: task', 'status: ready', 'priority: 2', '---', 'Body text.', ''].join(
  '\n',
);

describe('applyFrontmatter sets a known key', () => {
  it('replaces the status line and leaves every other byte untouched', () => {
    const out = applyFrontmatter(NOTE, { status: 'doing' });
    expect(out).toBe(
      ['---', 'type: task', 'status: doing', 'priority: 2', '---', 'Body text.', ''].join('\n'),
    );
  });

  it('touches nothing but the status line', () => {
    const out = applyFrontmatter(NOTE, { status: 'doing' });
    expect(out.replace('status: doing', 'status: ready')).toBe(NOTE);
  });
});

describe('applyFrontmatter inserts a missing key', () => {
  it('appends completed at the end of the block', () => {
    const out = applyFrontmatter(NOTE, { status: 'done', completed: '2026-09-09' });
    expect(out).toBe(
      [
        '---',
        'type: task',
        'status: done',
        'priority: 2',
        'completed: 2026-09-09',
        '---',
        'Body text.',
        '',
      ].join('\n'),
    );
  });
});

describe('applyFrontmatter removes a key', () => {
  const done = ['---', 'type: task', 'status: done', 'completed: 2026-09-09', '---', 'x', ''].join(
    '\n',
  );

  it('drops the completed line when set to null', () => {
    const out = applyFrontmatter(done, { status: 'doing', completed: null });
    expect(out).toBe(['---', 'type: task', 'status: doing', '---', 'x', ''].join('\n'));
  });

  it('is a no-op when clearing a key that is absent', () => {
    const out = applyFrontmatter(NOTE, { completed: null });
    expect(out).toBe(NOTE);
  });
});

describe('applyFrontmatter tolerates CRLF', () => {
  it('keeps CRLF terminators and edits only the value', () => {
    const crlf = ['---', 'type: task', 'status: ready', '---', 'Body', ''].join('\r\n');
    const out = applyFrontmatter(crlf, { status: 'doing' });
    expect(out).toBe(['---', 'type: task', 'status: doing', '---', 'Body', ''].join('\r\n'));
  });
});

describe('flowList', () => {
  it('renders bare tags without quotes', () => {
    expect(flowList(['st/bug', 'st/review'], false)).toBe('[st/bug, st/review]');
  });

  it('renders wikilinks quoted, matching the fixtures', () => {
    expect(flowList(['[[Messprotokoll]]'], true)).toBe('["[[Messprotokoll]]"]');
  });

  it('renders an empty list as []', () => {
    expect(flowList([], false)).toBe('[]');
  });
});

describe('applyFrontmatter replaces a block-style list, not just its key line', () => {
  // Obsidian's own link-follow rewrite turns a flow list into block style on
  // rename (F036 K4); the next write through this module must not leave the
  // old `- item` lines dangling underneath the new value.
  const blockNotes = [
    '---',
    'type: task',
    'notes:',
    '  - "[[Messprotokoll-v2]]"',
    'adr:',
    '  - "[[ADR_2026-09-10_parser-strategie]]"',
    '---',
    'Body.',
    '',
  ].join('\n');

  it('drops the old continuation lines when the key is set', () => {
    const out = applyFrontmatter(blockNotes, { notes: '["[[Messprotokoll-v2]]", "[[Wochenplan]]"]' });
    expect(out).toBe(
      [
        '---',
        'type: task',
        'notes: ["[[Messprotokoll-v2]]", "[[Wochenplan]]"]',
        'adr:',
        '  - "[[ADR_2026-09-10_parser-strategie]]"',
        '---',
        'Body.',
        '',
      ].join('\n'),
    );
  });

  it('drops the old continuation lines when the key is cleared', () => {
    const out = applyFrontmatter(blockNotes, { notes: null });
    expect(out).toBe(
      [
        '---',
        'type: task',
        'adr:',
        '  - "[[ADR_2026-09-10_parser-strategie]]"',
        '---',
        'Body.',
        '',
      ].join('\n'),
    );
  });
});

describe('applyFrontmatter preserves an unknown block', () => {
  it('leaves a body-level --- and unknown keys intact', () => {
    const note = ['---', 'status: ready', 'extra: keep', '---', 'text', '---', 'more', ''].join(
      '\n',
    );
    const out = applyFrontmatter(note, { status: 'doing' });
    expect(out).toBe(
      ['---', 'status: doing', 'extra: keep', '---', 'text', '---', 'more', ''].join('\n'),
    );
  });
});
