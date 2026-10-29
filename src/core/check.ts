import type { BoardElement, FileEntry } from './model';
import { type IsDone, placementFindings, type PlacementProject } from './placement';

export interface CheckFinding {
  path: string;
  reason: string;
}

/** Resolves a wikilink's linkpath (without alias/heading) from `sourcePath`, the way `metadataCache.getFirstLinkpathDest` does. `undefined` when it resolves nowhere. */
export type LinkResolver = (linktext: string, sourcePath: string) => string | undefined;

// A value counts as a known ktm_placement only as the literal string `auto`
// or `manual` (011, Ergänzung 2026-10-19): `Manual`, `true` or an empty value
// are each reported, even though read.ts already treats them as `manual`
// behaviorally — the plugin never corrects the value itself.
const KNOWN_PLACEMENT_VALUES = new Set(['auto', 'manual']);

/**
 * Every finding `ktm:check` reports (011, Ergänzung 2026-09-25 und
 * 2026-10-19, "Bestandsprüfung"): ungültige Karten, doppelte Kennungen, ein
 * `parent` ins Leere oder sonst ungültig (gleiche/tiefere Ebene, anderes
 * Projekt), ein `parent_link`, der nicht mehr zum Titel des Parents passt,
 * Notizen mit `type`/`status` ohne `ktm_id`, ein unbekannter Wert in
 * `ktm_placement`, und alles, was {@link placementFindings} schon meldet. Ein
 * Element mit unaufgelöstem `parent` (schon als "parent ins Leere"/"Parent
 * ungültig" gemeldet) wird für den `parent_link` nicht zusätzlich geprüft —
 * es hat gar keinen aufgelösten Parent, gegen den ein Link passen könnte —
 * und taucht auch bei placementFindings nicht auf, weil computedLocation ein
 * Element mit `notice` von sich aus überspringt. Schreibt nichts.
 */
export function checkFindings(
  entries: FileEntry[],
  elements: BoardElement[],
  unadopted: string[],
  resolveLink: LinkResolver,
  projects: PlacementProject[],
  isDone: IsDone,
): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const entryByPath = new Map(entries.map((e) => [e.path, e]));

  for (const el of elements) {
    if (el.duplicate) {
      findings.push({ path: el.paths.note, reason: `Kennung doppelt: ${el.id}` });
    } else if (el.invalid) {
      findings.push({ path: el.paths.note, reason: `ungültige Karte: ${el.invalidReason}` });
    }
  }

  for (const el of elements) {
    if (el.invalid || el.duplicate || el.notice === undefined) continue;
    const rawParent = text(entryByPath.get(el.paths.note)?.frontmatter.parent);
    if (el.notice.includes('anderen Projekt') || el.notice.includes('höheren Ebene')) {
      const grund = el.notice.includes('anderen Projekt')
        ? 'gehört zu einem anderen Projekt'
        : 'liegt nicht auf einer höheren Ebene';
      findings.push({ path: el.paths.note, reason: `Parent ungültig: ${rawParent} (${grund})` });
    } else {
      findings.push({ path: el.paths.note, reason: `parent ins Leere: ${rawParent}` });
    }
  }

  for (const el of elements) {
    if (el.invalid || el.duplicate || el.notice !== undefined) continue;
    const rawLink = text(entryByPath.get(el.paths.note)?.frontmatter.parent_link);
    if (!rawLink) continue;
    const parent = el.parents[0];
    if (!parent) {
      findings.push({ path: el.paths.note, reason: `parent_link veraltet: ${rawLink}` });
      continue;
    }
    const parsed = parseWikilink(rawLink);
    const resolved = parsed ? resolveLink(parsed.target, el.paths.note) : undefined;
    const staleAlias = parsed?.alias !== undefined && parsed.alias !== parent.title;
    if (resolved !== parent.note || staleAlias) {
      findings.push({ path: el.paths.note, reason: `parent_link veraltet: ${rawLink}` });
    }
  }

  for (const path of unadopted) {
    findings.push({ path, reason: 'ohne ktm_id: type und status gesetzt' });
  }

  for (const el of elements) {
    if (el.invalid || el.duplicate) continue;
    const fm = entryByPath.get(el.paths.note)?.frontmatter;
    if (!fm || !Object.hasOwn(fm, 'ktm_placement')) continue;
    const raw = fm.ktm_placement;
    if (typeof raw === 'string' && KNOWN_PLACEMENT_VALUES.has(raw)) continue;
    findings.push({ path: el.paths.note, reason: `ktm_placement unbekannt: ${placementValueText(raw)}` });
  }

  findings.push(...placementFindings(elements, projects, isDone));

  return findings;
}

function parseWikilink(raw: string): { target: string; alias?: string } | undefined {
  const match = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(raw);
  const inner = match ? match[1] : raw;
  const [targetPart, ...rest] = inner.split('|');
  const target = targetPart.split('#')[0].trim();
  if (!target) return undefined;
  return { target, alias: rest.length > 0 ? rest.join('|').trim() : undefined };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function placementValueText(raw: unknown): string {
  if (raw === null || raw === undefined) return '(leer)';
  if (typeof raw === 'string') return raw.trim() === '' ? '(leer)' : raw;
  return String(raw);
}
