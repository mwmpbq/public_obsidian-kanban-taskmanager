import { addDays, absoluteDate, isoWeek, mondayOf } from './dates';
import type { BoardElement } from './model';
import type { Column } from './settings';
import { roleOf } from './week';

export type AgendaGroupKey = 'overdue' | 'today' | 'tomorrow' | 'week' | 'nextweek' | 'later' | 'none';

export interface AgendaGroup {
  key: AgendaGroupKey;
  name: string;
  /** Zeitraum unter dem Gruppentitel (DESIGN.md "Agenda"), nur wo einer sinnvoll ist. */
  range?: string;
  cards: BoardElement[];
}

function compareOptionalDate(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a < b ? -1 : 1;
}

// aktiv vor offen (012 "Agenda": "Rolle (aktiv vor offen)").
function roleRank(role: string): number {
  return role === 'active' ? 0 : 1;
}

/**
 * Ordnet offene und aktive Karten den sieben Fälligkeitsgruppen der Agenda zu
 * (012 S14, "Agenda") und sortiert sie je Gruppe nach Fällig, Geplant (ohne
 * Geplant zuletzt), Priorität, Rolle (aktiv vor offen) und Titel. Erledigte
 * und verworfene Rollen sowie ungültige Karten fehlen ganz. Leere Gruppen
 * werden nicht zurückgegeben, in der festen Reihenfolge Überfällig, Heute,
 * Morgen, Diese Woche, Nächste Woche, Später, Ohne Fälligkeit. Ist `today`
 * selbst ein Sonntag, liegt "Diese Woche" (bis heute) vor "Morgen" und bleibt
 * deshalb leer, ohne eigenen Sonderfall: der Vergleich mit `tomorrow` greift
 * unabhängig von der Wochengrenze zuerst.
 */
export function agendaGroups(elements: BoardElement[], today: string, columns: Column[]): AgendaGroup[] {
  const monday = mondayOf(today);
  const thisSunday = addDays(monday, 6);
  const nextSunday = addDays(monday, 13);
  const tomorrow = addDays(today, 1);
  const nextMonday = addDays(monday, 7);

  const buckets: Record<AgendaGroupKey, BoardElement[]> = {
    overdue: [],
    today: [],
    tomorrow: [],
    week: [],
    nextweek: [],
    later: [],
    none: [],
  };

  for (const el of elements) {
    if (el.invalid) continue;
    const role = roleOf(el.status, columns);
    if (role !== 'open' && role !== 'active') continue;
    const due = el.due;
    let key: AgendaGroupKey;
    if (due === undefined) key = 'none';
    else if (due < today) key = 'overdue';
    else if (due === today) key = 'today';
    else if (due === tomorrow) key = 'tomorrow';
    else if (due <= thisSunday) key = 'week';
    else if (due <= nextSunday) key = 'nextweek';
    else key = 'later';
    buckets[key].push(el);
  }

  const compare = (a: BoardElement, b: BoardElement): number => {
    const dueCmp = compareOptionalDate(a.due, b.due);
    if (dueCmp !== 0) return dueCmp;
    const plannedCmp = compareOptionalDate(a.planned, b.planned);
    if (plannedCmp !== 0) return plannedCmp;
    if (a.priority !== b.priority) return a.priority - b.priority;
    const roleCmp = roleRank(roleOf(a.status, columns)) - roleRank(roleOf(b.status, columns));
    if (roleCmp !== 0) return roleCmp;
    return a.title.localeCompare(b.title, 'de');
  };

  const defs: Array<{ key: AgendaGroupKey; name: string; range?: string }> = [
    { key: 'overdue', name: 'Überfällig' },
    { key: 'today', name: 'Heute', range: absoluteDate(today, today) },
    { key: 'tomorrow', name: 'Morgen', range: absoluteDate(tomorrow, today) },
    { key: 'week', name: 'Diese Woche', range: `bis ${absoluteDate(thisSunday, today)}` },
    { key: 'nextweek', name: 'Nächste Woche', range: `KW ${isoWeek(Date.parse(`${nextMonday}T00:00:00Z`))}` },
    { key: 'later', name: 'Später' },
    { key: 'none', name: 'Ohne Fälligkeit' },
  ];

  return defs
    .filter((d) => buckets[d.key].length > 0)
    .map((d) => ({ key: d.key, name: d.name, range: d.range, cards: [...buckets[d.key]].sort(compare) }));
}
