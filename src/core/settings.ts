import type { BoardElement, ElementType, FileEntry, ProjectRoot } from './model';
import type { SavedView } from './savedViews';
import type { TodayKey } from './today';

export interface ColumnConfig {
  key: string;
  name: string;
  /** Only for open keys; an end key's role always follows from the key itself (006, Ergänzung 2026-10-25). */
  role?: 'aktiv' | 'offen';
}

export interface GeneralSettings {
  columns: string[] | ColumnConfig[];
  doneColumns?: string[];
  lastView?: string;
  lastLevel?: ElementType;
  collapsedColumns?: Record<string, string[]>;
  collapsedToday?: Record<string, boolean>;
  /** "Heute folgt der Auswahl" je Ansicht (004, Ergänzung 2026-10-24). */
  todayFollows?: Record<string, boolean>;
  /** Filterfeld-Auswahl je Ansicht, Liste von `ktm_id` (001, Ergänzung 2026-10-18). */
  filters?: Record<string, string[]>;
  /** Hervorhebung je Ansicht, `ktm_id` des markierten Elements (001, Ergänzung 2026-10-18 "Hervorheben"). */
  spotlights?: Record<string, string>;
  /** Gespeicherte Ansichten in Anzeigereihenfolge (001, Ergänzung 2026-10-18 "Gespeicherte Ansichten"). */
  savedViews?: SavedView[];
  notifyPlanned?: boolean;
  notifyDue?: boolean;
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
  shortInChips?: boolean;
  /** "Abgeschlossene nach Done/ verschieben" (011, Ablageregel 1), Standard an; read via `?? true`. */
  moveDoneToFolder?: boolean;
  /** "Datei und Ordner beim Umbenennen des Titels mit umbenennen" (011, Ablageregel 3), Standard aus; read via `?? false`. */
  renameOnTitleChange?: boolean;
  /** The exact text "LLM-Verweis einrichten" last appended to CLAUDE.md, so "LLM-Verweis entfernen" can cut precisely that back off (011, Ergänzung 2026-09-25). */
  llmLink?: { appended: string; created: boolean };
  /** Reihenfolge der Projekte (Kürzel, `intern` ausgenommen, ausgeblendete eingeschlossen); fehlt sie, gilt alphabetisch nach Anzeigename (006, Ergänzung 2026-10-19). */
  projectOrder?: string[];
  /** Größe der Board-Ansicht in Prozent, 50-200 in 10er-Schritten, Standard 100 (001, Ergänzung 2026-10-24 "Eigene Größe des Boards"). */
  boardScale?: number;
  /** Position der festen Result-Art unter den Verknüpfungsarten (002, Ergänzung 2026-10-19 "Result"); fehlt sie, steht Result am Ende. */
  resultPosition?: number;
  /** Form der Bedienelemente, nur allgemein; ein fehlender oder unbekannter Wert gilt als Ghost (006, Ergänzung 2026-10-25 "Buttonstil"). */
  buttonStyle?: string;
  /** Hinterlegte Tags mit Icon, allgemein (006, Ergänzung 2026-10-25 "Tags mit Icon"). */
  tagList?: TagEntry[];
  /** Reihenfolge der Darstellungs-Icons in der Kopfzeile, nur allgemein (012, Ergänzung 2026-10-25 "Reihenfolge per Ziehen"). */
  viewOrder?: string[];
  /** Gemerkte Darstellung je Ansicht ("all", "internal", Projekt-Kürzel), nur allgemein (012, Ergänzung 2026-10-25 "Darstellung für ein Projekt merken"). */
  viewModes?: Record<string, string>;
  /** Sortierung des Baums je Ansicht, in Klickreihenfolge, nur allgemein (012, Ergänzung 2026-10-25 "Baum": "Die Sortierung gilt je Ansicht und übersteht Neuladen"). */
  treeSort?: Record<string, { key: string; dir: 'asc' | 'desc' }[]>;
  /** Zeitraum und Raster der Roadmap je Ansicht, nur allgemein (012, Ergänzung 2026-10-25 "Roadmap": "Zeitraum und Raster gelten je Ansicht und überstehen Neuladen"); ein unbekannter oder kaputter Eintrag fällt beim Lesen auf den Standard zurück (core/roadmap.ts#parseRoadmapState). */
  roadmap?: Record<string, { start: string; end: string; grid: string }>;
}

export type ButtonStyle = 'basic' | 'ghost' | 'outline' | 'keycap';

