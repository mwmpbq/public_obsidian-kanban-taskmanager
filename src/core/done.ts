import type { FrontmatterChange } from './frontmatter';
import type { ElementType, TaskForm } from './model';

export interface DoneCandidate {
  form: TaskForm;
  notePath: string;
  folderPath?: string;
  base: string;
  /** `undefined` for an unknown status (invalid note, key missing from the columns): not reconciled (F066). */
  done: boolean | undefined;
  completed?: string;
}

// A candidate enriched with the hierarchy facts the container rules need: its
// kind, its title for the notice text, and its immediate parent's note path.
export interface DoneElement extends DoneCandidate {
  type: ElementType;
  title: string;
  parentNote?: string;
}

export interface CompletedCandidate {
  /** `undefined` for an unknown status (invalid note, key missing from the columns): left alone. */
  done: boolean | undefined;
  completed?: string;
}

/**
 * The `completed`-field reconciliation alone, without a path or a move (011:
 * the Done/-Ordner-Umzug is now part of core/placement.ts#computedLocation,
 * driven by main.ts#placeElement off the element's own status change, never a
 * set-wide sweep): a closed status without `completed` is stamped with
 * `today`, an open one that still carries `completed` has it cleared, an
 * unknown status (`done === undefined`) is left untouched either way.
 */
export function reconcileCompleted(c: CompletedCandidate, today: string): FrontmatterChange | null {
  if (c.done === undefined) return null;
  if (c.done) return c.completed ? null : { completed: today };
  return c.completed ? { completed: null } : null;
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

  return { firstOpenDescendant, doneAncestor };
}

function closeNotice(container: string, task: string): string {
  return `„${container}" bleibt offen, solange „${task}" nicht abgeschlossen ist.`;
}

function reopenNotice(feature: string): string {
  return `Zuerst „${feature}" wieder öffnen.`;
}
