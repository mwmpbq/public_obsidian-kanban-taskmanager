/** A configured level key (`type` value), not a fixed set of three (Spec 006). */
export type ElementType = string;

export type TaskForm = 'nested' | 'atomic';

export interface FileEntry {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface ProjectRoot {
  key: string;
  root: string;
}

export interface ParentRef {
  type: ElementType;
  title: string;
  note: string;
  /** Ancestor's short name (`short`), for the level chip on a card (008 S38). */
  short?: string;
}

export interface FreeLink {
  kind: string;
  target: string;
}

export interface ElementPaths {
  note: string;
  folder?: string;
}

export interface Checklist {
  done: number;
  total: number;
}

export interface BoardElement {
  type: ElementType;
  form: TaskForm;
  title: string;
  status: string;
  project?: string;
  priority: number;
  planned?: string;
  due?: string;
  completed?: string;
  ticket?: number;
  summary?: string;
  tags: string[];
  checklist?: Checklist;
  parents: ParentRef[];
  links: FreeLink[];
  order?: number;
  paths: ElementPaths;
  invalid?: boolean;
  /** Own short name (008 S38). */
  short?: string;
  /** Folder lies outside the standard placement (008, addendum 2026-09-20). */
  ownFolder?: boolean;
  /** Surfaced in the board's notice area, e.g. a `parent` vs. folder conflict (008 S30). */
  notice?: string;
}
