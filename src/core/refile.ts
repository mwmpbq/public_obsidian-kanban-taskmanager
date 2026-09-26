import { canChangeLevel } from './board';
import { atomicNotePath, nestedPaths, renameTarget, uniqueName } from './create';
import type { DoneCandidate } from './done';
import { type FrontmatterChange, yamlScalar } from './frontmatter';
import type { BoardElement, ElementType, TaskForm } from './model';
import { ownsFolder } from './placement';
import type { Level } from './settings';

export interface RefileElement {
  form: TaskForm;
  type: ElementType;
  notePath: string;
  folderPath?: string;
}

/**
 * The changed fields of the enlarged card. `parentFolder` applies only to a
 * filed element (the target folder that a changed project or a changed
 * parent turns it into — resolving the label to a folder is the caller's
 * job, since it knows the whole vault); `project` only for an atomic task,
 * whose project is a frontmatter field.
 */
export interface RefileTarget {
  title?: string;
  type?: ElementType;
  project?: string;
  parentFolder?: string;
  missingRoot?: string;
}

export interface RefileMove {
  from: string;
  to: string;
  parent: string;
}

export interface RefilePlan {
  move?: RefileMove;
  frontmatter: FrontmatterChange;
  notePath: string;
  notice?: string;
  blocked?: string;
}

/**
 * The notice for a target root that does not exist in the vault (006 S43,
 * F071 K4/K5): a missing folder must not be created and nothing may be
 * written there. `exists` is asked with the root stripped of a trailing
 * slash, since the caller (folderExists) matches vault paths without one.
 */
export function missingRootNotice(root: string, exists: (root: string) => boolean): string | undefined {
  const normalized = root.replace(/\/+$/, '');
  if (exists(normalized)) return undefined;
  return `Root-Ordner „${normalized}“ fehlt im Vault, es wird nichts geschrieben.`;
}

/**
 * Builds the refile plan from the changed fields (title, project, level,
 * parent): renaming and moving collapse, when both apply, into a single
 * target path, because `FileManager.renameFile` changes folder name and
 * parent folder in one call (008 S21-S23, 002 S17-S19). A level change
 * that {@link canChangeLevel} refuses because of an existing child lands
 * as `notice` instead of a `type` field; all other field changes are
 * unaffected by that (K5). `taken` are the names already taken at the
 * target (008 S28); without a move or rename the name stays untouched,
 * so a `taken` that contains the element's own unchanged name can't
 * trigger a false collision. `target.missingRoot` (006 S43, F071 K4) short-
 * circuits every other field: the caller has already decided the target
 * root does not exist, so nothing is renamed and nothing is written, only
 * `blocked` carries the notice back. `ownsFolder` (default `true`, the
 * pre-011 shape every existing caller of this function assumes) decides
 * whether a nested element's whole folder is renamed/moved along, or only
 * its own note (011, "Ordner beim Einordnen ... mitziehen", {@link
 * ownsFolder}): an atomic task always moves only its note, regardless.
 */
