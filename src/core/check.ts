import type { BoardElement, FileEntry } from './model';
import { type IsDone, placementFindings, type PlacementProject } from './placement';

export interface CheckFinding {
  path: string;
  reason: string;
}

/** Resolves a wikilink's linkpath (without alias/heading) from `sourcePath`, the way `metadataCache.getFirstLinkpathDest` does. `undefined` when it resolves nowhere. */
export type LinkResolver = (linktext: string, sourcePath: string) => string | undefined;

/**
 * Every finding `ktm:check` reports (011, Ergänzung 2026-09-25, "Bestandsprüfung"):
 * ungültige Karten, doppelte Kennungen, ein `parent` ins Leere, ein
 * `parent_link`, der nicht mehr zum Titel des Parents passt, Notizen mit
 * `type`/`status` ohne `ktm_id`, und alles, was {@link placementFindings}
 * schon meldet. Ein Element mit unaufgelöstem `parent` (schon als "parent ins
 * Leere" gemeldet) wird für den `parent_link` nicht zusätzlich geprüft — es
 * hat gar keinen aufgelösten Parent, gegen den ein Link passen könnte — und
 * taucht auch bei placementFindings nicht auf, weil computedLocation ein
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
    findings.push({ path: el.paths.note, reason: `parent ins Leere: ${rawParent}` });
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
