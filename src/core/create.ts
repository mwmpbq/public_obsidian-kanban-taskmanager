import { yamlScalar } from './frontmatter';
import type { ElementType } from './model';

export interface NewElement {
  /** `ktm_id` (011 S54); the caller draws a fresh one via `core/ids#newId`. */
  id: string;
  type: ElementType;
  title: string;
  status: string;
  /** Always written now (011, Pflichtfeld); `"intern"` for an element without a real project. */
  project: string;
  /** Anlagedatum (011 S58/S63), `YYYY-MM-DD`. */
  created: string;
  /** `ktm_id` des Elternteils, nur wenn gesetzt (011, wissen #686). */
  parent?: string;
  /** Wikilink auf die Notiz des Elternteils, nur wenn `parent` gesetzt ist. */
  parentLink?: string;
}

/**
 * `[[<linktext>|<Titel>]]`, Obsidians eigene Alias-Schreibweise (DESIGN.md
 * §Datenform, "Verknüpfung (frei)"): the one place every `parent_link` writer
 * builds the alias, so a title change is reflected consistently everywhere
 * (011, Ergänzung 2026-09-25, "parent_link wird mitgepflegt"). A title
 * containing `|`, `[` or `]` would break the wikilink syntax itself, so the
 * alias is dropped for it (011, wissen #790 — the same characters yamlScalar
 * already has to quote around).
 */
export function formatParentLink(linktext: string, title: string): string {
  if (/[|[\]]/.test(title)) return `[[${linktext}]]`;
  return `[[${linktext}|${title}]]`;
}

export interface ParentChoice {
  label: string;
  folder: string;
  project?: string;
}

/**
 * Folder- and file-name slug of a title: lower case, apostrophes dropped, every
 * run of non-alphanumerics collapsed to a single hyphen, trimmed. Matches the
 * existing vault naming (`pipeline-fehler-bei-leeren-dateien`).
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/['’‘´`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** `YYYY-MM-DD_<slug>`, the shared base for a folder and its `_`-note. */
export function baseName(title: string, today: string): string {
  return `${today}_${slugify(title)}`;
}

/**
 * Folder and note of a nested element under `parentFolder` (root, epic, or
 * feature folder); the note carries no leading underscore anymore (011,
 * "Einen führenden Unterstrich schreibt das Plugin nicht mehr"). `taken` is
 * the set of names already used in `parentFolder` (008 S28/S48, F068 K4):
 * the folder's base name is made unique against it via {@link uniqueName}
 * before either path is built, so a second same-day, same-title draft gets
 * `<base>-2` instead of colliding with the first one's folder.
 */
export function nestedPaths(
  parentFolder: string,
  title: string,
  today: string,
  taken: Iterable<string> = [],
): { folder: string; note: string } {
  const name = uniqueName(baseName(title, today), taken);
  const folder = join(parentFolder, name);
  return { folder, note: `${folder}/${name}.md` };
}

/**
 * Note path of an atomic task: a note in `_Tasks/Atomic/`, no folder. `taken`
 * is the set of note stems (without `.md`) already used there (F068 K4),
 * made unique the same way as {@link nestedPaths}.
 */
export function atomicNotePath(title: string, today: string, taken: Iterable<string> = []): string {
  return `_Tasks/Atomic/${uniqueName(baseName(title, today), taken)}.md`;
}

/**
 * The ordered field set of a new note (011 S58/S63): `ktm_id`, `type`,
 * `title`, `status`, `project` (Pflichtfelder, `project` always written,
 * `"intern"` for an element without a real one), `created`, then `parent`
 * and `parent_link` only when set (wissen #686 — a cleared/absent parent has
 * no line at all, not `parent: null`). No `ticket` (that turns the card into
 * an ADO card).
 */
export function elementFields(el: NewElement): [string, string][] {
  const fields: [string, string][] = [
    ['ktm_id', el.id],
    ['type', el.type],
    ['title', yamlScalar(el.title)],
    ['status', el.status],
    ['project', el.project],
    ['created', el.created],
  ];
  if (el.parent) fields.push(['parent', yamlScalar(el.parent)]);
  if (el.parentLink) fields.push(['parent_link', yamlScalar(el.parentLink)]);
  return fields;
}

