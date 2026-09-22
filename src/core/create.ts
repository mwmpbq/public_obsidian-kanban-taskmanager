import type { ElementType } from './model';

export interface NewElement {
  type: ElementType;
  title: string;
  status: string;
  project?: string;
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
 * Folder and `_` note of a nested element under `parentFolder` (root, epic,
 * or feature folder).
 */
export function nestedPaths(
  parentFolder: string,
  title: string,
  today: string,
): { folder: string; note: string } {
  const name = baseName(title, today);
  const folder = join(parentFolder, name);
  return { folder, note: `${folder}/_${name}.md` };
}

/** Note path of an atomic task: a note in `_Tasks/Atomic/`, no folder. */
export function atomicNotePath(title: string, today: string): string {
  return `_Tasks/Atomic/${baseName(title, today)}.md`;
}

/**
 * Frontmatter of a new note: `type`, `title`, `status`, optional `project`.
 * No `ticket` (that turns the card into an ADO card), no empty fields.
 */
export function noteContent(el: NewElement): string {
  const lines = [`type: ${el.type}`, `title: ${el.title}`, `status: ${el.status}`];
  if (el.project) lines.push(`project: ${el.project}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

/**
 * Target path when an atomic task is filed under `parentFolder`: the
 * previous file name (date plus slug) becomes the folder name, the note
 * becomes the `_` note inside it. Identity stays, content is untouched.
 */
export function embedAtomicTarget(
  atomicPath: string,
  parentFolder: string,
): { folder: string; note: string } {
  const name = fileStem(atomicPath);
  const folder = join(parentFolder, name);
  return { folder, note: `${folder}/_${name}.md` };
}

/**
 * Target path after a title change: date and ticket prefix of the name stay,
 * only the slug follows the new title. A nested element (note `_<base>.md`
 * in a folder of the same name) renames both folder and note, an atomic task
 * only its file (008 S21).
 */
export function renameTarget(
  notePath: string,
  newTitle: string,
): { folder?: string; note: string } {
  const slug = slugify(newTitle);
  const file = fileStem(notePath);
  if (file.startsWith('_')) {
    const dir = dirOf(notePath);
    const newBase = replaceSlug(fileStem(dir), slug);
    const folder = join(dirOf(dir), newBase);
    return { folder, note: `${folder}/_${newBase}.md` };
  }
  const newBase = replaceSlug(file, slug);
  return { note: join(dirOf(notePath), `${newBase}.md`) };
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
