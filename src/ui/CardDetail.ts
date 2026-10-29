import {
  type App,
  Component,
  DropdownComponent,
  MarkdownRenderer,
  Menu,
  Notice,
  Platform,
  setIcon,
  setTooltip,
  type TFile,
  TFolder,
  ToggleComponent,
} from 'obsidian';
import {
  dueState,
  monthGrid,
  parseDateInput,
  priorityIcon,
  priorityLabel,
  relativeDate,
} from '../core/dates';
import { offerableLevels } from '../core/board';
import type { LinkResolver } from '../core/check';
import { flowList, yamlScalar } from '../core/frontmatter';
import { expandBlankLines, toggleMarkup, wrapSelection } from '../core/markup';
import type { BoardElement, ElementPaths, ElementType, FreeLink, ParentRef } from '../core/model';
import { startedAfterStatusChange } from '../core/move';
import { linkDisplayName } from '../core/read';
import {
  type Column,
  isBottomLevel,
  type Level,
  type LinkKind,
  RESULT_LINK_KIND,
  statusClosure,
  type TagEntry,
} from '../core/settings';
import { toggleTaskLine } from '../core/tasklist';
import { canonicalTag, tagSuggestions } from '../core/tags';
import { ParentDialog } from './ParentDialog';

// `vault.getConfig` and `hotkeyManager` are part of the running app but not
// of the public typings (narrow, like `DesktopApp` in BoardView.ts): only the
// two editor settings and the two command hotkeys the description field
// reads (002, Ergänzung 2026-10-18 "Markdown auf einer Markierung").
interface DesktopApp extends App {
  vault: App['vault'] & { getConfig(key: string): unknown };
  hotkeyManager: {
    getHotkeys(id: string): Hotkey[] | undefined;
    getDefaultHotkeys(id: string): Hotkey[] | undefined;
  };
}

interface Hotkey {
  modifiers: string[];
  key: string;
}

// One keystroke that, with a non-empty selection and the matching Obsidian
// setting on, wraps instead of replaces (002 S59/S60). `bracket` picks which
// of the two settings governs it (autoPairBrackets vs. autoPairMarkdown).
const PAIR_CHARS: Record<string, { open: string; close: string; bracket: boolean }> = {
  '*': { open: '*', close: '*', bracket: false },
  _: { open: '_', close: '_', bracket: false },
  '`': { open: '`', close: '`', bracket: false },
  '~': { open: '~', close: '~', bracket: false },
  '=': { open: '=', close: '=', bracket: false },
  '(': { open: '(', close: ')', bracket: true },
  '[': { open: '[', close: ']', bracket: true },
  '{': { open: '{', close: '}', bracket: true },
  '"': { open: '"', close: '"', bracket: true },
};

// `require('electron')` is available in every Obsidian desktop plugin
// (manifest isDesktopOnly: true); narrowed to the calls the image menu's
// copy action needs (002, Ergänzung 2026-10-26). Both clipboards are typed
// because copyImage picks between them by the rule Obsidian's own copy
// action follows (obsidian.asar: `electronMajor < 40 ? electron.clipboard :
// electron.remote.clipboard`).
interface ElectronClipboard {
  writeImage(image: unknown): void;
  readImage(): { isEmpty(): boolean };
}

interface ElectronRenderer {
  clipboard: ElectronClipboard;
  remote: { clipboard: ElectronClipboard };
  nativeImage: { createFromBuffer(buffer: Buffer): { isEmpty(): boolean } };
}

// Obsidian's own hotkey for a command, falling back to its default once no
// custom binding is set (`getHotkeys` returns `undefined` then, not `[]`).
function resolveHotkeys(app: App, commandId: string): Hotkey[] {
  const manager = (app as DesktopApp).hotkeyManager;
  const custom = manager?.getHotkeys?.(commandId);
  if (custom !== undefined) return custom;
  return manager?.getDefaultHotkeys?.(commandId) ?? [];
}

function matchesHotkey(ev: KeyboardEvent, hotkeys: Hotkey[]): boolean {
  return hotkeys.some((hotkey) => {
    const mods = new Set(hotkey.modifiers);
    const wantCtrl = mods.has('Ctrl') || (mods.has('Mod') && !Platform.isMacOS);
    const wantMeta = mods.has('Meta') || (mods.has('Mod') && Platform.isMacOS);
    return (
      ev.ctrlKey === wantCtrl &&
      ev.metaKey === wantMeta &&
      ev.shiftKey === mods.has('Shift') &&
      ev.altKey === mods.has('Alt') &&
      ev.key.toUpperCase() === hotkey.key.toUpperCase()
    );
  });
}

// The edits the detail view collects and writes when it closes. `body` is the
// markdown below the frontmatter; `status`/`priority`/`planned`/`due` are plain
// frontmatter fields. Title, project, level and the parentLabel driven via the
// link list feed `refile` instead: filing them (rename, folder
// move, guard) needs the whole vault, so the board resolves and applies it
// (F034/F051).
interface Draft {
  status: string;
  priority: number;
  planned?: string;
  due?: string;
  started?: string;
  body: string;
  title: string;
  short?: string;
  project?: string;
  type: ElementType;
  parentLabel: string;
  tags: string[];
  links: FreeLink[];
  // The parent chain picked in this session, nearest parent first like
  // `element.parents` (F052 K1/K2, F105): effectiveParents() returns it
  // unchanged once set, ahead of the refile that only happens on close. An
  // empty array (011, Ergänzung 2026-09-25, pickLevel; 008, Ergänzung
  // 2026-10-06) means "ohne Parent"; `undefined` means untouched this
  // session, falling back to `element.parents`.
  newParents?: ParentRef[];
  // The Ordner-Feld's picked target this session (F054): `undefined` means
  // untouched, a path means a chosen own folder, `null` means "Standardablage"
  // picked explicitly. Both defined values differ from the initial `undefined`
  // baseline, so `changes()` reports a refile exactly when the field was used.
  ownFolderTarget?: string | null;
  // Draft only (F055): the folder field's chosen form, mirroring
  // `element.form` at open time. A fixed atomic draft (view all/internal)
  // never flips it back (renderFolderField's early return keeps the field
  // display-only there, "ausserhalb"); a nested draft's picker toggles it
  // via pickAtomic/pickFolder, and pickParent clears it (008 S22).
  atomic: boolean;
}

// The five fields a filing edit can touch; present only where the draft
// differs from the note's original value. `folder` (F054) is the folder field's
// pick: a path or `null` for "Standardablage".
export interface RefileRequest {
  title?: string;
  project?: string;
  type?: ElementType;
  parentLabel?: string;
  folder?: string | null;
}

// The draft's filing target (draftTarget()): final values, not a diff —
// Status or parent often stay at their opening default, which a diff
// against that default would omit even though the new note still needs them.
export interface DraftTarget {
  title: string;
  status: string;
  type: ElementType;
  project?: string;
  parentLabel: string;
  // F055: the folder field's chosen form. `atomic` wins outright
  // (_Tasks/Atomic/); else a defined `ownFolder` places directly under that
  // path; else `parentLabel` resolves the Standardablage, with or without a
  // picked ancestor (008 S21-S23, wissen #477).
  atomic: boolean;
  ownFolder?: string;
}

export interface DetailChanges {
  frontmatter: Record<string, string | null>;
  body?: string;
  refile?: RefileRequest;
  // Child note paths whose cross in the link list was clicked
  // (F051 K6): the board moves them one level up when closing, into
  // this element's parent's folder.
  detachedChildren?: string[];
}

// The field block offers project and level as dropdowns; their option lists
// are resolved by the board and handed in here. Parent has no dropdown
// anymore (F051): the parent chain comes from `element.parents` and is edited
// through the link list's cross, not through an options list.
export interface DetailOptions {
  projects: string[];
  // The levels of one project, in project order (F052, F104): a draft
  // re-resolves this as its own project-dropdown changes, so it is a
  // resolver rather than a fixed list taken at open time. `undefined` asks
  // for the general levels (no project, i.e. "intern").
  levelsFor: (project: string | undefined) => Level[];
  // Whether a project has a configured root, i.e. a Standardablage (F104,
  // 011 "Leerer ktm_root"); `undefined` (no project, "intern") never has one.
  hasRoot: (project: string | undefined) => boolean;
  linkKinds: LinkKind[];
  vaultTags: string[];
  // The wirksame Liste (006, Ergänzung 2026-10-25) of a project's hinterlegte
  // Tags, same resolver pattern as levelsFor: a draft re-resolves this as its
  // own project dropdown changes (002, Ergänzung 2026-10-25).
  tagsFor: (project: string | undefined) => TagEntry[];
}

// One link-menu search hit for a level (F052 S36): the board resolves it
// from its already-loaded elements, so this component never imports obsidian
// vault APIs for it. `chain` is the hit's own parent chain, top to bottom,
// including the hit itself (F105, core/board.ts#parentChain): picking the
// hit as a parent brings this chain along, not just the hit alone.
export interface LinkSearchResult {
  id: string;
  path: string;
  title: string;
  project?: string;
  statusName: string;
  chain: ParentRef[];
  /** Visual group index for the link-menu's list (002, Ergänzung 2026-10-18): a separator is drawn wherever this changes. */
  group: number;
  closed: boolean;
}

// One offering in the link-menu's kind dropdown (F052, availableArts): either
// a level of the element's own project (`level` set, `ancestor` true when it
// ranks above the element's own level and can therefore be its parent) or a
// free link kind (`linkKind` set).
interface LinkArt {
  label: string;
  icon: string;
  level?: ElementType;
  ancestor?: boolean;
  linkKind?: LinkKind;
}

export interface CardDetailHost {
  close(): void;
  openNote(path: string): void;
  // Reveals the element's folder in the file tree (002 S4/K3, 008 S42);
  // distinct from a click elsewhere in the field, which opens the picker (F054).
  revealFolder(path: string): void;
  openChild(element: BoardElement): void;
  openLink(target: string): void;
  // Creates a new note (or, for a kind with a `prefix`, an ADR) next to the
  // element and returns the unbracketed wikilink text (`fileToLinktext`) to
  // store in `notes`/`adr`; needs vault write access, so it lives on the
  // board (F035).
  createLinkNote(kind: LinkKind, title: string): Promise<string | undefined>;
  // Searches the elements of one level for the link-menu (002, Ergänzung
  // 2026-10-18, S53-S58; core/board.ts#linkCandidates does the grouping and
  // sorting): grouped by project (the card's own first, in a project view
  // only that project), within a group the descendants of `parentIds` (the
  // card's currently set parents) ahead of the rest, open before closed,
  // both alphabetical. An empty query still returns the full list, so the
  // field shows candidates before anything is typed. Unbounded, since the
  // list scrolls (DESIGN.md .ktm-linkmenu-list).
  searchElements(level: ElementType, query: string, parentIds: string[]): LinkSearchResult[];
  // Opens a stacked draft of the chosen level above the currently
  // open card (008 addendum 2026-09-20, F053): `ancestor` true when the
  // level ranks above its own (the open card becomes its child),
  // else the open card itself becomes the draft's parent.
  createStackedElement(level: ElementType, ancestor: boolean, title: string): void;
  // Writes `type` and `parent`/`parent_link` immediately, once a level at or
  // above the current parent's height is confirmed in the ParentDialog (011,
  // Ergänzung 2026-09-25, "Ebene wechseln"): `parentId` null clears the
  // parent. Resolves false on a failed write, so the field can be rolled
  // back instead of pretending the change happened.
  changeLevel(type: ElementType, parentId: string | null): Promise<boolean>;
  // Writes `ktm_placement` immediately when the "Ablage automatisch" toggle
  // is flipped (011, Ergänzung 2026-09-25, "Von Hand verschoben"/"Zurück").
  setPlacement(value: 'auto' | 'manual'): Promise<boolean>;
  // Opens the Result-Dialog for `target` and, once confirmed, moves it and
  // writes `results`/`notes` (002/008, Ergänzung 2026-10-19 "Result");
  // `fromKind` is set only for "Als Result markieren" so the write also
  // drops the link from its old kind. A cancelled dialog or a failed step
  // changes nothing on the card.
  assignResult(target: TFile, fromKind?: string): Promise<void>;
  // The "<Ebene> <Titel>" of whichever element carries `target` in its own
  // `notes` (002 S84), or undefined if none does — used for the Result
  // row's right-hand "→ …" label.
  resultTargetLabel(target: string): string | undefined;
}

// "intern" is a project like any other (003 addendum 2026-10-06, 008): the
// board always offers it first and reads it back as no project at all
// (BoardView's own INTERNAL_PROJECT/read.ts), so the dropdown only ever maps
// to/from the empty `draft.project`, never stores the word itself.
const INTERN_PROJECT = 'intern';

const LEVEL_LABEL: Record<ElementType, string> = {
  task: 'Task',
  feature: 'Feature',
  epic: 'Epic',
};

const PARENT_ICON: Record<'feature' | 'epic', string> = {
  feature: 'box',
  epic: 'layers',
};

const CHILD_ICON: Record<ElementType, string> = {
  task: 'square',
  feature: 'box',
  epic: 'layers',
};

export const MONTH_NAMES = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];

export const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

export function shiftMonth(year: number, month: number, delta: number): [number, number] {
  const total = year * 12 + (month - 1) + delta;
  return [Math.floor(total / 12), (total % 12) + 1];
}

interface DateEditState {
  kind: 'planned' | 'due' | 'started';
  wrap: HTMLElement;
  input: HTMLInputElement;
  calendarEl: HTMLElement;
  prev?: string;
  cleanup: () => void;
}

