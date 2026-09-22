import type { ElementType, FileEntry } from './model';
import type { TodayKey } from './today';

export interface GeneralSettings {
  columns: string[];
  doneColumns: string[];
  lastView?: string;
  lastLevel?: ElementType;
  collapsedColumns?: Record<string, string[]>;
  collapsedToday?: Record<string, boolean>;
  notifyPlanned?: boolean;
  todaySortOrder?: TodayKey[];
  linkKinds?: LinkKind[];
  cardFields?: CardField[];
  levels?: Level[];
  doneLimit?: number;
  allLevels?: 'rank' | 'bottom';
  ribbon?: boolean;
  openView?: string;
  openLevel?: string;
  expandedWidthFactor?: number;
  atomicFolder?: string;
  notesFolder?: string;
  shortInChips?: boolean;
}

export interface Level {
  key: string;
  name: string;
  icon: string;
}

export const DEFAULT_LEVELS: Level[] = [
  { key: 'epic', name: 'Epic', icon: 'layers' },
  { key: 'feature', name: 'Feature', icon: 'box' },
  { key: 'task', name: 'Task', icon: 'square' },
];

const LEVEL_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * Parses the flat note encoding of a level list, `"key | name | icon"` per
 * entry (006, addendum 2026-09-20). Any single malformed entry (wrong
 * separator, invalid key, duplicate key, missing name or icon) invalidates
 * the whole list; the caller falls back to the general levels and reports
 * the note and key (K4).
 */
export function parseLevelList(raw: unknown): Level[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const seen = new Set<string>();
  const levels: Level[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return null;
    const parts = entry.split('|').map((p) => p.trim());
    if (parts.length !== 3) return null;
    const [key, name, icon] = parts;
    if (!key || !name || !icon) return null;
    if (!LEVEL_KEY_PATTERN.test(key) || seen.has(key)) return null;
    seen.add(key);
    levels.push({ key, name, icon });
  }
  return levels;
}

/**
 * Resolves the general levels: the `levels` list from `data.json` if it
 * carries at least one valid entry, otherwise the built-in default
 * Epic/Feature/Task (pattern of resolveLinkKinds). Data.json stores levels as
 * objects, not the flat note encoding.
 */
export function resolveLevels(general?: Pick<GeneralSettings, 'levels'>): Level[] {
  const raw: unknown = general?.levels;
  if (!Array.isArray(raw)) return DEFAULT_LEVELS;
  const seen = new Set<string>();
  const levels: Level[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.key !== 'string' || typeof e.name !== 'string' || typeof e.icon !== 'string') {
      continue;
    }
    if (!LEVEL_KEY_PATTERN.test(e.key) || seen.has(e.key)) continue;
    seen.add(e.key);
    levels.push({ key: e.key, name: e.name, icon: e.icon });
  }
  return levels.length > 0 ? levels : DEFAULT_LEVELS;
}

/** The standing default level of the board and of a new card (006 addendum 2026-09-20). */
export function bottomLevel(levels: Level[]): Level | undefined {
  return levels[levels.length - 1];
}

/**
 * Every level except the bottom one: the settings row for these carries a
 * remove cross, the bottom row never does (S20/K4).
 */
export function removableLevels(levels: Level[]): Level[] {
  return levels.slice(0, -1);
}

/**
 * The settings-page row label "Kurzname in <Ebenen>-Chips" (S19/K3), built
 * from the non-bottom level names with German elision of the repeated word
 * ("Epic- und Feature-Chips", "Epic-, Feature- und Story-Chips").
 */
export function chipLevelLabel(levels: Level[]): string {
  const names = removableLevels(levels).map((l) => l.name);
  if (names.length === 0) return 'Kurzname in Chips';
  if (names.length === 1) return `Kurzname in ${names[0]}-Chips`;
  const init = names.slice(0, -1).map((name) => `${name}-`);
  const last = names[names.length - 1];
  return `Kurzname in ${[...init, `und ${last}-Chips`].join(', ').replace(', und', ' und')}`;
}

export type CardField =
  | 'ticket'
  | 'planned'
  | 'due'
  | 'checklist'
  | 'priority'
  | 'project'
  | 'parents'
  | 'tags';

