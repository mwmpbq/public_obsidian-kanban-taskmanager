import type { BoardElement } from './model';

/** Standard location of an atomic task without a folder (008, 011). */
export const ATOMIC_BASE = '_Tasks/Atomic';
const DONE_SEGMENT = 'Done';

export interface PlacementProject {
  key: string;
  root: string;
}

/** Whether an element's status counts as done; `undefined` for an unknown status (never reconciled, F066). */
export type IsDone = (element: BoardElement) => boolean | undefined;

type FolderMember = { id: string; parentId?: string };

/**
 * Who owns `folder`, among the element notes directly inside it (011,
 * Ergänzung 2026-09-25, "Ein Ordner gehört einem Element genau dann..."):
 * with one note, that note; with several, the one every other note names as
 * its `parent` — resolving the S91/S96 contradiction, since a single
 * adopted child sharing its parent's folder does not make that folder
 * ambiguous. `'ambiguous'` when no such note exists. `undefined` for an
 * empty folder.
 */
export function folderOwner(members: FolderMember[]): string | 'ambiguous' | undefined {
  if (members.length === 0) return undefined;
  if (members.length === 1) return members[0].id;
  const candidate = members.find((c) => members.every((n) => n.id === c.id || n.parentId === c.id));
  return candidate ? candidate.id : 'ambiguous';
}

function stripSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

/**
 * Roots, their `Done/` mirror, the atomic base and its own `Done/` mirror
 * never belong to an element (011, folderOwner): they hold many elements by
 * design, and moving one of them as "its own folder" would be wrong.
 */
export function isBaseFolder(folder: string, projects: PlacementProject[]): boolean {
  const norm = stripSlash(folder);
  if (norm === ATOMIC_BASE || norm === `${ATOMIC_BASE}/${DONE_SEGMENT}`) return true;
  for (const p of projects) {
    const root = stripSlash(p.root);
    if (!root) continue;
    if (norm === root || norm === `${root}/${DONE_SEGMENT}`) return true;
  }
  return false;
}

type FolderElement = Pick<BoardElement, 'id' | 'paths' | 'parents' | 'invalid' | 'duplicate'>;

function elementsIn(folder: string, elements: FolderElement[]): FolderMember[] {
  return elements
    .filter((e) => !e.invalid && !e.duplicate && e.paths.folder !== undefined && stripSlash(e.paths.folder) === folder)
    .map((e) => ({ id: e.id, parentId: e.parents[0]?.id }));
}

/**
 * Whether `folder` currently holds two or more element notes with no single
 * one of them as the common owner (011 S91): the two-notes-without-a-shared-
 * element case, distinct from the S96 one where a note's own note plus a
 * single adopted child both point at it.
 */
export function isAmbiguousFolder(
  folder: string | undefined,
  elements: FolderElement[],
  projects: PlacementProject[],
): boolean {
  if (!folder) return false;
  const norm = stripSlash(folder);
  if (isBaseFolder(norm, projects)) return false;
  return folderOwner(elementsIn(norm, elements)) === 'ambiguous';
}

/**
 * Whether `element`'s own note directory is unambiguously its own (011,
 * replaces the pre-011 refile.ts#ownsFolder): an atomic task never owns one;
 * a base folder (project root, its Done mirror, the atomic base) never
 * belongs to anyone; otherwise the folder's owner (see {@link folderOwner})
 * must be this element itself.
 */
