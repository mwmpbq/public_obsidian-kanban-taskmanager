import type { LinkResolver } from './check';
import { isValidId } from './ids';
import type {
  BoardElement,
  Checklist,
  ElementType,
  FileEntry,
  FreeLink,
  ParentRef,
  ProjectRoot,
} from './model';
import { bottomLevel, DEFAULT_LEVELS, type Level, type LinkKind, resolveLinkKinds, RESULT_LINK_KIND } from './settings';

const RESULT_KEY = RESULT_LINK_KIND.key;

const ATOMIC_PREFIX = '_Tasks/Atomic/';
const DEFAULT_PRIORITY = 3;
// The literal `project` value an element without a real project carries
// (011, "Bedeutung ... intern ist ein Projekt", Wissen #589): normalized away
// to `undefined` on a *valid* element, so the existing "intern" chip and
// filters keep working unchanged.
const INTERNAL_PROJECT = 'intern';

/** Resolves the level list a project's `type` values are checked against (Wissen #536). */
export type LevelsFor = (project: string) => Level[];

const defaultLevelsFor: LevelsFor = () => DEFAULT_LEVELS;

/**
 * Resolves the free link kinds a project's notes are parsed and rendered
 * with (F052): a per-project `ktm_link_kinds` list, or the general one.
 */
export type LinkKindsFor = (project: string) => LinkKind[];

const defaultLinkKindsFor: LinkKindsFor = () => resolveLinkKinds();

// A candidate that passed field validation: the finished element (parents
// still empty) plus what parent resolution needs and cannot read back from
// `BoardElement` alone — the *unnormalized* `project` value (levelsFor keys
// on it, not on the "intern" → undefined display value) and the raw
// frontmatter, to follow this element's own `parent` field one step further
// up the chain.
interface Resolved {
  element: BoardElement;
  entry: FileEntry;
  rawProject: string;
}

/**
 * Resolves file entries and project roots into the task-level board model.
 * An element is any note whose frontmatter carries `ktm_id` (011 S54); name,
 * folder and project root carry no meaning. `read` narrows {@link
 * readElements} to the bottom level of each element's own project.
 */
export function read(
  entries: FileEntry[],
  roots: ProjectRoot[],
  linkKindsFor: LinkKindsFor = defaultLinkKindsFor,
  levelsFor: LevelsFor = defaultLevelsFor,
): BoardElement[] {
  return readElements(entries, roots, linkKindsFor, levelsFor).filter((el) => {
    if (el.invalid) return true;
    const bottom = bottomLevel(levelsFor(el.project ?? INTERNAL_PROJECT));
    return bottom?.key === el.type;
  });
}

/**
 * Like {@link read}, but emits every level as a card, so the board can show
 * any of them. Identity, pflichtfelder and hierarchy all come from the
 * frontmatter alone (011): `ktm_id` marks an element, `parent` names its
 * ancestor's `ktm_id`, `project` its project's key or `intern`. A project's
 * own note (`ktm_project`) is never an element, regardless of its name or
 * location (Wissen #758).
 */
export function readElements(
  entries: FileEntry[],
  roots: ProjectRoot[],
  linkKindsFor: LinkKindsFor = defaultLinkKindsFor,
  levelsFor: LevelsFor = defaultLevelsFor,
): BoardElement[] {
  const projectKeys = new Set(roots.map((r) => r.key));
  projectKeys.add(INTERNAL_PROJECT);

  const { winners, invalid } = splitDuplicates(entries, projectKeys);

  const idIndex = new Map<string, Resolved>();
  const invalidResults: BoardElement[] = [...invalid];
  for (const entry of winners) {
    const outcome = validateFields(entry, projectKeys, roots, levelsFor, linkKindsFor);
    if (outcome.ok) idIndex.set(outcome.resolved.element.id, outcome.resolved);
    else invalidResults.push(outcome.element);
  }

  const result: BoardElement[] = [...invalidResults];
  for (const resolved of idIndex.values()) {
    const { parents, notice } = resolveParents(resolved, idIndex, levelsFor);
    resolved.element.parents = parents;
    if (notice) resolved.element.notice = notice;
    result.push(resolved.element);
  }
  return result;
}

