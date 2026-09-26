import type { FrontmatterChange } from './frontmatter';
import { newId } from './ids';
import type { FileEntry, ProjectRoot } from './model';
import { computedLocation, type PlacementProject } from './placement';
import { readElements } from './read';
import { DEFAULT_LEVELS, type Level } from './settings';

const ATOMIC_PREFIX = '_Tasks/Atomic/';
const ARCHIVE_SEGMENT = 'Archive';
const DONE_SEGMENT = 'Done';

/** Resolves the level list a project's `type` values are checked against, same contract as read.ts. */
export type LevelsFor = (project: string) => Level[];

/**
 * True for the 0.0.1 form of an element note: a folder plus a `_`-note that
 * repeats the folder's name exactly, `_<Ordner>.md` (F098). A `_`-note
 * directly under a root has no containing folder to match and is never this
 * form; the `Done/`-mirror keeps the rule unchanged, since `Done/` is just
 * one more folder above the matching pair. `create.ts` no longer names new
 * notes this way (011), so this is a legacy-only check.
 */
export function isLegacyNoteName(parts: string[]): boolean {
  if (parts.length < 2) return false;
  const fileName = parts[parts.length - 1];
  const folderName = parts[parts.length - 2];
  return fileName === `_${folderName}.md`;
}

const defaultLevelsFor: LevelsFor = () => DEFAULT_LEVELS;

/** The fields planMigration writes for one element; only what was missing before (011, wissen #686). */
export interface MigrationFields {
  ktm_id: string;
  title?: string;
  project?: string;
  parent?: string;
  parent_link?: string;
  created?: string;
  /**
   * `auto` when the element already sits at its computed location once every
   * other planned field is applied, `manual` otherwise (011, Ergänzung
   * 2026-09-25, S94): filled in for every item before {@link planMigration}
   * returns, never left missing — the bestand's physical layout is never
   * touched by the migration itself.
   */
  ktm_placement?: 'auto' | 'manual';
}

export interface MigrationItem {
  path: string;
  fields: MigrationFields;
}

export interface MigrationPlan {
  /** One entry per note that gets `ktm_id` and the other missing pflichtfelder (011 S67). */
  items: MigrationItem[];
  /** How many items get a `parent` written (011 K2). */
  parentCount: number;
  /**
   * Paths of `_`-notes under a root that are skipped: without `type`/`status`
   * (`_index.md`, `_template.md`, 011 S67), or, without `ktm_id`, whose name
   * doesn't match its containing folder (`_overview.md` directly under a
   * root, F098 S54) — that second reason applies even with `type`/`status`
   * set, since such a note is never this note's own adoptable element.
   */
  skipped: string[];
}

interface LegacyCandidate {
  entry: FileEntry;
  /** Already carries `ktm_id`: only usable as a parent target, never gets its own item (011, umsetzung). */
  existingId?: string;
  rawProject: string;
  rootKey?: string;
  folders: string[];
  logical: string[];
  parentField?: string;
}

/**
 * Plans the one-time adoption of a 0.0.1-style bestand: every legacy `_`-note
 * below a project root and every note under `_Tasks/Atomic/` (011 S67,
 * porting the candidate rules of 393dee3:read.ts's `collect`). Only the
 * pflichtfelder a note is still missing are planned — `ktm_id`, and where
 * absent, `title`, `project`, `created`, `parent`/`parent_link` — so a second
 * run over already-migrated files (already carrying `ktm_id`) yields an empty
 * plan (S68). `taken` seeds the id pool so a caller's already-known ids are
 * never redrawn; every id this plan itself hands out is added to it too, so
 * two items in the same plan never collide.
 */
