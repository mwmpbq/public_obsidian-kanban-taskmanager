export interface OrderCard {
  path: string;
  order?: number;
}

export interface OrderChange {
  path: string;
  /** `null` deletes the field (FrontmatterChange), used for S38: a card dragged into an
   * untouched automatic column keeps no `order` of its own, and nobody else's changes. */
  order: number | null;
}

// Spread far enough apart that most single inserts land between two
// neighbours without touching anyone else's value.
const SPREAD = 10;

/**
 * Derives the `order` writes for dropping `draggedPath` at `insertIndex`
 * among `cards` (a column's full card sequence in display order; the dragged
 * card may or may not already be among them). `fromOtherColumn` tells apart a
 * status change by drag (the dragged card used to live in a different
 * column) from a reorder within the same column (default); it only matters
 * when the target column has no manual order at all (see below).
 *
 * A column already manually sorted (some card carries `order`, S19) only
 * touches the dragged card, giving it a value between its new neighbours —
 * but only when that is actually between two neighbours: the predecessor
 * must carry an `order` itself, or the card lands at the very front (003,
 * Ergänzung 2026-10-18 "Jede Stelle ist erreichbar"). Otherwise, and when
 * neighbours are adjacent integers with no room between them (see contract
 * "ausserhalb"), the whole sequence is renumbered instead, deliberately away
 * from S17 for this one case (#524). `cards` is the caller's own view's
 * sequence (its column, F188); the whole of it is renumbered.
 *
 * A column with no manual order yet (S16) is renumbered whole when the
 * dragged card already belonged to it; dragged in from elsewhere (S38) it
 * only loses its own `order`, and every other card stays untouched.
 */
export function reorderColumn(
  cards: OrderCard[],
  draggedPath: string,
  insertIndex: number,
  fromOtherColumn = false,
): OrderChange[] {
  const others = cards.filter((c) => c.path !== draggedPath);
  const index = Math.max(0, Math.min(insertIndex, others.length));
  const manual = others.some((c) => c.order !== undefined);

  if (!manual && fromOtherColumn) return [{ path: draggedPath, order: null }];

  if (manual) {
    const predecessor = others[index - 1];
    const canFit = index === 0 || predecessor?.order !== undefined;
    if (canFit) {
      const fitted = fittingOrder(predecessor?.order, others[index]?.order, others.length === 0);
      if (fitted !== undefined) return [{ path: draggedPath, order: fitted }];
    }
  }

  const sequence = [...others];
  sequence.splice(index, 0, { path: draggedPath });
  return sequence.map((c, i) => ({ path: c.path, order: (i + 1) * SPREAD }));
}

function fittingOrder(
  before: number | undefined,
  after: number | undefined,
  columnEmpty: boolean,
): number | undefined {
  if (before === undefined && after === undefined) return columnEmpty ? SPREAD : undefined;
  if (before === undefined) return after! - SPREAD;
  if (after === undefined) return before + SPREAD;
  const mid = Math.floor((before + after) / 2);
  return mid > before && mid < after ? mid : undefined;
}

/**
 * Maps a drop between visible neighbours onto an index in the column's full
 * card sequence (003, Ergänzung 2026-10-18 "Eingeschränkte Spalte", S36): the
 * cards hidden by the current view/filter keep their relative order, because
 * the index returned slots the dragged card in strictly by `beforePath`
 * (or, dropped at the visible end, right after the last visible neighbour),
 * never by a count over the visible list alone. Both path lists exclude
 * nothing on input; the dragged card is removed from `fullPaths` here so the
 * returned index is ready for {@link reorderColumn}'s `others`-relative
 * `insertIndex`.
 */
export function fullInsertIndex(
  visiblePaths: string[],
  fullPaths: string[],
  draggedPath: string,
  beforePath: string | undefined,
): number {
  const full = fullPaths.filter((p) => p !== draggedPath);
  if (beforePath !== undefined) {
    const at = full.indexOf(beforePath);
    if (at !== -1) return at;
  }
  const visible = visiblePaths.filter((p) => p !== draggedPath);
  for (let i = visible.length - 1; i >= 0; i--) {
    const at = full.indexOf(visible[i]);
    if (at !== -1) return at + 1;
  }
  return full.length;
}