/** Ordnet den rohen `buttonStyle`-Wert aus `data.json` einem Stil zu; ein fehlender oder unbekannter Wert gilt als Ghost (006, Ergänzung 2026-10-25). */
export function buttonStyleOf(raw: unknown): ButtonStyle {
  return raw === 'basic' || raw === 'ghost' || raw === 'outline' || raw === 'keycap' ? raw : 'ghost';
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
 * Whether `type` is the bottom (atomic) level of the given list, replacing a
 * hardcoded `type === 'task'` at every caller that decides atomicity, the
 * Heute filter, or a new card's default type (F072, S22).
 */
export function isBottomLevel(levels: Level[], type: ElementType): boolean {
  return bottomLevel(levels)?.key === type;
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

const BOARD_SCALE_MIN = 50;
const BOARD_SCALE_MAX = 200;
const BOARD_SCALE_STEP = 10;
const BOARD_SCALE_DEFAULT = 100;

/**
 * Macht aus dem Rohwert von `boardScale` aus data.json eine gültige Größe
 * (001, Ergänzung 2026-10-24): data.json ist eine Vertrauensgrenze, ein
 * nicht-endlicher Wert ergibt den Standard, jeder andere wird auf den
 * nächsten 10er-Schritt gerundet und auf 50-200 begrenzt.
 */
export function normalizeBoardScale(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return BOARD_SCALE_DEFAULT;
  const stepped = Math.round(raw / BOARD_SCALE_STEP) * BOARD_SCALE_STEP;
  return Math.min(BOARD_SCALE_MAX, Math.max(BOARD_SCALE_MIN, stepped));
}

/**
 * Ein Schritt der drei Board-Größe-Befehle (001, Ergänzung 2026-10-24);
 * `current` ist bereits normalisiert. An einer Grenze ändert ein weiterer
 * Schritt in diese Richtung nichts (S44).
 */
export function stepBoardScale(current: number, action: 'in' | 'out' | 'reset'): number {
  if (action === 'reset') return BOARD_SCALE_DEFAULT;
  const delta = action === 'in' ? BOARD_SCALE_STEP : -BOARD_SCALE_STEP;
  return Math.min(BOARD_SCALE_MAX, Math.max(BOARD_SCALE_MIN, current + delta));
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

/**
 * Result is a fixed free-link kind outside `linkKinds` (002, Ergänzung
 * 2026-10-19 "Result"): it never comes from `resolveLinkKinds`/`linkKinds`
 * settings, cannot be removed, and only its position among the configured
 * kinds is stored (`resultPosition`).
 */
export const RESULT_LINK_KIND: LinkKind = { key: 'results', label: 'Result', icon: 'file-check-2' };

/**
 * Inserts {@link RESULT_LINK_KIND} into a resolved `linkKinds` list at the
 * clamped `position` (undefined or out of range: at the end), unless a kind
 * already named `results` is configured there — an unlikely hand-edit that
 * must win over the fixed one rather than collide with it.
 */
export function withResultKind(kinds: LinkKind[], position?: number): LinkKind[] {
  if (kinds.some((k) => k.key === RESULT_LINK_KIND.key)) return kinds;
  const index = position === undefined ? kinds.length : Math.max(0, Math.min(position, kinds.length));
  const next = [...kinds];
  next.splice(index, 0, RESULT_LINK_KIND);
  return next;
}

export interface ProjectSettings {
  key: string;
  name: string;
  root: string;
  path: string;
  columns?: string[];
  doneColumns?: string[];
  levels?: Level[];
  linkKinds?: LinkKind[];
  cardFields?: CardField[];
  doneLimit?: number;
  shortInChips?: boolean;
  /** `ktm_hidden: true` (006 addendum 2026-09-24, F085): the project stays in
   * the settings list but disappears from every view, "Alle" and "Heute". */
  hidden?: boolean;
  /** Hinterlegte Tags mit Icon aus `ktm_tags`, ergänzt die allgemeinen (006, Ergänzung 2026-10-25 "Tags mit Icon"). */
  tags?: TagEntry[];
}

export interface ResolvedProjects {
  projects: ProjectSettings[];
  notices: string[];
}

export type ColumnRole = 'open' | 'active' | 'done' | 'wont-do';

export interface Column {
  status: string;
  name: string;
  done: boolean;
  role?: ColumnRole;
  aliases?: string[];
}

/**
 * Collects project settings from every note that carries the `ktm_project`
 * marker, regardless of its path. Two notes with the same key: the one that
 * sorts first by path wins, the later one becomes a notice. A note whose
 * `ktm_root` is invalid (006 S42, F071 K1-K3) is skipped without entering
 * `seen`, so it never wins the key and a later, valid note with the same
 * `ktm_project` still gets a chance to become the project.
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
    const root = text(note.frontmatter.ktm_root);
    if (invalidRoot(root)) {
      notices.push(`Projektnotiz ${note.path}: „ktm_root“ ${root} ist ungültig, Projekt wird nicht angeboten.`);
      continue;
    }
    const hidden = boolean(note.frontmatter.ktm_hidden) === true;
    const project: ProjectSettings = {
      key,
      name: text(note.frontmatter.ktm_name) || key,
      root,
      path: note.path,
      columns: stringList(note.frontmatter.ktm_columns),
      doneColumns: stringList(note.frontmatter.ktm_done_columns),
      doneLimit: number(note.frontmatter.ktm_done_limit),
      shortInChips: boolean(note.frontmatter.ktm_short_in_chips),
    };
    if (hidden) project.hidden = true;
    // An ausgeblendetes Projekt (F085, 006 addendum 2026-09-24) verschwindet
    // auch aus dem Hinweisbereich: Meldungen über seine eigene Notiz werden
    // gesammelt, aber nur angehängt, wenn das Projekt sichtbar bleibt (K21).
    const ownNotices: string[] = [];
    if (note.frontmatter.ktm_levels !== undefined) {
      const levels = parseLevelList(note.frontmatter.ktm_levels);
      if (levels) project.levels = levels;
      else ownNotices.push(`Projektnotiz ${note.path}: „ktm_levels“ ist ungültig und wird ignoriert.`);
    }
    if (note.frontmatter.ktm_link_kinds !== undefined) {
      const linkKinds = parseLinkKindList(note.frontmatter.ktm_link_kinds);
      if (linkKinds) project.linkKinds = linkKinds;
      else {
        ownNotices.push(`Projektnotiz ${note.path}: „ktm_link_kinds“ ist ungültig und wird ignoriert.`);
      }
    }
    if (note.frontmatter.ktm_card_fields !== undefined) {
      const cardFields = parseCardFieldList(note.frontmatter.ktm_card_fields);
      if (cardFields) project.cardFields = cardFields;
      else {
        ownNotices.push(`Projektnotiz ${note.path}: „ktm_card_fields“ ist ungültig und wird ignoriert.`);
      }
    }
    if (note.frontmatter.ktm_tags !== undefined) {
      const tags = parseTagList(note.frontmatter.ktm_tags);
      if (tags) project.tags = tags;
      else ownNotices.push(`Projektnotiz ${note.path}: „ktm_tags“ ist ungültig und wird ignoriert.`);
    }
    // The raw list, not project.columns: stringList() already dropped every
    // non-string entry, so a ktm_columns made only of numbers would reach
    // parseColumns as an empty, already-undefined list and produce no notice
    // at all (F122 K12, #955).
    const rawColumns = note.frontmatter.ktm_columns;
    if (Array.isArray(rawColumns) && rawColumns.length > 0) {
      const parsed = parseColumns(rawColumns, project.doneColumns);
      if (parsed) ownNotices.push(...parsed.notices.map((n) => `Projektnotiz ${note.path}: ${n}`));
      else {
        ownNotices.push(
          `Projektnotiz ${note.path}: „ktm_columns“ enthält keine gültige Spalte, allgemeine Spalten gelten.`,
        );
      }
    }
    projects.push(project);
    seen.set(key, project);
    ownNotices.push(...danglingDoneNotices(project));
    if (!hidden) notices.push(...ownNotices);
  }

  return { projects, notices };
}

// A done column that is not one of the project's own columns marks nothing as
// done and is almost always a typo; the project stays, but the note and the
// stray name are named so it can be fixed. A `ktm_columns` already in the new
// `"key | name"` form (006 addendum 2026-09-22) carries the done/wont-do role
// in the key itself; a leftover `ktm_done_columns` next to it (011, Ergänzung
// 2026-09-25, "übrig gebliebenes ktm_done_columns") is no longer evaluated at
// all and gets a single "veraltet" notice instead of one dangling-name notice
// per stray entry.
function danglingDoneNotices(project: ProjectSettings): string[] {
  if (!project.columns || !project.doneColumns) return [];
  if (project.columns.every((c) => c.includes('|'))) {
    return [`Projektnotiz ${project.path}: „ktm_done_columns“ ist veraltet und wird ignoriert.`];
  }
  const columnSlugs = new Set(project.columns.map(slugifyStatus));
  return project.doneColumns
    .filter((name) => !columnSlugs.has(slugifyStatus(name)))
    .map(
      (name) =>
        `Projektnotiz ${project.path}: „${name}“ steht in ktm_done_columns, aber nicht in ktm_columns.`,
    );
}

/**
 * Removes every entry belonging to a hidden project (F085, 006 addendum
 * 2026-09-24, K18-K20), by its `project` frontmatter field alone (011,
 * "Ausgeblendete Projekte werden über `project` gefiltert" — no more root
 * path involved, an element's physical location carries no meaning). Called
 * once before {@link resolveColumns}-style consumption (`readElements`,
 * `today`), so "alle", "Heute", the view dropdown and the hint area never see
 * a hidden project's tasks, without touching every one of those call sites.
 */
export function withoutHiddenProjects(
  entries: FileEntry[],
  roots: ProjectRoot[],
  projects: ProjectSettings[],
): { entries: FileEntry[]; roots: ProjectRoot[] } {
  const hiddenProjects = projects.filter((p) => p.hidden);
  if (hiddenProjects.length === 0) return { entries, roots };
  const hiddenKeys = new Set(hiddenProjects.map((p) => p.key));
  return {
    entries: entries.filter((e) => {
      const project = e.frontmatter.project;
      return !(typeof project === 'string' && hiddenKeys.has(project));
    }),
    roots: roots.filter((r) => !hiddenKeys.has(r.key)),
  };
}

/**
 * Orders project-like entries for the project list and everywhere projects
 * are shown in sequence (006, Ergänzung 2026-10-19): `intern`, if present,
 * always first, regardless of `order`. Without `order`, the rest sorts by
 * `name` (`localeCompare`, `sensitivity: 'base'`, so case makes no
 * difference), ties broken by `key`. With `order`, entries whose key appears
 * in it keep that rank; a stale key in `order` with no matching entry is
 * simply skipped; entries missing from `order` (new projects) are appended,
 * sorted the same way as the no-order case.
 */
export function orderProjects<T extends { key: string; name: string }>(items: T[], order?: string[]): T[] {
  const intern = items.filter((item) => item.key === 'intern');
  const rest = items.filter((item) => item.key !== 'intern');
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key);
  if (!order) return [...intern, ...rest.slice().sort(byName)];

  const rank = new Map(order.filter((key) => key !== 'intern').map((key, index) => [key, index]));
  const known = rest.filter((item) => rank.has(item.key)).sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  const unknown = rest.filter((item) => !rank.has(item.key)).sort(byName);
  return [...intern, ...known, ...unknown];
}

const INVALID_ROOT_PATTERN = /\\|^\/|^[a-zA-Z]:/;

/**
 * Rejects a `ktm_root` that could escape the vault or land inside Obsidian's
 * own config folder (006 S42, F071 K1/K2, sharpened 011 Ergänzung 2026-09-25
 * "Konfigurationsordner als Root"): a backslash (Windows separator), a
 * leading slash or drive letter (absolute outside the vault), a `..`
 * segment anywhere, or a first segment `.obsidian` — checked case-insensitive
 * and after stripping a repeated leading `./`, so `.OBSIDIAN/x` and
 * `./.obsidian/x` are rejected just like `.obsidian/x`. A trailing slash is
 * stripped before the segment check, since the rest of the code trims it too
 * (parseColumns etc.); an empty root stays valid here — a project without a
 * root simply has no Standardablage (011, "Leerer ktm_root").
 */
export function invalidRoot(root: string): boolean {
  const normalized = normalizeRootForCheck(root);
  if (INVALID_ROOT_PATTERN.test(normalized)) return true;
  const segments = normalized.replace(/\/+$/, '').split('/');
  return segments.includes('..') || segments[0] === '.obsidian';
}

function normalizeRootForCheck(root: string): string {
  let normalized = root.toLowerCase();
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

const COLUMN_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * Builds a status key from a column name: the same slug as `slugifyStatus`,
 * further stripped of diacritics (Unicode NFD, combining marks removed) and
 * `ß` folded to `ss`, since a status key must stay plain ASCII
 * (`[a-z][a-z0-9_-]*`, 006 addendum 2026-09-22). A slug that still does not
 * start with a letter (a pure number, or empty) gets the prefix `col-`, so the
 * key is never a bare number and never collides with a reserved role key by
 * accident (K2).
 */
export function columnKey(name: string): string {
  const slug = slugifyStatus(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '');
  return COLUMN_KEY_PATTERN.test(slug) ? slug : `col-${slug}`;
}

/**
 * The role of a column key (006, Ergänzung 2026-10-25 "Spaltenrolle aktiv"):
 * `done`/`wont-do` always carry their own reserved role, regardless of
 * `explicit` (#648, the role follows the key, not a stored value). `doing`
 * defaults to active, every other key to open; `explicit`, the role read
 * from `data.json` or the note, overrides that default only for a key that
 * is not itself an end role.
 */
function roleForKey(key: string, explicit?: 'aktiv' | 'offen'): ColumnRole {
  if (key === 'done') return 'done';
  if (key === 'wont-do') return 'wont-do';
  if (explicit === 'aktiv') return 'active';
  if (explicit === 'offen') return 'open';
  return key === 'doing' ? 'active' : 'open';
}

function isEndRole(role: ColumnRole): boolean {
  return role === 'done' || role === 'wont-do';
}

// `all`/`internal` are the board's own view ids (VIEW_ALL/VIEW_INTERNAL,
// F074), `intern`/`alle` their German names (S53, 006 addendum 2026-09-24): a
// project taking any of these keys would make that key unreachable as a view.
const RESERVED_PROJECT_KEYS = new Set(['intern', 'alle', 'all', 'internal']);

/**
 * Validates a project about to be created on the settings page (F085, 006
 * addendum 2026-09-24, S48): `null` when `name`, `key` and `root` may become a
 * new project note, otherwise a German reason naming what is wrong (#716: each
 * reason carries a distinct word — "leer", "ungültiges Kürzel", "reserviert",
 * "schon vergeben", "ungültig", "überschneidet" — so a caller can tell them
 * apart). A root is rejected the same way {@link invalidRoot} rejects one, and
 * additionally when it lies inside, or contains, the root of any existing
 * project, hidden ones included (segment-wise, ignoring a trailing slash) —
 * two projects sharing files would make "which project owns this note"
 * ambiguous.
 */
export function validateNewProject(
  name: string,
  key: string,
  root: string,
  existing: ProjectSettings[],
): string | null {
  if (!name.trim()) return 'Der Name darf nicht leer sein.';
  if (!COLUMN_KEY_PATTERN.test(key)) {
    return `„${key}“ ist ein ungültiges Kürzel: nur a-z, 0-9, „-“ und „_“, beginnend mit einem Buchstaben.`;
  }
  if (RESERVED_PROJECT_KEYS.has(key)) return `„${key}“ ist reserviert und kann nicht vergeben werden.`;
  if (existing.some((p) => p.key === key)) return `Das Kürzel „${key}“ ist schon vergeben.`;
  const trimmedRoot = root.replace(/\/+$/, '');
  if (!trimmedRoot || invalidRoot(root)) return `Der Root „${root}“ ist ungültig.`;
  for (const project of existing) {
    const otherRoot = project.root.replace(/\/+$/, '');
    const overlaps =
      trimmedRoot === otherRoot ||
      trimmedRoot.startsWith(otherRoot + '/') ||
      otherRoot.startsWith(trimmedRoot + '/');
    if (overlaps) {
      return `Der Root überschneidet sich mit dem Root von „${project.name}“ (${project.root}).`;
    }
  }
  return null;
}

export interface ParsedColumns {
  columns: Column[];
  notices: string[];
}

/**
 * Resolves the set of statuses that count as done, the reserved keys `done`
 * and `wont-do` plus every alias of such a column (K5, K6): a card whose
 * `status` is an old slug that a column now carries only as an alias still
 * counts as completed, so the reconciliation with `Done/` does not reopen it
 * (008, addendum 2026-09-22).
 */
export function doneStatuses(columns: Column[]): Set<string> {
  const set = new Set<string>();
  for (const col of columns) {
    if (!col.done) continue;
    set.add(col.status);
    for (const alias of col.aliases ?? []) set.add(alias);
  }
  return set;
}

/**
 * Decides whether a status counts as closed for the Done reconciliation
 * (008, addendum 2026-09-22, F066): the reserved keys `done` and `wont-do`
 * are always closed, regardless of what the column list says about them
 * (#644, the old form can give the `done` key an `open` role). Any other
 * key or alias found in `columns` follows that column's own `done` flag.
 * An empty status or one that matches nothing in `columns` is unknown
 * (`undefined`): neither closed nor open, so a caller must not reconcile it.
 */
export function statusClosure(status: string, columns: Column[]): boolean | undefined {
  if (!status) return undefined;
  if (status === 'done' || status === 'wont-do') return true;
  for (const col of columns) {
    if (col.status === status || col.aliases?.includes(status)) return col.done;
  }
  return undefined;
}

/**
 * Resolves an old status slug to the reserved key it is an alias of (008,
 * addendum 2026-09-22, second part, S43): `undefined` when `status` already
 * is a column's own key (nothing to rewrite) or matches no column's alias at
 * all (an unrelated or unknown status). Used on the write path so a note
 * still carrying the pre-rename slug gets `status` normalized to the key the
 * very next time the board writes any field of it.
 */
export function canonicalStatus(status: string, columns: Column[]): string | undefined {
  if (columns.some((c) => c.status === status)) return undefined;
  for (const col of columns) {
    if (col.aliases?.includes(status)) return col.status;
  }
  return undefined;
}

function isColumnConfig(value: unknown): value is ColumnConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.key === 'string' && typeof v.name === 'string';
}

/** The eingebauten Standardspalten (006 S57): shared by `DEFAULT_SETTINGS.columns`
 * (main.ts) and resolveColumns' own last resort, so there is exactly one list. */
export const DEFAULT_COLUMNS: ColumnConfig[] = [
  { key: 'backlog', name: 'Backlog' },
  { key: 'ready', name: 'Ready' },
  { key: 'doing', name: 'Doing' },
  { key: 'done', name: 'Done' },
  { key: 'wont-do', name: "Won't Do" },
];

// parseColumns always succeeds on DEFAULT_COLUMNS (well-formed, unique keys),
// computed once instead of re-parsing it on every resolveColumns fallback.
const RESOLVED_DEFAULT_COLUMNS: Column[] = DEFAULT_COLUMNS.map((c) => {
  const role = roleForKey(c.key);
  return { status: c.key, name: c.name, done: isEndRole(role), role };
});

/** A short JSON rendering of an unusable column entry for a notice (K9/K10). */
function describeEntry(entry: unknown): string {
  try {
    return JSON.stringify(entry);
  } catch {
    return String(entry);
  }
}

function unusableEntryNotice(entry: unknown): string {
  return `Unbrauchbarer Spalten-Eintrag ${describeEntry(entry)} wird übersprungen.`;
}

/**
 * Parses a raw column list plus its done-column list (`ktm_columns` /
 * `ktm_done_columns` or their `data.json` counterparts) into `Column`s with
 * key, name and role (006, addendum 2026-09-22; Ergänzung 2026-10-18 "Eintrag
 * für Eintrag"). Every entry is read for itself, in any mix: an object
 * `{key, name}` is the `data.json` form; a string containing `|` is the
 * note's flat-string new form `key | name`; a plain string without `|` is the
 * old form (a display name, its role coming from position in
 * `rawDoneColumns`, like the pre-2026-10-18 `parseOldFormColumns`). Either way
 * the role of an object or new-form entry follows only from the reserved key
 * (`done`, `wont-do`). A name whose own slug differs from the assigned key
 * becomes an alias, so a note with the old `status` value keeps finding its
 * column (K2, K5 of 008). A malformed or otherwise unusable entry (wrong
 * separator count, invalid key, object without a valid key or name, a
 * duplicate key, or any value that is neither a column object nor a string)
 * is skipped and reported by itself, naming the entry (K8-K10); the other
 * entries still become columns. `null` only when not a single entry produced
 * a column (S60): the caller falls back further (resolveColumns).
 */
export function parseColumns(rawColumns: unknown, rawDoneColumns: unknown): ParsedColumns | null {
  if (!Array.isArray(rawColumns) || rawColumns.length === 0) return null;

  const doneNames = Array.isArray(rawDoneColumns)
    ? rawDoneColumns.filter((v): v is string => typeof v === 'string')
    : [];
  const roleByOldSlug = new Map<string, ColumnRole>();
  const notices: string[] = [];
  doneNames.forEach((doneName, i) => {
    const slug = slugifyStatus(doneName);
    if (i === 0) roleByOldSlug.set(slug, 'done');
    else if (i === 1) roleByOldSlug.set(slug, 'wont-do');
    else notices.push(`Zusätzliche abgeschlossene Spalte „${doneName}“ wird ignoriert und bleibt offen.`);
  });

  const seenKeys = new Set<string>();
  const columns: Column[] = [];
  const addColumn = (key: string, column: Column): void => {
    if (seenKeys.has(key)) {
      notices.push(`Doppelter Spaltenschlüssel „${key}“ wird ignoriert.`);
      return;
    }
    seenKeys.add(key);
    columns.push(column);
  };

  // Reads an explicit third value (object `role` or the note's third `|`
  // part): `undefined` when absent, the parsed role when it is "aktiv" or
  // "offen", and `null` for anything else — unusable on an open key, but
  // ignored on an end key, whose role never comes from this value anyway
  // (006, Ergänzung 2026-10-25).
  const explicitRole = (raw: unknown, isEnd: boolean): 'aktiv' | 'offen' | undefined | null => {
    if (raw === undefined) return undefined;
    if (raw === 'aktiv' || raw === 'offen') return raw;
    return isEnd ? undefined : null;
  };

  for (const entry of rawColumns) {
    if (isColumnConfig(entry)) {
      const { key, name } = entry;
      if (!key || !name || !COLUMN_KEY_PATTERN.test(key)) {
        notices.push(unusableEntryNotice(entry));
        continue;
      }
      const isEnd = key === 'done' || key === 'wont-do';
      const explicit = explicitRole((entry as ColumnConfig).role, isEnd);
      if (explicit === null) {
        notices.push(unusableEntryNotice(entry));
        continue;
      }
      const role = roleForKey(key, explicit);
      addColumn(key, { status: key, name, done: isEndRole(role), role });
      continue;
    }
    if (typeof entry === 'string' && entry.includes('|')) {
      const parts = entry.split('|').map((p) => p.trim());
      const [key, name, rawRole] = parts;
      if (parts.length < 2 || parts.length > 3 || !key || !name || !COLUMN_KEY_PATTERN.test(key)) {
        notices.push(unusableEntryNotice(entry));
        continue;
      }
      const isEnd = key === 'done' || key === 'wont-do';
      const explicit = explicitRole(rawRole, isEnd);
      if (explicit === null) {
        notices.push(unusableEntryNotice(entry));
        continue;
      }
      const role = roleForKey(key, explicit);
      addColumn(key, { status: key, name, done: isEndRole(role), role });
      continue;
    }
    if (typeof entry === 'string') {
      const oldSlug = slugifyStatus(entry);
      // The old form's done/wont-do role comes only from position in
      // rawDoneColumns, never from the slug matching "done" by coincidence
      // (#644/#648: a column merely named "Done" stays open unless listed).
      // "doing" is the one slug that does get a role from itself, by the
      // same default as every other form (006, Ergänzung 2026-10-25,
      // "Standard gilt auch in der alten Form").
      const endRole = roleByOldSlug.get(oldSlug);
      const role: ColumnRole = endRole ?? (oldSlug === 'doing' ? 'active' : 'open');
      const isEnd = isEndRole(role);
      const key: string = isEnd ? role : COLUMN_KEY_PATTERN.test(oldSlug) ? oldSlug : columnKey(entry);
      const column: Column = { status: key, name: entry, done: isEnd, role };
      if (oldSlug !== key) column.aliases = [oldSlug];
      addColumn(key, column);
      continue;
    }
    notices.push(unusableEntryNotice(entry));
  }

  if (columns.length === 0) return null;
  return { columns, notices };
}

/**
 * Whether `key` may become a column's own key on the settings page (F070's
 * ColumnDialog free-key input, S39): matches {@link COLUMN_KEY_PATTERN}, is
 * not already used by another column in `existing`, and is not one of the
 * reserved role keys `done`/`wont-do` — those are earned only by taking on
 * that role, never typed in directly.
 */
export function isValidColumnKey(key: string, existing: Column[]): boolean {
  if (!COLUMN_KEY_PATTERN.test(key)) return false;
  if (key === 'done' || key === 'wont-do') return false;
  return !existing.some((c) => c.status === key);
}

/**
 * The valid elements of every level (task, feature, epic — not just task)
 * that a column currently holds, scoped like the settings page's "Gilt für"
 * (F070's removeColumn/changeColumnRole, S37-S39): a project scope keeps only
 * that project's elements, general scope keeps elements without a project
 * plus those of any project that carries no own column list (so it inherits
 * the general one being edited, rather than one of its own). A card matches
 * by the column's key or one of its old-slug aliases (F065); invalid
 * elements never count.
 */
export function columnMembers(
  elements: BoardElement[],
  column: Pick<Column, 'status' | 'aliases'>,
  scope: string,
  projects: ProjectSettings[],
): BoardElement[] {
  const keys = new Set([column.status, ...(column.aliases ?? [])]);
  const inGeneralScope = (project: string | undefined): boolean => {
    if (!project) return true;
    return projects.find((p) => p.key === project)?.columns === undefined;
  };
  return elements.filter((el) => {
    if (el.invalid) return false;
    if (!keys.has(el.status)) return false;
    return scope === 'general' ? inGeneralScope(el.project) : el.project === scope;
  });
}

/**
 * Resolves the columns a project shows: its own column list if at least one
 * entry parses, otherwise the general list if at least one entry of that
 * parses, otherwise the eingebauten {@link DEFAULT_COLUMNS} (006, Ergänzung
 * 2026-10-18 "Keine gültige Spalte"). Never an empty list (S60); without a
 * project, as in the `all` view, only the general columns apply.
 */
export function resolveColumns(general: GeneralSettings, project?: ProjectSettings): Column[] {
  if (project?.columns !== undefined) {
    const own = parseColumns(project.columns, project.doneColumns);
    if (own) return own.columns;
  }
  const parsed = parseColumns(general.columns, general.doneColumns);
  return parsed ? parsed.columns : RESOLVED_DEFAULT_COLUMNS;
}

/**
 * The hint-area notices for the general `columns` setting alone (006,
 * Ergänzung 2026-10-18 "data.json: " Präfix, Muster der Projektnotiz-Hinweise
 * in {@link resolveProjectSettings}): every per-entry notice from parsing
 * `data.json`'s own `columns`, or, when none of its entries parse at all, one
 * notice saying so and that the Standardspalten apply (S60/K12).
 */
export function generalColumnNotices(general: Pick<GeneralSettings, 'columns' | 'doneColumns'>): string[] {
  const prefix = 'data.json: ';
  const parsed = parseColumns(general.columns, general.doneColumns);
  if (!parsed) return [`${prefix}„columns“ enthält keine gültige Spalte, Standardspalten gelten.`];
  return parsed.notices.map((n) => `${prefix}${n}`);
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
 * Resolves which card fields a board card shows, and in which order: the
 * general `cardFields` list filtered to valid, non-repeated keys in its own
 * stored order (F058, drag-to-reorder on the settings page needs the order
 * kept, not folded back onto CARD_FIELDS' fixed order), or every field in the
 * fixed CARD_FIELDS order when the setting is missing, invalid or empty (006
 * S11).
 */
export function resolveCardFields(general?: Pick<GeneralSettings, 'cardFields'>): CardField[] {
  const raw: unknown = general?.cardFields;
  if (!Array.isArray(raw)) return [...CARD_FIELDS];
  const seen = new Set<CardField>();
  const fields: CardField[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !CARD_FIELDS.includes(value as CardField)) continue;
    const field = value as CardField;
    if (seen.has(field)) continue;
    seen.add(field);
    fields.push(field);
  }
  return fields.length > 0 ? fields : [...CARD_FIELDS];
}

/**
 * Parses the project note's `ktm_card_fields`: a flat list of field keys
 * (unlike `ktm_levels`/`ktm_link_kinds` there is no `|`-joined structure, a
 * card field is just its key). Mirrors {@link parseLevelList}: any single
 * malformed entry (unknown key, duplicate) invalidates the whole list, the
 * caller falls back to the general card fields and reports the note and key.
 */
export function parseCardFieldList(raw: unknown): CardField[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const seen = new Set<CardField>();
  const fields: CardField[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return null;
    const value = entry.trim() as CardField;
    if (!CARD_FIELDS.includes(value) || seen.has(value)) return null;
    seen.add(value);
    fields.push(value);
  }
  return fields;
}

export interface TagEntry {
  tag: string;
  icon?: string;
}

// Obsidian's own tag form: letters, digits, `_`, `-`, and `/` for sub-tags, no
// `#`, no whitespace (006, Ergänzung 2026-10-25 "Tags mit Icon").
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]*(\/[A-Za-z0-9_][A-Za-z0-9_-]*)*$/;

/** Whether `tag` has Obsidian's tag form, without the leading `#`. */
export function isValidTag(tag: string): boolean {
  return TAG_PATTERN.test(tag);
}

/**
 * Parses the flat note encoding of a tag list, `"tag"` or `"tag | icon"` per
 * entry (006, Ergänzung 2026-10-25 "Tags mit Icon"), mirroring
 * {@link parseLevelList}. Any single malformed entry (invalid tag, empty
 * icon after a separator, duplicate tag without regard to case) invalidates
 * the whole list; the caller falls back to the general tags and reports the
 * note and key.
 */
export function parseTagList(raw: unknown): TagEntry[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const seen = new Set<string>();
  const tags: TagEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return null;
    const parts = entry.split('|').map((p) => p.trim());
    if (parts.length !== 1 && parts.length !== 2) return null;
    const [tag, icon] = parts;
    if (!tag || !isValidTag(tag)) return null;
    if (parts.length === 2 && !icon) return null;
    const key = tag.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    tags.push(icon ? { tag, icon } : { tag });
  }
  return tags;
}

/**
 * Resolves the general tags: `tagList` from `data.json`, with every
 * individually unbrauchbar (invalid or case-insensitively duplicate) entry
 * dropped, same pattern as {@link resolveLevels}. A missing or empty list
 * resolves to an empty list, not a built-in default — unlike levels or link
 * kinds, tags have no fallback (006, Ergänzung 2026-10-25).
 */
export function resolveTagList(general?: Pick<GeneralSettings, 'tagList'>): TagEntry[] {
  const raw: unknown = general?.tagList;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const tags: TagEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.tag !== 'string' || !isValidTag(e.tag)) continue;
    const key = e.tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const icon = typeof e.icon === 'string' && e.icon ? e.icon : undefined;
    tags.push(icon ? { tag: e.tag, icon } : { tag: e.tag });
  }
  return tags;
}