export function planRefile(
  element: RefileElement,
  target: RefileTarget,
  children: BoardElement[],
  taken: Iterable<string> = [],
  ownsFolder = true,
): RefilePlan {
  if (target.missingRoot) {
    return { frontmatter: {}, notePath: element.notePath, blocked: target.missingRoot };
  }

  const frontmatter: FrontmatterChange = {};
  let notice: string | undefined;

  if (target.title) frontmatter.title = yamlScalar(target.title);
  if (target.type && target.type !== element.type) {
    const check = canChangeLevel({ type: element.type, paths: { note: element.notePath } }, target.type, children);
    if (check.ok) frontmatter.type = target.type;
    else notice = check.reason;
  }
  if (element.form === 'atomic' && target.project !== undefined) {
    // `project` is a Pflichtfeld (011): an atomic task without a chosen
    // project is `intern`, never a cleared field.
    frontmatter.project = target.project || 'intern';
  }

  if (element.form === 'atomic') {
    const notePath = target.title ? renameTarget(element.notePath, target.title, false).note : element.notePath;
    const move = notePath === element.notePath ? undefined : { from: element.notePath, to: notePath, parent: dirOf(notePath) };
    return { move, frontmatter, notePath, notice };
  }

  if (!ownsFolder) {
    // The folder is shared with another element note, or is a Root/Done/
    // Atomic segment (011): only this note itself moves and/or renames, the
    // folder — and whatever else lives in it — stays exactly where it is.
    const renamedNote = target.title ? renameTarget(element.notePath, target.title, false).note : element.notePath;
    let notePath = renamedNote;
    if (target.parentFolder !== undefined) {
      const stem = baseName(renamedNote).replace(/\.md$/, '');
      const takenStems = [...taken].map((name) => name.replace(/\.md$/, ''));
      notePath = `${target.parentFolder}/${uniqueName(stem, takenStems)}.md`;
    }
    const move =
      notePath === element.notePath ? undefined : { from: element.notePath, to: notePath, parent: dirOf(notePath) };
    return { move, frontmatter, notePath, notice };
  }

  const folderPath = element.folderPath ?? dirOf(element.notePath);
  const currentBase = baseName(folderPath);
  const currentParent = dirOf(folderPath);
  const renamed = target.title ? renameTarget(element.notePath, target.title, true) : undefined;
  const newBase = renamed ? baseName(renamed.folder ?? folderPath) : currentBase;
  const parentDir = target.parentFolder ?? currentParent;
  const moves = parentDir !== currentParent || newBase !== currentBase;
  const finalBase = moves ? uniqueName(newBase, taken) : currentBase;
  const finalFolder = join(parentDir, finalBase);
  // The note keeps its own file name unless the rename itself is what moved
  // it (011, "Die Zielnotiz behält ihren Dateinamen statt _<base>.md"): a
  // folder move alone never touches the note's file name.
  const finalNote = renamed ? `${finalFolder}/${finalBase}.md` : `${finalFolder}/${baseName(element.notePath)}`;
  const move = finalFolder === folderPath ? undefined : { from: folderPath, to: finalFolder, parent: parentDir };
  return { move, frontmatter, notePath: finalNote, notice };
}

export interface RefileRules {
  /** "Datei und Ordner beim Umbenennen des Titels mit umbenennen", Standard aus. */
  renameOnTitleChange: boolean;
}

const DEFAULT_REFILE_RULES: RefileRules = { renameOnTitleChange: false };

/**
 * The vault access a placement decision needs, handed in by the caller
 * (BoardView in Obsidian, a fixture-backed stand-in in tests) so the
 * decision itself — {@link resolveParentTarget}, {@link planDraftPlacement},
 * {@link planFiling} — stays plain TypeScript and is provable against the
 * fixture vault without a running Obsidian (F072, S23).
 */
export interface RefileEnv {
  projects: { key: string; name: string; root: string }[];
  elements: BoardElement[];
  levelsFor: (project: string) => Level[];
  rootExists: (root: string) => boolean;
  siblings: (folder: string) => string[];
  childrenOf: (element: BoardElement) => BoardElement[];
  /** Ablageregeln 2/3 (011); defaults to the Standard (moveFolder an, renameOnTitleChange aus). */
  rules?: RefileRules;
  /**
   * The finished wikilink text from an ancestor's note to a (possibly not
   * yet moved) source note, with the ancestor's `title` as alias
   * (adapters/obsidian.ts#parentLinkTo the way BoardView#refileEnv supplies
   * it, 011, Ergänzung 2026-09-25). Optional so a test env may omit it;
   * `planFiling` then writes `parent` alone, without `parent_link` (008 S38,
   * F088).
   */
  linkTo?: (targetNote: string, sourceNote: string, title: string) => string | undefined;
}

/**
 * The root folder an existing element physically sits under: the longest
 * configured project root that prefixes its own folder. Deliberately not
 * `element.project`, which a note may override (#540).
 */
export function projectRootForElement(
  element: BoardElement,
  projects: { root: string }[],
): string | undefined {
  const folder = element.paths.folder;
  if (!folder) return undefined;
  let best: string | undefined;
  for (const p of projects) {
    const root = p.root.replace(/\/+$/, '');
    if ((folder === root || folder.startsWith(`${root}/`)) && (!best || root.length > best.length)) {
      best = root;
    }
  }
  return best;
}

/**
 * The longest configured project root that prefixes a note's own path (not
 * its folder): the Done reconciliation's `base` for a nested element, since
 * an element already mirrored under `<root>/Done/...` has no folder prefixed
 * by the root itself once it's there — the note path always is.
 */
export function rootForPath(notePath: string, roots: { root: string }[]): string | undefined {
  return roots
    .map((r) => r.root.replace(/\/+$/, ''))
    .filter((root) => root && notePath.startsWith(`${root}/`))
    .sort((a, b) => b.length - a.length)[0];
}

/**
 * The candidate main.ts#fileByStatus needs for exactly one element's own,
 * just-applied status change (011, Ablageregel 1): `base` is the element's
 * root (or the atomic base), and {@link ownsFolder} decides whether its whole
 * folder may drag along or only its note — shared by BoardView and
 * SettingsTab so the two interactive paths that can change a status build
 * the same candidate.
 */