export function planMigration(
  entries: FileEntry[],
  roots: ProjectRoot[],
  levelsFor: LevelsFor = defaultLevelsFor,
  taken: ReadonlySet<string> = new Set(),
  today = localDate(Date.now()),
): MigrationPlan {
  const drawn = new Set(taken);
  const normRoots = roots
    .map((r) => ({ key: r.key, root: stripTrailingSlash(r.root) }))
    .sort((a, b) => b.root.length - a.root.length);

  const candidates: LegacyCandidate[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    if (isAtomic(entry.path)) {
      candidates.push(atomicCandidate(entry));
      continue;
    }
    const root = normRoots.find((r) => entry.path.startsWith(`${r.root}/`));
    if (!root) continue;
    const parts = entry.path.slice(root.root.length + 1).split('/');
    const fileName = parts[parts.length - 1];
    if (!fileName.startsWith('_')) continue;
    if (parts[0] === ARCHIVE_SEGMENT) continue;
    if (parts.length === 1 && typeof entry.frontmatter.ktm_project === 'string') continue;

    const existingId = existingKtmId(entry);
    if (
      !existingId &&
      (!hasText(entry.frontmatter.type) || !hasText(entry.frontmatter.status) || !isLegacyNoteName(parts))
    ) {
      skipped.push(entry.path);
      continue;
    }
    const folders = parts.slice(0, -1);
    const logical = folders[0] === DONE_SEGMENT ? folders.slice(1) : folders;
    candidates.push({
      entry,
      existingId,
      rawProject: text(entry.frontmatter.project) || root.key,
      rootKey: root.key,
      folders,
      logical,
      parentField: parentFieldOf(entry.frontmatter.parent),
    });
  }

  // Only root-based candidates can be a parent (393dee3:read.ts kept atomic
  // notes out of both indices the same way): an atomic task's own basename
  // never resolves another note's `parent` wikilink.
  const basenameIndex = new Map<string, LegacyCandidate>();
  const folderIndex = new Map<string, LegacyCandidate>();
  for (const candidate of candidates) {
    if (candidate.rootKey === undefined) continue;
    basenameIndex.set(baseName(candidate.entry.path), candidate);
    folderIndex.set(folderKey(candidate.rootKey, candidate.logical), candidate);
  }

  // Ids are assigned before parent resolution, so an ancestor that itself
  // needs migrating already has the id its children's `parent` will name.
  const idByPath = new Map<string, string>();
  for (const candidate of candidates) {
    if (candidate.existingId) {
      idByPath.set(candidate.entry.path, candidate.existingId);
      continue;
    }
    const id = newId(drawn);
    drawn.add(id);
    idByPath.set(candidate.entry.path, id);
  }

  const items: MigrationItem[] = [];
  let parentCount = 0;
  for (const candidate of candidates) {
    if (candidate.existingId) continue;
    const fields: MigrationFields = { ktm_id: idByPath.get(candidate.entry.path)! };

    if (!hasText(candidate.entry.frontmatter.title)) {
      fields.title = titleOf(candidate.entry, fallbackNameFor(candidate));
    }
    if (!hasText(candidate.entry.frontmatter.project)) {
      fields.project = candidate.rawProject;
    }
    if (!hasText(candidate.entry.frontmatter.created)) {
      fields.created = createdOf(candidate, today);
    }

    const ancestor = immediateAncestor(candidate, basenameIndex, folderIndex, levelsFor);
    if (ancestor) {
      fields.parent = idByPath.get(ancestor.entry.path) ?? ancestor.existingId;
      fields.parent_link = candidate.parentField
        ? rawParentValue(candidate.entry.frontmatter.parent)
        : `[[${baseName(ancestor.entry.path)}]]`;
      parentCount++;
    }

    items.push({ path: candidate.entry.path, fields });
  }

  assignPlacement(items, entries, roots, levelsFor);
  return { items, parentCount, skipped };
}

// S94 ("Migration setzt die Ablage, ohne zu verschieben"): simulates the
// bestand with every planned field applied — same entries, same paths,
// nothing moved — reads it back into BoardElements, and marks each item
// `auto` when it already sits at its own computedLocation, `manual`
// otherwise. Closed-ness uses only the two reserved status keys: migrate.ts
// has no project-specific column config to ask, and every fixture this
// covers (F089's legacy bestand) uses them directly.
function assignPlacement(
  items: MigrationItem[],
  entries: FileEntry[],
  roots: ProjectRoot[],
  levelsFor: LevelsFor,
): void {
  const fieldsByPath = new Map(items.map((item) => [item.path, item.fields]));
  const simulated = entries.map((entry) => {
    const fields = fieldsByPath.get(entry.path);
    if (!fields) return entry;
    const frontmatter: Record<string, unknown> = { ...entry.frontmatter, ktm_id: fields.ktm_id };
    if (fields.title !== undefined) frontmatter.title = fields.title;
    if (fields.project !== undefined) frontmatter.project = fields.project;
    if (fields.created !== undefined) frontmatter.created = fields.created;
    if (fields.parent !== undefined) frontmatter.parent = fields.parent;
    return { ...entry, frontmatter };
  });
  const elements = readElements(simulated, roots, undefined, levelsFor);
  const projects: PlacementProject[] = roots.map((r) => ({ key: r.key, root: r.root }));
  const isDone = (status: string): boolean => status === 'done' || status === 'wont-do';
  for (const item of items) {
    const element = elements.find((e) => e.paths.note === item.path);
    if (!element) continue;
    const target = computedLocation(element, elements, projects, (el) => isDone(el.status));
    const current = element.form === 'atomic' ? element.paths.note : (element.paths.folder ?? element.paths.note);
    item.fields.ktm_placement = target === current ? 'auto' : 'manual';
  }
}

