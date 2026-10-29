/**
 * Rewrites `.gitignore`, `.gitattributes` and the path strings inside query
 * blocks when an element moves (008, Ergänzung 2026-10-19). Pure string
 * handling, no `obsidian` import: {@link ../adapters/obsidian.ts#followPaths}
 * reads and writes the actual files and calls these on their content.
 */

/** One entry a rewrite touched, for notices and for {@link insertIntoRoot}. */
export interface RewrittenEntry {
  /** The entry's full original line, before the rewrite. */
  before: string;
  /** The nearest comment line directly above the entry, if any. */
  header?: string;
}

export interface RewriteResult {
  /** The file's content with every in-place rewrite applied, untouched otherwise. */
  content: string;
  /** Entries rewritten in place, original text first, for a write-failure notice. */
  changed: RewrittenEntry[];
  /**
   * Entries whose new path lies outside `dir`: removed from `content` here,
   * carried with a full vault-relative path for {@link insertIntoRoot}.
   */
  toRoot: { entry: RewrittenEntry; line: string }[];
}

/** Splits `content` into lines, each paired with the exact line ending that followed it (`''` for a final line without one). */
function splitKeepingEol(content: string): { text: string; eol: string }[] {
  const result: { text: string; eol: string }[] = [];
  const re = /\r\n|\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) {
    result.push({ text: content.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  if (start < content.length) result.push({ text: content.slice(start), eol: '' });
  return result;
}

/** `path` relative to `dir` (`''` is the vault root), or `undefined` when `path` does not lie under `dir`. */
function toRelative(dir: string, path: string): string | undefined {
  if (dir === '') return path;
  if (path === dir) return '';
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : undefined;
}

function splitPrefixes(line: string): { negate: boolean; anchored: boolean; core: string } {
  let rest = line;
  let negate = false;
  if (rest.startsWith('!')) {
    negate = true;
    rest = rest.slice(1);
  }
  let anchored = false;
  if (rest.startsWith('/')) {
    anchored = true;
    rest = rest.slice(1);
  }
  return { negate, anchored, core: rest };
}

/** The part of a gitignore/gitattributes pattern before its first wildcard (`*`, `?`, `[`). */
function fixedAnchorOf(core: string): string {
  const idx = core.search(/[*?[]/);
  return idx === -1 ? core : core.slice(0, idx);
}

/**
 * `core` begins with `oldRelative`, ending there at a path boundary (`/` or
 * the end of the whole entry); a wildcard directly behind the old path (`A*`,
 * `A?`, `A[`) is not a boundary, which `fixedAnchor` (the part before the
 * first wildcard) must fully cover for `oldRelative` to even count.
 */
function matchesBoundary(core: string, fixedAnchor: string, oldRelative: string): boolean {
  if (fixedAnchor.length < oldRelative.length) return false;
  if (!core.startsWith(oldRelative)) return false;
  const rest = core.slice(oldRelative.length);
  return rest === '' || rest.startsWith('/');
}

/**
 * Shared line-rewriter for {@link rewriteGitignore} and {@link
 * rewriteGitattributes}: given a pattern's `!`/`/`-stripped core, decides
 * whether it matches the moved path and, if so, builds both the in-place and
 * the full-path (toRoot) replacement.
 */
function rewritePattern(
  pattern: string,
  dir: string,
  oldRelative: string,
  newPath: string,
): { core: string; negate: boolean; anchored: boolean } | { full: string; negate: boolean; anchored: boolean } | undefined {
  const { negate, anchored, core } = splitPrefixes(pattern);
  const fixedAnchor = fixedAnchorOf(core);
  if (!matchesBoundary(core, fixedAnchor, oldRelative)) return undefined;
  const rest = core.slice(oldRelative.length);
  const newRelative = toRelative(dir, newPath);
  if (newRelative !== undefined) return { core: newRelative + rest, negate, anchored };
  return { full: newPath + rest, negate, anchored };
}

function withPrefixes(negate: boolean, anchored: boolean, core: string): string {
  return `${negate ? '!' : ''}${anchored ? '/' : ''}${core}`;
}

/**
 * Rewrites every `.gitignore` entry whose fixed anchor, relative to `dir`,
 * begins with `from` at a path boundary (008, Ergänzung 2026-10-19, "Fester
 * Anfang"). Comments, blank lines, block markers, order and line endings are
 * untouched; an entry whose fixed anchor has no wildcard still only matches
 * at a boundary, so `A-2/x` never matches `A`. An entry whose new location
 * falls outside `dir` is removed here and returned under `toRoot`, with the
 * nearest directly preceding comment line as its `header` for {@link
 * insertIntoRoot}.
 */
export function rewriteGitignore(content: string, dir: string, from: string, to: string): RewriteResult {
  const oldRelative = toRelative(dir, from);
  if (oldRelative === undefined) return { content, changed: [], toRoot: [] };
  const lines = splitKeepingEol(content);
  const kept: string[] = [];
  const changed: RewrittenEntry[] = [];
  const toRoot: RewriteResult['toRoot'] = [];
  let header: string | undefined;
  for (const { text, eol } of lines) {
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      kept.push(text + eol);
      if (trimmed.startsWith('#')) header = trimmed;
      continue;
    }
    const rewritten = rewritePattern(text, dir, oldRelative, to);
    if (!rewritten) {
      kept.push(text + eol);
      header = undefined;
      continue;
    }
    if ('core' in rewritten) {
      kept.push(withPrefixes(rewritten.negate, rewritten.anchored, rewritten.core) + eol);
      changed.push({ before: text, header });
    } else {
      toRoot.push({ entry: { before: text, header }, line: withPrefixes(rewritten.negate, rewritten.anchored, rewritten.full) });
    }
    header = undefined;
  }
  return { content: kept.join(''), changed, toRoot };
}

/**
 * Same rule as {@link rewriteGitignore}, applied only to the pattern token at
 * the start of a `.gitattributes` line; the attributes and whitespace that
 * follow stay character-identical (008, Ergänzung 2026-10-19).
 */
export function rewriteGitattributes(content: string, dir: string, from: string, to: string): RewriteResult {
  const oldRelative = toRelative(dir, from);
  if (oldRelative === undefined) return { content, changed: [], toRoot: [] };
  const lines = splitKeepingEol(content);
  const kept: string[] = [];
  const changed: RewrittenEntry[] = [];
  const toRoot: RewriteResult['toRoot'] = [];
  let header: string | undefined;
  for (const { text, eol } of lines) {
    const trimmed = text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      kept.push(text + eol);
      if (trimmed.startsWith('#')) header = trimmed;
      continue;
    }
    const spaceIdx = text.search(/\s/);
    const pattern = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? '' : text.slice(spaceIdx);
    const rewritten = rewritePattern(pattern, dir, oldRelative, to);
    if (!rewritten) {
      kept.push(text + eol);
      header = undefined;
      continue;
    }
    if ('core' in rewritten) {
      kept.push(withPrefixes(rewritten.negate, rewritten.anchored, rewritten.core) + rest + eol);
      changed.push({ before: text, header });
    } else {
      toRoot.push({
        entry: { before: text, header },
        line: withPrefixes(rewritten.negate, rewritten.anchored, rewritten.full) + rest,
      });
    }
    header = undefined;
  }
  return { content: kept.join(''), changed, toRoot };
}

/**
 * Inserts every `toRoot` line into the root `.gitignore`/`.gitattributes`
 * content: behind the last entry of the block that starts with the same
 * `header` comment, when there is one, otherwise at the end of the file, in
 * the file's own line ending (008, Ergänzung 2026-10-19, "Verschachtelte
 * `.gitignore`").
 */
export function insertIntoRoot(rootContent: string, entries: { entry: RewrittenEntry; line: string }[]): string {
  if (entries.length === 0) return rootContent;
  const eol = rootContent.includes('\r\n') ? '\r\n' : '\n';
  let lines = splitKeepingEol(rootContent);
  for (const { entry, line } of entries) {
    let insertAt = lines.length;
    if (entry.header !== undefined) {
      const headerIdx = lines.findIndex((l) => l.text.trim() === entry.header);
      if (headerIdx !== -1) {
        insertAt = headerIdx + 1;
        while (insertAt < lines.length) {
          const t = lines[insertAt].text.trim();
          if (t === '' || t.startsWith('#')) break;
          insertAt++;
        }
      }
    }
    if (insertAt === lines.length && lines.length > 0 && lines[lines.length - 1].eol === '') {
      lines[lines.length - 1] = { ...lines[lines.length - 1], eol };
    }
    lines = [...lines.slice(0, insertAt), { text: line, eol }, ...lines.slice(insertAt)];
  }
  return lines.map((l) => l.text + l.eol).join('');
}

const FENCE_OPEN_RE = /^(```|~~~)(dataview|dataviewjs|base)(?=\s|$)/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrites every quoted path string (delimited by `"`, `'` or `` ` ``) in
 * `content` whose value begins with `from` at a path boundary (`/` or the
 * closing quote) to start with `to` instead; the rest of the string, and
 * everything outside a match, stays byte-identical (008, Ergänzung
 * 2026-10-19). Used directly on `.base` files and, per block, by {@link
 * rewriteQueryBlocks}.
 */
export function rewriteQueryText(content: string, from: string, to: string): string {
  const pattern = new RegExp(`(["'\`])${escapeRegExp(from)}(?=\\/|\\1)`, 'g');
  return content.replace(pattern, (_match, quote: string) => `${quote}${to}`);
}

/**
 * Applies {@link rewriteQueryText} only inside fenced `dataview`,
 * `dataviewjs` and `base` code blocks of a note; text outside these blocks,
 * including inline queries and plain prose, is left untouched (008,
 * Ergänzung 2026-10-19). A fence opens at the start of a line with ``` ` ``
 * or `~~~` and exactly one of the three languages, followed by whitespace or
 * the line's end (so `basex` is not a block); it closes at the next line that
 * is the same fence marker alone. A block without such a closing line is not
 * rewritten, and an empty block (fence immediately followed by its closing
 * fence) ends there without reaching into what follows.
 */
export function rewriteQueryBlocks(content: string, from: string, to: string): string {
  const lines = splitKeepingEol(content);
  const parts: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const { text, eol } = lines[i];
    const open = text.match(FENCE_OPEN_RE);
    if (!open) {
      parts.push(text + eol);
      i++;
      continue;
    }
    const marker = open[1];
    let close = i + 1;
    while (close < lines.length && lines[close].text.trimEnd() !== marker) close++;
    if (close >= lines.length) {
      parts.push(text + eol);
      i++;
      continue;
    }
    const body = lines
      .slice(i + 1, close)
      .map((l) => l.text + l.eol)
      .join('');
    parts.push(text + eol, rewriteQueryText(body, from, to), lines[close].text + lines[close].eol);
    i = close + 1;
  }
  return parts.join('');
}