export function doneCandidateFor(
  element: Pick<BoardElement, 'id' | 'form' | 'paths' | 'completed'>,
  done: boolean | undefined,
  elements: Pick<BoardElement, 'id' | 'paths' | 'parents' | 'invalid' | 'duplicate'>[],
  roots: { root: string }[],
): DoneCandidate {
  const owns = element.form !== 'atomic' && ownsFolder(element, elements, roots.map((r) => ({ key: '', root: r.root })));
  const base = element.form === 'atomic' ? ATOMIC_BASE : (rootForPath(element.paths.note, roots) ?? '');
  return {
    form: owns ? element.form : 'atomic',
    notePath: element.paths.note,
    folderPath: element.paths.folder,
    base,
    done,
    completed: element.completed,
  };
}

/**
 * Resolves a parentLabel to both the ancestor's folder (a standard move) and
 * the ancestor element itself (writing `parent` on an element with an own
 * folder, or on a standard move, F072 S20/K1): "<Ebenenname>: <Titel>" looks
 * up that level by name in the levels of the relevant project (the element's
 * own, or the draft's chosen one) and finds the element of that level with
 * this title, preferring one in the same project when several projects carry
 * the same title (wissen #566: matches by title, not by note path — a
 * future package could disambiguate further, see "entdeckt"). `''` is the
 * project root — of the given element's physical placement (wissen #540: via
 * the folder, not an overridable `project` field) for an existing element, or
 * of the given project key for a not-yet-filed draft.
 */
export function resolveParentTarget(
  label: string,
  env: Pick<RefileEnv, 'elements' | 'projects' | 'levelsFor'>,
  context: { element?: BoardElement; project?: string } = {},
): { folder?: string; ancestor?: BoardElement } {
  if (label === '') {
    if (context.element) return { folder: projectRootForElement(context.element, env.projects) };
    const project = env.projects.find((p) => p.key === context.project);
    return { folder: project?.root.replace(/\/+$/, '') };
  }
  const named = /^(.+): (.+)$/.exec(label);
  if (!named) return {};
  const [, levelName, title] = named;
  const preferProject = context.element?.project ?? context.project;
  const level = env.levelsFor(preferProject ?? '').find((l) => l.name === levelName);
  if (!level) return {};
  const matches = env.elements.filter((el) => el.type === level.key && el.title === title && el.paths.folder);
  if (matches.length === 0) return {};
  const ancestor = (preferProject && matches.find((el) => el.project === preferProject)) || matches[0];
  return { folder: ancestor.paths.folder, ancestor };
}

// The draft's filing target (mirrors CardDetail's DraftTarget): `atomic`
// wins outright (_Tasks/Atomic/); else a defined `ownFolder` places directly
// under that path; else `parentLabel` resolves the Standardablage, with or
// without a picked ancestor (008 S21-S23, wissen #477).
export interface DraftPlacementTarget {
  title: string;
  atomic: boolean;
  ownFolder?: string;
  parentLabel: string;
  project?: string;
}

const ATOMIC_BASE = '_Tasks/Atomic';

/**
 * Places a draft according to its chosen form (008 S21-S23, F055): atomic,
 * an own path chosen via the folder field (project as its own field, no
 * parent — K3, wissen #477, the element leaves the root), or default filing
 * (parentLabel resolves the ancestor once, wissen #566, returning both its
 * folder — where the note is created — and the ancestor itself for the
 * parent wikilink, wissen #586). Each branch de-duplicates the base name
 * against the names already taken at the target (008 S28/S48, F068 K4).
 */
export interface DraftPlacement {
  path: string;
  project?: string;
  parent?: string;
  /** The ancestor's own note path, only when `parent` is set (K8: builds `parent_link`). */
  parentNote?: string;
  missingRoot?: string;
}