export function ownsFolder(
  element: Pick<BoardElement, 'id' | 'form' | 'paths'>,
  elements: FolderElement[],
  projects: PlacementProject[],
): boolean {
  if (element.form === 'atomic') return false;
  const folder = element.paths.folder;
  if (!folder) return false;
  const norm = stripSlash(folder);
  if (isBaseFolder(norm, projects)) return false;
  return folderOwner(elementsIn(norm, elements)) === element.id;
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function baseName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

function join(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

/** The longest configured project root (or the atomic base) that prefixes `path`. */
function baseFor(path: string, projects: PlacementProject[]): string | undefined {
  if (path === ATOMIC_BASE || path.startsWith(`${ATOMIC_BASE}/`)) return ATOMIC_BASE;
  let best: string | undefined;
  for (const p of projects) {
    const root = stripSlash(p.root);
    if (!root) continue;
    if ((path === root || path.startsWith(`${root}/`)) && (!best || root.length > best.length)) best = root;
  }
  return best;
}

// Folds a fresh logical (not-yet-done) target back under `base`'s `Done/`
// mirror, or back out of it, without ever doubling the segment (mirrors
// core/done.ts#planDoneMove's own rule, 011 Ergänzung 2026-09-25 "Done ist
// Teil des Orts"): the target is derived from a base and its logical
// (non-done) relative path so a container that is itself already done (its
// own folder already sits under `Done/`) is not walked into twice.
function withDoneMirror(base: string, target: string, done: boolean): string {
  if (target === base || !target.startsWith(`${base}/`)) return target;
  const rel = target.slice(base.length + 1);
  const mirrored = rel === DONE_SEGMENT || rel.startsWith(`${DONE_SEGMENT}/`);
  const logical = mirrored ? rel.slice(DONE_SEGMENT.length + 1) : rel;
  if (!logical) return target;
  if (done) return mirrored ? target : join(base, join(DONE_SEGMENT, logical));
  return mirrored ? join(base, logical) : target;
}

/**
 * The unit a moved element drags along: its own folder when it owns one
 * (011, "Der Ordner wandert als Ganzes"), otherwise its bare note (an atomic
 * task, or a nested element sharing its folder as a non-owning co-tenant,
 * 011 S96).
 */
function ownUnit(element: BoardElement, elements: BoardElement[], projects: PlacementProject[]): string {
  if (element.form === 'atomic') return element.paths.note;
  if (ownsFolder(element, elements, projects)) return element.paths.folder ?? element.paths.note;
  return element.paths.note;
}

/**
 * The computed location of an element (011, Ergänzung 2026-09-25 "Der Ort
 * folgt dem Parent"): with a parent, the folder of the parent's own note,
 * wherever that lies; without one, the root of its project (nested) or,
 * for a folder-less element, the root as a bare note — the atomic base
 * counting equally as "at the place" there, so neither is ever a spurious
 * move target for the other. `undefined` for every case with no computed
 * location at all: an invalid or duplicate card, `ktm_placement: manual`,
 * an unresolved `parent` (an element carrying a notice, 011 S57), an
 * ambiguous own folder (S91), or a nested element without a parent whose
 * project has no root.
 */
export function computedLocation(
  element: BoardElement,
  elements: BoardElement[],
  projects: PlacementProject[],
  isDone: IsDone,
): string | undefined {
  if (element.invalid || element.duplicate) return undefined;
  if ((element.placement ?? 'auto') === 'manual') return undefined;
  if (element.notice !== undefined) return undefined;
  if (element.form !== 'atomic' && isAmbiguousFolder(element.paths.folder, elements, projects)) return undefined;

  const project = element.project ? projects.find((p) => p.key === element.project) : undefined;
  const root = project ? stripSlash(project.root) : undefined;
  // A project note with an explicit but empty ktm_root has no Standardablage
  // (011, Ergänzung 2026-09-25, "Leerer ktm_root"): a nested element of such
  // a project has no computed location at all, parent or not — it is never
  // moved by the plugin (distinct from "intern", where `project` itself is
  // undefined and the parent-folder branch below still applies unchanged).
  if (element.form !== 'atomic' && project && !root) return undefined;
  const done = isDone(element) === true;

  const parent = element.parents[0];
  if (parent) {
    const parentDir = dirOf(parent.note);
    const name = baseName(ownUnit(element, elements, projects));
    const target = join(parentDir, name);
    const base = baseFor(parentDir, projects);
    return base ? withDoneMirror(base, target, done) : target;
  }

  if (element.form === 'atomic') {
    // "Root und _Tasks/Atomic gelten beide als am Ort": whichever of the two
    // the note currently sits at (open or already Done-mirrored) is the base
    // the Done step below mirrors under, so toggling `done` never bounces an
    // atomic note between the two homes on its own (011 K10).
    const current = element.paths.note;
    const name = baseName(current);
    const atRoot = root !== undefined && current === join(root, name);
    const atRootDone = root !== undefined && current === join(root, join(DONE_SEGMENT, name));
    const atAtomicBase = current === join(ATOMIC_BASE, name);
    const atAtomicDone = current === join(ATOMIC_BASE, join(DONE_SEGMENT, name));
    const base = atRoot || atRootDone ? root! : atAtomicBase || atAtomicDone ? ATOMIC_BASE : (root ?? ATOMIC_BASE);
    return withDoneMirror(base, join(base, name), done);
  }

  if (!root) return undefined;
  const name = baseName(ownUnit(element, elements, projects));
  return withDoneMirror(root, join(root, name), done);
}

/** The element's own current location: its folder if it has (and owns) one, else its bare note. */
export function currentLocation(element: BoardElement, elements: BoardElement[], projects: PlacementProject[]): string {
  return ownUnit(element, elements, projects);
}

export interface HandMoveCandidate {
  id: string;
  oldPath: string;
  newPath: string;
}

export interface OwnMove {
  from: string;
  to: string;
}

/**
 * Which of `candidates` were moved by hand (011, Ergänzung 2026-09-25 "Von
 * Hand verschoben"): a rename whose directory actually changed, that is not
 * covered by one of the plugin's own recent moves ({@link OwnMove}, tracked
 * by adapters/obsidian.ts#moveElement), and that is not itself nested inside
 * another candidate's old directory — a child swept along inside its
 * parent's folder is not "moved by hand" on its own account.
 */
export function handMoved(candidates: HandMoveCandidate[], ownMoves: OwnMove[]): string[] {
  const isOwnMove = (oldPath: string, newPath: string): boolean =>
    ownMoves.some(
      (m) =>
        (oldPath === m.from || oldPath.startsWith(`${m.from}/`)) &&
        (newPath === m.to || newPath.startsWith(`${m.to}/`)),
    );

  const moved = candidates.filter((c) => {
    const oldDir = dirOf(c.oldPath);
    const newDir = dirOf(c.newPath);
    return oldDir !== newDir && !isOwnMove(c.oldPath, c.newPath);
  });

  return moved
    .filter((c) => {
      const oldDir = dirOf(c.oldPath);
      return !moved.some(
        (other) => other.id !== c.id && dirOf(other.oldPath) !== oldDir && c.oldPath.startsWith(`${dirOf(other.oldPath)}/`),
      );
    })
    .map((c) => c.id);
}

export interface PlacementFinding {
  path: string;
  reason: string;
}

/**
 * Findings for `ktm:check`'s placement section (011, Ergänzung 2026-09-25,
 * F099's narrow slice of the full F090 check): every note in an ambiguous
 * folder, and every `auto` element that does not currently sit at its
 * {@link computedLocation}.
 */
export function placementFindings(
  elements: BoardElement[],
  projects: PlacementProject[],
  isDone: IsDone,
): PlacementFinding[] {
  const findings: PlacementFinding[] = [];
  const groups = new Map<string, BoardElement[]>();
  for (const el of elements) {
    if (el.invalid || el.duplicate || el.form === 'atomic') continue;
    const folder = el.paths.folder;
    if (!folder) continue;
    const norm = stripSlash(folder);
    if (isBaseFolder(norm, projects)) continue;
    const list = groups.get(norm) ?? [];
    list.push(el);
    groups.set(norm, list);
  }
  for (const [folder, group] of groups) {
    if (group.length < 2) continue;
    const owner = folderOwner(group.map((e) => ({ id: e.id, parentId: e.parents[0]?.id })));
    if (owner !== 'ambiguous') continue;
    for (const el of group) findings.push({ path: el.paths.note, reason: `Ordner nicht eindeutig: ${folder}` });
  }

  for (const el of elements) {
    if (el.invalid || el.duplicate) continue;
    if ((el.placement ?? 'auto') !== 'auto') continue;
    const target = computedLocation(el, elements, projects, isDone);
    if (!target) continue;
    const current = currentLocation(el, elements, projects);
    if (target !== current) findings.push({ path: el.paths.note, reason: `liegt nicht am berechneten Ort: ${target}` });
  }
  return findings;
}
