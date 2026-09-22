import type { FrontmatterChange } from './frontmatter';
import type { Column } from './settings';

export type MoveDirection = 'left' | 'right';

export interface Move {
  targetStatus: string;
  change: FrontmatterChange;
}

/**
 * Computes the move one column to the left or right of the card's current
 * column. Returns `null` at the edges (no left of the first, no right of the
 * last) and when the current status matches no column, so the caller does
 * nothing and raises no error.
 */
export function moveByDirection(
  currentStatus: string,
  direction: MoveDirection,
  columns: Column[],
  today: string,
): Move | null {
  const from = columns.findIndex((c) => c.status === currentStatus);
  if (from === -1) return null;
  const to = direction === 'right' ? from + 1 : from - 1;
  if (to < 0 || to >= columns.length) return null;
  return toMove(columns[to], today);
}

/**
 * Computes the move onto a named target column, as a drop does. Returns `null`
 * when the target is the current column or matches no column.
 */
export function moveToColumn(
  currentStatus: string,
  targetStatus: string,
  columns: Column[],
  today: string,
): Move | null {
  if (targetStatus === currentStatus) return null;
  const target = columns.find((c) => c.status === targetStatus);
  if (!target) return null;
  return toMove(target, today);
}

// A done column stamps completed with today; any other column clears it, so
// re-opening a card removes the stale completion date.
function toMove(target: Column, today: string): Move {
  return {
    targetStatus: target.status,
    change: { status: target.status, completed: target.done ? today : null },
  };
}
