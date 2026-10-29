import {
  type App,
  type CachedMetadata,
  DropdownComponent,
  getFrontMatterInfo,
  ItemView,
  Notice,
  setIcon,
  type TAbstractFile,
  TFile,
  TFolder,
  type WorkspaceLeaf,
} from 'obsidian';
import { createNote, folderExists, moveDocument, moveElement, parentLinkTo, writeBody, writeFrontmatter } from '../adapters/obsidian';
import {
  allViewLevels,
  type BoardColumn,
  type BoardView as BoardFilter,
  buildBoard,
  type LevelContext,
  linkCandidates,
  orderChildren,
  parentChain,
} from '../core/board';
import { agendaGroups, type AgendaGroup } from '../core/agenda';
import { adrTarget, linkFolder, noteContent, noteTarget, uniqueName } from '../core/create';
import {
  absoluteDate,
  addDays,
  dayDiff,
  dueState,
  fullDate,
  isoWeek,
  mondayOf,
  monthGrid,
  msUntilNextMidnight,
  priorityIcon,
  relativeDate,
  shortDate,
  todayISO,
  visibleTags,
} from '../core/dates';
import { type DoneElement, guardMove, reconcileCompleted } from '../core/done';
import {
  chainParent,
  type FilterRow,
  type FilterSelection,
  filterEntries,
  filterRows,
  filterSummary,
  isUnderSpotlight,
  isVisibleUnderSelection,
  parseFilterEntries,
  pruneSelection,
  toggleFilterSelection,
} from '../core/filter';
import { flowList, type FrontmatterChange, yamlScalar } from '../core/frontmatter';
import { newId } from '../core/ids';
import { assignMatrix, matrixDropPriority, matrixQuadrant, type MatrixQuadrant } from '../core/matrix';
import type { BoardElement, ElementType, ParentRef, ProjectRoot, TaskForm } from '../core/model';
import { type Move, type MoveDirection, moveByDirection, moveToColumn, startedAfterStatusChange } from '../core/move';
import { isAmbiguousFolder } from '../core/placement';
import { fullInsertIndex, reorderColumn } from '../core/order';
import { linksOf, readElements } from '../core/read';
import { planResult } from '../core/result';
import { moveSavedView, type SavedView, validateViewName } from '../core/savedViews';
import { splitTagChips, tagSuggestions } from '../core/tags';
import { isViewModeKey, rememberedMode, resolveViewOrder, VIEW_MODES } from '../core/viewModes';
import {
  buildTree,
  cycleTreeSort,
  parseTreeSort,
  sortTree,
  type TreeProjectEntry,
  type TreeRow,
  type TreeSort,
  type TreeSortKey,
} from '../core/tree';
import { buildPortfolio, type PortfolioProgressRow, type PortfolioScope, type PortfolioTile } from '../core/portfolio';
import { buildRetro, type RetroEntry, type RetroWeek } from '../core/retro';
import { assignWeek, statusTone } from '../core/week';
import {
  monthRange,
  parseRoadmapState,
  roadmapRows,
  ROADMAP_DAY_WIDTH,
  ROADMAP_GRIDS,
  shiftRoadmapRange,
  todayRange,
  type RoadmapGrid,
  type RoadmapRange,
  type RoadmapRow,
  type RoadmapState,
} from '../core/roadmap';
import {
  type DraftPlacement,
  planDraftPlacement,
  planFiling,
  planRefile,
  type RefileEnv,
  type RefilePlan,
  rootForPath,
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
  buttonStyleOf,
  canonicalStatus,
  doneStatuses as columnDoneStatuses,
  effectiveTags,
  generalColumnNotices,
  isBottomLevel,
  normalizeBoardScale,
  orderProjects,
  resolveCardFields,
  resolveColumns,
  resolveLevels,
  resolveProjectSettings,
  RESULT_LINK_KIND,
  settingsFor,
  statusClosure,
  withoutHiddenProjects,
  withResultKind,
} from '../core/settings';
import type KanbanTaskManagerPlugin from '../main';
import { type AncestorChip, metaItem, renderCardFace, renderParentChip, renderStatusMark } from './cardFace';
import {
  CardDetail,
  MONTH_NAMES,
  parentFolderLabelFor,
  shiftMonth,
  WEEKDAY_LABELS,
  type DraftTarget,
  type LinkSearchResult,
  type RefileRequest,
} from './CardDetail';
import { type ResultCandidate, ResultDialog } from './ResultDialog';
import { ViewNameDialog } from './ViewNameDialog';

export const VIEW_TYPE_BOARD = 'ktm-board';

const ICON_PLANNED = 'calendar';
const ICON_DUE = 'flag';

const VIEW_ALL = 'all';
const VIEW_INTERNAL = 'internal';
// The literal `project` value an element without a real project carries (011).
const INTERNAL_PROJECT = 'intern';

// Sortierbare Köpfe des Baums außer Titel, in Anzeigereihenfolge (012 "Baum").
const TREE_HEAD_COLUMNS: { key: TreeSortKey; label: string }[] = [
  { key: 'status', label: 'Status' },
  { key: 'started', label: 'Gestartet' },
  { key: 'planned', label: 'Geplant' },
  { key: 'due', label: 'Fällig' },
  { key: 'progress', label: 'Fortschritt' },
];

// F010 owns creating a task; the toolbar button forwards to its command so the
// wiring is real once that command lands, and a plain pass-through until then.
const NEW_TASK_COMMAND = 'kanban-taskmanager:new-task';
// Die Größensteuerung (001, Ergänzung 2026-10-24) führt dieselben drei Befehle
// aus wie die Befehlspalette, statt die Einstellung direkt zu schreiben.
const BOARD_ZOOM_IN_COMMAND = 'kanban-taskmanager:board-zoom-in';
const BOARD_ZOOM_OUT_COMMAND = 'kanban-taskmanager:board-zoom-out';
const BOARD_ZOOM_RESET_COMMAND = 'kanban-taskmanager:board-zoom-reset';

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
  /** The element's `ktm_id` (011 K5-K8); undefined for a draft, which is never retargeted. */
  id?: string;
  cardEl: HTMLElement;
  coverEl: HTMLElement;
  resize: ResizeObserver;
  draft: boolean;
  stackedFrom?: StackedFrom;
}

// What a keep-open redraw (render()) must put back once it has reattached the
// card (002, Ergänzung 2026-10-18 "Karte bleibt offen"): detaching the card's
// DOM subtree (contentEl.empty()) drops focus from a field in edit — like the
// description textarea — without leaving anything to restore it from
// afterwards, so this is captured while the card is still connected.
interface DetailFocus {
  field?: { el: HTMLTextAreaElement | HTMLInputElement; selectionStart: number | null; selectionEnd: number | null };
  scrollTop: number;
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
// Mitscrollen langer Spalten (003, Ergänzung 2026-10-18 "Lange Spalten
// scrollen mit", K11/K12): fester Randbereich und feste Schrittweite je
// Bildwiederholung, kein Gestaltungswert.
const AUTOSCROLL_EDGE = 40;
const AUTOSCROLL_STEP = 16;

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
  // Pointerdown begann auf einem Ebenen-Chip (001, Ergänzung 2026-10-18): ein
  // Ziehen darüber hinweg bewegt die Karte trotzdem ganz normal, nur der
  // reine Klick (ohne Bewegung über die Schwelle) öffnet sie dann nicht —
  // der Chip selbst behandelt ihn (installAncestorChipHandlers).
  fromChip?: boolean;
  ghost?: HTMLElement;
  placeholder?: HTMLElement;
  targetColumn?: HTMLElement;
  // Anker statt DOM-Index (F127 U2/U3): der Pfad der Karte, vor der der
  // Platzhalter steht, oder undefined fürs Ende der Spalte. targetStatus ist
  // zugleich das Zeichen, ob der Zeiger überhaupt in einer Spalte steht —
  // ist er das nicht, sind beide undefined (K7).
  targetStatus?: string;
  // Spalte in der Woche (012 "Woche"): ein ISO-Tag oder 'none' für "Ohne
  // Datum"; gesetzt statt targetStatus, dort gibt es keine data-status-Spalte.
  targetDay?: string;
  // Feld in der Matrix (012 "Matrix"): gesetzt statt targetStatus/targetDay,
  // wenn die Spalte unter dem Zeiger ein Matrix-Feld ist.
  targetQuadrant?: MatrixQuadrant;
  beforePath?: string;
  // Letzte Zeigerposition, fürs Mitscrollen (kommt beim Halten ohne
  // pointermove aus) und um den Anker nach einem Neuzeichnen neu zu finden,
  // wenn die Anker-Karte selbst verschwunden ist (U3).
  lastX?: number;
  lastY?: number;
  scrollFrame?: number;
}

// Ziehen einer gespeicherten Ansicht im Ansicht-Menü (001, Ergänzung
// 2026-10-18 "Ansichten per Ziehen ordnen"), getrennt vom Kartenzug (eigenes
// Feld statt desselben DragState, Wissen #1032): Schwelle 5 px wie beim
// Kartenzug, aber kein Ghost/Platzhalter nötig, die Einfügestelle wird erst
// bei pointerup aus dem DOM gelesen (Muster SettingsTab#registerDragHandle).
interface ViewDragState {
  key: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
}

// Ziehen eines Darstellungs-Icons im Darstellungs-Schalter (012, Ergänzung
// 2026-10-25 "Reihenfolge per Ziehen"), nach demselben Muster wie
// ViewDragState: ein eigener Zugzustand, getrennt vom Kartenzug, die
// Einfügestelle (beforeMode) läuft über updateViewSwitchMarker während des
// Zugs statt erst bei pointerup berechnet zu werden, weil der Einfügestrich
// (anders als bei den gespeicherten Ansichten) schon während des Zugs sichtbar
// sein muss (012 S3).
interface SwitchDragState {
  mode: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  beforeMode?: string;
}

// Eine Aktionszeile, die Marke "geändert" und Ansicht-Menü gemeinsam nutzen
// (012, Ergänzung 2026-10-25 "Marke 'geändert'"): BoardView#modeActions baut
// die Liste aus dem aktuellen Zustand der Ansicht, renderModeActionRow
// zeichnet sie identisch in beiden Popovern.
interface ModeAction {
  text: string;
  icon: string;
  run: () => Promise<void>;
}

// Production reads the local system date; the measurement pins a day via
// window.__ktmToday so the relative labels are deterministic (core/dates#todayISO).
export type KtmWindow = Window & { __ktmToday?: unknown };

