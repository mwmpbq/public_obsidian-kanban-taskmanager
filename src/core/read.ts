import type {
  BoardElement,
  Checklist,
  ElementType,
  FileEntry,
  FreeLink,
  ParentRef,
  ProjectRoot,
} from './model';
import { DEFAULT_LEVELS, type Level, type LinkKind, resolveLinkKinds } from './settings';

const ATOMIC_PREFIX = '_Tasks/Atomic/';
const ARCHIVE_SEGMENT = 'Archive';
const DONE_SEGMENT = 'Done';
const DEFAULT_PRIORITY = 3;

/** Resolves the level list a project's `type` values are checked against (Wissen #536). */
export type LevelsFor = (project: string) => Level[];

const defaultLevelsFor: LevelsFor = () => DEFAULT_LEVELS;

/**
 * Resolves the free link kinds a project's notes are parsed and rendered
 * with (F052): a per-project `ktm_link_kinds` list, or the general one.
 * Without this, a kind set only on one project (e.g. a `protocol` link on
 * Nimbus) would be written but never read back on that project's own cards.
 */
export type LinkKindsFor = (project: string) => LinkKind[];

const defaultLinkKindsFor: LinkKindsFor = () => resolveLinkKinds();

interface NestedNote {
  entry: FileEntry;
  type: ElementType;
  title: string;
  short?: string;
  project: string;
  /**
   * The project root's own key, independent of a `project` field override on
   * this note (008 S30/K2). Folder-based ancestor lookup keys on this, not on
   * `project`, so an element whose frontmatter overrides `project` still finds
   * ancestors that don't (#429). `undefined` for an own-folder element (008,
   * addendum 2026-09-20), which has no root-relative folder hierarchy.
   */
  rootKey?: string;
  folders: string[];
  logical: string[];
  ownFolder: boolean;
  /** Wikilink target of the `parent` field, if the note carries one (008 S29). */
  parentField?: string;
}

interface Collected {
  nested: NestedNote[];
  atomic: FileEntry[];
  invalid: FileEntry[];
  basenameIndex: Map<string, NestedNote>;
  folderIndex: Map<string, NestedNote>;
}

/**
 * Resolves file entries and project roots into the task-level board model.
 * Only `_`-notes below a project root, own-folder `_`-notes elsewhere (008,
 * addendum 2026-09-20) and notes in `_Tasks/Atomic/` are considered; epics
 * and features are indexed for parent resolution but never emitted here.
 * `Archive/` is ignored, `Done/` mirrors the open hierarchy.
 */
export function read(
  entries: FileEntry[],
  roots: ProjectRoot[],
  linkKindsFor: LinkKindsFor = defaultLinkKindsFor,
  levelsFor: LevelsFor = defaultLevelsFor,
): BoardElement[] {
  const { nested, atomic, invalid, basenameIndex, folderIndex } = collect(entries, roots, levelsFor);
  const result: BoardElement[] = [];

  for (const note of nested) {
    if (note.type !== 'task') continue;
    result.push(nestedElement(note, basenameIndex, folderIndex, levelsFor, linkKindsFor(note.project)));
  }
  for (const entry of atomic) {
    result.push(atomicElement(entry, linkKindsFor(text(entry.frontmatter.project))));
  }
  for (const entry of invalid) {
    result.push(invalidElement(entry));
  }

  return result;
}

/**
 * Like {@link read}, but emits epics and features as cards too, so the board
 * can show any level. Tasks are identical to {@link read}.
 */
export function readElements(
  entries: FileEntry[],
  roots: ProjectRoot[],
  linkKindsFor: LinkKindsFor = defaultLinkKindsFor,
  levelsFor: LevelsFor = defaultLevelsFor,
): BoardElement[] {
  const { nested, atomic, invalid, basenameIndex, folderIndex } = collect(entries, roots, levelsFor);
  const result: BoardElement[] = [];

  for (const note of nested) {
    result.push(nestedElement(note, basenameIndex, folderIndex, levelsFor, linkKindsFor(note.project)));
  }
  for (const entry of atomic) {
    result.push(atomicElement(entry, linkKindsFor(text(entry.frontmatter.project))));
  }
  for (const entry of invalid) {
    result.push(invalidElement(entry));
  }

  return result;
}

