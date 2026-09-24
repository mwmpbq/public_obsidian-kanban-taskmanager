import {
  type App,
  type CachedMetadata,
  DropdownComponent,
  ItemView,
  Notice,
  setIcon,
  type TAbstractFile,
  TFile,
  TFolder,
  type WorkspaceLeaf,
} from 'obsidian';
import {
  createNote,
  folderExists,
  moveElement,
  readVault,
  writeBody,
  writeFrontmatter,
} from '../adapters/obsidian';
import {
  allViewLevels,
  type BoardColumn,
  type BoardView as BoardFilter,
  buildBoard,
  orderChildren,
} from '../core/board';
import { adrTarget, linkFolder, noteContent, noteTarget, uniqueName } from '../core/create';
import { fullDate, priorityIcon, relativeDate } from '../core/dates';
import { type DoneElement, guardMove, planDone } from '../core/done';
import type { FrontmatterChange } from '../core/frontmatter';
import type { BoardElement, ElementType, ParentRef, ProjectRoot, TaskForm } from '../core/model';
import { type Move, type MoveDirection, moveByDirection, moveToColumn } from '../core/move';
import { reorderColumn } from '../core/order';
import { linksOf, readElements } from '../core/read';
import {
  planDraftPlacement,
  planFiling,
  planRefile,
  projectRootForElement,
  type RefileEnv,
  type RefilePlan,
} from '../core/refile';
import {
  DEFAULT_TODAY_SORT,
  orderTodayTiles,
  today,
  type TodayKey,
  type TodayTile,
} from '../core/today';
import {
  type CardField,
  type Column,
  type Level,
  type LinkKind,
  type ProjectSettings,
  type ResolvedSettings,
  bottomLevel,
  canonicalStatus,
  doneStatuses as columnDoneStatuses,
  resolveCardFields,
  resolveColumns,
  resolveLevels,
  resolveProjectSettings,
  settingsFor,
  statusClosure,
  withoutHiddenProjects,
} from '../core/settings';
import type KanbanTaskManagerPlugin from '../main';
import { renderCardFace } from './cardFace';
import { CardDetail, type DraftTarget, type LinkSearchResult, type RefileRequest } from './CardDetail';

export const VIEW_TYPE_BOARD = 'ktm-board';

const ICON_PLANNED = 'calendar';
const ICON_DUE = 'flag';

const VIEW_ALL = 'all';
const VIEW_INTERNAL = 'internal';

// F010 owns creating a task; the toolbar button forwards to its command so the
// wiring is real once that command lands, and a plain pass-through until then.
const NEW_TASK_COMMAND = 'kanban-taskmanager:new-task';

// `commands`, `setting` and `internalPlugins` are part of the running app but
// not of the public typings; the board only forwards to them.
interface DesktopApp extends App {
  commands: { executeCommandById(id: string): boolean };
  setting: { open(): void };
  internalPlugins: {
    getPluginById(id: string): { instance?: { revealInFolder?(file: TAbstractFile): void } } | null;
  };
}

// Business data of a stacked draft (F053): the source card it was created
// under, whether its level lies above the source (then the source is pulled
// under the new element on close), and the child rows the draft pre-fills
// (only in the ancestor case — the source itself).
interface StackedFrom {
  source: BoardElement;
  ancestor: boolean;
  children: BoardElement[];
}

interface OpenDetail {
  detail: CardDetail;
  path: string;
  cardEl: HTMLElement;
  coverEl: HTMLElement;
  resize: ResizeObserver;
  draft: boolean;
  stackedFrom?: StackedFrom;
}

const EXPANDED_MIN_WIDTH = 720;
const EXPANDED_MARGIN = 24;
const EXPAND_DURATION = 150;
// Stacked draft (DESIGN.md .ktm-card[data-stacked], F053): 80 px narrower
// than the card beneath, offset 40/32 px right/down.
const STACK_WIDTH_INSET = 80;
const STACK_OFFSET_X = 40;
const STACK_OFFSET_Y = 32;

const ATOMIC_BASE = '_Tasks/Atomic';

// A synthetic card-id for the not-yet-written draft (003 S9): distinct from
// every real note path, so it never matches a column card (childrenOf, the
// animation's origin lookup) or an existing file. DRAFT_PRIORITY mirrors
// core/read.ts's DEFAULT_PRIORITY, so a draft closed without touching
// priority writes no field at all (008 "fields only when set").
const DRAFT_PATH = '__ktm-draft__';
const DRAFT_PRIORITY = 3;
const RECONCILE_DEBOUNCE = 250;
const NOTICE_DURATION = 15000;

const DRAG_THRESHOLD = 5;

interface DragState {
  card: HTMLElement;
  path: string;
  status: string;
  pointerId: number;
  startX: number;
  startY: number;
  grabX: number;
  grabY: number;
  active: boolean;
  ghost?: HTMLElement;
  placeholder?: HTMLElement;
  targetColumn?: HTMLElement;
  insertIndex?: number;
}

type KtmWindow = Window & { __ktmToday?: unknown };