interface BoardViewState {
  view?: string;
  level?: ElementType;
  mode?: string;
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
  private reconcileMissed = false;
  private midnightTimer?: number;
  private readonly shownNotices = new Set<string>();
  private readonly elementByPath = new Map<string, BoardElement>();
  private readonly bodyByPath = new Map<string, string>();
  // Every `ktm_id` currently in the vault, valid or not (011), so a freshly
  // drawn id (new note, "Neue Kennung vergeben") never collides.
  private knownIds = new Set<string>();
  private detail?: OpenDetail;
  // The dimmed, inert entry beneath a stacked draft
  // (F053); set exactly when `this.detail` currently is the draft.
  private stackedBase?: OpenDetail;
  // Filterfeld-Auswahl der aktuellen Ansicht (001, Ergänzung 2026-10-18,
  // erweitert 2026-10-25 um Status und Tags), frisch aus den Einstellungen
  // gelesen; die Hierarchie-IDs werden bei jedem render() auf vorhandene
  // gekürzt, Status und Tags nicht (001, "Ausserhalb"). Nie direkt
  // geschrieben, nur über plugin.saveFilter mit filterEntries().
  private filterSelection: FilterSelection = { ids: new Set(), statuses: new Set(), tags: new Set() };
  // Aufklappzustand je Sektion des Filter-Popovers über die 16-/8-/16-Grenze
  // (001, Ergänzung 2026-10-25, "Platz"): ein eigenes Feld statt einer
  // DOM-Abfrage, weil ein laufendes render() ihn sonst stumm verwerfen würde
  // wie filterMenuOpen (Wissen #914/#962); beim Öffnen zurückgesetzt.
  private filterSectionExpanded = { hierarchy: false, status: false, tags: false };
  // Hervorhebung der aktuellen Ansicht (001, Ergänzung 2026-10-18
  // "Hervorheben"), frisch aus den Einstellungen gelesen und auf ein
  // vorhandenes Element gekürzt bei jedem render(); nie direkt geschrieben,
  // nur über plugin.saveSpotlight.
  private spotlightId: string | undefined;
  // Ob/wonach das Filter-Popover offen ist: ein eigener Zustand statt einer
  // DOM-Abfrage, weil ein laufendes render() das Popover sonst stumm
  // verwerfen würde (Wissen #914/#962).
  private filterMenuOpen = false;
  private filterSearch = '';
  private filterMenuCleanup?: () => void;
  // Ansicht-Menü (001, Ergänzung 2026-10-18 "Ansicht-Menü"): derselbe Zweck
  // wie filterMenuOpen (Wissen #914/#962) für das eigene Popover unter dem
  // beibehaltenen nativen Select.
  private viewMenuOpen = false;
  private viewMenuCleanup?: () => void;
  // Schlüssel der gespeicherten Ansicht, deren Name im Menü gerade als
  // Textfeld bearbeitet wird; undefined außerhalb des Umbenennens.
  private viewRenameKey?: string;
  private viewDrag?: ViewDragState;
  // Darstellung der View (012, Ergänzung 2026-10-25 "Darstellungen"): Teil
  // des Zustands (getState/setState), aber nie in data.json geschrieben
  // (kein "lastMode", 012 "Ausserhalb") — persistiert wird nur die gemerkte
  // Darstellung je Ansicht (viewModes/SavedView.mode).
  private mode = VIEW_MODES[0].key;
  private switchDrag?: SwitchDragState;
  // Gewählte Woche je Ansicht (012 "Woche"): gilt, bis die Darstellung
  // verlassen wird (setMode leert die Map dann), nicht in data.json.
  private weekStartByView = new Map<string, string>();
  private weekCalOpen = false;
  private weekCalMonth?: { year: number; month: number };
  private weekCalCleanup?: () => void;
  // Eingeklappte Gruppen der Agenda (012 "Agenda"): flüchtig wie
  // weekStartByView, nie in getState/data.json (Wissen #1363).
  private readonly agendaCollapsedGroups = new Set<string>();
  // Monatswahl der Roadmap (012 "Roadmap"): flüchtig wie weekCalOpen/-Month,
  // nie in getState/data.json. roadmapPickFirst hält den ersten der beiden
  // Monatsklicks, bis der zweite den Zeitraum ergibt.
  private roadmapCalOpen = false;
  private roadmapCalYear?: number;
  private roadmapPickFirst?: { year: number; month: number };
  private roadmapCalCleanup?: () => void;
  // Eingeklappte Zeilen des Baums (012 "Baum"): `TreeRow.id`, flüchtig wie
  // agendaCollapsedGroups, nie in getState/data.json (Wissen #1363).
  private readonly treeCollapsed = new Set<string>();
  // Menü der Marke "geändert" (012, Ergänzung 2026-10-25): derselbe Zweck wie
  // viewMenuOpen (Wissen #914/#962) für das eigene Popover unter der Marke.
  private changedMenuOpen = false;
  private changedMenuCleanup?: () => void;
  // Gewählte Kachelart des Portfolio-Schalters je Ansicht (012 "Portfolio"):
  // flüchtig wie weekStartByView, nie in getState/data.json (Wissen #1274/#1399).
  private readonly portfolioKindByView = new Map<string, PortfolioScope>();

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
    return { ...super.getState(), view: this.view, level: this.level, mode: this.mode };
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
    const nextMode = typeof state?.mode === 'string' && isViewModeKey(state.mode) ? state.mode : undefined;
    const changed =
      (nextView !== undefined && nextView !== this.view) ||
      (nextLevel !== undefined && nextLevel !== this.level) ||
      (nextMode !== undefined && nextMode !== this.mode);
    if (nextView !== undefined) this.view = nextView;
    if (nextLevel !== undefined) this.level = nextLevel;
    if (nextMode !== undefined) this.mode = nextMode;
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
    // metadataCache 'changed'/vault 'rename'/'delete' are registered once at
    // plugin level (main.ts), feeding the shared ElementIndex first and this
    // view second through the public hooks below (011 S61).
    await this.render();
    // Tageswechsel (F106, 004 Ergaenzung 2026-10-06): ein Zeitgeber auf die
    // naechste lokale Mitternacht, dazu focus/visibilitychange als Rueckfall
    // nach einem Schlafzustand des Rechners (S10).
    this.scheduleMidnightCheck();
    const win = this.contentEl.win;
    this.registerDomEvent(win, 'focus', () => this.checkDay());
    this.registerDomEvent(this.contentEl.doc, 'visibilitychange', () => {
      if (this.contentEl.doc.visibilityState === 'visible') this.checkDay();
    });
    // Jede Bedienung prueft zusaetzlich (004 Ergaenzung 2026-10-19, S24): ein
    // Schlaf ohne Fokus- oder Sichtbarkeitsereignis darf nicht bis zum
    // naechsten solchen Ereignis unbemerkt bleiben. pointerdown in der
    // Capture-Phase laeuft vor jedem Kind-Handler, der stopPropagation ruft.
    // Obsidians hotkeyManager faengt ein gebundenes Kuerzel am Fenster in der
    // Capture-Phase ab (wissen #983), darum haengt der keydown-Listener dort
    // ebenfalls in der Capture-Phase, gefiltert auf den Fokus im Board.
    this.registerDomEvent(this.contentEl, 'pointerdown', () => this.checkDay(), true);
    this.registerDomEvent(
      win,
      'keydown',
      () => {
        if (this.contentEl.contains(this.contentEl.doc.activeElement)) this.checkDay();
      },
      true,
    );
  }

  // Public hook for a rerender driven from outside a user gesture on this
  // view: the settings tab after a toggle, and onExternalSettingsChange after
  // a data.json edit made without the UI (006 S10). render() itself is
  // private, wired to the view's own event handlers; it always carries an
  // open card through instead of deferring (002, Ergänzung 2026-10-18 "Karte
  // bleibt offen", formerly F123 K7-K9's `keepDetail`).
  async rerender(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {
    if (this.reconcileTimer !== undefined) {
      this.contentEl.win.clearTimeout(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    if (this.midnightTimer !== undefined) {
      this.contentEl.win.clearTimeout(this.midnightTimer);
      this.midnightTimer = undefined;
    }
    this.discardDetail();
  }

  // Stellt sich nach jedem Feuern neu auf die naechste Mitternacht; so wird
  // auch ein Zeitgeber aufgefangen, der etwas zu frueh ausgeloest hat (kein
  // Datumswechsel in checkDay, siehe dort).
  private scheduleMidnightCheck(): void {
    const win = this.contentEl.win;
    this.midnightTimer = win.setTimeout(() => {
      this.checkDay();
      this.scheduleMidnightCheck();
    }, msUntilNextMidnight(new Date()));
  }

  // Oeffentliche Tagespruefung (F106): ausgeloest vom Mitternachts-Zeitgeber,
  // von focus und von visibilitychange. Zeichnet nur bei einem Datumswechsel
  // neu, ueber denselben debounced Reconcile-Weg wie eine externe Aenderung;
  // eine offene Karte verzoegert das seit 002 (Ergaenzung 2026-10-18, "Karte
  // bleibt offen") nicht mehr, render() nimmt sie mit.
  checkDay(): void {
    const current = todayISO((this.contentEl.win as KtmWindow).__ktmToday);
    if (current === this.today) return;
    if (this.reconciling) {
      this.reconcileMissed = true;
      // Kein catchUpReconcile() ohne einen laufenden Schreibvorgang; ein
      // eigener Wechsel wuerde sonst verloren gehen.
      this.contentEl.win.setTimeout(() => this.checkDay(), RECONCILE_DEBOUNCE);
      return;
    }
    this.scheduleReconcile();
  }

  // An external status edit reaches the board through the changed event, an
  // external move or delete through rename/delete. A folder move fires rename
  // once per child, so the shared debounce coalesces the burst. A change to
  // the note behind the open detail card is special-cased (K3/K4): the guard
  // in scheduleReconcile would otherwise drop it until the card closes, and a
  // followed rename reaches the open note the same way, as a rewritten
  // wikilink in its own frontmatter (alwaysUpdateLinks). Called by the
  // plugin (main.ts#onNoteChanged) after the shared ElementIndex already
  // reflects the change.
  onNoteChanged(path: string, cache: CachedMetadata): void {
    if (this.detail && path === this.detail.path) {
      this.refreshDetailLinks(cache);
      // The body too (002, Ergänzung 2026-10-26): Obsidian's own image menu
      // (rename, move) changes the note's link to the image without going
      // through this card at all. CachedMetadata carries no body text, so
      // this rereads the file itself (same split as closeDetail's own
      // getFrontMatterInfo); `open` and the fresh `this.detail` identity
      // check against a card that closed or reopened during the read
      // (wissen #914: render() can tear an open card down meanwhile).
      const open = this.detail;
      const file = this.app.vault.getFileByPath(path);
      if (file) {
        void this.app.vault.read(file).then((raw) => {
          if (this.detail !== open) return;
          const info = getFrontMatterInfo(raw);
          const body = info.exists ? raw.slice(info.contentStart) : raw;
          this.bodyByPath.set(path, body);
          open.detail.refreshBody(body);
        });
      }
      return;
    }
    // Obsidian's file watcher reports an *external* rename (011 K5-K8, e.g.
    // Node's fs.renameSync outside the app) not through `vault.on('rename')`
    // but as the old path disappearing and the new one being indexed fresh —
    // which surfaces here, as 'changed' for the new path, once its metadata
    // resolves. Retargeting on every 'changed', not only on an actual
    // `onRename` call, is what catches that case; a no-op otherwise.
    this.retargetDetail();
    this.scheduleReconcile();
  }

  // Called by the plugin (main.ts#onVaultRename) after the shared
  // ElementIndex already reflects the rename: retargets an open detail via
  // its `ktm_id` (011 K5-K8), then falls back to the normal debounced
  // reconcile for everything else the rename might affect (a card's own
  // column entry, a parent chip elsewhere).
  onRename(_newPath: string, _oldPath: string): void {
    this.retargetDetail();
    this.scheduleReconcile();
  }

  // Called by the plugin (main.ts#onVaultDelete). An open detail whose own
  // note was deleted is left exactly as it is (closeDetail already refuses
  // to write and shows a notice, 008 S45); everything else the board might
  // need to drop follows the normal debounced reconcile.
  onDelete(_path: string): void {
    this.scheduleReconcile();
  }

  // Keeps an open detail card pointed at its own note through a rename or a
  // move, including a move outside every root, and a rename Obsidian reports
  // as delete+create (011 K5-K8): identity comes from `ktm_id`, recomputed
  // purely in memory from the already-updated index (no vault access), so
  // repeated calls for the same move (a folder rename plus a per-child event,
  // Wissen #6) cost nothing beyond the first and a draft (no id) is left
  // untouched.
  private retargetDetail(): void {
    const open = this.detail;
    if (!open || open.id === undefined) return;
    const fresh = this.freshElement(open.id);
    if (!fresh || fresh.paths.note === open.path) return;

    const target = fresh.paths.note;
    this.elementByPath.delete(open.path);
    this.elementByPath.set(target, fresh);
    const body = this.bodyByPath.get(open.path);
    if (body !== undefined) {
      this.bodyByPath.delete(open.path);
      this.bodyByPath.set(target, body);
    }
    open.path = target;
    open.cardEl.setAttribute('data-card-id', target);
    open.detail.refreshLocation(fresh.paths, fresh.ownFolder === true);
  }

  // The element carrying `id` as the shared ElementIndex currently sees it
  // (002, Ergänzung 2026-10-19): the same computation retargetDetail used to
  // do inline, now shared with closeDetail's rebase() check.
  private freshElement(id: string): BoardElement | undefined {
    return this.freshElements().find((el) => el.id === id);
  }

  // Every element as the shared ElementIndex currently sees it, read fresh
  // right now rather than waiting for the next debounced render (used by
  // freshElement and, after a Result assignment, resultTargetLabel — wissen
  // #857: a note another note's write just touched needs this, not
  // `elementByPath`, which only catches up on the next render).
  private freshElements(): BoardElement[] {
    const entries = this.plugin.index.latestEntries();
    const roots = this.plugin.index.roots();
    const resolved = resolveProjectSettings(entries);
    const visible = withoutHiddenProjects(entries, roots, resolved.projects);
    const levelsFor = (project: string) => this.projectSettings(project).levels;
    const linkKindsFor = (project: string) => this.projectSettings(project).linkKinds;
    return readElements(visible.entries, visible.roots, linkKindsFor, levelsFor);
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

  // The board's own writes echo through the same events; the reconciling
  // guard drops those and the debounce lands a single reconciling render well
  // within two seconds. An open card no longer defers this (002, Ergänzung
  // 2026-10-18 "Karte bleibt offen"): render() carries it through instead.
  //
  // The guard above only stops a timer from being *planned* while reconciling
  // is already true; a timer planned earlier still fires on schedule even if
  // reconciling turns true in between (wissen #584/#775-adjacent race: an
  // external status edit both a) triggers main.ts#placeElement's own move,
  // wrapped in this same reconciling flag via runReconciling, and b) reaches
  // this scheduler through the plain metadataCache 'changed' event first,
  // since maybePlaceAfterChange only starts the move afterwards). Rendering
  // then, mid-move, would read the note at its old, about-to-vanish path and
  // reconcileDone's own writeFrontmatter races the rename underneath it
  // (ENOENT). The timer callback re-checks reconciling at *execution* time
  // too and defers to reconcileMissed/catchUpReconcile for that case.
  private scheduleReconcile(): void {
    if (this.reconciling) return;
    const win = this.contentEl.win;
    if (this.reconcileTimer !== undefined) win.clearTimeout(this.reconcileTimer);
    this.reconcileTimer = win.setTimeout(() => {
      this.reconcileTimer = undefined;
      if (this.reconciling) {
        this.reconcileMissed = true;
        return;
      }
      void this.render();
    }, RECONCILE_DEBOUNCE);
  }

  // Catches up once a detail overlay is fully gone without a render of its
  // own (closeDetail's no-change path, closeDraft's empty-title discard):
  // scheduleReconcile() itself is reused so the usual debounce still applies,
  // and it is a no-op when nothing was actually missed.
  private catchUpReconcile(): void {
    if (!this.reconcileMissed) return;
    this.reconcileMissed = false;
    this.scheduleReconcile();
  }

  // An open card never defers this redraw (002, Ergänzung 2026-10-18 "Karte
  // bleibt offen"): render() builds the whole board fresh and reattaches the
  // surviving card via {@link reattachDetail} — the same mechanism
  // `closeDraft`'s failure path already relies on.
  private async render(): Promise<void> {
    const seq = ++this.renderSeq;
    this.reconcileMissed = false;
    await this.plugin.reloadSettings();
    await this.plugin.indexReady;
    if (seq !== this.renderSeq) return;
    // Set before reconcileDone runs (below): reconcileCompleted stamps
    // `completed` with `this.today`, which must already be this render's own
    // value, not whatever the previous render last left behind.
    this.today = todayISO((this.contentEl.win as KtmWindow).__ktmToday);

    // Index read and reconcileDone run inside the plugin's exclusive section
    // (F123, Wissen #829): so this never reads, or stamps `completed` on,
    // a note mid-move by a concurrently running placeElement, and a move
    // started elsewhere never reads this render's half-updated state either.
    const { entries, resolved, visible, elements, reconcile } = await this.plugin.runExclusive(async () => {
      const entries = this.plugin.index.entries();
      const roots = this.plugin.index.roots();
      const resolved = resolveProjectSettings(entries);
      // A hidden project (F085, 006 addendum 2026-09-24) is dropped from
      // this.projects (view dropdown, currentProject, projectSettings) and its
      // files from what readElements/renderToday ever see (K18-K20); the
      // settings page reads resolveProjectSettings itself and keeps it visible
      // there (K22).
      this.projects = orderProjects(resolved.projects, this.plugin.settings.projectOrder).filter((p) => !p.hidden);
      const visible = withoutHiddenProjects(entries, roots, resolved.projects);
      const levelsFor = (project: string) => this.projectSettings(project).levels;
      const linkKindsFor = (project: string) => this.projectSettings(project).linkKinds;
      const elements = readElements(visible.entries, visible.roots, linkKindsFor, levelsFor);
      // An open card (002, Ergänzung 2026-10-18 "Karte bleibt offen") never
      // gets `completed` stamped on its own note by this redraw: it may hold
      // unsaved edits, and this read reflects the vault, not them.
      const reconcile = await this.reconcileDone(elements, this.detail?.path);
      return { entries, resolved, visible, elements, reconcile };
    });

    this.elementByPath.clear();
    for (const el of elements) this.elementByPath.set(el.paths.note, el);
    this.bodyByPath.clear();
    for (const entry of visible.entries) this.bodyByPath.set(entry.path, entry.body);
    this.knownIds = new Set(
      entries
        .map((e) => e.frontmatter.ktm_id)
        .filter((id): id is string => typeof id === 'string' && id.trim() !== ''),
    );
    this.roots = visible.roots;

    if (reconcile.changed) {
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
    const parsedFilter = parseFilterEntries(this.plugin.settings.filters?.[this.view] ?? []);
    this.filterSelection = {
      ids: pruneSelection(parsedFilter.ids, elements),
      statuses: parsedFilter.statuses,
      tags: parsedFilter.tags,
    };
    const rawSpotlight = this.plugin.settings.spotlights?.[this.view];
    // `tag:`/`status:`/`project:` (001, Ergänzung 2026-10-25) sind nie ein
    // Element und werden deshalb nicht über pruneSelection geprüft; sie
    // fallen still weg, falls Tag/Status/Projekt im Vault verschwinden
    // ("Ausserhalb", kein Kriterium), aber nicht bei jedem render().
    const isPrefixed = (v: string): boolean => v.startsWith('tag:') || v.startsWith('status:') || v.startsWith('project:');
    this.spotlightId =
      rawSpotlight && (isPrefixed(rawSpotlight) || pruneSelection(new Set([rawSpotlight]), elements).size > 0)
        ? rawSpotlight
        : undefined;

    // An open card (002, Ergänzung 2026-10-18 "Karte bleibt offen") is always
    // carried through, never torn down here: discardDetail now only runs
    // when the view itself closes (onClose).
    let keptOpen: OpenDetail | undefined;
    let keptBase: OpenDetail | undefined;
    let keptFocus: DetailFocus | undefined;
    if (this.detail) {
      keptOpen = this.detail;
      keptBase = this.stackedBase;
      // Captured now, the last moment the card is still connected to the
      // document: contentEl.empty() below detaches it, which drops focus
      // without leaving a trace to restore it from afterwards.
      keptFocus = this.captureDetailFocus(keptOpen);
      this.detail = undefined;
      this.stackedBase = undefined;
    }
    this.contentEl.empty();
    this.contentEl.addClass('ktm-board-host');
    this.rendered = true;
    const boardEl = this.contentEl.createDiv({ cls: 'ktm-board' });
    // CSS zoom statt einer transform: skaliert jedes px-, Token- und Rohmaß der
    // Ansicht auf einmal, der Obsidian-Zoom multipliziert sich von selbst dazu
    // (001, Ergänzung 2026-10-24 "Eigene Größe des Boards").
    boardEl.style.zoom = String(this.boardZoomFactor());
    boardEl.setAttribute('data-button-style', buttonStyleOf(this.plugin.settings.buttonStyle));
    this.renderToolbar(boardEl, levels, elements);

    // An empty ktm_root is a project with no Standardablage (011, Ergänzung
    // 2026-09-25, S83 "Root-Grenzfälle"), not a missing folder: the error
    // card is reserved for a configured, non-empty root that does not exist.
    if (project && project.root && !folderExists(this.app, project.root)) {
      this.renderError(boardEl, project.root);
      if (keptOpen) this.reattachDetail(keptOpen, keptBase, keptFocus);
      return;
    }

    this.columns = resolveColumns(this.plugin.settings, project);
    this.doneLimit = settingsFor(this.plugin.settings, project).doneLimit;
    const board = buildBoard(elements, this.filter(), this.columns, {
      level: this.level,
      bottomLevel: bottomLevel(levels)?.key,
      doneLimit: this.doneLimit,
      filterSelection: this.filterSelection.ids,
      filterTags: this.filterSelection.tags,
    });
    this.showNotices([
      ...resolved.notices,
      ...generalColumnNotices(this.plugin.settings),
      ...board.notices,
      ...reconcile.notices,
      ...this.legacyNotice(),
    ]);

    // Darstellungen jenseits des Boards ersetzen hier den Hauptinhalt; alle
    // bisherigen bleiben das Board (012, Wissen #1356). Die Agenda zeigt
    // keinen Bereich Heute (012 "Für alle Darstellungen": der steht nur über
    // Board, Baum und Portfolio).
    if (this.mode === 'week') {
      this.renderWeek(boardEl, elements, levels);
    } else if (this.mode === 'agenda') {
      this.renderAgenda(boardEl, elements, levels);
    } else if (this.mode === 'tree') {
      this.renderToday(boardEl, elements);
      this.renderTree(boardEl, elements);
    } else if (this.mode === 'roadmap') {
      this.renderRoadmap(boardEl, elements);
    } else if (this.mode === 'matrix') {
      this.renderMatrix(boardEl, elements, levels);
    } else if (this.mode === 'retro') {
      this.renderRetro(boardEl, elements, levels);
    } else if (this.mode === 'portfolio') {
      // Bereich Heute nur bei Kacheln Projekte (012 "Für alle Darstellungen",
      // DESIGN.md Komponente Bereich Heute: "nur bei Kacheln Projekte").
      if (this.portfolioKind() === 'project') this.renderToday(boardEl, elements);
      this.renderPortfolio(boardEl, elements);
    } else {
      this.renderToday(boardEl, elements);
      const columnsEl = boardEl.createDiv({ cls: 'ktm-columns' });
      for (const column of board.columns) {
        this.renderColumn(columnsEl, column, this.today);
      }
    }

    if (keptOpen) this.reattachDetail(keptOpen, keptBase, keptFocus);
    this.restoreDrag();
  }

  // Ein laufendes Ziehen übersteht ein Neuzeichnen (003, Ergänzung 2026-10-18
  // "Auch unter Last", U3, K9/K10): die alten Elemente sind mit
  // contentEl.empty() oben verschwunden, drag.card also verwaist. Hier wird
  // die neue Karte mit demselben Pfad wieder als die gezogene markiert und der
  // Platzhalter wieder an seinen Anker gesetzt. Ist die Anker-Karte selbst
  // verschwunden, übernimmt updateDropTarget mit der zuletzt bekannten
  // Zeigerposition. Ein Ghost im document.body bleibt unberührt, er hängt
  // nicht an dieser View.
  private restoreDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    const card = this.contentEl.querySelector<HTMLElement>(`.ktm-card[data-card-id="${drag.path}"]`);
    if (card) drag.card = card;
    if (!drag.active || !drag.placeholder) return;
    card?.setAttribute('data-dragging', 'true');

    const anchorGone =
      drag.beforePath !== undefined &&
      !this.contentEl.querySelector(`.ktm-card[data-card-id="${drag.beforePath}"]`);
    if (anchorGone) {
      if (drag.lastX !== undefined && drag.lastY !== undefined) {
        this.updateDropTarget(drag, drag.lastX, drag.lastY);
      }
      return;
    }

    const column = drag.targetStatus
      ? this.contentEl.querySelector<HTMLElement>(`.ktm-column[data-status="${drag.targetStatus}"]`)
      : drag.targetDay !== undefined
        ? this.contentEl.querySelector<HTMLElement>(`.ktm-column[data-day="${drag.targetDay}"]`)
        : drag.targetQuadrant !== undefined
          ? this.contentEl.querySelector<HTMLElement>(`.ktm-column[data-quadrant="${drag.targetQuadrant}"]`)
          : null;
    drag.targetColumn = column ?? undefined;
    if (!column) return;
    column.setAttribute('data-drop-target', 'true');
    const body = column.querySelector<HTMLElement>('.ktm-column-body');
    if (!body) return;
    const before = drag.beforePath
      ? body.querySelector<HTMLElement>(`.ktm-card[data-card-id="${drag.beforePath}"]`)
      : null;
    if (before) body.insertBefore(drag.placeholder, before);
    else body.appendChild(drag.placeholder);
  }

  // "Bestand noch nicht übernommen" (011 S69, #769): a plain board notice,
  // named the count of legacy 0.0.1 notes and the command that adopts them.
  private legacyNotice(): string[] {
    const count = this.plugin.legacyCount();
    if (count === 0) return [];
    return [
      `Bestand noch nicht übernommen: ${count} Notizen. Befehl „Bestand übernehmen“ in der Befehlspalette.`,
    ];
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

  // The focused field (if any) and the card's own scroll position, read
  // before `render()` detaches the card's DOM subtree (reattachDetail below
  // restores both once the card is back in the document).
  private captureDetailFocus(open: OpenDetail): DetailFocus {
    const active = open.cardEl.ownerDocument.activeElement;
    const field =
      (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && open.cardEl.contains(active)
        ? { el: active, selectionStart: active.selectionStart, selectionEnd: active.selectionEnd }
        : undefined;
    return { field, scrollTop: open.cardEl.scrollTop };
  }

  // Re-parents an already-open detail overlay (cardEl, coverEl, and the
  // dimmed stacked base beneath it, if any) onto the freshly rendered board
  // after a failed write (008 S45/S46, F068 K1/K2) or a keep-open redraw
  // (002, Ergänzung 2026-10-18): the CardDetail instance and its unsaved
  // edits are kept as they are, only their DOM host moves. `base` is only
  // ever passed by closeDraft, after render() has run with `this.stackedBase`
  // already cleared. `focus` restores what captureDetailFocus read before the
  // detach, so a description in edit keeps its cursor and selection.
  private reattachDetail(open: OpenDetail, base?: OpenDetail, focus?: DetailFocus): void {
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
    if (focus) {
      open.cardEl.scrollTop = focus.scrollTop;
      if (focus.field) {
        focus.field.el.focus();
        if (focus.field.selectionStart !== null && focus.field.selectionEnd !== null) {
          focus.field.el.setSelectionRange(focus.field.selectionStart, focus.field.selectionEnd);
        }
      }
    }
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

  // Keeps `completed` in step with status, no matter who set it, purely as a
  // field (011, Ablageregel 1): a closed status without one is stamped with
  // today, an open one that still carries one has it cleared. Runs on each
  // read and on the debounced changed event, so an external status edit lands
  // within two seconds. The Done/-Ordner-Umzug itself no longer happens here
  // (wissen #656 superseded): it hangs only on this element's own status
  // change through the interactive paths, main.ts#fileByStatus. Returns
  // whether anything changed, so the caller re-reads the vault before
  // drawing, plus the notices for a write that failed (008 S46-style).
  private async reconcileDone(
    elements: BoardElement[],
    skipPath?: string,
  ): Promise<{ changed: boolean; notices: string[] }> {
    this.reconciling = true;
    try {
      const notices: string[] = [];
      let changed = false;
      for (const el of elements) {
        if (el.invalid) continue;
        if (skipPath && el.paths.note === skipPath) continue;
        const change = reconcileCompleted({ done: this.doneElement(el).done, completed: el.completed }, this.today);
        if (!change) continue;
        try {
          await writeFrontmatter(this.app, el.paths.note, change);
          changed = true;
        } catch (err) {
          notices.push(`Aktualisierung übersprungen: ${el.paths.note} (${errorMessage(err)})`);
        }
      }
      return { changed, notices };
    } finally {
      this.reconciling = false;
    }
  }

  // The Done reconciliation (planDone) keys "closed" off the status itself
  // (F066): done/wont-do always close, an invalid element (status '') or an
  // unknown status stays undefined and is left alone. guardMove and the drop
  // path keep using doneStatuses(), which stays column-based (#479).
  private doneElement(el: BoardElement): DoneElement {
    const base = el.form === 'atomic' ? ATOMIC_BASE : rootForPath(el.paths.note, this.roots);
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
    if (this.isSavedView(this.view)) return;
    if (!this.projects.some((p) => p.key === this.view)) this.view = VIEW_ALL;
  }

  private currentProject(): ProjectSettings | undefined {
    return this.projects.find((p) => p.key === this.view);
  }

  private savedViews(): SavedView[] {
    return this.plugin.settings.savedViews ?? [];
  }

  private isSavedView(key: string): boolean {
    return this.savedViews().some((v) => v.key === key);
  }

  // Eine gespeicherte Ansicht reicht über alle Projekte wie "Alle Aufgaben"
  // und hat deren Spalten (001, Ergänzung 2026-10-18, "Gespeicherte
  // Ansichten"): überall, wo bisher nur VIEW_ALL geprüft wurde, gilt jetzt
  // dieser weitere Test mit.
  private isAllScope(): boolean {
    return this.view === VIEW_ALL || this.isSavedView(this.view);
  }

  private filter(): BoardFilter {
    if (this.isAllScope()) return { kind: 'all' };
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

  private renderToolbar(parent: HTMLElement, levels: Level[], elements: BoardElement[]): void {
    const toolbar = parent.createDiv({ cls: 'ktm-toolbar' });

    const newTask = toolbar.createEl('button', { cls: 'ktm-button ktm-new-task' });
    setIcon(newTask.createSpan({ cls: 'ktm-button-icon' }), 'plus');
    newTask.createSpan({ text: 'Neue Aufgabe' });
    this.registerDomEvent(newTask, 'click', () => {
      (this.app as DesktopApp).commands.executeCommandById(NEW_TASK_COMMAND);
    });

    // Darstellungs-Schalter direkt rechts von "Neue Aufgabe" (012, Ergänzung
    // 2026-10-25 "Darstellungen"; DESIGN.md Komponente "Darstellungs-Schalter").
    this.renderViewSwitch(toolbar);

    toolbar.createDiv({ cls: 'ktm-toolbar-spacer' });

    const controls = toolbar.createDiv({ cls: 'ktm-toolbar-controls' });
    // Die Marke der Hervorhebung steht vor dem Filterfeld, auch in "intern"
    // vor dem Ebenen-Schalter (001, Ergänzung 2026-10-18, DESIGN.md
    // "Marke der Hervorhebung").
    this.renderSpotlightMark(controls, elements);
    // Kein Filterfeld in "intern": dort gibt es keine Hierarchie (001,
    // Ergänzung 2026-10-18, "Kein Filter in intern"). Ein Trennstrich (006,
    // Ergänzung 2026-10-25 "Buttonstil", nur im Stil Ghost sichtbar) steht
    // nur zwischen zwei tatsächlich vorhandenen Teilen, damit in "intern"
    // oder bei allLevels "bottom" keiner am Rand hängt.
    const parts: Array<() => void> = [];
    if (this.view !== VIEW_INTERNAL) parts.push(() => this.renderFilterField(controls, elements));
    // Im Portfolio ersetzt der Schalter "Features, Epics, Projekte" den
    // Ebenen-Schalter an derselben Stelle (012 "Portfolio").
    if (this.mode === 'portfolio') parts.push(() => this.renderPortfolioSwitch(controls));
    else if (levels.length > 0) parts.push(() => this.renderLevelSegment(controls, levels));
    // Die Marke "geändert" steht im selben Teil wie das Ansicht-Menü, direkt
    // davor (012, Ergänzung 2026-10-25 "Marke 'geändert'"): kein eigener
    // Trennstrich zwischen beiden.
    parts.push(() => {
      this.renderChangedMark(controls);
      this.renderViewDropdown(controls);
    });
    parts.push(() => this.renderScaleControl(controls));
    parts.forEach((renderPart, i) => {
      if (i > 0) controls.createDiv({ cls: 'ktm-toolbar-sep' });
      renderPart();
    });
  }

  // Acht Icon-Buttons in resolveViewOrder-Folge (012 S1/S3); Ziehen läuft über
  // onPointerDown/onPointerMove/onPointerUp (Muster viewDrag, getrennt vom
  // Kartenzug), ein Klick ohne Zug wechselt die Darstellung über setMode.
  private renderViewSwitch(parent: HTMLElement): void {
    const switchEl = parent.createDiv({ cls: 'ktm-viewswitch' });
    const order = resolveViewOrder(this.plugin.settings.viewOrder);
    for (const key of order) {
      const mode = VIEW_MODES.find((m) => m.key === key);
      if (!mode) continue;
      const button = switchEl.createEl('button', {
        cls: 'ktm-viewswitch-button',
        attr: { 'data-mode': mode.key, 'data-active': String(mode.key === this.mode), 'aria-label': mode.name },
      });
      setIcon(button, mode.icon);
    }
  }

  // Wechselt die Darstellung (012 S2) ohne irgendetwas zu speichern — erst
  // dadurch kann sie von der gemerkten/gespeicherten Darstellung abweichen und
  // die Marke "geändert" entsteht.
  private setMode(mode: string): void {
    if (mode === this.mode) return;
    if (this.mode === 'week' || this.mode === 'retro') {
      // Die gewählte Woche gilt nur, bis die Darstellung verlassen wird (012
      // "Woche"/"Rückblick", wiederverwendeter Wochenkopf): kein gemerkter
      // Zustand über das Verlassen hinaus.
      this.weekStartByView.clear();
      this.weekCalOpen = false;
      this.weekCalCleanup?.();
      this.weekCalCleanup = undefined;
    }
    if (this.mode === 'roadmap') {
      this.roadmapCalOpen = false;
      this.roadmapPickFirst = undefined;
      this.roadmapCalCleanup?.();
      this.roadmapCalCleanup = undefined;
    }
    this.mode = mode;
    void this.render();
  }

  private currentWeekStart(): string {
    return this.weekStartByView.get(this.view) ?? mondayOf(this.today);
  }

  private weekRangeLabel(monday: string): string {
    const end = addDays(monday, 6);
    const [, sm, sd] = monday.split('-');
    const [ey, em, ed] = end.split('-');
    return `${sd}.${sm}. – ${ed}.${em}.${ey}`;
  }

  // Woche mit Tagesspalten Mo–So und "Ohne Datum" (012 "Woche"): Karten kommen
  // flach aus buildBoard (keine Status-Spalten, kein doneLimit) und werden
  // über assignWeek auf die Tage verteilt.
  private renderWeek(parent: HTMLElement, elements: BoardElement[], levels: Level[]): void {
    const monday = this.currentWeekStart();
    this.renderWeekHeader(parent, monday);
    const weekBoard = buildBoard(elements, this.filter(), this.columns, {
      level: this.level,
      bottomLevel: bottomLevel(levels)?.key,
      filterSelection: this.filterSelection.ids,
      filterTags: this.filterSelection.tags,
    });
    const cards = weekBoard.columns.flatMap((c) => c.cards.filter((card) => !card.invalid));
    const assignment = assignWeek(cards, monday, this.columns);
    const weekEl = parent.createDiv({ cls: 'ktm-week' });
    for (let i = 0; i < 7; i++) {
      const day = addDays(monday, i);
      this.renderWeekColumn(weekEl, day, assignment.days[day] ?? [], i >= 5);
    }
    this.renderWeekColumn(weekEl, 'none', assignment.nodate, false);
  }

  private renderWeekColumn(parent: HTMLElement, day: string, cards: BoardElement[], weekend: boolean): void {
    const isToday = day === this.today;
    const isPast = day !== 'none' && day < this.today;
    const columnEl = parent.createDiv({
      cls: 'ktm-column ktm-week-day',
      attr: {
        'data-day': day,
        ...(weekend ? { 'data-weekend': 'true' } : {}),
        ...(isToday ? { 'data-today': 'true' } : {}),
        ...(isPast ? { 'data-past': 'true' } : {}),
      },
    });
    const header = columnEl.createDiv({ cls: 'ktm-column-header' });
    header.createSpan({
      cls: 'ktm-column-title',
      text: day === 'none' ? 'Ohne Datum' : absoluteDate(day, this.today),
    });
    const body = columnEl.createDiv({ cls: 'ktm-column-body' });
    if (cards.length === 0) {
      body.createDiv({ cls: 'ktm-empty' });
      return;
    }
    for (const card of cards) {
      this.renderCard(body, card, this.doneStatuses(card.project).has(card.status), this.today, true);
    }
  }

  // Unterkopf der Woche (012 "Woche"): Pfeile ±7 Tage, Datumsknopf mit
  // Wochenkalender-Popover, "Heute" ausgegraut in der aktuellen Woche.
  private renderWeekHeader(parent: HTMLElement, monday: string): void {
    const header = parent.createDiv({ cls: 'ktm-subheader' });

    const prev = header.createEl('button', { cls: 'ktm-week-prev', attr: { 'aria-label': 'Vorherige Woche' } });
    setIcon(prev, 'chevron-left');
    this.registerDomEvent(prev, 'click', () => void this.goToWeek(addDays(monday, -7)));

    const next = header.createEl('button', { cls: 'ktm-week-next', attr: { 'aria-label': 'Nächste Woche' } });
    setIcon(next, 'chevron-right');
    this.registerDomEvent(next, 'click', () => void this.goToWeek(addDays(monday, 7)));

    const dateWrap = header.createDiv({ cls: 'ktm-week-date-wrap' });
    const dateButton = dateWrap.createEl('button', { cls: 'ktm-week-date' });
    setIcon(dateButton.createSpan({ cls: 'ktm-week-date-icon' }), 'calendar');
    const week = isoWeek(Date.parse(`${monday}T00:00:00Z`));
    dateButton.createSpan({ cls: 'ktm-week-date-kw', text: `KW ${week}` });
    // Führendes Leerzeichen trennt "KW n" sichtbar vom Datumsbereich auch im
    // reinen Text (012 "Woche": "KW 37 07.09. – 13.09.2026" als ein Textfluss).
    dateButton.createSpan({ cls: 'ktm-week-date-range', text: ` ${this.weekRangeLabel(monday)}` });
    setIcon(dateButton.createSpan({ cls: 'ktm-week-date-chevron' }), 'chevron-down');
    this.registerDomEvent(dateButton, 'click', () => this.toggleWeekCal(dateWrap, monday));
    if (this.weekCalOpen) this.renderWeekCalendar(dateWrap, monday);

    const todayCurrent = monday === mondayOf(this.today);
    const todayBtn = header.createEl('button', {
      cls: 'ktm-week-today',
      text: 'Heute',
      attr: todayCurrent ? { disabled: 'true', 'aria-disabled': 'true' } : {},
    });
    this.registerDomEvent(todayBtn, 'click', () => {
      if (todayCurrent) return;
      void this.goToWeek(mondayOf(this.today));
    });
  }

  private async goToWeek(monday: string): Promise<void> {
    this.weekStartByView.set(this.view, monday);
    this.weekCalOpen = false;
    this.weekCalCleanup?.();
    this.weekCalCleanup = undefined;
    await this.render();
  }

  private toggleWeekCal(wrap: HTMLElement, monday: string): void {
    if (this.weekCalOpen) {
      this.closeWeekCal();
      return;
    }
    this.weekCalOpen = true;
    const [year, month] = monday.split('-').map(Number);
    this.weekCalMonth = { year, month };
    this.renderWeekCalendar(wrap, monday);
  }

  private closeWeekCal(): void {
    if (!this.weekCalOpen) return;
    this.weekCalOpen = false;
    this.weekCalCleanup?.();
    this.weekCalCleanup = undefined;
    this.contentEl.querySelector('.ktm-weekcal')?.remove();
  }

  // Wochenkalender-Popover (012 "Wochenkalender", DESIGN.md Komponente
  // gleichen Namens): je Woche eine Zeile mit KW und sieben Tagen; ein Klick
  // auf eine Zeile wählt die Woche und schließt. Neu gezeichnet bei jeder
  // Monatsnavigation, wie CardDetail#renderCalendar.
  private renderWeekCalendar(wrap: HTMLElement, selectedMonday: string): void {
    this.weekCalCleanup?.();
    this.weekCalCleanup = undefined;
    wrap.querySelector('.ktm-weekcal')?.remove();

    const [defaultYear, defaultMonth] = selectedMonday.split('-').map(Number);
    const { year, month } = this.weekCalMonth ?? { year: defaultYear, month: defaultMonth };
    const cal = wrap.createDiv({ cls: 'ktm-weekcal' });

    const head = cal.createDiv({ cls: 'ktm-weekcal-head' });
    const prev = head.createSpan({ cls: 'ktm-weekcal-nav' });
    setIcon(prev, 'chevron-left');
    head.createSpan({ cls: 'ktm-weekcal-title', text: `${MONTH_NAMES[month - 1]} ${year}` });
    const next = head.createSpan({ cls: 'ktm-weekcal-nav' });
    setIcon(next, 'chevron-right');
    this.registerDomEvent(prev, 'click', (ev) => {
      ev.stopPropagation();
      const [y, m] = shiftMonth(year, month, -1);
      this.weekCalMonth = { year: y, month: m };
      this.renderWeekCalendar(wrap, selectedMonday);
    });
    this.registerDomEvent(next, 'click', (ev) => {
      ev.stopPropagation();
      const [y, m] = shiftMonth(year, month, 1);
      this.weekCalMonth = { year: y, month: m };
      this.renderWeekCalendar(wrap, selectedMonday);
    });

    const headRow = cal.createDiv({ cls: 'ktm-weekcal-headrow' });
    headRow.createSpan({ cls: 'ktm-weekcal-week', text: 'KW' });
    for (const label of WEEKDAY_LABELS) headRow.createSpan({ text: label });

    const currentMonday = mondayOf(this.today);
    for (const week of monthGrid(year, month, this.today)) {
      const weekStart = week.days[0].date;
      const row = cal.createDiv({
        cls: 'ktm-weekcal-row',
        attr: {
          'data-week-start': weekStart,
          'data-selected': String(weekStart === selectedMonday),
          'data-current': String(weekStart === currentMonday),
        },
      });
      row.createSpan({ cls: 'ktm-weekcal-week', text: String(week.week) });
      for (const day of week.days) {
        row.createSpan({
          cls: 'ktm-weekcal-day',
          text: String(day.day),
          attr: {
            ...(day.otherMonth ? { 'data-other-month': 'true' } : {}),
            ...(day.isToday ? { 'data-today': 'true' } : {}),
          },
        });
      }
      this.registerDomEvent(row, 'click', () => void this.goToWeek(weekStart));
    }

    const foot = cal.createDiv({ cls: 'ktm-weekcal-foot' });
    foot.createSpan({ text: 'Zeile wählt die Woche' });
    const todayRow = foot.createSpan({ cls: 'ktm-weekcal-foot-today', text: 'Diese Woche' });
    this.registerDomEvent(todayRow, 'click', () => void this.goToWeek(currentMonday));

    this.installWeekCalHandlers(wrap);
  }

  private installWeekCalHandlers(wrap: HTMLElement): void {
    const doc = this.contentEl.doc;
    const onKeydown = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') this.closeWeekCal();
    };
    const onClick = (ev: MouseEvent): void => {
      const target = ev.target as HTMLElement;
      if (wrap.contains(target)) return;
      this.closeWeekCal();
    };
    doc.addEventListener('keydown', onKeydown, true);
    doc.addEventListener('click', onClick, true);
    this.weekCalCleanup = () => {
      doc.removeEventListener('keydown', onKeydown, true);
      doc.removeEventListener('click', onClick, true);
    };
  }

  // Agenda (012 "Agenda"): Karten wie renderWeek über buildBoard geholt
  // (Ebene, filterSelection ids und tags), zusätzlich nach
  // filterSelection.statuses gefiltert — buildBoard setzt die Status-Auswahl
  // für das Board absichtlich immer leer (S51), die Agenda ist aber eine der
  // Darstellungen, in denen die Status-Sektion wirken soll (012 "Für alle
  // Darstellungen"). Sortiert und gruppiert wird rein in core/agenda.ts.
  private renderAgenda(parent: HTMLElement, elements: BoardElement[], levels: Level[]): void {
    const bottomType = bottomLevel(levels)?.key ?? 'task';
    const agendaBoard = buildBoard(elements, this.filter(), this.columns, {
      level: this.level,
      bottomLevel: bottomType,
      filterSelection: this.filterSelection.ids,
      filterTags: this.filterSelection.tags,
    });
    const cards = agendaBoard.columns
      .flatMap((c) => c.cards.filter((card) => !card.invalid))
      .filter((card) => isVisibleUnderSelection(card, this.filterSelection, bottomType));
    const groups = agendaGroups(cards, this.today, this.columns);

    const host = parent.createDiv({ cls: 'ktm-agenda-host' });
    const agendaEl = host.createDiv({ cls: 'ktm-agenda' });
    this.renderAgendaHead(agendaEl);
    for (const group of groups) this.renderAgendaGroup(agendaEl, group);
  }

  private renderAgendaHead(parent: HTMLElement): void {
    const head = parent.createDiv({ cls: 'ktm-agenda-head' });
    const cell = (col: string, text = ''): void => {
      head.createDiv({ cls: 'ktm-agenda-cell', attr: { 'data-col': col }, text });
    };
    cell('title', 'Titel');
    cell('status', 'Status');
    cell('planned', 'Geplant');
    cell('due', 'Fällig');
    // Priorität ohne Beschriftung (DESIGN.md "Agenda"): die Spalte bleibt
    // trotzdem erhalten, damit Kopf- und Zeilenraster gleich viele Zellen
    // haben.
    cell('priority');
    cell('project', 'Projekt');
    cell('ancestors', 'Epic › Feature');
    cell('tags', 'Tags');
  }

  // Gruppenkopf klappt per Klick (012 "Agenda"); welche Gruppen eingeklappt
  // sind, ist flüchtig je Ansichtsinstanz (agendaCollapsedGroups), nicht
  // Teil von getState/data.json — ein neuer gemerkter Zustand würde sonst
  // vault:reset erneut betreffen (Wissen #1363).
  private renderAgendaGroup(parent: HTMLElement, group: AgendaGroup): void {
    const collapsed = this.agendaCollapsedGroups.has(group.key);
    const groupEl = parent.createDiv({ cls: 'ktm-agenda-group', attr: { 'data-group': group.key } });
    const head = groupEl.createDiv({ cls: 'ktm-agenda-group-head' });
    setIcon(head.createSpan({ cls: 'ktm-agenda-group-chevron' }), collapsed ? 'chevron-right' : 'chevron-down');
    head.createSpan({ cls: 'ktm-agenda-group-title', attr: { 'data-group': group.key }, text: group.name });
    if (group.range) head.createSpan({ cls: 'ktm-agenda-group-range', text: group.range });
    head.createSpan({ cls: 'ktm-agenda-group-count', text: String(group.cards.length) });
    this.registerDomEvent(head, 'click', () => this.toggleAgendaGroup(group.key));
    if (collapsed) return;
    const rows = groupEl.createDiv({ cls: 'ktm-agenda-rows' });
    for (const card of group.cards) this.renderAgendaRow(rows, card);
  }

  private toggleAgendaGroup(key: string): void {
    if (this.agendaCollapsedGroups.has(key)) this.agendaCollapsedGroups.delete(key);
    else this.agendaCollapsedGroups.add(key);
    void this.render();
  }

  // Zeile der Agenda (012 "Agenda"): .ktm-agenda-row statt .ktm-card und
  // außerhalb von .ktm-columns/.ktm-week, damit onPointerDown (dessen Guard
  // genau diese beiden Container prüft) nie ein Ziehen beginnt — die Agenda
  // bleibt so ohne eigenen Code nur zum Lesen (012 "Nur zum Lesen", Wissen
  // #1362). Ein Klick öffnet die Karte direkt, nicht über den Zugzustand.
  private renderAgendaRow(parent: HTMLElement, card: BoardElement): void {
    const rowEl = parent.createDiv({
      cls: 'ktm-agenda-row',
      attr: {
        'data-card-id': card.paths.note,
        'data-status': card.status,
        ...(this.spotlightId !== undefined && !isUnderSpotlight(card, this.spotlightId)
          ? { 'data-spotlight': 'dim' }
          : {}),
      },
    });

    rowEl.createDiv({
      cls: 'ktm-agenda-cell ktm-agenda-title',
      attr: { 'data-col': 'title', title: card.title },
      text: card.title,
    });

    const statusCell = rowEl.createDiv({ cls: 'ktm-agenda-cell', attr: { 'data-col': 'status' } });
    renderStatusMark(statusCell, card.status, this.statusNameFor(card), statusTone(card.status, this.columns));

    const plannedCell = rowEl.createDiv({ cls: 'ktm-agenda-cell', attr: { 'data-col': 'planned' } });
    if (card.planned) {
      const state = dueState(card.planned, this.today) === 'today' ? 'today' : undefined;
      metaItem(plannedCell, 'ktm-card-planned', 'calendar', relativeDate(card.planned, this.today), {
        'data-planned': state,
      });
    }

    const dueCell = rowEl.createDiv({ cls: 'ktm-agenda-cell', attr: { 'data-col': 'due' } });
    if (card.due) {
      metaItem(dueCell, 'ktm-card-due', 'flag', relativeDate(card.due, this.today), {
        'data-due': dueState(card.due, this.today),
      });
    }

    const priorityCell = rowEl.createDiv({ cls: 'ktm-agenda-cell', attr: { 'data-col': 'priority' } });
    const icon = priorityIcon(card.priority);
    if (icon) {
      const prioEl = priorityCell.createSpan({
        cls: 'ktm-card-meta-item ktm-card-priority',
        attr: { 'data-priority': String(card.priority) },
      });
      setIcon(prioEl, icon);
    }

    const projectCell = rowEl.createDiv({ cls: 'ktm-agenda-cell', attr: { 'data-col': 'project' } });
    projectCell.createSpan({
      cls: 'ktm-card-chip ktm-card-project',
      text: card.project || 'intern',
      attr: { 'data-project': card.project ?? '' },
    });

    const ancestorsCell = rowEl.createDiv({ cls: 'ktm-agenda-cell', attr: { 'data-col': 'ancestors' } });
    for (const ancestor of this.ancestorChips(card)) {
      renderParentChip(ancestorsCell, ancestor.icon, ancestor.title, ancestor.levelName, ancestor.fullTitle, ancestor.id);
    }

    const tagsCell = rowEl.createDiv({ cls: 'ktm-agenda-cell', attr: { 'data-col': 'tags' } });
    const stripHash = (t: string): string => (t.startsWith('#') ? t.slice(1) : t);
    const tagList = effectiveTags(this.plugin.settings, this.projects.find((p) => p.key === card.project));
    const split = splitTagChips(card.tags, tagList);
    const visible = visibleTags(split.text);
    for (const chip of split.icons) {
      const iconChip = tagsCell.createSpan({
        cls: 'ktm-card-chip ktm-chip is-icon',
        attr: { 'aria-label': chip.tag, 'data-tag': stripHash(chip.tag) },
      });
      setIcon(iconChip, chip.icon);
    }
    for (const tag of visible.shown) {
      tagsCell.createSpan({ cls: 'ktm-card-chip ktm-card-tag', text: stripHash(tag), attr: { 'data-tag': stripHash(tag) } });
    }
    if (visible.rest > 0) {
      tagsCell.createSpan({ cls: 'ktm-card-chip ktm-card-tagmore', text: `+${visible.rest}` });
    }

    this.installAncestorChipHandlers(rowEl);
    this.registerDomEvent(rowEl, 'click', () => {
      const element = this.elementByPath.get(card.paths.note);
      if (element) void this.openDetail(element);
    });
  }

  // Baum (012 "Baum"): Projekt › Epic › Feature › Task als Tabelle, über
  // buildTree/sortTree in core/tree.ts. Die Projektreihenfolge folgt dem
  // Ansicht-Menü (intern zuerst, dann this.projects, Wissen #1036); eine
  // Projekt- oder "intern"-Ansicht zeigt nur ihr eigenes Projekt, da nur
  // dessen Schlüssel in `projects` steht (buildTree lässt alles andere weg).
  private renderTree(parent: HTMLElement, elements: BoardElement[]): void {
    const scope = this.filter();
    const projects: TreeProjectEntry[] =
      scope.kind === 'project'
        ? [{ key: scope.project, name: this.projectDisplayName(scope.project) }]
        : scope.kind === 'internal'
          ? [{ name: 'Intern' }]
          : [{ name: 'Intern' }, ...this.projects.map((p) => ({ key: p.key, name: p.name }))];
    const levelContext: LevelContext = {
      generalLevels: resolveLevels(this.plugin.settings),
      projectLevels: Object.fromEntries(this.projects.map((p) => [p.key, this.projectSettings(p.key).levels])),
      allLevels: this.plugin.settings.allLevels ?? 'rank',
    };
    const rows = buildTree(elements, projects, {
      columns: this.columns,
      levelContext,
      level: this.level,
      filterSelection: this.filterSelection,
    });
    const sort = parseTreeSort(this.plugin.settings.treeSort?.[this.view]);
    const sorted = sortTree(rows, sort, this.columns);

    const host = parent.createDiv({ cls: 'ktm-tree-host' });
    const treeEl = host.createDiv({ cls: 'ktm-tree' });
    this.renderTreeHead(treeEl, sort);

    const byId = new Map(sorted.map((r) => [r.id, r]));
    const parentIds = new Set(sorted.map((r) => r.parentKey));
    const hiddenByCollapse = (row: TreeRow): boolean => {
      let parentId = row.parentKey;
      while (parentId) {
        if (this.treeCollapsed.has(parentId)) return true;
        parentId = byId.get(parentId)?.parentKey ?? '';
      }
      return false;
    };
    for (const row of sorted) {
      if (hiddenByCollapse(row)) continue;
      this.renderTreeRow(treeEl, row, parentIds.has(row.id));
    }
  }

  private renderTreeHead(parent: HTMLElement, sort: TreeSort[]): void {
    const head = parent.createDiv({ cls: 'ktm-tree-head' });
    const titleCell = head.createDiv({ cls: 'ktm-tree-cell', attr: { 'data-col': 'title' } });
    titleCell.createSpan({ text: 'Titel' });
    if (sort.length > 0) {
      const reset = titleCell.createSpan({ cls: 'ktm-tree-reset' });
      setIcon(reset.createSpan({ cls: 'ktm-tree-reset-icon' }), 'x');
      reset.createSpan({ text: 'Sortierung zurücksetzen' });
      this.registerDomEvent(reset, 'click', () => void this.setTreeSort([]));
    }
    for (const col of TREE_HEAD_COLUMNS) {
      const cell = head.createDiv({ cls: 'ktm-tree-cell', attr: { 'data-col': col.key } });
      cell.createSpan({ text: col.label });
      const spec = sort.find((s) => s.key === col.key);
      if (spec) {
        cell.setAttribute('data-sort', spec.dir);
        setIcon(cell.createSpan({ cls: 'ktm-tree-sort-icon' }), spec.dir === 'asc' ? 'arrow-up' : 'arrow-down');
        cell.createSpan({ cls: 'ktm-tree-rank', text: String(sort.indexOf(spec) + 1) });
      } else {
        setIcon(cell.createSpan({ cls: 'ktm-tree-sort-icon ktm-tree-sort-hint' }), 'chevrons-up-down');
      }
      this.registerDomEvent(cell, 'click', () => void this.setTreeSort(cycleTreeSort(sort, col.key)));
    }
  }

  private async setTreeSort(sort: TreeSort[]): Promise<void> {
    await this.plugin.saveTreeSort(this.view, sort);
    await this.render();
  }

  private toggleTreeRow(id: string): void {
    if (this.treeCollapsed.has(id)) this.treeCollapsed.delete(id);
    else this.treeCollapsed.add(id);
    void this.render();
  }

  private treeLevelIcon(row: TreeRow): string {
    if (row.kind === 'project') return 'folder';
    return this.projectSettings(row.project).levels.find((l) => l.key === row.kind)?.icon ?? 'square';
  }

  private treeStatusName(row: TreeRow): string {
    return this.projectSettings(row.project).columns.find((c) => c.status === row.status)?.name ?? (row.status ?? '');
  }

  private renderTreeRow(parent: HTMLElement, row: TreeRow, hasChildren: boolean): void {
    const isProject = row.kind === 'project';
    const rowEl = parent.createDiv({
      cls: 'ktm-tree-row',
      attr: {
        'data-card-id': row.cardId,
        ...(isProject ? { 'data-kind': 'project' } : { 'data-type': row.kind, 'data-depth': String(row.depth) }),
        ...(row.parentKey ? { 'data-parent': row.parentKey } : {}),
        ...(row.due ? { 'data-due': row.due } : {}),
        ...(row.context ? { 'data-context': 'true' } : {}),
        ...(row.discarded ? { 'data-discarded': 'true' } : {}),
      },
    });

    const titleCell = rowEl.createDiv({ cls: 'ktm-tree-cell', attr: { 'data-col': 'title' } });
    const titleWrap = titleCell.createDiv({ cls: 'ktm-tree-title' });
    titleWrap.style.marginLeft = `calc(var(--ktm-tree-indent) * ${row.depth})`;
    if (hasChildren) {
      const chevron = titleWrap.createSpan({ cls: 'ktm-tree-chevron' });
      setIcon(chevron, this.treeCollapsed.has(row.id) ? 'chevron-right' : 'chevron-down');
      this.registerDomEvent(chevron, 'click', (ev) => {
        ev.stopPropagation();
        this.toggleTreeRow(row.id);
      });
    } else if (!isProject) {
      titleWrap.createSpan({ cls: 'ktm-tree-chevron ktm-tree-chevron-spacer' });
    }
    setIcon(titleWrap.createSpan({ cls: 'ktm-tree-icon' }), this.treeLevelIcon(row));
    titleWrap.createSpan({ cls: 'ktm-tree-title-text', text: row.title, attr: { title: row.title } });
    if (isProject) {
      const noun = row.openTasks === 1 ? 'offener Task' : 'offene Tasks';
      titleWrap.createSpan({ cls: 'ktm-tree-opentasks', text: `${row.openTasks ?? 0} ${noun}` });
    }

    if (!isProject) {
      const statusCell = rowEl.createDiv({ cls: 'ktm-tree-cell', attr: { 'data-col': 'status' } });
      renderStatusMark(statusCell, row.status ?? '', this.treeStatusName(row), statusTone(row.status ?? '', this.columns));

      const startedCell = rowEl.createDiv({
        cls: 'ktm-tree-cell',
        attr: { 'data-col': 'started', ...(row.startedDerived ? { 'data-derived': 'true' } : {}) },
      });
      if (row.startedDisplay) startedCell.createSpan({ cls: 'ktm-tree-date', text: shortDate(row.startedDisplay) });

      const plannedCell = rowEl.createDiv({ cls: 'ktm-tree-cell', attr: { 'data-col': 'planned' } });
      if (row.planned) {
        const state = dueState(row.planned, this.today) === 'today' ? 'today' : undefined;
        plannedCell.createSpan({
          cls: 'ktm-tree-date',
          text: relativeDate(row.planned, this.today),
          attr: state ? { 'data-state': state } : {},
        });
      }

      const dueCell = rowEl.createDiv({ cls: 'ktm-tree-cell', attr: { 'data-col': 'due' } });
      if (row.due) {
        dueCell.createSpan({
          cls: 'ktm-tree-date',
          text: relativeDate(row.due, this.today),
          attr: { 'data-state': dueState(row.due, this.today) ?? '' },
        });
      }

      const progressCell = rowEl.createDiv({ cls: 'ktm-tree-cell', attr: { 'data-col': 'progress' } });
      if (row.progress) {
        const pct = row.progress.total > 0 ? (100 * row.progress.done) / row.progress.total : 0;
        const bar = progressCell.createDiv({ cls: 'ktm-tree-progress-bar' });
        const fill = bar.createDiv({ cls: 'ktm-tree-progress-fill' });
        fill.style.width = `${pct}%`;
        progressCell.createSpan({ cls: 'ktm-tree-progress-label', text: `${row.progress.done}/${row.progress.total}` });
      }

      this.registerDomEvent(rowEl, 'click', () => {
        const element = this.elementByPath.get(row.cardId);
        if (element) void this.openDetail(element);
      });
    }
  }

  // Roadmap (012 S23-S28, "Roadmap"): Unterkopf, dann die feste Spalte und
  // die Zeitachse. Zeilen, Hierarchie und Filter mit Kontext kommen aus
  // roadmapRows (buildTree-Muster, Wissen #1374 für "Intern"); Form und
  // Position der Balken aus roadmapShape über Tagesbreite und Zeitraum. Kein
  // Bereich Heute (012 "Für alle Darstellungen").
  private renderRoadmap(parent: HTMLElement, elements: BoardElement[]): void {
    const state = parseRoadmapState(this.plugin.settings.roadmap?.[this.view], this.today);
    this.renderRoadmapHeader(parent, state);

    const scope = this.filter();
    const projects: TreeProjectEntry[] =
      scope.kind === 'project'
        ? [{ key: scope.project, name: this.projectDisplayName(scope.project) }]
        : scope.kind === 'internal'
          ? [{ name: 'Intern' }]
          : [{ name: 'Intern' }, ...this.projects.map((p) => ({ key: p.key, name: p.name }))];
    const levelContext: LevelContext = {
      generalLevels: resolveLevels(this.plugin.settings),
      projectLevels: Object.fromEntries(this.projects.map((p) => [p.key, this.projectSettings(p.key).levels])),
      allLevels: this.plugin.settings.allLevels ?? 'rank',
    };
    const rows = roadmapRows(elements, projects, {
      columns: this.columns,
      levelContext,
      level: this.level,
      filterSelection: this.filterSelection,
      today: this.today,
    });

    const totalDays = (dayDiff(state.end, state.start) ?? 0) + 1;
    const dayWidth = ROADMAP_DAY_WIDTH[state.grid];
    const trackWidth = totalDays * dayWidth;

    const road = parent.createDiv({
      cls: 'ktm-road',
      attr: { 'data-range-start': state.start, 'data-range-end': state.end, 'data-grid': state.grid },
    });

    const head = road.createDiv({ cls: 'ktm-road-head' });
    head.createDiv({ cls: 'ktm-road-label ktm-road-corner' });
    const axisHead = head.createDiv({ cls: 'ktm-road-axis-head' });
    axisHead.style.width = `${trackWidth}px`;
    const { top, bottom } = roadmapHeaderCells(state, this.today);
    const topRow = axisHead.createDiv({ cls: 'ktm-road-head-top' });
    for (const cell of top) {
      const cellEl = topRow.createSpan({
        cls: 'ktm-road-head-cell',
        text: cell.label,
        attr: { 'data-days': String(cell.days), ...(cell.current ? { 'data-current': 'true' } : {}) },
      });
      cellEl.style.width = `${cell.days * dayWidth}px`;
    }
    const bottomRow = axisHead.createDiv({ cls: 'ktm-road-head-bottom' });
    let cumulative = 0;
    for (const cell of bottom) {
      const cellEl = bottomRow.createSpan({
        cls: 'ktm-road-head-cell',
        text: cell.label,
        attr: { 'data-days': String(cell.days), ...(cell.current ? { 'data-current': 'true' } : {}) },
      });
      cellEl.style.width = `${cell.days * dayWidth}px`;
      cumulative += cell.days * dayWidth;
      if (cumulative < trackWidth - 0.5) {
        const gridline = road.createDiv({ cls: 'ktm-road-gridline' });
        gridline.style.left = `calc(var(--ktm-road-label) + ${cumulative}px)`;
      }
    }

    const body = road.createDiv({ cls: 'ktm-road-body' });
    for (const row of rows) this.renderRoadmapRow(body, row, state, dayWidth, trackWidth);

    const todayOffset = dayDiff(this.today, state.start);
    if (todayOffset !== undefined && todayOffset >= 0 && todayOffset <= totalDays) {
      const line = road.createDiv({ cls: 'ktm-road-today-line' });
      line.style.left = `calc(var(--ktm-road-label) + ${todayOffset * dayWidth}px)`;
    }
  }

  private roadmapLevelIcon(row: RoadmapRow): string {
    if (row.kind === 'orphan') return 'diamond';
    return this.projectSettings(row.project).levels.find((l) => l.key === row.kind)?.icon ?? 'square';
  }

  private renderRoadmapRow(parent: HTMLElement, row: RoadmapRow, state: RoadmapState, dayWidth: number, trackWidth: number): void {
    const isProject = row.kind === 'project';
    const isOrphan = row.kind === 'orphan';
    const rowEl = parent.createDiv({
      cls: 'ktm-road-row',
      attr: {
        'data-card-id': row.cardId,
        ...(isProject
          ? { 'data-kind': 'project' }
          : isOrphan
            ? { 'data-kind': 'orphan' }
            : { 'data-kind': row.kind, 'data-depth': String(row.depth) }),
        ...(row.parentKey ? { 'data-parent': row.parentKey } : {}),
        ...(row.context ? { 'data-context': 'true' } : {}),
      },
    });

    const label = rowEl.createDiv({ cls: 'ktm-road-label' });
    if (!isProject) {
      label.style.paddingLeft = `calc(var(--ktm-tree-indent) * ${Math.max(row.depth - 1, 0)})`;
      setIcon(label.createSpan({ cls: 'ktm-road-icon' }), this.roadmapLevelIcon(row));
    }
    label.createSpan({ cls: 'ktm-road-title', text: row.title, attr: { title: row.title } });

    const track = rowEl.createDiv({ cls: 'ktm-road-track' });
    track.style.width = `${trackWidth}px`;
    if (isProject) return;

    const cellLeft = (date: string): number => (dayDiff(date, state.start) ?? 0) * dayWidth;
    const cellRight = (date: string): number => ((dayDiff(date, state.start) ?? 0) + 1) * dayWidth;

    const shape = row.shape;
    if (shape?.kind === 'bar') {
      const left = cellLeft(shape.start);
      const right = shape.overdue || shape.openEnd ? cellLeft(shape.end) : cellRight(shape.end);
      const width = Math.max(right - left, 1);
      const bar = track.createDiv({
        cls: 'ktm-road-bar',
        attr: {
          'data-shape': 'bar',
          ...(shape.startDerived ? { 'data-start-derived': 'true' } : {}),
          ...(shape.overdue ? { 'data-overdue': 'true' } : {}),
          ...(shape.openEnd ? { 'data-openend': 'true' } : {}),
          ...(shape.done ? { 'data-done': 'true' } : {}),
        },
      });
      bar.style.left = `${left}px`;
      bar.style.width = `${width}px`;
      bar.createSpan({ cls: 'ktm-road-bar-title', text: row.title });
      if (row.progress) {
        bar.createSpan({ cls: 'ktm-road-bar-progress', text: `${row.progress.done}/${row.progress.total}` });
        const fill = bar.createDiv({ cls: 'ktm-road-bar-done' });
        const pct = row.progress.total > 0 ? row.progress.done / row.progress.total : 0;
        fill.style.width = `${pct * 100}%`;
      }
    } else if (shape?.kind === 'frame') {
      const left = cellLeft(shape.start);
      const width = Math.max(cellRight(shape.end) - left, 1);
      const frame = track.createDiv({ cls: 'ktm-road-frame', attr: { 'data-shape': 'frame', title: row.title } });
      frame.style.left = `${left}px`;
      frame.style.width = `${width}px`;
    } else if (shape?.kind === 'point') {
      const center = cellLeft(shape.date) + dayWidth / 2;
      const point = track.createDiv({
        cls: 'ktm-road-point',
        attr: {
          'data-shape': 'point',
          title: row.title,
          ...(shape.done ? { 'data-done': 'true' } : {}),
          ...(shape.overdue ? { 'data-overdue': 'true' } : {}),
        },
      });
      point.style.left = `${center}px`;
    }

    for (const diamond of row.diamonds ?? []) {
      const center = cellLeft(diamond.date) + dayWidth / 2;
      const d = track.createDiv({
        cls: 'ktm-road-diamond',
        attr: diamond.done ? { 'data-done': 'true' } : {},
      });
      d.style.left = `${center}px`;
    }

    this.registerDomEvent(rowEl, 'click', () => {
      const element = this.elementByPath.get(row.cardId);
      if (element) void this.openDetail(element);
    });
  }

  // Unterkopf der Roadmap (012 "Roadmap"): Pfeile, Datumsknopf mit
  // Monatswahl, "Heute", rechts das Raster-Segment im Stil der
  // Ebenen-Schalter (DESIGN.md "Darstellungen"/"Buttonstil"). Pfeile,
  // Datumsknopf und "Heute" teilen die CSS-Klassen des Wochen-Unterkopfs
  // (012 "Für alle Darstellungen"/DESIGN.md Buttonstil: "folgen dem
  // Unterkopf der Woche").
  private renderRoadmapHeader(parent: HTMLElement, state: RoadmapState): void {
    const header = parent.createDiv({ cls: 'ktm-subheader ktm-road-subheader' });

    const prev = header.createEl('button', { cls: 'ktm-week-prev', attr: { 'aria-label': 'Zeitraum zurück' } });
    setIcon(prev, 'chevron-left');
    this.registerDomEvent(prev, 'click', () => void this.setRoadmapState({ ...shiftRoadmapRange(state, -1), grid: state.grid }));

    const next = header.createEl('button', { cls: 'ktm-week-next', attr: { 'aria-label': 'Zeitraum vor' } });
    setIcon(next, 'chevron-right');
    this.registerDomEvent(next, 'click', () => void this.setRoadmapState({ ...shiftRoadmapRange(state, 1), grid: state.grid }));

    const dateWrap = header.createDiv({ cls: 'ktm-week-date-wrap' });
    const dateButton = dateWrap.createEl('button', { cls: 'ktm-week-date ktm-road-date' });
    setIcon(dateButton.createSpan({ cls: 'ktm-week-date-icon' }), 'calendar');
    dateButton.createSpan({ cls: 'ktm-week-date-kw', text: roadmapRangeLabel(state) });
    setIcon(dateButton.createSpan({ cls: 'ktm-week-date-chevron' }), 'chevron-down');
    this.registerDomEvent(dateButton, 'click', () => this.toggleRoadmapCal(dateWrap, state));
    if (this.roadmapCalOpen) this.renderRoadmapMonthPicker(dateWrap, state);

    const todayBtn = header.createEl('button', { cls: 'ktm-week-today', text: 'Heute' });
    this.registerDomEvent(todayBtn, 'click', () => void this.setRoadmapState({ ...todayRange(state, this.today), grid: state.grid }));

    header.createDiv({ cls: 'ktm-toolbar-spacer' });

    const legend = header.createDiv({ cls: 'ktm-road-legend' });
    const addLegendItem = (modifier: string, label: string): void => {
      const item = legend.createSpan({ cls: 'ktm-road-legend-item' });
      item.createSpan({ cls: `ktm-road-legend-swatch ktm-road-legend-${modifier}` });
      item.createSpan({ text: label });
    };
    addLegendItem('active', 'laufend');
    addLegendItem('overdue', 'überfällig');
    addLegendItem('done', 'erledigt');
    addLegendItem('planned', 'geplant');

    const gridSeg = header.createDiv({ cls: 'ktm-level-segment ktm-road-grid-segment' });
    for (const grid of ROADMAP_GRIDS) {
      const btn = gridSeg.createEl('button', {
        cls: 'ktm-level-button',
        text: roadmapGridLabel(grid),
        attr: { 'data-grid': grid, 'data-active': String(grid === state.grid), 'aria-label': roadmapGridLabel(grid) },
      });
      this.registerDomEvent(btn, 'click', () => {
        if (grid === state.grid) return;
        void this.setRoadmapState({ ...state, grid });
      });
    }
  }

  private toggleRoadmapCal(wrap: HTMLElement, state: RoadmapState): void {
    if (this.roadmapCalOpen) {
      this.closeRoadmapCal();
      return;
    }
    this.roadmapCalOpen = true;
    this.roadmapPickFirst = undefined;
    this.roadmapCalYear = Number(state.start.split('-')[0]);
    this.renderRoadmapMonthPicker(wrap, state);
  }

  private closeRoadmapCal(): void {
    if (!this.roadmapCalOpen) return;
    this.roadmapCalOpen = false;
    this.roadmapPickFirst = undefined;
    this.roadmapCalCleanup?.();
    this.roadmapCalCleanup = undefined;
    this.contentEl.querySelector('.ktm-roadcal')?.remove();
  }

  // Monatswahl (012 "Roadmap"): Popover in der Form des Wochenkalenders
  // (DESIGN.md Komponente "Wochenkalender"), hier mit zwei Jahren aus
  // Monatszellen statt Wochenzeilen. Der erste Klick setzt den ersten Monat,
  // der zweite den letzten (Reihenfolge egal, monthRange sortiert), dann
  // schließt das Popover.
  private renderRoadmapMonthPicker(wrap: HTMLElement, state: RoadmapState): void {
    this.roadmapCalCleanup?.();
    this.roadmapCalCleanup = undefined;
    wrap.querySelector('.ktm-roadcal')?.remove();

    const baseYear = this.roadmapCalYear ?? Number(state.start.split('-')[0]);
    const cal = wrap.createDiv({ cls: 'ktm-roadcal' });

    const head = cal.createDiv({ cls: 'ktm-roadcal-head' });
    const prev = head.createSpan({ cls: 'ktm-roadcal-nav' });
    setIcon(prev, 'chevron-left');
    head.createSpan({ cls: 'ktm-roadcal-title', text: `${baseYear} – ${baseYear + 1}` });
    const next = head.createSpan({ cls: 'ktm-roadcal-nav' });
    setIcon(next, 'chevron-right');
    this.registerDomEvent(prev, 'click', (ev) => {
      ev.stopPropagation();
      this.roadmapCalYear = baseYear - 1;
      this.renderRoadmapMonthPicker(wrap, state);
    });
    this.registerDomEvent(next, 'click', (ev) => {
      ev.stopPropagation();
      this.roadmapCalYear = baseYear + 1;
      this.renderRoadmapMonthPicker(wrap, state);
    });

    const pickMonth = (year: number, month: number): void => {
      if (!this.roadmapPickFirst) {
        this.roadmapPickFirst = { year, month };
        this.renderRoadmapMonthPicker(wrap, state);
        return;
      }
      const range = monthRange(this.roadmapPickFirst, { year, month });
      this.roadmapPickFirst = undefined;
      this.closeRoadmapCal();
      void this.setRoadmapState({ ...range, grid: state.grid });
    };

    for (const year of [baseYear, baseYear + 1]) {
      const yearBlock = cal.createDiv({ cls: 'ktm-roadcal-year' });
      yearBlock.createSpan({ cls: 'ktm-roadcal-year-label', text: String(year) });
      const monthsGrid = yearBlock.createDiv({ cls: 'ktm-roadcal-months' });
      for (let m = 1; m <= 12; m++) {
        const picked = this.roadmapPickFirst?.year === year && this.roadmapPickFirst?.month === m;
        const cell = monthsGrid.createSpan({
          cls: 'ktm-roadcal-month',
          text: MONTH_NAMES[m - 1].slice(0, 3),
          attr: { 'data-year': String(year), 'data-month': String(m), ...(picked ? { 'data-picked': 'true' } : {}) },
        });
        this.registerDomEvent(cell, 'click', () => pickMonth(year, m));
      }
    }

    const suggestions = cal.createDiv({ cls: 'ktm-roadcal-suggestions' });
    const addSuggestion = (label: string, range: RoadmapRange): void => {
      const btn = suggestions.createSpan({ cls: 'ktm-roadcal-suggestion', text: label });
      this.registerDomEvent(btn, 'click', () => {
        this.closeRoadmapCal();
        void this.setRoadmapState({ ...range, grid: state.grid });
      });
    };
    const [cy, cm] = this.today.split('-').map(Number);
    const quarterFirst = (Math.ceil(cm / 3) - 1) * 3 + 1;
    addSuggestion('Dieses Quartal', monthRange({ year: cy, month: quarterFirst }, { year: cy, month: quarterFirst + 2 }));
    const addMonths = (n: number): { year: number; month: number } => {
      const total = cy * 12 + (cm - 1) + n;
      return { year: Math.floor(total / 12), month: (total % 12) + 1 };
    };
    addSuggestion('Nächste 6 Monate', monthRange({ year: cy, month: cm }, addMonths(5)));
    addSuggestion('Nächste 12 Monate', monthRange({ year: cy, month: cm }, addMonths(11)));
    addSuggestion('Dieses Jahr', monthRange({ year: cy, month: 1 }, { year: cy, month: 12 }));

    this.installRoadmapCalHandlers(wrap);
  }

  private installRoadmapCalHandlers(wrap: HTMLElement): void {
    const doc = this.contentEl.doc;
    const onKeydown = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') this.closeRoadmapCal();
    };
    const onClick = (ev: MouseEvent): void => {
      const target = ev.target as HTMLElement;
      if (wrap.contains(target)) return;
      this.closeRoadmapCal();
    };
    doc.addEventListener('keydown', onKeydown, true);
    doc.addEventListener('click', onClick, true);
    this.roadmapCalCleanup = () => {
      doc.removeEventListener('keydown', onKeydown, true);
      doc.removeEventListener('click', onClick, true);
    };
  }

  private async setRoadmapState(state: RoadmapState): Promise<void> {
    await this.plugin.saveRoadmap(this.view, state);
    await this.render();
  }

  // Matrix (012 "Matrix", S29-S31): vier Felder nach Dringlichkeit und
  // Wichtigkeit, kein Bereich Heute (012 "Für alle Darstellungen").
  private renderMatrix(parent: HTMLElement, elements: BoardElement[], levels: Level[]): void {
    const board = buildBoard(elements, this.filter(), this.columns, {
      level: this.level,
      bottomLevel: bottomLevel(levels)?.key,
      filterSelection: this.filterSelection.ids,
      filterTags: this.filterSelection.tags,
    });
    const cards = board.columns.flatMap((c) => c.cards.filter((card) => !card.invalid));
    const assignment = assignMatrix(cards, this.today, this.columns);
    const matrixEl = parent.createDiv({ cls: 'ktm-matrix' });
    matrixEl.createDiv({ cls: 'ktm-matrix-corner' });
    matrixEl.createDiv({ cls: 'ktm-matrix-axis ktm-matrix-axis-h', text: 'dringend: fällig in höchstens drei Tagen' });
    matrixEl.createDiv({ cls: 'ktm-matrix-axis ktm-matrix-axis-h', text: 'nicht dringend' });
    matrixEl.createDiv({ cls: 'ktm-matrix-axis ktm-matrix-axis-v', text: 'wichtig: Priorität 1 oder 2' });
    this.renderMatrixQuad(matrixEl, 'now', 'Sofort', 'dringend und wichtig', assignment.now);
    this.renderMatrixQuad(matrixEl, 'plan', 'Einplanen', 'wichtig, nicht dringend', assignment.plan);
    matrixEl.createDiv({ cls: 'ktm-matrix-axis ktm-matrix-axis-v', text: 'nicht wichtig' });
    this.renderMatrixQuad(matrixEl, 'quick', 'Kurz erledigen', 'dringend, nicht wichtig', assignment.quick);
    this.renderMatrixQuad(matrixEl, 'later', 'Später oder nie', 'weder noch', assignment.later);
  }

  private renderMatrixQuad(
    parent: HTMLElement,
    quadrant: MatrixQuadrant,
    title: string,
    subtitle: string,
    cards: BoardElement[],
  ): void {
    const quadEl = parent.createDiv({ cls: 'ktm-column ktm-matrix-quad', attr: { 'data-quadrant': quadrant } });
    const header = quadEl.createDiv({ cls: 'ktm-column-header' });
    const titleWrap = header.createDiv({ cls: 'ktm-matrix-quad-titles' });
    titleWrap.createSpan({ cls: 'ktm-column-title', text: title });
    titleWrap.createSpan({ cls: 'ktm-matrix-quad-subtitle', text: subtitle });
    header.createSpan({ cls: 'ktm-column-count', text: String(cards.length) });
    const body = quadEl.createDiv({ cls: 'ktm-column-body' });
    if (cards.length === 0) {
      body.createDiv({ cls: 'ktm-empty' });
      return;
    }
    for (const card of cards) {
      this.renderCard(body, card, this.doneStatuses(card.project).has(card.status), this.today, false, true);
    }
  }

  // Rückblick (012 S32-S35, "Rückblick"): Wochenkopf wie in der Woche
  // (renderWeekHeader, wiederverwendet), darunter die vier Wochen aus
  // buildRetro. Kein Bereich Heute (012 "Für alle Darstellungen"). Ein Klick
  // auf eine Karte oder Zeile öffnet sie über einen einzigen Handler am
  // Container, statt über den Zugzustand: der Pointer-Guard in
  // onPointerDown erfasst .ktm-retro bewusst nicht, damit hier nie ein Zug
  // beginnt (012 "Nur zum Lesen", Wissen #1362).
  private renderRetro(parent: HTMLElement, elements: BoardElement[], levels: Level[]): void {
    const monday = this.currentWeekStart();
    this.renderWeekHeader(parent, monday);
    const scope = this.filter();
    const projects: TreeProjectEntry[] =
      scope.kind === 'project'
        ? [{ key: scope.project, name: this.projectDisplayName(scope.project) }]
        : scope.kind === 'internal'
          ? [{ name: 'Intern' }]
          : [{ name: 'Intern' }, ...this.projects.map((p) => ({ key: p.key, name: p.name }))];
    const levelContext: LevelContext = {
      generalLevels: resolveLevels(this.plugin.settings),
      projectLevels: Object.fromEntries(this.projects.map((p) => [p.key, this.projectSettings(p.key).levels])),
      allLevels: this.plugin.settings.allLevels ?? 'rank',
    };
    const weeks = buildRetro(elements, projects, {
      columns: this.columns,
      levelContext,
      level: this.level,
      filterSelection: this.filterSelection,
      weekStart: monday,
    });

    const host = parent.createDiv({ cls: 'ktm-retro-host' });
    const retroEl = host.createDiv({ cls: 'ktm-retro' });
    this.registerDomEvent(retroEl, 'click', (ev) => {
      const target = ev.target instanceof Element ? ev.target.closest<HTMLElement>('.ktm-card, .ktm-retro-item') : null;
      const cardId = target?.dataset.cardId;
      if (!cardId) return;
      const element = this.elementByPath.get(cardId);
      if (element) void this.openDetail(element);
    });
    for (const week of weeks) this.renderRetroWeek(retroEl, week, levels);
  }

  private retroLevelInfo(kind: ElementType, project: string | undefined): Level | undefined {
    return this.projectSettings(project).levels.find((l) => l.key === kind);
  }

  private renderRetroWeek(parent: HTMLElement, week: RetroWeek, levels: Level[]): void {
    const weekEl = parent.createDiv({ cls: 'ktm-retro-week', attr: { 'data-week-start': week.monday } });

    const side = weekEl.createDiv({ cls: 'ktm-retro-side' });
    const weekNumber = isoWeek(Date.parse(`${week.monday}T00:00:00Z`));
    side.createDiv({ cls: 'ktm-retro-kw', text: `KW ${weekNumber}` });
    side.createDiv({ cls: 'ktm-retro-range', text: this.weekRangeLabel(week.monday) });
    side.createDiv({ cls: 'ktm-retro-count', text: String(week.taskCount) });
    side.createDiv({ cls: 'ktm-retro-count-label', text: 'Tasks erledigt' });
    // Von unten nach oben (Feature vor Epic, 012 "Rückblick"): `levels` steht
    // von oben nach unten (board.ts-Konvention), levelCounts kennt nie die
    // unterste Ebene (die hat auf dieser Stufe keine Zeile).
    for (const lvl of [...levels].reverse()) {
      const count = week.levelCounts[lvl.key];
      if (!count) continue;
      const noun = count === 1 ? lvl.name : levelPlural(lvl.name);
      side.createDiv({ cls: 'ktm-retro-level-count', text: `${count} ${noun} abgeschlossen` });
    }
    const bars = side.createDiv({ cls: 'ktm-retro-bars' });
    const maxCount = Math.max(1, ...week.dayCounts);
    for (const count of week.dayCounts) {
      const bar = bars.createDiv({ cls: 'ktm-retro-bar' });
      bar.style.setProperty('--ktm-retro-bar-pct', `${(count / maxCount) * 100}%`);
    }

    const content = weekEl.createDiv({ cls: 'ktm-retro-content' });
    for (const project of week.projects) {
      const projectEl = content.createDiv({ cls: 'ktm-retro-project' });
      projectEl.createDiv({ cls: 'ktm-retro-project-title', text: project.name });
      const grid = projectEl.createDiv({ cls: 'ktm-retro-grid' });
      for (const entry of project.entries) this.renderRetroEntry(grid, entry, project.key);
    }
  }

  private renderRetroEntry(parent: HTMLElement, entry: RetroEntry, project: string | undefined): void {
    if (!entry.children) {
      const element = this.elementByPath.get(entry.cardId);
      if (!element) return;
      this.renderCard(parent, element, true, this.today);
      const cardEl = parent.lastElementChild as HTMLElement;
      const meta = cardEl.querySelector<HTMLElement>('.ktm-card-meta') ?? cardEl.createDiv({ cls: 'ktm-card-meta' });
      const text =
        entry.duration !== undefined
          ? `erledigt ${absoluteDate(entry.completed, this.today)} · ${entry.duration} Tage`
          : `erledigt ${absoluteDate(entry.completed, this.today)}`;
      meta.createSpan({ cls: 'ktm-card-meta-item ktm-retro-completed', text });
      return;
    }

    const levelInfo = this.retroLevelInfo(entry.kind, project);
    const itemEl = parent.createDiv({
      cls: 'ktm-retro-item',
      attr: { 'data-kind': entry.kind, 'data-card-id': entry.cardId },
    });
    const head = itemEl.createDiv({ cls: 'ktm-retro-item-head' });
    setIcon(head.createSpan({ cls: 'ktm-retro-item-icon' }), levelInfo?.icon ?? 'square');
    head.createSpan({ cls: 'ktm-retro-item-title', text: entry.title });
    const durationPart = entry.duration !== undefined ? ` · ${entry.duration} Tage` : '';
    const taskNoun = entry.taskCount === 1 ? 'Task' : 'Tasks';
    head.createSpan({
      cls: 'ktm-retro-item-info',
      text: `erledigt ${absoluteDate(entry.completed, this.today)}${durationPart} · ${entry.taskCount ?? 0} ${taskNoun} in dieser Woche`,
    });
    head.createSpan({ cls: 'ktm-retro-badge', text: `${levelInfo?.name ?? entry.kind} abgeschlossen` });

    const childrenEl = itemEl.createDiv({ cls: 'ktm-retro-children ktm-retro-grid' });
    for (const child of entry.children) this.renderRetroEntry(childrenEl, child, project);
  }

  // Kachelart des Portfolio-Schalters der aktuellen Ansicht (012 "Portfolio"):
  // Standard "Alle Aufgaben" Projekte, sonst Epics; flüchtig wie
  // weekStartByView, kein Nachzug durch vault:reset nötig (Wissen #1274/#1399).
  private portfolioKind(): PortfolioScope {
    return this.portfolioKindByView.get(this.view) ?? (this.isAllScope() ? 'project' : 'epic');
  }

  // Portfolio (012 S36-S39, "Portfolio"): Kacheln je Projekt, Epic oder
  // Feature, Muster renderRetro für Projektliste und LevelContext.
  private renderPortfolio(parent: HTMLElement, elements: BoardElement[]): void {
    const scope = this.filter();
    const projects: TreeProjectEntry[] =
      scope.kind === 'project'
        ? [{ key: scope.project, name: this.projectDisplayName(scope.project) }]
        : scope.kind === 'internal'
          ? [{ name: 'Intern' }]
          : [{ name: 'Intern' }, ...this.projects.map((p) => ({ key: p.key, name: p.name }))];
    const levelContext: LevelContext = {
      generalLevels: resolveLevels(this.plugin.settings),
      projectLevels: Object.fromEntries(this.projects.map((p) => [p.key, this.projectSettings(p.key).levels])),
      allLevels: this.plugin.settings.allLevels ?? 'rank',
    };
    const tiles = buildPortfolio(elements, projects, {
      columns: this.columns,
      levelContext,
      kind: this.portfolioKind(),
      filterSelection: this.filterSelection,
      today: this.today,
    });

    const host = parent.createDiv({ cls: 'ktm-portfolio-host' });
    const gridEl = host.createDiv({ cls: 'ktm-portfolio' });
    this.registerDomEvent(gridEl, 'click', (ev) => {
      const target =
        ev.target instanceof Element ? ev.target.closest<HTMLElement>('.ktm-card, .ktm-portfolio-progress-row') : null;
      const cardId = target?.dataset.cardId;
      if (!cardId) return;
      const element = this.elementByPath.get(cardId);
      if (element) void this.openDetail(element);
    });
    for (const tile of tiles) this.renderPortfolioTile(gridEl, tile);
  }

  private portfolioTileIcon(tile: PortfolioTile): string {
    if (tile.kind === 'project') return 'folder';
    if (tile.kind === 'loose') return 'inbox';
    return this.projectSettings(tile.project).levels.find((l) => l.key === tile.kind)?.icon ?? 'square';
  }

  private renderPortfolioTile(parent: HTMLElement, tile: PortfolioTile): void {
    // Hervorhebung wie bei Karten/Chips (Wissen #1031): nur DOM-Attribute, nur
    // für Kacheln mit einem eigenen Element (Epic/Feature); Projekt- und
    // Ohne-Kacheln stehen für mehrere Elemente und werden nie gedimmt.
    const element = tile.cardId !== undefined ? this.elementByPath.get(tile.cardId) : undefined;
    const dimmed = element !== undefined && this.spotlightId !== undefined && !isUnderSpotlight(element, this.spotlightId);
    const tileEl = parent.createDiv({
      cls: 'ktm-portfolio-tile',
      attr: {
        'data-kind': tile.kind,
        'data-project': tile.project ?? '',
        ...(tile.cardId !== undefined ? { 'data-card-id': tile.cardId } : {}),
        ...(dimmed ? { 'data-spotlight': 'dim' } : {}),
      },
    });

    const head = tileEl.createDiv({ cls: 'ktm-portfolio-head' });
    setIcon(head.createSpan({ cls: 'ktm-portfolio-icon' }), this.portfolioTileIcon(tile));
    const nameWrap = head.createDiv({ cls: 'ktm-portfolio-name-wrap' });
    nameWrap.createDiv({ cls: 'ktm-portfolio-name', text: tile.title });
    const metaParts = [`${tile.openCount} offen`];
    if ((tile.kind === 'epic' || tile.kind === 'feature') && this.isAllScope()) {
      metaParts.push(tile.project !== undefined ? this.projectDisplayName(tile.project) : 'Intern');
    }
    if (tile.due) metaParts.push(`fällig ${absoluteDate(tile.due, this.today)}`);
    nameWrap.createDiv({ cls: 'ktm-portfolio-meta', text: metaParts.join(' · ') });
    const boardBtn = head.createEl('button', { cls: 'ktm-portfolio-board', text: 'Board' });
    this.registerDomEvent(boardBtn, 'click', (ev) => {
      ev.stopPropagation();
      void this.openPortfolioBoard(tile);
    });

    const total = tile.distribution.reduce((acc, d) => acc + d.count, 0);
    const barEl = tileEl.createDiv({ cls: 'ktm-portfolio-bar' });
    const legendEl = tileEl.createDiv({ cls: 'ktm-portfolio-legend' });
    for (const segment of tile.distribution) {
      const share = total > 0 ? segment.count / total : 0;
      const segEl = barEl.createDiv({ cls: 'ktm-portfolio-bar-segment', attr: { 'data-tone': segment.tone } });
      segEl.style.flexGrow = String(share);
      const item = legendEl.createDiv({ cls: 'ktm-portfolio-legend-item', attr: { 'data-tone': segment.tone } });
      item.createSpan({ cls: 'ktm-portfolio-legend-dot' });
      item.createSpan({ cls: 'ktm-portfolio-legend-count', text: String(segment.count) });
    }

    const signalsEl = tileEl.createDiv({ cls: 'ktm-portfolio-signals' });
    this.renderPortfolioSignal(signalsEl, 'overdue', tile.overdue, 'überfällig');
    this.renderPortfolioSignal(signalsEl, 'today', tile.dueToday, 'heute');
    this.renderPortfolioSignal(signalsEl, 'week', tile.restOfWeek, 'Rest der Woche');

    if (tile.progress.length > 0) {
      tileEl.createDiv({ cls: 'ktm-portfolio-heading', text: tile.kind === 'project' ? 'Epics' : 'Features' });
      const progressEl = tileEl.createDiv({ cls: 'ktm-portfolio-progress' });
      for (const row of tile.progress) this.renderPortfolioProgressRow(progressEl, row);
    }

    if (tile.upcoming.length > 0) {
      tileEl.createDiv({ cls: 'ktm-portfolio-heading', text: 'Als Nächstes' });
      const nextEl = tileEl.createDiv({ cls: 'ktm-portfolio-next' });
      for (const cardId of tile.upcoming) {
        const upcomingElement = this.elementByPath.get(cardId);
        if (upcomingElement) this.renderCard(nextEl, upcomingElement, false, this.today);
      }
    }
  }

  private renderPortfolioSignal(parent: HTMLElement, kind: 'overdue' | 'today' | 'week', count: number, label: string): void {
    const signalEl = parent.createDiv({ cls: 'ktm-portfolio-signal', attr: { 'data-kind': kind } });
    signalEl.createDiv({ cls: 'ktm-portfolio-signal-count', text: String(count) });
    signalEl.createDiv({ cls: 'ktm-portfolio-signal-label', text: label });
  }

  private renderPortfolioProgressRow(parent: HTMLElement, row: PortfolioProgressRow): void {
    const rowEl = parent.createDiv({ cls: 'ktm-portfolio-progress-row', attr: { 'data-card-id': row.cardId } });
    rowEl.createSpan({ cls: 'ktm-portfolio-progress-title', text: row.title });
    const bar = rowEl.createDiv({ cls: 'ktm-tree-progress-bar' });
    const fill = bar.createDiv({ cls: 'ktm-tree-progress-fill' });
    fill.style.width = `${row.total > 0 ? (row.done / row.total) * 100 : 0}%`;
    rowEl.createSpan({ cls: 'ktm-tree-progress-label', text: `${row.done}/${row.total}` });
  }

  // Schalter "Features, Epics, Projekte" (012 "Portfolio"): dieselben Klassen
  // wie der Ebenen-Schalter (DESIGN.md "in dessen Form"), aber
  // `data-tile-kind` statt `data-level` und nie in data.json gespeichert.
  private renderPortfolioSwitch(parent: HTMLElement): void {
    const current = this.portfolioKind();
    const options: { key: PortfolioScope; label: string }[] = [
      { key: 'feature', label: 'Features' },
      { key: 'epic', label: 'Epics' },
      { key: 'project', label: 'Projekte' },
    ];
    const segment = parent.createDiv({ cls: 'ktm-level-segment' });
    for (const option of options) {
      const button = segment.createEl('button', {
        cls: 'ktm-level-button',
        text: option.label,
        attr: { 'data-tile-kind': option.key, 'data-active': String(option.key === current) },
      });
      this.registerDomEvent(button, 'click', () => {
        if (option.key === current) return;
        this.portfolioKindByView.set(this.view, option.key);
        void this.render();
      });
    }
  }

  // "Board" einer Kachel (012 "Portfolio"): Projekt-/Ohne-Kachel wechselt die
  // Ansicht auf das Projekt, Epic-/Feature-Kachel hebt das Element in der
  // gleichen Ansicht hervor (Wissen #128: this.settings vor render schreiben).
  private async openPortfolioBoard(tile: PortfolioTile): Promise<void> {
    if (tile.kind === 'project' || tile.kind === 'loose') {
      this.view = tile.project ?? VIEW_INTERNAL;
      this.mode = 'board';
      await this.applyState();
      return;
    }
    await this.plugin.saveSpotlight(this.view, tile.id);
    this.setMode('board');
  }

  // Einfügestrich beim Ziehen eines Darstellungs-Icons (012 S3): mittig in
  // der Lücke vor dem Button, dessen linke Hälfte der Zeiger erreicht hat
  // (Muster updateDropTarget, aber horizontal statt vertikal und ohne
  // Platzhalter — das gezogene Icon bleibt an seiner Stelle, nur gedimmt).
  private updateViewSwitchMarker(drag: SwitchDragState, x: number): void {
    const switchEl = this.contentEl.querySelector<HTMLElement>('.ktm-viewswitch');
    if (!switchEl) return;
    const buttons = [...switchEl.querySelectorAll<HTMLElement>('.ktm-viewswitch-button')];
    const dragged = buttons.find((b) => b.dataset.mode === drag.mode);
    dragged?.setAttribute('data-dragging', 'true');
    let before: HTMLElement | undefined;
    for (const button of buttons) {
      if (button === dragged) continue;
      if (x < button.getBoundingClientRect().left + button.getBoundingClientRect().width / 2) {
        before = button;
        break;
      }
    }
    drag.beforeMode = before?.dataset.mode;

    let marker = switchEl.querySelector<HTMLElement>('.ktm-viewswitch-marker');
    if (!marker) {
      marker = this.contentEl.doc.createElement('div');
      marker.addClass('ktm-viewswitch-marker');
      switchEl.appendChild(marker);
    }
    const switchRect = switchEl.getBoundingClientRect();
    const index = before ? buttons.indexOf(before) : -1;
    const prev = index > 0 ? buttons[index - 1] : undefined;
    let markerX: number;
    if (before) {
      const leftEdge = prev ? prev.getBoundingClientRect().right : switchRect.left;
      markerX = (leftEdge + before.getBoundingClientRect().left) / 2;
    } else {
      const last = buttons[buttons.length - 1];
      markerX = last.getBoundingClientRect().right + (switchRect.right - last.getBoundingClientRect().right) / 2;
    }
    marker.style.left = `${markerX - switchRect.left}px`;
  }

  // Größensteuerung "− n % +" (001, Ergänzung 2026-10-24 "Eigene Größe des
  // Boards", DESIGN.md "Größensteuerung .ktm-scale"): data-scale erst nach dem
  // Neuzeichnen mit dem gespeicherten Wert gesetzt, Klicks laufen über
  // dieselben drei Befehle wie die Befehlspalette (Muster "Neue Aufgabe"
  // oben), nicht über einen direkten Schreibzugriff.
  private renderScaleControl(parent: HTMLElement): void {
    const scale = normalizeBoardScale(this.plugin.settings.boardScale);
    const wrap = parent.createDiv({ cls: 'ktm-scale', attr: { 'data-scale': String(scale) } });

    const down = wrap.createEl('button', { cls: 'ktm-scale-down', attr: { 'aria-label': 'Board verkleinern' } });
    setIcon(down, 'minus');
    this.registerDomEvent(down, 'click', () => {
      (this.app as DesktopApp).commands.executeCommandById(BOARD_ZOOM_OUT_COMMAND);
    });

    const value = wrap.createEl('button', {
      cls: 'ktm-scale-value',
      text: `${scale} %`,
      attr: { 'aria-label': 'Board-Größe zurücksetzen' },
    });
    this.registerDomEvent(value, 'click', () => {
      (this.app as DesktopApp).commands.executeCommandById(BOARD_ZOOM_RESET_COMMAND);
    });

    const up = wrap.createEl('button', { cls: 'ktm-scale-up', attr: { 'aria-label': 'Board vergrößern' } });
    setIcon(up, 'plus');
    this.registerDomEvent(up, 'click', () => {
      (this.app as DesktopApp).commands.executeCommandById(BOARD_ZOOM_IN_COMMAND);
    });
  }

  // Marke der Hervorhebung (DESIGN.md Komponenten "Marke der Hervorhebung"):
  // Icon der Ebene, Titel mit Ellipse, Kreuz zum Aufheben. Ohne aktive
  // Hervorhebung oder ohne (mehr) passendes Element bleibt sie weg.
  private renderSpotlightMark(parent: HTMLElement, elements: readonly BoardElement[]): HTMLElement | undefined {
    const info = this.spotlightMarkInfo(elements);
    if (!info) return undefined;
    const mark = parent.createDiv({ cls: 'ktm-spotlight-mark', attr: { 'aria-label': info.title } });
    setIcon(mark.createSpan({ cls: 'ktm-spotlight-mark-icon' }), info.icon);
    mark.createSpan({ cls: 'ktm-spotlight-mark-title', text: info.title, attr: { title: info.title } });
    const cross = mark.createSpan({ cls: 'ktm-spotlight-mark-clear', attr: { 'aria-label': 'Hervorhebung aufheben' } });
    setIcon(cross, 'x');
    this.registerDomEvent(cross, 'click', (ev) => {
      ev.stopPropagation();
      void this.clearSpotlight();
    });
    return mark;
  }

  // Icon und Titel der Marke (001, Ergänzung 2026-10-25, DESIGN.md "Marke der
  // Hervorhebung"): für `tag:` das Icon aus der wirksamen Tag-Liste der
  // aktuellen Ansicht, sonst `tag`; für `status:` `circle` und der
  // Spaltenname; für `project:` `folder` und projectDisplayName (leerer
  // Schlüssel: "intern"); sonst (eine Element-ID) wie bisher.
  private spotlightMarkInfo(elements: readonly BoardElement[]): { icon: string; title: string } | undefined {
    const value = this.spotlightId;
    if (!value) return undefined;
    if (value.startsWith('tag:')) {
      const tag = value.slice('tag:'.length);
      const tagList = effectiveTags(this.plugin.settings, this.currentProject());
      const icon = tagList.find((t) => t.tag.toLowerCase() === tag.toLowerCase())?.icon ?? 'tag';
      return { icon, title: tag };
    }
    if (value.startsWith('status:')) {
      const key = value.slice('status:'.length);
      const columns = resolveColumns(this.plugin.settings, this.currentProject());
      return { icon: 'circle', title: columns.find((c) => c.status === key)?.name ?? key };
    }
    if (value.startsWith('project:')) {
      return { icon: 'folder', title: this.projectDisplayName(value.slice('project:'.length)) || 'intern' };
    }
    // Zwei Elemente mit derselben Kennung (011 S59, Wissen #1315: Original und
    // Kopie teilen eine ktm_id) sollen die gültige Karte zeigen, nicht die
    // ungültige Dublette (deren Titel nur der Dateiname ist).
    const element = elements.find((e) => e.id === value && !e.invalid) ?? elements.find((e) => e.id === value);
    if (!element) return undefined;
    const icon = this.projectSettings(element.project).levels.find((l) => l.key === element.type)?.icon ?? 'layers';
    return { icon, title: element.title };
  }

  private async clearSpotlight(): Promise<void> {
    this.spotlightId = undefined;
    await this.plugin.saveSpotlight(this.view, undefined);
    await this.render();
  }

  // Einfachklick auf einen Ebenen-Chip (001, Ergänzung 2026-10-18,
  // "Hervorheben"): versetzt oder hebt die Hervorhebung auf. Aktualisiert
  // Marke und Karten-Attribute an Ort und Stelle statt über render() — der
  // Chip bleibt dasselbe DOM-Element, damit ein folgender Doppelklick
  // (setFilterFromChip) noch ankommt (Wissen #914/#962 gelten für render()).
  private async toggleSpotlight(id: string): Promise<void> {
    const next = this.spotlightId === id ? undefined : id;
    this.spotlightId = next;
    await this.plugin.saveSpotlight(this.view, next);
    this.updateSpotlightDisplay();
  }

  private updateSpotlightDisplay(): void {
    const elements = [...this.elementByPath.values()];
    const controls = this.contentEl.querySelector<HTMLElement>('.ktm-toolbar-controls');
    if (controls) {
      controls.querySelector('.ktm-spotlight-mark')?.remove();
      const mark = this.renderSpotlightMark(controls, elements);
      if (mark) controls.insertBefore(mark, controls.firstChild);
    }
    for (const cardEl of this.contentEl.querySelectorAll<HTMLElement>('.ktm-columns .ktm-card')) {
      const path = cardEl.dataset.cardId;
      const element = path ? this.elementByPath.get(path) : undefined;
      const dim = this.spotlightId !== undefined && !(element && isUnderSpotlight(element, this.spotlightId));
      if (dim) cardEl.setAttribute('data-spotlight', 'dim');
      else cardEl.removeAttribute('data-spotlight');
    }
  }

  // Doppelklick auf einen Ebenen-Chip (001, Ergänzung 2026-10-18, "Doppelklick
  // setzt den Filter"): ersetzt den bisherigen Filter durch dieses Element
  // (mit den Regeln des Anwählens) und hebt eine Hervorhebung auf.
  private async setFilterFromChip(id: string): Promise<void> {
    const treeElements = this.filterTreeElements([...this.elementByPath.values()]);
    const ids = toggleFilterSelection(new Set(), id, treeElements);
    await this.replaceFilterSelection({ ids, statuses: new Set(), tags: new Set() });
  }

  // Doppelklick auf einen Tag-Chip (001, Ergänzung 2026-10-25, "Hervorheben"):
  // ersetzt den bisherigen Filter durch genau diesen Tag und hebt eine
  // Hervorhebung auf.
  private async setFilterFromTagChip(tag: string): Promise<void> {
    await this.replaceFilterSelection({ ids: new Set(), statuses: new Set(), tags: new Set([tag]) });
  }

  private async replaceFilterSelection(selection: FilterSelection): Promise<void> {
    this.filterSelection = selection;
    this.spotlightId = undefined;
    await this.plugin.saveFilter(this.view, filterEntries(selection));
    await this.plugin.saveSpotlight(this.view, undefined);
    await this.render();
  }

  // Elements the filter tree offers: every level above each element's own
  // project's bottom one (001, Ergänzung 2026-10-18, "Die Liste"), narrowed
  // to the current view's project outside "Alle Aufgaben" (010/K370: a
  // project view filters by the `project` field, the same way buildBoard
  // does).
  private filterTreeElements(elements: BoardElement[]): BoardElement[] {
    const project = this.currentProject();
    const scoped = project ? elements.filter((e) => e.project === project.key) : elements;
    return scoped.filter((e) => !e.invalid && !isBottomLevel(this.projectSettings(e.project).levels, e.type));
  }

  // Status-Namen und Tags der aktuellen Auswahl, in Anzeigereihenfolge (001,
  // Ergänzung 2026-10-25): für filterSummary's `extra`-Parameter, nach den
  // obersten Hierarchie-Elementen angehängt.
  private filterExtraLabels(): string[] {
    const columns = resolveColumns(this.plugin.settings, this.currentProject());
    const statusNames = columns.filter((c) => this.filterSelection.statuses.has(c.status)).map((c) => c.name);
    const tagNames = [...this.filterSelection.tags].sort((a, b) => a.localeCompare(b, 'de'));
    return [...statusNames, ...tagNames];
  }

  private totalFilterSelected(): number {
    return this.filterSelection.ids.size + this.filterSelection.statuses.size + this.filterSelection.tags.size;
  }

  private renderFilterField(parent: HTMLElement, elements: BoardElement[]): void {
    const treeElements = this.filterTreeElements(elements);
    const summary = filterSummary(this.filterSelection.ids, treeElements, this.filterExtraLabels());
    const wrap = parent.createDiv({ cls: 'ktm-filter-wrap' });
    const field = wrap.createDiv({
      cls: 'ktm-filter',
      attr: { 'data-set': String(summary.count > 0), 'aria-label': summary.tooltip || 'Filter' },
    });
    setIcon(field.createSpan({ cls: 'ktm-filter-icon' }), 'filter');
    field.createSpan({ cls: 'ktm-filter-text', text: summary.text || 'Filter' });
    if (summary.count > 0) {
      field.createSpan({ cls: 'ktm-filter-badge', text: String(summary.count) });
      const cross = field.createSpan({ cls: 'ktm-filter-clear', attr: { 'aria-label': 'Filter leeren' } });
      setIcon(cross, 'x');
      this.registerDomEvent(cross, 'click', (ev) => {
        ev.stopPropagation();
        void this.clearFilter();
      });
    } else {
      setIcon(field.createSpan({ cls: 'ktm-filter-chevron' }), 'chevron-down');
    }
    this.registerDomEvent(field, 'click', () => this.toggleFilterMenu(wrap, treeElements));
    if (this.filterMenuOpen) this.renderFilterMenu(wrap, treeElements);
  }

  private toggleFilterMenu(wrap: HTMLElement, treeElements: BoardElement[]): void {
    if (this.filterMenuOpen) {
      this.closeFilterMenu();
      return;
    }
    this.filterMenuOpen = true;
    this.filterSearch = '';
    this.filterSectionExpanded = { hierarchy: false, status: false, tags: false };
    this.renderFilterMenu(wrap, treeElements);
  }

  private closeFilterMenu(): void {
    if (!this.filterMenuOpen) return;
    this.filterMenuOpen = false;
    this.filterMenuCleanup?.();
    this.filterMenuCleanup = undefined;
    this.contentEl.querySelector('.ktm-filtermenu')?.remove();
  }

  // The popover itself (DESIGN.md Filter-Popover): rebuilt on every toggle
  // and on every keystroke in the search field, never diffed — the list is
  // short enough (epics/features) that a full redraw costs nothing, and it
  // keeps the row state (gewählt/teilweise) always in sync with
  // this.filterSelection. The old outside-click/Escape listeners are torn
  // down first, so a stale pair never outlives its own (detached) `wrap`
  // (Wissen #558). Drei Sektionen seit 001, Ergänzung 2026-10-25: Hierarchie,
  // Status (wirkt im Board nicht) und Tags.
  private renderFilterMenu(wrap: HTMLElement, treeElements: BoardElement[]): void {
    this.filterMenuCleanup?.();
    this.filterMenuCleanup = undefined;
    wrap.querySelector('.ktm-filtermenu')?.remove();
    const menu = wrap.createDiv({ cls: 'ktm-filtermenu' });

    const searchWrap = menu.createDiv({ cls: 'ktm-search' });
    setIcon(searchWrap.createSpan(), 'search');
    const search = searchWrap.createEl('input', {
      type: 'text',
      cls: 'ktm-search-input',
      value: this.filterSearch,
      attr: { placeholder: 'Suchen' },
    });
    this.registerDomEvent(search, 'input', () => {
      this.filterSearch = search.value;
      this.renderFilterMenu(wrap, treeElements);
    });

    const headRow = menu.createDiv({ cls: 'ktm-filtermenu-head' });
    headRow.createSpan({ cls: 'ktm-filtermenu-count', text: `${this.totalFilterSelected()} gewählt` });
    const clearAll = headRow.createSpan({ cls: 'ktm-filtermenu-clearall', text: 'alle abwählen' });
    this.registerDomEvent(clearAll, 'click', () => void this.clearFilter());

    this.renderHierarchySection(menu, treeElements);
    this.renderStatusSection(menu, treeElements);
    this.renderTagsSection(menu, treeElements);

    // "Als Ansicht speichern …" (001, Ergänzung 2026-10-18, "Gespeicherte
    // Ansichten"): letzte Zeile hinter einer 1-px-Linie, immer sichtbar,
    // unabhängig von der aktuellen Auswahl (auch eine leere Auswahl lässt
    // sich als Ansicht speichern).
    menu.createDiv({ cls: 'ktm-filtermenu-separator' });
    const saveRow = menu.createDiv({ cls: 'ktm-filtermenu-save' });
    setIcon(saveRow.createSpan(), 'plus');
    saveRow.createSpan({ text: 'Als Ansicht speichern …' });
    this.registerDomEvent(saveRow, 'click', () => void this.saveAsView());

    this.installFilterMenuHandlers(wrap);
    search.focus();
  }

  // Sektionskopf: Überschrift, bei Auswahl die Zahl als Marke (DESIGN.md
  // Filter-Popover).
  private renderFilterSectionHeading(parent: HTMLElement, title: string, count: number): HTMLElement {
    const section = parent.createDiv({ cls: 'ktm-filtermenu-section' });
    const heading = section.createDiv({ cls: 'ktm-filtermenu-section-heading' });
    heading.createSpan({ text: title });
    if (count > 0) heading.createSpan({ cls: 'ktm-filtermenu-section-count', text: String(count) });
    return section;
  }

  // "… alle anzeigen (n weitere)" / "weniger anzeigen" (001, Ergänzung
  // 2026-10-25, "Platz"; DESIGN.md Zustände "Filter-Popover, Sektion mehr als
  // die Grenze").
  private renderExpandLink(parent: HTMLElement, expanded: boolean, rest: number, onClick: () => void): void {
    const link = parent.createDiv({
      cls: 'ktm-filtermenu-expand',
      text: expanded ? 'weniger anzeigen' : `… alle anzeigen (${rest} weitere)`,
    });
    this.registerDomEvent(link, 'click', onClick);
  }

  // Sektion "Epics und Features" (001, Ergänzung 2026-10-25): dieselbe Liste
  // wie bisher, benannt nach den Ebenen über der untersten, ohne eigenes
  // Scrollen und mit einer Grenze von 16 Zeilen (Projektnamen zählen nicht
  // mit).
  private renderHierarchySection(menu: HTMLElement, treeElements: BoardElement[]): void {
    const HIERARCHY_LIMIT = 16;
    const title = this.hierarchySectionLevels()
      .map((l) => levelPlural(l.name))
      .join(' und ');
    const section = this.renderFilterSectionHeading(menu, title, this.filterSelection.ids.size);
    const list = section.createDiv({ cls: 'ktm-filtermenu-list' });
    const projectOrder = this.isAllScope() ? this.projectOrder() : undefined;
    const rows = filterRows(
      treeElements,
      this.filterSelection.ids,
      (el) => this.doneStatuses(el.project).has(el.status),
      (el) => this.statusNameFor(el),
      this.filterSearch,
      projectOrder,
    );
    const expanded = this.filterSectionExpanded.hierarchy;
    const visibleRows = expanded ? rows : rows.slice(0, HIERARCHY_LIMIT);
    let lastProject: string | undefined;
    let firstGroup = true;
    for (const row of visibleRows) {
      if (projectOrder && row.project !== lastProject) {
        if (!firstGroup) list.createDiv({ cls: 'ktm-filtermenu-separator' });
        firstGroup = false;
        list.createDiv({ cls: 'ktm-filtermenu-group', text: this.projectDisplayName(row.project) });
        lastProject = row.project;
      }
      this.renderFilterRow(list, row, treeElements);
    }
    if (rows.length > HIERARCHY_LIMIT) {
      this.renderExpandLink(section, expanded, rows.length - HIERARCHY_LIMIT, () => {
        this.filterSectionExpanded = { ...this.filterSectionExpanded, hierarchy: !expanded };
        this.renderFilterMenu(menu.parentElement as HTMLElement, treeElements);
      });
    }
  }

  // Ebenen über der untersten (001, Ergänzung 2026-10-25, "Epics und
  // Features"): die volle Ebenenliste eines Projekts, sonst die allgemeine —
  // unabhängig vom Ebenen-Schalter, der im Modus `bottom` leer bleibt
  // (009, Ergänzung 2026-09-20), die Hierarchie-Sektion aber unverändert
  // zeigt.
  private hierarchySectionLevels(): Level[] {
    const project = this.currentProject();
    const levels = project ? this.projectSettings(project.key).levels : resolveLevels(this.plugin.settings);
    return levels.slice(0, -1);
  }

  // Sektion "Status" (001, Ergänzung 2026-10-25): ein Chip je Spalte der
  // Ansicht in Spaltenreihenfolge, mit Punkt nach Rolle; wirkt auf dem Board
  // nicht (S51), bleibt aber klickbar und wirkt in anderen Darstellungen.
  private renderStatusSection(menu: HTMLElement, treeElements: BoardElement[]): void {
    const STATUS_LIMIT = 8;
    const columns = resolveColumns(this.plugin.settings, this.currentProject());
    const openColumns = columns.filter((c) => c.role === 'open');
    const dotColor = (col: Column): string => {
      if (col.role === 'done') return 'var(--color-green)';
      if (col.role === 'active') return 'var(--text-accent)';
      if (col.role === 'open' && openColumns.indexOf(col) === 1) return 'var(--color-cyan)';
      return 'var(--text-faint)';
    };
    const section = this.renderFilterSectionHeading(menu, 'Status', this.filterSelection.statuses.size);
    section.setAttribute('data-inactive', 'true');
    section.createDiv({ cls: 'ktm-filtermenu-section-hint', text: 'wirkt im Board nicht' });
    const chipRow = section.createDiv({ cls: 'ktm-filtermenu-chips' });
    const expanded = this.filterSectionExpanded.status;
    const visible = expanded ? columns : columns.slice(0, STATUS_LIMIT);
    for (const column of visible) {
      const selected = this.filterSelection.statuses.has(column.status);
      const chip = chipRow.createDiv({
        cls: 'ktm-filterchip',
        attr: { 'data-status': column.status, 'data-selected': String(selected) },
      });
      const dot = chip.createSpan({ cls: 'ktm-filterchip-dot' });
      dot.style.background = dotColor(column);
      chip.createSpan({ text: column.name });
      this.registerDomEvent(chip, 'click', () => void this.toggleFilterFacet('status', column.status));
    }
    if (columns.length > STATUS_LIMIT) {
      this.renderExpandLink(section, expanded, columns.length - STATUS_LIMIT, () => {
        this.filterSectionExpanded = { ...this.filterSectionExpanded, status: !expanded };
        this.renderFilterMenu(menu.parentElement as HTMLElement, treeElements);
      });
    }
  }

  // Sektion "Tags" (001, Ergänzung 2026-10-25): erst die hinterlegten Tags
  // der wirksamen Liste mit Icon, dann die übrigen Vault-Tags alphabetisch
  // (tagSuggestions, Leiter Stufe 2), gefiltert nach dem Suchtext.
  private renderTagsSection(menu: HTMLElement, treeElements: BoardElement[]): void {
    const TAGS_LIMIT = 16;
    const tagList = effectiveTags(this.plugin.settings, this.currentProject());
    const suggestions = tagSuggestions(tagList, this.vaultTags(), [], this.filterSearch);
    const chips: Array<{ tag: string; icon?: string }> = [
      ...suggestions.pinned.map((t) => ({ tag: t.tag, icon: t.icon })),
      ...suggestions.rest.map((tag) => ({ tag })),
    ];
    const section = this.renderFilterSectionHeading(menu, 'Tags', this.filterSelection.tags.size);
    const chipRow = section.createDiv({ cls: 'ktm-filtermenu-chips' });
    const expanded = this.filterSectionExpanded.tags;
    const visible = expanded ? chips : chips.slice(0, TAGS_LIMIT);
    for (const entry of visible) {
      const selected = this.filterSelection.tags.has(entry.tag);
      const chip = chipRow.createDiv({
        cls: 'ktm-filterchip',
        attr: { 'data-tag': entry.tag, 'data-selected': String(selected) },
      });
      if (entry.icon) setIcon(chip.createSpan({ cls: 'ktm-filterchip-icon' }), entry.icon);
      chip.createSpan({ text: entry.tag });
      this.registerDomEvent(chip, 'click', () => void this.toggleFilterFacet('tag', entry.tag));
    }
    if (chips.length > TAGS_LIMIT) {
      this.renderExpandLink(section, expanded, chips.length - TAGS_LIMIT, () => {
        this.filterSectionExpanded = { ...this.filterSectionExpanded, tags: !expanded };
        this.renderFilterMenu(menu.parentElement as HTMLElement, treeElements);
      });
    }
  }

  // "Als Ansicht speichern …" (001, Ergänzung 2026-10-18): fragt per
  // ViewNameDialog nach einem Namen, legt am Ende der Liste eine neue
  // gespeicherte Ansicht mit einem frischen Schlüssel an, kopiert die
  // aktuelle Filterauswahl und Hervorhebung auf diesen Schlüssel (sie bezogen
  // sich bis eben auf this.view) und wechselt hinein.
  // 006, Ergänzung 2026-10-19 (S62): liefert saveSavedViews false (data.json
  // seit dem Laden kein einziges Mal lesbar), endet die Methode sofort — kein
  // saveFilter/saveSpotlight auf den neuen Schlüssel, kein Wechsel von
  // this.view, keine Übernahme der aktuellen Filterauswahl auf eine Ansicht,
  // die nie entstanden ist.
  private async saveAsView(): Promise<void> {
    this.closeFilterMenu();
    const existing = this.savedViews();
    const name = await ViewNameDialog.ask(this.app, {
      title: 'Als Ansicht speichern',
      validate: (value) => validateViewName(value, existing),
    });
    if (name === undefined) return;
    const key = `saved:${newId()}`;
    // Die neue Ansicht bringt die aktuelle Darstellung mit (012 S6).
    const nextList = [...existing, { key, name, mode: this.mode }];
    const saved = await this.plugin.saveSavedViews(nextList);
    if (!saved) return;
    await this.plugin.saveFilter(key, filterEntries(this.filterSelection));
    await this.plugin.saveSpotlight(key, this.spotlightId);
    // Der Heute-Schalter gehört zur Ansicht (004, Ergänzung 2026-10-24, S30):
    // war er in der Ausgangsansicht an, übernimmt ihn die neue Ansicht, und
    // die Ausgangsansicht steht danach wieder aus.
    if (this.plugin.isTodayFollows(this.view)) {
      await this.plugin.saveTodayFollows(key, true);
      await this.plugin.saveTodayFollows(this.view, false);
    }
    this.view = key;
    await this.plugin.saveViewState(this.view, this.level);
    await this.render();
  }

  private renderFilterRow(parent: HTMLElement, row: FilterRow, treeElements: BoardElement[]): void {
    const selected = row.state === 'selected' ? 'true' : row.state === 'partial' ? 'partial' : 'false';
    const rowEl = parent.createDiv({
      cls: 'ktm-filtermenu-row',
      attr: { 'data-selected': selected, 'data-depth': String(row.depth), 'data-closed': String(row.closed) },
    });
    rowEl.style.paddingLeft = `${row.depth * 18}px`;
    const icon = this.projectSettings(row.project).levels.find((l) => l.key === row.type)?.icon ?? 'layers';
    setIcon(rowEl.createSpan({ cls: 'ktm-filtermenu-row-icon' }), icon);
    rowEl.createSpan({ cls: 'ktm-filtermenu-row-title', text: row.title });
    rowEl.createSpan({ cls: 'ktm-filtermenu-row-right', text: row.right });
    this.registerDomEvent(rowEl, 'click', () => void this.toggleFilterRow(row.id, treeElements));
  }

  private projectDisplayName(key: string | undefined): string {
    return this.projects.find((p) => p.key === key)?.name ?? key ?? '';
  }

  private installFilterMenuHandlers(wrap: HTMLElement): void {
    const doc = this.contentEl.doc;
    const onKeydown = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') this.closeFilterMenu();
    };
    // Obsidian's own Menu (Art-Dropdown etc.) renders outside this
    // popover's DOM; excluding `.menu` keeps a click on one of its items
    // from reading as an outside click first (Wissen #558).
    const onClick = (ev: MouseEvent): void => {
      const target = ev.target as HTMLElement;
      if (wrap.contains(target)) return;
      if (target.closest?.('.menu')) return;
      this.closeFilterMenu();
    };
    doc.addEventListener('keydown', onKeydown, true);
    doc.addEventListener('click', onClick, true);
    this.filterMenuCleanup = () => {
      doc.removeEventListener('keydown', onKeydown, true);
      doc.removeEventListener('click', onClick, true);
    };
  }

  private async toggleFilterRow(id: string, treeElements: BoardElement[]): Promise<void> {
    const ids = toggleFilterSelection(this.filterSelection.ids, id, treeElements);
    this.filterSelection = { ...this.filterSelection, ids };
    await this.plugin.saveFilter(this.view, filterEntries(this.filterSelection));
    await this.render();
  }

  // Status- oder Tag-Chip umschalten (001, Ergänzung 2026-10-25): wie
  // toggleFilterRow, aber in der Status- oder Tag-Menge; das Popover bleibt
  // offen, weil filterMenuOpen das überlebt (Wissen #914).
  private async toggleFilterFacet(section: 'status' | 'tag', value: string): Promise<void> {
    const key = section === 'status' ? 'statuses' : 'tags';
    const next = new Set(this.filterSelection[key]);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    this.filterSelection = { ...this.filterSelection, [key]: next };
    await this.plugin.saveFilter(this.view, filterEntries(this.filterSelection));
    await this.render();
  }

  private async clearFilter(): Promise<void> {
    this.filterSelection = { ids: new Set(), statuses: new Set(), tags: new Set() };
    await this.plugin.saveFilter(this.view, []);
    await this.render();
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

  // Der native Select bleibt der Auslöser, den bestehende e2e-Skripte über
  // ein change-Event ansprechen (Wissen #960); mousedown öffnet stattdessen
  // das eigene Popover darunter (DESIGN.md "Ansicht-Menü") statt der
  // nativen Liste, Enter/Leertaste ebenso.
  private renderViewDropdown(parent: HTMLElement): void {
    const wrap = parent.createDiv({ cls: 'ktm-view-wrap' });
    const dropdown = new DropdownComponent(wrap);
    dropdown.selectEl.addClass('ktm-view-select');
    dropdown.addOption(VIEW_ALL, 'Alle Aufgaben');
    dropdown.addOption(VIEW_INTERNAL, 'Intern');
    for (const project of this.projects) dropdown.addOption(project.key, project.name);
    for (const saved of this.savedViews()) dropdown.addOption(saved.key, saved.name);
    dropdown.setValue(this.view);
    setIcon(wrap.createSpan({ cls: 'ktm-viewmenu-chevron' }), 'chevron-down');
    dropdown.onChange((value) => {
      this.view = value;
      // Auch dieser Weg übernimmt die gemerkte Darstellung (012 S4/S5, Wissen #960).
      this.mode = rememberedMode(value, this.savedViews(), this.plugin.settings.viewModes) ?? this.mode;
      void this.applyState();
    });
    this.registerDomEvent(dropdown.selectEl, 'mousedown', (ev) => {
      ev.preventDefault();
      this.toggleViewMenu(wrap);
    });
    this.registerDomEvent(dropdown.selectEl, 'keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      this.toggleViewMenu(wrap);
    });
    if (this.viewMenuOpen) this.renderViewMenu(wrap);
  }

  private toggleViewMenu(wrap: HTMLElement): void {
    if (this.viewMenuOpen) {
      this.closeViewMenu();
      return;
    }
    this.viewMenuOpen = true;
    this.viewRenameKey = undefined;
    this.renderViewMenu(wrap);
  }

  private closeViewMenu(): void {
    if (!this.viewMenuOpen) return;
    this.viewMenuOpen = false;
    this.viewRenameKey = undefined;
    this.viewMenuCleanup?.();
    this.viewMenuCleanup = undefined;
    this.contentEl.querySelector('.ktm-viewmenu')?.remove();
  }

  // Das Popover selbst (DESIGN.md Komponenten "Ansicht-Menü"): Alle Aufgaben,
  // Intern, die Projekte, dann hinter einer Trennlinie die gespeicherten
  // Ansichten (001, Ergänzung 2026-10-18 "Ansicht-Menü"). Bei jedem Toggle,
  // jedem Umbenennen und jedem Löschen neu aufgebaut, wie das Filter-Popover
  // (Wissen #558 gilt genauso: der Außen-Klick-Handler nimmt .menu aus).
  private renderViewMenu(wrap: HTMLElement): void {
    this.viewMenuCleanup?.();
    this.viewMenuCleanup = undefined;
    wrap.querySelector('.ktm-viewmenu')?.remove();
    const menu = wrap.createDiv({ cls: 'ktm-viewmenu' });

    this.renderViewMenuRow(wrap, menu, VIEW_ALL, 'Alle Aufgaben', false);
    this.renderViewMenuRow(wrap, menu, VIEW_INTERNAL, 'Intern', false);
    for (const project of this.projects) this.renderViewMenuRow(wrap, menu, project.key, project.name, false);

    const saved = this.savedViews();
    if (saved.length > 0) {
      menu.createDiv({ cls: 'ktm-viewmenu-separator' });
      for (const view of saved) this.renderViewMenuRow(wrap, menu, view.key, view.name, true);
    }

    // Aktionszeilen für die aktuell gezeigte Ansicht (012, Ergänzung
    // 2026-10-25 "Marke 'geändert'"): dieselbe Liste wie im Menü der Marke.
    const actions = this.modeActions();
    if (actions.length > 0) {
      menu.createDiv({ cls: 'ktm-viewmenu-separator' });
      for (const action of actions) this.renderModeActionRow(menu, action);
    }

    this.installViewMenuHandlers(wrap);
  }

  private renderViewMenuRow(
    wrap: HTMLElement,
    menu: HTMLElement,
    key: string,
    name: string,
    saved: boolean,
  ): void {
    const row = menu.createDiv({
      cls: 'ktm-viewmenu-row',
      attr: {
        'data-view': key,
        'data-selected': String(this.view === key),
        ...(saved ? { 'data-saved': 'true' } : {}),
      },
    });
    if (saved) {
      const grip = row.createSpan({ cls: 'ktm-viewmenu-grip' });
      setIcon(grip, 'grip-vertical');
      this.registerDomEvent(grip, 'click', (ev) => ev.stopPropagation());
    }
    if (saved && this.viewRenameKey === key) {
      this.renderViewRenameField(wrap, row, key, name);
      return;
    }
    row.createSpan({ cls: 'ktm-viewmenu-row-title', text: name });
    // Darstellung, die diese Zeile mitbringt (012, Ergänzung 2026-10-25
    // "Ansicht-Menü, Darstellungen"): rechts Icon und Name, wo es eine gibt.
    const rowMode = rememberedMode(key, this.savedViews(), this.plugin.settings.viewModes);
    const rowModeInfo = rowMode ? VIEW_MODES.find((m) => m.key === rowMode) : undefined;
    if (rowModeInfo) {
      const modeEl = row.createSpan({ cls: 'ktm-viewmenu-mode' });
      setIcon(modeEl.createSpan(), rowModeInfo.icon);
      modeEl.createSpan({ text: rowModeInfo.name });
    }
    if (saved) {
      const rename = row.createSpan({ cls: 'ktm-viewmenu-rename', attr: { 'aria-label': 'Umbenennen' } });
      setIcon(rename, 'pencil');
      this.registerDomEvent(rename, 'click', (ev) => {
        ev.stopPropagation();
        this.viewRenameKey = key;
        this.renderViewMenu(wrap);
      });
      const del = row.createSpan({ cls: 'ktm-viewmenu-delete', attr: { 'aria-label': 'Löschen' } });
      setIcon(del, 'x');
      this.registerDomEvent(del, 'click', (ev) => {
        ev.stopPropagation();
        void this.deleteSavedViewRow(key);
      });
    }
    this.registerDomEvent(row, 'click', () => void this.selectView(key));
  }

  // Macht den Namen in der Zeile zu einem Textfeld (001, Ergänzung
  // 2026-10-18, "Ansicht-Menü"): Enter prüft mit validateViewName und
  // speichert oder zeigt ein Notice und behält den alten Namen (K6), Escape
  // verwirft ohne zu prüfen.
  private renderViewRenameField(wrap: HTMLElement, row: HTMLElement, key: string, name: string): void {
    const input = row.createEl('input', { type: 'text', cls: 'ktm-viewmenu-rename-input', value: name });
    this.registerDomEvent(input, 'click', (ev) => ev.stopPropagation());
    this.registerDomEvent(input, 'keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void this.commitViewRename(wrap, key, input.value);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.viewRenameKey = undefined;
        this.renderViewMenu(wrap);
      }
    });
    input.focus();
    input.select();
  }

  private async commitViewRename(wrap: HTMLElement, key: string, rawName: string): Promise<void> {
    const existing = this.savedViews();
    const error = validateViewName(rawName, existing, key);
    this.viewRenameKey = undefined;
    if (error) {
      new Notice(error, NOTICE_DURATION);
      this.renderViewMenu(wrap);
      return;
    }
    const next = existing.map((v) => (v.key === key ? { ...v, name: rawName.trim() } : v));
    await this.plugin.saveSavedViews(next);
    await this.render();
  }

  // Löschen ohne Rückfrage (001 S36): plugin.deleteSavedView räumt filters,
  // spotlights und die eingeklappten Zustände mit auf; zeigte das Board
  // gerade diese Ansicht, fällt es auf "Alle Aufgaben" zurück.
  private async deleteSavedViewRow(key: string): Promise<void> {
    await this.plugin.deleteSavedView(key);
    if (this.view === key) this.view = VIEW_ALL;
    await this.render();
  }

  private async selectView(key: string): Promise<void> {
    this.closeViewMenu();
    this.view = key;
    this.mode = rememberedMode(key, this.savedViews(), this.plugin.settings.viewModes) ?? this.mode;
    await this.applyState();
  }

  private installViewMenuHandlers(wrap: HTMLElement): void {
    const doc = this.contentEl.doc;
    const onKeydown = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') this.closeViewMenu();
    };
    // Wie installFilterMenuHandlers (Wissen #558): Obsidians eigenes Menu
    // (z.B. ein Kontextmenü) liegt außerhalb dieses Popovers.
    const onClick = (ev: MouseEvent): void => {
      const target = ev.target as HTMLElement;
      if (wrap.contains(target)) return;
      if (target.closest?.('.menu')) return;
      this.closeViewMenu();
    };
    doc.addEventListener('keydown', onKeydown, true);
    doc.addEventListener('click', onClick, true);
    this.viewMenuCleanup = () => {
      doc.removeEventListener('keydown', onKeydown, true);
      doc.removeEventListener('click', onClick, true);
    };
  }

  private async applyState(): Promise<void> {
    await this.plugin.saveViewState(this.view, this.level);
    await this.render();
  }

  private viewDisplayName(view: string): string {
    if (view === VIEW_ALL) return 'Alle Aufgaben';
    if (view === VIEW_INTERNAL) return 'Intern';
    const project = this.projects.find((p) => p.key === view);
    if (project) return project.name;
    return this.savedViews().find((v) => v.key === view)?.name ?? view;
  }

  // Marke "geändert" (012, Ergänzung 2026-10-25 "Marke 'geändert'"): nur wenn
  // die aktuelle Ansicht eine Darstellung mitbringt und this.mode davon
  // abweicht. Steht im selben Teil der Kopfzeile wie das Ansicht-Menü, direkt
  // davor (renderToolbar).
  private renderChangedMark(parent: HTMLElement): void {
    const remembered = rememberedMode(this.view, this.savedViews(), this.plugin.settings.viewModes);
    if (remembered === undefined || remembered === this.mode) {
      this.changedMenuOpen = false;
      return;
    }
    const wrap = parent.createDiv({ cls: 'ktm-changed-wrap' });
    const mark = wrap.createDiv({ cls: 'ktm-changed' });
    mark.createSpan({ cls: 'ktm-changed-dot' });
    mark.createSpan({ cls: 'ktm-changed-text', text: 'geändert' });
    setIcon(mark.createSpan({ cls: 'ktm-changed-chevron' }), 'chevron-down');
    this.registerDomEvent(mark, 'click', () => this.toggleChangedMenu(wrap));
    if (this.changedMenuOpen) this.renderChangedMenu(wrap);
  }

  private toggleChangedMenu(wrap: HTMLElement): void {
    if (this.changedMenuOpen) {
      this.closeChangedMenu();
      return;
    }
    this.changedMenuOpen = true;
    this.renderChangedMenu(wrap);
  }

  private closeChangedMenu(): void {
    if (!this.changedMenuOpen) return;
    this.changedMenuOpen = false;
    this.changedMenuCleanup?.();
    this.changedMenuCleanup = undefined;
    this.contentEl.querySelector('.ktm-changedmenu')?.remove();
  }

  // Popover in der Form des Ansicht-Menüs (012 "Marke 'geändert'"), dieselben
  // Aktionszeilen wie am Ende des Ansicht-Menüs (modeActions).
  private renderChangedMenu(wrap: HTMLElement): void {
    this.changedMenuCleanup?.();
    this.changedMenuCleanup = undefined;
    wrap.querySelector('.ktm-changedmenu')?.remove();
    const menu = wrap.createDiv({ cls: 'ktm-changedmenu' });
    for (const action of this.modeActions()) this.renderModeActionRow(menu, action);
    this.installChangedMenuHandlers(wrap);
  }

  private installChangedMenuHandlers(wrap: HTMLElement): void {
    const doc = this.contentEl.doc;
    const onKeydown = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') this.closeChangedMenu();
    };
    // Wie installViewMenuHandlers (Wissen #558): Obsidians eigenes Menu liegt
    // außerhalb dieses Popovers.
    const onClick = (ev: MouseEvent): void => {
      const target = ev.target as HTMLElement;
      if (wrap.contains(target)) return;
      if (target.closest?.('.menu')) return;
      this.closeChangedMenu();
    };
    doc.addEventListener('keydown', onKeydown, true);
    doc.addEventListener('click', onClick, true);
    this.changedMenuCleanup = () => {
      doc.removeEventListener('keydown', onKeydown, true);
      doc.removeEventListener('click', onClick, true);
    };
  }

  // Aktionszeilen, die Marke "geändert" und Ansicht-Menü gemeinsam nutzen
  // (012 "Marke 'geändert'"): für eine gespeicherte Ansicht nur bei
  // Abweichung drei Einträge (überschreiben/speichern/verwerfen); für "Alle
  // Aufgaben", "intern" und Projekte immer ein Eintrag (merken/nicht mehr
  // merken), bei Abweichung ebenfalls die drei Einträge aus dem Menü der Marke.
  private modeActions(): ModeAction[] {
    const view = this.view;
    const saved = this.savedViews().find((v) => v.key === view);
    const remembered = rememberedMode(view, this.savedViews(), this.plugin.settings.viewModes);
    const deviates = remembered !== undefined && remembered !== this.mode;
    const modeName = (key: string): string => VIEW_MODES.find((m) => m.key === key)?.name ?? key;
    const viewName = this.viewDisplayName(view);

    if (saved) {
      if (!deviates) return [];
      return [
        {
          text: `„${saved.name}“ überschreiben`,
          icon: 'save',
          run: async (): Promise<void> => {
            const next = this.savedViews().map((v) => (v.key === saved.key ? { ...v, mode: this.mode } : v));
            await this.plugin.saveSavedViews(next);
            await this.render();
          },
        },
        {
          text: 'Als neue Ansicht speichern …',
          icon: 'plus',
          run: async (): Promise<void> => {
            await this.saveAsView();
          },
        },
        {
          text: 'Änderungen verwerfen',
          icon: 'rotate-ccw',
          run: async (): Promise<void> => {
            this.mode = remembered;
            await this.render();
          },
        },
      ];
    }

    if (remembered === undefined) {
      return [
        {
          text: `${modeName(this.mode)} für ${viewName} merken`,
          icon: 'pin',
          run: async (): Promise<void> => {
            await this.plugin.saveViewModes(view, this.mode);
            await this.render();
          },
        },
      ];
    }
    if (!deviates) {
      return [
        {
          text: `${modeName(this.mode)} nicht mehr für ${viewName} merken`,
          icon: 'pin-off',
          run: async (): Promise<void> => {
            await this.plugin.saveViewModes(view, undefined);
            await this.render();
          },
        },
      ];
    }
    return [
      {
        text: `${modeName(this.mode)} für ${viewName} merken`,
        icon: 'pin',
        run: async (): Promise<void> => {
          await this.plugin.saveViewModes(view, this.mode);
          await this.render();
        },
      },
      {
        text: 'Als neue Ansicht speichern …',
        icon: 'plus',
        run: async (): Promise<void> => {
          await this.saveAsView();
        },
      },
      {
        text: `Zurück zu ${modeName(remembered)}`,
        icon: 'rotate-ccw',
        run: async (): Promise<void> => {
          this.mode = remembered;
          await this.render();
        },
      },
    ];
  }

  private renderModeActionRow(parent: HTMLElement, action: ModeAction): void {
    const row = parent.createDiv({ cls: 'ktm-viewmenu-action' });
    setIcon(row.createSpan({ cls: 'ktm-viewmenu-action-icon' }), action.icon);
    row.createSpan({ cls: 'ktm-viewmenu-action-text', text: action.text });
    this.registerDomEvent(row, 'click', (ev) => {
      ev.stopPropagation();
      void action.run();
    });
  }

  // The "Heute" area above the columns: open tasks planned for today and open
  // overdue tasks, across every project and level, rendered as one wrapping tile
  // grid ordered by the configured key sequence (F020). It grows downward from
  // the toolbar and pushes the columns down. With nothing to report it folds to
  // its header showing "nichts anliegend"; with content it honours the manual
  // collapse state remembered per view.
  private renderToday(parent: HTMLElement, elements: BoardElement[]): void {
    const notifyPlanned = this.plugin.settings.notifyPlanned ?? true;
    const notifyDue = this.plugin.settings.notifyDue ?? true;
    // "Heute folgt der Auswahl" (004, Ergänzung 2026-10-24): eingeschaltet
    // sieht "Heute" nur, was das Board in Ansicht und Filter gerade
    // einschließt. Eine Heute-Kachel liegt immer auf der untersten Ebene
    // ihres Projekts (today(), F072 S22), also ist el.type schon ihr
    // bottomType für isVisibleUnderSelection. Status wirkt wie auf dem Board
    // nicht (001, Ergänzung 2026-10-25, S51).
    const follows = this.plugin.isTodayFollows(this.view);
    const todaySelection: FilterSelection = { ...this.filterSelection, statuses: new Set() };
    const sieved = follows
      ? elements.filter(
          (el) => this.isVisibleInCurrentView(el) && isVisibleUnderSelection(el, todaySelection, el.type),
        )
      : elements;
    const { overdue, dueToday, planned } = today(
      sieved,
      this.today,
      (task) => this.doneStatuses(task.project).has(task.status),
      notifyPlanned,
      (project) => this.projectSettings(project).levels,
      notifyDue,
    );
    const tiles: TodayTile[] = [
      ...overdue.map((el) => ({ element: el, kind: 'overdue' as const, date: el.due ?? '' })),
      ...dueToday.map((el) => ({ element: el, kind: 'due' as const, date: el.due ?? '' })),
      ...planned.map((el) => ({ element: el, kind: 'planned' as const, date: el.planned ?? '' })),
    ];
    const hasContent = tiles.length > 0;
    const collapsed = hasContent ? this.plugin.isTodayCollapsed(this.view) : true;
    const area = parent.createDiv({ cls: 'ktm-today', attr: { 'data-collapsed': String(collapsed) } });
    this.renderTodayHeader(area, overdue.length, dueToday.length, planned.length, hasContent, collapsed, follows);
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
    dueToday: number,
    planned: number,
    hasContent: boolean,
    collapsed: boolean,
    follows: boolean,
  ): void {
    const header = area.createDiv({ cls: 'ktm-today-header' });
    const toggle = header.createSpan({ cls: 'ktm-today-toggle' });
    setIcon(toggle, collapsed ? 'chevron-right' : 'chevron-down');
    header.createSpan({ cls: 'ktm-today-title', text: 'Heute' });
    if (hasContent) {
      if (overdue > 0) this.renderTodayCount(header, 'overdue', ICON_DUE, `${overdue} überfällig`);
      if (dueToday > 0) this.renderTodayCount(header, 'due', ICON_DUE, `${dueToday} heute fällig`);
      if (planned > 0) this.renderTodayCount(header, 'planned', ICON_PLANNED, `${planned} heute geplant`);
    } else {
      header.createSpan({ cls: 'ktm-today-none', text: 'nichts anliegend' });
    }
    header.createSpan({ cls: 'ktm-today-spacer' });
    // Immer gerendert und verdrahtet, auch eingeklappt und bei "nichts
    // anliegend" (004, Ergänzung 2026-10-24). stopPropagation, sonst klappt
    // der Klick zusätzlich die eingeklappte Kopfzeile auf (Wissen #709).
    const follow = header.createSpan({
      cls: 'ktm-today-follow',
      attr: {
        'data-on': String(follows),
        'aria-pressed': String(follows),
        'aria-label': 'Heute folgt der Auswahl',
      },
    });
    setIcon(follow, 'filter');
    this.registerDomEvent(follow, 'click', (ev) => {
      ev.stopPropagation();
      void this.toggleTodayFollows(follows);
    });
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

  private async toggleTodayFollows(current: boolean): Promise<void> {
    await this.plugin.saveTodayFollows(this.view, !current);
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
      attr: {
        'data-card-id': card.paths.note,
        'data-kind': tile.kind,
        'data-priority': String(card.priority),
        tabindex: '0',
      },
    });
    item.createDiv({ cls: 'ktm-today-item-title', attr: { title: card.title }, text: card.title });

    const meta = item.createDiv({ cls: 'ktm-today-item-meta' });
    const dateEl = meta.createSpan({
      cls: 'ktm-today-date-signal',
      attr: { 'data-signal': tile.kind === 'overdue' ? 'overdue' : 'today' },
    });
    setIcon(
      dateEl.createSpan({ cls: 'ktm-today-item-icon' }),
      tile.kind === 'planned' ? ICON_PLANNED : ICON_DUE,
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
    if (this.isAllScope()) return true;
    if (this.view === VIEW_INTERNAL) return !el.project;
    return el.project === this.view;
  }

  // Entry point of the "Neue Aufgabe" command and toolbar button: an element
  // at the current project's bottom level (F072 S22), first column's status,
  // with the view's opening default (003 S13).
  startCreate(): void {
    const level = this.draftLevel();
    this.openDraft(level, this.defaultStatus(), this.chainParentFor(level));
  }

  // The parent a new draft prefills under the active filter (001, Ergänzung
  // 2026-10-18, "Neue Aufgabe bei aktivem Filter"): the deepest element of a
  // single selected chain above the draft's own level, or undefined when the
  // selection is empty, branches, or has no element above that level.
  private chainParentFor(level: ElementType): BoardElement | undefined {
    return chainParent(this.filterSelection.ids, [...this.elementByPath.values()], level);
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
      id: '',
      type,
      form: defaults.form,
      title: '',
      status,
      project: defaults.project,
      priority: DRAFT_PRIORITY,
      tags: [],
      // The parent's whole chain, nearest first (F105 parentChain reversed,
      // like CardDetail#pickParent), so the draft shows every ancestor —
      // not just the direct parent — under Verknüpfungen (001, Ergänzung
      // 2026-10-18, S25 "Feature und sein Epic").
      parents: parent ? [...parentChain(parent)].reverse() : [],
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
      // A project without a root has no Standardablage (011, Ergänzung
      // 2026-09-25, S83): its draft goes atomic like "alle"/"intern", but
      // keeps the project's own key so the new note still carries it (K30).
      if (!project.root) return { form: 'atomic', project: project.key, parentLabel: 'Atomar' };
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
      parents = [{ id: source.id, type: source.type, title: source.title, note: source.paths.note }];
    }
    const element: BoardElement = {
      id: '',
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
  //
  // The move alone used to leave the source without `parent` (002, Ergänzung
  // 2026-10-18, "Gestapelter Entwurf schreibt parent"; wissen #876): the new
  // element is the source's parent now, so that write belongs here too, in
  // the same reconciling block closeDraft already wraps this call in, before
  // the Ablage (011) gets a chance to read the still-parentless note back.
  private async applyStackedRefile(
    from: StackedFrom,
    createdPath: string,
    createdId: string,
    createdTitle: string,
  ): Promise<string> {
    const source = from.source;
    if (!from.ancestor || !source.paths.folder) return source.paths.note;
    const newFolder = dirOf(createdPath);
    const plan = planRefile(
      { form: source.form, type: source.type, notePath: source.paths.note, folderPath: source.paths.folder },
      { parentFolder: newFolder },
      this.childrenOf(source),
      this.siblingNames(newFolder),
    );
    if (plan.move) await moveElement(this.app, plan.move.from, plan.move.to, plan.move.parent, false);
    const frontmatter: FrontmatterChange = { parent: createdId };
    const parentLink = parentLinkTo(this.app, createdPath, plan.notePath, createdTitle);
    if (parentLink) frontmatter.parent_link = yamlScalar(parentLink);
    await writeFrontmatter(this.app, plan.notePath, frontmatter);
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
        this.openDraft(this.level, column.status, this.chainParentFor(this.level));
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

  // `week` und `mark` trennen zwei frühere Bedeutungen desselben Parameters
  // (012 "Statusmarke"): `mark` zeigt die Statusmarke (Woche, Matrix), `week`
  // blendet Geplant in der Metazeile aus (nur Woche, dort steht es schon in
  // der Tagesspalte).
  private renderCard(
    parent: HTMLElement,
    card: BoardElement,
    done: boolean,
    today: string,
    week = false,
    mark = week,
  ): void {
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
        ...(this.spotlightId !== undefined && !isUnderSpotlight(card, this.spotlightId)
          ? { 'data-spotlight': 'dim' }
          : {}),
      },
    });

    // In der Woche steht Geplant schon in der Tagesspalte, nicht noch einmal
    // in der Metazeile (012 "Woche").
    const fields = week ? this.cardFields.filter((f) => f !== 'planned') : this.cardFields;
    const showProject = this.isAllScope() && fields.includes('project');
    const ancestors = fields.includes('parents') ? this.ancestorChips(card) : [];
    const tagList = effectiveTags(this.plugin.settings, this.projects.find((p) => p.key === card.project));
    renderCardFace(cardEl, card, fields, today, done, showProject, ancestors, tagList);
    this.installAncestorChipHandlers(cardEl);
    // Statusmarke (012 "Statusmarke"): auf Karten in Woche, Agenda und Matrix.
    if (mark) {
      renderStatusMark(cardEl, card.status, this.statusNameFor(card), statusTone(card.status, this.columns));
    }

    // "Ordner nicht eindeutig" (011 S91, K32): a card whose own folder holds
    // two or more element notes with no single one of them recognized as its
    // owner. Like "ungültig" it is a word in the metazeile, in the orange
    // signal color instead of red (DESIGN.md Karte, addendum 011).
    if (card.form !== 'atomic' && isAmbiguousFolder(card.paths.folder, [...this.elementByPath.values()], this.roots)) {
      cardEl.setAttribute('data-placement-notice', 'true');
      const meta = cardEl.querySelector<HTMLElement>('.ktm-card-meta') ?? cardEl.createDiv({ cls: 'ktm-card-meta' });
      meta.createSpan({ cls: 'ktm-card-meta-item ktm-card-placement-notice', text: 'Ordner nicht eindeutig' });
    }
  }

  // Hervorhebungs-Klick auf einen Ebenen-Chip der Karte (001, Ergänzung
  // 2026-10-18): Einfachklick (ev.detail === 1) hebt hervor/versetzt/hebt
  // auf, Doppelklick setzt stattdessen den Filter; beide stoppen die
  // Weiterleitung. Das Öffnen der Karte unterdrückt onPointerUp für einen
  // Klick, der hier begann (drag.fromChip); ein echtes Ziehen bleibt möglich.
  private installAncestorChipHandlers(cardEl: HTMLElement): void {
    for (const chip of cardEl.querySelectorAll<HTMLElement>('.ktm-card-parent[data-ancestor-id]')) {
      const ancestorId = chip.dataset.ancestorId;
      if (!ancestorId) continue;
      this.registerDomEvent(chip, 'click', (ev) => {
        ev.stopPropagation();
        if (ev.detail !== 1) return;
        void this.toggleSpotlight(ancestorId);
      });
      this.registerDomEvent(chip, 'dblclick', (ev) => {
        ev.stopPropagation();
        void this.setFilterFromChip(ancestorId);
      });
    }
    // Tag-Chips, Text- und Icon-Form (001/002, Ergänzung 2026-10-25): Klick
    // hebt den Tag hervor, Doppelklick setzt den Filter auf genau diesen Tag.
    for (const chip of cardEl.querySelectorAll<HTMLElement>('.ktm-card-tag[data-tag], .ktm-chip.is-icon[data-tag]')) {
      const tag = chip.dataset.tag;
      if (!tag) continue;
      this.registerDomEvent(chip, 'click', (ev) => {
        ev.stopPropagation();
        if (ev.detail !== 1) return;
        void this.toggleSpotlight(`tag:${tag}`);
      });
      this.registerDomEvent(chip, 'dblclick', (ev) => {
        ev.stopPropagation();
        void this.setFilterFromTagChip(tag);
      });
    }
    // Projekt-Chip (001, Ergänzung 2026-10-25): Klick hebt hervor; kein
    // Doppelklick (die Spec sieht ihn nur für Ebenen- und Tag-Chip vor).
    const projectChip = cardEl.querySelector<HTMLElement>('.ktm-card-project[data-project]');
    if (projectChip) {
      const project = projectChip.dataset.project ?? '';
      this.registerDomEvent(projectChip, 'click', (ev) => {
        ev.stopPropagation();
        if (ev.detail !== 1) return;
        void this.toggleSpotlight(`project:${project}`);
      });
    }
    // Statusmarke (012 "Statusmarke"): Klick hebt den Status hervor, über
    // denselben "status:"-Pfad wie die Hervorhebungs-Anzeige (filter.ts).
    const statusMark = cardEl.querySelector<HTMLElement>('.ktm-status[data-status]');
    if (statusMark) {
      const status = statusMark.dataset.status ?? '';
      this.registerDomEvent(statusMark, 'click', (ev) => {
        ev.stopPropagation();
        void this.toggleSpotlight(`status:${status}`);
      });
    }
  }

  // DESIGN.md "Ungültige Karte": the meta row keeps reading exactly
  // "ungültig" in every case (011); the reason (missing field, or "Kennung
  // doppelt") only shows as a tooltip/aria-label and as data-invalid-reason
  // (K10-K13). A duplicate additionally offers "Neue Kennung vergeben"
  // (011 S59): it writes only `ktm_id` to a fresh, vault-unique value.
  // Eine ungültige Karte wird nie hervorgehoben (001 S30, K7): sie bleibt bei
  // aktiver Hervorhebung deshalb immer gedimmt (isUnderSpotlight liefert für
  // sie stets false).
  private renderInvalidCard(parent: HTMLElement, card: BoardElement): void {
    const reason = card.invalidReason ?? '';
    const cardEl = parent.createDiv({
      cls: 'ktm-card',
      attr: {
        'data-invalid': 'true',
        'data-card-id': card.paths.note,
        'data-invalid-reason': reason,
        tabindex: '0',
        ...(this.spotlightId !== undefined ? { 'data-spotlight': 'dim' } : {}),
      },
    });
    const titleRow = cardEl.createDiv({ cls: 'ktm-card-titlerow', attr: { title: card.title } });
    titleRow.createSpan({ cls: 'ktm-card-title', text: card.title });
    const meta = cardEl.createDiv({
      cls: 'ktm-card-meta',
      attr: { title: reason, 'aria-label': reason },
    });
    meta.createSpan({ text: 'ungültig' });
    // Projekt-Chip wie auf der gültigen Karte, nur in "Alle Aufgaben" (011
    // S98-S100, F123): dieselbe Bedingung wie showProject in renderCard, kein
    // neues Styling.
    if (this.isAllScope() && this.cardFields.includes('project')) {
      const chips = cardEl.createDiv({ cls: 'ktm-card-chips' });
      chips.createSpan({ cls: 'ktm-card-chip ktm-card-project', text: card.project || 'intern' });
    }
    if (card.duplicate) {
      const button = cardEl.createEl('button', { cls: 'ktm-button', text: 'Neue Kennung vergeben' });
      this.registerDomEvent(button, 'click', (ev) => {
        ev.stopPropagation();
        void this.persist('Neue Kennung vergeben', card.paths.note, async () => {
          await writeFrontmatter(this.app, card.paths.note, { ktm_id: newId(this.knownIds) });
        });
      });
    }
  }

  // One chip per level above the card's own on which it has an ancestor, top
  // to bottom (Epic before Feature before User Story, 009 addendum
  // 2026-09-20): icon from the card's own project's level list, so a chip
  // still resolves right in the "all" view where that can differ from the
  // levels shown. A missing ancestor on some intermediate level yields no
  // chip for it, not a gap that shifts the rest.
  private ancestorChips(card: BoardElement): AncestorChip[] {
    const settings = this.projectSettings(card.project);
    const levels = settings.levels;
    const parentByType = new Map(card.parents.map((p) => [p.type, p]));
    const ownIndex = levels.findIndex((l) => l.key === card.type);
    const above = ownIndex === -1 ? levels.length : ownIndex;
    const chips: AncestorChip[] = [];
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
          id: ancestor.id,
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
    if (!ok) return;
    this.focusCard(path);
    // Ablageregel 1 (011, Ergänzung 2026-09-25): the status write above is
    // enough on its own now — main.ts#placeElement reacts to the changed
    // `status` field itself and files a closed element under Done/, or back
    // out of it, without a separate call here.
  }

  private focusCard(path: string): void {
    const el = this.contentEl.querySelector(`.ktm-card[data-card-id="${path}"]`);
    if (el instanceof HTMLElement) el.focus();
  }

  private onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    // Ziehen einer gespeicherten Ansicht im Ansicht-Menü (001, Ergänzung
    // 2026-10-18 "Ansichten per Ziehen ordnen"): ein eigener Zustand statt
    // des Kartenzugs (Wissen #1032), damit der Griff nie versehentlich einen
    // Kartenzug blockiert.
    const grip = ev.target instanceof Element ? ev.target.closest('.ktm-viewmenu-grip') : null;
    if (grip instanceof HTMLElement) {
      const row = grip.closest<HTMLElement>('.ktm-viewmenu-row[data-saved="true"]');
      const key = row?.dataset.view;
      if (key) this.viewDrag = { key, pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY, active: false };
      return;
    }
    // Ziehen eines Darstellungs-Icons (012 S3): ebenfalls ein eigener
    // Zugzustand, getrennt vom Kartenzug (SwitchDragState).
    const switchButton = ev.target instanceof Element ? ev.target.closest<HTMLElement>('.ktm-viewswitch-button') : null;
    if (switchButton) {
      const mode = switchButton.dataset.mode;
      if (isViewModeKey(mode)) {
        this.switchDrag = { mode, pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY, active: false };
      }
      return;
    }
    const card = ev.target instanceof Element ? ev.target.closest('.ktm-card') : null;
    // Woche hält ihre Karten in .ktm-week statt .ktm-columns, die Matrix in
    // .ktm-matrix (012 "Woche", "Matrix").
    if (!(card instanceof HTMLElement) || !card.closest('.ktm-columns, .ktm-week, .ktm-matrix')) return;
    if (card.closest('.ktm-column[data-unknown="true"]')) return;
    const { cardId, status } = card.dataset;
    if (!cardId || status === undefined) return;
    // Ein Ebenen-Chip handhabt den reinen Klick und den Doppelklick selbst
    // (001, Ergänzung 2026-10-18, "Hervorheben"/"Doppelklick setzt den
    // Filter", K1): das Ziehen der Karte beginnt trotzdem normal, falls der
    // Zeiger über die Schwelle hinaus bewegt wird (onPointerUp unterdrückt
    // nur das Öffnen, wenn daraus kein Drag wurde).
    // Tag- und Projekt-Chips zählen seit 001, Ergänzung 2026-10-25 ebenfalls
    // als Chip (Wissen #1032): sie behandeln Klick/Doppelklick selbst
    // (installAncestorChipHandlers), nur das Ziehen von dort läuft normal.
    const fromChip =
      ev.target instanceof Element &&
      !!ev.target.closest(
        '.ktm-card-parent[data-ancestor-id], .ktm-card-tag[data-tag], .ktm-chip.is-icon[data-tag], .ktm-card-project[data-project], .ktm-status[data-status]',
      );
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
      fromChip,
    };
  }

  private onPointerMove(ev: PointerEvent): void {
    const viewDrag = this.viewDrag;
    if (viewDrag && ev.pointerId === viewDrag.pointerId) {
      if (!viewDrag.active) {
        if (Math.hypot(ev.clientX - viewDrag.startX, ev.clientY - viewDrag.startY) < DRAG_THRESHOLD) return;
        viewDrag.active = true;
      }
      return;
    }
    const switchDrag = this.switchDrag;
    if (switchDrag && ev.pointerId === switchDrag.pointerId) {
      if (!switchDrag.active) {
        if (Math.hypot(ev.clientX - switchDrag.startX, ev.clientY - switchDrag.startY) < DRAG_THRESHOLD) return;
        switchDrag.active = true;
      }
      this.updateViewSwitchMarker(switchDrag, ev.clientX);
      return;
    }
    const drag = this.drag;
    if (!drag || ev.pointerId !== drag.pointerId) return;

    if (!drag.active) {
      if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < DRAG_THRESHOLD) return;
      this.startDrag(drag);
    }

    drag.lastX = ev.clientX;
    drag.lastY = ev.clientY;
    if (drag.ghost) {
      // ev.clientX/grabX sind Bildschirm-Pixel (wie rect in startDrag); der
      // Ghost trägt denselben zoom wie das Board, die Differenz muss daher
      // durch den Faktor geteilt werden (001, Ergänzung 2026-10-24).
      const zoom = this.boardZoomFactor();
      drag.ghost.style.left = `${(ev.clientX - drag.grabX) / zoom}px`;
      drag.ghost.style.top = `${(ev.clientY - drag.grabY) / zoom}px`;
    }
    this.updateDropTarget(drag, ev.clientX, ev.clientY);
  }

  private startDrag(drag: DragState): void {
    const doc = this.contentEl.doc;
    const rect = drag.card.getBoundingClientRect();
    // Der Ghost sitzt im body, außerhalb des gezoomten Boards: derselbe zoom
    // lässt ihn optisch zur gezogenen Karte passen, verlangt dafür aber
    // dieselbe Umrechnung screen-px -> Board-Einheiten wie cardEl in
    // animateOpen (001, Ergänzung 2026-10-24), sonst stünde er doppelt so
    // groß/weit da.
    const zoom = this.boardZoomFactor();

    const ghost = drag.card.cloneNode(true) as HTMLElement;
    ghost.addClass('ktm-drag-ghost');
    ghost.style.zoom = String(zoom);
    ghost.style.width = `${rect.width / zoom}px`;
    ghost.style.height = `${rect.height / zoom}px`;
    ghost.style.left = `${rect.left / zoom}px`;
    ghost.style.top = `${rect.top / zoom}px`;
    doc.body.appendChild(ghost);

    const placeholder = doc.createElement('div');
    placeholder.addClass('ktm-drop-placeholder');
    placeholder.style.height = `${rect.height / zoom}px`;

    drag.card.setAttribute('data-dragging', 'true');
    drag.active = true;
    drag.ghost = ghost;
    drag.placeholder = placeholder;
    // contentEl übersteht jedes render (nur sein Inhalt wird geleert), damit
    // trifft pointerup hier auch, wenn der Zeiger die View verlässt. Die
    // Capture-Zusage ist best effort: ohne eine vom UA als aktiv geführte
    // Pointer-Session (etwa bei synthetisch ausgelösten Pointer-Events) wirft
    // setPointerCapture NotFoundError; das Fangen hier ist harmlos, der Zug
    // läuft über drag.active ohnehin weiter.
    try {
      this.contentEl.setPointerCapture(drag.pointerId);
    } catch {
      // siehe Kommentar oben
    }
    this.autoScroll(drag);
  }

  // Mitscrollen am Rand einer langen Spalte (003, Ergänzung 2026-10-18 K11/K12):
  // läuft, solange das Ziehen aktiv ist, unabhängig von weiteren
  // pointermove-Ereignissen — die kommen beim Halten am Rand gerade nicht.
  // Jeder Tick, der scrollt, ruft updateDropTarget mit der zuletzt bekannten
  // Position erneut auf, damit der Platzhalter der neuen Scrollposition folgt.
  private autoScroll(drag: DragState): void {
    const win = this.contentEl.win;
    const tick = (): void => {
      if (this.drag !== drag) return;
      const body = drag.targetColumn?.querySelector<HTMLElement>('.ktm-column-body');
      if (body && drag.lastX !== undefined && drag.lastY !== undefined) {
        const rect = body.getBoundingClientRect();
        const y = drag.lastY;
        let delta = 0;
        if (y > rect.top && y < rect.top + AUTOSCROLL_EDGE) delta = -AUTOSCROLL_STEP;
        else if (y < rect.bottom && y > rect.bottom - AUTOSCROLL_EDGE) delta = AUTOSCROLL_STEP;
        if (delta !== 0) {
          const next = Math.max(0, Math.min(body.scrollTop + delta, body.scrollHeight - body.clientHeight));
          if (next !== body.scrollTop) {
            body.scrollTop = next;
            this.updateDropTarget(drag, drag.lastX, drag.lastY);
          }
        }
      }
      drag.scrollFrame = win.requestAnimationFrame(tick);
    };
    drag.scrollFrame = win.requestAnimationFrame(tick);
  }

  // Recomputes on every move, not only on a column change: within the same
  // column the insertion point still shifts with the pointer. The placeholder
  // sits before the card whose vertical centre lies below the pointer
  // (DESIGN.md §Zustaende); that card's path is remembered as the drop's
  // anchor (F127 U2), not a DOM index. Leaving every column removes the
  // placeholder and the anchor outright (K7): there is nothing to drop at
  // until the pointer re-enters one.
  private updateDropTarget(drag: DragState, x: number, y: number): void {
    const column = this.columnAt(x, y);
    if (column !== drag.targetColumn) {
      drag.targetColumn?.removeAttribute('data-drop-target');
      drag.targetColumn = column ?? undefined;
      if (column) column.setAttribute('data-drop-target', 'true');
    }
    if (!column || !drag.placeholder) {
      drag.targetStatus = undefined;
      drag.targetDay = undefined;
      drag.targetQuadrant = undefined;
      drag.beforePath = undefined;
      drag.placeholder?.remove();
      return;
    }
    drag.targetStatus = column.dataset.status;
    drag.targetDay = column.dataset.day;
    drag.targetQuadrant = isMatrixQuadrant(column.dataset.quadrant) ? column.dataset.quadrant : undefined;
    const body = column.querySelector('.ktm-column-body');
    if (!body) return;
    const cards = [
      ...body.querySelectorAll<HTMLElement>('.ktm-card:not([data-dragging]):not([data-invalid])'),
    ];
    let before: HTMLElement | undefined;
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        before = card;
        break;
      }
    }
    drag.beforePath = before?.dataset.cardId;
    if (before) body.insertBefore(drag.placeholder, before);
    else body.appendChild(drag.placeholder);
  }

  private columnAt(x: number, y: number): HTMLElement | null {
    const el = this.contentEl.doc.elementFromPoint(x, y);
    const column = el instanceof Element ? el.closest('.ktm-column') : null;
    return column instanceof HTMLElement ? column : null;
  }

  private async onPointerUp(ev: PointerEvent): Promise<void> {
    const viewDrag = this.viewDrag;
    if (viewDrag && ev.pointerId === viewDrag.pointerId) {
      this.viewDrag = undefined;
      if (viewDrag.active) await this.dropSavedView(viewDrag.key, ev.clientY);
      return;
    }
    const switchDrag = this.switchDrag;
    if (switchDrag && ev.pointerId === switchDrag.pointerId) {
      const wasActive = switchDrag.active;
      const mode = switchDrag.mode;
      const beforeMode = switchDrag.beforeMode;
      this.endDrag();
      if (!wasActive) {
        this.setMode(mode);
        return;
      }
      const order = resolveViewOrder(this.plugin.settings.viewOrder).map((key) => ({ key }));
      const next = moveSavedView(order, mode, beforeMode);
      await this.plugin.saveViewOrder(next.map((v) => v.key));
      await this.render();
      return;
    }
    const drag = this.drag;
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const targetStatus = drag.targetStatus;
    const targetDay = drag.targetDay;
    const targetQuadrant = drag.targetQuadrant;
    const beforePath = drag.beforePath;
    const wasActive = drag.active;
    const fromChip = drag.fromChip;
    this.endDrag();
    if (!wasActive) {
      // Ein reiner Klick, der auf einem Ebenen-Chip begann, öffnet die Karte
      // nicht (K1): der Chip selbst hat die Hervorhebung bereits gesetzt
      // (installAncestorChipHandlers).
      if (fromChip) return;
      const element = this.elementByPath.get(drag.path);
      if (element) await this.openDetail(element);
      return;
    }
    if (this.mode === 'week') {
      // Ohne Zieltag, also mit dem Zeiger außerhalb jeder Tagesspalte:
      // abbrechen, nichts wird geschrieben (012 "Woche", wie 003 S32/K8).
      if (targetDay === undefined) return;
      await this.applyPlanned(drag.path, targetDay);
      return;
    }
    if (this.mode === 'matrix') {
      // Ohne Zielfeld, also mit dem Zeiger außerhalb jedes Matrix-Felds:
      // abbrechen, nichts wird geschrieben (012 "Matrix", wie 003 S32/K8).
      if (targetQuadrant === undefined) return;
      const element = this.elementByPath.get(drag.path);
      if (!element) return;
      await this.applyPriority(drag.path, matrixQuadrant(element, this.today), targetQuadrant);
      return;
    }
    // Ohne Anker, also mit dem Zeiger außerhalb jeder Spalte: abbrechen,
    // nichts wird geschrieben, die Karte bleibt (003 S32/K8).
    if (targetStatus === undefined) return;
    await this.applyReorder(drag.path, drag.status, targetStatus, beforePath);
  }

  // Ziehen auf einen Tag setzt `planned`, auf "Ohne Datum" löscht es wieder;
  // `status` bleibt unberührt (012 "Woche", Wissen #526 für das Muster).
  private async applyPlanned(path: string, targetDay: string): Promise<void> {
    const element = this.elementByPath.get(path);
    if (!element) return;
    const planned = targetDay === 'none' ? undefined : targetDay;
    if ((element.planned ?? undefined) === planned) return;
    const change: FrontmatterChange = { planned: planned ?? null };
    const ok = await this.persist('Verschieben', path, () => writeFrontmatter(this.app, path, change));
    if (!ok) return;
    this.focusCard(path);
  }

  // Ziehen zwischen den Zeilen der Matrix setzt `priority`; seitwärts oder
  // innerhalb desselben Felds schreibt nichts (012 "Matrix" S30/S31, Wissen
  // #526 für das Muster).
  private async applyPriority(path: string, from: MatrixQuadrant, to: MatrixQuadrant): Promise<void> {
    const priority = matrixDropPriority(from, to);
    if (priority === undefined) return;
    const change: FrontmatterChange = { priority };
    const ok = await this.persist('Verschieben', path, () => writeFrontmatter(this.app, path, change));
    if (!ok) return;
    this.focusCard(path);
  }

  // A drop within a column or positioned into another one (003 addendum,
  // S16/S19/S36): the visible sequence (this view's own filter) maps the
  // anchor onto an index in the *project column's* own sequence — this
  // view's filter and level, but no doneLimit (U1c), since a card merely
  // hidden under doneLimit is still this view's own — via fullInsertIndex,
  // so a filtered or scroll-trimmed view never reorders a card it cannot
  // even see, and a card outside this project's column is never a neighbour
  // or a write target (#1217/#1219, F188). reorderColumn derives the order
  // writes from that same sequence, and — on a column change — the
  // status/completed change folds into the same write as the dragged card's
  // new order, guarded exactly like applyMove. In "alle" and saved views
  // this.filter() returns {kind: 'all'}, so the sequence stays the shared
  // column there, unchanged from before.
  private async applyReorder(
    path: string,
    fromStatus: string,
    toStatus: string,
    beforePath: string | undefined,
  ): Promise<void> {
    const element = this.elementByPath.get(path);
    if (!element) return;

    let statusChange: FrontmatterChange = {};
    const statusChanged = toStatus !== fromStatus;
    if (statusChanged) {
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

    const elements = [...this.elementByPath.values()];
    const visibleBoard = buildBoard(elements, this.filter(), this.columns, {
      level: this.level,
      doneLimit: this.doneLimit,
    });
    const visibleColumn = visibleBoard.columns.find((c) => c.status === toStatus);
    if (!visibleColumn) return;
    const visiblePaths = visibleColumn.cards.filter((c) => !c.invalid).map((c) => c.paths.note);

    // Bezugsfolge ist die Spalte der eigenen Ansicht, nicht die Gesamtspalte
    // aller Projekte (S36, #1217/#1219): verborgene und fremde Karten sind
    // weder Nachbar noch Schreibziel.
    const ownBoard = buildBoard(elements, this.filter(), this.columns, { level: this.level });
    const ownColumn = ownBoard.columns.find((c) => c.status === toStatus);
    if (!ownColumn) return;
    const ownCards = ownColumn.cards.filter((c) => !c.invalid);
    const ownPaths = ownCards.map((c) => c.paths.note);
    const readOrder = new Map(ownCards.map((c) => [c.paths.note, c.order]));

    const insertIndex = fullInsertIndex(visiblePaths, ownPaths, path, beforePath);
    const changes = reorderColumn(
      ownCards.map((c) => ({ path: c.paths.note, order: c.order })),
      path,
      insertIndex,
      statusChanged,
    );

    // Vor dem Schreiben gemerkt (main.ts#markOwnPlacement, F127): ein frisch
    // vergebenes order für den Spaltenwechsel in eine manuelle Spalte darf
    // der Bereinigungs-Hook nicht löschen, auch wenn es zufällig dem alten
    // order entspricht.
    const own = changes.find((c) => c.path === path);
    if (statusChanged && own && own.order !== null) this.plugin.markOwnPlacement(path);

    let failedPath = path;
    const ok = await this.persist('Verschieben', () => failedPath, async () => {
      for (const change of changes) {
        // Nur schreiben, was vom gelesenen order abweicht (U4); die gezogene
        // Karte immer, zusammen mit status/completed.
        if (change.path !== path && readOrder.get(change.path) === change.order) continue;
        failedPath = change.path;
        const order = change.order === null ? null : String(change.order);
        const frontmatter: FrontmatterChange =
          change.path === path ? this.withCanonicalStatus(element, { ...statusChange, order }) : { order };
        await writeFrontmatter(this.app, change.path, frontmatter);
      }
    });

    if (!ok) return;
    this.focusCard(path);
  }

  // Einfügestelle wie in der Reihenfolge-Liste (SettingsTab#dropTargetKey):
  // aus den aktuellen Zeilen gelesen, nicht aus einer während des Ziehens
  // mitgeführten Position. Eine Zielposition über den Projektzeilen klemmt
  // von selbst auf den Bereich der gespeicherten Ansichten (K11), weil nur
  // deren Zeilen in die Suche eingehen.
  private async dropSavedView(key: string, dropY: number): Promise<void> {
    const rows = [...this.contentEl.querySelectorAll<HTMLElement>('.ktm-viewmenu-row[data-saved="true"]')];
    let targetKey: string | undefined;
    for (const rowEl of rows) {
      const rowKey = rowEl.dataset.view;
      if (!rowKey || rowKey === key) continue;
      const rect = rowEl.getBoundingClientRect();
      if (dropY < rect.top + rect.height / 2) {
        targetKey = rowKey;
        break;
      }
    }
    const next = moveSavedView(this.savedViews(), key, targetKey);
    await this.plugin.saveSavedViews(next);
    await this.render();
  }

  private endDrag(): void {
    this.viewDrag = undefined;
    this.switchDrag = undefined;
    this.contentEl.querySelector('.ktm-viewswitch-marker')?.remove();
    this.contentEl.querySelector('.ktm-viewswitch-button[data-dragging]')?.removeAttribute('data-dragging');
    const drag = this.drag;
    this.drag = undefined;
    if (!drag) return;
    if (drag.scrollFrame !== undefined) this.contentEl.win.cancelAnimationFrame(drag.scrollFrame);
    if (drag.active) {
      try {
        this.contentEl.releasePointerCapture(drag.pointerId);
      } catch {
        // Already released (pointerup/pointercancel release it on their own).
      }
    }
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
    // A conflict or a missing note can make closeDetail() refuse to close
    // the current card (002, Ergänzung 2026-10-19, wissen #914): opening a
    // second one over it would tear the first down without saving anything.
    // A click on another card then behaves like a rejected close.
    if (!stackedFrom && !(await this.closeDetail())) return;
    const boardEl = this.contentEl.querySelector<HTMLElement>('.ktm-board');
    if (!boardEl) return;

    const base = stackedFrom ? this.detail : undefined;
    if (stackedFrom && !base) return;
    if (base) {
      this.stackedBase = base;
      base.cardEl.setAttribute('data-stacked', 'under');
    }

    // The board's last render can predate a write that just finished
    // elsewhere (hand move -> ktm_placement: manual, wissen #1079): an
    // existing card opens with the index's current element, not the one
    // drawn at the last render, exactly as retargetDetail keeps it current
    // afterwards.
    if (!draft && !stackedFrom && element.id !== undefined) {
      const fresh = this.freshElement(element.id);
      if (fresh) {
        if (fresh.paths.note !== element.paths.note) {
          this.elementByPath.delete(element.paths.note);
          this.elementByPath.set(fresh.paths.note, fresh);
        }
        element = fresh;
      }
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
        searchElements: (level, query, parentIds) => this.searchElements(level, element, query, parentIds),
        createStackedElement: (level, ancestor, title) =>
          this.openStackedDraft(level, ancestor, title, element),
        changeLevel: (type, parentId) => this.changeLevel(element, type, parentId),
        setPlacement: (value) => this.setPlacement(element, value),
        assignResult: (target, fromKind) => this.assignResult(element, target, fromKind),
        resultTargetLabel: (target) => this.resultTargetLabel(target, element.paths.note),
      },
      {
        projects: this.projects.map((p) => p.key),
        levelsFor: (project) => this.projectSettings(project).levels,
        hasRoot: (project) => !!project && !!this.projects.find((p) => p.key === project)?.root,
        linkKinds: withResultKind(this.projectSettings(element.project).linkKinds, this.plugin.settings.resultPosition),
        vaultTags: this.vaultTags(),
        tagsFor: (project) => effectiveTags(this.plugin.settings, this.projects.find((p) => p.key === project)),
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

    this.detail = {
      detail,
      path: element.paths.note,
      id: draft ? undefined : element.id,
      cardEl,
      coverEl,
      resize,
      draft,
      stackedFrom,
    };

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

    // boardRect/rect sind Bildschirm-Pixel (getBoundingClientRect); cardEl ist
    // ein Kind des gezoomten boardEl und erwartet style-px in Board-Einheiten,
    // daher durch den Zoom-Faktor geteilt (001, Ergänzung 2026-10-24).
    const zoom = this.boardZoomFactor();
    const boardRect = boardEl.getBoundingClientRect();
    const rect = origin.getBoundingClientRect();
    cardEl.style.left = `${(rect.left - boardRect.left) / zoom}px`;
    cardEl.style.top = `${(rect.top - boardRect.top) / zoom}px`;
    cardEl.style.width = `${rect.width / zoom}px`;
    cardEl.style.height = `${rect.height / zoom}px`;

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
    // clientWidth misst im eigenen (board-lokalen) Koordinatenraum des
    // gezoomten Elements, bereits in Board-Einheiten (gemessen, kein Faktor
    // nötig); getBoundingClientRect misst dagegen in Bildschirm-Pixeln und
    // muss für Board-Einheiten durch den Zoom-Faktor geteilt werden (001,
    // Ergänzung 2026-10-24).
    const boardWidth = boardEl.clientWidth;
    const openColumn = boardEl.querySelector<HTMLElement>('.ktm-column:not([data-collapsed="true"])');
    const columnWidth = openColumn
      ? openColumn.getBoundingClientRect().width / this.boardZoomFactor()
      : EXPANDED_MIN_WIDTH;
    const factor = this.plugin.settings.expandedWidthFactor ?? 3;
    let width = Math.min(factor * columnWidth, Math.floor((boardWidth * 2) / 3));
    width = Math.max(EXPANDED_MIN_WIDTH, width);
    width = Math.min(width, boardWidth - EXPANDED_MARGIN);
    return stackedOver ? width - STACK_WIDTH_INSET : width;
  }

  // Faktor der Board-Größe (001, Ergänzung 2026-10-24 "Eigene Größe des
  // Boards"): dieselbe Normalisierung wie beim Setzen von .ktm-board's zoom in
  // render(), hier zum Umrechnen von Bildschirm-Pixeln (getBoundingClientRect)
  // in Board-Einheiten für alles, was style-px innerhalb des gezoomten Boards
  // setzt.
  private boardZoomFactor(): number {
    return normalizeBoardScale(this.plugin.settings.boardScale) / 100;
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

  // Returns whether the card is closed afterwards: false for a rejected
  // close (a missing note, a same-field conflict, a blocked refile or a
  // failed write), so openDetail can refuse to open a second card over one
  // that refused to go away (002, Ergänzung 2026-10-19, wissen #914).
  private async closeDetail(): Promise<boolean> {
    const open = this.detail;
    if (!open) return true;

    if (open.draft) {
      return this.closeDraft(open);
    }

    // The note may have been moved or deleted from outside while the card was
    // open (008 S45, F068 K2): checked before this.detail is touched, so a
    // missing note leaves the card, its cover and its unsaved edits exactly as
    // they were — nothing is written, nothing is redrawn.
    const file = this.app.vault.getFileByPath(open.path);
    if (!file) {
      this.failureNotice('Schließen', open.path, 'Notiz wurde verschoben oder gelöscht');
      return false;
    }

    // Dasselbe Feld von außen (002, Ergänzung 2026-10-19): compared against
    // the freshest state the index and the disk have, right before deciding
    // what to write. No conflict possible without a fresh element (the index
    // momentarily does not carry this `ktm_id`) — the write below proceeds
    // as it always has then.
    const fresh = this.freshElement(open.id ?? '');
    if (fresh) {
      const raw = await this.app.vault.read(file);
      const info = getFrontMatterInfo(raw);
      const freshBody = info.exists ? raw.slice(info.contentStart) : raw;
      const conflicts = open.detail.rebase(fresh, freshBody);
      if (conflicts.length > 0) {
        new Notice(
          `${conflicts.join(', ')}: von außen geändert. Erneutes Schließen speichert die Eingabe der Karte.`,
          NOTICE_DURATION,
        );
        return false;
      }
    }

    const changes = open.detail.changes();
    const element = this.elementByPath.get(open.path);
    if (!changes) {
      this.detail = undefined;
      open.resize.disconnect();
      this.removeChild(open.detail);
      open.coverEl.remove();
      open.cardEl.remove();
      this.catchUpReconcile();
      return true;
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
        return false;
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
            await moveElement(this.app, plan.move.from, plan.move.to, plan.move.parent, false);
            // A folder move carries its `_`-note along under its old file name;
            // a title change needs a second, separate rename of just that note
            // (adapter building block: "in two renameFile steps").
            if (element.form === 'nested') {
              const interim = `${plan.move.to}/${baseName(element.paths.note)}`;
              if (interim !== plan.notePath) {
                await moveElement(this.app, interim, plan.notePath, plan.move.to, false);
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
        // onto the (unchanged) parent of the open element, or loses its
        // parent entirely without one (F113: `parent`/`parent_link` go
        // through the same planFiling/writeFrontmatter path as the cross at
        // a parent row; main.ts#placeElement moves the folder once the
        // write lands back through metadataCache.on('changed')).
        if (changes.detachedChildren && element) {
          const grandparent = element.parents[0];
          const parentLabel = grandparent ? parentFolderLabelFor(grandparent, this.projectSettings(element.project).levels) : '';
          for (const childPath of changes.detachedChildren) {
            const child = this.elementByPath.get(childPath);
            if (!child) continue;
            const plan = this.resolveRefile(child, { parentLabel });
            if (Object.keys(plan.frontmatter).length > 0) {
              await writeFrontmatter(this.app, plan.notePath, plan.frontmatter);
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
      // Ablageregel 1 (011, Ergänzung 2026-09-25): the status write above,
      // like any other write, already reaches main.ts#placeElement through
      // the changed `status` field, so nothing further is filed here.
      return true;
    }
    // S46/K1: the write failed partway; the card stays open with its
    // unsaved draft, the board underneath was already redrawn by persist().
    this.reattachDetail(open);
    return false;
  }

  // The draft-closing half of closeDetail: an empty title discards silently
  // (S11/K3, unrelated to write errors), a real write failure (F068)
  // leaves the draft open with a notice instead of tearing it down, and a
  // successful create proceeds exactly as before (F053 stacking).
  private async closeDraft(open: OpenDetail): Promise<boolean> {
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
        this.catchUpReconcile();
        return true;
      }
      // K4: an empty title creates nothing; the card beneath becomes
      // operable again without a render (DESIGN.md Gestapelter Entwurf).
      base.cardEl.removeAttribute('data-stacked');
      this.detail = base;
      return true;
    }

    if (!result.ok) {
      this.failureNotice('Anlegen', result.path, result.message);
      await this.render();
      this.reattachDetail(open, base);
      return false;
    }
    const createdPath = result.path;

    if (!base) {
      this.removeChild(open.detail);
      open.cardEl.remove();
      open.coverEl.remove();
      await this.render();
      this.noticeIfFilteredOut(createdPath);
      return true;
    }

    // K1-K3: created. On a level above the source it pulls under the
    // new element (planRefile/moveElement); then pop the stack, render()
    // and reopen the card beneath fresh at the new path — both overlays
    // are torn down explicitly below before that render(), render() itself
    // no longer discards anything (002, Ergänzung 2026-10-18).
    // moveElement itself under reconciling=true, otherwise the
    // rename event schedules an unguided reconcile render (250ms debounce)
    // that fires after the reopen below and tears it down again.
    this.reconciling = true;
    let sourcePath: string;
    try {
      sourcePath = open.stackedFrom
        ? await this.applyStackedRefile(open.stackedFrom, createdPath, result.id, result.title)
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
    return true;
  }

  // 001, Ergänzung 2026-10-18, "Neue Aufgabe außerhalb des Filters" (K19):
  // called after render() has read the freshly created note back, so
  // `this.elementByPath` already carries it with its real `parents`.
  private noticeIfFilteredOut(path: string): void {
    // Wie renderToday: prüft ohne die Status-Sektion (001, Ergänzung
    // 2026-10-25, S51 "Status auf dem Board").
    const selection: FilterSelection = { ...this.filterSelection, statuses: new Set() };
    if (selection.ids.size === 0 && selection.tags.size === 0) return;
    const created = this.elementByPath.get(path);
    if (!created) return;
    const bottomType = bottomLevel(this.currentLevels(this.currentProject()))?.key ?? created.type;
    if (!isVisibleUnderSelection(created, selection, bottomType)) {
      new Notice('Angelegt, durch den Filter ausgeblendet', NOTICE_DURATION);
    }
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
  ): Promise<
    | { path: string; ok: true; id: string; title: string }
    | { path: string; ok: false; message: string }
    | undefined
  > {
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

    // parent/parent_link go into the note in the same step as the rest of
    // the Pflichtfelder (011, "created und parent/parent_link in einem
    // Schritt"): a wikilink relative to the not-yet-created note, with the
    // parent's title as alias (011, Ergänzung 2026-09-25, "parent_link" ist
    // Obsidians eigene Alias-Schreibweise).
    let parentLink: string | undefined;
    if (placement.parent && placement.parentNote) {
      const parentTitle = this.elementByPath.get(placement.parentNote)?.title;
      if (parentTitle !== undefined) {
        parentLink = parentLinkTo(this.app, placement.parentNote, placement.path, parentTitle);
      }
    }
    const id = newId(this.knownIds);
    const content = noteContent({
      id,
      type: target.type,
      title: target.title,
      status: target.status,
      project: placement.project || INTERNAL_PROJECT,
      created: this.today,
      parent: placement.parent,
      parentLink,
    });

    this.reconciling = true;
    try {
      await createNote(this.app, placement.path, content);
      const changes = detail.changes();
      const frontmatter: Record<string, string | null> = { ...changes?.frontmatter };
      // The changed-Hook never sees a brand-new note (it has no `before`), so
      // a draft opened directly in an active (or done) column stamps its own
      // `started` here, in the same write as the rest of the draft's fields
      // (008, Ergänzung 2026-10-25, K5). A `started` the draft's own Gestartet
      // field already set (changes().frontmatter) wins; the stamp never
      // overwrites it.
      if (frontmatter.started === undefined) {
        const targetColumn = this.columns.find((c) => c.status === target.status);
        const started = startedAfterStatusChange(targetColumn?.role ?? 'open', undefined, undefined, this.today);
        if (started) frontmatter.started = started;
      }
      if (Object.keys(frontmatter).length > 0) {
        await writeFrontmatter(this.app, placement.path, frontmatter);
      }
      if (changes?.body !== undefined) {
        await writeBody(this.app, placement.path, changes.body);
      }
      return { path: placement.path, ok: true, id, title: target.title };
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
      childrenOf: (element) => this.childrenOf(element),
      rules: {
        renameOnTitleChange: this.plugin.settings.renameOnTitleChange ?? false,
      },
      linkTo: (targetNote, sourceNote, title) => parentLinkTo(this.app, targetNote, sourceNote, title),
    };
  }

  // Places the draft according to its chosen form (008 S21-S23, F055,
  // core/refile.ts#planDraftPlacement).
  private draftPlacement(target: DraftTarget): DraftPlacement | undefined {
    return planDraftPlacement(target, this.refileEnv(), this.today);
  }

  // Turns the filing edits (title, project, level, the parentLabel driven
  // via the link list, the folder field) into a plan
  // (core/refile.ts#planFiling, F034/F051/F054/F072).
  private resolveRefile(element: BoardElement, refile: RefileRequest): RefilePlan {
    return planFiling(element, refile, this.refileEnv());
  }

  // A level pick at or above the parent's height (011, Ergänzung
  // 2026-09-25, "Ebene wechseln", CardDetail#pickLevel): writes `type` and
  // `parent`/`parent_link` right away, the move that follows is
  // main.ts#placeElement's job once the write lands back through
  // metadataCache.on('changed'). Wrapped under {@link runReconciling} so
  // that move never races the open card's own render (wissen #584).
  private async changeLevel(element: BoardElement, type: ElementType, parentId: string | null): Promise<boolean> {
    const frontmatter: FrontmatterChange = { type };
    if (parentId === null) {
      frontmatter.parent = null;
      frontmatter.parent_link = null;
    } else {
      frontmatter.parent = parentId;
      const ancestor = [...this.elementByPath.values()].find((e) => e.id === parentId);
      const link = ancestor ? parentLinkTo(this.app, ancestor.paths.note, element.paths.note, ancestor.title) : undefined;
      if (link) frontmatter.parent_link = yamlScalar(link);
    }
    try {
      await this.runReconciling(() => writeFrontmatter(this.app, element.paths.note, frontmatter));
      return true;
    } catch (err) {
      this.failureNotice('Ebene ändern', element.paths.note, errorMessage(err));
      return false;
    }
  }

  // "Ablage automatisch" (011, Ergänzung 2026-09-25): writes the literal
  // string so a Karte's Zustand is always visible in the frontmatter (K24),
  // never just a cleared key.
  private async setPlacement(element: BoardElement, value: 'auto' | 'manual'): Promise<boolean> {
    try {
      await this.runReconciling(() =>
        writeFrontmatter(this.app, element.paths.note, { ktm_placement: value }),
      );
      return true;
    } catch (err) {
      this.failureNotice('Ablage automatisch', element.paths.note, errorMessage(err));
      return false;
    }
  }

  // Lets an outside caller (main.ts#placeElement) run a move under this
  // board's own reconciling guard (wissen #584): reentrant, so a move
  // triggered by a write this view itself already wrapped in reconciling
  // (closeDetail, changeLevel, setPlacement) does not toggle the flag off
  // early. Only the outermost call flips it back and catches up a reconcile
  // that was missed while it ran.
  async runReconciling<T>(fn: () => Promise<T>): Promise<T> {
    const already = this.reconciling;
    if (!already) this.reconciling = true;
    try {
      return await fn();
    } finally {
      if (!already) {
        this.reconciling = false;
        this.catchUpReconcile();
      }
    }
  }

  private siblingNames(folder: string): string[] {
    const abstract = this.app.vault.getAbstractFileByPath(folder);
    return abstract instanceof TFolder ? abstract.children.map((c) => c.name) : [];
  }

  // Tears the overlay down without saving; only onClose calls this now
  // (002, Ergänzung 2026-10-18 "Karte bleibt offen" — a redraw no longer
  // pulls the board out from under an open detail, render() carries it
  // through via reattachDetail instead). Also tears down a stacked draft
  // along with its base (F053).
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

  // Die Projekte der aktuellen Filterauswahl, geordnet wie das Ansicht-Menü
  // (002 S56, "Interner Entwurf in einer gespeicherten Ansicht"): Lieferant
  // für linkCandidates' preferredProjects.
  private preferredProjectsFromFilter(): string[] {
    const projects = new Set<string>();
    for (const el of this.elementByPath.values()) {
      if (this.filterSelection.ids.has(el.id) && el.project) projects.add(el.project);
    }
    return this.projectOrder().filter((p) => projects.has(p));
  }

  // The link-menu's element search (F052 S36/K4, F105 K7): elements of the
  // given level whose title contains the query, or all of them for an empty
  // query (F105: a level art searches even before anything is typed). Sort
  // order: first the elements whose own `parents` contain one of
  // `parentIds` — the card's currently set parents, so its own epic's other
  // features lead — then the searching card's own project, then by note
  // path (wissen #496 — the underlying vault order is not stable enough to
  // rely on, so this sorts explicitly; the path, not the title, because
  // DESIGN.md's own reference order for same-project matches follows the
  // fixtures' date-prefixed folders, not alphabetical titles).
  private searchElements(
    level: ElementType,
    source: BoardElement,
    query: string,
    parentIds: string[] = [],
  ): LinkSearchResult[] {
    const candidates = [...this.elementByPath.values()].filter(
      (el) => el.type === level && el.paths.note !== source.paths.note,
    );
    // Interner Entwurf in einer gespeicherten Ansicht (002 S56): die
    // Projekte des aktiven Filters stehen vor der übrigen Projektfolge, aber
    // nur dort, wo wie in "Alle Aufgaben" über alle Projekte gesucht wird.
    const preferredProjects = this.isAllScope() ? this.preferredProjectsFromFilter() : [];
    return linkCandidates(
      candidates,
      query,
      parentIds,
      source.project,
      this.filter(),
      this.projectOrder(),
      (el) => this.doneStatuses(el.project).has(el.status),
      preferredProjects,
    ).map((c) => ({
      id: c.element.id,
      path: c.element.paths.note,
      title: c.element.title,
      project: c.element.project,
      statusName: this.statusNameFor(c.element),
      chain: parentChain(c.element),
      group: c.group,
      closed: c.closed,
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

  // Opens the Result-Dialog for `target` on `element`'s task and, once
  // confirmed, carries out the plan from `planResult` (002/008, Ergänzung
  // 2026-10-19 "Result"): move (or just link, already there), refuse on a
  // name collision (K20), then write `notes` on the chosen element and
  // `results` on the task, dropping `fromKind`'s old entry when this came
  // from "Als Result markieren". `fromKind` is undefined for a brand-new
  // link via the Plus menu.
  private async assignResult(element: BoardElement, target: TFile, fromKind?: string): Promise<void> {
    const levels = this.projectSettings(element.project).levels;
    const ancestors: ResultCandidate[] = element.parents.map((p) => {
      const level = levels.find((l) => l.key === p.type);
      return {
        notePath: p.note,
        levelIcon: level?.icon ?? 'layers',
        levelName: level?.name ?? p.type,
        title: p.title,
      };
    });
    const chosen = await ResultDialog.ask(this.app, {
      fileName: target.name,
      ancestors,
      search: (query) => this.resultCandidates(element, query),
    });
    if (!chosen) return;

    const plan = planResult(target.path, chosen.notePath, (path) => !!this.app.vault.getAbstractFileByPath(path));
    if (plan.kind === 'no-target') return;
    if (plan.kind === 'occupied') {
      new Notice(`Name schon vergeben: ${plan.from} und ${plan.to}`, NOTICE_DURATION);
      return;
    }

    let finalFile = target;
    if (plan.kind === 'move') {
      try {
        for (const message of await moveDocument(this.app, plan.from, plan.to)) new Notice(message, NOTICE_DURATION);
      } catch (err) {
        this.failureNotice('Verschieben', plan.from, errorMessage(err));
        return;
      }
      const moved = this.app.vault.getAbstractFileByPath(plan.to);
      if (!(moved instanceof TFile)) {
        this.failureNotice('Verschieben', plan.from, 'Datei nach dem Verschieben nicht gefunden');
        return;
      }
      finalFile = moved;
    }

    try {
      if (fromKind) await this.removeResultLink(element.paths.note, fromKind, finalFile);
      await this.appendResultLink(element.paths.note, RESULT_LINK_KIND.key, finalFile);
      await this.appendResultLink(chosen.notePath, 'notes', finalFile);
    } catch (err) {
      this.failureNotice('Zuordnen', element.paths.note, errorMessage(err));
      return;
    }

    if (this.detail && this.detail.path === element.paths.note) {
      this.detail.detail.applyResult(finalFile, fromKind);
    }
  }

  // Elements of a fitting level (above the task's own, by rank within each
  // element's own project — 002, Ergänzung 2026-10-19 "Result") across every
  // project, filtered by title; empty before anything is typed (S90: the
  // Result-Dialog shows no list before a query). Read from `elementByPath`,
  // not `freshElements()` — this only ever runs while the dialog is open,
  // before anything has moved yet.
  private resultCandidates(element: BoardElement, query: string): ResultCandidate[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const ownRank = this.projectSettings(element.project).levels.findIndex((l) => l.key === element.type);
    const result: ResultCandidate[] = [];
    for (const candidate of this.elementByPath.values()) {
      if (candidate.invalid || candidate.id === element.id) continue;
      if (!candidate.title.toLowerCase().includes(needle)) continue;
      const levels = this.projectSettings(candidate.project).levels;
      const rank = levels.findIndex((l) => l.key === candidate.type);
      if (rank === -1 || (ownRank !== -1 && rank >= ownRank)) continue;
      const level = levels[rank];
      result.push({
        notePath: candidate.paths.note,
        levelIcon: level.icon,
        levelName: level.name,
        title: candidate.title,
        projectName: candidate.project !== element.project ? this.projectDisplayName(candidate.project) : undefined,
      });
    }
    return result.sort((a, b) => a.title.localeCompare(b.title, 'de')).slice(0, 8);
  }

  // The "<Ebene> <Titel>" of whichever element currently carries `target` in
  // its own `notes` (002 S84), read from the shared index right now (wissen
  // #857) rather than `elementByPath`, since this runs straight after a move
  // that index has not necessarily reconciled into a render yet.
  private resultTargetLabel(target: string, sourcePath: string): string | undefined {
    const file = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
    if (!file) return undefined;
    for (const el of this.freshElements()) {
      if (el.invalid) continue;
      const carriesIt = el.links.some(
        (l) => l.kind === 'notes' && this.app.metadataCache.getFirstLinkpathDest(l.target, el.paths.note)?.path === file.path,
      );
      if (!carriesIt) continue;
      const level = this.projectSettings(el.project).levels.find((l) => l.key === el.type);
      return `${level?.name ?? el.type} ${el.title}`;
    }
    return undefined;
  }

  private wikilinkOf(link: { target: string; alias?: string }): string {
    return link.alias ? `[[${link.target}|${link.alias}]]` : `[[${link.target}]]`;
  }

  // Appends `file` to `key`'s free-link list on `notePath`'s own note, unless
  // it is already there; read from the fresh cache, not `elementByPath`
  // (wissen #857). Used for `notes` on a Result's new target and `results`
  // on the task itself.
  private async appendResultLink(notePath: string, key: string, file: TFile): Promise<void> {
    const existing = this.freshFreeLinks(notePath, key);
    const already = existing.some(
      (l) => this.app.metadataCache.getFirstLinkpathDest(l.target, notePath)?.path === file.path,
    );
    if (already) return;
    const target = this.app.metadataCache.fileToLinktext(file, notePath, true);
    const next = [...existing, { target }];
    await writeFrontmatter(this.app, notePath, { [key]: flowList(next.map((l) => this.wikilinkOf(l)), true) });
  }

  // Drops `file`'s entry from `key`'s free-link list on `notePath`'s own note
  // ("Als Result markieren", 002, Ergänzung 2026-10-19), matched by resolved
  // file rather than raw text so an alias or a path-qualified target (002
  // S49) is still found.
  private async removeResultLink(notePath: string, key: string, file: TFile): Promise<void> {
    const existing = this.freshFreeLinks(notePath, key);
    const next = existing.filter(
      (l) => this.app.metadataCache.getFirstLinkpathDest(l.target, notePath)?.path !== file.path,
    );
    if (next.length === existing.length) return;
    await writeFrontmatter(this.app, notePath, {
      [key]: next.length ? flowList(next.map((l) => this.wikilinkOf(l)), true) : null,
    });
  }

  // `key`'s own free-link entries read straight from the fresh MetadataCache
  // frontmatter of `notePath` (wissen #857); `linksOf` always parses
  // `results` as well as whatever kind is asked for (core/read.ts), so the
  // result is filtered back down to `key` alone.
  private freshFreeLinks(notePath: string, key: string): { target: string; alias?: string }[] {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    const frontmatter = file instanceof TFile ? (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) : {};
    return linksOf(frontmatter, [{ key, label: '', icon: '' }]).filter((l) => l.kind === key);
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

function isMatrixQuadrant(value: string | undefined): value is MatrixQuadrant {
  return value === 'now' || value === 'plan' || value === 'quick' || value === 'later';
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
// the name already ends in one. Exported for the Buttonstil-Vorschau (006,
// Ergänzung 2026-10-25), die dieselbe Beschriftung braucht.
export function levelPlural(name: string): string {
  return name.endsWith('s') ? name : `${name}s`;
}

const ROADMAP_GRID_LABELS: Record<RoadmapGrid, string> = { week: 'KW', month: 'Monat', quarter: 'Quartal', year: 'Jahr' };

function roadmapGridLabel(grid: RoadmapGrid): string {
  return ROADMAP_GRID_LABELS[grid];
}

function roadmapDatePart(dateISO: string): string {
  const [y, m, d] = dateISO.split('-');
  return `${d}.${m}.${y}`;
}

function roadmapRangeLabel(state: RoadmapState): string {
  return `${roadmapDatePart(state.start)} – ${roadmapDatePart(state.end)}`;
}

interface RoadmapHeadCell {
  label: string;
  days: number;
  current: boolean;
}

function roadmapMonthsIn(start: string, end: string): { year: number; month: number }[] {
  const months: { year: number; month: number }[] = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    months.push({ year: y, month: m });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

function roadmapClampDays(unitStart: string, unitEnd: string, rangeStart: string, rangeEnd: string): number {
  const s = unitStart > rangeStart ? unitStart : rangeStart;
  const e = unitEnd < rangeEnd ? unitEnd : rangeEnd;
  const diff = dayDiff(e, s);
  return diff === undefined || diff < 0 ? 0 : diff + 1;
}

/**
 * Zweizeiliger Kopf der Roadmap (012 S27, "Raster"): KW zeigt unten Wochen
 * und oben Monate, Monat/Quartal unten ihre Einheit und oben Jahre, Jahr nur
 * unten Jahre. Reine Darstellungslogik über dates.ts, kein eigener Zustand.
 */
function roadmapHeaderCells(state: RoadmapState, today: string): { top: RoadmapHeadCell[]; bottom: RoadmapHeadCell[] } {
  const { start, end, grid } = state;
  const months = roadmapMonthsIn(start, end);
  const years = [...new Set(months.map((m) => m.year))];
  const [cy, cm] = today.split('-').map(Number);

  const monthCell = (m: { year: number; month: number }): RoadmapHeadCell => {
    const range = monthRange(m, m);
    return {
      label: MONTH_NAMES[m.month - 1],
      days: roadmapClampDays(range.start, range.end, start, end),
      current: cy === m.year && cm === m.month,
    };
  };
  const yearCell = (y: number): RoadmapHeadCell => ({
    label: String(y),
    days: roadmapClampDays(`${y}-01-01`, `${y}-12-31`, start, end),
    current: cy === y,
  });
  const quarterCell = (y: number, q: number): RoadmapHeadCell => {
    const first = (q - 1) * 3 + 1;
    const range = monthRange({ year: y, month: first }, { year: y, month: first + 2 });
    return {
      label: `Q${q}`,
      days: roadmapClampDays(range.start, range.end, start, end),
      current: cy === y && Math.ceil(cm / 3) === q,
    };
  };

  if (grid === 'week') {
    const bottom: RoadmapHeadCell[] = [];
    for (let w = mondayOf(start); w <= end; w = addDays(w, 7)) {
      const weekEnd = addDays(w, 6);
      const week = isoWeek(Date.parse(`${w}T00:00:00Z`));
      bottom.push({ label: `KW ${week}`, days: roadmapClampDays(w, weekEnd, start, end), current: today >= w && today <= weekEnd });
    }
    const top = months.map((m) => monthCell(m)).filter((c) => c.days > 0);
    return { top, bottom: bottom.filter((c) => c.days > 0) };
  }
  if (grid === 'month') {
    return { top: years.map((y) => yearCell(y)).filter((c) => c.days > 0), bottom: months.map((m) => monthCell(m)).filter((c) => c.days > 0) };
  }
  if (grid === 'quarter') {
    const quarterKeys = [...new Set(months.map((m) => `${m.year}-${Math.ceil(m.month / 3)}`))];
    const bottom = quarterKeys
      .map((key) => {
        const [y, q] = key.split('-').map(Number);
        return quarterCell(y, q);
      })
      .filter((c) => c.days > 0);
    return { top: years.map((y) => yearCell(y)).filter((c) => c.days > 0), bottom };
  }
  return { top: [], bottom: years.map((y) => yearCell(y)).filter((c) => c.days > 0) };
}