/**
 * Content of the expanded card, second layout: title, the field block (Status,
 * project, level, parent as dropdowns, then wrapping Tags with a ghost
 * chip), a rendered-yet-editable description, the planning fields, the links
 * (structural first, then the free notes and ADRs) and — on a feature or epic —
 * the children. The opening mechanism and placement live in the board; this
 * component only fills a given element and reports the pending edits so closing
 * can persist them.
 */
export class CardDetail extends Component {
  private readonly draft: Draft;
  private readonly original: Draft;
  private editingBody = false;
  private descriptionEdit!: HTMLTextAreaElement;
  private descriptionWrap!: HTMLElement;
  private dueWrap?: HTMLElement;
  private startedWrap?: HTMLElement;
  private dateEdit?: DateEditState;
  private titleWrap!: HTMLElement;
  private titleEdit?: { input: HTMLInputElement; prev: string; cleanup: () => void };
  private shortWrap!: HTMLElement;
  private shortEdit?: { input: HTMLInputElement; prev?: string; cleanup: () => void };
  private tagsWrap!: HTMLElement;
  private tagEdit?: { cleanup: () => void };
  private linksWrap!: HTMLElement;
  private linkMenu?: { head: HTMLElement; el: HTMLElement; cleanup: () => void };
  private folderWrap!: HTMLElement;
  private folderMenu?: { el: HTMLElement; cleanup: () => void };
  // Obsidian's own context menu for an image in the rendered description
  // (002, Ergänzung 2026-10-26): the held Menu instance, so cancelActiveField
  // can close exactly this one.
  private imageMenu?: Menu;
  // Child note paths whose cross was clicked in this session (F051 K6).
  private readonly detachedChildren = new Set<string>();
  // Whether the "Erledigt (n)" group is open in this session; every open of
  // the card starts a new CardDetail instance, so this resets to collapsed
  // without any stored state (002, Ergänzung 2026-10-24, S95).
  private doneExpanded = false;
  // The project-dropdown's own wrap and the level-dropdown's own wrap (F104):
  // a draft repaints both when its project changes, since the offered levels
  // and the chosen one follow the project.
  private projectWrap!: HTMLElement;
  private levelWrap!: HTMLElement;
  // The levels offered by the card's current project (F104): resolved once
  // at open time and, in a draft, again on every project change
  // (onDraftProjectChange). An existing card never retriggers that, so this
  // stays the same list `options.levelsFor(element.project)` would have given
  // at construction.
  private levels: Level[];

  constructor(
    private readonly app: App,
    private readonly containerEl: HTMLElement,
    private readonly element: BoardElement,
    private readonly columns: Column[],
    private readonly today: string,
    private readonly host: CardDetailHost,
    private readonly options: DetailOptions,
    private readonly children: BoardElement[],
    private readonly isDraft = false,
  ) {
    super();
    this.levels = options.levelsFor(element.project);
    // The board element carries no body; the caller feeds it via setBody once
    // the note is read, which also refreshes the baseline for change detection.
    this.draft = {
      status: element.status,
      priority: element.priority,
      planned: element.planned,
      due: element.due,
      started: element.started,
      body: '',
      title: element.title,
      short: element.short,
      project: element.project,
      type: element.type,
      parentLabel: initialParentLabel(element, this.levels),
      tags: [...element.tags],
      links: [...element.links],
      atomic: element.form === 'atomic',
    };
    this.original = { ...this.draft, tags: [...this.draft.tags], links: [...this.draft.links] };
  }

  onload(): void {
    this.render();
  }

  onunload(): void {
    this.dateEdit?.cleanup();
    this.titleEdit?.cleanup();
    this.shortEdit?.cleanup();
    this.tagEdit?.cleanup();
    this.linkMenu?.cleanup();
    this.folderMenu?.cleanup();
    this.imageMenu?.hide();
    this.closeOpenTooltip();
  }

  // Every close path (Escape, outside click, draft, stack) ends in
  // removeChild(this.containerEl); that never fires a mouseleave, so an
  // Obsidian tooltip shown for an element of this card (S81, setTooltip)
  // would otherwise linger in the document after the card itself is gone.
  // A synthetic leave on whatever is still hovered lets Obsidian close it the
  // normal way; if the pointer already moved off before unload, the orphaned
  // node is removed directly.
  private closeOpenTooltip(): void {
    const hovered = this.containerEl.querySelector<HTMLElement>(':hover');
    hovered?.dispatchEvent(new MouseEvent('mouseleave'));
    hovered?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    this.containerEl.doc.querySelector('.tooltip')?.remove();
  }

  // Whether a field's typed-but-unconfirmed input is open. The board asks this
  // before Escape closes the whole card (S11/K4): the field wins first.
  //
  // The image menu (002, Ergänzung 2026-10-26): Obsidian's own Menu can close
  // itself on the very same Escape that reaches BoardView.onDetailEscape
  // (its keymap handling isn't ordered after this card's), which would clear
  // `imageMenu` via onHide before this runs. openImageMenu defers that clear
  // to the next tick, so this still reports true for that first Escape and
  // onDetailEscape routes it to cancelActiveField instead of closing the card.
  hasActiveField(): boolean {
    return (
      this.dateEdit !== undefined ||
      this.titleEdit !== undefined ||
      this.shortEdit !== undefined ||
      this.tagEdit !== undefined ||
      this.linkMenu !== undefined ||
      this.folderMenu !== undefined ||
      this.imageMenu !== undefined
    );
  }

  cancelActiveField(): void {
    if (this.titleEdit) this.cancelTitleEdit();
    else if (this.shortEdit) this.cancelShortEdit();
    else if (this.tagEdit) this.cancelTagEdit();
    else if (this.linkMenu) this.closeLinkMenu();
    else if (this.folderMenu) this.closeFolderMenu();
    else if (this.imageMenu) this.closeImageMenu();
    else this.cancelDateEdit();
  }

  // Only the menu goes away; the fields stay untouched (002, Ergänzung
  // 2026-10-26). Closing through the held instance is the normal path, the
  // document-wide `.menu` lookup only covers it having torn itself down
  // already (same race as hasActiveField's doc comment).
  private closeImageMenu(): void {
    this.imageMenu?.hide();
    this.containerEl.doc.querySelector('.menu')?.remove();
    this.imageMenu = undefined;
  }

  setBody(body: string): void {
    this.draft.body = body;
    this.original.body = body;
    this.renderDescription();
  }

  // Picks up a body Obsidian itself just changed in the note — a rename or
  // move the image menu triggered (002, Ergänzung 2026-10-26 "Änderungen aus
  // dem Menü gehen nicht verloren") — as the new draft/original baseline and
  // re-renders it. Only while the description isn't being edited and this
  // session hasn't touched it yet (draft.body still equals original.body);
  // otherwise it is left exactly as it is, same as refreshLinks leaves an
  // in-flight add/remove alone. The close-time conflict path over `rebase`
  // (S71) still covers an actual edit colliding with an outside change.
  refreshBody(body: string): void {
    if (this.editingBody || this.draft.body !== this.original.body) return;
    this.draft.body = body;
    this.original.body = body;
    this.renderDescription();
  }

  // Replaces the free links with a fresh list read from the note itself (K3/K4:
  // an external edit or a followed rename). Becomes the new baseline too, so
  // closing the card without touching links writes nothing back; an
  // add or remove still in flight in `draft.links` is not merged, it is
  // overwritten by the external state (see "ausserhalb").
  refreshLinks(links: FreeLink[]): void {
    this.draft.links = [...links];
    this.original.links = [...links];
    this.repaintLinks();
  }

  // Patches the element's own note/folder location after an external rename
  // or move (011 K5-K8, BoardView#retargetDetail): only the folder field is
  // repainted, via the same paintFolder() a folder-picker pick already uses,
  // so an edit in progress elsewhere on the card (draft.*) is untouched.
  refreshLocation(paths: ElementPaths, ownFolder: boolean): void {
    this.element.paths = paths;
    this.element.ownFolder = ownFolder;
    if (this.element.form !== 'atomic') this.paintFolder();
  }

  changes(): DetailChanges | null {
    if (this.editingBody) this.draft.body = this.descriptionEdit.value;
    if (this.titleEdit) this.commitTitleEdit();
    if (this.shortEdit) this.commitShortEdit();
    const frontmatter: Record<string, string | null> = {};
    if (this.draft.status !== this.original.status) frontmatter.status = this.draft.status;
    if (this.draft.priority !== this.original.priority) {
      frontmatter.priority = String(this.draft.priority);
    }
    fieldChange(frontmatter, 'planned', this.original.planned, this.draft.planned);
    fieldChange(frontmatter, 'due', this.original.due, this.draft.due);
    fieldChange(frontmatter, 'started', this.original.started, this.draft.started);
    fieldChange(frontmatter, 'short', this.original.short, this.draft.short);
    if (typeof frontmatter.short === 'string') frontmatter.short = yamlScalar(frontmatter.short);

    if (!sameList(this.draft.tags, this.original.tags)) {
      frontmatter.tags = this.draft.tags.length ? flowList(this.draft.tags, false) : null;
    }
    for (const kind of this.options.linkKinds) {
      const before = this.original.links.filter((l) => l.kind === kind.key).map(wikilink);
      const after = this.draft.links.filter((l) => l.kind === kind.key);
      if (!sameList(before, after.map(wikilink))) {
        frontmatter[kind.key] = after.length ? flowList(after.map(wikilink), true) : null;
      }
    }

    const body = this.draft.body !== this.original.body ? this.draft.body : undefined;

    const refile: RefileRequest = {};
    if (this.draft.title !== this.original.title) refile.title = this.draft.title;
    if (this.draft.project !== this.original.project) refile.project = this.draft.project ?? '';
    if (this.draft.type !== this.original.type) refile.type = this.draft.type;
    if (this.draft.parentLabel !== this.original.parentLabel) refile.parentLabel = this.draft.parentLabel;
    if (this.draft.ownFolderTarget !== undefined) refile.folder = this.draft.ownFolderTarget;
    const hasRefile = Object.keys(refile).length > 0;
    const detachedChildren = this.detachedChildren.size > 0 ? [...this.detachedChildren] : undefined;

    if (
      Object.keys(frontmatter).length === 0 &&
      body === undefined &&
      !hasRefile &&
      !detachedChildren
    ) {
      return null;
    }
    return { frontmatter, body, refile: hasRefile ? refile : undefined, detachedChildren };
  }

  // Draft-only (isDraft): the draft's filing target, or null with an empty
  // title (S11/K3 — the board discards without writing). See DraftTarget.
  draftTarget(): DraftTarget | null {
    if (this.titleEdit) this.commitTitleEdit();
    const title = this.draft.title.trim();
    if (!title) return null;
    return {
      title,
      status: this.draft.status,
      type: this.draft.type,
      project: this.draft.project,
      parentLabel: this.draft.parentLabel,
      atomic: this.draft.atomic,
      ownFolder: typeof this.draft.ownFolderTarget === 'string' ? this.draft.ownFolderTarget : undefined,
    };
  }

  // Reconciles the draft against the note's current state right before
  // closeDetail() decides whether writing it is safe (002, Ergänzung
  // 2026-10-19 "Dasselbe Feld von außen"): a field only conflicts if this
  // session's own draft changed it *and* the outside world changed it too —
  // an outside edit to a field the draft never touched simply stays out of
  // changes() and is left alone in the note. Returns the German names of
  // every conflicting field; draft and the rendered DOM are left exactly as
  // they are, so the card keeps showing the user's own input. A conflicting
  // field's `original` moves forward to the fresh value, so a second rebase
  // (the second Escape) compares against it instead of the stale value from
  // opening time, and the draft's own value writes through then.
  rebase(fresh: BoardElement, freshBody: string): string[] {
    if (this.editingBody) this.draft.body = this.descriptionEdit.value;
    if (this.titleEdit) this.commitTitleEdit();
    if (this.shortEdit) this.commitShortEdit();

    const conflicts: string[] = [];
    const check = (label: string, changed: boolean, stillOriginal: boolean, apply: () => void): void => {
      if (!changed || stillOriginal) return;
      conflicts.push(label);
      apply();
    };

    check('Status', this.draft.status !== this.original.status, fresh.status === this.original.status, () => {
      this.original.status = fresh.status;
    });
    check(
      'Priorität',
      this.draft.priority !== this.original.priority,
      fresh.priority === this.original.priority,
      () => {
        this.original.priority = fresh.priority;
      },
    );
    check('Geplant', this.draft.planned !== this.original.planned, fresh.planned === this.original.planned, () => {
      this.original.planned = fresh.planned;
    });
    check('Fällig', this.draft.due !== this.original.due, fresh.due === this.original.due, () => {
      this.original.due = fresh.due;
    });
    check(
      'Gestartet',
      this.draft.started !== this.original.started,
      fresh.started === this.original.started,
      () => {
        this.original.started = fresh.started;
      },
    );
    check('Kurzname', this.draft.short !== this.original.short, fresh.short === this.original.short, () => {
      this.original.short = fresh.short;
    });
    check(
      'Tags',
      !sameList(this.draft.tags, this.original.tags),
      sameList(fresh.tags, this.original.tags),
      () => {
        this.original.tags = [...fresh.tags];
      },
    );
    check('Beschreibung', this.draft.body !== this.original.body, freshBody === this.original.body, () => {
      this.original.body = freshBody;
    });
    check('Titel', this.draft.title !== this.original.title, fresh.title === this.original.title, () => {
      this.original.title = fresh.title;
    });
    check('Projekt', this.draft.project !== this.original.project, fresh.project === this.original.project, () => {
      this.original.project = fresh.project;
    });
    check('Ebene', this.draft.type !== this.original.type, fresh.type === this.original.type, () => {
      this.original.type = fresh.type;
    });
    const freshParentLabel = initialParentLabel(fresh, this.levels);
    check(
      'Übergeordnet',
      this.draft.parentLabel !== this.original.parentLabel,
      freshParentLabel === this.original.parentLabel,
      () => {
        this.original.parentLabel = freshParentLabel;
      },
    );

    for (const kind of this.options.linkKinds) {
      const targetsOf = (links: FreeLink[]) => links.filter((l) => l.kind === kind.key).map((l) => l.target);
      const draftTargets = targetsOf(this.draft.links);
      const originalTargets = targetsOf(this.original.links);
      const freshTargets = targetsOf(fresh.links);
      check(kind.label, !sameList(draftTargets, originalTargets), sameList(freshTargets, originalTargets), () => {
        this.original.links = [
          ...this.original.links.filter((l) => l.kind !== kind.key),
          ...freshTargets.map((target) => ({ kind: kind.key, target })),
        ];
      });
    }

    return conflicts;
  }

