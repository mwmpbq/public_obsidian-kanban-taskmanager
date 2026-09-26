/** A configured level key (`type` value), not a fixed set of three (Spec 006). */
export type ElementType = string;

export type TaskForm = 'nested' | 'atomic';

export interface FileEntry {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  /** File creation time in ms since epoch, used to order duplicate `ktm_id`s (011 S59). */
  ctime?: number;
}

export interface ProjectRoot {
  key: string;
  root: string;
}

export interface ParentRef {
  id: string;
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
  /** Stable `ktm_id` (011 S54); empty for the synthetic invalid/draft cards that have none. */
  id: string;
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
  /** Names the missing/invalid frontmatter field(s), set together with `invalid` (011 S56). */
  invalidReason?: string;
  /** A second (or later) file carrying an already-used `ktm_id` (011 S59). */
  duplicate?: boolean;
  /** Own short name (008 S38). */
  short?: string;
  /** Folder lies outside the standard placement (008, addendum 2026-09-20). */
  ownFolder?: boolean;
  /** Surfaced in the board's notice area, e.g. an unresolved `parent` (011 S57). */
  notice?: string;
  /** `ktm_placement` (011, Ergänzung 2026-09-25): anything but `manual` reads as `auto`. */
  placement?: 'auto' | 'manual';
}