/**
 * The wirksame Liste eines Projekts (006, Ergänzung 2026-10-25): its own tags
 * in their stored order, then the general tags, skipping any that already
 * appear in the project's own list (ohne Rücksicht auf Groß- und
 * Kleinschreibung) — so a project's icon wins over the general one for the
 * same tag (S98/S99, K1).
 */
export function effectiveTags(general: Pick<GeneralSettings, 'tagList'>, project?: Pick<ProjectSettings, 'tags'>): TagEntry[] {
  const own = project?.tags ?? [];
  const seen = new Set(own.map((t) => t.tag.toLowerCase()));
  const result = [...own];
  for (const tag of resolveTagList(general)) {
    const key = tag.tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
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

/**
 * Reads `ktm_short_in_chips`: a native boolean, or the strings `"true"` and
 * `"false"` (the Properties panel offers a checkbox, but a hand-typed note or
 * Claude may write either form). Anything else is ignored, so the row falls
 * back to the general value instead of a project note with a typo silently
 * turning it off.
 */
function boolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export interface ResolvedSettings {
  levels: Level[];
  linkKinds: LinkKind[];
  cardFields: CardField[];
  doneLimit?: number;
  columns: Column[];
  allLevels: 'rank' | 'bottom';
  ribbon?: boolean;
  shortInChips: boolean;
}

/**
 * Resolves the settings that apply to a board view: project-capable keys
 * (levels, linkKinds, cardFields, doneLimit, columns) from the project note if
 * it sets them, otherwise the general value (resolveColumns' merge pattern,
 * #372); keys that are general-only (ribbon, allLevels) always come from
 * `general`, the project note is never read for them (006, addendum
 * 2026-09-20).
 */
export function settingsFor(general: GeneralSettings, project?: ProjectSettings): ResolvedSettings {
  return {
    levels: project?.levels ?? resolveLevels(general),
    linkKinds: project?.linkKinds ?? resolveLinkKinds(general),
    cardFields: project?.cardFields ?? resolveCardFields(general),
    doneLimit: project?.doneLimit ?? general.doneLimit,
    columns: resolveColumns(general, project),
    allLevels: general.allLevels ?? 'rank',
    ribbon: general.ribbon,
    shortInChips: project?.shortInChips ?? general.shortInChips ?? true,
  };
}