/** Marks that a migrated item's `parent` field carried no value before the migration wrote it (011, Ergänzung 2026-09-25, "Übernahmeprotokoll"). */
export const NO_PREVIOUS_PARENT = 'fehlte';

export interface MigrationProtocolItem {
  path: string;
  /** Every key the migration itself wrote for this file, value as logically written (unquoted, wissen #686/#790). Always includes `ktm_id`. */
  written: Record<string, string>;
  /** The `parent` field's value right before the migration overwrote it, or {@link NO_PREVIOUS_PARENT}; present only when `written.parent` is set. */
  previousParent?: string;
}

export interface MigrationProtocol {
  items: MigrationProtocolItem[];
}

/**
 * Builds the undo protocol from the items a migration run actually wrote
 * (011, Ergänzung 2026-09-25): for each, every field it added (so undo knows
 * exactly what to remove again) and, where it touched `parent`, the value the
 * file carried right before — a wikilink, or {@link NO_PREVIOUS_PARENT} when
 * the field was absent (mirrors {@link MigrationFields.parent} always being
 * overwritten outright, unlike title/project/created which only fill a gap).
 * `entries` must be the pre-migration snapshot the items were planned against.
 */
export function migrationProtocol(items: MigrationItem[], entries: FileEntry[]): MigrationProtocol {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const protocolItems: MigrationProtocolItem[] = items.map((item) => {
    const written: Record<string, string> = {};
    for (const [key, value] of Object.entries(item.fields)) {
      if (typeof value === 'string') written[key] = value;
    }
    const protocolItem: MigrationProtocolItem = { path: item.path, written };
    if (item.fields.parent !== undefined) {
      const before = byPath.get(item.path)?.frontmatter.parent;
      protocolItem.previousParent = typeof before === 'string' && before.trim() !== '' ? before : NO_PREVIOUS_PARENT;
    }
    return protocolItem;
  });
  return { items: protocolItems };
}

export interface UndoConflict {
  path: string;
  key: string;
}

export interface UndoPlan {
  changes: { path: string; change: FrontmatterChange }[];
  conflicts: UndoConflict[];
}

/**
 * Plans "Übernahme rückgängig machen"/`ktm:migrate undo` (011, Ergänzung
 * 2026-09-25): for every protocol entry whose file still exists, each field
 * the migration wrote is removed again — `parent` restored to its recorded
 * previous value instead — as long as the field still carries exactly what
 * the migration put there; a value changed since is left untouched and
 * reported as a conflict (path, key) instead. A field the protocol never
 * mentions (e.g. a `due` set by hand afterwards) is never in `written` and
 * therefore never touched (wissen #686 applies the same way in reverse: the
 * restored `parent` is written as a real value or removed, never `null`
 * literally left dangling).
 */
export function planUndo(protocol: MigrationProtocol, entries: FileEntry[]): UndoPlan {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const changes: { path: string; change: FrontmatterChange }[] = [];
  const conflicts: UndoConflict[] = [];

  for (const item of protocol.items) {
    const entry = byPath.get(item.path);
    if (!entry) continue;
    const change: FrontmatterChange = {};
    for (const [key, writtenValue] of Object.entries(item.written)) {
      const current = entry.frontmatter[key];
      const currentText = typeof current === 'string' ? current : undefined;
      if (currentText !== writtenValue) {
        conflicts.push({ path: item.path, key });
        continue;
      }
      if (key === 'parent' && item.previousParent !== undefined) {
        change.parent = item.previousParent === NO_PREVIOUS_PARENT ? null : item.previousParent;
      } else {
        change[key] = null;
      }
    }
    if (Object.keys(change).length > 0) changes.push({ path: item.path, change });
  }

  return { changes, conflicts };
}