  private render(): void {
    const el = this.containerEl;
    const head = el.createDiv({ cls: 'ktm-expanded-head' });
    this.renderTitle(head);
    if (!this.isDraft) {
      const note = head.createSpan({ cls: 'ktm-expanded-note' });
      setIcon(note, 'file-text');
      this.registerDomEvent(note, 'click', (ev) => {
        ev.stopPropagation();
        this.host.openNote(this.element.paths.note);
      });
    }
    const close = head.createSpan({ cls: 'ktm-expanded-close' });
    setIcon(close, 'x');
    this.registerDomEvent(close, 'click', () => this.host.close());

    this.renderFields(el);
    const body = el.createDiv({ cls: 'ktm-expanded-body' });
    this.renderDescriptionColumn(body);
    this.renderSide(body);

    // A click anywhere else in the card ends an open description edit (S12);
    // the description's own listener only starts editing, since a click that
    // starts it also lands inside the wrap and must not immediately end it.
    this.registerDomEvent(el, 'click', (ev) => {
      if (!this.editingBody) return;
      if (this.descriptionWrap.contains(ev.target as Node)) return;
      this.endBodyEdit();
    });
  }

  private renderFields(parent: HTMLElement): void {
    const fields = parent.createDiv({ cls: 'ktm-fields' });

    fields.createSpan({ cls: 'ktm-label', text: 'Status' });
    this.renderStatus(fields.createSpan({ cls: 'ktm-value ktm-value-select' }));

    fields.createSpan({ cls: 'ktm-label', text: 'Projekt' });
    this.renderProject(fields.createSpan({ cls: 'ktm-value ktm-value-select' }));

    fields.createSpan({ cls: 'ktm-label', text: 'Ebene' });
    this.renderLevel(fields.createSpan({ cls: 'ktm-value ktm-value-select' }));

    fields.createSpan({ cls: 'ktm-label', text: 'Kurzname' });
    this.shortWrap = fields.createSpan({ cls: 'ktm-value ktm-field' });
    this.registerDomEvent(this.shortWrap, 'click', () => this.editShort());
    this.paintShort();

    fields.createSpan({ cls: 'ktm-label', text: 'Tags' });
    this.tagsWrap = fields.createSpan({ cls: 'ktm-detail-tags' });
    this.paintTags();

    fields.createSpan({ cls: 'ktm-label', text: 'Ordner' });
    const folderRow = fields.createDiv({ cls: 'ktm-value ktm-field-span ktm-folder-row' });
    this.renderFolderField(folderRow.createSpan({ cls: 'ktm-folder-value' }));
    this.renderPlacementToggle(folderRow);
  }

  // "Ablage automatisch" (011, Ergänzung 2026-09-25): a toggle next to the
  // Ordner-Feld, wired straight to host.setPlacement — no draft, no Speichern-
  // Button, it wirkt sofort like every other immediate write in this package
  // (changeLevel). Absent on a draft, which has no note yet to place.
  private renderPlacementToggle(parent: HTMLElement): void {
    if (this.isDraft) return;
    const wrap = parent.createSpan({ cls: 'ktm-placement-toggle', attr: { 'data-placement': this.element.placement ?? 'auto' } });
    wrap.createSpan({ cls: 'ktm-label', text: 'Ablage automatisch' });
    const toggle = new ToggleComponent(wrap);
    toggle.setValue((this.element.placement ?? 'auto') !== 'manual');
    toggle.onChange((value) => {
      void (async () => {
        const target = value ? 'auto' : 'manual';
        const ok = await this.host.setPlacement(target);
        if (!ok) {
          toggle.setValue(!value);
          return;
        }
        this.element.placement = target;
        wrap.setAttribute('data-placement', target);
      })();
    });
  }

  // Idle state of the Kurzname field (S41/K1): a chip-free text value like the
  // title, with a placeholder when unset. Read by BoardView.renderChips as
  // `short ?? title` on the parent chip.
  private paintShort(): void {
    this.shortWrap.empty();
    if (this.draft.short) {
      this.shortWrap.removeClass('ktm-placeholder');
      this.shortWrap.setText(this.draft.short);
    } else {
      this.shortWrap.addClass('ktm-placeholder');
      this.shortWrap.setText('Kurzname');
    }
  }