/**
 * Splits every `ktm_id` candidate (any note whose frontmatter carries the
 * key, project notes excluded, Wissen #758) into the one winner per id — the
 * oldest by `created`, then `ctime`, then path (011 S59) — and the rest,
 * already turned into "Kennung doppelt" invalid cards.
 */
function splitDuplicates(
  entries: FileEntry[],
  projectKeys: Set<string>,
): { winners: FileEntry[]; invalid: BoardElement[] } {
  const groups = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    const raw = entry.frontmatter.ktm_id;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    if (typeof entry.frontmatter.ktm_project === 'string') continue;
    const list = groups.get(raw) ?? [];
    list.push(entry);
    groups.set(raw, list);
  }

  const winners: FileEntry[] = [];
  const invalid: BoardElement[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      winners.push(group[0]);
      continue;
    }
    const sorted = [...group].sort(compareForDuplicate);
    winners.push(sorted[0]);
    for (const loser of sorted.slice(1)) {
      invalid.push(invalidElement(loser, 'Kennung doppelt', projectKeys, true));
    }
  }
  return { winners, invalid };
}

// Oldest wins (011 S59): `created` ascending, a missing one counting as
// younger than any real date; then file creation time; then path, both
// ascending, for a fully deterministic order.
function compareForDuplicate(a: FileEntry, b: FileEntry): number {
  const ca = text(a.frontmatter.created);
  const cb = text(b.frontmatter.created);
  if (ca !== cb) {
    if (!ca) return 1;
    if (!cb) return -1;
    return ca < cb ? -1 : 1;
  }
  const ta = a.ctime ?? Number.POSITIVE_INFINITY;
  const tb = b.ctime ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta - tb;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

type FieldOutcome = { ok: true; resolved: Resolved } | { ok: false; element: BoardElement };

/**
 * Checks the pflichtfelder (011): `ktm_id` in the allowed format, `type`,
 * `title` and `status` non-empty, `project` a known project key or `intern`,
 * `type` a level of that project. Every miss is named in `invalidReason`
 * (K10-K13); the title of an invalid card is always the file name, never a
 * fallback derived from H1, folder or root (011 S15, no longer read at all).
 */
function validateFields(
  entry: FileEntry,
  projectKeys: Set<string>,
  roots: ProjectRoot[],
  levelsFor: LevelsFor,
  linkKindsFor: LinkKindsFor,
): FieldOutcome {
  const fm = entry.frontmatter;
  const id = text(fm.ktm_id);
  const idPresent = id.trim() !== '';
  const missing: string[] = [];
  if (!idPresent) missing.push('ktm_id');

  const title = text(fm.title);
  if (!title.trim()) missing.push('title');

  const status = text(fm.status);
  if (!status.trim()) missing.push('status');

  const rawProject = text(fm.project);
  const projectKnown = rawProject.trim() !== '' && projectKeys.has(rawProject);
  if (!projectKnown) missing.push('project');

  const typeRaw = elementType(fm.type);
  const typeKnown = typeRaw !== undefined && projectKnown && levelsFor(rawProject).some((l) => l.key === typeRaw);
  if (typeRaw === undefined || (projectKnown && !typeKnown)) missing.push('type');

  // A *present* but syntactically malformed ktm_id (011, Ergänzung
  // 2026-09-25, "Kennungsregeln") gets its own reason instead of joining the
  // generic Pflichtfeld list under the field name "ktm_id"; a missing ktm_id
  // (idPresent false, already in `missing` above) keeps the old wording.
  if (idPresent && !isValidId(id)) {
    const reason =
      missing.length > 0
        ? `Kennung ungültig; Pflichtfeld fehlt oder ungültig: ${missing.join(', ')}`
        : 'Kennung ungültig';
    return { ok: false, element: invalidElement(entry, reason, projectKeys) };
  }

  if (missing.length > 0) {
    return {
      ok: false,
      element: invalidElement(entry, `Pflichtfeld fehlt oder ungültig: ${missing.join(', ')}`, projectKeys),
    };
  }

  const form = isAtomic(entry.path) ? 'atomic' : 'nested';
  const project = rawProject === INTERNAL_PROJECT ? undefined : rawProject;
  const element: BoardElement = {
    id,
    type: typeRaw!,
    form,
    ...common(entry, title, project, linkKindsFor(rawProject)),
    parents: [],
    paths: form === 'atomic' ? { note: entry.path } : { note: entry.path, folder: dirOf(entry.path) },
  };
  if (computeOwnFolder(entry.path, form, rawProject, roots)) element.ownFolder = true;
  // 011, Ergänzung 2026-10-19 "ktm_placement": any value but the literal
  // string `auto` reads as `manual`, including `true`, `null` (an empty
  // value) or an unrecognized word — only a missing key stays `auto`. The
  // plugin never rewrites the value itself (ktm:check reports it instead).
  if (Object.hasOwn(fm, 'ktm_placement') && text(fm.ktm_placement) !== 'auto') element.placement = 'manual';
  return { ok: true, resolved: { element, entry, rawProject } };
}

// A `_`-note or atomic note without valid pflichtfelder, or one whose
// `ktm_id` collides with an older file, is surfaced rather than dropped: the
// board shows it as an invalid card whose title is the file name, so the
// problem is visible instead of silently missing. Carries `project` (011 S98,
// F123) when the frontmatter names a known, non-`intern` project, so the card
// sorts into that project's view and the "all" view's project chip — `intern`,
// an unknown project, or none at all leave it project-less, same as a valid
// element without one (011 S99). `status` keeps its raw, trimmed value (011
// S100) instead of always reading empty, so board.ts can place the card in
// the column its status actually names.
function invalidElement(
  entry: FileEntry,
  reason: string,
  projectKeys: Set<string>,
  duplicate = false,
): BoardElement {
  const form = isAtomic(entry.path) ? 'atomic' : 'nested';
  const rawProject = text(entry.frontmatter.project).trim();
  const project =
    rawProject && rawProject !== INTERNAL_PROJECT && projectKeys.has(rawProject) ? rawProject : undefined;
  return {
    id: text(entry.frontmatter.ktm_id),
    // Fixed to the bottom level's usual key so an invalid card keeps showing
    // in the default (bottom-level) view regardless of its own `type` field,
    // matching the pre-011 behavior invalid cards always relied on.
    type: 'task',
    form,
    title: baseName(entry.path),
    status: text(entry.frontmatter.status).trim(),
    project,
    priority: DEFAULT_PRIORITY,
    tags: [],
    parents: [],
    links: [],
    paths: form === 'atomic' ? { note: entry.path } : { note: entry.path, folder: dirOf(entry.path) },
    invalid: true,
    invalidReason: reason,
    ...(duplicate ? { duplicate: true } : {}),
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
  | 'started'
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
    started: dateField(fm.started),
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
// order of that field's list. Targets are the wikilink names Obsidian
// stores, stripped of an alias or heading suffix. Exported so the board can
// rederive a single open note's links from a fresh metadataCache frontmatter
// (F036), without a second parser.
//
// `results` is always read as a free link, whether or not it is among the
// configured `linkKinds` (002, Ergänzung 2026-10-19 "Result"): it is a fixed
// kind outside `linkKinds` (settings.ts#RESULT_LINK_KIND/withResultKind), so
// changes() and rebase() treat it like any other kind without a special case.
export function linksOf(fm: Record<string, unknown>, linkKinds: LinkKind[]): FreeLink[] {
  const kinds = linkKinds.some((k) => k.key === RESULT_KEY) ? linkKinds : [...linkKinds, RESULT_LINK_KIND];
  const links: FreeLink[] = [];
  for (const kind of kinds) {
    for (const raw of asList(fm[kind.key])) {
      const target = wikilinkTarget(raw);
      if (!target) continue;
      const alias = wikilinkAlias(raw);
      links.push(alias ? { kind: kind.key, target, alias } : { kind: kind.key, target });
    }
  }
  return links;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value) return [value];
  return [];
}

/**
 * The name a free link's row shows (002, Ergänzung 2026-10-06, "Notizname";
 * F107 K1; 002 Ergänzung 2026-10-19, F138 K1): with an alias (`[[target|alias]]`,
 * bracketed or not) the alias itself, unconditionally; otherwise the resolved
 * target file's own name without `.md`, or, unresolved, the link text's last
 * path segment without `.md` — never the raw linktext with its path.
 */
export function linkDisplayName(linktext: string, sourcePath: string, resolve: LinkResolver): string {
  const alias = wikilinkAlias(linktext);
  if (alias) return alias;
  const target = wikilinkTarget(linktext) ?? linktext;
  const resolved = resolve(target, sourcePath);
  return baseName(resolved ?? target);
}

function wikilinkTarget(raw: string): string | undefined {
  const match = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(raw);
  const inner = match ? match[1] : raw;
  return inner.split(/[|#]/)[0].trim() || undefined;
}

/** The alias half of a `[[target|alias]]` wikilink (002 S77), bracketed or not. */
function wikilinkAlias(raw: string): string | undefined {
  const match = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(raw);
  const inner = match ? match[1] : raw;
  const pipe = inner.indexOf('|');
  return pipe === -1 ? undefined : inner.slice(pipe + 1).trim() || undefined;
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
 * The element's parent chain, nearest first, resolved purely by `ktm_id`
 * (011 S57): `parent` names an ancestor's id; a dangling id, one that
 * resolves to a same-or-lower level, or one belonging to a different project
 * (011, Ergänzung 2026-10-19), yields no parent and a notice naming the
 * element's path and the offending value (K19). Climbing continues from
 * whichever ancestor was found, so a task's `parent` on a feature still
 * reaches the epic above it through the feature's own `parent` (K16).
 */
function resolveParents(
  resolved: Resolved,
  idIndex: Map<string, Resolved>,
  levelsFor: LevelsFor,
): { parents: ParentRef[]; notice?: string } {
  const parents: ParentRef[] = [];
  const seen = new Set<string>([resolved.element.id]);
  let current = resolved;
  let notice: string | undefined;
  let first = true;
  while (true) {
    const parentValue = text(current.entry.frontmatter.parent);
    if (!parentValue.trim()) break;
    const target = idIndex.get(parentValue);
    if (!target) {
      if (first) notice = `Unbekannter Parent „${parentValue}“: ${resolved.element.paths.note}`;
      break;
    }
    // A parent belonging to another project (011, Ergänzung 2026-10-19,
    // "Projektwechsel nimmt den Parent"): only checked against the element's
    // own project, so only the first step rejects it — an already-accepted
    // ancestor further up is never revisited here.
    if (first && target.rawProject !== resolved.rawProject) {
      notice = `Parent „${parentValue}“ gehört zu einem anderen Projekt: ${resolved.element.paths.note}`;
      break;
    }
    if (seen.has(target.element.id) || !isHigherLevel(target, current, levelsFor)) {
      // A known id, but on the same or a lower level, or closing a cycle
      // (011 K20): distinct from a dangling id, and naming the level so the
      // notice explains *why* the parent was rejected.
      if (first) {
        notice = `Parent „${parentValue}“ liegt nicht auf einer höheren Ebene: ${resolved.element.paths.note}`;
      }
      break;
    }
    seen.add(target.element.id);
    parents.push({
      id: target.element.id,
      type: target.element.type,
      title: target.element.title,
      note: target.element.paths.note,
      short: target.element.short,
    });
    current = target;
    first = false;
  }
  return { parents, notice };
}

function isHigherLevel(candidate: Resolved, child: Resolved, levelsFor: LevelsFor): boolean {
  const levels = levelsFor(child.rawProject);
  const candidateRank = levels.findIndex((l) => l.key === candidate.element.type);
  const childRank = levels.findIndex((l) => l.key === child.element.type);
  return candidateRank !== -1 && childRank !== -1 && candidateRank < childRank;
}

// Whether the note's folder lies outside its project's configured root (008,
// addendum 2026-09-20): purely for display (Ordner-Feld's "eigener Ordner"
// marker), never for identity or parent resolution.
function computeOwnFolder(
  entryPath: string,
  form: 'nested' | 'atomic',
  rawProject: string,
  roots: ProjectRoot[],
): boolean {
  if (form !== 'nested') return false;
  const root = roots.find((r) => r.key === rawProject)?.root;
  if (!root) return false;
  const normRoot = stripTrailingSlash(root);
  if (!normRoot) return false;
  const folder = dirOf(entryPath);
  return !(folder === normRoot || folder.startsWith(normRoot + '/'));
}

function isAtomic(path: string): boolean {
  return path.startsWith(ATOMIC_PREFIX);
}

function elementType(value: unknown): ElementType | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
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

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function baseName(path: string): string {
  const cut = path.lastIndexOf('/');
  const name = cut === -1 ? path : path.slice(cut + 1);
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}