function atomicCandidate(entry: FileEntry): LegacyCandidate {
  return {
    entry,
    existingId: existingKtmId(entry),
    rawProject: text(entry.frontmatter.project),
    folders: [],
    logical: [],
  };
}

function existingKtmId(entry: FileEntry): string | undefined {
  const id = entry.frontmatter.ktm_id;
  return typeof id === 'string' && id.trim() !== '' ? id : undefined;
}

// The folder name, for a nested note (0.0.1's date/slug lives on the folder,
// not necessarily on the `_`-note inside it), otherwise the note's own
// basename (an atomic task has no containing folder to fall back on).
function fallbackNameFor(candidate: LegacyCandidate): string {
  return candidate.folders[candidate.folders.length - 1] ?? baseName(candidate.entry.path);
}

function createdOf(candidate: LegacyCandidate, today: string): string {
  const fromName = stripDatePrefixMatch(fallbackNameFor(candidate));
  if (fromName) return fromName;
  const ctime = candidate.entry.ctime;
  return typeof ctime === 'number' ? localDate(ctime) : today;
}

function stripDatePrefixMatch(name: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})_/.exec(name);
  return match ? match[1] : undefined;
}

// Local calendar date, never `toISOString` (that shifts the day across time
// zones, VERIFICATION.md/konventionen.md): the same getters `todayISO` uses.
function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function immediateAncestor(
  candidate: LegacyCandidate,
  basenameIndex: Map<string, LegacyCandidate>,
  folderIndex: Map<string, LegacyCandidate>,
  levelsFor: LevelsFor,
): LegacyCandidate | undefined {
  const folderAncestor = nearestFolderAncestor(candidate, folderIndex);
  if (candidate.parentField === undefined) return folderAncestor;
  const fieldAncestor = basenameIndex.get(candidate.parentField);
  if (!fieldAncestor || !isHigherLevel(fieldAncestor, candidate, levelsFor)) return undefined;
  return fieldAncestor;
}

function nearestFolderAncestor(
  candidate: LegacyCandidate,
  folderIndex: Map<string, LegacyCandidate>,
): LegacyCandidate | undefined {
  if (candidate.rootKey === undefined) return undefined;
  for (let i = candidate.logical.length - 1; i >= 1; i--) {
    const found = folderIndex.get(folderKey(candidate.rootKey, candidate.logical.slice(0, i)));
    if (found) return found;
  }
  return undefined;
}

function isHigherLevel(candidate: LegacyCandidate, child: LegacyCandidate, levelsFor: LevelsFor): boolean {
  const levels = levelsFor(child.rawProject);
  const candidateType = elementType(candidate.entry.frontmatter.type);
  const childType = elementType(child.entry.frontmatter.type);
  const candidateRank = candidateType ? levels.findIndex((l) => l.key === candidateType) : -1;
  const childRank = childType ? levels.findIndex((l) => l.key === childType) : -1;
  return candidateRank !== -1 && childRank !== -1 && candidateRank < childRank;
}

function isAtomic(path: string): boolean {
  return path.startsWith(ATOMIC_PREFIX);
}

function elementType(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const H1_PATTERN = /^#\s+(.+?)\s*$/m;

function titleOf(entry: FileEntry, fallbackName: string): string {
  const h1 = H1_PATTERN.exec(entry.body);
  if (h1) return h1[1];
  return stripDatePrefix(stripLeadingUnderscore(baseName(fallbackName)));
}

function parentFieldOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return wikilinkTarget(value);
}

function rawParentValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function wikilinkTarget(raw: string): string | undefined {
  const match = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(raw);
  const inner = match ? match[1] : raw;
  return inner.split(/[|#]/)[0].trim() || undefined;
}

function folderKey(rootKey: string, logical: string[]): string {
  return `${rootKey} ${logical.join('/')}`;
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