function collect(entries: FileEntry[], roots: ProjectRoot[], levelsFor: LevelsFor): Collected {
  const normRoots = roots
    .map((r) => ({ key: r.key, root: stripTrailingSlash(r.root) }))
    .sort((a, b) => b.root.length - a.root.length);

  const nested: NestedNote[] = [];
  const atomic: FileEntry[] = [];
  const invalid: FileEntry[] = [];

  for (const entry of entries) {
    if (isAtomic(entry.path)) {
      atomic.push(entry);
      continue;
    }
    const root = normRoots.find((r) => entry.path.startsWith(r.root + '/'));
    if (root) {
      const parts = entry.path.slice(root.root.length + 1).split('/');
      const fileName = parts[parts.length - 1];
      if (!fileName.startsWith('_')) continue;
      if (parts[0] === ARCHIVE_SEGMENT) continue;

      const type = elementType(entry.frontmatter.type);
      if (!type || !hasStatus(entry.frontmatter.status)) {
        invalid.push(entry);
        continue;
      }
      const folders = parts.slice(0, -1);
      const logical = folders[0] === DONE_SEGMENT ? folders.slice(1) : folders;
      const project = text(entry.frontmatter.project) || root.key;
      if (!levelsFor(project).some((l) => l.key === type)) {
        invalid.push(entry);
        continue;
      }
      nested.push({
        entry,
        type,
        title: titleOf(entry, folders[folders.length - 1] ?? ''),
        short: text(entry.frontmatter.short) || undefined,
        project,
        rootKey: root.key,
        folders,
        logical,
        ownFolder: false,
        parentField: parentFieldOf(entry.frontmatter.parent),
      });
      continue;
    }

    // No project root covers this note: an own-folder element (008, addendum
    // 2026-09-20) needs type, status and project all present, outside
    // `_Tasks/Atomic/` and any `Archive/` segment. Anything less is an
    // ordinary vault note this plugin doesn't own, left untouched (K4).
    const parts = entry.path.split('/');
    const fileName = parts[parts.length - 1];
    if (!fileName.startsWith('_') || parts.includes(ARCHIVE_SEGMENT)) continue;
    const type = elementType(entry.frontmatter.type);
    const project = text(entry.frontmatter.project);
    if (!type || !hasStatus(entry.frontmatter.status) || !project) continue;
    if (!levelsFor(project).some((l) => l.key === type)) {
      invalid.push(entry);
      continue;
    }
    nested.push({
      entry,
      type,
      title: titleOf(entry, fileName),
      short: text(entry.frontmatter.short) || undefined,
      project,
      rootKey: undefined,
      folders: [],
      logical: [],
      ownFolder: true,
      parentField: parentFieldOf(entry.frontmatter.parent),
    });
  }

  const basenameIndex = new Map<string, NestedNote>();
  const folderIndex = new Map<string, NestedNote>();
  for (const note of nested) {
    basenameIndex.set(baseName(note.entry.path), note);
    if (note.rootKey !== undefined) {
      folderIndex.set(folderKey(note.rootKey, note.logical), note);
    }
  }

  return { nested, atomic, invalid, basenameIndex, folderIndex };
}

function nestedElement(
  note: NestedNote,
  basenameIndex: Map<string, NestedNote>,
  folderIndex: Map<string, NestedNote>,
  levelsFor: LevelsFor,
  linkKinds: LinkKind[],
): BoardElement {
  const { parents, notice } = resolveParents(note, basenameIndex, folderIndex, levelsFor);
  const element: BoardElement = {
    type: note.type,
    form: 'nested',
    ...common(note.entry, note.title, note.project || undefined, linkKinds),
    parents,
    paths: { note: note.entry.path, folder: dirOf(note.entry.path) },
  };
  if (note.ownFolder) element.ownFolder = true;
  if (notice) element.notice = notice;
  return element;
}

