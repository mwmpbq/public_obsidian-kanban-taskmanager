import {
  type App,
  Component,
  DropdownComponent,
  MarkdownRenderer,
  Menu,
  setIcon,
  type TFile,
  TFolder,
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
import { flowList, yamlScalar } from '../core/frontmatter';
import type { BoardElement, ElementType, FreeLink, ParentRef } from '../core/model';
import { type Column, isBottomLevel, type Level, type LinkKind } from '../core/settings';
import { toggleTaskLine } from '../core/tasklist';

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
  body: string;
  title: string;
  short?: string;
  project?: string;
  type: ElementType;
  parentLabel: string;
  tags: string[];
  links: FreeLink[];
  // A parent picked in this session from the link-menu's element search
  // (F052 K1/K2), not present in `element.parents`: effectiveParents() shows
  // it right away, ahead of the refile that only happens on close.
  newParent?: ParentRef;
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
  // The element's own project's levels, in project order (F052): the
  // link-menu's kind dropdown offers every level but the element's own.
  levels: Level[];
  linkKinds: LinkKind[];
  vaultTags: string[];
}

// One link-menu search hit for a level (F052 S36): the board resolves it
// from its already-loaded elements, so this component never imports obsidian
// vault APIs for it.
export interface LinkSearchResult {
  path: string;
  title: string;
  project?: string;
  statusName: string;
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
  // Searches the elements of one level for the link-menu (F052 S36): up to
  // five matches, the searching card's own project first.
  searchElements(level: ElementType, query: string): LinkSearchResult[];
  // Opens a stacked draft of the chosen level above the currently
  // open card (008 addendum 2026-09-20, F053): `ancestor` true when the
  // level ranks above its own (the open card becomes its child),
  // else the open card itself becomes the draft's parent.
  createStackedElement(level: ElementType, ancestor: boolean, title: string): void;
}

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

