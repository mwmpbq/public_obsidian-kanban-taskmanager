import type { TagEntry } from './settings';

function stripHash(tag: string): string {
  return tag.startsWith('#') ? tag.slice(1) : tag;
}

export interface TagSuggestions {
  pinned: TagEntry[];
  rest: string[];
}

/**
 * Orders and filters the tag input's suggestions (002, Ergänzung 2026-10-25):
 * the hinterlegte Liste first, in its own order, then the remaining tags used
 * anywhere in the vault, alphabetically, without the hinterlegten and without
 * what the card already carries. `query` filters both halves on "enthält",
 * ohne Unterschied der Schreibung (S100); a leading `#` in `query` is ignored
 * like everywhere else tags are typed.
 */
export function tagSuggestions(
  tagList: TagEntry[],
  vaultTags: string[],
  cardTags: string[],
  query: string,
): TagSuggestions {
  const q = stripHash(query.trim()).toLowerCase();
  const cardKeys = new Set(cardTags.map((t) => stripHash(t).toLowerCase()));
  const pinnedKeys = new Set(tagList.map((t) => t.tag.toLowerCase()));

  const pinned = tagList.filter((entry) => {
    const key = entry.tag.toLowerCase();
    if (cardKeys.has(key)) return false;
    return !q || key.includes(q);
  });

  const restKeys = new Set<string>();
  for (const tag of vaultTags) {
    const stripped = stripHash(tag);
    const key = stripped.toLowerCase();
    if (cardKeys.has(key) || pinnedKeys.has(key)) continue;
    if (q && !key.includes(q)) continue;
    restKeys.add(stripped);
  }
  const rest = [...restKeys].sort((a, b) => a.localeCompare(b));

  return { pinned, rest };
}

/**
 * Resolves what the tag input commits (S100): a typed value that matches a
 * hinterlegten Tag ohne Unterschied der Schreibung becomes that tag's own
 * spelling, everything else is returned stripped of `#` and surrounding
 * whitespace.
 */
export function canonicalTag(input: string, tagList: TagEntry[]): string {
  const value = stripHash(input.trim());
  const match = tagList.find((entry) => entry.tag.toLowerCase() === value.toLowerCase());
  return match ? match.tag : value;
}

export interface TagChip {
  tag: string;
  icon: string;
}

export interface SplitTagChips {
  icons: TagChip[];
  text: string[];
}

/**
 * Splits a card's tags into the Icon-Chips (002, Ergänzung 2026-10-25): one
 * per hinterlegten Tag mit Icon that the card carries, in the wirksame
 * Liste's order, with the tag in the card's own spelling; and the remaining
 * tags, text chips, in their original order. `visibleTags` (core/dates) then
 * limits only the text part to three plus "+n".
 */
export function splitTagChips(cardTags: string[], tagList: TagEntry[]): SplitTagChips {
  const byKey = new Map(cardTags.map((tag) => [stripHash(tag).toLowerCase(), tag] as const));
  const consumed = new Set<string>();
  const icons: TagChip[] = [];
  for (const entry of tagList) {
    if (!entry.icon) continue;
    const key = entry.tag.toLowerCase();
    const cardTag = byKey.get(key);
    if (cardTag === undefined) continue;
    icons.push({ tag: cardTag, icon: entry.icon });
    consumed.add(key);
  }
  const text = cardTags.filter((tag) => !consumed.has(stripHash(tag).toLowerCase()));
  return { icons, text };
}
