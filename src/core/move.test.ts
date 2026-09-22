import { describe, expect, it } from 'vitest';
import { moveByDirection, moveToColumn } from './move';
import type { Column } from './settings';

const TODAY = '2026-09-09';

const COLUMNS: Column[] = [
  { status: 'backlog', name: 'Backlog', done: false },
  { status: 'ready', name: 'Ready', done: false },
  { status: 'doing', name: 'Doing', done: false },
  { status: 'done', name: 'Done', done: true },
  { status: 'wont-do', name: "Won't Do", done: true },
];

describe('moveToColumn', () => {
  it('ready to doing sets status, no completion', () => {
    expect(moveToColumn('ready', 'doing', COLUMNS, TODAY)).toEqual({
      targetStatus: 'doing',
      change: { status: 'doing', completed: null },
    });
  });

  it('into a done column stamps completed with today', () => {
    expect(moveToColumn('doing', 'done', COLUMNS, TODAY)).toEqual({
      targetStatus: 'done',
      change: { status: 'done', completed: TODAY },
    });
  });

  it('onto the same column is a no-op', () => {
    expect(moveToColumn('doing', 'doing', COLUMNS, TODAY)).toBeNull();
  });

  it('onto an unknown column is a no-op', () => {
    expect(moveToColumn('doing', 'waiting', COLUMNS, TODAY)).toBeNull();
  });
});

describe('moveByDirection', () => {
  it('right from ready lands in doing', () => {
    expect(moveByDirection('ready', 'right', COLUMNS, TODAY)).toEqual({
      targetStatus: 'doing',
      change: { status: 'doing', completed: null },
    });
  });

  it('left from doing lands in ready', () => {
    expect(moveByDirection('doing', 'left', COLUMNS, TODAY)).toEqual({
      targetStatus: 'ready',
      change: { status: 'ready', completed: null },
    });
  });

  it('right into a done column stamps completed', () => {
    expect(moveByDirection('doing', 'right', COLUMNS, TODAY)).toEqual({
      targetStatus: 'done',
      change: { status: 'done', completed: TODAY },
    });
  });

  it('right from the last column is a no-op', () => {
    expect(moveByDirection('wont-do', 'right', COLUMNS, TODAY)).toBeNull();
  });

  it('left from the first column is a no-op', () => {
    expect(moveByDirection('backlog', 'left', COLUMNS, TODAY)).toBeNull();
  });

  it('an unknown current status is a no-op', () => {
    expect(moveByDirection('waiting', 'right', COLUMNS, TODAY)).toBeNull();
  });
});
