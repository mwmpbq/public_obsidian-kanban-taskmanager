import { dayDiff } from './dates';
import type { BoardElement } from './model';
import type { Column } from './settings';
import { roleOf } from './week';

export type MatrixQuadrant = 'now' | 'plan' | 'quick' | 'later';

/**
 * Feld eines Elements in der Matrix (012 "Matrix"): wichtig heißt Priorität 1
 * oder 2 (eine fehlende Priorität liest BoardElement schon als 3, Default aus
 * dem Modell), dringend heißt fällig in höchstens drei Tagen, überfällig
 * eingeschlossen; ohne `due` nie dringend.
 */
export function matrixQuadrant(element: Pick<BoardElement, 'priority' | 'due'>, today: string): MatrixQuadrant {
  const important = element.priority <= 2;
  const diff = element.due !== undefined ? dayDiff(element.due, today) : undefined;
  const urgent = diff !== undefined && diff <= 3;
  if (important) return urgent ? 'now' : 'plan';
  return urgent ? 'quick' : 'later';
}

export interface MatrixAssignment {
  now: BoardElement[];
  plan: BoardElement[];
  quick: BoardElement[];
  later: BoardElement[];
}

/**
 * Verteilt `elements` auf die vier Felder der Matrix und behält dabei die
 * Eingangsreihenfolge aus buildBoard. Elemente mit Rolle `done` oder
 * `wont-do` (012 "Für alle Darstellungen") und ungültige Karten fehlen.
 */
export function assignMatrix(elements: BoardElement[], today: string, columns: Column[]): MatrixAssignment {
  const result: MatrixAssignment = { now: [], plan: [], quick: [], later: [] };
  for (const element of elements) {
    if (element.invalid) continue;
    const role = roleOf(element.status, columns);
    if (role === 'done' || role === 'wont-do') continue;
    result[matrixQuadrant(element, today)].push(element);
  }
  return result;
}

const TOP_ROW = new Set<MatrixQuadrant>(['now', 'plan']);

/**
 * Zu schreibender `priority`-Wert beim Ziehen zwischen Feldern (012 "Matrix"):
 * nur ein Zeilenwechsel schreibt etwas, Ziehen in die obere Zeile ergibt '2',
 * in die untere '3'. Bleibt die Zeile gleich (seitwärts oder gleiches Feld),
 * ist das Ergebnis undefined (012 S31).
 */
export function matrixDropPriority(from: MatrixQuadrant, to: MatrixQuadrant): '2' | '3' | undefined {
  const fromTop = TOP_ROW.has(from);
  const toTop = TOP_ROW.has(to);
  if (fromTop === toTop) return undefined;
  return toTop ? '2' : '3';
}