export const CARD_FIELDS: readonly CardField[] = [
  'ticket',
  'planned',
  'due',
  'checklist',
  'priority',
  'project',
  'parents',
  'tags',
];

export interface LinkKind {
  key: string;
  label: string;
  icon: string;
  prefix?: string;
}

const DEFAULT_LINK_KINDS: LinkKind[] = [
  { key: 'notes', label: 'Notiz', icon: 'file-text' },
  { key: 'adr', label: 'ADR', icon: 'scale', prefix: 'ADR_' },
];

export interface ProjectSettings {
  key: string;
  name: string;
  root: string;
  path: string;
  columns?: string[];
  doneColumns?: string[];
  levels?: Level[];
  linkKinds?: LinkKind[];
  doneLimit?: number;
}

export interface ResolvedProjects {
  projects: ProjectSettings[];
  notices: string[];
}

export interface Column {
  status: string;
  name: string;
  done: boolean;
}

/**
 * Collects project settings from every note that carries the `ktm_project`
 * marker, regardless of its path. Two notes with the same key: the one that
 * sorts first by path wins, the later one becomes a notice.
 */
export function resolveProjectSettings(entries: FileEntry[]): ResolvedProjects {
  const notes = entries
    .filter((e) => typeof e.frontmatter.ktm_project === 'string')
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const projects: ProjectSettings[] = [];
  const notices: string[] = [];
  const seen = new Map<string, ProjectSettings>();

  for (const note of notes) {
    const key = note.frontmatter.ktm_project as string;
    const first = seen.get(key);
    if (first) {
      notices.push(
        `Doppelte Projektnotiz für „${key}“: ${note.path} wird ignoriert, ${first.path} gilt.`,
      );
      continue;
    }
    const project: ProjectSettings = {
      key,
      name: text(note.frontmatter.ktm_name) || key,
      root: text(note.frontmatter.ktm_root),
      path: note.path,
      columns: stringList(note.frontmatter.ktm_columns),
      doneColumns: stringList(note.frontmatter.ktm_done_columns),
      doneLimit: number(note.frontmatter.ktm_done_limit),
    };
    if (note.frontmatter.ktm_levels !== undefined) {
      const levels = parseLevelList(note.frontmatter.ktm_levels);
      if (levels) project.levels = levels;
      else notices.push(`Projektnotiz ${note.path}: „ktm_levels“ ist ungültig und wird ignoriert.`);
    }
    if (note.frontmatter.ktm_link_kinds !== undefined) {
      const linkKinds = parseLinkKindList(note.frontmatter.ktm_link_kinds);
      if (linkKinds) project.linkKinds = linkKinds;
      else {
        notices.push(`Projektnotiz ${note.path}: „ktm_link_kinds“ ist ungültig und wird ignoriert.`);
      }
    }
    projects.push(project);
    seen.set(key, project);
    notices.push(...danglingDoneNotices(project));
  }

  return { projects, notices };
}

// A done column that is not one of the project's own columns marks nothing as
// done and is almost always a typo; the project stays, but the note and the
// stray name are named so it can be fixed.
function danglingDoneNotices(project: ProjectSettings): string[] {
  if (!project.columns || !project.doneColumns) return [];
  const columnSlugs = new Set(project.columns.map(slugifyStatus));
  return project.doneColumns
    .filter((name) => !columnSlugs.has(slugifyStatus(name)))
    .map(
      (name) =>
        `Projektnotiz ${project.path}: „${name}“ steht in ktm_done_columns, aber nicht in ktm_columns.`,
    );
}

/**
 * Resolves the columns a project shows: its own column list if it has one,
 * otherwise the general default (same rule per key). Without a project, as in
 * the `all` view, the general columns apply. Each column carries its status
 * slug and whether it counts as done.
 */
export function resolveColumns(general: GeneralSettings, project?: ProjectSettings): Column[] {
  const names = project?.columns ?? general.columns;
  const doneNames = project?.doneColumns ?? general.doneColumns;
  const doneSlugs = new Set(doneNames.map(slugifyStatus));
  return names.map((name) => {
    const status = slugifyStatus(name);
    return { status, name, done: doneSlugs.has(status) };
  });
}