  private editShort(): void {
    if (this.shortEdit) return;
    this.shortWrap.empty();
    this.shortWrap.removeClass('ktm-placeholder');
    this.shortWrap.setAttribute('data-editing', 'true');
    const input = this.shortWrap.createEl('input', {
      type: 'text',
      cls: 'ktm-short-field',
      placeholder: 'Kurzname',
    });
    input.value = this.draft.short ?? '';
    input.focus();
    input.select();

    this.registerDomEvent(input, 'keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.commitShortEdit();
      }
    });
    const outside = (ev: MouseEvent): void => {
      if (this.shortWrap.contains(ev.target as Node)) return;
      this.commitShortEdit();
    };
    const doc = this.containerEl.ownerDocument;
    doc.addEventListener('click', outside, true);

    this.shortEdit = {
      input,
      prev: this.draft.short,
      cleanup: () => doc.removeEventListener('click', outside, true),
    };
  }

  private commitShortEdit(): void {
    const state = this.shortEdit;
    if (!state) return;
    this.draft.short = state.input.value.trim() || undefined;
    this.closeShortEdit();
    this.paintShort();
  }

  private cancelShortEdit(): void {
    const state = this.shortEdit;
    if (!state) return;
    this.draft.short = state.prev;
    this.closeShortEdit();
    this.paintShort();
  }

  private closeShortEdit(): void {
    const state = this.shortEdit;
    if (!state) return;
    state.cleanup();
    this.shortWrap.removeAttribute('data-editing');
    this.shortEdit = undefined;
  }

  // Folder field (DESIGN.md .ktm-folder-value): path relative to the vault with
  // a separating '/', "eigener Ordner" only outside the Standardablage (008),
  // "Atomar" instead of a path for atomic tasks. A click opens the picker
  // (008 addendum 2026-09-20 S35/S36, F054); an existing atomic card stays
  // display-only, since it has no Standardablage to switch to. A draft
  // always goes through paintFolder/the picker, even while it starts atomic
  // (F104, 003 addendum 2026-10-06): its project can still turn it into a
  // nested element, and openFolderMenu keeps it unbedienbar on its own
  // without a project.
  private renderFolderField(wrap: HTMLElement): void {
    this.folderWrap = wrap;
    if (!this.isDraft && this.element.form === 'atomic') {
      setIcon(wrap.createSpan({ cls: 'ktm-folder-icon' }), 'folder');
      wrap.createSpan({ cls: 'ktm-label', text: 'Atomar' });
      return;
    }
    this.paintFolder();
    this.registerDomEvent(wrap, 'click', () => this.openFolderMenu());
  }

  // The folder field's current value: the draft's picked target if the
  // picker was used this session, else the element's own state (K1/K3).
  private currentFolder(): { path?: string; own: boolean } {
    const target = this.draft.ownFolderTarget;
    if (target === undefined) return { path: this.element.paths.folder, own: this.element.ownFolder === true };
    if (target === null) return { path: undefined, own: false };
    const base = this.element.paths.folder ? folderBaseName(this.element.paths.folder) : undefined;
    return { path: base ? `${target}/${base}` : target, own: true };
  }

  private paintFolder(): void {
    const wrap = this.folderWrap;
    wrap.empty();
    setIcon(wrap.createSpan({ cls: 'ktm-folder-icon' }), 'folder');
    if (this.isDraft && this.draft.atomic) {
      wrap.createSpan({ cls: 'ktm-label', text: 'Atomar' });
      return;
    }
    const { path, own } = this.currentFolder();
    if (!path) {
      wrap.createSpan({ cls: 'ktm-label', text: 'Standardablage' });
      return;
    }
    const pathSpan = wrap.createSpan({ cls: 'ktm-folder-path', text: `${path}/` });
    setTooltip(pathSpan, `${path}/`);
    this.registerDomEvent(pathSpan, 'click', (ev) => {
      ev.stopPropagation();
      this.host.revealFolder(path);
    });
    if (own) wrap.createSpan({ cls: 'ktm-badge is-own', text: 'eigener Ordner' });
  }

  // Popover shaped like the link-menu (DESIGN.md link-menu, F054): first
  // line "Standardablage", below it up to five folder matches by search
  // text. A pick only sets the draft; the actual move including
  // project/parent frontmatter is the board's job on close (wissen
  // #540, #477), since it knows the whole vault.
  private openFolderMenu(): void {
    if (this.folderMenu) return;
    // The internal draft's folder field stays unbedienbar (003 addendum
    // 2026-10-06, "ausserhalb"): without a project there is no Standardablage
    // to pick, and picking an own folder here is out of scope for this
    // package.
    if (this.isDraft && !this.draft.project) return;
    const wrap = this.folderWrap;
    wrap.setAttribute('data-editing', 'true');
    // The results popover may overrun the card edge (wissen #581), otherwise
    // .ktm-expanded clips it.
    this.containerEl.setAttribute('data-popover', 'true');
    const menu = wrap.createDiv({ cls: 'ktm-linkmenu' });
    const search = menu.createDiv({ cls: 'ktm-search' });
    setIcon(search.createSpan(), 'search');
    const input = search.createEl('input', { type: 'text', cls: 'ktm-search-input' });
    const list = menu.createDiv({ cls: 'ktm-linkmenu-list' });

    const onHover = (item: HTMLElement): void => {
      for (const el of Array.from(list.children)) el.removeAttribute('data-hover');
      item.setAttribute('data-hover', 'true');
    };

    const addItem = (icon: string, label: string, onPick: () => void): HTMLElement => {
      const item = list.createDiv({ cls: 'ktm-linkmenu-item' });
      setIcon(item.createSpan(), icon);
      item.createSpan({ text: label });
      this.registerDomEvent(item, 'pointerenter', () => onHover(item));
      this.registerDomEvent(item, 'click', (ev) => {
        ev.stopPropagation();
        onPick();
      });
      return item;
    };

    const paint = (): void => {
      list.empty();
      // A draft at the bottom level additionally offers "Atomar" (008 S21,
      // F055, F072 S22: not a fixed 'task'); an existing card and a draft
      // that is already atomic (view all/internal) never land here
      // (renderFolderField's early return).
      const fixed: HTMLElement[] = [];
      if (this.isDraft && isBottomLevel(this.levels, this.draft.type)) {
        fixed.push(addItem('folder', 'Atomar', () => this.pickAtomic()));
      }
      fixed.push(addItem('folder', 'Standardablage', () => this.pickFolder(null)));
      const query = input.value.trim().toLowerCase();
      if (!query) {
        fixed[fixed.length - 1].setAttribute('data-hover', 'true');
        return;
      }
      const folders = this.app.vault
        .getAllLoadedFiles()
        .filter((f): f is TFolder => f instanceof TFolder)
        .filter((f) => f.path.toLowerCase().includes(query))
        .sort((a, b) => a.path.localeCompare(b.path))
        .slice(0, 5);
      for (const folder of folders) addItem('folder', folder.path, () => this.pickFolder(folder.path));
      (list.children[fixed.length] ?? fixed[fixed.length - 1])?.setAttribute('data-hover', 'true');
    };

    paint();
    this.registerDomEvent(input, 'input', paint);
    this.registerDomEvent(input, 'keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      list.querySelector<HTMLElement>('[data-hover="true"]')?.click();
    });

    const outside = (ev: MouseEvent): void => {
      if (menu.contains(ev.target as Node)) return;
      this.closeFolderMenu();
    };
    const doc = this.containerEl.ownerDocument;
    doc.addEventListener('click', outside, true);

    this.folderMenu = { el: menu, cleanup: () => doc.removeEventListener('click', outside, true) };
    input.focus();
  }

  private pickFolder(path: string | null): void {
    this.draft.atomic = false;
    this.draft.ownFolderTarget = path;
    this.closeFolderMenu();
    this.paintFolder();
  }

  private pickAtomic(): void {
    this.draft.atomic = true;
    this.draft.ownFolderTarget = undefined;
    this.closeFolderMenu();
    this.paintFolder();
  }

  private closeFolderMenu(): void {
    const state = this.folderMenu;
    if (!state) return;
    state.cleanup();
    state.el.remove();
    this.folderWrap.removeAttribute('data-editing');
    this.folderMenu = undefined;
    this.containerEl.removeAttribute('data-popover');
  }

  // Idle state of the tags field (S15/S16): a chip per tag plus the ghost chip
  // "+ Tag" last. Repainted after every add or remove.
  private paintTags(): void {
    this.tagsWrap.empty();
    for (const tag of this.draft.tags) this.renderTagChip(tag);
    const ghost = this.tagsWrap.createSpan({ cls: 'ktm-card-chip ktm-chip-ghost', text: '+ Tag' });
    this.registerDomEvent(ghost, 'click', () => this.editTag(ghost));
  }

  // The remove cross only exists in the DOM while the pointer is over the
  // chip, so the resting chip keeps the exact width the frozen references
  // measure (F032/F043) — unlike the free links below, nothing here is ever
  // pre-rendered hidden.
  private renderTagChip(tag: string): void {
    const chip = this.tagsWrap.createSpan({ cls: 'ktm-card-chip ktm-card-tag' });
    const entry = this.options
      .tagsFor(this.draft.project)
      .find((t) => t.tag.toLowerCase() === stripHash(tag).toLowerCase());
    if (entry?.icon) {
      const iconEl = chip.createSpan({ cls: 'ktm-tag-chip-icon' });
      setIcon(iconEl, entry.icon);
    }
    chip.createSpan({ text: stripHash(tag) });
    let remove: HTMLElement | undefined;
    this.registerDomEvent(chip, 'pointerenter', () => {
      if (remove) return;
      remove = chip.createSpan({ cls: 'ktm-chip-remove' });
      setIcon(remove, 'x');
      this.registerDomEvent(remove, 'click', (ev) => {
        ev.stopPropagation();
        this.draft.tags = this.draft.tags.filter((t) => t !== tag);
        this.paintTags();
      });
    });
    this.registerDomEvent(chip, 'pointerleave', () => {
      remove?.remove();
      remove = undefined;
    });
  }

  // Replaces the ghost chip with an input plus a suggestion popover (002,
  // Ergänzung 2026-10-25): the popover opens right away, even before typing,
  // and is redrawn from tagSuggestions on every keystroke. No row starts
  // marked (S100); ArrowDown/ArrowUp move a single `data-hover` mark through
  // the rows, Enter takes the marked row if one is set, else canonicalTag of
  // the typed text (S101). A row click commits that row; an outside click
  // commits the typed text (S103), same as before.
  private editTag(ghost: HTMLElement): void {
    if (this.tagEdit) return;
    const wrap = this.tagsWrap.createSpan({ cls: 'ktm-anchor' });
    ghost.replaceWith(wrap);
    const input = wrap.createEl('input', { type: 'text', cls: 'ktm-tag-input' });
    const suggestions = wrap.createDiv({ cls: 'ktm-tag-suggestions' });
    suggestions.hide();

    let hovered = -1;
    const rows = (): HTMLElement[] => Array.from(suggestions.querySelectorAll<HTMLElement>('.ktm-linkmenu-item'));
    const moveHover = (delta: number): void => {
      const list = rows();
      if (list.length === 0) return;
      hovered = Math.min(Math.max(hovered + delta, 0), list.length - 1);
      list.forEach((el, i) => {
        if (i === hovered) el.setAttribute('data-hover', 'true');
        else el.removeAttribute('data-hover');
      });
    };

    const addRow = (tag: string, icon?: string, faint = false): void => {
      const item = suggestions.createDiv({ cls: 'ktm-linkmenu-item', attr: { 'data-tag': tag } });
      if (icon !== undefined) {
        const iconEl = item.createSpan();
        if (faint) iconEl.addClass('ktm-tag-sugg-noicon');
        setIcon(iconEl, icon);
      }
      item.createSpan({ text: tag });
      this.registerDomEvent(item, 'click', (ev) => {
        ev.stopPropagation();
        this.commitTag(tag);
      });
    };

    const paintSuggestions = (): void => {
      suggestions.empty();
      hovered = -1;
      const { pinned, rest } = tagSuggestions(
        this.options.tagsFor(this.draft.project),
        this.options.vaultTags,
        this.draft.tags,
        input.value,
      );
      if (pinned.length === 0 && rest.length === 0) {
        suggestions.hide();
        return;
      }
      suggestions.show();
      for (const entry of pinned) addRow(entry.tag, entry.icon ?? 'tag', !entry.icon);
      if (pinned.length > 0 && rest.length > 0) suggestions.createDiv({ cls: 'ktm-tag-sep' });
      for (const tag of rest) addRow(tag);
    };

    paintSuggestions();
    this.registerDomEvent(input, 'input', paintSuggestions);
    this.registerDomEvent(input, 'keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const marked = rows()[hovered]?.dataset.tag;
        this.commitTag(marked ?? input.value);
      } else if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        moveHover(1);
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        moveHover(-1);
      }
    });
    const outside = (ev: MouseEvent): void => {
      if (wrap.contains(ev.target as Node)) return;
      this.commitTag(input.value);
    };
    const doc = this.containerEl.ownerDocument;
    doc.addEventListener('click', outside, true);

    this.tagEdit = { cleanup: () => doc.removeEventListener('click', outside, true) };
    input.focus();
  }

  private commitTag(raw: string): void {
    const value = canonicalTag(raw, this.options.tagsFor(this.draft.project));
    if (value && !this.draft.tags.includes(value)) this.draft.tags.push(value);
    this.closeTagEdit();
    this.paintTags();
  }

  private cancelTagEdit(): void {
    this.closeTagEdit();
    this.paintTags();
  }

  private closeTagEdit(): void {
    const state = this.tagEdit;
    if (!state) return;
    state.cleanup();
    this.tagEdit = undefined;
  }

  // The four field dropdowns rest with a single chevron-down instead of the
  // native double-arrow / spinner glyph (F045 K1); styles.css hides the
  // native/Obsidian arrow and positions this icon.
  private addSelectChevron(parent: HTMLElement): void {
    setIcon(parent.createSpan({ cls: 'ktm-select-chevron' }), 'chevron-down');
  }

  private renderStatus(parent: HTMLElement): void {
    const dropdown = new DropdownComponent(parent);
    const known = new Set(this.columns.map((c) => c.status));
    if (!known.has(this.draft.status)) dropdown.addOption(this.draft.status, this.draft.status);
    for (const column of this.columns) dropdown.addOption(column.status, column.name);
    dropdown.setValue(this.draft.status);
    dropdown.onChange((value) => {
      this.draft.status = value;
      const targetRole = this.columns.find((c) => c.status === value)?.role ?? 'open';
      this.draft.started = startedAfterStatusChange(
        targetRole,
        this.draft.started,
        this.element.completed,
        this.today,
      );
      if (this.startedWrap) this.paintDate(this.startedWrap, 'started');
    });
    this.addSelectChevron(parent);
  }

  // "intern" always leads the options (003 addendum 2026-10-06, wissen
  // #510/#593): added only when the project list does not already carry it,
  // shown selected for a project-less card, and mapped back to an empty
  // `draft.project` so changes()/draftTarget() keep taking the existing
  // "leer → intern" path (wissen #390). A draft also re-resolves its levels
  // and folder for the newly chosen project (onDraftProjectChange).
  private renderProject(parent: HTMLElement): void {
    this.projectWrap = parent;
    this.paintProject();
  }

  private paintProject(): void {
    const parent = this.projectWrap;
    parent.empty();
    const dropdown = new DropdownComponent(parent);
    const options = this.options.projects;
    const current = this.draft.project;
    if (!options.includes(INTERN_PROJECT)) dropdown.addOption(INTERN_PROJECT, INTERN_PROJECT);
    if (current && !options.includes(current)) dropdown.addOption(current, current);
    for (const option of options) dropdown.addOption(option, option);
    dropdown.setValue(current ?? INTERN_PROJECT);
    dropdown.onChange((value) => {
      const next = value === INTERN_PROJECT ? undefined : value;
      // A project switch in the draft drops a parent set from the old project
      // (003, Ergänzung 2026-10-19): only here, not when pickParent itself
      // moves the draft onto the picked parent's project (003 S27).
      if (this.isDraft && next !== this.draft.project) {
        this.draft.newParents = [];
        this.draft.parentLabel = '';
      }
      this.draft.project = next;
      if (this.isDraft) {
        this.onDraftProjectChange();
        this.repaintLinks();
      }
    });
    this.addSelectChevron(parent);
  }

  // On an atomic task the level is fixed to the project's bottom level (002
  // S28, K7; 009 addendum 2026-09-20): embedding it under an ancestor goes
  // through parent, not this field. Otherwise the offer follows only the
  // children's barrier (008 S23/S40, 009 addendum 2026-09-25 changed,
  // core/board.ts#offerableLevels): a level at or above the current
  // parent's height is offered too, but picking one opens the ParentDialog
  // (below) instead of going through the deferred draft/refile path. A draft
  // follows `draft.atomic` instead of `element.form` (F104): its project can
  // turn an atomic start into a nested one and back; an existing card's form
  // never changes this way, so this is unchanged there.
  private renderLevel(parent: HTMLElement): void {
    this.levelWrap = parent;
    this.paintLevel();
  }

  private paintLevel(): void {
    const parent = this.levelWrap;
    parent.empty();
    const dropdown = new DropdownComponent(parent);
    const atomic = this.isDraft ? this.draft.atomic : this.element.form === 'atomic';
    const bottom = this.levels[this.levels.length - 1];
    const levels = atomic ? (bottom ? [bottom] : []) : offerableLevels(this.levels, this.children.map((c) => c.type));
    for (const level of levels) dropdown.addOption(level.key, level.name);
    const current = levels.find((l) => l.key === this.draft.type) ?? bottom;
    if (current) dropdown.setValue(current.key);
    dropdown.onChange((value) => {
      if (this.isDraft || atomic) {
        this.draft.type = value;
        return;
      }
      void this.pickLevel(value, dropdown);
    });
    this.addSelectChevron(parent);
  }

  // A draft's project change (F104, 003 addendum 2026-10-06): re-resolves the
  // card's levels for the new project, and, unless an own folder is already
  // picked (`ownFolderTarget` a string, which survives every project switch),
  // recomputes `draft.atomic` from whether the new project has a root at all
  // ("kein Projekt oder Projekt ohne Root"). An atomic result pins the type to
  // the bottom level; otherwise the current type survives if the new levels
  // still carry it, else it falls back to the bottom level too. Project,
  // level and folder fields are repainted to show the result.
  private onDraftProjectChange(): void {
    this.levels = this.options.levelsFor(this.draft.project);
    if (typeof this.draft.ownFolderTarget !== 'string') {
      // A draft opened fixed atomic (view all/internal, initialParentLabel)
      // starts with the sentinel 'Atomar' in `parentLabel`, never a real
      // "<Ebene>: <Titel>" string or the root label ''; planDraftPlacement
      // would misread it as an unresolved ancestor the moment atomic turns
      // false here (resolveParentTarget's regex doesn't match it either).
      // Dropping it to the root label is safe: a parent picked through
      // pickParent already replaced it with a real label before this call.
      if (this.draft.parentLabel === 'Atomar') this.draft.parentLabel = '';
      this.draft.atomic = !this.draft.project || !this.options.hasRoot(this.draft.project);
    }
    const bottom = this.levels[this.levels.length - 1];
    if (this.draft.atomic || !this.levels.some((l) => l.key === this.draft.type)) {
      if (bottom) this.draft.type = bottom.key;
    }
    this.paintProject();
    this.paintLevel();
    this.paintFolder();
  }

  // A level pick at or above the current parent's height (011, Ergänzung
  // 2026-09-25, "Ebene wechseln"): asks {@link ParentDialog} for the new
  // parent, proposing the nearest ancestor whose own level ranks strictly
  // above the picked one ("passender Vorfahre"), "ohne Parent" otherwise.
  // Confirming writes through host.changeLevel immediately and folds the
  // result into `draft`/`original` so closing the card does not file it a
  // second time; cancelling restores the dropdown to the level it had
  // before. A level below the parent's height (or without a parent at all)
  // never opens the dialog: it stays on the deferred draft/refile path.
  private async pickLevel(value: ElementType, dropdown: DropdownComponent): Promise<void> {
    const levels = this.levels;
    const indexOf = (key: ElementType): number => levels.findIndex((l) => l.key === key);
    const selectedIdx = indexOf(value);
    const chain = this.effectiveParents();
    const parent = chain[0];
    const atHeightOrAbove = parent !== undefined && selectedIdx <= indexOf(parent.type);
    if (!atHeightOrAbove) {
      this.draft.type = value;
      return;
    }
    const candidates = chain.filter((p) => indexOf(p.type) < selectedIdx);
    const chosen = await ParentDialog.ask(this.app, {
      levelName: levels.find((l) => l.key === value)?.name ?? value,
      candidates: candidates.map((p) => ({ id: p.id, label: `${parentLabel(p, levels)}: ${p.title}` })),
    });
    if (chosen === undefined) {
      dropdown.setValue(this.draft.type);
      return;
    }
    const ok = await this.host.changeLevel(value, chosen);
    if (!ok) {
      dropdown.setValue(this.draft.type);
      return;
    }
    this.draft.type = value;
    this.original.type = value;
    const ancestor = chosen ? candidates.find((p) => p.id === chosen) : undefined;
    // Keeps the ancestor's own ancestors too (008, Ergänzung 2026-10-06,
    // wissen #825): the chain from the chosen ancestor onward in the
    // effective chain, not the ancestor alone.
    const ancestorIdx = ancestor ? chain.indexOf(ancestor) : -1;
    this.draft.newParents = ancestorIdx === -1 ? [] : chain.slice(ancestorIdx);
    this.draft.parentLabel = ancestor ? `${parentLabel(ancestor, levels)}: ${ancestor.title}` : '';
    this.original.parentLabel = this.draft.parentLabel;
    this.repaintLinks();
  }

  private renderTitle(parent: HTMLElement): void {
    this.titleWrap = parent.createDiv({ cls: 'ktm-expanded-title ktm-field' });
    this.registerDomEvent(this.titleWrap, 'click', () => this.editTitle());
    // The draft opens with the title already in edit, empty and focused
    // (003 S9/K1); an existing card's title starts idle until clicked.
    if (this.isDraft) this.editTitle();
    else this.paintTitle();
  }

  private paintTitle(): void {
    this.titleWrap.empty();
    this.titleWrap.setText(this.draft.title);
  }

  private editTitle(): void {
    if (this.titleEdit) return;
    this.titleWrap.empty();
    this.titleWrap.setAttribute('data-editing', 'true');
    const input = this.titleWrap.createEl('input', {
      type: 'text',
      cls: 'ktm-title-field',
      placeholder: 'Titel',
    });
    input.value = this.draft.title;
    input.focus();
    // A draft's title starts with the cursor after its (possibly empty)
    // prefill, never marked; only reopening an existing title still selects
    // it all (002 S78/S80).
    if (this.isDraft) input.setSelectionRange(input.value.length, input.value.length);
    else input.select();

    this.registerDomEvent(input, 'keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.commitTitleEdit();
        // Enter on the draft's title hands focus straight to the
        // description, cursor included (003 S15/K7).
        if (this.isDraft) this.startBodyEdit();
      }
    });
    const outside = (ev: MouseEvent): void => {
      if (this.titleWrap.contains(ev.target as Node)) return;
      this.commitTitleEdit();
    };
    const doc = this.containerEl.ownerDocument;
    doc.addEventListener('click', outside, true);

    this.titleEdit = {
      input,
      prev: this.draft.title,
      cleanup: () => doc.removeEventListener('click', outside, true),
    };
  }

  // An empty field falls back to the previous value, so an existing
  // card never gets an empty title — on a draft (isDraft) that previous
  // value is only the pre-filled search input of a stacked draft (F053),
  // not a saved title; there an emptied field stays empty, so
  // draftTarget() recognizes the discard (S11/K4).
  private commitTitleEdit(): void {
    const state = this.titleEdit;
    if (!state) return;
    const typed = state.input.value.trim();
    this.draft.title = typed || (this.isDraft ? '' : state.prev);
    this.closeTitleEdit();
    this.paintTitle();
  }

  private cancelTitleEdit(): void {
    const state = this.titleEdit;
    if (!state) return;
    this.draft.title = state.prev;
    this.closeTitleEdit();
    this.paintTitle();
  }

  private closeTitleEdit(): void {
    const state = this.titleEdit;
    if (!state) return;
    state.cleanup();
    this.titleWrap.removeAttribute('data-editing');
    this.titleEdit = undefined;
  }

  private renderDescriptionColumn(parent: HTMLElement): void {
    const block = parent.createDiv();
    block.createDiv({ cls: 'ktm-section-title', text: 'Beschreibung' });
    const wrap = block.createDiv({ cls: 'ktm-description' });
    this.descriptionWrap = wrap;
    wrap.createDiv({ cls: 'ktm-description-rendered' });
    this.descriptionEdit = wrap.createEl('textarea', {
      cls: 'ktm-description-edit',
      placeholder: 'Beschreibung',
    });
    this.descriptionEdit.hide();
    this.registerDomEvent(this.descriptionEdit, 'input', () => {
      this.draft.body = this.descriptionEdit.value;
      this.resizeDescriptionEdit();
    });
    // Obsidian's editor settings (002, Ergänzung 2026-10-18): with a
    // non-empty selection and the matching "automatisch paaren" switch on,
    // the typed pair character wraps the selection instead of replacing it.
    // With the switch off, or on an empty selection, the default insertion
    // runs unchanged (S61).
    this.registerDomEvent(this.descriptionEdit, 'beforeinput', (ev: InputEvent) => {
      if (ev.inputType !== 'insertText' || ev.data === null || ev.data.length !== 1) return;
      const ta = this.descriptionEdit;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      if (start === null || end === null || start === end) return;
      const pair = PAIR_CHARS[ev.data];
      if (!pair) return;
      const app = this.app as DesktopApp;
      const configKey = pair.bracket ? 'autoPairBrackets' : 'autoPairMarkdown';
      if (app.vault.getConfig(configKey) !== true) return;
      ev.preventDefault();
      this.applyDescriptionEdit(wrapSelection(ta.value, start, end, pair.open, pair.close));
    });
    // Fett/Kursiv per Obsidians eigenem Tastenkürzel (002 S62), unabhängig
    // von den beiden Schaltern oben. Obsidians hotkeyManager fängt ein
    // gebundenes Kürzel (Mod+B etc.) schon auf `window`, in der Capture-Phase
    // und mit stopPropagation (nicht stopImmediatePropagation), ab, bevor es
    // dieses Feld erreicht: ein Listener auf dem textarea selbst sähe das
    // Tastenereignis nie. Ein eigener, ebenfalls fensterweiter
    // Capture-Listener läuft als weiterer Listener auf demselben Knoten noch
    // mit und wird nicht durch Obsidians eigenes preventDefault
    // ausgeschlossen; `activeElement` grenzt ihn auf dieses Feld ein.
    this.registerDomEvent(
      this.containerEl.win,
      'keydown',
      (ev) => {
        const ta = this.descriptionEdit;
        if (this.containerEl.ownerDocument.activeElement !== ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        if (start === null || end === null || start === end) return;
        let marker: string | undefined;
        if (matchesHotkey(ev, resolveHotkeys(this.app, 'editor:toggle-bold'))) marker = '**';
        else if (matchesHotkey(ev, resolveHotkeys(this.app, 'editor:toggle-italics'))) marker = '*';
        if (!marker) return;
        ev.preventDefault();
        this.applyDescriptionEdit(toggleMarkup(ta.value, start, end, marker));
      },
      true,
    );
    this.registerDomEvent(wrap, 'click', (ev) => {
      const target = ev.target as HTMLElement;
      const checkbox = target.closest?.('input[type="checkbox"]');
      if (checkbox instanceof HTMLInputElement) {
        ev.preventDefault();
        this.toggleCheckbox(checkbox);
        return;
      }
      if (this.editingBody || ev.target === this.descriptionEdit) return;
      this.startBodyEdit();
    });
    // Obsidian's own image menu (002, Ergänzung 2026-10-26): the reading
    // view's embed renderer attaches nothing of its own (checked against
    // 1.14.5, wissen #558) — Live Preview's widget is the only place this is
    // reachable, via Menu.forEvent plus the public handleLinkContextMenu. No
    // card click, edit or board menu follows from this event.
    this.registerDomEvent(wrap, 'contextmenu', (ev) => {
      const target = ev.target as HTMLElement;
      const img = target.closest?.('img');
      if (!(img instanceof HTMLImageElement) || !img.closest('.ktm-description-rendered')) return;
      ev.stopPropagation();
      this.openImageMenu(ev, img);
    });
    this.renderDescription();
  }

  // Menu.forEvent calls preventDefault and schedules its own showAtMouseEvent
  // (obsidian.asar, same as the Live Preview image widget's own handler),
  // so items only need adding here. `rawLink` is the raw `![[...]]` target
  // read off the embed wrapper's `src` attribute Obsidian's renderer leaves
  // behind; without it (an external `![](https://…)` image) only the copy
  // entry applies, matching the Live Preview widget's own external-image case.
  private openImageMenu(ev: MouseEvent, img: HTMLImageElement): void {
    const rawLink = img.closest('.internal-embed')?.getAttribute('src') ?? undefined;
    const menu = Menu.forEvent(ev);
    // Menu.sort() registers a section the first time an item names it, in
    // add order, and renders unregistered (default "") items last regardless
    // of when they were added (obsidian.asar); naming "image" here, before
    // handleLinkContextMenu names its own sections, is what puts the copy
    // item first without the private addSections() the Live Preview widget
    // uses for the same effect.
    menu.addItem((item) =>
      item
        .setSection('image')
        .setTitle('Bild kopieren')
        .setIcon('lucide-copy')
        .onClick(() => void this.copyImage(img, rawLink)),
    );
    if (rawLink !== undefined) {
      this.app.workspace.handleLinkContextMenu(menu, rawLink, this.element.paths.note);
    }
    this.imageMenu = menu;
    menu.onHide(() => {
      // Deferred to the next tick: see hasActiveField's doc comment.
      this.containerEl.win.setTimeout(() => {
        if (this.imageMenu === menu) this.imageMenu = undefined;
      });
    });
  }

  // Obsidian's own copy-image action has no public equivalent, so this takes
  // the same path it does: nativeImage straight from electron, the clipboard
  // chosen by Electron's major version (below 40 electron.clipboard, from 40
  // electron.remote.clipboard; measured under Obsidian 1.14.5: Electron 39.8.3).
  // navigator.clipboard.write() is no alternative: it resolves without error
  // and leaves the OS clipboard empty. Reading back through the same
  // clipboard turns a silent no-op into the notice.
  private async copyImage(img: HTMLImageElement, rawLink: string | undefined): Promise<void> {
    try {
      const data = await this.readImageData(img, rawLink);
      const electron = require('electron') as ElectronRenderer;
      // Under Electron 39.8.3, electron.clipboard.writeImage reaches the OS
      // clipboard directly and is measured to work (#1341); from Electron 40
      // on, obsidian.asar itself switches to the remote.clipboard bridge.
      const major = parseInt(process.versions.electron ?? '', 10);
      const clipboard = major < 40 ? electron.clipboard : electron.remote.clipboard;
      const image = electron.nativeImage.createFromBuffer(Buffer.from(data));
      if (image.isEmpty()) throw new Error('image could not be decoded');
      clipboard.writeImage(image);
      if (clipboard.readImage().isEmpty()) throw new Error('clipboard empty after write');
    } catch (error) {
      console.warn('kanban-taskmanager: copy image failed', error);
      new Notice('Bild konnte nicht kopiert werden.');
    }
  }

  // Reads the image's bytes: through the vault for a resolved internal embed
  // (the same source Obsidian's own copy action reads from, not the
  // rendered `app://` resource URL — that URL's host is a per-vault
  // resource origin distinct from the page's own, so fetching it is a
  // cross-origin request a plain `fetch` can't make); otherwise (a true
  // external `![](https://…)` image, no internal-embed) the only source is
  // the URL the renderer already resolved.
  private async readImageData(img: HTMLImageElement, rawLink: string | undefined): Promise<ArrayBuffer> {
    if (rawLink !== undefined) {
      const dest = this.app.metadataCache.getFirstLinkpathDest(rawLink, this.element.paths.note);
      if (dest) return this.app.vault.readBinary(dest);
    }
    const response = await fetch(img.currentSrc || img.src);
    return response.arrayBuffer();
  }

  private renderDescription(): void {
    if (!this.descriptionEdit) return;
    const rendered = this.containerEl.querySelector<HTMLElement>('.ktm-description-rendered');
    if (!rendered) return;
    rendered.empty();
    // An empty body shows the same placeholder the draft opens with
    // (DESIGN.md Draft); the textarea underneath stays hidden until clicked,
    // so this is never shown alongside the live edit.
    if (!this.draft.body) {
      rendered.createSpan({ cls: 'ktm-placeholder', text: 'Beschreibung' });
      return;
    }
    // Every blank line becomes its own block (002 S63, wissen #293) so the
    // renderer shows the same line count Obsidian's own Live Preview would;
    // draft.body itself stays untouched, toggleCheckbox keeps reading it.
    void MarkdownRenderer.render(
      this.app,
      expandBlankLines(this.draft.body),
      rendered,
      this.element.paths.note,
      this,
    );
  }

  // Writes a wrap/toggle result into the textarea and keeps the draft and
  // the field's grown height in step with it (CardDetail never calls this
  // for plain typing, only for the pairing/hotkey paths above).
  private applyDescriptionEdit(result: { text: string; selectionStart: number; selectionEnd: number }): void {
    const ta = this.descriptionEdit;
    ta.value = result.text;
    ta.setSelectionRange(result.selectionStart, result.selectionEnd);
    this.draft.body = result.text;
    this.resizeDescriptionEdit();
  }

  // The field grows with its content instead of scrolling inside itself
  // (002 S63/K10), so a line sits at the same height while editing as it did
  // rendered a moment before.
  private resizeDescriptionEdit(): void {
    const ta = this.descriptionEdit;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }

  private startBodyEdit(): void {
    this.editingBody = true;
    const rendered = this.containerEl.querySelector<HTMLElement>('.ktm-description-rendered');
    rendered?.hide();
    this.descriptionEdit.value = this.draft.body;
    this.descriptionEdit.show();
    this.resizeDescriptionEdit();
    this.descriptionEdit.focus();
    this.descriptionEdit.setSelectionRange(this.draft.body.length, this.draft.body.length);
  }

  private endBodyEdit(): void {
    if (!this.editingBody) return;
    this.editingBody = false;
    this.draft.body = this.descriptionEdit.value;
    this.descriptionEdit.hide();
    this.renderDescription();
    this.containerEl.querySelector<HTMLElement>('.ktm-description-rendered')?.show();
  }

  // A checkbox click wins over the container's click-to-edit (addendum
  // 2026-09-14: "Interactive elements take precedence over their container").
  // Checkboxes only exist in the rendered markdown, never while editing, so
  // their document order matches the task-list lines in the raw body 1:1.
  private toggleCheckbox(checkbox: HTMLInputElement): void {
    const rendered = this.containerEl.querySelector<HTMLElement>('.ktm-description-rendered');
    if (!rendered) return;
    const boxes = [...rendered.querySelectorAll('input[type="checkbox"]')];
    const index = boxes.indexOf(checkbox);
    if (index === -1) return;
    this.draft.body = toggleTaskLine(this.draft.body, index);
    this.renderDescription();
  }

  private renderSide(parent: HTMLElement): void {
    const side = parent.createDiv({ cls: 'ktm-side' });

    const planning = side.createDiv();
    planning.createDiv({ cls: 'ktm-section-title', text: 'Planung' });
    const fields = planning.createDiv({ cls: 'ktm-fields' });
    fields.createSpan({ cls: 'ktm-label', text: 'Priorität' });
    const prio = fields.createSpan({ cls: 'ktm-value ktm-priority-value' });
    this.registerDomEvent(prio, 'click', () => this.editPriority(prio));
    this.paintPriority(prio);
    fields.createSpan({ cls: 'ktm-label', text: 'Geplant' });
    const planned = fields.createSpan({ cls: 'ktm-value ktm-date-value' });
    this.registerDomEvent(planned, 'click', () => this.editDate(planned, 'planned'));
    this.paintDate(planned, 'planned');
    fields.createSpan({ cls: 'ktm-label', text: 'Fällig' });
    const due = fields.createSpan({ cls: 'ktm-value ktm-date-value' });
    this.dueWrap = due;
    this.registerDomEvent(due, 'click', () => this.editDate(due, 'due'));
    this.paintDate(due, 'due');
    fields.createSpan({ cls: 'ktm-label', text: 'Gestartet' });
    const started = fields.createSpan({ cls: 'ktm-value ktm-date-value' });
    this.startedWrap = started;
    this.registerDomEvent(started, 'click', () => this.editDate(started, 'started'));
    this.paintDate(started, 'started');

    // The draft shows only the Links heading with rows for a parent
    // already picked this session (DESIGN.md Draft); the plus is wired like
    // on any card (F055, 008 S22) — it can only pick an existing ancestor
    // (availableArts), never a free note/ADR link or "Neu anlegen", since the
    // note doesn't exist yet ("ausserhalb"). Children are rows of this one list
    // (F051); there is no separate children section anymore.
    const links = side.createDiv();
    this.sectionHead(links, 'Verknüpfungen', (head) => this.openLinkMenu(head));
    this.linksWrap = links.createDiv({ cls: 'ktm-links' });
    this.renderLinks(this.linksWrap);
  }

  // A section heading with a plus on the right (link menu, F035); the draft
  // itself has it unwired (Links display-only, see the isDraft gate
  // above).
  private sectionHead(parent: HTMLElement, title: string, onPlus?: (head: HTMLElement) => void): void {
    const head = parent.createDiv({ cls: 'ktm-section-head' });
    head.createSpan({ cls: 'ktm-section-title', text: title });
    const plus = head.createSpan({ cls: 'ktm-section-plus' });
    setIcon(plus, 'plus');
    if (onPlus) {
      this.registerDomEvent(plus, 'click', (ev) => {
        ev.stopPropagation();
        onPlus(head);
      });
    }
  }

  private paintPriority(wrap: HTMLElement): void {
    wrap.empty();
    const priority = this.draft.priority;
    const icon = priorityIcon(priority);
    if (icon) {
      const iconEl = wrap.createSpan({
        cls: 'ktm-card-priority',
        attr: { 'data-priority': String(priority) },
      });
      setIcon(iconEl, icon);
    }
    wrap.createSpan({ text: priorityLabel(priority) });
  }

  private editPriority(wrap: HTMLElement): void {
    if (wrap.querySelector('select')) return;
    wrap.empty();
    const dropdown = new DropdownComponent(wrap);
    for (let p = 1; p <= 4; p++) dropdown.addOption(String(p), priorityLabel(p));
    dropdown.setValue(String(this.draft.priority));
    dropdown.selectEl.focus();
    let done = false;
    const commit = (): void => {
      if (done) return;
      done = true;
      this.draft.priority = Number(dropdown.getValue());
      this.paintPriority(wrap);
    };
    dropdown.onChange(commit);
    this.registerDomEvent(dropdown.selectEl, 'blur', commit);
  }

  private paintDate(wrap: HTMLElement, kind: 'planned' | 'due' | 'started'): void {
    wrap.empty();
    wrap.removeAttribute('data-planned');
    wrap.removeAttribute('data-due');
    wrap.removeAttribute('data-field');
    wrap.removeAttribute('data-editing');
    wrap.removeClass('ktm-anchor');
    const value = this.draft[kind];
    if (!value) {
      wrap.addClass('ktm-label');
      wrap.removeClass('ktm-card-meta-item');
      wrap.setText('nicht geplant');
      return;
    }
    wrap.removeClass('ktm-label');
    wrap.addClass('ktm-card-meta-item');
    if (kind === 'started') {
      // Gestartet never signals overdue/today (008, Ergänzung 2026-10-25): the
      // relative text stays `--text-muted` even on the day it starts.
      wrap.setAttribute('data-field', 'started');
    } else {
      const state = dueState(value, this.today);
      if (kind === 'planned') {
        if (state === 'today') wrap.setAttribute('data-planned', 'today');
      } else if (state) {
        wrap.setAttribute('data-due', state);
      }
    }
    const icon = wrap.createSpan();
    setIcon(icon, kind === 'planned' ? 'calendar' : kind === 'due' ? 'flag' : 'play');
    wrap.createSpan({ text: `${value} · ${relativeDate(value, this.today)}` });
    const clear = wrap.createSpan({ cls: 'ktm-date-clear' });
    setIcon(clear, 'x');
    this.registerDomEvent(clear, 'click', (ev) => {
      ev.stopPropagation();
      this.draft[kind] = undefined;
      this.paintDate(wrap, kind);
    });
  }

  // Opens the date field (DESIGN.md .ktm-date-field): a text input that takes
  // typed characters without ever auto-closing (S8/K1), plus the calendar
  // popover underneath. Enter and Tab commit and are handled here; Escape is
  // deliberately not, since the board's capture-phase listener sees it first
  // and must ask hasActiveField() before it decides to close the whole card.
  private editDate(wrap: HTMLElement, kind: 'planned' | 'due' | 'started'): void {
    if (this.dateEdit?.wrap === wrap) return;
    if (this.dateEdit) this.commitDateEdit(false);

    wrap.empty();
    wrap.removeClass('ktm-label');
    wrap.removeClass('ktm-card-meta-item');
    // Editing is neutral (DESIGN.md states: field being edited): the
    // due/planned signal belongs to the displayed value, not the
    // editor, otherwise it colors the calendar header/days red (finding F033).
    wrap.removeAttribute('data-due');
    wrap.removeAttribute('data-planned');
    wrap.removeAttribute('data-field');
    wrap.addClass('ktm-anchor');
    wrap.setAttribute('data-editing', 'true');

    const input = wrap.createEl('input', { type: 'text', cls: 'ktm-date-field' });
    input.value = this.draft[kind] ?? '';
    // Own layer at the window's body (#581 only lifts the card's own edge, not
    // the window's): position:fixed, placed below placeCalendar() so no card
    // or board edge can clip it, and the card never scrolls to reveal it (K1/K3).
    const calendarEl = this.containerEl.doc.body.createDiv({ cls: 'ktm-calendar' });

    const base = parseDateInput(input.value) ?? this.today;
    const [baseYear, baseMonth] = base.split('-').map(Number);
    this.renderCalendar(calendarEl, baseYear, baseMonth, kind, input, wrap);

    this.registerDomEvent(input, 'input', () => {
      const parsed = parseDateInput(input.value);
      if (!parsed) return;
      const [y, m] = parsed.split('-').map(Number);
      this.renderCalendar(calendarEl, y, m, kind, input, wrap);
    });
    this.registerDomEvent(input, 'keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.commitDateEdit(false);
      } else if (ev.key === 'Tab') {
        ev.preventDefault();
        this.commitDateEdit(true);
      }
    });

    const outside = (ev: MouseEvent): void => {
      const target = ev.target as Node;
      if (wrap.contains(target) || calendarEl.contains(target)) return;
      this.commitDateEdit(false);
    };
    const doc = this.containerEl.ownerDocument;
    doc.addEventListener('click', outside, true);

    // The card re-centers when the window or its own size changes (#903: a
    // viewport change after opening leaves the fixed calendar at its old
    // coordinates). Both reposition synchronously; rAF alone is throttled
    // while the window sits in the background (#705).
    const win = wrap.win as Window & { ResizeObserver: typeof ResizeObserver };
    const reposition = (): void => this.placeCalendar(wrap, calendarEl);
    win.addEventListener('resize', reposition);
    const resizeObserver = new win.ResizeObserver(reposition);
    resizeObserver.observe(this.containerEl);

    this.dateEdit = {
      kind,
      wrap,
      input,
      calendarEl,
      prev: this.draft[kind],
      cleanup: () => {
        doc.removeEventListener('click', outside, true);
        win.removeEventListener('resize', reposition);
        resizeObserver.disconnect();
        calendarEl.remove();
      },
    };
    input.focus({ preventScroll: true });
  }

  // Standard is below the field, left-aligned to it (DESIGN.md .ktm-date-field);
  // falls back to above when the window has no room below, and to right-aligned
  // when it has no room to the right. The window is wrap.win, not window, so a
  // detached test document still measures the right one (K1/K2/K5/K6).
  private placeCalendar(wrap: HTMLElement, calendarEl: HTMLElement): void {
    const win = wrap.win;
    const margin = 4;
    const fieldRect = wrap.getBoundingClientRect();
    const calRect = calendarEl.getBoundingClientRect();

    calendarEl.style.top = '';
    calendarEl.style.bottom = '';
    calendarEl.style.left = '';
    calendarEl.style.right = '';

    if (fieldRect.bottom + margin + calRect.height <= win.innerHeight) {
      calendarEl.style.top = `${fieldRect.bottom + margin}px`;
    } else {
      calendarEl.style.bottom = `${win.innerHeight - fieldRect.top + margin}px`;
    }

    if (fieldRect.left + calRect.width <= win.innerWidth) {
      calendarEl.style.left = `${fieldRect.left}px`;
    } else {
      calendarEl.style.right = `${win.innerWidth - fieldRect.right}px`;
    }
  }

  private renderCalendar(
    container: HTMLElement,
    year: number,
    month: number,
    kind: 'planned' | 'due' | 'started',
    input: HTMLInputElement,
    wrap: HTMLElement,
  ): void {
    container.empty();
    const head = container.createDiv({ cls: 'ktm-calendar-head' });
    const prev = head.createSpan({ cls: 'ktm-calendar-nav' });
    setIcon(prev, 'chevron-left');
    head.createSpan({ text: `${MONTH_NAMES[month - 1]} ${year}` });
    const next = head.createSpan({ cls: 'ktm-calendar-nav' });
    setIcon(next, 'chevron-right');
    this.registerDomEvent(prev, 'click', (ev) => {
      ev.stopPropagation();
      const [y, m] = shiftMonth(year, month, -1);
      this.renderCalendar(container, y, m, kind, input, wrap);
    });
    this.registerDomEvent(next, 'click', (ev) => {
      ev.stopPropagation();
      const [y, m] = shiftMonth(year, month, 1);
      this.renderCalendar(container, y, m, kind, input, wrap);
    });

    const grid = container.createDiv({ cls: 'ktm-calendar-grid' });
    grid.createSpan({ cls: 'is-week', text: 'KW' });
    for (const label of WEEKDAY_LABELS) grid.createSpan({ cls: 'is-head', text: label });

    const selected = parseDateInput(input.value) ?? this.draft[kind];
    for (const week of monthGrid(year, month, this.today, selected)) {
      grid.createSpan({ cls: 'is-week', text: String(week.week) });
      for (const day of week.days) {
        const cls: string[] = [];
        if (day.otherMonth) cls.push('is-other');
        if (day.isToday) cls.push('is-today');
        if (day.isSelected) cls.push('is-selected');
        const cell = grid.createSpan({ cls: cls.join(' '), text: String(day.day) });
        this.registerDomEvent(cell, 'click', (ev) => {
          ev.stopPropagation();
          input.value = day.date;
          this.commitDateEdit(false);
        });
      }
    }
    this.placeCalendar(wrap, container);
  }

  private commitDateEdit(advance: boolean): void {
    const state = this.dateEdit;
    if (!state) return;
    const raw = state.input.value.trim();
    const parsed = raw === '' ? undefined : parseDateInput(raw);
    if (raw !== '' && parsed === undefined) return;
    this.draft[state.kind] = parsed;
    this.closeDateEdit();
    this.paintDate(state.wrap, state.kind);
    if (advance && state.kind === 'planned' && this.dueWrap) {
      this.editDate(this.dueWrap, 'due');
    }
  }

  private cancelDateEdit(): void {
    const state = this.dateEdit;
    if (!state) return;
    this.draft[state.kind] = state.prev;
    this.closeDateEdit();
    this.paintDate(state.wrap, state.kind);
  }

  private closeDateEdit(): void {
    const state = this.dateEdit;
    if (!state) return;
    state.cleanup();
    this.dateEdit = undefined;
  }

  private statusName(status: string): string {
    return this.columns.find((c) => c.status === status)?.name ?? status;
  }

  // The parent chain as it stands after any cross-click or link-menu pick in
  // this session (F105): `newParents`, set by either, wins outright and is
  // returned unchanged; untouched, it falls back to the note's own chain.
  private effectiveParents(): ParentRef[] {
    return this.draft.newParents ?? this.element.parents;
  }

  // One flat list (DESIGN.md .ktm-links, 008 addendum 2026-09-20): parents
  // highest level first, then this element's open children (only where it can
  // have any, i.e. not on a Task), then the free links grouped by kind in the
  // configured order, then — last, 002 Ergänzung 2026-10-24 S93 — the
  // collapsed "Erledigt (n)" group for children whose status is closed
  // (statusClosure, wissen #648: the role follows the key, not a doneStatuses
  // list). Every row carries a pre-rendered, hover-only remove cross (wissen
  // #497). Free links are grouped by kind explicitly — not just taken in
  // `draft.links`' own order — so a newly added link lands next to others of
  // its kind instead of at the array's end (F051 K3/S30). A stacked draft
  // (F053) carries its preset parent/child rows through the same
  // chain/children the constructor filled in; a plain "Neue Aufgabe" has
  // neither and stays without rows (DESIGN.md Draft). The free-link loop is
  // the only part skipped in a draft (no note exists yet to link); the done
  // group still applies there.
  private renderLinks(parent: HTMLElement): void {
    parent.empty();
    const chain = this.effectiveParents();
    for (let i = chain.length - 1; i >= 0; i--) this.renderParentLink(parent, chain, i);
    const doneChildren: BoardElement[] = [];
    if (this.element.type !== 'task') {
      for (const child of this.children) {
        if (this.detachedChildren.has(child.paths.note)) continue;
        if (statusClosure(child.status, this.columns) === true) {
          doneChildren.push(child);
          continue;
        }
        this.renderChildLink(parent, child);
      }
    }
    if (!this.isDraft) {
      for (const kind of this.options.linkKinds) {
        for (const link of this.draft.links) {
          if (link.kind === kind.key) this.renderFreeLink(parent, kind, link);
        }
      }
    }
    if (doneChildren.length > 0) this.renderDoneGroup(parent, doneChildren);
  }

  private repaintLinks(): void {
    this.renderLinks(this.linksWrap);
  }

  // The collapsed-by-default "Erledigt (n)" row (002, Ergänzung 2026-10-24):
  // not a `.ktm-link` itself, so scripts reading `.ktm-link`/`.ktm-label`
  // don't count it as a linked item. A click toggles `doneExpanded` and
  // repaints; expanded, its children follow as plain sibling rows via the
  // same `renderChildLink` any other child uses.
  private renderDoneGroup(parent: HTMLElement, children: BoardElement[]): void {
    const row = parent.createDiv({ cls: 'ktm-done-group' });
    row.setAttribute('data-collapsed', String(!this.doneExpanded));
    setIcon(row.createSpan({ cls: 'ktm-done-group-chevron' }), this.doneExpanded ? 'chevron-down' : 'chevron-right');
    row.createSpan({ text: `Erledigt (${children.length})` });
    this.registerDomEvent(row, 'click', () => {
      this.doneExpanded = !this.doneExpanded;
      this.repaintLinks();
    });
    if (this.doneExpanded) {
      for (const child of children) this.renderChildLink(parent, child);
    }
  }

  // A row's common shell: icon, label, ellipsis-safe text taking the rest of
  // the width, then hover state via `data-hover` (styles.css keeps the remove
  // cross in the DOM at all times, only its visibility toggles).
  private beginLinkRow(parent: HTMLElement, icon: string, label: string, text: string): HTMLElement {
    const link = parent.createSpan({ cls: 'ktm-link' });
    setIcon(link.createSpan({ cls: 'ktm-link-icon' }), icon);
    link.createSpan({ cls: 'ktm-label', text: label });
    link.createSpan({ cls: 'ktm-link-text', text });
    this.registerDomEvent(link, 'pointerenter', () => link.setAttribute('data-hover', 'true'));
    this.registerDomEvent(link, 'pointerleave', () => link.removeAttribute('data-hover'));
    return link;
  }

  private addRemoveCross(link: HTMLElement, onRemove: () => void): void {
    const remove = link.createSpan({ cls: 'ktm-link-remove' });
    setIcon(remove, 'x');
    this.registerDomEvent(remove, 'click', (ev) => {
      ev.stopPropagation();
      onRemove();
    });
  }

  // A click on a parent row's cross raises the element to the next-
  // higher level (the clicked row's grandparent), or to the project
  // root ('', F051 K4/K5); clicking the row opens the parent note.
  // In a stacked draft (isDraft, F053) the row is a pure back-
  // reference before creation: no cross, no open click (wissen
  // #497, DESIGN.md Stacked draft).
  private renderParentLink(parent: HTMLElement, chain: ParentRef[], index: number): void {
    const ref = chain[index];
    const icon = this.levels.find((l) => l.key === ref.type)?.icon ?? PARENT_ICON.epic;
    const link = this.beginLinkRow(parent, icon, parentLabel(ref, this.levels), ref.title);
    if (this.isDraft) return;
    this.registerDomEvent(link, 'click', () => this.host.openNote(ref.note));
    this.addRemoveCross(link, () => {
      // Keeps the rest of the chain above this row, not just the next
      // ancestor alone (F105, wissen #825: resolving a multi-level parent
      // fully still takes one click per row).
      const rest = chain.slice(index + 1);
      this.draft.newParents = rest;
      const next = rest[0];
      this.draft.parentLabel = next ? parentFolderLabelFor(next, this.levels) : '';
      this.repaintLinks();
    });
  }

  // A click on a child row's cross marks it as detached (F051 K6);
  // clicking the row opens the child. Order comes pre-sorted via
  // `this.children` (BoardView.childrenOf/orderChildren); a closed child
  // (statusClosure) renders here too, but inside the "Erledigt" group
  // (renderDoneGroup) rather than among the open children.
  // Icon and name come defensively from this.levels (wissen #565): a
  // foreign level, for which CHILD_ICON/LEVEL_LABEL carry no entry, falls
  // through to setIcon(el, undefined) otherwise and breaks the rendering. In a
  // stacked draft (isDraft) no cross, no open click.
  private renderChildLink(parent: HTMLElement, child: BoardElement): void {
    const level = this.levels.find((l) => l.key === child.type);
    const icon = level?.icon ?? CHILD_ICON.task;
    const label = level?.name ?? LEVEL_LABEL[child.type] ?? child.type;
    const link = this.beginLinkRow(parent, icon, label, child.title);
    link.createSpan({ cls: 'ktm-child-status', text: this.statusName(child.status) });
    if (this.isDraft) return;
    this.registerDomEvent(link, 'click', () => this.host.openChild(child));
    this.addRemoveCross(link, () => {
      this.detachedChildren.add(child.paths.note);
      this.repaintLinks();
    });
  }

  // Shows the resolved note's own name, never the raw (possibly pathed)
  // linktext (002, Ergänzung 2026-10-06, "Notizname"; F107 K2), or an alias
  // where the link has one (002 S77, F138 K1): the full linktext (target only,
  // no alias) still goes in the tooltip, and target itself — unresolved — is
  // what click, remove and the link-menu's "already linked" check keep using.
  private renderFreeLink(parent: HTMLElement, kind: LinkKind, link: FreeLink): void {
    const resolve: LinkResolver = (linktext, sourcePath) =>
      this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)?.path;
    const linktext = link.alias ? `${link.target}|${link.alias}` : link.target;
    const displayName = linkDisplayName(linktext, this.element.paths.note, resolve);
    const row = this.beginLinkRow(parent, kind.icon, kind.label, displayName);
    setTooltip(row, link.target);
    this.registerDomEvent(row, 'click', () => this.host.openLink(link.target));
    // A Result row names its target instead of offering to become one (002
    // S84); every other free-link row gets the hover-only "Als Result
    // markieren" icon (wissen #497: vorgerendert, nur per data-hover
    // sichtbar, wie das Kreuz).
    if (kind.key === RESULT_LINK_KIND.key) {
      const targetLabel = this.host.resultTargetLabel(link.target);
      if (targetLabel) row.createSpan({ cls: 'ktm-child-status', text: `→ ${targetLabel}` });
    } else {
      this.addMarkResultIcon(row, link);
    }
    this.addRemoveCross(row, () => {
      this.draft.links = this.draft.links.filter((l) => !(l.kind === kind.key && l.target === link.target));
      this.repaintLinks();
    });
  }

  private addMarkResultIcon(row: HTMLElement, link: FreeLink): void {
    const mark = row.createSpan({ cls: 'ktm-link-mark-result' });
    setIcon(mark, 'file-check-2');
    setTooltip(mark, 'Als Result markieren');
    this.registerDomEvent(mark, 'click', (ev) => {
      ev.stopPropagation();
      const file = this.app.metadataCache.getFirstLinkpathDest(link.target, this.element.paths.note);
      if (!file) return;
      void this.host.assignResult(file, link.kind);
    });
  }

  // Patches the just-assigned Result straight into both link lists (wissen
  // #914: no round trip through the async metadataCache 'changed' event and
  // refreshLinks, which a debounced render could otherwise tear the still-
  // open card down in the middle of), so changes() sees nothing new to write
  // for either kind. Matches "fromKind"'s old entry and any prior `results`
  // entry for the same file by resolved path, not by raw text — the former
  // because an alias or a path-qualified target (002 S49) would otherwise
  // survive the removal, the latter because BoardView's own writes can make
  // the ordinary metadataCache 'changed' round trip (refreshLinks) land
  // between the write and this call and already add it once, which would
  // otherwise double it here.
  applyResult(file: TFile, fromKind?: string): void {
    const target = this.app.metadataCache.fileToLinktext(file, this.element.paths.note, true);
    const nextLink: FreeLink = { kind: RESULT_LINK_KIND.key, target };
    const resolvesToFile = (l: FreeLink): boolean =>
      this.app.metadataCache.getFirstLinkpathDest(l.target, this.element.paths.note)?.path === file.path;
    const withoutOld = (links: FreeLink[]): FreeLink[] =>
      links.filter((l) => !((fromKind && l.kind === fromKind && resolvesToFile(l)) || (l.kind === RESULT_LINK_KIND.key && resolvesToFile(l))));
    this.draft.links = [...withoutOld(this.draft.links), nextLink];
    this.original.links = [...withoutOld(this.original.links), nextLink];
    this.repaintLinks();
  }

  // Available "kinds" for the link-menu's kind dropdown (F052): every level of
  // the element's own project but its own, ancestor levels hidden while
  // already set (effectiveParents, K3), then the free link kinds in their
  // configured order (K6: a descendant level like Task-from-Feature is
  // offered but not wired to a pick, see class-level note on openLinkMenu).
  // On the draft (F055) only ancestor levels make it through: the note
  // doesn't exist yet, so neither a descendant level nor a free note/ADR link
  // has anything to point at ("ausserhalb").
  private availableArts(): LinkArt[] {
    const levels = this.levels;
    const ownIndex = levels.findIndex((l) => l.key === this.draft.type);
    const setParentTypes = new Set(this.effectiveParents().map((p) => p.type));
    const levelArts: LinkArt[] = [];
    levels.forEach((level, i) => {
      if (level.key === this.draft.type) return;
      const ancestor = ownIndex !== -1 && i < ownIndex;
      if (this.isDraft && !ancestor) return;
      if (ancestor && setParentTypes.has(level.key)) return;
      levelArts.push({ label: level.name, icon: level.icon, level: level.key, ancestor });
    });
    if (this.isDraft) return levelArts;
    // Result has no possible target from the project's topmost level (008,
    // Ergänzung 2026-10-19): nothing ranks above it to assign a document to.
    const noResultTarget = ownIndex === 0;
    const noteArts: LinkArt[] = this.options.linkKinds
      .filter((kind) => kind.key !== RESULT_LINK_KIND.key || !noResultTarget)
      .map((kind) => ({
        label: kind.label,
        icon: kind.icon,
        linkKind: kind,
      }));
    return [...levelArts, ...noteArts];
  }

  // Popover under the Links plus (DESIGN.md .ktm-linkmenu, third
  // version): a kind dropdown (availableArts) replacing the old note/ADR
  // segment, one search field, a trailing "Neu anlegen" row and in between
  // either the grouped, scrolling Ebenen-list (level kind, unbounded, 002
  // Ergänzung 2026-10-18) or up to five note matches (unchanged, S58). A
  // level kind searches host.searchElements and, for an
  // ancestor level, picks set the parent (K1/K2); a descendant level (e.g.
  // Task from a Feature) only offers itself in the dropdown (K6) — picking an
  // existing match or "Neu anlegen" for it is F053's stacked draft, out of
  // scope here (see contract "ausserhalb"). Escape/outside-click precedence
  // is wired through hasActiveField/cancelActiveField like the other fields.
  private openLinkMenu(head: HTMLElement): void {
    this.closeLinkMenu();
    head.setAttribute('data-open', 'true');
    // The card scrolls (overflow-y: auto) once its content overflows; the
    // popover is meant to overrun the card edge (DESIGN.md .ktm-linkmenu), so
    // the card's overflow is lifted for as long as the popover is open.
    this.containerEl.setAttribute('data-popover', 'true');
    const menu = head.createDiv({ cls: 'ktm-linkmenu' });
    const arts = this.availableArts();
    let active: LinkArt | undefined = arts[0];
    let noteMatches: TFile[] = [];
    let elementMatches: LinkSearchResult[] = [];

    const selectRow = menu.createDiv({ cls: 'ktm-linkmenu-select' });
    const search = menu.createDiv({ cls: 'ktm-search' });
    setIcon(search.createSpan(), 'search');
    const input = search.createEl('input', { type: 'text', cls: 'ktm-search-input' });
    const list = menu.createDiv({ cls: 'ktm-linkmenu-list' });
    const createRow = menu.createDiv({ cls: 'ktm-linkmenu-create' });

    const paintSelect = (): void => {
      selectRow.empty();
      if (!active) return;
      const label = selectRow.createSpan({ cls: 'ktm-linkmenu-select-label' });
      setIcon(label.createSpan(), active.icon);
      label.createSpan({ text: active.label });
      this.addSelectChevron(selectRow);
    };

    const openArtMenu = (): void => {
      if (arts.length === 0) return;
      const artMenu = new Menu();
      for (const art of arts) {
        artMenu.addItem((item) =>
          item
            .setTitle(art.label)
            .setIcon(art.icon)
            .onClick(() => {
              active = art;
              paintSelect();
              paintResults();
            }),
        );
      }
      const rect = selectRow.getBoundingClientRect();
      artMenu.showAtPosition({ x: rect.left, y: rect.bottom }, this.containerEl.ownerDocument);
    };
    this.registerDomEvent(selectRow, 'click', (ev) => {
      ev.stopPropagation();
      openArtMenu();
    });

    const highlightFirst = (): void => {
      const first = list.querySelector('.ktm-linkmenu-item');
      if (first) first.setAttribute('data-hover', 'true');
    };
    const onHover = (item: HTMLElement): void => {
      for (const el of Array.from(list.children)) el.removeAttribute('data-hover');
      item.setAttribute('data-hover', 'true');
    };

    const paintResults = (): void => {
      list.empty();
      createRow.empty();
      if (!active) return;
      const query = input.value.trim();

      if (active.level) {
        const level = active.level;
        const ancestor = active.ancestor === true;
        // Searched with an empty query too (F105 K7): the field shows the
        // level's elements, the card's own parents' children first, before
        // anything is typed.
        elementMatches = this.host.searchElements(
          level,
          query,
          this.effectiveParents().map((p) => p.id),
        );
        // Groups come pre-sorted and pre-numbered from linkCandidates; a
        // separator marks every change of `group` (002, Ergänzung
        // 2026-10-18), never a heading.
        elementMatches.forEach((res, i) => {
          if (i > 0 && res.group !== elementMatches[i - 1].group) {
            list.createDiv({ cls: 'ktm-linkmenu-sep' });
          }
          const item = list.createDiv({ cls: 'ktm-linkmenu-item' });
          if (res.closed) item.setAttribute('data-closed', 'true');
          setIcon(item.createSpan(), active!.icon);
          item.createSpan({ text: res.title });
          item.createSpan({
            cls: 'ktm-linkmenu-folder',
            text: res.project ? `${res.project} · ${res.statusName}` : res.statusName,
          });
          this.registerDomEvent(item, 'pointerenter', () => onHover(item));
          if (ancestor) {
            this.registerDomEvent(item, 'click', (ev) => {
              ev.stopPropagation();
              this.pickParent(level, active!.label, res);
            });
          }
        });
        highlightFirst();

        // No "Neu anlegen" on the draft (F055, "ausserhalb"): a
        // stacked draft above a draft creates nothing, because the
        // source note itself doesn't exist yet.
        if (!this.isDraft) {
          const createItem = createRow.createDiv({ cls: 'ktm-linkmenu-item' });
          setIcon(createItem.createSpan(), 'plus');
          createItem.createSpan({ text: `Neu anlegen: ${active.label} „${query}“` });
          this.registerDomEvent(createItem, 'click', (ev) => {
            ev.stopPropagation();
            if (!query) return;
            this.closeLinkMenu();
            this.host.createStackedElement(level, ancestor, query);
          });
        }
        return;
      }

      const kind = active.linkKind!;
      // Result searches every vault file, not just markdown ones (002,
      // Ergänzung 2026-10-19 "Result"), has no "Neu anlegen" row, and a pick
      // opens the Result-Dialog through the host instead of linking directly.
      if (kind.key === RESULT_LINK_KIND.key) {
        const linkedResultPaths = new Set<string>();
        for (const l of this.draft.links) {
          if (l.kind !== kind.key) continue;
          const resolved = this.app.metadataCache.getFirstLinkpathDest(l.target, this.element.paths.note)?.path;
          if (resolved) linkedResultPaths.add(resolved);
        }
        noteMatches = query
          ? this.app.vault
              .getFiles()
              .filter(
                (f) =>
                  f.path !== this.element.paths.note &&
                  !linkedResultPaths.has(f.path) &&
                  f.basename.toLowerCase().includes(query.toLowerCase()),
              )
              .sort((a, b) => a.basename.localeCompare(b.basename))
              .slice(0, 5)
          : [];
        noteMatches.forEach((file) => {
          const item = list.createDiv({ cls: 'ktm-linkmenu-item' });
          setIcon(item.createSpan(), kind.icon);
          item.createSpan({ text: file.basename });
          item.createSpan({ cls: 'ktm-linkmenu-folder', text: file.parent?.name ?? '' });
          this.registerDomEvent(item, 'pointerenter', () => onHover(item));
          this.registerDomEvent(item, 'click', (ev) => {
            ev.stopPropagation();
            this.closeLinkMenu();
            void this.host.assignResult(file);
          });
        });
        highlightFirst();
        return;
      }
      // Excludes an already-linked note by its resolved path (F107 K6), not
      // just its basename — a link with a path (002 S49) would otherwise
      // keep showing up as a match. A target that resolves nowhere falls
      // back to the old basename compare.
      const linkedPaths = new Set<string>();
      const linkedNames = new Set<string>();
      for (const l of this.draft.links) {
        if (l.kind !== kind.key) continue;
        const resolved = this.app.metadataCache.getFirstLinkpathDest(l.target, this.element.paths.note)?.path;
        if (resolved) linkedPaths.add(resolved);
        else linkedNames.add(l.target);
      }
      noteMatches = query
        ? this.app.vault
            .getMarkdownFiles()
            .filter(
              (f) =>
                f.path !== this.element.paths.note &&
                !linkedPaths.has(f.path) &&
                !linkedNames.has(f.basename) &&
                f.basename.toLowerCase().includes(query.toLowerCase()),
            )
            .sort((a, b) => a.basename.localeCompare(b.basename))
            .slice(0, 5)
        : [];
      noteMatches.forEach((file) => {
        const item = list.createDiv({ cls: 'ktm-linkmenu-item' });
        setIcon(item.createSpan(), 'file-text');
        item.createSpan({ text: file.basename });
        item.createSpan({ cls: 'ktm-linkmenu-folder', text: file.parent?.name ?? '' });
        this.registerDomEvent(item, 'pointerenter', () => onHover(item));
        this.registerDomEvent(item, 'click', (ev) => {
          ev.stopPropagation();
          this.pickExistingLink(kind, file);
        });
      });
      highlightFirst();

      const createItem = createRow.createDiv({ cls: 'ktm-linkmenu-item' });
      setIcon(createItem.createSpan(), 'plus');
      createItem.createSpan({ text: `Neu anlegen: „${query}“` });
      this.registerDomEvent(createItem, 'click', (ev) => {
        ev.stopPropagation();
        if (!query) return;
        void this.createAndLink(kind, query);
      });
    };

    paintSelect();
    paintResults();
    this.registerDomEvent(input, 'input', paintResults);
    this.registerDomEvent(input, 'keydown', (ev) => {
      if (ev.key !== 'Enter' || !active) return;
      ev.preventDefault();
      const query = input.value.trim();
      if (active.level) {
        if (active.ancestor && elementMatches[0]) {
          this.pickParent(active.level, active.label, elementMatches[0]);
        } else if (query && !this.isDraft) {
          const level = active.level;
          const ancestor = active.ancestor === true;
          this.closeLinkMenu();
          this.host.createStackedElement(level, ancestor, query);
        }
      } else if (noteMatches[0]) {
        if (active.linkKind!.key === RESULT_LINK_KIND.key) {
          this.closeLinkMenu();
          void this.host.assignResult(noteMatches[0]);
        } else {
          this.pickExistingLink(active.linkKind!, noteMatches[0]);
        }
      } else if (query && active.linkKind!.key !== RESULT_LINK_KIND.key) {
        void this.createAndLink(active.linkKind!, query);
      }
    });

    // Obsidian's own kind-dropdown Menu (openArtMenu) renders outside this
    // popover's DOM; without excluding it, a click on one of its items would
    // read as an outside click and close the whole popover before onClick runs.
    const outside = (ev: MouseEvent): void => {
      if (menu.contains(ev.target as Node)) return;
      if ((ev.target as HTMLElement).closest?.('.menu')) return;
      this.closeLinkMenu();
    };
    const doc = this.containerEl.ownerDocument;
    doc.addEventListener('click', outside, true);

    this.linkMenu = { head, el: menu, cleanup: () => doc.removeEventListener('click', outside, true) };
    input.focus();
  }

  // Sets a freshly picked ancestor, with its own chain, as the element's
  // parent (F052 K1/K2, F105): the link list shows it immediately via
  // effectiveParents()/newParents, the actual refile happens through the
  // existing parentLabel path on close (wissen #540). `res.chain` is top to
  // bottom (core/board.ts#parentChain); reversed it matches `newParents`'
  // nearest-first order and replaces whatever stood above the picked level
  // outright — a conflict there is only reported, never left standing
  // (008, Ergänzung 2026-10-06, S46).
  private pickParent(level: ElementType, levelLabel: string, res: LinkSearchResult): void {
    const previous = this.effectiveParents();
    const newChain = [...res.chain].reverse();
    this.notifyParentConflict(previous, newChain, level);
    this.draft.newParents = newChain;
    this.draft.parentLabel = `${levelLabel}: ${res.title}`;
    // A draft set to "Atomar" via the folder field falls back to
    // Standardablage when setting a parent (008 S22). In a draft this wins
    // outright even when it was fixed atomic at open time (view all/
    // internal, F104, 003 addendum 2026-10-06): the parent's own project
    // takes over first, the same way a dropdown change does, which already
    // flips atomic off where the new project has a root.
    if (this.isDraft) {
      if (res.project !== this.draft.project) {
        this.draft.project = res.project;
        this.onDraftProjectChange();
      } else if (this.draft.atomic) {
        this.draft.atomic = false;
        this.draft.ownFolderTarget = undefined;
        this.paintLevel();
        this.paintFolder();
      }
    } else {
      // An existing element follows the picked ancestor across a project
      // boundary too (011 S103: a parent only counts "aus einem anderen
      // Projekt" — and is refused — when it still points outside the
      // project the element carries after the write; project and parent
      // travel together here exactly as `ktm:set id=… project=… parent=…`
      // does). Without this, the card wrote `parent` alone, the element
      // kept its old `project`, and the move was rejected as invalid (008
      // S75, F124 K7/K9).
      if (res.project !== this.draft.project) {
        this.draft.project = res.project;
        this.paintProject();
      }
      if (this.draft.atomic && this.element.form !== 'atomic') {
        this.draft.atomic = false;
        this.draft.ownFolderTarget = undefined;
        this.paintFolder();
      }
    }
    this.closeLinkMenu();
    this.repaintLinks();
  }

  // Compares the ancestors above the picked level, before and after a pick
  // (008, Ergänzung 2026-10-06, S46): a level's own ancestor always wins, so
  // an ancestor the card already had there that is replaced or dropped
  // would otherwise vanish silently. One Obsidian Notice names every such
  // ancestor, the title it had and, if there still is one, its replacement.
  private notifyParentConflict(previous: ParentRef[], next: ParentRef[], level: ElementType): void {
    const indexOf = (key: ElementType): number => this.levels.findIndex((l) => l.key === key);
    const aboveLevel = indexOf(level);
    const previousAbove = previous.filter((p) => indexOf(p.type) < aboveLevel);
    if (previousAbove.length === 0) return;
    const nextByType = new Map(
      next.filter((p) => indexOf(p.type) < aboveLevel).map((p) => [p.type, p] as const),
    );
    const sentences: string[] = [];
    for (const prev of previousAbove) {
      const replacement = nextByType.get(prev.type);
      if (replacement && replacement.id === prev.id) continue;
      const levelName = parentLabel(prev, this.levels);
      sentences.push(
        replacement
          ? `${levelName} „${prev.title}“ wird durch „${replacement.title}“ ersetzt.`
          : `${levelName} „${prev.title}“ entfällt.`,
      );
    }
    if (sentences.length > 0) new Notice(sentences.join(' '));
  }

  private pickExistingLink(kind: LinkKind, file: TFile): void {
    const target = this.app.metadataCache.fileToLinktext(file, this.element.paths.note, true);
    this.draft.links.push({ kind: kind.key, target });
    this.closeLinkMenu();
    this.repaintLinks();
  }

  private async createAndLink(kind: LinkKind, title: string): Promise<void> {
    const target = await this.host.createLinkNote(kind, title);
    if (!target) return;
    this.draft.links.push({ kind: kind.key, target });
    this.closeLinkMenu();
    this.repaintLinks();
  }

  private closeLinkMenu(): void {
    const state = this.linkMenu;
    if (!state) return;
    state.cleanup();
    state.head.removeAttribute('data-open');
    state.el.remove();
    this.linkMenu = undefined;
    this.containerEl.removeAttribute('data-popover');
  }
}

