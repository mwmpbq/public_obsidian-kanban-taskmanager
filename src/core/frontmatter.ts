export type FrontmatterChange = Record<string, string | null>;

/**
 * Renders a list as a single-line YAML flow sequence, `tags: [a, b]` style —
 * the form the fixtures already carry for `tags`, `notes` and `adr` (008).
 * Quoted items (`notes`/`adr` wikilinks, which contain `[[` and `]]`) are
 * JSON-escaped; bare tags need no quoting.
 */
export function flowList(items: string[], quote: boolean): string {
  const body = items.map((item) => (quote ? JSON.stringify(item) : item)).join(', ');
  return `[${body}]`;
}

interface Block {
  innerStart: number;
  innerEnd: number;
}

/**
 * Sets or removes known top-level keys in a note's frontmatter, line by line.
 * A string value sets the key (replacing an existing line or appending a new
 * one); `null` removes the key if present. Every line the change does not touch
 * stays byte-identical, so an unknown key, its comment or its exact spelling is
 * preserved. Both `\n` and `\r\n` line endings are tolerated and kept.
 */
export function applyFrontmatter(content: string, change: FrontmatterChange): string {
  const sets = Object.entries(change).filter((e): e is [string, string] => e[1] !== null);
  const clears = Object.entries(change)
    .filter((e) => e[1] === null)
    .map(([key]) => key);

  const block = findBlock(content);
  if (!block) {
    if (sets.length === 0) return content;
    const nl = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = sets.map(([key, value]) => `${key}: ${value}`).join(nl);
    return `---${nl}${lines}${nl}---${nl}${content}`;
  }

  const before = content.slice(0, block.innerStart);
  const inner = content.slice(block.innerStart, block.innerEnd);
  const after = content.slice(block.innerEnd);

  return before + editInner(inner, new Map(sets), new Set(clears)) + after;
}

function editInner(inner: string, sets: Map<string, string>, clears: Set<string>): string {
  const nl = inner.includes('\r\n') ? '\r\n' : '\n';
  const lines = inner.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out: string[] = [];
  const applied = new Set<string>();
  // A key we set or clear may hold a multi-line YAML block sequence rather
  // than the flow style this module writes (Obsidian's own link-follow
  // rewrites a list this way on rename, F036 K4). Its indented `- item`
  // continuation lines carry no key of their own, so once the key's line is
  // replaced or dropped, its old continuation must go with it — otherwise it
  // survives as dangling, unparseable text under the new line.
  let skipContinuation = false;

  for (const line of lines) {
    if (skipContinuation) {
      if (isContinuation(line)) continue;
      skipContinuation = false;
    }
    const key = topLevelKey(line);
    if (key === undefined) {
      out.push(line);
      continue;
    }
    if (clears.has(key)) {
      skipContinuation = true;
      continue;
    }
    if (sets.has(key)) {
      out.push(`${key}: ${sets.get(key) as string}${terminator(line, nl)}`);
      applied.add(key);
      skipContinuation = true;
      continue;
    }
    out.push(line);
  }

  for (const [key, value] of sets) {
    if (applied.has(key)) continue;
    out.push(`${key}: ${value}${nl}`);
  }

  return out.join('');
}

function topLevelKey(line: string): string | undefined {
  const match = /^([A-Za-z0-9_][\w-]*)\s*:/.exec(line);
  return match ? match[1] : undefined;
}

function isContinuation(line: string): boolean {
  return /^[ \t]+\S/.test(line);
}

function terminator(line: string, fallback: string): string {
  if (line.endsWith('\r\n')) return '\r\n';
  if (line.endsWith('\n')) return '\n';
  return fallback;
}

function findBlock(content: string): Block | undefined {
  const open = /^---[ \t]*\r?\n/.exec(content);
  if (!open) return undefined;
  const innerStart = open[0].length;
  const close = /(\r?\n)---[ \t]*(\r?\n|$)/.exec(content.slice(innerStart));
  if (!close) return undefined;
  return { innerStart, innerEnd: innerStart + close.index + close[1].length };
}