export function planDraftPlacement(
  target: DraftPlacementTarget,
  env: RefileEnv,
  today: string,
): DraftPlacement | undefined {
  if (target.atomic) {
    const taken = env.siblings(ATOMIC_BASE).map((name) => name.replace(/\.md$/, ''));
    return { path: atomicNotePath(target.title, today, taken), project: target.project };
  }
  if (target.ownFolder) {
    const taken = env.siblings(target.ownFolder);
    const { note } = nestedPaths(target.ownFolder, target.title, today, taken);
    return { path: note, project: target.project };
  }
  const resolved = resolveParentTarget(target.parentLabel, env, { project: target.project });
  if (!resolved.folder) return undefined;
  const taken = env.siblings(resolved.folder);
  const { note } = nestedPaths(resolved.folder, target.title, today, taken);
  // Default filing into a root the vault does not have (006 S43, F071 K5):
  // siblings/nestedPaths above only read and build a string, so checking
  // here still precedes any vault write.
  const notice = missingRootNotice(resolved.folder, env.rootExists);
  if (notice) return { path: note, missingRoot: notice };
  // `project` is a Pflichtfeld now (011): the standard-filing branch must
  // carry it along too, not just the atomic/ownFolder ones (F088 K6).
  if (!resolved.ancestor) return { path: note, project: target.project };
  return { path: note, project: target.project, parent: resolved.ancestor.id, parentNote: resolved.ancestor.paths.note };
}

// The five fields a filing edit can touch (mirrors CardDetail's
// RefileRequest); present only where the draft differs from the note's
// original value. `folder` (F054) is the folder field's pick: a path or
// `null` for "Standardablage".
export interface FilingRequest {
  title?: string;
  project?: string;
  type?: ElementType;
  parentLabel?: string;
  folder?: string | null;
}

/**
 * Turns the filing edits (title, project, level, the parentLabel driven via
 * the link list, the folder field) into a plan: project on a filed element
 * moves it to the root of the new project, with `parent` cleared (wissen
 * #566/#477 — a leftover parent field would otherwise still point at an
 * ancestor of the old project, since read.ts prefers it fully over the
 * folder); parentLabel alone moves within the current project and, in the
 * standard filing branch, (re)writes `parent` as a wikilink relative to the
 * new note path, or clears it without an ancestor (F072 S20/K1, wissen #586).
 * Project on an atomic task is only a frontmatter field (008); filing an
 * atomic task via a cross stays "ausserhalb". The folder field (F054) takes
 * precedence: a chosen folder moves there and writes project/parent as their
 * own frontmatter fields, because the element then lies "ausserhalb" every
 * root (008, wissen #477); a parent change on an element with its own
 * folder, by contrast, does not move it (S34/K2), but only rewrites `parent`
 * again. The `parent` wikilink itself is only ever built once `planRefile`
 * has settled the final note path (F073 S20/K1): a rename or a move to a
 * different folder changes `notePath`, and a relative wikilink built against
 * the old path would resolve wrongly, or not at all, from the new one.
 *
 * A title change alone renames folder and note only with Ablageregel 3
 * (`env.rules.renameOnTitleChange`) on, otherwise it writes just the `title`
 * field (K22); {@link ownsFolder} decides whether that rename drags the
 * whole folder along or only this note. A project switch or a parentLabel
 * move (the link list's cross) no longer moves anything here at all (011,
 * Ergänzung 2026-09-25, replacing the retired Ablageregel 2): they only
 * write `project`/`parent`/`parent_link`, and the move that follows from
 * that is main.ts#placeElement's job, once the write lands back through
 * `metadataCache.on('changed')`.
 */
