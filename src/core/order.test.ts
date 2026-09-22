import { describe, expect, it } from 'vitest';
import { reorderColumn } from './order';

describe('reorderColumn', () => {
  it('renumbers a fresh column (no order yet) with the dragged card at its new index', () => {
    const cards = [{ path: 'a' }, { path: 'b' }, { path: 'c' }, { path: 'd' }];
    // Third card ('c') dragged to the front, as in K1.
    const changes = reorderColumn(cards, 'c', 0);
    expect(changes).toEqual([
      { path: 'c', order: 10 },
      { path: 'a', order: 20 },
      { path: 'b', order: 30 },
      { path: 'd', order: 40 },
    ]);
  });

  it('inserts a card from another column between two ordered neighbours without touching them', () => {
    const cards = [
      { path: 'a', order: 10 },
      { path: 'b', order: 20 },
      { path: 'c', order: 30 },
      { path: 'd', order: 40 },
    ];
    const changes = reorderColumn(cards, 'x', 1);
    expect(changes).toEqual([{ path: 'x', order: 15 }]);
  });

  it('places an insert at the front below the first neighbour', () => {
    const cards = [
      { path: 'a', order: 10 },
      { path: 'b', order: 20 },
    ];
    expect(reorderColumn(cards, 'x', 0)).toEqual([{ path: 'x', order: 0 }]);
  });

  it('places an insert at the end above the last neighbour', () => {
    const cards = [
      { path: 'a', order: 10 },
      { path: 'b', order: 20 },
    ];
    expect(reorderColumn(cards, 'x', 2)).toEqual([{ path: 'x', order: 30 }]);
  });

  it('renumbers the whole sequence when adjacent neighbours leave no integer gap', () => {
    const cards = [
      { path: 'a', order: 10 },
      { path: 'b', order: 11 },
      { path: 'c', order: 20 },
    ];
    const changes = reorderColumn(cards, 'x', 1);
    expect(changes).toEqual([
      { path: 'a', order: 10 },
      { path: 'x', order: 20 },
      { path: 'b', order: 30 },
      { path: 'c', order: 40 },
    ]);
  });

  it('leaves order-less new cards (K2/K3 fallback) out of the manual check when none carry order', () => {
    const cards = [{ path: 'a' }, { path: 'b' }];
    const changes = reorderColumn(cards, 'a', 1);
    expect(changes).toEqual([
      { path: 'b', order: 10 },
      { path: 'a', order: 20 },
    ]);
  });

  it('clamps an out-of-range index to the end of the column', () => {
    const cards = [{ path: 'a', order: 10 }];
    expect(reorderColumn(cards, 'x', 99)).toEqual([{ path: 'x', order: 20 }]);
  });
});