const LINK_KIND_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * Parses the flat note encoding of a link-kind list, `"key | label | icon
 * [| prefix]"` per entry (006, per-project ktm_link_kinds), mirroring
 * {@link parseLevelList}. Any single malformed entry (wrong separator count,
 * invalid key, duplicate key, missing label or icon) invalidates the whole
 * list; the caller falls back to the general link kinds and reports the note
 * and key.
 */
export function parseLinkKindList(raw: unknown): LinkKind[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const seen = new Set<string>();
  const kinds: LinkKind[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return null;
    const parts = entry.split('|').map((p) => p.trim());
    if (parts.length !== 3 && parts.length !== 4) return null;
    const [key, label, icon, prefix] = parts;
    if (!key || !label || !icon) return null;
    if (!LINK_KIND_KEY_PATTERN.test(key) || seen.has(key)) return null;
    seen.add(key);
    const kind: LinkKind = { key, label, icon };
    if (prefix) kind.prefix = prefix;
    kinds.push(kind);
  }
  return kinds;
}

/**
 * Resolves the free link kinds: the general `linkKinds` list if it carries at
 * least one valid entry, otherwise the built-in default Notiz before ADR. Each
 * entry keeps its own icon and optional filename prefix; the order is the order
 * of free links in a card (006 S15, S16). An entry whose key is not
 * `[a-z][a-z0-9_-]*` or repeats an earlier key is dropped: the key becomes a
 * frontmatter field name and the guard at this boundary keeps a malformed or
 * duplicated entry from a hand-edited `data.json` from reaching the card and
 * link-menu rendering.
 */
export function resolveLinkKinds(general?: Pick<GeneralSettings, 'linkKinds'>): LinkKind[] {
  const raw: unknown = general?.linkKinds;
  if (!Array.isArray(raw)) return DEFAULT_LINK_KINDS;
  const seen = new Set<string>();
  const kinds: LinkKind[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.key !== 'string' || typeof e.label !== 'string' || typeof e.icon !== 'string') {
      continue;
    }
    if (!LINK_KIND_KEY_PATTERN.test(e.key) || seen.has(e.key)) continue;
    seen.add(e.key);
    const kind: LinkKind = { key: e.key, label: e.label, icon: e.icon };
    if (typeof e.prefix === 'string') kind.prefix = e.prefix;
    kinds.push(kind);
  }
  return kinds.length > 0 ? kinds : DEFAULT_LINK_KINDS;
}

/**
 * Resolves which card fields a board card shows: the general `cardFields`
 * list filtered to valid keys and put back in the fixed CARD_FIELDS order, or
 * every field when the setting is missing, invalid or empty (006 S11).
 */
export function resolveCardFields(general?: Pick<GeneralSettings, 'cardFields'>): CardField[] {
  const raw: unknown = general?.cardFields;
  if (!Array.isArray(raw)) return [...CARD_FIELDS];
  const enabled = new Set(raw.filter((v): v is CardField => CARD_FIELDS.includes(v as CardField)));
  const fields = CARD_FIELDS.filter((key) => enabled.has(key));
  return fields.length > 0 ? fields : [...CARD_FIELDS];
}

export function slugifyStatus(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’‘´`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((v): v is string => typeof v === 'string');
  return list.length > 0 ? list : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export interface ResolvedSettings {
  levels: Level[];
  linkKinds: LinkKind[];
  doneLimit?: number;
  columns: Column[];
  allLevels: 'rank' | 'bottom';
  ribbon?: boolean;
}

/**
 * Resolves the settings that apply to a board view: project-capable keys
 * (levels, linkKinds, doneLimit, columns) from the project note if it sets
 * them, otherwise the general value (resolveColumns' merge pattern, #372);
 * keys that are general-only (ribbon, allLevels) always come from `general`,
 * the project note is never read for them (006, addendum 2026-09-20).
 */
export function settingsFor(general: GeneralSettings, project?: ProjectSettings): ResolvedSettings {
  return {
    levels: project?.levels ?? resolveLevels(general),
    linkKinds: project?.linkKinds ?? resolveLinkKinds(general),
    doneLimit: project?.doneLimit ?? general.doneLimit,
    columns: resolveColumns(general, project),
    allLevels: general.allLevels ?? 'rank',
    ribbon: general.ribbon,
  };
}
