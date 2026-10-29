/** Eine gespeicherte Ansicht (001, Ergänzung 2026-10-18 "Gespeicherte Ansichten"): `key` ist fest ('saved:' + newId()), `name` frei änderbar. */
export interface SavedView {
  key: string;
  name: string;
  /** Darstellung, die diese Ansicht mitbringt (012, Ergänzung 2026-10-25 "Darstellungen"); ohne `mode` zeigt sie nie die Marke "geändert". */
  mode?: string;
}

/**
 * Hinweistext für einen ungültigen Ansichtsnamen: leer (nach `trim`) oder
 * schon von einer anderen gespeicherten Ansicht getragen, ohne Unterschied
 * der Groß- und Kleinschreibung (`toLocaleLowerCase('de')`). `excludeKey`
 * nimmt beim Umbenennen die eigene Ansicht von der Dublettenprüfung aus.
 * `undefined`, wenn der Name gültig ist.
 */
export function validateViewName(
  name: string,
  existing: readonly SavedView[],
  excludeKey?: string,
): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'Bitte einen Namen eingeben.';
  const lower = trimmed.toLocaleLowerCase('de');
  const clash = existing.some((v) => v.key !== excludeKey && v.name.toLocaleLowerCase('de') === lower);
  if (clash) return `Der Name „${trimmed}“ wird schon verwendet.`;
  return undefined;
}

/**
 * Verschiebt den Eintrag `key` direkt vor `beforeKey` und gibt eine neue
 * Liste zurück (001, Ergänzung 2026-10-18 "Ansichten per Ziehen ordnen");
 * `beforeKey` undefined verschiebt ans Ende. Ist `key` nicht in der Liste,
 * oder `beforeKey` gesetzt, aber in der um `key` bereinigten Liste nicht zu
 * finden (Ziel außerhalb der Liste), bleibt die Liste unverändert.
 *
 * Generisch über `T extends { key: string }` (012, Ergänzung 2026-10-25
 * "Reihenfolge per Ziehen"): verschiebt auch die Darstellungs-Icon-Reihenfolge,
 * ohne eine zweite, fast identische Funktion.
 */
export function moveSavedView<T extends { key: string }>(
  list: readonly T[],
  key: string,
  beforeKey: string | undefined,
): T[] {
  const dragged = list.find((v) => v.key === key);
  if (!dragged) return [...list];
  const rest = list.filter((v) => v.key !== key);
  if (beforeKey === undefined) return [...rest, dragged];
  const targetIndex = rest.findIndex((v) => v.key === beforeKey);
  if (targetIndex === -1) return [...list];
  rest.splice(targetIndex, 0, dragged);
  return rest;
}
