import { addDays } from './dates';
import type { BoardElement } from './model';
import type { Column, ColumnRole } from './settings';

export type WeekTone = 'open' | 'ready' | 'active' | 'done';

export interface WeekDay {
  day: string;
  done: boolean;
}

/**
 * The day an element occupies in the week starting `monday` (012 S10): a
 * verworfene Rolle (`wont-do`) never shows up. The day is `planned`, else
 * `due`, else — only for the erledigt role — `completed`; outside the week
 * that is simply absent (planned takes precedence over an in-week `due`,
 * S10 "bleibt außerhalb"). Without `planned` and `due` and not erledigt, the
 * element has no day at all and goes to "Ohne Datum".
 */
export function weekSlot(
  element: Pick<BoardElement, 'planned' | 'due' | 'completed'>,
  monday: string,
  role: ColumnRole,
): WeekDay | 'nodate' | null {
  if (role === 'wont-do') return null;
  const day = element.planned ?? element.due ?? (role === 'done' ? element.completed : undefined);
  if (day !== undefined) {
    const last = addDays(monday, 6);
    if (day >= monday && day <= last) return { day, done: role === 'done' };
  }
  if (element.planned === undefined && element.due === undefined && role !== 'done') return 'nodate';
  return null;
}

export interface WeekAssignment {
  days: Record<string, BoardElement[]>;
  nodate: BoardElement[];
}

/** Rollenauflösung einer Spalte (012 "Agenda" nutzt dieselbe wie die Woche). */
export function roleOf(status: string, columns: Column[]): ColumnRole {
  for (const col of columns) {
    if (col.status === status || col.aliases?.includes(status)) return col.role ?? 'open';
  }
  return 'open';
}

/**
 * Distributes `elements` over the seven days of the week starting `monday`
 * plus "Ohne Datum" (012 S10), keeping each day's input order (callers hand
 * in elements already sorted by buildBoard).
 */
export function assignWeek(elements: BoardElement[], monday: string, columns: Column[]): WeekAssignment {
  const days: Record<string, BoardElement[]> = {};
  for (let i = 0; i < 7; i++) days[addDays(monday, i)] = [];
  const nodate: BoardElement[] = [];
  for (const element of elements) {
    const slot = weekSlot(element, monday, roleOf(element.status, columns));
    if (slot === null) continue;
    if (slot === 'nodate') {
      nodate.push(element);
      continue;
    }
    (days[slot.day] ?? (days[slot.day] = [])).push(element);
  }
  return { days, nodate };
}

/**
 * Ton der Statusmarke (012 "Statusmarke"): done/wont-do → `done`, active →
 * `active`, die erste offene Spalte nach der ersten → `ready`, jede andere
 * offene Spalte (auch die allererste) → `open`.
 */
export function statusTone(status: string, columns: Column[]): WeekTone {
  const role = roleOf(status, columns);
  if (role === 'done' || role === 'wont-do') return 'done';
  if (role === 'active') return 'active';
  const openColumns = columns.filter((c) => (c.role ?? 'open') === 'open');
  const index = openColumns.findIndex((c) => c.status === status || c.aliases?.includes(status));
  return index === 1 ? 'ready' : 'open';
}
