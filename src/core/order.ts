export interface OrderCard {
  path: string;
  order?: number;
}

export interface OrderChange {
  path: string;
  order: number;
}

// Spread far enough apart that most single inserts land between two
// neighbours without touching anyone else's value.
const SPREAD = 10;

/**
 * Derives the `order` writes for dropping `draggedPath` at `insertIndex`
 * among `cards` (a column's visible, non-invalid cards in their current
 * display order; the dragged card may or may not already be among them).
 *
 * A column with no manual order yet (008 S16) is renumbered whole: every
 * card, including the dragged one, gets an integer spread value reflecting
 * the new sequence. A column already manually sorted (some card carries
 * `order`) only touches the dragged card, giving it a value between its new
 * neighbours (S19) — unless the neighbours are adjacent integers with no
 * room between them, in which case the whole sequence is renumbered instead
 * of falling back to a fractional value (see contract "ausserhalb").
 */
export function reorderColumn(
  cards: OrderCard[],
  draggedPath: string,
  insertIndex: number,
): OrderChange[] {
  const others = cards.filter((c) => c.path !== draggedPath);
  const index = Math.max(0, Math.min(insertIndex, others.length));
  const manual = others.some((c) => c.order !== undefined);

  if (manual) {
    const fitted = fittingOrder(others[index - 1]?.order, others[index]?.order);
    if (fitted !== undefined) return [{ path: draggedPath, order: fitted }];
  }

  const sequence = [...others];
  sequence.splice(index, 0, { path: draggedPath });
  return sequence.map((c, i) => ({ path: c.path, order: (i + 1) * SPREAD }));
}

function fittingOrder(before: number | undefined, after: number | undefined): number | undefined {
  if (before === undefined && after === undefined) return SPREAD;
  if (before === undefined) return after! - SPREAD;
  if (after === undefined) return before + SPREAD;
  const mid = Math.floor((before + after) / 2);
  return mid > before && mid < after ? mid : undefined;
}