// Production reads the local system date; the measurement pins a day via
// window.__ktmToday so the relative labels are deterministic.
function todayISO(win: Window): string {
  const override = (win as KtmWindow).__ktmToday;
  if (typeof override === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

interface BoardViewState {
  view?: string;
  level?: ElementType;
}

export class BoardView extends ItemView {
  private readonly plugin: KanbanTaskManagerPlugin;
  private view: string;
  private level: ElementType;
  private projects: ProjectSettings[] = [];
  private roots: ProjectRoot[] = [];
  private renderSeq = 0;
  private columns: Column[] = [];
  private cardFields: CardField[] = resolveCardFields();
  private doneLimit?: number;
  private today = '';
  private rendered = false;
  private drag?: DragState;
  private reconciling = false;
  private reconcileTimer?: number;
  private readonly shownNotices = new Set<string>();
  private readonly elementByPath = new Map<string, BoardElement>();
  private readonly bodyByPath = new Map<string, string>();
  private detail?: OpenDetail;
  // The dimmed, inert entry beneath a stacked draft
  // (F053); set exactly when `this.detail` currently is the draft.
  private stackedBase?: OpenDetail;

  constructor(leaf: WorkspaceLeaf, plugin: KanbanTaskManagerPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.view = plugin.settings.lastView ?? VIEW_ALL;
    this.level = plugin.settings.lastLevel ?? 'task';
  }

  getViewType(): string {
    return VIEW_TYPE_BOARD;
  }

  getDisplayText(): string {
    return 'Kanban';
  }

  getIcon(): string {
    return 'kanban-square';
  }

  getState(): Record<string, unknown> {
    return { ...super.getState(), view: this.view, level: this.level };
  }

  // Applies a state handed in through setViewState (F059, opening from the
  // ribbon or the command with an openView/openLevel default): if the view is
  // already rendered — Obsidian may call this only after onOpen's first
  // render has already drawn the constructor's defaults — the new view/level
  // is persisted as the last-used one and the board redraws (wissen #128:
  // plugin.settings must be written before render(), which reloads it from
  // disk). Arriving before the first render needs neither, that render()
  // already picks up the fields set here.
  async setState(state: BoardViewState, result: Parameters<ItemView['setState']>[1]): Promise<void> {
    const nextView = typeof state?.view === 'string' ? state.view : undefined;
    const nextLevel = state?.level;
    const changed =
      (nextView !== undefined && nextView !== this.view) ||
      (nextLevel !== undefined && nextLevel !== this.level);
    if (nextView !== undefined) this.view = nextView;
    if (nextLevel !== undefined) this.level = nextLevel;
    await super.setState(state, result);
    if (changed && this.rendered) {
      await this.plugin.saveViewState(this.view, this.level);
      await this.render();
    }
  }

  async onOpen(): Promise<void> {
    this.registerDomEvent(this.contentEl, 'pointerdown', (ev) => this.onPointerDown(ev));
    this.registerDomEvent(this.contentEl, 'pointermove', (ev) => this.onPointerMove(ev));
    this.registerDomEvent(this.contentEl, 'pointerup', (ev) => void this.onPointerUp(ev));
    this.registerDomEvent(this.contentEl, 'pointercancel', () => this.endDrag());
    // A single, permanent Escape listener instead of one per card opening
    // (F053): it always asks for the current stack top, so a stacked draft
    // never triggers a second, still-active listener on the card
    // underneath.
    this.registerDomEvent(this.contentEl.doc, 'keydown', (ev) => this.onDetailEscape(ev), true);
    this.registerEvent(
      this.app.metadataCache.on('changed', (file, _data, cache) => this.onNoteChanged(file, cache)),
    );
    this.registerEvent(this.app.vault.on('rename', () => this.scheduleReconcile()));
    this.registerEvent(this.app.vault.on('delete', () => this.scheduleReconcile()));
    await this.render();
  }

  // Public hook for a rerender driven from outside a user gesture on this
  // view: the settings tab after a toggle, and onExternalSettingsChange after
  // a data.json edit made without the UI (006 S10). render() itself is
  // private, wired to the view's own event handlers.
  async rerender(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {
    if (this.reconcileTimer !== undefined) {
      this.contentEl.win.clearTimeout(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    this.discardDetail();
  }

  // An external status edit reaches the board through the changed event, an
  // external move or delete through rename/delete. A folder move fires rename
  // once per child, so the shared debounce coalesces the burst. A change to
  // the note behind the open detail card is special-cased (K3/K4): the guard
  // in scheduleReconcile would otherwise drop it until the card closes, and a
  // followed rename reaches the open note the same way, as a rewritten
  // wikilink in its own frontmatter (alwaysUpdateLinks).
  private onNoteChanged(file: TAbstractFile, cache: CachedMetadata): void {
    if (!file.path.endsWith('.md')) return;
    if (this.detail && file.path === this.detail.path) {
      this.refreshDetailLinks(cache);
      return;
    }
    this.scheduleReconcile();
  }

  // Rereads only the free links of the open detail's own note from the fresh
  // cache and hands them to the card; no board render, so the expanded card
  // stays exactly where it is (K3/K4). Also patches the element cached in
  // elementByPath: closing and reopening the same card without an
  // intervening full render (nothing else changed, so scheduleReconcile never
  // fires) must not hand the reopened CardDetail the pre-change links again.
  private refreshDetailLinks(cache: CachedMetadata): void {
    const open = this.detail;
    if (!open) return;
    const element = this.elementByPath.get(open.path);
    const linkKinds = this.projectSettings(element?.project).linkKinds;
    const links = linksOf(cache.frontmatter ?? {}, linkKinds);
    open.detail.refreshLinks(links);
    if (element) element.links = links;
  }

  // The board's own writes echo through the same events; the reconciling guard
  // drops those, the open-detail guard keeps an edit in progress safe, and the
  // debounce lands a single reconciling render well within two seconds.
  private scheduleReconcile(): void {
    if (this.reconciling || this.detail) return;
    const win = this.contentEl.win;
    if (this.reconcileTimer !== undefined) win.clearTimeout(this.reconcileTimer);
    this.reconcileTimer = win.setTimeout(() => {
      this.reconcileTimer = undefined;
      void this.render();
    }, RECONCILE_DEBOUNCE);
  }

  private async render(): Promise<void> {
    const seq = ++this.renderSeq;
    await this.plugin.reloadSettings();
    const { entries, roots } = await readVault(this.app);
    if (seq !== this.renderSeq) return;

    const resolved = resolveProjectSettings(entries);
    // A hidden project (F085, 006 addendum 2026-09-24) is dropped from
    // this.projects (view dropdown, currentProject, projectSettings) and its
    // files from what readElements/renderToday ever see (K18-K20); the
    // settings page reads resolveProjectSettings itself and keeps it visible
    // there (K22).
    this.projects = resolved.projects.filter((p) => !p.hidden);
    const visible = withoutHiddenProjects(entries, roots, resolved.projects);
    const levelsFor = (project: string) => this.projectSettings(project).levels;
    const linkKindsFor = (project: string) => this.projectSettings(project).linkKinds;
    const elements = readElements(visible.entries, visible.roots, linkKindsFor, levelsFor);
    this.elementByPath.clear();
    for (const el of elements) this.elementByPath.set(el.paths.note, el);
    this.bodyByPath.clear();
    for (const entry of visible.entries) this.bodyByPath.set(entry.path, entry.body);
    this.roots = visible.roots;
    this.today = todayISO(this.contentEl.win);

    const reconcile = await this.reconcileDone(elements);
    if (reconcile.moved) {
      if (seq === this.renderSeq) await this.render();
      return;
    }
    if (seq !== this.renderSeq) return;

    this.normalizeView();
    const project = this.currentProject();
    // "Alle" shows the general cardFields, a project view its own override if
    // set (project undefined for both "all" and "internal"): settingsFor
    // already falls back to the general value (F058, BoardView#renderCard).
    this.cardFields = settingsFor(this.plugin.settings, project).cardFields;
    const levels = this.currentLevels(project);
    this.normalizeLevel(levels);

    this.discardDetail();
    this.contentEl.empty();
    this.contentEl.addClass('ktm-board-host');
    this.rendered = true;
    const boardEl = this.contentEl.createDiv({ cls: 'ktm-board' });
    this.renderToolbar(boardEl, levels);

    if (project && !folderExists(this.app, project.root)) {
      this.renderError(boardEl, project.root);
      return;
    }

    this.columns = resolveColumns(this.plugin.settings, project);
    this.doneLimit = settingsFor(this.plugin.settings, project).doneLimit;
    const board = buildBoard(elements, this.filter(), this.columns, {
      level: this.level,
      bottomLevel: bottomLevel(levels)?.key,
      doneLimit: this.doneLimit,
    });
    this.showNotices([...resolved.notices, ...board.notices, ...reconcile.notices]);

    this.renderToday(boardEl, elements);

    const columnsEl = boardEl.createDiv({ cls: 'ktm-columns' });
    for (const column of board.columns) {
      this.renderColumn(columnsEl, column, this.today);
    }
  }

  // Each distinct notice is surfaced once per view session; re-renders from the
  // debounced reconcile do not re-toast an issue that is still there.
  private showNotices(messages: string[]): void {
    for (const message of messages) {
      if (this.shownNotices.has(message)) continue;
      this.shownNotices.add(message);
      new Notice(message, NOTICE_DURATION);
    }
  }

  // The shared fault-handling for a write to the vault (008 S46, F068 K1):
  // `fn` runs, a thrown error surfaces as a Notice naming the action and the
  // path, and the board is always redrawn afterwards so it shows the vault's
  // real state — the write may have partially landed, or not at all. `path`
  // may be a getter instead of a fixed string for a loop that writes several
  // files (applyReorder): it is read only once `fn` has actually thrown, by
  // which point the caller has updated it to the entry that failed.
  private async persist(
    action: string,
    path: string | (() => string),
    fn: () => Promise<void>,
  ): Promise<boolean> {
    let ok = true;
    try {
      await fn();
    } catch (err) {
      ok = false;
      this.failureNotice(action, typeof path === 'function' ? path() : path, errorMessage(err));
    }
    await this.render();
    return ok;
  }

  private failureNotice(action: string, path: string, reason: string): void {
    new Notice(`${action} fehlgeschlagen: ${path} (${reason})`, NOTICE_DURATION);
  }

  // A note whose `status` is an old alias (an old column name that survives
  // only as an alias, 008 S43) gets rewritten to the reserved key it stands
  // for the next time the board writes anything on it — unless this very
  // change already sets `status` itself.
  private withCanonicalStatus(
    element: BoardElement | undefined,
    change: FrontmatterChange,
  ): FrontmatterChange {
    if (!element || 'status' in change) return change;
    const project = element.project ? this.projects.find((p) => p.key === element.project) : undefined;
    const columns = resolveColumns(this.plugin.settings, project);
    const canonical = canonicalStatus(element.status, columns);
    return canonical ? { ...change, status: canonical } : change;
  }

  // Re-parents an already-open detail overlay (cardEl, coverEl, and the
  // dimmed stacked base beneath it, if any) onto the freshly rendered board
  // after a failed write (008 S45/S46, F068 K1/K2): the CardDetail instance
  // and its unsaved edits are kept as they are, only their DOM host moves.
  // `base` is only ever passed by closeDraft, after render() has run with
  // `this.stackedBase` already cleared (so discardDetail() left it alone).
  private reattachDetail(open: OpenDetail, base?: OpenDetail): void {
    const boardEl = this.contentEl.querySelector<HTMLElement>('.ktm-board');
    if (!boardEl) return;
    boardEl.appendChild(open.coverEl);
    if (base) {
      boardEl.appendChild(base.cardEl);
      this.stackedBase = base;
    }
    boardEl.appendChild(open.cardEl);
    open.resize.disconnect();
    const win = this.contentEl.win as Window & { ResizeObserver: typeof ResizeObserver };
    const resize = new win.ResizeObserver(() => {
      if (open.cardEl.getAttribute('data-expanded') === 'true') {
        open.cardEl.style.width = `${this.expandedWidth(boardEl, !!open.stackedFrom)}px`;
      }
    });
    resize.observe(boardEl);
    this.detail = { ...open, resize };
  }

  private renderError(parent: HTMLElement, rootPath: string): void {
    const wrap = parent.createDiv({ cls: 'ktm-error-wrap' });
    const card = wrap.createDiv({ cls: 'ktm-card ktm-error', attr: { 'data-error': 'true' } });
    card.createDiv({ cls: 'ktm-card-title', text: 'Root-Ordner nicht gefunden' });
    const paragraph = card.createEl('p');
    paragraph.appendText('Der Pfad ');
    paragraph.createEl('code', { text: rootPath });
    paragraph.appendText(' aus der Projektnotiz existiert im Vault nicht.');
    const button = card.createEl('button', { cls: 'ktm-button', text: 'Einstellungen öffnen' });
    this.registerDomEvent(button, 'click', () => {
      (this.app as DesktopApp).setting.open();
    });
  }

  // Keeps every element's folder location in step with its status, no matter
  // who set it: a done element pulls into the Done mirror, an open one pulls
  // back, and a container follows only once all its descendants are done. Runs
  // on each read and on the debounced changed event, so an external edit lands
  // within two seconds. Returns whether anything moved, so the caller re-reads
  // the vault with the fresh paths before drawing, plus the notices for the
  // locks it hit (open descendant, still-done ancestor) and for any move the
  // plan could not carry out (a colliding target, 008 S47, F068 K3): that one
  // move is skipped and reported, the rest of the plan still runs, and
  // `moved` counts only the ones that actually succeeded, so a plan that only
  // ever fails does not send render() into an endless retry loop.
  private async reconcileDone(elements: BoardElement[]): Promise<{ moved: boolean; notices: string[] }> {
    this.reconciling = true;
    try {
      const plan = planDone(
        elements.map((el) => this.doneElement(el)),
        this.today,
      );
      const notices = [...plan.notices];
      let moved = false;
      for (const move of plan.moves) {
        try {
          await moveElement(this.app, move.from, move.to, move.parent);
          if (move.frontmatter) await writeFrontmatter(this.app, move.toNotePath, move.frontmatter);
          moved = true;
        } catch (err) {
          notices.push(`Umzug übersprungen: ${move.from} → ${move.to} (${errorMessage(err)})`);
        }
      }
      return { moved, notices };
    } finally {
      this.reconciling = false;
    }
  }

  // The Done reconciliation (planDone) keys "closed" off the status itself
  // (F066): done/wont-do always close, an invalid element (status '') or an
  // unknown status stays undefined and is left alone. guardMove and the drop
  // path keep using doneStatuses(), which stays column-based (#479).
  private doneElement(el: BoardElement): DoneElement {
    const base = el.form === 'atomic' ? ATOMIC_BASE : matchRoot(el.paths.note, this.roots);
    return {
      form: el.form,
      notePath: el.paths.note,
      folderPath: el.paths.folder,
      base: base ?? '',
      done: el.invalid
        ? undefined
        : statusClosure(
            el.status,
            resolveColumns(
              this.plugin.settings,
              el.project ? this.projects.find((p) => p.key === el.project) : undefined,
            ),
          ),
      completed: el.completed,
      type: el.type,
      title: el.title,
      parentNote: el.parents[0]?.note,
    };
  }

  private doneStatuses(project?: string): Set<string> {
    const settings = project ? this.projects.find((p) => p.key === project) : undefined;
    const columns = resolveColumns(this.plugin.settings, settings);
    return columnDoneStatuses(columns);
  }

  private normalizeView(): void {
    if (this.view === VIEW_ALL || this.view === VIEW_INTERNAL) return;
    if (!this.projects.some((p) => p.key === this.view)) this.view = VIEW_ALL;
  }

  private currentProject(): ProjectSettings | undefined {
    return this.projects.find((p) => p.key === this.view);
  }

  private filter(): BoardFilter {
    if (this.view === VIEW_ALL) return { kind: 'all' };
    if (this.view === VIEW_INTERNAL) return { kind: 'internal' };
    return { kind: 'project', project: this.view };
  }

  // The levels the level switcher offers for the view currently shown: a
  // project view's own levels, the general list otherwise, narrowed by
  // `allLevels` (009 addendum 2026-09-20, wissen #518/#128: read on every
  // render so an external data.json edit lands within K5's two seconds).
  private currentLevels(project: ProjectSettings | undefined): Level[] {
    if (project) return this.projectSettings(project.key).levels;
    return allViewLevels(this.plugin.settings.allLevels ?? 'rank', resolveLevels(this.plugin.settings));
  }

  // A level persisted from another view (#552) or one a config edit dropped
  // (K5) must not point past the current view's levels; falls back to the
  // bottom one, the switcher's default (S1).
  private normalizeLevel(levels: Level[]): void {
    if (levels.length === 0 || levels.some((l) => l.key === this.level)) return;
    this.level = levels[levels.length - 1].key;
  }

  private renderToolbar(parent: HTMLElement, levels: Level[]): void {
    const toolbar = parent.createDiv({ cls: 'ktm-toolbar' });

    const newTask = toolbar.createEl('button', { cls: 'ktm-button ktm-new-task' });
    setIcon(newTask.createSpan({ cls: 'ktm-button-icon' }), 'plus');
    newTask.createSpan({ text: 'Neue Aufgabe' });
    this.registerDomEvent(newTask, 'click', () => {
      (this.app as DesktopApp).commands.executeCommandById(NEW_TASK_COMMAND);
    });

    toolbar.createDiv({ cls: 'ktm-toolbar-spacer' });

    const controls = toolbar.createDiv({ cls: 'ktm-toolbar-controls' });
    this.renderLevelSegment(controls, levels);
    this.renderViewDropdown(controls);
  }

  // Segments from the view's own level list, bottom first, labelled with the
  // German lending-word plural (name + "s", unless it already ends in one);
  // `allLevels: 'bottom'` yields an empty list and no switcher at all (009
  // addendum 2026-09-20).
  private renderLevelSegment(parent: HTMLElement, levels: Level[]): void {
    if (levels.length === 0) return;
    const segment = parent.createDiv({ cls: 'ktm-level-segment' });
    for (let i = levels.length - 1; i >= 0; i--) {
      const level = levels[i];
      const button = segment.createEl('button', {
        cls: 'ktm-level-button',
        text: levelPlural(level.name),
        attr: { 'data-level': level.key, 'data-active': String(level.key === this.level) },
      });
      this.registerDomEvent(button, 'click', () => {
        if (this.level === level.key) return;
        this.level = level.key;
        void this.applyState();
      });
    }
  }

  private renderViewDropdown(parent: HTMLElement): void {
    const dropdown = new DropdownComponent(parent);
    dropdown.selectEl.addClass('ktm-view-select');
    dropdown.addOption(VIEW_ALL, 'Alle Aufgaben');
    dropdown.addOption(VIEW_INTERNAL, 'Intern');
    for (const project of this.projects) dropdown.addOption(project.key, project.name);
    dropdown.setValue(this.view);
    dropdown.onChange((value) => {
      this.view = value;
      void this.applyState();
    });
  }

  private async applyState(): Promise<void> {
    await this.plugin.saveViewState(this.view, this.level);
    await this.render();
  }

  // The "Heute" area above the columns: open tasks planned for today and open
  // overdue tasks, across every project and level, rendered as one wrapping tile
  // grid ordered by the configured key sequence (F020). It grows downward from
  // the toolbar and pushes the columns down. With nothing to report it folds to
  // its header showing "nichts anliegend"; with content it honours the manual
  // collapse state remembered per view.
  private renderToday(parent: HTMLElement, elements: BoardElement[]): void {
    const notifyPlanned = this.plugin.settings.notifyPlanned ?? true;
    const { overdue, planned } = today(
      elements,
      this.today,
      (task) => this.doneStatuses(task.project).has(task.status),
      notifyPlanned,
      (project) => this.projectSettings(project).levels,
    );
    const tiles: TodayTile[] = [
      ...overdue.map((el) => ({ element: el, kind: 'overdue' as const, date: el.due ?? '' })),
      ...planned.map((el) => ({ element: el, kind: 'planned' as const, date: el.planned ?? '' })),
    ];
    const hasContent = tiles.length > 0;
    const collapsed = hasContent ? this.plugin.isTodayCollapsed(this.view) : true;
    const area = parent.createDiv({ cls: 'ktm-today', attr: { 'data-collapsed': String(collapsed) } });
    this.renderTodayHeader(area, overdue.length, planned.length, hasContent, collapsed);
    if (collapsed) return;
    const ordered = orderTodayTiles(tiles, this.todaySortOrder(), this.projectOrder());
    const body = area.createDiv({ cls: 'ktm-today-body' });
    for (const tile of ordered) this.renderTodayTile(body, tile);
  }

  private todaySortOrder(): TodayKey[] {
    return this.plugin.settings.todaySortOrder ?? DEFAULT_TODAY_SORT;
  }

  private projectOrder(): string[] {
    return this.projects.map((p) => p.key);
  }

  private renderTodayHeader(
    area: HTMLElement,
    overdue: number,
    planned: number,
    hasContent: boolean,
    collapsed: boolean,
  ): void {
    const header = area.createDiv({ cls: 'ktm-today-header' });
    const toggle = header.createSpan({ cls: 'ktm-today-toggle' });
    setIcon(toggle, collapsed ? 'chevron-right' : 'chevron-down');
    header.createSpan({ cls: 'ktm-today-title', text: 'Heute' });
    if (hasContent) {
      if (overdue > 0) this.renderTodayCount(header, 'overdue', ICON_DUE, `${overdue} überfällig`);
      if (planned > 0) this.renderTodayCount(header, 'planned', ICON_PLANNED, `${planned} heute geplant`);
    } else {
      header.createSpan({ cls: 'ktm-today-none', text: 'nichts anliegend' });
    }
    header.createSpan({ cls: 'ktm-today-spacer' });
    header.createSpan({ cls: 'ktm-today-date', text: fullDate(this.today) });

    if (!hasContent) return;
    if (collapsed) {
      this.registerDomEvent(header, 'click', () => void this.toggleTodayCollapsed());
    } else {
      this.registerDomEvent(toggle, 'click', () => void this.toggleTodayCollapsed());
    }
  }

  private async toggleTodayCollapsed(): Promise<void> {
    await this.plugin.toggleCollapsedToday(this.view);
    await this.render();
  }

  private renderTodayCount(parent: HTMLElement, signal: string, icon: string, label: string): void {
    const count = parent.createSpan({ cls: 'ktm-today-count', attr: { 'data-signal': signal } });
    setIcon(count.createSpan({ cls: 'ktm-today-count-icon' }), icon);
    count.createSpan({ text: label });
  }

  private renderTodayTile(parent: HTMLElement, tile: TodayTile): void {
    const card = tile.element;
    const item = parent.createDiv({
      cls: 'ktm-today-item',
      attr: { 'data-card-id': card.paths.note, 'data-priority': String(card.priority), tabindex: '0' },
    });
    item.createDiv({ cls: 'ktm-today-item-title', attr: { title: card.title }, text: card.title });

    const meta = item.createDiv({ cls: 'ktm-today-item-meta' });
    const dateEl = meta.createSpan({
      cls: 'ktm-today-date-signal',
      attr: { 'data-signal': tile.kind === 'overdue' ? 'overdue' : 'today' },
    });
    setIcon(
      dateEl.createSpan({ cls: 'ktm-today-item-icon' }),
      tile.kind === 'overdue' ? ICON_DUE : ICON_PLANNED,
    );
    dateEl.createSpan({ text: relativeDate(tile.date, this.today) });

    if (card.project) {
      meta.createSpan({ cls: 'ktm-today-chip', text: card.project });
    }
    const icon = priorityIcon(card.priority);
    if (icon) {
      const prio = meta.createSpan({
        cls: 'ktm-today-priority',
        attr: { 'data-priority': String(card.priority) },
      });
      setIcon(prio, icon);
    }

    this.registerDomEvent(item, 'click', () => void this.openTodayTask(card.paths.note));
  }

  // A tile click opens the task's detail. When the task lies outside the current
  // view or level, the board first switches to a view and level that show it,
  // then expands the card (S5, K9).
  private async openTodayTask(path: string): Promise<void> {
    const element = this.elementByPath.get(path);
    if (!element) return;
    const visible = this.isVisibleInCurrentView(element);
    // A Heute tile is always at its project's bottom level (today(), F072
    // S22), so switching to its own type is switching to the bottom level.
    if (!visible || this.level !== element.type) {
      this.view = visible ? this.view : element.project ?? VIEW_INTERNAL;
      this.level = element.type;
      await this.plugin.saveViewState(this.view, this.level);
      await this.render();
    }
    const fresh = this.elementByPath.get(path) ?? element;
    await this.openDetail(fresh);
  }

  private isVisibleInCurrentView(el: BoardElement): boolean {
    if (this.view === VIEW_ALL) return true;
    if (this.view === VIEW_INTERNAL) return !el.project;
    return el.project === this.view;
  }

  // Entry point of the "Neue Aufgabe" command and toolbar button: an element
  // at the current project's bottom level (F072 S22), first column's status,
  // with the view's opening default (003 S13).
  startCreate(): void {
    this.openDraft(this.draftLevel(), this.defaultStatus());
  }

  private draftLevel(): ElementType {
    const project = this.currentProject();
    const levels = project ? this.projectSettings(project.key).levels : resolveLevels(this.plugin.settings);
    // Never empty: project.levels is only ever set non-empty (parseLevelList),
    // and resolveLevels falls back to DEFAULT_LEVELS otherwise.
    return bottomLevel(levels)!.key;
  }

  // Opens the enlarged card as a draft instead of a modal (addendum
  // 2026-09-14, 003 S9): a synthetic, unsaved BoardElement with the opening
  // default for the current view, no paths. The note is written only when the
  // card closes with a title (closeDetail/writeDraft). The `parent` param is
  // unused since the children plus fell to F051 (no in-app caller left); the
  // popover-driven "Neu anlegen: <Ebene>" (008 addendum 2026-09-20, S39)
  // needs a stacked draft above the open card instead of in its place
  // and therefore goes through openStackedDraft (F053).
  private openDraft(type: ElementType, status: string, parent?: BoardElement): void {
    const defaults = parent
      ? { form: 'nested' as TaskForm, project: parent.project }
      : this.draftDefaults();
    const element: BoardElement = {
      type,
      form: defaults.form,
      title: '',
      status,
      project: defaults.project,
      priority: DRAFT_PRIORITY,
      tags: [],
      parents: parent ? [{ type: parent.type, title: parent.title, note: parent.paths.note }] : [],
      links: [],
      paths: { note: DRAFT_PATH },
    };
    void this.openDetail(element, true);
  }

  // The draft's opening filing target follows the current view (addendum
  // 2026-09-14): a project view files it under that project's root — an
  // empty parentLabel with the project key resolves to that root (F072 S21,
  // resolveParentTarget), no longer a match against the project's display
  // name; "all" and "internal" leave it atomic without a project — the
  // intern chip on the card is a display fallback (wissen #390), not a
  // stored field (#477).
  private draftDefaults(): { form: TaskForm; project?: string; parentLabel: string } {
    const project = this.currentProject();
    if (project) {
      return { form: 'nested', project: project.key, parentLabel: '' };
    }
    return { form: 'atomic', parentLabel: 'Atomar' };
  }

  private defaultStatus(): string {
    return this.columns[0]?.status ?? 'backlog';
  }

  // "Neu anlegen: <Ebene>" from the link menu (008 addendum
  // 2026-09-20 S37/S39, F053): a stacked draft above the open
  // source card, status of the first column, project inherited from the
  // source via refile (no project field, wissen #390/#477). On a level above
  // the source (`ancestor`) the draft inherits the source's ancestor that lies
  // above this new level, and shows the source itself as a child row; on
  // a level below it, the source becomes the draft's parent — refile alone
  // already places the new note correctly then (no refile needed, unlike
  // the ancestor case, see closeDetail/applyStackedRefile).
  private openStackedDraft(
    level: ElementType,
    ancestor: boolean,
    title: string,
    source: BoardElement,
  ): void {
    const levels = this.projectSettings(source.project).levels;
    const levelIndex = levels.findIndex((l) => l.key === level);
    let parents: ParentRef[] = [];
    let children: BoardElement[] = [];
    if (ancestor) {
      const inherited = source.parents.find((p) => {
        const idx = levels.findIndex((l) => l.key === p.type);
        return idx !== -1 && idx < levelIndex;
      });
      if (inherited) parents = [inherited];
      children = [source];
    } else {
      parents = [{ type: source.type, title: source.title, note: source.paths.note }];
    }
    const element: BoardElement = {
      type: level,
      form: 'nested',
      title,
      status: this.defaultStatus(),
      project: source.project,
      priority: DRAFT_PRIORITY,
      tags: [],
      parents,
      links: [],
      paths: { note: DRAFT_PATH },
    };
    void this.openDetail(element, true, { source, ancestor, children });
  }

  // Pulls the source card of an ancestor stack (F053, K1/K2) under the just
  // created element, via the same planRefile/moveElement path as a
  // cross on a link row; on a level below (K3) the new note already sits
  // correctly, there is nothing to move. Returns the path under which
  // the source is to be reopened after closing.
  private async applyStackedRefile(from: StackedFrom, createdPath: string): Promise<string> {
    const source = from.source;
    if (!from.ancestor || !source.paths.folder) return source.paths.note;
    const newFolder = dirOf(createdPath);
    const plan = planRefile(
      { form: source.form, type: source.type, notePath: source.paths.note, folderPath: source.paths.folder },
      { parentFolder: newFolder },
      this.childrenOf(source),
      this.siblingNames(newFolder),
    );
    if (plan.move) await moveElement(this.app, plan.move.from, plan.move.to, plan.move.parent);
    return plan.notePath;
  }

  private renderColumn(parent: HTMLElement, column: BoardColumn, today: string): void {
    const collapsed = this.plugin.isColumnCollapsed(this.view, column.status);
    const columnEl = parent.createDiv({
      cls: 'ktm-column',
      attr: {
        'data-status': column.status,
        'data-collapsed': String(collapsed),
        ...(column.unknown ? { 'data-unknown': 'true' } : {}),
      },
    });

    const header = columnEl.createDiv({ cls: 'ktm-column-header' });
    const toggle = header.createSpan({ cls: 'ktm-column-toggle' });
    setIcon(toggle, collapsed ? 'chevron-right' : 'chevron-down');
    header.createSpan({ cls: 'ktm-column-title', text: column.name });
    header.createSpan({ cls: 'ktm-column-count', text: String(column.total) });

    if (collapsed) {
      this.registerDomEvent(header, 'click', () => void this.toggleCollapsed(column.status));
      return;
    }
    this.registerDomEvent(toggle, 'click', () => void this.toggleCollapsed(column.status));

    if (!column.unknown) {
      const add = header.createSpan({ cls: 'ktm-column-add', attr: { 'aria-label': 'Neue Karte' } });
      setIcon(add, 'plus');
      this.registerDomEvent(add, 'click', (ev) => {
        ev.stopPropagation();
        this.openDraft(this.level, column.status);
      });
    }

    const body = columnEl.createDiv({ cls: 'ktm-column-body' });
    if (column.cards.length === 0) {
      body.createDiv({ cls: 'ktm-empty' });
      return;
    }
    for (const card of column.cards) {
      this.renderCard(body, card, column.done, today);
    }
  }

  private async toggleCollapsed(status: string): Promise<void> {
    await this.plugin.toggleCollapsedColumn(this.view, status);
    await this.render();
  }

  private renderCard(parent: HTMLElement, card: BoardElement, done: boolean, today: string): void {
    if (card.invalid) {
      this.renderInvalidCard(parent, card);
      return;
    }

    const cardEl = parent.createDiv({
      cls: 'ktm-card',
      attr: {
        'data-status': card.status,
        'data-card-id': card.paths.note,
        'data-priority': String(card.priority),
        tabindex: '0',
        ...(done ? { 'data-done': 'true' } : {}),
      },
    });

    const showProject = this.view === VIEW_ALL && this.cardFields.includes('project');
    const ancestors = this.cardFields.includes('parents') ? this.ancestorChips(card) : [];
    renderCardFace(cardEl, card, this.cardFields, today, done, showProject, ancestors);
  }

  private renderInvalidCard(parent: HTMLElement, card: BoardElement): void {
    const cardEl = parent.createDiv({
      cls: 'ktm-card',
      attr: { 'data-invalid': 'true', 'data-card-id': card.paths.note, tabindex: '0' },
    });
    const titleRow = cardEl.createDiv({ cls: 'ktm-card-titlerow', attr: { title: card.title } });
    titleRow.createSpan({ cls: 'ktm-card-title', text: card.title });
    const meta = cardEl.createDiv({ cls: 'ktm-card-meta' });
    meta.createSpan({ text: 'ungültig' });
  }

  // One chip per level above the card's own on which it has an ancestor, top
  // to bottom (Epic before Feature before User Story, 009 addendum
  // 2026-09-20): icon from the card's own project's level list, so a chip
  // still resolves right in the "all" view where that can differ from the
  // levels shown. A missing ancestor on some intermediate level yields no
  // chip for it, not a gap that shifts the rest.
  private ancestorChips(
    card: BoardElement,
  ): { icon: string; title: string; levelName: string; fullTitle: string }[] {
    const settings = this.projectSettings(card.project);
    const levels = settings.levels;
    const parentByType = new Map(card.parents.map((p) => [p.type, p]));
    const ownIndex = levels.findIndex((l) => l.key === card.type);
    const above = ownIndex === -1 ? levels.length : ownIndex;
    const chips: { icon: string; title: string; levelName: string; fullTitle: string }[] = [];
    for (let i = 0; i < above; i++) {
      const level = levels[i];
      if (!level) continue;
      const ancestor = parentByType.get(level.key);
      if (ancestor) {
        chips.push({
          icon: level.icon,
          title: settings.shortInChips ? (ancestor.short ?? ancestor.title) : ancestor.title,
          levelName: level.name,
          fullTitle: ancestor.title,
        });
      }
    }
    return chips;
  }

  async moveFocusedCard(direction: MoveDirection): Promise<void> {
    const active = this.contentEl.doc.activeElement;
    const card = active instanceof HTMLElement ? active.closest('.ktm-card') : null;
    if (!(card instanceof HTMLElement)) return;
    const { cardId, status } = card.dataset;
    if (!cardId || status === undefined) return;
    await this.applyMove(cardId, moveByDirection(status, direction, this.columns, this.today));
  }

  private async applyMove(path: string, move: Move | null): Promise<void> {
    if (!move) return;
    const element = this.elementByPath.get(path);
    if (element) {
      const targetDone = this.doneStatuses(element.project).has(move.targetStatus);
      const blocked = guardMove(
        this.doneElement(element),
        targetDone,
        [...this.elementByPath.values()].map((el) => this.doneElement(el)),
      );
      if (blocked) {
        new Notice(blocked, NOTICE_DURATION);
        return;
      }
    }
    const change = this.withCanonicalStatus(element, move.change);
    const ok = await this.persist('Verschieben', path, () => writeFrontmatter(this.app, path, change));
    if (ok) this.focusCard(path);
  }

  private focusCard(path: string): void {
    const el = this.contentEl.querySelector(`.ktm-card[data-card-id="${path}"]`);
    if (el instanceof HTMLElement) el.focus();
  }

  private onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const card = ev.target instanceof Element ? ev.target.closest('.ktm-card') : null;
    if (!(card instanceof HTMLElement) || !card.closest('.ktm-columns')) return;
    if (card.closest('.ktm-column[data-unknown="true"]')) return;
    const { cardId, status } = card.dataset;
    if (!cardId || status === undefined) return;
    const rect = card.getBoundingClientRect();
    this.drag = {
      card,
      path: cardId,
      status,
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      grabX: ev.clientX - rect.left,
      grabY: ev.clientY - rect.top,
      active: false,
    };
  }

  private onPointerMove(ev: PointerEvent): void {
    const drag = this.drag;
    if (!drag || ev.pointerId !== drag.pointerId) return;

    if (!drag.active) {
      if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < DRAG_THRESHOLD) return;
      this.startDrag(drag);
    }

    if (drag.ghost) {
      drag.ghost.style.left = `${ev.clientX - drag.grabX}px`;
      drag.ghost.style.top = `${ev.clientY - drag.grabY}px`;
    }
    this.updateDropTarget(drag, ev.clientX, ev.clientY);
  }

  private startDrag(drag: DragState): void {
    const doc = this.contentEl.doc;
    const rect = drag.card.getBoundingClientRect();

    const ghost = drag.card.cloneNode(true) as HTMLElement;
    ghost.addClass('ktm-drag-ghost');
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    doc.body.appendChild(ghost);

    const placeholder = doc.createElement('div');
    placeholder.addClass('ktm-drop-placeholder');
    placeholder.style.height = `${rect.height}px`;

    drag.card.setAttribute('data-dragging', 'true');
    drag.active = true;
    drag.ghost = ghost;
    drag.placeholder = placeholder;
  }

  // Recomputes on every move, not only on a column change: within the same
  // column the insertion point still shifts with the pointer. The placeholder
  // sits before the card whose vertical centre lies below the pointer
  // (DESIGN.md §Zustaende), and that card's index among the column's other,
  // non-invalid cards is remembered as the drop's insertIndex.
  private updateDropTarget(drag: DragState, x: number, y: number): void {
    const column = this.columnAt(x, y);
    if (column !== drag.targetColumn) {
      drag.targetColumn?.removeAttribute('data-drop-target');
      drag.targetColumn = column ?? undefined;
      if (column) column.setAttribute('data-drop-target', 'true');
    }
    if (!column || !drag.placeholder) {
      drag.insertIndex = undefined;
      return;
    }
    const body = column.querySelector('.ktm-column-body');
    if (!body) return;
    const cards = [
      ...body.querySelectorAll<HTMLElement>('.ktm-card:not([data-dragging]):not([data-invalid])'),
    ];
    let index = cards.length;
    let before: HTMLElement | undefined;
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        index = i;
        before = cards[i];
        break;
      }
    }
    drag.insertIndex = index;
    if (before) body.insertBefore(drag.placeholder, before);
    else body.appendChild(drag.placeholder);
  }

  private columnAt(x: number, y: number): HTMLElement | null {
    const el = this.contentEl.doc.elementFromPoint(x, y);
    const column = el instanceof Element ? el.closest('.ktm-column') : null;
    return column instanceof HTMLElement ? column : null;
  }

  private async onPointerUp(ev: PointerEvent): Promise<void> {
    const drag = this.drag;
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const targetStatus = this.columnAt(ev.clientX, ev.clientY)?.dataset.status;
    const insertIndex = drag.insertIndex ?? 0;
    const wasActive = drag.active;
    this.endDrag();
    if (!wasActive) {
      const element = this.elementByPath.get(drag.path);
      if (element) await this.openDetail(element);
      return;
    }
    if (targetStatus === undefined) return;
    await this.applyReorder(drag.path, drag.status, targetStatus, insertIndex);
  }

  // A drop within a column or positioned into another one (003 addendum,
  // S16/S19): resolves the target column's cards from buildBoard/resolveColumns
  // rather than the rendered DOM (#460, the "all" view's extra unknown-status
  // column), derives the order writes via reorderColumn, and — on a column
  // change — folds the status/completed change into the same write as the
  // dragged card's new order, guarded exactly like applyMove.
  private async applyReorder(
    path: string,
    fromStatus: string,
    toStatus: string,
    insertIndex: number,
  ): Promise<void> {
    const element = this.elementByPath.get(path);
    if (!element) return;

    let statusChange: FrontmatterChange = {};
    if (toStatus !== fromStatus) {
      const move = moveToColumn(fromStatus, toStatus, this.columns, this.today);
      if (!move) return;
      const targetDone = this.doneStatuses(element.project).has(move.targetStatus);
      const blocked = guardMove(
        this.doneElement(element),
        targetDone,
        [...this.elementByPath.values()].map((el) => this.doneElement(el)),
      );
      if (blocked) {
        new Notice(blocked, NOTICE_DURATION);
        return;
      }
      statusChange = move.change;
    }

    const board = buildBoard([...this.elementByPath.values()], this.filter(), this.columns, {
      level: this.level,
      doneLimit: this.doneLimit,
    });
    const column = board.columns.find((c) => c.status === toStatus);
    if (!column) return;
    const cards = column.cards
      .filter((c) => !c.invalid)
      .map((c) => ({ path: c.paths.note, order: c.order }));

    const changes = reorderColumn(cards, path, insertIndex);
    let failedPath = path;
    const ok = await this.persist('Verschieben', () => failedPath, async () => {
      for (const change of changes) {
        failedPath = change.path;
        const frontmatter: FrontmatterChange =
          change.path === path
            ? this.withCanonicalStatus(element, { ...statusChange, order: String(change.order) })
            : { order: String(change.order) };
        await writeFrontmatter(this.app, change.path, frontmatter);
      }
    });

    if (ok) this.focusCard(path);
  }

  private endDrag(): void {
    const drag = this.drag;
    this.drag = undefined;
    if (!drag) return;
    drag.ghost?.remove();
    drag.placeholder?.remove();
    drag.targetColumn?.removeAttribute('data-drop-target');
    drag.card.removeAttribute('data-dragging');
  }

  // Grows the clicked card into the centered detail overlay. Closes any card
  // already open first, so at most one is expanded at a time. `draft` marks an
  // draft opened from a column's plus or "Neue Aufgabe" (openDraft): no file
  // exists yet, so no origin card sits on the board for the open animation,
  // and closing writes a new note instead of editing one (closeDetail).
  // `stackedFrom` marks a stacked draft (F053, openStackedDraft): the
  // card already open (`this.detail`) is dimmed as the stack's base instead of
  // being closed, and the new card layers on top without a growth animation
  // (no reference image for that, "ausserhalb").
  private async openDetail(
    element: BoardElement,
    draft = false,
    stackedFrom?: StackedFrom,
  ): Promise<void> {
    if (!stackedFrom) await this.closeDetail();
    const boardEl = this.contentEl.querySelector<HTMLElement>('.ktm-board');
    if (!boardEl) return;

    const base = stackedFrom ? this.detail : undefined;
    if (stackedFrom && !base) return;
    if (base) {
      this.stackedBase = base;
      base.cardEl.setAttribute('data-stacked', 'under');
    }

    const coverEl = base ? base.coverEl : boardEl.createDiv({ cls: 'ktm-cover' });
    const cardEl = boardEl.createDiv({
      cls: 'ktm-card ktm-expanded',
      attr: {
        'data-status': element.status,
        'data-card-id': element.paths.note,
        ...(draft ? { 'data-draft': 'true' } : {}),
        ...(stackedFrom ? { 'data-stacked': 'over' } : {}),
      },
    });

    const detail = new CardDetail(
      this.app,
      cardEl,
      element,
      this.columns,
      this.today,
      {
        close: () => void this.closeDetail(),
        openNote: (path) => void this.openNote(path),
        revealFolder: (path) => void this.revealFolder(path),
        openChild: (el) => void this.openDetail(el),
        openLink: (target) => void this.openLink(target, element.paths.note),
        createLinkNote: (kind, title) => this.createLinkNote(element, kind, title),
        searchElements: (level, query) => this.searchElements(level, element, query),
        createStackedElement: (level, ancestor, title) =>
          this.openStackedDraft(level, ancestor, title, element),
      },
      {
        projects: this.projects.map((p) => p.key),
        levels: this.projectSettings(element.project).levels,
        linkKinds: this.projectSettings(element.project).linkKinds,
        vaultTags: this.vaultTags(),
      },
      stackedFrom ? stackedFrom.children : this.childrenOf(element),
      draft,
    );
    this.addChild(detail);
    detail.setBody(this.bodyByPath.get(element.paths.note) ?? '');

    if (!base) this.registerDomEvent(coverEl, 'click', (ev) => this.onCoverClick(ev));

    // The detail width scales with the board (DESIGN.md); a board that resizes
    // after the card has grown resizes the card too, not just the layout behind.
    const win = this.contentEl.win as Window & { ResizeObserver: typeof ResizeObserver };
    const resize = new win.ResizeObserver(() => {
      if (cardEl.getAttribute('data-expanded') === 'true') {
        cardEl.style.width = `${this.expandedWidth(boardEl, !!stackedFrom)}px`;
      }
    });
    resize.observe(boardEl);

    this.detail = { detail, path: element.paths.note, cardEl, coverEl, resize, draft, stackedFrom };

    if (stackedFrom) {
      cardEl.style.width = `${this.expandedWidth(boardEl, true)}px`;
      this.finalizeOpen(cardEl, true);
    } else {
      this.animateOpen(boardEl, cardEl, element.paths.note);
    }
  }

  private animateOpen(boardEl: HTMLElement, cardEl: HTMLElement, path: string): void {
    const finalWidth = this.expandedWidth(boardEl);
    cardEl.style.width = `${finalWidth}px`;

    const origin = this.contentEl.querySelector<HTMLElement>(
      `.ktm-columns .ktm-card[data-card-id="${path}"]`,
    );
    const reduced = this.contentEl.win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!origin || reduced) {
      this.finalizeOpen(cardEl);
      return;
    }

    const boardRect = boardEl.getBoundingClientRect();
    const rect = origin.getBoundingClientRect();
    cardEl.style.left = `${rect.left - boardRect.left}px`;
    cardEl.style.top = `${rect.top - boardRect.top}px`;
    cardEl.style.width = `${rect.width}px`;
    cardEl.style.height = `${rect.height}px`;

    cardEl.addClass('ktm-expanding');
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      cardEl.removeClass('ktm-expanding');
      // A backgrounded window throttles requestAnimationFrame (#705); the
      // timeout path below reaches here without it ever having applied
      // finalWidth, so the card would freeze at the origin's column width.
      cardEl.style.width = `${finalWidth}px`;
      this.finalizeOpen(cardEl);
    };
    this.registerDomEvent(cardEl, 'transitionend', finish);
    this.contentEl.win.setTimeout(finish, EXPAND_DURATION + 60);

    this.contentEl.win.requestAnimationFrame(() => {
      cardEl.style.left = '50%';
      cardEl.style.top = '50%';
      cardEl.style.transform = 'translate(-50%, -50%)';
      cardEl.style.width = `${finalWidth}px`;
      cardEl.style.height = '';
    });
  }

  // `stackedOver` offsets the draft 40/32 px right/down relative to
  // the centered card beneath (DESIGN.md Gestapelter Entwurf, F053).
  private finalizeOpen(cardEl: HTMLElement, stackedOver = false): void {
    cardEl.style.left = '50%';
    cardEl.style.top = '50%';
    cardEl.style.transform = stackedOver
      ? `translate(calc(-50% + ${STACK_OFFSET_X}px), calc(-50% + ${STACK_OFFSET_Y}px))`
      : 'translate(-50%, -50%)';
    cardEl.style.height = '';
    cardEl.setAttribute('data-expanded', 'true');
  }

  // Board minus margins, capped at two thirds of the board and a multiple of
  // the column width (Einstellung expandedWidthFactor, Standard 3), floored
  // at 720 px — the detail width from DESIGN.md. A stacked draft (F053) is
  // 80 px narrower than this width.
  private expandedWidth(boardEl: HTMLElement, stackedOver = false): number {
    const boardWidth = boardEl.clientWidth;
    const openColumn = boardEl.querySelector<HTMLElement>('.ktm-column:not([data-collapsed="true"])');
    const columnWidth = openColumn ? openColumn.getBoundingClientRect().width : EXPANDED_MIN_WIDTH;
    const factor = this.plugin.settings.expandedWidthFactor ?? 3;
    let width = Math.min(factor * columnWidth, Math.floor((boardWidth * 2) / 3));
    width = Math.max(EXPANDED_MIN_WIDTH, width);
    width = Math.min(width, boardWidth - EXPANDED_MARGIN);
    return stackedOver ? width - STACK_WIDTH_INSET : width;
  }

  private onCoverClick(ev: MouseEvent): void {
    const beneath = this.cardAtPoint(ev.clientX, ev.clientY);
    if (beneath) void this.openDetail(beneath);
    else void this.closeDetail();
  }

  private cardAtPoint(x: number, y: number): BoardElement | undefined {
    for (const el of this.contentEl.doc.elementsFromPoint(x, y)) {
      const card = el instanceof Element ? el.closest('.ktm-columns .ktm-card') : null;
      const id = card instanceof HTMLElement ? card.dataset.cardId : undefined;
      const element = id ? this.elementByPath.get(id) : undefined;
      if (element) return element;
    }
    return undefined;
  }

  // Escape closes only the current stack top; a single, permanent
  // listener (onOpen) instead of one per card opening keeps that unambiguous.
  private onDetailEscape(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape') return;
    const open = this.detail;
    if (!open) return;
    ev.preventDefault();
    // A field's own unconfirmed edit (the date field's calendar) wins the
    // first Escape (S11/K4); only a second Escape, with no field active
    // anymore, closes the card.
    if (open.detail.hasActiveField()) {
      open.detail.cancelActiveField();
      return;
    }
    void this.closeDetail();
  }

  // Tears down a stack entry without saving (discard path); used for
  // the card beneath when a stacked draft replaces it anyway through a
  // fresh reopen (F053 K1-K3, wissen #529).
  private teardownEntry(entry: OpenDetail): void {
    entry.resize.disconnect();
    this.removeChild(entry.detail);
  }

  private async closeDetail(): Promise<void> {
    const open = this.detail;
    if (!open) return;

    if (open.draft) {
      await this.closeDraft(open);
      return;
    }

    // The note may have been moved or deleted from outside while the card was
    // open (008 S45, F068 K2): checked before this.detail is touched, so a
    // missing note leaves the card, its cover and its unsaved edits exactly as
    // they were — nothing is written, nothing is redrawn.
    if (!this.app.vault.getFileByPath(open.path)) {
      this.failureNotice('Schließen', open.path, 'Notiz wurde verschoben oder gelöscht');
      return;
    }

    const changes = open.detail.changes();
    const element = this.elementByPath.get(open.path);
    if (!changes) {
      this.detail = undefined;
      open.resize.disconnect();
      this.removeChild(open.detail);
      open.coverEl.remove();
      open.cardEl.remove();
      return;
    }

    // Resolved before anything is torn down (F071 K4, wissen #584): a
    // project switch into a root the vault does not have must write
    // nothing and leave the card exactly as it is, not run through
    // persist()/render() at all.
    let refilePlan: RefilePlan | undefined;
    if (changes.refile && element) {
      refilePlan = this.resolveRefile(element, changes.refile);
      if (refilePlan.blocked) {
        new Notice(refilePlan.blocked, NOTICE_DURATION);
        this.reattachDetail(open);
        return;
      }
    }

    this.detail = undefined;
    open.resize.disconnect();

    const ok = await this.persist('Speichern', open.path, async () => {
      this.reconciling = true;
      try {
        let notePath = open.path;
        let frontmatter = { ...changes.frontmatter };
        if (refilePlan && element) {
          const plan = refilePlan;
          if (plan.notice) new Notice(plan.notice, NOTICE_DURATION);
          Object.assign(frontmatter, plan.frontmatter);
          if (plan.move) {
            await moveElement(this.app, plan.move.from, plan.move.to, plan.move.parent);
            // A folder move carries its `_`-note along under its old file name;
            // a title change needs a second, separate rename of just that note
            // (adapter building block: "in two renameFile steps").
            if (element.form === 'nested') {
              const interim = `${plan.move.to}/${baseName(element.paths.note)}`;
              if (interim !== plan.notePath) {
                await moveElement(this.app, interim, plan.notePath, plan.move.to);
              }
            }
          }
          notePath = plan.notePath;
        }
        if (element) frontmatter = this.withCanonicalStatus(element, frontmatter);
        if (Object.keys(frontmatter).length > 0) {
          await writeFrontmatter(this.app, notePath, frontmatter);
        }
        if (changes.body !== undefined) {
          await writeBody(this.app, notePath, changes.body);
        }
        // Child detachments (F051 K6): only after the refile of the open
        // element, reconcile was blocked the whole time the detail was
        // open anyway (#130) — each detached child pulls one level higher,
        // into the folder of the (unchanged) parent of the open element,
        // or to its project root.
        if (changes.detachedChildren && element) {
          const targetFolder = this.detachFolderFor(element);
          if (targetFolder) {
            for (const childPath of changes.detachedChildren) {
              const child = this.elementByPath.get(childPath);
              if (!child?.paths.folder) continue;
              const plan = planRefile(
                { form: child.form, type: child.type, notePath: child.paths.note, folderPath: child.paths.folder },
                { parentFolder: targetFolder },
                this.childrenOf(child),
                this.siblingNames(targetFolder),
              );
              if (plan.move) await moveElement(this.app, plan.move.from, plan.move.to, plan.move.parent);
            }
          }
        }
      } finally {
        this.reconciling = false;
      }
    });

    if (ok) {
      this.removeChild(open.detail);
      open.coverEl.remove();
      open.cardEl.remove();
    } else {
      // S46/K1: the write failed partway; the card stays open with its
      // unsaved draft, the board underneath was already redrawn by persist().
      this.reattachDetail(open);
    }
  }

  // The draft-closing half of closeDetail: an empty title discards silently
  // (S11/K3, unrelated to write errors), a real write failure (F068)
  // leaves the draft open with a notice instead of tearing it down, and a
  // successful create proceeds exactly as before (F053 stacking).
  private async closeDraft(open: OpenDetail): Promise<void> {
    this.detail = undefined;
    open.resize.disconnect();
    const base = this.stackedBase;
    this.stackedBase = undefined;

    const result = await this.writeDraft(open.detail);

    if (!result) {
      this.removeChild(open.detail);
      open.cardEl.remove();
      if (!base) {
        open.coverEl.remove();
        return;
      }
      // K4: an empty title creates nothing; the card beneath becomes
      // operable again without a render (DESIGN.md Gestapelter Entwurf).
      base.cardEl.removeAttribute('data-stacked');
      this.detail = base;
      return;
    }

    if (!result.ok) {
      this.failureNotice('Anlegen', result.path, result.message);
      await this.render();
      this.reattachDetail(open, base);
      return;
    }
    const createdPath = result.path;

    if (!base) {
      this.removeChild(open.detail);
      open.cardEl.remove();
      open.coverEl.remove();
      await this.render();
      return;
    }

    // K1-K3: created. On a level above the source it pulls under the
    // new element (planRefile/moveElement); then pop the stack, render()
    // and reopen the card beneath fresh at the new path — it must
    // not survive, render() tears down discardDetail() anyway (#529).
    // moveElement itself under reconciling=true, otherwise the
    // rename event schedules an unguided reconcile render (250ms debounce)
    // that fires after the reopen below and tears it down again.
    this.reconciling = true;
    let sourcePath: string;
    try {
      sourcePath = open.stackedFrom
        ? await this.applyStackedRefile(open.stackedFrom, createdPath)
        : base.path;
    } finally {
      this.reconciling = false;
    }
    this.removeChild(open.detail);
    open.cardEl.remove();
    this.teardownEntry(base);
    base.cardEl.remove();
    base.coverEl.remove();
    await this.render();
    const fresh = this.elementByPath.get(sourcePath);
    if (fresh) await this.openDetail(fresh);
  }

  // The target folder of a child detachment: the folder of its own parent,
  // otherwise (no parent) the element's own project root.
  private detachFolderFor(element: BoardElement): string | undefined {
    const parent = element.parents[0];
    if (parent) return this.elementByPath.get(parent.note)?.paths.folder;
    return projectRootForElement(element, this.projects);
  }

  // Builds the draft's note from its final title/status/type and the form
  // chosen via the folder field or the link-plus (draftPlacement) and
  // writes it; an empty title discards the draft without vault access
  // (S11/K3), reported as `undefined`, distinct from a real write failure
  // (F068), reported as `{ok: false}` with the intended path and the error's
  // message so closeDraft can leave the draft open with a notice instead of
  // tearing it down. draftTarget() reports the final values rather than a
  // diff, since status often stays at its opening default and a diff
  // against that default would omit it even though the new note still needs
  // it; the optional fields (priority/planned/due/tags) and a typed
  // description genuinely are "only if set" (008), so those still come from
  // changes(). On success, the path doubles as the created note's path
  // (F053: closing a stacked draft needs it to refile the card underneath).
  private async writeDraft(
    detail: CardDetail,
  ): Promise<{ path: string; ok: true } | { path: string; ok: false; message: string } | undefined> {
    const target = detail.draftTarget();
    if (!target) return undefined;
    const placement = this.draftPlacement(target);
    if (!placement) return undefined;
    // A root the vault does not have (006 S43, F071 K5): reported before
    // createNote ever runs, same shape as a real write failure so
    // closeDraft leaves the draft open with the notice.
    if (placement.missingRoot) {
      return { path: placement.path, ok: false, message: placement.missingRoot };
    }

    const content = noteContent({
      type: target.type,
      title: target.title,
      status: target.status,
      project: placement.project,
    });

    this.reconciling = true;
    try {
      await createNote(this.app, placement.path, content);
      const frontmatter: Record<string, string | null> = {};
      if (placement.parent) frontmatter.parent = placement.parent;
      const changes = detail.changes();
      if (changes) Object.assign(frontmatter, changes.frontmatter);
      if (Object.keys(frontmatter).length > 0) {
        await writeFrontmatter(this.app, placement.path, frontmatter);
      }
      if (changes?.body !== undefined) {
        await writeBody(this.app, placement.path, changes.body);
      }
      return { path: placement.path, ok: true };
    } catch (err) {
      return { path: placement.path, ok: false, message: errorMessage(err) };
    } finally {
      this.reconciling = false;
    }
  }

  // The vault access the core placement decision (planDraftPlacement,
  // planFiling, resolveParentTarget — core/refile.ts) needs, built from the
  // board's already-loaded state so the decision itself stays plain
  // TypeScript and provable without Obsidian (F072 S23).
  private refileEnv(): RefileEnv {
    return {
      projects: this.projects,
      elements: [...this.elementByPath.values()],
      levelsFor: (project) => this.projectSettings(project).levels,
      rootExists: (root) => folderExists(this.app, root),
      siblings: (folder) => this.siblingNames(folder),
      linkTo: (target, source) => this.wikilinkTo(target, source),
      childrenOf: (element) => this.childrenOf(element),
    };
  }

  // Places the draft according to its chosen form (008 S21-S23, F055,
  // core/refile.ts#planDraftPlacement).
  private draftPlacement(
    target: DraftTarget,
  ): { path: string; project?: string; parent?: string; missingRoot?: string } | undefined {
    return planDraftPlacement(target, this.refileEnv(), this.today);
  }

  // Turns the filing edits (title, project, level, the parentLabel driven
  // via the link list, the folder field) into a plan
  // (core/refile.ts#planFiling, F034/F051/F054/F072).
  private resolveRefile(element: BoardElement, refile: RefileRequest): RefilePlan {
    return planFiling(element, refile, this.refileEnv());
  }

  // A scalar `parent` value (008 S29, wissen #500: bewusst quotiert statt
  // einer Liste): the wikilink Obsidian's own link format would produce,
  // resolved relative to the writing note so a vault-unique basename stays
  // short.
  private wikilinkTo(targetNotePath: string, sourceNotePath: string): string {
    const file = this.app.vault.getFileByPath(targetNotePath);
    const linktext = file
      ? this.app.metadataCache.fileToLinktext(file, sourceNotePath, true)
      : baseName(targetNotePath).replace(/\.md$/, '');
    return JSON.stringify(`[[${linktext}]]`);
  }

  private siblingNames(folder: string): string[] {
    const abstract = this.app.vault.getAbstractFileByPath(folder);
    return abstract instanceof TFolder ? abstract.children.map((c) => c.name) : [];
  }

  // Tears the overlay down without saving; used only when a re-render or view
  // close pulls the board out from under an open detail. Also tears down a
  // stacked draft along with its base (F053).
  private discardDetail(): void {
    const base = this.stackedBase;
    this.stackedBase = undefined;
    if (base) {
      this.teardownEntry(base);
      base.cardEl.remove();
    }
    const open = this.detail;
    if (!open) return;
    this.detail = undefined;
    open.resize.disconnect();
    this.removeChild(open.detail);
    open.coverEl.remove();
    open.cardEl.remove();
  }

  // The direct children of an element: every card whose immediate parent is
  // this note, in the order the link list shows them (F051: column
  // order, Done last, DESIGN.md Datenform "Kinder").
  private childrenOf(element: BoardElement): BoardElement[] {
    const direct = [...this.elementByPath.values()].filter(
      (c) => c.parents[0]?.note === element.paths.note,
    );
    return orderChildren(direct, this.columns);
  }

  // Every tag already used anywhere in the vault (tasks, features, epics),
  // deduplicated: the suggestion list for the tags field (K1). Read from the
  // already-loaded elements rather than a fresh vault scan.
  private vaultTags(): string[] {
    const tags = new Set<string>();
    for (const el of this.elementByPath.values()) {
      for (const tag of el.tags) tags.add(tag);
    }
    return [...tags].sort();
  }

  // The project-capable settings (levels, linkKinds, columns) for one
  // element's project, resolved the same way the board itself is (F052):
  // the project note's own values, else the general ones. Used by the
  // link-menu's Art-dropdown and by refreshDetailLinks/openDetail, so a
  // per-project link kind (e.g. Nimbus' `protocol`) is parsed and rendered
  // with the same list it was written with, not the general one.
  private projectSettings(projectKey: string | undefined): ResolvedSettings {
    const project = this.projects.find((p) => p.key === projectKey);
    return settingsFor(this.plugin.settings, project);
  }

  private statusNameFor(element: BoardElement): string {
    const columns = this.projectSettings(element.project).columns;
    return columns.find((c) => c.status === element.status)?.name ?? element.status;
  }

  // The link-menu's element search (F052 S36/K4): elements of the given
  // level whose title contains the query, the searching card's own project
  // first, then by note path (wissen #496 — the underlying vault order is not
  // stable enough to rely on, so this sorts explicitly; the path, not the
  // title, because DESIGN.md's own reference order for same-project matches
  // follows the fixtures' date-prefixed folders, not alphabetical titles).
  private searchElements(level: ElementType, source: BoardElement, query: string): LinkSearchResult[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const matches = [...this.elementByPath.values()].filter(
      (el) =>
        el.type === level &&
        el.paths.note !== source.paths.note &&
        el.title.toLowerCase().includes(needle),
    );
    matches.sort((a, b) => {
      const rankA = a.project === source.project ? 0 : 1;
      const rankB = b.project === source.project ? 0 : 1;
      return rankA !== rankB ? rankA - rankB : a.paths.note.localeCompare(b.paths.note);
    });
    return matches.slice(0, 5).map((el) => ({
      path: el.paths.note,
      title: el.title,
      project: el.project,
      statusName: this.statusNameFor(el),
    }));
  }

  // Creates the note (or, for a kind with a `prefix`, the ADR) a link-menu
  // "Neu anlegen" picks, next to the element (F035 K4/K5). The default name
  // from core/create is de-duplicated against the folder's existing files
  // before creating, so a second note with the same title does not collide.
  private async createLinkNote(
    element: BoardElement,
    kind: LinkKind,
    title: string,
  ): Promise<string | undefined> {
    const trimmed = title.trim();
    if (!trimmed) return undefined;
    const folder = linkFolder(element.paths.note);
    const taken = this.siblingNames(folder).map((name) => name.replace(/\.md$/, ''));
    const draft = kind.prefix
      ? adrTarget(folder, trimmed, this.today)
      : { path: noteTarget(folder, trimmed), content: '' };
    const stem = uniqueName(baseName(draft.path).replace(/\.md$/, ''), taken);
    const path = folder ? `${folder}/${stem}.md` : `${stem}.md`;

    await createNote(this.app, path, draft.content);
    const file = this.app.vault.getFileByPath(path);
    if (!file) return undefined;
    return this.app.metadataCache.fileToLinktext(file, element.paths.note, true);
  }

  // Opens a free link's target note in a tab, resolved as a wikilink relative to
  // the element it hangs on (K3).
  private async openLink(target: string, source: string): Promise<void> {
    const file = this.app.metadataCache.getFirstLinkpathDest(target, source);
    if (!file) return;
    await this.closeDetail();
    await this.app.workspace.getLeaf('tab').openFile(file);
  }

  private async openNote(path: string): Promise<void> {
    await this.closeDetail();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(file);
  }

  // Klick auf den Ordner-Pfad (002 S4/K3, 008 S42): zeigt den Ordner im
  // Dateibaum, ohne den Picker zu oeffnen, den ein Klick auf den Rest des
  // Feldes startet (F054).
  private async revealFolder(path: string): Promise<void> {
    await this.closeDetail();
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (!folder) return;
    const explorer = (this.app as DesktopApp).internalPlugins.getPluginById('file-explorer');
    explorer?.instance?.revealInFolder?.(folder);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function baseName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

// The level switcher's segment label (009 addendum 2026-09-20): the level
// name plus a German lending-word "s" (Epics, Features, User Storys), unless
// the name already ends in one.
function levelPlural(name: string): string {
  return name.endsWith('s') ? name : `${name}s`;
}

function matchRoot(notePath: string, roots: ProjectRoot[]): string | undefined {
  return roots
    .map((r) => r.root.replace(/\/+$/, ''))
    .filter((root) => notePath.startsWith(root + '/'))
    .sort((a, b) => b.length - a.length)[0];
}