/** Frontmatter block of a new note, from {@link elementFields}. */
export function noteContent(el: NewElement): string {
  const lines = elementFields(el).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

/**
 * Target path after a title change (Ablageregel 3, off by default): date and
 * ticket prefix of the name stay, only the slug follows the new title. An
 * element that owns its folder (`ownsFolder`, core/refile.ts) renames both
 * folder and note, in step; any other element — an atomic task, or a nested
 * one sharing its folder with another element note — renames only its own
 * file (011, "Die Zielnotiz behält ihren Dateinamen statt _<base>.md" no
 * longer applies once the title itself is what changed).
 */
export function renameTarget(
  notePath: string,
  newTitle: string,
  ownsFolder: boolean,
): { folder?: string; note: string } {
  const slug = slugify(newTitle);
  if (ownsFolder) {
    const dir = dirOf(notePath);
    const newBase = replaceSlug(fileStem(dir), slug);
    const folder = join(dirOf(dir), newBase);
    return { folder, note: `${folder}/${newBase}.md` };
  }
  const newBase = replaceSlug(fileStem(notePath), slug);
  return { note: join(dirOf(notePath), `${newBase}.md`) };
}

export interface AdoptProposal {
  title: string;
  project: string;
  status: string;
  type: string;
}

const H1_PATTERN = /^#\s+(.+?)\s*$/m;

/**
 * Suggestions for "Als Aufgabe übernehmen" (011 S64): title from the body's
 * first H1, else the file name; project from the longest configured root
 * that prefixes the note's own folder, else `intern`; status the project's
 * first column; level the project's bottom one. Plain data in, plain data
 * out, so this is provable without Obsidian (F088).
 */
export function adoptProposal(
  notePath: string,
  body: string,
  projects: { key: string; root: string }[],
  levelsFor: (project: string) => { key: string }[],
  columnsFor: (project: string) => { status: string }[],
): AdoptProposal {
  const match = H1_PATTERN.exec(body);
  const title = match ? match[1] : fileStem(notePath);
  const folder = dirOf(notePath);
  let project = 'intern';
  let bestRootLength = -1;
  for (const p of projects) {
    const root = p.root.replace(/\/+$/, '');
    if (!root) continue;
    if ((folder === root || folder.startsWith(`${root}/`)) && root.length > bestRootLength) {
      project = p.key;
      bestRootLength = root.length;
    }
  }
  const levels = levelsFor(project);
  const columns = columnsFor(project);
  return {
    title,
    project,
    status: columns[0]?.status ?? '',
    type: levels[levels.length - 1]?.key ?? 'task',
  };
}

// Folder/file base is `<date>[_<ticket>]_<slug>`, all parts separated by
// underscores, and the slug is always the last segment (slugify replaces
// underscores with hyphens). So everything before the slug stays intact.
function replaceSlug(base: string, slug: string): string {
  const prefix = base.split('_').slice(0, -1).join('_');
  return prefix ? `${prefix}_${slug}` : slug;
}

/**
 * Unique name among ones already taken: if `base` is free, it stays; otherwise
 * the first free `base-2`, `base-3`, … (008 S28).
 */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = taken instanceof Set ? taken : new Set(taken);
  if (!set.has(base)) return base;
  let n = 2;
  while (set.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Folder for new notes and ADRs of an element: its own folder, except for
 * an atomic task, whose attachments live in `_Tasks/Notes/` because everything
 * under `_Tasks/Atomic/` is read as a task (008 S27).
 */
export function linkFolder(elementNotePath: string): string {
  if (elementNotePath.startsWith('_Tasks/Atomic/')) return '_Tasks/Notes';
  return dirOf(elementNotePath);
}

/** Path of a new note under `folder`, named after its title (008 S27). */
export function noteTarget(folder: string, title: string): string {
  return join(folder, `${title}.md`);
}

/**
 * File and skeleton content of a new ADR under `folder`: `ADR_<date>_<slug>.md`
 * with the sections `Kontext`, `Entscheidung`, `Folgen` (008 addendum ADR note).
 */
export function adrTarget(
  folder: string,
  title: string,
  date: string,
): { path: string; content: string } {
  const name = `ADR_${date}_${slugify(title)}`;
  return { path: join(folder, `${name}.md`), content: adrSkeleton(title) };
}

function adrSkeleton(title: string): string {
  return `# ${title}\n\n## Kontext\n\n## Entscheidung\n\n## Folgen\n`;
}

function join(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function fileStem(path: string): string {
  const cut = path.lastIndexOf('/');
  const file = cut === -1 ? path : path.slice(cut + 1);
  return file.endsWith('.md') ? file.slice(0, -3) : file;
}