function atomicElement(entry: FileEntry, linkKinds: LinkKind[]): BoardElement {
  if (elementType(entry.frontmatter.type) !== 'task' || !hasStatus(entry.frontmatter.status)) {
    return invalidElement(entry);
  }
  return {
    type: 'task',
    form: 'atomic',
    ...common(
      entry,
      titleOf(entry, baseName(entry.path)),
      text(entry.frontmatter.project) || undefined,
      linkKinds,
    ),
    parents: [],
    paths: { note: entry.path },
  };
}

// A `_`-note or atomic note without a valid `type` or without a `status` is
// surfaced rather than dropped: the board shows it as an invalid card whose
// title is the file name so the problem is visible instead of silently missing.
function invalidElement(entry: FileEntry): BoardElement {
  const nested = !isAtomic(entry.path);
  return {
    type: 'task',
    form: nested ? 'nested' : 'atomic',
    title: baseName(entry.path),
    status: '',
    priority: DEFAULT_PRIORITY,
    tags: [],
    parents: [],
    links: [],
    paths: nested ? { note: entry.path, folder: dirOf(entry.path) } : { note: entry.path },
    invalid: true,
  };
}

function common(
  entry: FileEntry,
  title: string,
  project: string | undefined,
  linkKinds: LinkKind[],
): Pick<
  BoardElement,
  | 'title'
  | 'status'
  | 'project'
  | 'priority'
  | 'planned'
  | 'due'
  | 'completed'
  | 'ticket'
  | 'summary'
  | 'tags'
  | 'checklist'
  | 'links'
  | 'order'
  | 'short'
> {
  const fm = entry.frontmatter;
  return {
    title,
    status: text(fm.status),
    project,
    priority: typeof fm.priority === 'number' ? fm.priority : DEFAULT_PRIORITY,
    planned: dateField(fm.planned),
    due: dateField(fm.due),
    completed: dateField(fm.completed),
    ticket: typeof fm.ticket === 'number' ? fm.ticket : undefined,
    summary: text(fm.summary) || undefined,
    tags: tagsOf(fm.tags),
    checklist: checklistOf(entry.body),
    links: linksOf(fm, linkKinds),
    order: typeof fm.order === 'number' ? fm.order : undefined,
    short: text(fm.short) || undefined,
  };
}

// Free links per configured kind, in the kinds' order, and within a kind in the
// order of that field's list (K1). Targets are the wikilink names Obsidian
// stores, stripped of an alias or heading suffix. Exported so the board can
// rederive a single open note's links from a fresh metadataCache frontmatter
// (F036), without a second parser.
export function linksOf(fm: Record<string, unknown>, linkKinds: LinkKind[]): FreeLink[] {
  const links: FreeLink[] = [];
  for (const kind of linkKinds) {
    for (const raw of asList(fm[kind.key])) {
      const target = wikilinkTarget(raw);
      if (target) links.push({ kind: kind.key, target });
    }
  }
  return links;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value) return [value];
  return [];
}

