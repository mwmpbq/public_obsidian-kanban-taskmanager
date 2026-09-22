import { canChangeLevel } from './board';
import { renameTarget, uniqueName } from './create';
import type { FrontmatterChange } from './frontmatter';
import type { BoardElement, ElementType, TaskForm } from './model';

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
 * trigger a false collision.
 */
export function planRefile(
  element: RefileElement,
  target: RefileTarget,
  children: BoardElement[],
  taken: Iterable<string> = [],
): RefilePlan {
  const frontmatter: FrontmatterChange = {};
  let notice: string | undefined;

  if (target.title) frontmatter.title = target.title;
  if (target.type && target.type !== element.type) {
    const check = canChangeLevel({ type: element.type, paths: { note: element.notePath } }, target.type, children);
    if (check.ok) frontmatter.type = target.type;
    else notice = check.reason;
  }
  if (element.form === 'atomic' && target.project !== undefined) {
    frontmatter.project = target.project || null;
  }

  if (element.form === 'atomic') {
    const notePath = target.title ? renameTarget(element.notePath, target.title).note : element.notePath;
    const move = notePath === element.notePath ? undefined : { from: element.notePath, to: notePath, parent: dirOf(notePath) };
    return { move, frontmatter, notePath, notice };
  }

  const folderPath = element.folderPath ?? dirOf(element.notePath);
  const currentBase = baseName(folderPath);
  const currentParent = dirOf(folderPath);
  const newBase = target.title
    ? baseName(renameTarget(element.notePath, target.title).folder ?? folderPath)
    : currentBase;
  const parentDir = target.parentFolder ?? currentParent;
  const moves = parentDir !== currentParent || newBase !== currentBase;
  const finalBase = moves ? uniqueName(newBase, taken) : currentBase;
  const finalFolder = join(parentDir, finalBase);
  const finalNote = `${finalFolder}/_${finalBase}.md`;
  const move = finalFolder === folderPath ? undefined : { from: folderPath, to: finalFolder, parent: parentDir };
  return { move, frontmatter, notePath: finalNote, notice };
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
