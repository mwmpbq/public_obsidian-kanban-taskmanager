import type { FrontmatterChange } from './frontmatter';
import type { ElementType, TaskForm } from './model';

const DONE_SEGMENT = 'Done';

export interface DoneCandidate {
  form: TaskForm;
  notePath: string;
  folderPath?: string;
  base: string;
  done: boolean;
  completed?: string;
}

export interface DoneMove {
  from: string;
  to: string;
  toNotePath: string;
  parent: string;
  frontmatter: FrontmatterChange | null;
}

// A candidate enriched with the hierarchy facts the container rules need: its
// kind, its title for the notice text, and its immediate parent's note path.
export interface DoneElement extends DoneCandidate {
  type: ElementType;
  title: string;
  parentNote?: string;
}

export interface DonePlan {
  moves: DoneMove[];
  notices: string[];
}

/**
 * Plans the move a task needs so its folder location matches its status: a done
 * status wants the element under `<base>/Done/<rel>`, an open status wants it at
 * `<base>/<rel>`. Nested tasks move their whole folder, atomic tasks their note.
 * Returns `null` when location and status already agree. The `frontmatter`
 * change stamps `completed` when entering Done without one and clears it when
 * leaving Done, so the interactive path and an external status edit converge on
 * the same result.
 */
export function planDoneMove(c: DoneCandidate, today: string): DoneMove | null {
  const item = c.form === 'atomic' ? c.notePath : c.folderPath;
  if (!item) return null;

  const rel = relativeTo(c.base, item);
  if (rel === null || rel === '') return null;

  const mirrored = rel === DONE_SEGMENT || rel.startsWith(DONE_SEGMENT + '/');
  const logical = mirrored ? rel.slice(DONE_SEGMENT.length + 1) : rel;
  if (!logical) return null;

  if (c.done && !mirrored) {
    const to = `${c.base}/${DONE_SEGMENT}/${logical}`;
    return move(c, item, to, c.completed ? null : { completed: today });
  }
  if (!c.done && mirrored) {
    const to = `${c.base}/${logical}`;
    return move(c, item, to, c.completed ? { completed: null } : null);
  }
  return null;
}

/**
 * Plans every reconciling move for a whole element set at once, so a container
 * only follows its children into the Done mirror once it is itself done and no
 * descendant is still open. A done container with an open descendant is left in
 * place and reported; a mirrored element under a done ancestor is not pulled
 * back out. When a container moves, its descendants' own moves are dropped from
 * the plan because the container's folder move carries them along.
 */
export function planDone(elements: DoneElement[], today: string): DonePlan {
  const ctx = hierarchy(elements);
  const notices: string[] = [];
  const candidates: { el: DoneElement; move: DoneMove }[] = [];
  const movers = new Set<string>();

  for (const el of elements) {
    const plan = planDoneMove(el, today);
    if (!plan) continue;
    if (el.done) {
      const open = ctx.firstOpenDescendant(el);
      if (open) {
        notices.push(closeNotice(el.title, open.title));
        continue;
      }
    } else {
      const ancestor = ctx.doneAncestor(el);
      if (ancestor) {
        notices.push(reopenNotice(ancestor.title));
        continue;
      }
    }
    candidates.push({ el, move: plan });
    movers.add(el.notePath);
  }

  const moves = candidates.filter((c) => !ctx.hasAncestorIn(c.el, movers)).map((c) => c.move);
  return { moves, notices };
}

/**
 * Decides whether an interactive move must be refused before its status is even
 * written: a container cannot be closed while a descendant is open, and a
 * mirrored element cannot be reopened while an ancestor is still done. Returns
 * the notice to show when refused, or `null` when the move may proceed.
 */
export function guardMove(el: DoneElement, targetDone: boolean, elements: DoneElement[]): string | null {
  const ctx = hierarchy(elements);
  if (targetDone) {
    const open = ctx.firstOpenDescendant(el);
    return open ? closeNotice(el.title, open.title) : null;
  }
  if (el.done) {
    const ancestor = ctx.doneAncestor(el);
    if (ancestor) return reopenNotice(ancestor.title);
  }
  return null;
}

function hierarchy(all: DoneElement[]) {
  const byNote = new Map<string, DoneElement>();
  for (const el of all) byNote.set(el.notePath, el);
  const children = new Map<string, DoneElement[]>();
  for (const el of all) {
    if (!el.parentNote) continue;
    const list = children.get(el.parentNote) ?? [];
    list.push(el);
    children.set(el.parentNote, list);
  }

  const firstOpenDescendant = (el: DoneElement): DoneElement | undefined => {
    const stack = [...(children.get(el.notePath) ?? [])];
    for (let cur = stack.pop(); cur; cur = stack.pop()) {
      if (!cur.done) return cur;
      stack.push(...(children.get(cur.notePath) ?? []));
    }
    return undefined;
  };

  const ancestors = function* (el: DoneElement): Generator<DoneElement> {
    const seen = new Set<string>([el.notePath]);
    let parent = el.parentNote ? byNote.get(el.parentNote) : undefined;
    while (parent && !seen.has(parent.notePath)) {
      seen.add(parent.notePath);
      yield parent;
      parent = parent.parentNote ? byNote.get(parent.parentNote) : undefined;
    }
  };

  const doneAncestor = (el: DoneElement): DoneElement | undefined => {
    for (const parent of ancestors(el)) if (parent.done) return parent;
    return undefined;
  };

  const hasAncestorIn = (el: DoneElement, set: Set<string>): boolean => {
    for (const parent of ancestors(el)) if (set.has(parent.notePath)) return true;
    return false;
  };

  return { firstOpenDescendant, doneAncestor, hasAncestorIn };
}

function closeNotice(container: string, task: string): string {
  return `„${container}" bleibt offen, solange „${task}" nicht abgeschlossen ist.`;
}

function reopenNotice(feature: string): string {
  return `Zuerst „${feature}" wieder öffnen.`;
}

function move(
  c: DoneCandidate,
  from: string,
  to: string,
  frontmatter: FrontmatterChange | null,
): DoneMove {
  const toNotePath = c.form === 'atomic' ? to : `${to}/${baseName(c.notePath)}`;
  return { from, to, toNotePath, parent: parentPath(to), frontmatter };
}

function relativeTo(base: string, path: string): string | null {
  if (path === base) return '';
  if (path.startsWith(base + '/')) return path.slice(base.length + 1);
  return null;
}

function baseName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

function parentPath(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}