function fieldChange(
  target: Record<string, string | null>,
  key: string,
  original: string | undefined,
  next: string | undefined,
): void {
  if (next === original) return;
  target[key] = next ?? null;
}

// The ancestor's own level name (008 addendum 2026-09-20: not fixed to
// Epic/Feature), falling back to Epic for a type the project's own levels no
// longer carry.
function parentLabel(ref: ParentRef, levels: Level[]): string {
  return levels.find((l) => l.key === ref.type)?.name ?? 'Epic';
}

// The label that core/refile.ts#resolveParentTarget resolves back to this
// ancestor's folder (F034 format "Epic: Title" / "Feature: Title"); exported
// for BoardView#closeDetail, which builds the same label for a detached
// child's new parent (F113).
export function parentFolderLabelFor(ref: ParentRef, levels: Level[]): string {
  return `${parentLabel(ref, levels)}: ${ref.title}`;
}

// Initial value of draft.parentLabel: the nearest parent's label, or ''
// for an element without a parent (project root or atomic task). Without
// the parent dropdown (F051) this is now only the internal reference point
// that a cross on a parent row changes (renderParentLink); without such a
// click it stays unchanged and triggers no refile in changes().
function initialParentLabel(element: BoardElement, levels: Level[]): string {
  if (element.form === 'atomic') return 'Atomar';
  const parent = element.parents[0];
  return parent ? parentFolderLabelFor(parent, levels) : '';
}

function folderBaseName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

function stripHash(tag: string): string {
  return tag.startsWith('#') ? tag.slice(1) : tag;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Keeps an existing alias through an unrelated change to another link of the
// same kind (002 S77, F138; wissen #992: the quoting against the YAML pipe
// ambiguity happens in `changes()` via `flowList(..., true)`).
function wikilink(link: FreeLink): string {
  return link.alias ? `[[${link.target}|${link.alias}]]` : `[[${link.target}]]`;
}