function wikilinkTarget(raw: string): string | undefined {
  const match = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(raw);
  const inner = match ? match[1] : raw;
  return inner.split(/[|#]/)[0].trim() || undefined;
}

function parentFieldOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return wikilinkTarget(value);
}

function checklistOf(body: string): Checklist | undefined {
  let done = 0;
  let total = 0;
  for (const line of body.split('\n')) {
    const match = /^\s*[-*+]\s+\[([ xX])\]\s/.exec(line);
    if (!match) continue;
    total++;
    if (match[1] !== ' ') done++;
  }
  return total === 0 ? undefined : { done, total };
}

/**
 * The element's parent chain, nearest first. The `parent` field wins over the
 * folder (008 S30/K2); without a field, the folder decides as before (K3).
 * Climbing continues from whichever ancestor was found, each step applying
 * the same rule, so a task's `parent` on a feature still reaches the epic
 * above it through the feature's own folder (K1).
 */
function resolveParents(
  note: NestedNote,
  basenameIndex: Map<string, NestedNote>,
  folderIndex: Map<string, NestedNote>,
  levelsFor: LevelsFor,
): { parents: ParentRef[]; notice?: string } {
  const { ancestor, notice } = immediateAncestor(note, basenameIndex, folderIndex, levelsFor);
  const parents: ParentRef[] = [];
  const seen = new Set<string>([note.entry.path]);
  let current = ancestor;
  while (current && !seen.has(current.entry.path)) {
    seen.add(current.entry.path);
    parents.push({ type: current.type, title: current.title, note: current.entry.path, short: current.short });
    current = immediateAncestor(current, basenameIndex, folderIndex, levelsFor).ancestor;
  }
  return { parents, notice };
}

// One step of parent resolution. A `parent` field that resolves to a known
// note of a strictly higher level wins; a field that is dangling or points at
// a same-or-lower level is rejected outright, with no fallback to the folder
// (K6): the field is an explicit statement of intent, wrong is not "ignore
// it". Without a field, the nearest ancestor `_`-note by folder decides (K3).
function immediateAncestor(
  note: NestedNote,
  basenameIndex: Map<string, NestedNote>,
  folderIndex: Map<string, NestedNote>,
  levelsFor: LevelsFor,
): { ancestor?: NestedNote; notice?: string } {
  const folderAncestor = nearestFolderAncestor(note, folderIndex);
  if (note.parentField === undefined) {
    return { ancestor: folderAncestor };
  }
  const fieldAncestor = basenameIndex.get(note.parentField);
  if (!fieldAncestor || !isHigherLevel(fieldAncestor, note, levelsFor)) {
    return {};
  }
  const notice =
    folderAncestor && folderAncestor.entry.path !== fieldAncestor.entry.path
      ? `Ordner passt nicht zum Parent: ${note.entry.path}`
      : undefined;
  return { ancestor: fieldAncestor, notice };
}

// Walks shorter folder prefixes until one names an indexed note (mirrors the
// pre-F049 loop over the whole chain, #368, #492); a gap where an
// intermediate folder carries no note of its own is skipped. Own-folder notes
// have no root-relative folder, so they never resolve an ancestor this way.
function nearestFolderAncestor(
  note: NestedNote,
  folderIndex: Map<string, NestedNote>,
): NestedNote | undefined {
  if (note.rootKey === undefined) return undefined;
  for (let i = note.logical.length - 1; i >= 1; i--) {
    const found = folderIndex.get(folderKey(note.rootKey, note.logical.slice(0, i)));
    if (found) return found;
  }
  return undefined;
}

function isHigherLevel(candidate: NestedNote, child: NestedNote, levelsFor: LevelsFor): boolean {
  const levels = levelsFor(child.project);
  const candidateRank = levels.findIndex((l) => l.key === candidate.type);
  const childRank = levels.findIndex((l) => l.key === child.type);
  return candidateRank !== -1 && childRank !== -1 && candidateRank < childRank;
}

function isAtomic(path: string): boolean {
  return path.startsWith(ATOMIC_PREFIX);
}

function elementType(value: unknown): ElementType | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function hasStatus(value: unknown): boolean {
  return text(value).trim() !== '';
}

function titleOf(entry: FileEntry, fallbackName: string): string {
  const title = entry.frontmatter.title;
  if (typeof title === 'string' && title.trim()) return title;
  const h1 = firstHeading(entry.body);
  if (h1) return h1;
  return stripDatePrefix(stripLeadingUnderscore(baseName(fallbackName)));
}

function firstHeading(body: string): string | undefined {
  const match = /^#\s+(.+?)\s*$/m.exec(body);
  return match ? match[1] : undefined;
}

function dateField(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function tagsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((t): t is string => typeof t === 'string');
  if (typeof value === 'string' && value) return [value];
  return [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function folderKey(rootKey: string, logical: string[]): string {
  return rootKey + ' ' + logical.join('/');
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function baseName(path: string): string {
  const cut = path.lastIndexOf('/');
  const name = cut === -1 ? path : path.slice(cut + 1);
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

function stripLeadingUnderscore(name: string): string {
  return name.startsWith('_') ? name.slice(1) : name;
}

function stripDatePrefix(name: string): string {
  return name.replace(/^\d{4}-\d{2}-\d{2}_/, '');
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}
