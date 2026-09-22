import { describe, expect, it } from 'vitest';
import { FORMAT_NOTE, TASK_FIELDS } from './format-doc';

describe('F016 K2 format description', () => {
  it('lists all fields from 008', () => {
    for (const field of TASK_FIELDS) {
      expect(FORMAT_NOTE).toContain(field);
    }
  });

  it('contains exactly the eleven fields from 008', () => {
    expect(TASK_FIELDS).toEqual([
      'type',
      'status',
      'title',
      'project',
      'priority',
      'planned',
      'due',
      'completed',
      'ticket',
      'summary',
      'tags',
    ]);
  });

  it('describes both refile forms', () => {
    expect(FORMAT_NOTE).toContain('Eingeordnete');
    expect(FORMAT_NOTE).toContain('Atomare');
  });

  it('contains a complete example', () => {
    expect(FORMAT_NOTE).toContain('type: task');
  });
});