export function planFiling(element: BoardElement, refile: FilingRequest, env: RefileEnv): RefilePlan {
  const rules = env.rules ?? DEFAULT_REFILE_RULES;
  const target: RefileTarget = {};
  const extra: FrontmatterChange = {};
  let parentAncestor: string | undefined;
  let parentAncestorNote: string | undefined;
  let parentAncestorTitle: string | undefined;
  let clearParent = false;

  if (refile.title) {
    if (rules.renameOnTitleChange) target.title = refile.title;
    else extra.title = yamlScalar(refile.title);
  }
  if (refile.type) target.type = refile.type;

  if (element.form === 'atomic') {
    if (refile.project !== undefined) target.project = refile.project;
  } else if (refile.folder !== undefined) {
    const result = resolveFolderRefile(element, refile.folder, target, env);
    Object.assign(extra, result.frontmatter);
    parentAncestor = result.parentAncestor;
    parentAncestorNote = result.parentAncestorNote;
    parentAncestorTitle = result.parentAncestorTitle;
    clearParent = result.clearParent ?? false;
  } else if (refile.project !== undefined && refile.project !== (element.project ?? '')) {
    const project = env.projects.find((p) => p.key === refile.project);
    if (project) {
      if (!project.root.replace(/\/+$/, '')) {
        // A target project without a root (011, Ergänzung 2026-09-25, S83
        // "Root-Grenzfälle") has no Standardablage: the switch writes only
        // `project`, no missingRoot notice (that would name an empty path),
        // and `parent`/`parent_link` are left exactly as they are.
        extra.project = refile.project;
      } else {
        // A project switch into a root the vault does not have (006 S43, F071
        // K4): the plan must write nothing rather than create the folder, so
        // this checks before parentFolder is ever set.
        const notice = missingRootNotice(project.root, env.rootExists);
        if (notice) target.missingRoot = notice;
        else {
          // `project` is a Pflichtfeld now (011): a folder move alone would
          // otherwise leave the note under its old project's field. The old
          // parent's `parent_link` would else keep pointing at an ancestor of
          // the abandoned project (K20), so it clears alongside `parent`.
          extra.project = refile.project;
          clearParent = true;
        }
      }
    }
  } else if (refile.parentLabel !== undefined) {
    const resolved = resolveParentTarget(refile.parentLabel, env, { element });
    if (resolved.ancestor) {
      parentAncestor = resolved.ancestor.id;
      parentAncestorNote = resolved.ancestor.paths.note;
      parentAncestorTitle = resolved.ancestor.title;
    } else clearParent = true;
  }

  const owns = element.form !== 'atomic' && ownsFolder(element, env.elements, env.projects);
  const taken = target.parentFolder ? env.siblings(target.parentFolder) : [];
  const plan = planRefile(
    {
      form: element.form,
      type: element.type,
      notePath: element.paths.note,
      folderPath: element.paths.folder,
    },
    target,
    env.childrenOf(element),
    taken,
    owns,
  );
  // The `parent_link` wikilink is built against the plan's final note path
  // (F073 wissen #683), only once `planRefile` has settled it, and only
  // where a `parent` is actually (re)written — clearing `parent` clears
  // `parent_link` alongside it (wissen #686: a cleared field is left out of
  // the frontmatter entirely, not written as `null` literally).
  if (parentAncestor) {
    extra.parent = parentAncestor;
    const link =
      parentAncestorNote && parentAncestorTitle !== undefined
        ? env.linkTo?.(parentAncestorNote, plan.notePath, parentAncestorTitle)
        : undefined;
    if (link) extra.parent_link = yamlScalar(link);
  } else if (clearParent) {
    extra.parent = null;
    extra.parent_link = null;
  }
  Object.assign(plan.frontmatter, extra);
  return plan;
}

// Folder-field branch of planFiling (F054, 008 S35-S37): a chosen folder
// becomes the new parent folder, project is written as its own field,
// because the element thereby steps outside every root and would otherwise
// be missing it on the next read (wissen #477). It also sets `ktm_placement:
// manual` (011, Ergänzung 2026-09-25): a deliberately chosen own folder must
// not be pulled back under the parent's folder the moment `parent` changes
// and main.ts#placeElement reacts to it. "Default filing" (`folder === null`)
// pulls back into the folder of the current parent or the project root,
// clears both fields again, and sets `ktm_placement: auto` — the folder
// hierarchy carries the relationship again, so the placer may resume. The
// `parent` wikilink itself is left for the caller to build once the final
// note path is known (F073 S20/K1): `parentAncestor` names the ancestor to
// link to, `clearParent` says there is none to link and the field must be
// emptied instead.
function resolveFolderRefile(
  element: BoardElement,
  folder: string | null,
  target: RefileTarget,
  env: RefileEnv,
): {
  frontmatter: FrontmatterChange;
  parentAncestor?: string;
  parentAncestorNote?: string;
  parentAncestorTitle?: string;
  clearParent?: boolean;
} {
  // `project` stays a Pflichtfeld either way (011): the folder field only
  // decides where the note is filed, never which project it belongs to.
  if (folder === null) {
    // The existing `parent` field is left exactly as it is (011): the pick
    // only removes the own-folder override, it does not touch the ancestor
    // relationship. Clearing it here would leave main.ts#placeElement with
    // no ancestor to compute a folder from, right after this same write.
    const parent = element.parents[0];
    const parentFolder = parent ? env.elements.find((e) => e.paths.note === parent.note)?.paths.folder : undefined;
    target.parentFolder =
      parentFolder ?? env.projects.find((p) => p.key === element.project)?.root.replace(/\/+$/, '');
    return {
      frontmatter: { project: element.project ?? 'intern', ktm_placement: 'auto' },
      clearParent: !parent,
    };
  }
  target.parentFolder = folder;
  const parent = element.parents[0];
  return {
    frontmatter: { project: element.project ?? 'intern', ktm_placement: 'manual' },
    parentAncestor: parent?.id,
    parentAncestorNote: parent?.note,
    parentAncestorTitle: parent?.title,
    clearParent: !parent,
  };
}

function baseName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function join(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}