const MONTH_NAMES = [
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

const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function shiftMonth(year: number, month: number, delta: number): [number, number] {
  const total = year * 12 + (month - 1) + delta;
  return [Math.floor(total / 12), (total % 12) + 1];
}

interface DateEditState {
  kind: 'planned' | 'due';
  wrap: HTMLElement;
  input: HTMLInputElement;
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
  // Child note paths whose cross was clicked in this session (F051 K6).
  private readonly detachedChildren = new Set<string>();

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
    // The board element carries no body; the caller feeds it via setBody once
    // the note is read, which also refreshes the baseline for change detection.
    this.draft = {
      status: element.status,
      priority: element.priority,
      planned: element.planned,
      due: element.due,
      body: '',
      title: element.title,
      short: element.short,
      project: element.project,
      type: element.type,
      parentLabel: initialParentLabel(element, options.levels),
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
  }

  // Whether a field's typed-but-unconfirmed input is open. The board asks this
  // before Escape closes the whole card (S11/K4): the field wins first.
  hasActiveField(): boolean {
    return (
      this.dateEdit !== undefined ||
      this.titleEdit !== undefined ||
      this.shortEdit !== undefined ||
      this.tagEdit !== undefined ||
      this.linkMenu !== undefined ||
      this.folderMenu !== undefined
    );
  }

  cancelActiveField(): void {
    if (this.titleEdit) this.cancelTitleEdit();
    else if (this.shortEdit) this.cancelShortEdit();
    else if (this.tagEdit) this.cancelTagEdit();
    else if (this.linkMenu) this.closeLinkMenu();
    else if (this.folderMenu) this.closeFolderMenu();
    else this.cancelDateEdit();
  }

  setBody(body: string): void {
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
    fieldChange(frontmatter, 'short', this.original.short, this.draft.short);
    if (typeof frontmatter.short === 'string') frontmatter.short = yamlScalar(frontmatter.short);

    if (!sameList(this.draft.tags, this.original.tags)) {
      frontmatter.tags = this.draft.tags.length ? flowList(this.draft.tags, false) : null;
    }
    for (const kind of this.options.linkKinds) {
      const before = this.original.links.filter((l) => l.kind === kind.key).map((l) => l.target);
      const after = this.draft.links.filter((l) => l.kind === kind.key).map((l) => l.target);
      if (!sameList(before, after)) {
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
    this.renderFolderField(fields.createSpan({ cls: 'ktm-value ktm-folder-value ktm-field-span' }));
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
  // (008 addendum 2026-09-20 S35/S36, F054); on a draft the field stays
  // display-only, since it has no note yet that could move.
  private renderFolderField(wrap: HTMLElement): void {
    this.folderWrap = wrap;
    if (this.element.form === 'atomic') {
      setIcon(wrap.createSpan(), 'folder');
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
    setIcon(wrap.createSpan(), 'folder');
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
      if (this.isDraft && isBottomLevel(this.options.levels, this.draft.type)) {
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
    chip.setText(stripHash(tag));
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

  // Replaces the ghost chip with an input plus a suggestion popover (open:
  // "shaped like the link-menu's search field, suggestions like its
  // results list"). Enter or an outside click commits the typed text as a new
  // tag; a suggestion click commits that tag instead.
  private editTag(ghost: HTMLElement): void {
    if (this.tagEdit) return;
    const wrap = this.tagsWrap.createSpan({ cls: 'ktm-anchor' });
    ghost.replaceWith(wrap);
    const input = wrap.createEl('input', { type: 'text', cls: 'ktm-tag-input' });
    const suggestions = wrap.createDiv({ cls: 'ktm-tag-suggestions' });
    suggestions.hide();

    const paintSuggestions = (): void => {
      const query = stripHash(input.value.trim()).toLowerCase();
      suggestions.empty();
      const matches = query
        ? this.options.vaultTags
            .filter((tag) => !this.draft.tags.includes(tag))
            .filter((tag) => stripHash(tag).toLowerCase().includes(query))
            .slice(0, 5)
        : [];
      if (matches.length === 0) {
        suggestions.hide();
        return;
      }
      suggestions.show();
      for (const tag of matches) {
        const item = suggestions.createDiv({ cls: 'ktm-linkmenu-item', text: stripHash(tag) });
        this.registerDomEvent(item, 'click', (ev) => {
          ev.stopPropagation();
          this.commitTag(tag);
        });
      }
    };

    this.registerDomEvent(input, 'input', paintSuggestions);
    this.registerDomEvent(input, 'keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.commitTag(input.value);
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
    const value = stripHash(raw.trim());
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
    });
    this.addSelectChevron(parent);
  }

  private renderProject(parent: HTMLElement): void {
    const dropdown = new DropdownComponent(parent);
    const options = this.options.projects;
    const current = this.draft.project;
    if (current && !options.includes(current)) dropdown.addOption(current, current);
    for (const option of options) dropdown.addOption(option, option);
    if (current) dropdown.setValue(current);
    dropdown.onChange((value) => {
      this.draft.project = value;
    });
    this.addSelectChevron(parent);
  }

  // On an atomic task the level is fixed to the project's bottom level (002
  // S28, K7; 009 addendum 2026-09-20): embedding it under an ancestor goes
  // through parent, not this field. Otherwise the offer follows the
  // level order with the element's own parent and children (008 S23/S40,
  // core/board.ts#offerableLevels).
  private renderLevel(parent: HTMLElement): void {
    const dropdown = new DropdownComponent(parent);
    const atomic = this.element.form === 'atomic';
    const bottom = this.options.levels[this.options.levels.length - 1];
    const levels = atomic
      ? bottom
        ? [bottom]
        : []
      : offerableLevels(
          this.options.levels,
          this.effectiveParents()[0]?.type,
          this.children.map((c) => c.type),
        );
    for (const level of levels) dropdown.addOption(level.key, level.name);
    const current = levels.find((l) => l.key === this.draft.type) ?? bottom;
    if (current) dropdown.setValue(current.key);
    dropdown.onChange((value) => {
      this.draft.type = value;
    });
    this.addSelectChevron(parent);
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
    input.select();

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
    });
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
    this.renderDescription();
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
    void MarkdownRenderer.render(this.app, this.draft.body, rendered, this.element.paths.note, this);
  }

  private startBodyEdit(): void {
    this.editingBody = true;
    const rendered = this.containerEl.querySelector<HTMLElement>('.ktm-description-rendered');
    rendered?.hide();
    this.descriptionEdit.value = this.draft.body;
    this.descriptionEdit.show();
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

  private paintDate(wrap: HTMLElement, kind: 'planned' | 'due'): void {
    wrap.empty();
    wrap.removeAttribute('data-planned');
    wrap.removeAttribute('data-due');
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
    const state = dueState(value, this.today);
    if (kind === 'planned') {
      if (state === 'today') wrap.setAttribute('data-planned', 'today');
    } else if (state) {
      wrap.setAttribute('data-due', state);
    }
    const icon = wrap.createSpan();
    setIcon(icon, kind === 'planned' ? 'calendar' : 'flag');
    wrap.createSpan({ text: `${value} · ${relativeDate(value, this.today)}` });
  }

  // Opens the date field (DESIGN.md .ktm-date-field): a text input that takes
  // typed characters without ever auto-closing (S8/K1), plus the calendar
  // popover underneath. Enter and Tab commit and are handled here; Escape is
  // deliberately not, since the board's capture-phase listener sees it first
  // and must ask hasActiveField() before it decides to close the whole card.
  private editDate(wrap: HTMLElement, kind: 'planned' | 'due'): void {
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
    wrap.addClass('ktm-anchor');
    wrap.setAttribute('data-editing', 'true');

    const input = wrap.createEl('input', { type: 'text', cls: 'ktm-date-field' });
    input.value = this.draft[kind] ?? '';
    const calendarEl = wrap.createDiv({ cls: 'ktm-calendar' });

    const base = parseDateInput(input.value) ?? this.today;
    const [baseYear, baseMonth] = base.split('-').map(Number);
    this.renderCalendar(calendarEl, baseYear, baseMonth, kind, input);

    this.registerDomEvent(input, 'input', () => {
      const parsed = parseDateInput(input.value);
      if (!parsed) return;
      const [y, m] = parsed.split('-').map(Number);
      this.renderCalendar(calendarEl, y, m, kind, input);
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
      if (wrap.contains(ev.target as Node)) return;
      this.commitDateEdit(false);
    };
    const doc = this.containerEl.ownerDocument;
    doc.addEventListener('click', outside, true);

    this.dateEdit = {
      kind,
      wrap,
      input,
      prev: this.draft[kind],
      cleanup: () => doc.removeEventListener('click', outside, true),
    };
    input.focus();
  }

  private renderCalendar(
    container: HTMLElement,
    year: number,
    month: number,
    kind: 'planned' | 'due',
    input: HTMLInputElement,
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
      this.renderCalendar(container, y, m, kind, input);
    });
    this.registerDomEvent(next, 'click', (ev) => {
      ev.stopPropagation();
      const [y, m] = shiftMonth(year, month, 1);
      this.renderCalendar(container, y, m, kind, input);
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
  // this session: a freshly picked parent (F052 K1/K2) wins outright, else
  // the full chain from the note unless `parentLabel` has moved (a row's
  // cross was clicked), in which case it is truncated to the ancestor that
  // label now names — or emptied for the root label '' (F051 K4/K5).
  private effectiveParents(): ParentRef[] {
    if (this.draft.newParent) return [this.draft.newParent];
    if (this.draft.parentLabel === this.original.parentLabel) return this.element.parents;
    const idx = this.element.parents.findIndex(
      (p) => parentFolderLabelFor(p, this.options.levels) === this.draft.parentLabel,
    );
    return idx === -1 ? [] : this.element.parents.slice(idx);
  }

  // One flat list (DESIGN.md .ktm-links, 008 addendum 2026-09-20): parents
  // highest level first, then this element's children (only where it can have
  // any, i.e. not on a Task), then the free links grouped by kind in the
  // configured order. Every row carries a pre-rendered, hover-only remove
  // cross (wissen #497). Free links are grouped by kind explicitly — not just
  // taken in `draft.links`' own order — so a newly added link lands next to
  // others of its kind instead of at the array's end (F051 K3/S30). A
  // A stacked draft (F053) carries its preset parent/child rows through the
  // same chain/children the constructor filled in; a plain "Neue Aufgabe" has
  // neither and stays without rows (DESIGN.md Draft).
  private renderLinks(parent: HTMLElement): void {
    parent.empty();
    const chain = this.effectiveParents();
    for (let i = chain.length - 1; i >= 0; i--) this.renderParentLink(parent, chain, i);
    if (this.element.type !== 'task') {
      for (const child of this.children) {
        if (this.detachedChildren.has(child.paths.note)) continue;
        this.renderChildLink(parent, child);
      }
    }
    if (this.isDraft) return;
    for (const kind of this.options.linkKinds) {
      for (const link of this.draft.links) {
        if (link.kind === kind.key) this.renderFreeLink(parent, kind, link.target);
      }
    }
  }

  private repaintLinks(): void {
    this.renderLinks(this.linksWrap);
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
    const icon = this.options.levels.find((l) => l.key === ref.type)?.icon ?? PARENT_ICON.epic;
    const link = this.beginLinkRow(parent, icon, parentLabel(ref, this.options.levels), ref.title);
    if (this.isDraft) return;
    this.registerDomEvent(link, 'click', () => this.host.openNote(ref.note));
    this.addRemoveCross(link, () => {
      this.draft.newParent = undefined;
      const next = chain[index + 1];
      this.draft.parentLabel = next ? parentFolderLabelFor(next, this.options.levels) : '';
      this.repaintLinks();
    });
  }

  // A click on a child row's cross marks it as detached (F051 K6);
  // clicking the row opens the child. Order comes pre-sorted
  // via `this.children` (BoardView.childrenOf/orderChildren, Done last).
  // Icon and name come defensively from options.levels (wissen #565): a
  // foreign level, for which CHILD_ICON/LEVEL_LABEL carry no entry, falls
  // through to setIcon(el, undefined) otherwise and breaks the rendering. In a
  // stacked draft (isDraft) no cross, no open click.
  private renderChildLink(parent: HTMLElement, child: BoardElement): void {
    const level = this.options.levels.find((l) => l.key === child.type);
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

  private renderFreeLink(parent: HTMLElement, kind: LinkKind, target: string): void {
    const link = this.beginLinkRow(parent, kind.icon, kind.label, target);
    this.registerDomEvent(link, 'click', () => this.host.openLink(target));
    this.addRemoveCross(link, () => {
      this.draft.links = this.draft.links.filter((l) => !(l.kind === kind.key && l.target === target));
      this.repaintLinks();
    });
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
    const levels = this.options.levels;
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
    const noteArts: LinkArt[] = this.options.linkKinds.map((kind) => ({
      label: kind.label,
      icon: kind.icon,
      linkKind: kind,
    }));
    return [...levelArts, ...noteArts];
  }

  // Popover under the Links plus (DESIGN.md .ktm-linkmenu, third
  // version): a kind dropdown (availableArts) replacing the old note/ADR
  // segment, one search field, up to five matches and a trailing "Neu
  // anlegen" row. A level kind searches host.searchElements and, for an
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
      const first = list.firstElementChild;
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
        elementMatches = query ? this.host.searchElements(level, query) : [];
        elementMatches.forEach((res) => {
          const item = list.createDiv({ cls: 'ktm-linkmenu-item' });
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
      const linked = new Set(this.draft.links.filter((l) => l.kind === kind.key).map((l) => l.target));
      noteMatches = query
        ? this.app.vault
            .getMarkdownFiles()
            .filter(
              (f) =>
                f.path !== this.element.paths.note &&
                !linked.has(f.basename) &&
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
        this.pickExistingLink(active.linkKind!, noteMatches[0]);
      } else if (query) {
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

  // Sets a freshly picked ancestor as the element's parent (F052 K1/K2): the
  // link list shows it immediately via effectiveParents()/newParent,
  // the actual refile happens through the existing parentLabel path on close
  // (wissen #540).
  private pickParent(level: ElementType, levelLabel: string, res: LinkSearchResult): void {
    this.draft.newParent = { type: level, title: res.title, note: res.path };
    this.draft.parentLabel = `${levelLabel}: ${res.title}`;
    // A draft set to "Atomar" via the folder field falls back to
    // Standardablage when setting a parent (008 S22); a draft whose
    // form is fixed atomic (view all/internal) never reaches this line
    // anyway (availableArts offers no ancestor levels there).
    if (this.draft.atomic && this.element.form !== 'atomic') {
      this.draft.atomic = false;
      this.draft.ownFolderTarget = undefined;
      this.paintFolder();
    }
    this.closeLinkMenu();
    this.repaintLinks();
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

// The label that BoardView.parentFolderForLabel resolves back to this
// ancestor's folder (F034 format "Epic: Title" / "Feature: Title").
function parentFolderLabelFor(ref: ParentRef, levels: Level[]): string {
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

function wikilink(target: string): string {
  return `[[${target}]]`;
}
