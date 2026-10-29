import { type CachedMetadata, getFrontMatterInfo, Modal, Notice, Plugin, type TAbstractFile, TFile, TFolder, type WorkspaceLeaf } from 'obsidian';
import {
  appendFreeLink,
  appendLlmLink,
  countLegacyCandidates,
  createNote,
  latestMigrationProtocol,
  legacyEntries,
  moveDocument,
  moveElement,
  obsidianFileSource,
  parentLinkTo,
  recentOwnMoves,
  removeLlmLink,
  removeMigrationProtocol,
  shrinkMigrationProtocol,
  syncGuide,
  unadoptedNotes,
  writeFrontmatter,
  writeMigrationProtocol,
} from './adapters/obsidian';
import { checkFindings } from './core/check';
import { adoptProposal, atomicNotePath, nestedPaths, noteContent, validateCreateValues } from './core/create';
import { todayISO } from './core/dates';
import { FORMAT_NOTE_PATH, GUIDE_NOTE_PATH, renderGuide } from './core/guide';
import type { FrontmatterChange } from './core/frontmatter';
import { yamlScalar } from './core/frontmatter';
import { newId } from './core/ids';
import {
  type MigrationFields,
  type MigrationItem,
  type MigrationPlan,
  migrationProtocol,
  planMigration,
  planUndo,
} from './core/migrate';
import type { BoardElement, ElementType, FileEntry } from './core/model';
import { startedAfterStatusChange, type MoveDirection } from './core/move';
import {
  computedLocation,
  currentLocation,
  handMoved,
  type HandMoveCandidate,
  isCurrentlyDone,
  isInDoneMirror,
  placementFindings,
  type PlacementProject,
} from './core/placement';
import { readElements } from './core/read';
import { planResult, unassignedResults } from './core/result';
import type { SavedView } from './core/savedViews';
import {
  bottomLevel,
  DEFAULT_COLUMNS,
  normalizeBoardScale,
  resolveColumns,
  resolveProjectSettings,
  settingsFor,
  statusClosure,
  stepBoardScale,
  withoutHiddenProjects,
  type GeneralSettings,
  type ProjectSettings,
} from './core/settings';
import { DEFAULT_TODAY_SORT } from './core/today';
import { ElementIndex } from './core/vault-index';

const GUIDE_DEBOUNCE = 300;
const NOTICE_DURATION = 15000;
const HAND_MOVE_DEBOUNCE = 300;
// Rückfall für markOwnPlacement (F127 S37/S38): räumt eine gemerkte eigene
// Platzierung auf, falls das erwartete `changed`-Ereignis aus irgendeinem
// Grund nie ankommt, statt sie für die Lebensdauer des Plugins stehenzulassen.
const OWN_PLACEMENT_TIMEOUT = 5000;
// Hilfsnotizen, die das Plugin selbst schreibt (011, Ergänzung 2026-10-18;
// 005 S7, 008 Ergänzung 2026-10-18 "Abgleich während des Starts"): ihr eigenes
// changed/delete-Ereignis erreicht das Board nicht — weder syncGuide's Schreiben
// der Anleitung noch ihr Löschen der alten Formatnotiz soll ein zweites
// Neuzeichnen auslösen, neben dem, das die eigentliche Einstellungsänderung
// schon anstößt (F123 K7, Wissen #640/#813).
const OWN_HELPER_NOTES: ReadonlySet<string> = new Set([GUIDE_NOTE_PATH, FORMAT_NOTE_PATH]);
import { BoardView, type KtmWindow, VIEW_TYPE_BOARD } from './ui/BoardView';
import { AdoptDialog } from './ui/AdoptDialog';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { KtmSettingTab } from './ui/SettingsTab';

const DEFAULT_SETTINGS: GeneralSettings = {
  columns: DEFAULT_COLUMNS,
  lastView: 'all',
  lastLevel: 'task',
  notifyPlanned: true,
  notifyDue: true,
  todaySortOrder: DEFAULT_TODAY_SORT,
};

const SETTINGS_UNREADABLE_NOTICE =
  'Einstellungen nicht lesbar, Voreinstellungen gelten. Die Datei bleibt unverändert.';
// 006, Ergänzung 2026-10-19 "Eine unlesbare Einstellungsdatei wird nie
// überschrieben": Notice für saveData's Schreibsperre, solange data.json seit
// dem Laden nie lesbar war (S62).
const SETTINGS_CHANGE_BLOCKED_NOTICE = 'Einstellungen nicht lesbar, Änderung nicht gespeichert';
// Notice für eine Datei, die erst im Betrieb unlesbar wurde und es länger als
// UNREADABLE_NOTIFY_DELAY bleibt (S66/S67); ein kurzer Ausfall unter dieser
// Schwelle bleibt stumm.
const SETTINGS_STILL_UNREADABLE_NOTICE =
  'Einstellungen nicht lesbar, zuletzt gelesene Einstellungen gelten. Die Datei bleibt unverändert.';
const UNREADABLE_NOTIFY_DELAY = 10000;

export default class KanbanTaskManagerPlugin extends Plugin {
  settings: GeneralSettings = DEFAULT_SETTINGS;
  // Raw object last read from data.json, without DEFAULT_SETTINGS merged in
  // (F122, 006 Ergänzung 2026-10-19 "Einstellungen fallen nie still zurück",
  // Wissen #963): saveViewState/toggleCollapsedColumn/toggleCollapsedToday
  // write through saveStoredSettings() so they persist only this plus their
  // own patch, never the full DEFAULT_SETTINGS-merged this.settings. Kept in
  // step by reloadSettings on every successful read; left untouched while
  // settingsLocked (last known raw stays last known raw).
  private storedSettings: Partial<GeneralSettings> = {};
  private guideTimer?: number;
  // One `ktm_id`-keyed index for board, settings page and format note (011
  // S61): built once after the metadata cache has resolved, then kept
  // current file by file through the events registered below, never by a
  // full vault rescan (K30).
  index!: ElementIndex;
  indexReady!: Promise<void>;
  // Collected `vault.on('rename')` events for the "von Hand verschoben"
  // detection (011, Ergänzung 2026-09-25), flushed as one batch after
  // HAND_MOVE_DEBOUNCE so a folder move (one event per file, konventionen.md)
  // is judged as a whole instead of file by file.
  private handMoveBatch: HandMoveCandidate[] = [];
  private handMoveTimer?: number;
  // Set whenever data.json is currently unreadable (006, Ergänzung
  // 2026-10-18 "Einstellungen fallen nie still zurück"): blocks the Done/
  // placement guard and saveViewState's own write, lifted again the moment
  // reloadSettings reads a plain object. `hasReadSettingsObject` tells a
  // first-ever unreadable file (DEFAULT_SETTINGS plus this lock) apart from
  // one that turns unreadable later (this.settings kept exactly as they are).
  private settingsLocked = false;
  private hasReadSettingsObject = false;
  // Zeitgeber für den Hinweis "zuletzt gelesene Einstellungen gelten" (S66/S67):
  // startet in lockSettings beim Übergang lesbar -> unlesbar, gelöscht sobald
  // reloadSettings wieder erfolgreich liest. unreadableNotified hält fest, dass
  // diese Phase der Unlesbarkeit ihren einmaligen Hinweis schon bekommen hat.
  private unreadableTimer?: number;
  private unreadableNotified = false;
  // Instanz statt der View behalten (006, Ergänzung 2026-10-19): saveData und
  // adoptDefaults zeichnen die offene Einstellungsseite neu, wenn eine
  // Änderung an der Sperre scheitert oder die Sperre aufgehoben wird.
  private settingTab!: KtmSettingTab;
  // Pfade, deren nächster status-Wechsel samt order vom Board selbst stammt
  // (F127, Umsetzung "markOwnPlacement"): schützt einen frisch gezogenen
  // Spaltenwechsel in eine manuelle Spalte davor, dass der Bereinigungs-Hook
  // (onNoteChanged) das neue order gleich wieder löscht, nur weil es
  // zufällig mit dem alten übereinstimmt.
  private ownPlacements = new Set<string>();
  private ownPlacementTimers = new Map<string, number>();
  // Pfade, deren nächster status-Wechsel vom Umschreiben einer entfernten
  // Spalte in den Einstellungen stammt (F190, Wissen #1231): das ist Pflege
  // der Spaltenliste, kein Arbeitsbeginn (008 S79 zählt diesen Weg nicht auf),
  // darum darf stampStartedAfterStatusChange hier kein `started` stempeln.
  // Gesetzt von markSettingsReassignment, verbraucht von
  // stampStartedAfterStatusChange; die Frist räumt auf, falls das erwartete
  // changed-Ereignis ausbleibt.
  private settingsReassignments = new Set<string>();
  private settingsReassignmentTimers = new Map<string, number>();
  // Exklusiver Abschnitt für Umzug und Abgleich (F123, 011/829): eine reine
  // Promise-Kette, kein Mutex mit explizitem Entsperren — placeElement und
  // BoardView#render hängen ihren jeweiligen Schritt hier an, sodass jeder
  // sein Ziel erst berechnet, wenn er an der Reihe ist, gegen den dann
  // aktuellen Index. Nichts, was ein Schritt selbst abwartet, darf wieder
  // runExclusive aufrufen und auf dessen Ergebnis warten, sonst entstünde ein
  // Deadlock; ein Schritt, der *beiläufig* (fire-and-forget, über ein
  // metadataCache-Ereignis) einen weiteren runExclusive-Aufruf auslöst, reiht
  // diesen nur hinten an und blockiert nicht.
  private exclusiveChain: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    // Index und die drei Vault-Ereignisse zuerst, vor jedem await (F123, 011
    // Ergänzung 2026-10-18): kommt eine Änderung kurz nach plugin:reload an,
    // während reloadSettings() noch auf data.json wartet, geht sie sonst
    // verloren, weil noch niemand zuhört. onLayoutReady bleibt der Weg für
    // alles, was das vollständige Layout braucht (file-menu, der erste
    // Guide-Schreibvorgang).
    this.index = new ElementIndex(obsidianFileSource(this.app));
    this.registerEvent(
      this.app.metadataCache.on('changed', (file, _data, cache) => {
        void this.onNoteChanged(file, cache);
        if (cache.frontmatter?.ktm_project !== undefined) this.refreshGuide();
      }),
    );
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onVaultRename(file, oldPath)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.onVaultDelete(file)));

    await this.reloadSettings();
    if (this.settingsLocked) new Notice(SETTINGS_UNREADABLE_NOTICE, NOTICE_DURATION);

    this.indexReady = this.buildIndex()
      .then((catchUp) => this.catchUpAfterLoad(catchUp))
      .then(() => this.assignPendingNewIds());

    this.registerView(VIEW_TYPE_BOARD, (leaf) => new BoardView(leaf, this));
    this.settingTab = new KtmSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.app.workspace.onLayoutReady(() => {
      this.refreshGuide();
      this.registerEvent(
        this.app.workspace.on('file-menu', (menu, file) => {
          if (!(file instanceof TFile) || !this.isAdoptable(file)) return;
          menu.addItem((item) =>
            item
              .setTitle('Als Aufgabe übernehmen')
              .setIcon('list-plus')
              .onClick(() => void this.adoptNote(file)),
          );
        }),
      );
    });

    if (this.settings.ribbon ?? true) {
      this.addRibbonIcon('kanban-square', 'Board öffnen', () => {
        void this.openBoard();
      });
    }

    this.addCommand({
      id: 'open-board',
      name: 'Board öffnen',
      callback: () => {
        void this.openBoard();
      },
    });

    this.addCommand({
      id: 'new-task',
      name: 'Neue Aufgabe',
      checkCallback: (checking) => {
        const board = this.activeBoard();
        if (!board) return false;
        if (!checking) board.startCreate();
        return true;
      },
    });

    // Drei Befehle der Board-Größe (001, Ergänzung 2026-10-24): callback statt
    // checkCallback, sie wirken auch ohne geöffnetes Board (der Wert steht in
    // den Einstellungen und zeigt sich beim nächsten Öffnen).
    this.addCommand({
      id: 'board-zoom-in',
      name: 'Board vergrößern',
      callback: () => {
        void this.saveBoardScale('in');
      },
    });

    this.addCommand({
      id: 'board-zoom-out',
      name: 'Board verkleinern',
      callback: () => {
        void this.saveBoardScale('out');
      },
    });

    this.addCommand({
      id: 'board-zoom-reset',
      name: 'Board-Größe zurücksetzen',
      callback: () => {
        void this.saveBoardScale('reset');
      },
    });

    this.addCommand({
      id: 'move-card-right',
      name: 'Karte nach rechts verschieben',
      checkCallback: (checking) => this.moveFocusedCard('right', checking),
    });

    this.addCommand({
      id: 'move-card-left',
      name: 'Karte nach links verschieben',
      checkCallback: (checking) => this.moveFocusedCard('left', checking),
    });

    this.addCommand({
      id: 'adopt-as-task',
      name: 'Als Aufgabe übernehmen',
      // callback statt checkCallback (011 K11): so steht der Befehl in
      // jedem Vault unter den Befehlen, auch ohne passenden Kontext. Der
      // Kontextmenü-Eintrag (file-menu oben) bleibt weiterhin auf
      // übernehmbare Dateien gefiltert.
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!this.isAdoptable(file)) {
          new Notice('Als Aufgabe übernehmen: keine aktive Notiz, die übernommen werden kann.', NOTICE_DURATION);
          return;
        }
        void this.adoptNote(file);
      },
    });

    this.addCommand({
      id: 'migrate',
      name: 'Bestand übernehmen',
      callback: () => {
        void this.runMigrateCommand();
      },
    });

    this.addCommand({
      id: 'setup-llm-link',
      name: 'LLM-Verweis einrichten',
      callback: () => {
        void this.runSetupLlmLinkCommand();
      },
    });

    this.addCommand({
      id: 'remove-llm-link',
      name: 'LLM-Verweis entfernen',
      callback: () => {
        void this.runRemoveLlmLinkCommand();
      },
    });

    this.addCommand({
      id: 'migrate-undo',
      name: 'Übernahme rückgängig machen',
      callback: () => {
        void this.runUndoMigrationCommand();
      },
    });

    // Plugin.registerCliHandler (API 1.12.2): `ktm:new-id n=<Anzahl>` gives an
    // LLM fresh `ktm_id`s without going through the app at all (011 S62).
    this.registerCliHandler(
      'ktm:new-id',
      'Gibt frische ktm_id-Kennungen aus',
      { n: { value: '<Anzahl>', description: 'Anzahl der Kennungen, 1 bis 100 (Standard 1)' } },
      async (params) => {
        await this.indexReady;
        const raw = params.n;
        const n = raw === undefined ? 1 : Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
          return `ktm:new-id: ungültige Anzahl „${String(raw)}“, erwartet eine ganze Zahl von 1 bis 100.`;
        }
        const known = this.knownIds();
        const ids: string[] = [];
        for (let i = 0; i < n; i++) ids.push(newId(new Set([...known, ...ids])));
        return ids.join('\n');
      },
    );

    // `ktm:migrate` (011 S67/S68, Ergänzung 2026-09-25): without `apply` or
    // `undo` a dry-run preview, with `apply` (arrives as the literal string
    // 'true', wissen #75) the same write the command performs, per file, with
    // `undo` the same rollback "Übernahme rückgängig machen" performs. `apply`
    // together with `undo` is rejected outright (K1's "ktm:error" branch). The
    // last line of a preview or apply is always the fixed `ktm:migrate <n>
    // offene Elemente` (K11), counted fresh from the MetadataCache.
    this.registerCliHandler(
      'ktm:migrate',
      'Vorschau, Anwendung oder Rückgängigmachen der Bestandsübernahme (011)',
      {
        apply: { value: undefined, description: 'Übernahme tatsächlich ausführen' },
        undo: { value: undefined, description: 'Letzte Übernahme rückgängig machen' },
      },
      async (params) => {
        await this.indexReady;
        if (params.apply === 'true' && params.undo === 'true') {
          return 'ktm:error ktm:migrate: apply und undo schließen sich aus.';
        }
        if (params.undo === 'true') return this.runUndoMigrationCli();

        const { plan, entries } = await this.buildMigration();
        const lines: string[] = [];
        if (params.apply === 'true') {
          const { lines: writeLines } = await this.writeMigrationItems(plan.items, entries);
          lines.push(...writeLines);
          this.rerenderBoard();
        } else {
          lines.push(`${plan.items.length} Elemente, ${plan.parentCount} Parents als Kennung.`);
          for (const item of plan.items) lines.push(`${item.path}: ${Object.keys(item.fields).join(', ')}`);
          for (const path of plan.skipped) lines.push(`Nicht übernommen: ${path}`);
        }
        lines.push(`ktm:migrate ${this.legacyCount()} offene Elemente`);
        return lines.join('\n');
      },
    );

    this.registerCliHandler('ktm:guide', 'Gibt die Anleitung aus', {}, async () => {
      await this.indexReady;
      return this.currentGuide();
    });

    // "Der Ort folgt dem Parent" (011, Ergänzung 2026-09-25): ktm:where reads
    // the current path back out of the index alone, no vault access beyond that.
    // Obsidian.com always exits 0, even when a handler throws (wissen #831); a
    // failure is signalled as the first output line `ktm:error <Grund>`
    // instead (Betreiberentscheid 2026-09-25, wissen #838).
    this.registerCliHandler(
      'ktm:where',
      'Gibt den aktuellen Pfad der Elementnotiz aus',
      { id: { value: '<ktm_id>', description: 'Kennung des Elements' } },
      async (params) => {
        await this.indexReady;
        const id = params.id;
        if (!id) return 'ktm:error ktm:where: id fehlt.';
        const entry = this.index.entries().find((e) => e.frontmatter.ktm_id === id);
        if (!entry) return `ktm:error ktm:where: unbekannte Kennung „${id}“.`;
        return entry.path;
      },
    );

    // ktm:set (011, Ergänzung 2026-09-25): validates everything before writing
    // anything, then lets placeElement do the actual move once the write
    // lands back through metadataCache.on('changed'). Same exitcode-0
    // limitation as ktm:where: a thrown validation error becomes the
    // `ktm:error <Grund>` first line instead of propagating.
    this.registerCliHandler(
      'ktm:set',
      'Ändert parent/project/type/status/placement eines Elements (011)',
      {
        id: { value: '<ktm_id>', description: 'Kennung des Elements' },
        parent: { value: '<ktm_id>', description: 'Kennung des neuen Parents, leer für „ohne Parent“' },
        project: { value: '<Kürzel>', description: 'Neues Projekt' },
        type: { value: '<Ebene>', description: 'Neue Ebene' },
        status: { value: '<Status>', description: 'Neuer Status' },
        placement: { value: 'auto|manual', description: 'Ablage automatisch oder manuell' },
      },
      async (params) => {
        await this.indexReady;
        try {
          return await this.runKtmSet(params);
        } catch (err) {
          return `ktm:error ${errorMessage(err)}`;
        }
      },
    );

    // ktm:check (011, Ergänzung 2026-09-25, "Bestandsprüfung"): every finding
    // core/check.ts#checkFindings knows, resolving a `parent_link` from the
    // child note's own point of view, exactly like Obsidian itself would.
    // Schreibt nichts (S76).
    this.registerCliHandler('ktm:check', 'Meldet Befunde über den Bestand (011)', {}, async () => {
      const lines = await this.checkLines();
      return lines.join('\n');
    });

    this.addCommand({
      id: 'check',
      name: 'Bestand prüfen',
      callback: () => {
        void this.runCheckCommand();
      },
    });

    // ktm:create (011, Ergänzung 2026-09-25, "Anlegen per CLI"): validates
    // every field before a single write happens, same exitcode-0 limitation as
    // ktm:set/ktm:where (wissen #831/#838).
    this.registerCliHandler(
      'ktm:create',
      'Legt ein neues Element an (011)',
      {
        title: { value: '<Titel>', description: 'Titel des Elements' },
        project: { value: '<Kürzel>', description: 'Projekt (Kürzel oder „intern“)' },
        type: { value: '<Ebene>', description: 'Ebene, Standard die unterste' },
        status: { value: '<Status>', description: 'Status, Standard die erste Spalte' },
        parent: { value: '<ktm_id>', description: 'Kennung des Parents' },
        due: { value: 'YYYY-MM-DD', description: 'Fälligkeitsdatum' },
        planned: { value: 'YYYY-MM-DD', description: 'Geplantes Datum' },
        priority: { value: '1-4', description: 'Priorität' },
      },
      async (params) => {
        await this.indexReady;
        try {
          return await this.runKtmCreate(params);
        } catch (err) {
          return `ktm:error ${errorMessage(err)}`;
        }
      },
    );

    // ktm:result (005, Ergänzung 2026-10-19 "Results für Claude"): validates
    // id, file and target before any write happens, same exitcode-0
    // limitation as ktm:set/ktm:create (wissen #838).
    this.registerCliHandler(
      'ktm:result',
      'Ordnet ein Dokument einer Task als Result zu (005)',
      {
        id: { value: '<ktm_id>', description: 'Kennung der Task' },
        file: { value: '<Pfad>', description: 'Vault-Pfad des Dokuments' },
        target: { value: '<ktm_id>', description: 'Kennung des Ziels, Standard der direkte Parent' },
      },
      async (params) => {
        await this.indexReady;
        try {
          return await this.runKtmResult(params);
        } catch (err) {
          return `ktm:error ${errorMessage(err)}`;
        }
      },
    );

    this.addCommand({
      id: 'move-to-computed',
      name: 'An berechneten Ort verschieben',
      callback: () => {
        void this.runMoveToComputedCommand();
      },
    });
  }

  // Plan der noch nicht übernommenen 0.0.1-Notizen (011 S67): `legacyEntries`
  // liest nur die Kandidaten (nicht den ganzen Vault), `knownIds()` seedet die
  // Kennungsvergabe, damit keine frisch vergebene Kennung mit einer schon
  // bestehenden kollidiert. Gibt die gelesenen `entries` mit zurück, weil ein
  // anschließendes Schreiben das Protokoll (migrationProtocol) noch gegen den
  // Stand *vor* der Übernahme aufbauen muss (011, Ergänzung 2026-09-25).
  private async buildMigration(): Promise<{ plan: MigrationPlan; entries: FileEntry[] }> {
    const roots = this.index.roots();
    const entries = await legacyEntries(this.app, roots);
    const { projects } = resolveProjectSettings(this.index.entries());
    const levelsFor = (project: string) => settingsFor(this.settings, projects.find((p) => p.key === project)).levels;
    const plan = planMigration(entries, roots, levelsFor, this.knownIds(), this.todayOverride());
    return { plan, entries };
  }

  // Schreibt die geplanten Items (Befehl und `ktm:migrate apply` teilen sich
  // das, 011 Ergänzung 2026-09-25): ein Fehler je Datei bricht die übrigen
  // nicht ab; das Übernahmeprotokoll wird nur aus den tatsächlich
  // geschriebenen Items gebaut und nur, wenn wenigstens eines gelang, unter
  // dem echten lokalen Datum abgelegt (K1).
  private async writeMigrationItems(
    items: MigrationItem[],
    entries: FileEntry[],
  ): Promise<{ lines: string[]; written: MigrationItem[] }> {
    const lines: string[] = [];
    const written: MigrationItem[] = [];
    for (const item of items) {
      try {
        await writeFrontmatter(this.app, item.path, migrationChange(item.fields));
        lines.push(`${item.path}: übernommen`);
        written.push(item);
      } catch (err) {
        lines.push(`${item.path}: Fehler (${errorMessage(err)})`);
      }
    }
    if (written.length > 0) {
      const protocol = migrationProtocol(written, entries);
      await writeMigrationProtocol(this.app, this.todayOverride(), protocol);
    }
    return { lines, written };
  }

  // "Bestand übernehmen" (011 S67): ohne Kandidaten ein Hinweis, sonst die
  // Zahlen und übersprungenen Pfade im ConfirmDialog; erst bei "Übernehmen"
  // wird geschrieben, ein Fehler je Datei bricht die übrigen nicht ab.
  private async runMigrateCommand(): Promise<void> {
    await this.indexReady;
    const { plan, entries } = await this.buildMigration();
    if (plan.items.length === 0) {
      new Notice('Nichts zu übernehmen.', NOTICE_DURATION);
      return;
    }
    const lines = [
      `${plan.items.length} Elemente werden übernommen.`,
      `${plan.parentCount} Parents werden als Kennung geschrieben.`,
    ];
    if (plan.skipped.length > 0) {
      lines.push(`Nicht übernommen:\n${plan.skipped.join('\n')}`);
    }
    const confirmed = await ConfirmDialog.ask(this.app, { title: 'Bestand übernehmen', lines });
    if (!confirmed) return;

    const { lines: writeLines } = await this.writeMigrationItems(plan.items, entries);
    for (const line of writeLines) {
      if (line.includes('Fehler')) new Notice(`Übernahme fehlgeschlagen: ${line}`, NOTICE_DURATION);
    }
    this.rerenderBoard();
  }

  // Liest genau die Pfade aus `paths` frisch aus dem MetadataCache (011,
  // Ergänzung 2026-09-25, "Übernahme rückgängig"): planUndo vergleicht jeden
  // Protokolleintrag gegen den *aktuellen* Frontmatter-Stand, nicht gegen den
  // (unter Umständen veralteten) Stand im Index.
  private async currentFrontmatterFor(paths: string[]): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    for (const path of paths) {
      const file = this.app.vault.getFileByPath(path);
      if (!file) continue;
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
      entries.push({ path, frontmatter, body: '' });
    }
    return entries;
  }

  // Führt "Übernahme rückgängig machen"/`ktm:migrate undo` tatsächlich aus
  // (011, Ergänzung 2026-09-25): liest das neueste Protokoll frisch (nicht das
  // aus einem vorherigen Aufruf), plant und schreibt, kürzt oder entfernt das
  // Protokoll danach. `ok: false` nur, wenn gar kein Protokoll existiert.
  private async performUndo(): Promise<
    { ok: true; conflictLines: string[]; count: number } | { ok: false; reason: string }
  > {
    const latest = await latestMigrationProtocol(this.app);
    if (!latest) return { ok: false, reason: 'Kein Übernahme-Protokoll gefunden.' };
    const entries = await this.currentFrontmatterFor(latest.protocol.items.map((i) => i.path));
    const undo = planUndo(latest.protocol, entries);
    const failedPaths = new Set<string>();
    for (const { path, change } of undo.changes) {
      try {
        await writeFrontmatter(this.app, path, toWriteChange(change));
      } catch {
        failedPaths.add(path);
      }
    }
    const remaining = latest.protocol.items.filter((item) => failedPaths.has(item.path));
    if (remaining.length > 0) await shrinkMigrationProtocol(this.app, latest.path, remaining);
    else await removeMigrationProtocol(this.app, latest.path);
    this.rerenderBoard();
    const conflictLines = undo.conflicts.map(
      (c) => `Konflikt: ${c.path}: ${c.key} seither geändert, nicht zurückgenommen`,
    );
    return { ok: true, conflictLines, count: undo.changes.length };
  }

  private async runUndoMigrationCommand(): Promise<void> {
    await this.indexReady;
    const latest = await latestMigrationProtocol(this.app);
    if (!latest) {
      new Notice('Kein Übernahme-Protokoll gefunden.', NOTICE_DURATION);
      return;
    }
    const confirmed = await ConfirmDialog.ask(this.app, {
      title: 'Übernahme rückgängig machen',
      lines: [`${latest.protocol.items.length} Dateien werden auf den Stand vor der letzten Übernahme zurückgesetzt.`],
      confirmText: 'Rückgängig machen',
    });
    if (!confirmed) return;
    const result = await this.performUndo();
    if (!result.ok) {
      new Notice(result.reason, NOTICE_DURATION);
      return;
    }
    if (result.conflictLines.length > 0) new Notice(result.conflictLines.join('\n'), NOTICE_DURATION);
    else new Notice(`Übernahme rückgängig gemacht: ${result.count} Dateien.`, NOTICE_DURATION);
  }

  // Zeilen der Bestandsprüfung (011, Ergänzung 2026-09-24/S76): identisch für
  // `ktm:check` und den Dialog "Bestand prüfen" (S112), einschließlich der
  // Schlusszeile `ktm:check <n> Befunde`. Schreibt nichts.
  private async checkLines(): Promise<string[]> {
    await this.indexReady;
    const { elements, projects } = this.placementElements();
    const entries = this.index.entries();
    const unadopted = unadoptedNotes(this.app, this.index.roots());
    const resolveLink = (linktext: string, sourcePath: string) =>
      this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)?.path;
    const findings = checkFindings(
      entries,
      elements,
      unadopted,
      resolveLink,
      projects,
      (el) => this.isDoneForPlacement(el, elements, projects),
    );
    const lines = findings.map((f) => `${f.path}: ${f.reason}`);
    lines.push(`ktm:check ${findings.length} Befunde`);
    return lines;
  }

  // "Bestand prüfen" (011 S112): ein reiner Anzeigedialog, keine Knöpfe,
  // Schließen ist Obsidians Standard (Escape, Kreuz, Klick daneben).
  private async runCheckCommand(): Promise<void> {
    const lines = await this.checkLines();
    const modal = new Modal(this.app);
    modal.setTitle('Bestand prüfen');
    for (const line of lines) {
      modal.contentEl.createEl('p', { text: line, cls: 'ktm-check-line' });
    }
    modal.open();
  }

  private async runUndoMigrationCli(): Promise<string> {
    const result = await this.performUndo();
    if (!result.ok) return `ktm:error ${result.reason}`;
    const lines = [...result.conflictLines, `ktm:migrate rückgängig: ${result.count} Dateien`];
    return lines.join('\n');
  }

  // "LLM-Verweis einrichten" (011, S72): eine Bestätigung nennt die Zeile, die
  // angehängt wird, dann appendLlmLink (idempotent, K28); was tatsächlich
  // angehängt wurde, merkt sich das Plugin in data.json, damit "LLM-Verweis
  // entfernen" es byte-genau zurücknehmen kann (011, Ergänzung 2026-09-25).
  private async runSetupLlmLinkCommand(): Promise<void> {
    const confirmed = await ConfirmDialog.ask(this.app, {
      title: 'LLM-Verweis einrichten',
      lines: [`An CLAUDE.md wird ein Verweis auf ${GUIDE_NOTE_PATH} angehängt (oder die Datei neu angelegt).`],
    });
    if (!confirmed) return;
    try {
      const info = await appendLlmLink(this.app);
      if (info.appended) {
        this.settings.llmLink = info;
        await this.saveData(this.settings);
      }
    } catch (err) {
      new Notice(`LLM-Verweis einrichten fehlgeschlagen: CLAUDE.md (${errorMessage(err)})`, NOTICE_DURATION);
    }
  }

  // "LLM-Verweis entfernen" (011, Ergänzung 2026-09-25, S75): keine
  // Bestätigung nötig, der gemerkte Eintrag sagt genau, was rückgängig zu
  // machen ist; ohne einen (etwa nach vault:reset, wissen #722/#694) fällt
  // removeLlmLink auf das Entfernen der bekannten Zeile zurück.
  private async runRemoveLlmLinkCommand(): Promise<void> {
    try {
      await removeLlmLink(this.app, this.settings.llmLink);
    } catch (err) {
      new Notice(`LLM-Verweis entfernen fehlgeschlagen: ${errorMessage(err)}`, NOTICE_DURATION);
      return;
    }
    delete this.settings.llmLink;
    await this.saveData(this.settings);
  }

  // Live-Konfiguration für Teil 2 der Anleitung (011): dieselbe
  // resolveProjectSettings-Quelle wie der Board-Render, damit Teil 2 nie
  // hinter der tatsächlichen Konfiguration zurückbleibt.
  private currentGuide(): string {
    const { projects } = resolveProjectSettings(this.index.entries());
    return renderGuide({ version: this.manifest.version, config: { general: this.settings, projects } });
  }

  // Zahl der noch nicht übernommenen 0.0.1-Notizen (011 S69), aus dem
  // MetadataCache allein, ohne einen einzigen Körper zu lesen — BoardView#render
  // ruft dies bei jedem Zeichnen auf.
  legacyCount(): number {
    return countLegacyCandidates(this.app, this.index.roots());
  }

  // The BoardElement set and the plain {key,root} project list core/placement
  // needs (011, Ergänzung 2026-09-25): the same read path the board itself
  // uses (readElements + withoutHiddenProjects), so ktm:where/ktm:set/
  // ktm:check/placeElement never see a different world than the open board.
  private placementElements(): { elements: BoardElement[]; projects: PlacementProject[] } {
    const entries = this.index.entries();
    const roots = this.index.roots();
    const { projects } = resolveProjectSettings(entries);
    const visible = withoutHiddenProjects(entries, roots, projects);
    const levelsFor = (project: string) => settingsFor(this.settings, projects.find((p) => p.key === project)).levels;
    const linkKindsFor = (project: string) => settingsFor(this.settings, projects.find((p) => p.key === project)).linkKinds;
    const elements = readElements(visible.entries, visible.roots, linkKindsFor, levelsFor);
    return { elements, projects: projects.map((p) => ({ key: p.key, root: p.root })) };
  }

  // Ablageregel 1 stays a toggle (011, Ergänzung 2026-09-25, "Regel 1 ist
  // aber Teil der Berechnung"): off, nothing ever counts as done for
  // placement purposes, so computedLocation never inserts the Done/ mirror.
  // While data.json is unreadable (006, Ergänzung 2026-10-18), the possibly
  // stale columns must not decide a move either way: isDoneForPlacement
  // reports whether the element already sits under a Done/ mirror instead, so
  // computedLocation's withDoneMirror is a no-op (S56, K1/K2).
  private isDoneForPlacement(
    el: BoardElement,
    elements: BoardElement[],
    projects: PlacementProject[],
  ): boolean | undefined {
    if (this.settingsLocked) return isCurrentlyDone(el, elements, projects);
    if (!(this.settings.moveDoneToFolder ?? true)) return false;
    const project = el.project
      ? resolveProjectSettings(this.index.entries()).projects.find((p) => p.key === el.project)
      : undefined;
    return statusClosure(el.status, resolveColumns(this.settings, project));
  }

  // Runs `fn` after every already-queued step has settled (F123, "Exklusiver
  // Abschnitt für Umzug und Abgleich"): a plain FIFO append on a Promise
  // chain, not a lock anyone explicitly releases, so queuing from *inside* an
  // already-running step (a fire-and-forget event it triggers) only ever
  // schedules it after — it can never deadlock against itself. The chain is
  // kept alive across a failing `fn` (`.then(noop, noop)`), so one failed
  // step never leaves every later one running in parallel with it instead of
  // after it.
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.exclusiveChain.then(fn, fn);
    this.exclusiveChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // Moves `id` to its computedLocation, if it has one and isn't already there
  // (011, Ergänzung 2026-09-25, "placeElement"): the one place every
  // interactive and CLI path funnels through. Returns the note's path after
  // the move (or its unchanged path when nothing moved), `undefined` when
  // there is nothing to do or the move failed (a Notice already shown). The
  // actual decision and move run inside {@link runExclusive} (F123): queued
  // behind any move or render already under way, and computed fresh against
  // the index only once it is this call's own turn — never frozen at the
  // moment `placeElement` itself was invoked.
  async placeElement(id: string): Promise<string | undefined> {
    await this.indexReady;
    return this.placeElementNow(id);
  }

  // The body of {@link placeElement} without the `await this.indexReady`
  // guard (F123): `catchUpAfterLoad` runs *inside* the `.then()` chain that
  // `this.indexReady` itself is, for the ids `load()` caught up on while
  // registration raced the scan (008 Ergänzung 2026-10-18 S54/S55) —
  // `placeElement` there would await the very promise its own call is
  // helping to resolve and deadlock forever. Every other caller already knows
  // the index is loaded by construction (inside `indexReady` or after it) and
  // goes through `placeElement` instead.
  private placeElementNow(id: string): Promise<string | undefined> {
    return this.runExclusive(async () => {
      const { elements, projects } = this.placementElements();
      const element = elements.find((e) => e.id === id);
      if (!element) return undefined;
      const target = computedLocation(element, elements, projects, (el) => this.isDoneForPlacement(el, elements, projects));
      if (!target) return undefined;
      const current = currentLocation(element, elements, projects);
      if (target === current) return element.paths.note;
      const parentDir = dirOf(target);
      const toNotePath = element.form === 'atomic' ? target : `${target}/${baseName(element.paths.note)}`;
      const board = this.activeBoard();
      // A pre-existing Done mirror without its own element note is merged
      // into, never any other occupied target (008, Ergänzung 2026-10-19,
      // "Der berechnete Ort ist schon belegt"; S47 and F068 K3 are abgelöst).
      const run = (): Promise<void> => moveElement(this.app, current, target, parentDir, isInDoneMirror(target, projects));
      try {
        if (board) await board.runReconciling(run);
        else await run();
        return toNotePath;
      } catch (err) {
        // 011 S92/K34, 008 Ergänzung 2026-10-19: a failed move — a locked
        // file, or an occupied target (adapters/obsidian.ts#moveElement's
        // classifyTarget) — leaves the note untouched beyond `parent`,
        // byte-for-byte, no implicit `ktm_placement` write and no suffix.
        // element.placement is already known not to be 'manual' here
        // (computedLocation's own early check), so the note stays eligible
        // for the next attempt without any extra field.
        new Notice(`Ablage übersprungen: ${current} → ${target} (${errorMessage(err)})`, NOTICE_DURATION);
        return undefined;
      }
    });
  }

  // "An berechneten Ort verschieben" (011 K41): every auto element
  // placementFindings names as not at its computed location, moved one by
  // one through the same placeElement every other path uses.
  private async runMoveToComputedCommand(): Promise<void> {
    await this.indexReady;
    const { elements, projects } = this.placementElements();
    const findings = placementFindings(elements, projects, (el) => this.isDoneForPlacement(el, elements, projects));
    const ids = new Set<string>();
    for (const finding of findings) {
      if (!finding.reason.startsWith('liegt nicht am berechneten Ort')) continue;
      const el = elements.find((e) => e.paths.note === finding.path);
      if (el) ids.add(el.id);
    }
    let moved = 0;
    for (const id of ids) {
      if (await this.placeElement(id)) moved++;
    }
    new Notice(`An berechneten Ort verschoben: ${moved}`, NOTICE_DURATION);
  }

  // ktm:set's field validation and write (011, Ergänzung 2026-09-25): every
  // value is checked before anything is written, matching ktm:create's
  // "bei einem Fehler nichts schreiben" (011 S77). A parent must resolve to a
  // known element on a strictly higher level than the (possibly just-changed)
  // target level, exactly like the board's own ParentDialog would require.
  // Gemeinsame Feldprüfung für ktm:set und ktm:create (011, Ergänzung
  // 2026-09-25, umsetzung "die Feldprüfung wandert in eine private Methode"):
  // Projekt, Ebene, Status und ein Parent mit Ebenenvergleich, jede Meldung
  // mit `prefix`. `defaults` gilt für jedes vom Aufrufer nicht angegebene
  // Feld; ein Parent wird nur geprüft, wenn `params.parent` gesetzt und nicht
  // leer ist (ktm:set nutzt eine leere Zeichenkette für "Parent entfernen",
  // ohne dass hier je ein Parent nachgeschlagen wird).
  private resolveTargetFields(
    prefix: string,
    params: { project?: string; type?: string; status?: string; parent?: string },
    defaults: { project: string; type: string; status: string },
    elements: BoardElement[],
    projects: PlacementProject[],
  ): { project: string; type: string; status: string; parent?: BoardElement } {
    const project = params.project ?? defaults.project;
    if (params.project !== undefined && params.project !== 'intern' && !projects.some((p) => p.key === params.project)) {
      throw new Error(`${prefix}: unbekanntes Projekt „${params.project}“ (project).`);
    }

    const projectSettings = resolveProjectSettings(this.index.entries()).projects.find((p) => p.key === project);
    const levels = settingsFor(this.settings, projectSettings).levels;
    const type = params.type ?? defaults.type;
    if (params.type !== undefined && !levels.some((l) => l.key === params.type)) {
      throw new Error(`${prefix}: unbekannte Ebene „${params.type}“ (type).`);
    }

    const columns = resolveColumns(this.settings, projectSettings);
    const status = params.status ?? defaults.status;
    if (params.status !== undefined) {
      const known = columns.some((c) => c.status === params.status) || params.status === 'done' || params.status === 'wont-do';
      if (!known) throw new Error(`${prefix}: unbekannter Status „${params.status}“ (status).`);
    }

    let parent: BoardElement | undefined;
    if (params.parent !== undefined && params.parent !== '') {
      // Only among valid, non-duplicate elements (F090 Fund): `elements`
      // still carries the invalid copy of a duplicate id alongside the kept
      // winner, and readElements lists it first — an unfiltered find would
      // resolve the parent to that copy, whose `type` no longer reflects the
      // real hierarchy.
      const found = elements.find((e) => e.id === params.parent && !e.invalid && !e.duplicate);
      if (!found) throw new Error(`${prefix}: unbekannter Parent „${params.parent}“ (parent).`);
      const targetIdx = levels.findIndex((l) => l.key === type);
      const parentIdx = levels.findIndex((l) => l.key === found.type);
      if (parentIdx === -1 || targetIdx === -1 || parentIdx >= targetIdx) {
        throw new Error(`${prefix}: Parent „${params.parent}“ liegt auf gleicher oder tieferer Ebene (parent).`);
      }
      // 011 Ergänzung 2026-10-19 (S103): ein Parent aus einem anderen Projekt
      // als dem, das das Element nach diesem Aufruf trägt, ist ungültig — ob
      // `project` hier mitgegeben wurde oder nicht (defaults.project trägt
      // dann das bisherige Projekt). `found.project` ist bereits normalisiert
      // (undefined für "intern", s. normalizeProject), `project` noch nicht.
      if (found.project !== (project === 'intern' ? undefined : project)) {
        throw new Error(`${prefix}: Parent „${params.parent}“ gehört zu einem anderen Projekt (parent).`);
      }
      parent = found;
    }

    return { project, type, status, parent };
  }

  private async runKtmSet(params: Record<string, string | undefined>): Promise<string> {
    const id = params.id;
    if (!id) throw new Error('ktm:set: id fehlt.');
    const { elements, projects } = this.placementElements();
    const element = elements.find((e) => e.id === id);
    if (!element) throw new Error(`ktm:set: unbekannte Kennung „${id}“.`);

    const resolved = this.resolveTargetFields(
      'ktm:set',
      { project: params.project, type: params.type, status: params.status, parent: params.parent },
      { project: element.project ?? 'intern', type: element.type, status: element.status },
      elements,
      projects,
    );

    const change: Record<string, string | null> = {};
    if (params.project !== undefined) change.project = resolved.project;
    if (params.type !== undefined) change.type = resolved.type;
    if (params.status !== undefined) change.status = resolved.status;

    if (params.parent !== undefined) {
      if (params.parent === '') {
        change.parent = null;
        change.parent_link = null;
      } else if (resolved.parent) {
        change.parent = resolved.parent.id;
        const link = parentLinkTo(this.app, resolved.parent.paths.note, element.paths.note, resolved.parent.title);
        if (link) change.parent_link = yamlScalar(link);
      }
    }

    if (params.placement !== undefined) {
      if (params.placement !== 'auto' && params.placement !== 'manual') {
        throw new Error(`ktm:set: ungültiger Wert für placement „${params.placement}“.`);
      }
      change.ktm_placement = params.placement;
    }

    // Projektwechsel nimmt den Parent (011, Ergänzung 2026-10-19): ohne eigens
    // angegebenen Parent, und gehört der bisherige zum alten Projekt, im
    // selben change entfernen, statt auf das eigene changed-Ereignis zu
    // warten — so sieht refreshIndexEntry schon den Stand ohne Parent, und
    // placeElement unten gibt sofort den neuen Pfad im Root des Projekts
    // zurück (K4).
    if (params.project !== undefined && params.parent === undefined && params.project !== (element.project ?? 'intern')) {
      const currentParentRef = element.parents[0];
      const currentParent = currentParentRef ? elements.find((e) => e.id === currentParentRef.id) : undefined;
      if (currentParent && currentParent.project === element.project) {
        change.parent = null;
        change.parent_link = null;
      }
    }

    if (Object.keys(change).length > 0) {
      await writeFrontmatter(this.app, element.paths.note, change);
      // writeFrontmatter only waits for *a* metadataCache 'changed' event to
      // fire (its own temporary listener), not for this plugin's own
      // permanent one to have finished feeding the index — so a placeElement
      // right after could still read the stale, pre-write entry. Refresh it
      // explicitly first, from the cache the write itself already settled.
      await this.refreshIndexEntry(element.paths.note);
    }
    const newPath = await this.placeElement(id);
    return newPath ?? element.paths.note;
  }

  // ktm:create (011, Ergänzung 2026-09-25, "Anlegen per CLI"): validates
  // every field via {@link resolveTargetFields} first — nothing is created on
  // an invalid value — then files the note exactly like a draft on the board
  // would (Standardablage: im Ordner eines Parents, sonst im Root des
  // Projekts, ohne Root oder für „intern“ atomar unter `_Tasks/Atomic/`).
  private async runKtmCreate(params: Record<string, string | undefined>): Promise<string> {
    const rejection = validateCreateValues(params);
    if (rejection) throw new Error(`ktm:create: ${rejection}`);
    const title = params.title!.trim();
    if (!params.project) throw new Error('ktm:create: project fehlt.');

    const { elements, projects } = this.placementElements();
    const { projects: resolvedProjects } = resolveProjectSettings(this.index.entries());
    const projectSettings = resolvedProjects.find((p) => p.key === params.project);
    const levels = settingsFor(this.settings, params.project === 'intern' ? undefined : projectSettings).levels;
    const columns = resolveColumns(this.settings, params.project === 'intern' ? undefined : projectSettings);

    const resolved = this.resolveTargetFields(
      'ktm:create',
      { project: params.project, type: params.type, status: params.status, parent: params.parent },
      { project: params.project, type: bottomLevel(levels)?.key ?? 'task', status: columns[0]?.status ?? '' },
      elements,
      projects,
    );

    const today = this.todayOverride();
    const id = newId(this.knownIds());
    let path: string;
    let parentLink: string | undefined;
    if (resolved.parent) {
      const parentFolder = resolved.parent.paths.folder;
      path = parentFolder
        ? nestedPaths(parentFolder, title, today, this.siblingNamesFor(parentFolder)).note
        : atomicNotePath(title, today, this.siblingNamesFor('_Tasks/Atomic'));
      parentLink = parentLinkTo(this.app, resolved.parent.paths.note, path, resolved.parent.title);
    } else {
      const root = projectSettings?.root?.replace(/\/+$/, '');
      path = root
        ? nestedPaths(root, title, today, this.siblingNamesFor(root)).note
        : atomicNotePath(title, today, this.siblingNamesFor('_Tasks/Atomic'));
    }

    const content = noteContent({
      id,
      type: resolved.type,
      title,
      status: resolved.status,
      project: resolved.project,
      created: today,
      parent: resolved.parent?.id,
      parentLink,
    });
    await createNote(this.app, path, content);

    const extra: Record<string, string> = {};
    if (params.due) extra.due = params.due;
    if (params.planned) extra.planned = params.planned;
    if (params.priority) extra.priority = params.priority;
    if (Object.keys(extra).length > 0) await writeFrontmatter(this.app, path, extra, { allowCreate: true });

    return `${id} ${path}`;
  }

  // ktm:result (005, Ergänzung 2026-10-19 "Results für Claude"): everything
  // that can fail is checked before the first write — unknown id, missing
  // file, no target (neither `target` nor a direct parent), a name already
  // taken at the target (planResult's `occupied`). `notes` on the target is
  // written before `results` on the task (same order BoardView#assignResult
  // uses): by the time the task's own write lands and its `changed` echo
  // reaches {@link assignFrontmatterResults}, the entry already resolves as
  // assigned there and that echo is a no-op.
  private async runKtmResult(params: Record<string, string | undefined>): Promise<string> {
    const id = params.id;
    if (!id) throw new Error('ktm:result: id fehlt.');
    const filePath = params.file;
    if (!filePath) throw new Error('ktm:result: file fehlt.');

    const { elements } = this.placementElements();
    const task = elements.find((e) => e.id === id && !e.invalid && !e.duplicate);
    if (!task) throw new Error(`ktm:result: unbekannte Kennung „${id}“.`);

    const doc = this.app.vault.getFileByPath(filePath);
    if (!(doc instanceof TFile)) throw new Error(`ktm:result: Datei nicht gefunden „${filePath}“.`);

    let target: BoardElement | undefined;
    if (params.target !== undefined) {
      target = elements.find((e) => e.id === params.target && !e.invalid && !e.duplicate);
      if (!target) throw new Error(`ktm:result: unbekanntes Ziel „${params.target}“ (target).`);
    } else {
      const parentRef = task.parents[0];
      target = parentRef ? elements.find((e) => e.id === parentRef.id && !e.invalid && !e.duplicate) : undefined;
      if (!target) throw new Error(`ktm:result: „${id}“ hat keinen Parent, target fehlt.`);
    }

    const plan = planResult(doc.path, target.paths.note, (p) => !!this.app.vault.getAbstractFileByPath(p));
    if (plan.kind === 'occupied') throw new Error(`ktm:result: Name schon vergeben „${plan.to}“.`);

    return this.runExclusive(async () => {
      let finalFile = doc;
      if (plan.kind === 'move') {
        for (const message of await moveDocument(this.app, plan.from, plan.to)) new Notice(message, NOTICE_DURATION);
        const moved = this.app.vault.getFileByPath(plan.to);
        if (!(moved instanceof TFile)) throw new Error(`ktm:result: Datei nach dem Verschieben nicht gefunden „${plan.to}“.`);
        finalFile = moved;
      }
      await appendFreeLink(this.app, target.paths.note, 'notes', finalFile);
      await appendFreeLink(this.app, task.paths.note, 'results', finalFile);
      return finalFile.path;
    });
  }

  // Zuordnung über das Frontmatter (005, Ergänzung 2026-10-19 "Results für
  // Claude"): läuft in {@link runExclusive}, angestoßen von {@link
  // onNoteChanged} für jede Notiz mit `ktm_id`, deren `results`/
  // `result_target` sich geändert haben könnten. unassignedResults gegen den
  // frisch gerechneten Index (nicht den Stand beim Auslösen) macht die
  // Funktion gegen ihre eigenen changed-Ereignisse idempotent (wissen #1178):
  // schon zugeordnete Einträge liefern beim nächsten Durchlauf nichts mehr.
  private assignFrontmatterResults(taskPath: string): Promise<void> {
    return this.runExclusive(async () => {
      const file = this.app.vault.getFileByPath(taskPath);
      if (!file) return;
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const taskId = frontmatter?.ktm_id;
      if (typeof taskId !== 'string' || !taskId.trim()) return;

      const { elements } = this.placementElements();
      const task = elements.find((e) => e.id === taskId && !e.invalid && !e.duplicate);
      if (!task) return;

      const resolveFrom = (sourcePath: string, target: string): string | undefined =>
        this.app.metadataCache.getFirstLinkpathDest(target, sourcePath)?.path;

      const resultPaths = task.links
        .filter((l) => l.kind === 'results')
        .map((l) => resolveFrom(taskPath, l.target))
        .filter((p): p is string => !!p);
      if (resultPaths.length === 0) return;

      const carriersOf = (path: string): string[] =>
        elements
          .filter((e) => e.links.some((l) => l.kind === 'notes' && resolveFrom(e.paths.note, l.target) === path))
          .map((e) => e.paths.note);

      const unassigned = unassignedResults(resultPaths, carriersOf);
      if (unassigned.length === 0) return;

      const rawTarget = typeof frontmatter?.result_target === 'string' ? frontmatter.result_target.trim() : '';
      let target: BoardElement | undefined;
      if (rawTarget) {
        target = elements.find((e) => e.id === rawTarget && !e.invalid && !e.duplicate);
        if (!target) return;
      } else {
        const parentRef = task.parents[0];
        target = parentRef ? elements.find((e) => e.id === parentRef.id && !e.invalid && !e.duplicate) : undefined;
        if (!target) return;
      }

      for (const path of unassigned) {
        const plan = planResult(path, target.paths.note, (p) => !!this.app.vault.getAbstractFileByPath(p));
        if (plan.kind === 'no-target') continue;
        if (plan.kind === 'occupied') {
          new Notice(`Name schon vergeben: ${plan.from} und ${plan.to}`, NOTICE_DURATION);
          continue;
        }
        let finalPath = path;
        if (plan.kind === 'move') {
          try {
            for (const message of await moveDocument(this.app, plan.from, plan.to)) new Notice(message, NOTICE_DURATION);
          } catch (err) {
            new Notice(`Result verschieben: ${plan.from} (${errorMessage(err)})`, NOTICE_DURATION);
            continue;
          }
          finalPath = plan.to;
        }
        const finalFile = this.app.vault.getFileByPath(finalPath);
        if (!(finalFile instanceof TFile)) continue;
        await appendFreeLink(this.app, target.paths.note, 'notes', finalFile);
      }

      if (rawTarget) await writeFrontmatter(this.app, taskPath, { result_target: null });
    });
  }

  /** The names of every direct child of `folder` (008 S28/S48-style de-duplication for ktm:create). */
  private siblingNamesFor(folder: string): string[] {
    const abstract = this.app.vault.getAbstractFileByPath(folder);
    return abstract instanceof TFolder ? abstract.children.map((c) => c.name) : [];
  }

  private async refreshIndexEntry(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    const frontmatter = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    await this.index.changed(path, frontmatter);
  }

  private knownIds(): Set<string> {
    return new Set(
      this.index
        .entries()
        .map((e) => e.frontmatter.ktm_id)
        .filter((id): id is string => typeof id === 'string' && id.trim() !== ''),
    );
  }

  private todayOverride(): string {
    return todayISO((window as KtmWindow).__ktmToday);
  }

  // Re-reads data.json from disk so a render picks up an edit made to the
  // general settings outside the app, without keeping a live watcher (006 S7).
  // Ergänzung 2026-10-18 "Einstellungen fallen nie still zurück": a thrown
  // read (loadData's own JSON.parse on a broken file), or any value that is
  // not a plain object, counts as unreadable; `null` only counts as a missing
  // file (wissen #694, no lock, DEFAULT_SETTINGS) the first time this ever
  // runs — once a real object has been read, a later `null` means the file
  // went missing in an unhealthy way and is unreadable too. Unreadable during
  // onload (nothing read yet) falls back to DEFAULT_SETTINGS under the lock
  // (S57); unreadable later keeps the last known-good this.settings exactly
  // as it is (S56, wissen #518 — render() calls this on every redraw).
  async reloadSettings(): Promise<void> {
    let stored: unknown;
    try {
      stored = await this.loadData();
    } catch {
      this.lockSettings();
      return;
    }
    if (stored === null && !this.hasReadSettingsObject) {
      this.settings = { ...DEFAULT_SETTINGS };
      this.storedSettings = {};
      this.settingsLocked = false;
      return;
    }
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
      this.lockSettings();
      return;
    }
    this.storedSettings = stored as Partial<GeneralSettings>;
    this.settings = { ...DEFAULT_SETTINGS, ...this.storedSettings };
    this.hasReadSettingsObject = true;
    this.settingsLocked = false;
    this.clearUnreadableTimer();
  }

  // Löscht den Zeitgeber aus lockSettings und die Einmal-Marke für seinen
  // Hinweis (006, Ergänzung 2026-10-19, S66/S67): nach einem erfolgreichen
  // Lesen bekommt eine spätere neue Phase der Unlesbarkeit wieder ihren
  // eigenen Hinweis.
  private clearUnreadableTimer(): void {
    if (this.unreadableTimer !== undefined) {
      window.clearTimeout(this.unreadableTimer);
      this.unreadableTimer = undefined;
    }
    this.unreadableNotified = false;
  }

  // Zweite, ereignislose Nachprüfung 10s nach dem Übergang auf unlesbar
  // (S66/S67, Wissen #518 für den Startzeitpunkt): liest data.json über
  // reloadSettings erneut, damit auch dann kein Hinweis fehlt, wenn die Datei
  // beim Zurückkommen kein onExternalSettingsChange auslöst. Ist sie
  // inzwischen wieder lesbar, hat reloadSettings den Zeitgeber selbst gelöscht
  // und hier gibt es nichts zu melden.
  private async notifyStillUnreadable(): Promise<void> {
    this.unreadableTimer = undefined;
    await this.reloadSettings();
    if (this.settingsLocked) {
      new Notice(SETTINGS_STILL_UNREADABLE_NOTICE, NOTICE_DURATION);
      this.unreadableNotified = true;
    }
  }

  // Merges a partial state into the raw storedSettings (not this.settings,
  // which also carries DEFAULT_SETTINGS) and writes exactly that through
  // saveData, so saveViewState/toggleCollapsedColumn/toggleCollapsedToday
  // never resurrect keys that were never in data.json (K13(c), Wissen #963).
  private async saveStoredSettings(patch: Partial<GeneralSettings>): Promise<void> {
    this.storedSettings = { ...this.storedSettings, ...patch };
    await this.saveData(this.storedSettings);
  }

  private lockSettings(): void {
    const wasLocked = this.settingsLocked;
    this.settingsLocked = true;
    if (!this.hasReadSettingsObject) {
      this.settings = { ...DEFAULT_SETTINGS };
      return;
    }
    // Übergang lesbar -> unlesbar (S66/S67): Zeitgeber nur beim ersten Tritt
    // in diese Phase starten, nicht bei jedem weiteren reloadSettings, das
    // render() währenddessen auslöst (wissen #518).
    if (!wasLocked && this.unreadableTimer === undefined && !this.unreadableNotified) {
      this.unreadableTimer = window.setTimeout(() => void this.notifyStillUnreadable(), UNREADABLE_NOTIFY_DELAY);
    }
  }

  // The index's one full scan (ElementIndex.load, via list()+read()), timed
  // to run once the metadata cache has resolved the vault (011 S61,
  // konventionen.md "Erstaufbau nach 'resolved'"), or immediately if it
  // already has: a `plugin:reload` (every e2e script, and Obsidian's normal
  // enable/disable) hits an already-warm cache, where 'resolved' fired long
  // ago and will not fire again just because the plugin reloaded — waiting
  // for it regardless would cost a needless multi-second stall on every
  // reload. Before `workspace.layoutReady`, though, `vault.getMarkdownFiles()`
  // can still return an empty or partial list while the vault is still being
  // scanned (observed: 0 files right after a full app reload), which would
  // make the "already resolved" check below vacuously true on that empty list
  // and load the index against nothing, forever — no later event corrects a
  // decision already baked into the resolved `indexReady` promise. Waiting
  // for `onLayoutReady` first guarantees the file list itself is complete
  // before that check ever runs.
  private buildIndex(): Promise<string[]> {
    if (this.app.workspace.layoutReady) return this.buildIndexNow();
    return new Promise((resolve) => {
      this.app.workspace.onLayoutReady(() => {
        void this.buildIndexNow().then(resolve);
      });
    });
  }

  // `metadataFullyCached` is the cheap, synchronous stand-in for the "already
  // resolved" flag Obsidian does not expose publicly; only a genuinely fresh
  // vault load falls through to the event, with a timeout mirroring the
  // fallback adapters/obsidian.ts already uses for nextMetadataChange.
  private buildIndexNow(): Promise<string[]> {
    if (this.metadataFullyCached()) return this.index.load();
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        this.app.metadataCache.offref(ref);
        window.clearTimeout(timer);
        void this.index.load().then(resolve);
      };
      const ref = this.app.metadataCache.on('resolved', finish);
      const timer = window.setTimeout(finish, 2000);
    });
  }

  private metadataFullyCached(): boolean {
    const files = this.app.vault.getMarkdownFiles();
    return files.length > 0 && files.every((file) => this.app.metadataCache.getFileCache(file) !== null);
  }

  // Nachgeholte Pfade aus ElementIndex.load() (F123, 008 Ergänzung 2026-10-18
  // "Abgleich während des Starts"): jeder behandelt wie eine Änderung im
  // laufenden Betrieb — placeElement für seine ktm_id (meist ohne Wirkung,
  // ein Element, das sich gar nicht geändert hat, zieht nicht um) — und das
  // Board danach genau einmal neu gezeichnet, nicht einmal je Pfad.
  private async catchUpAfterLoad(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    for (const id of new Set(ids)) {
      await this.placeElementNow(id);
    }
    this.rerenderBoard();
  }

  // The vault's own three sources of change (011 S61), always kept exactly
  // in this order: the index is fed first, so the board's own hook — called
  // right after — already sees the fresh entry when it recomputes anything
  // in memory (retargetDetail).
  private async onNoteChanged(file: TAbstractFile, cache: CachedMetadata): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    const before = this.index.get(file.path);
    await this.index.changed(file.path, cache.frontmatter);
    await this.assignNewId(file, cache.frontmatter);
    // Eigene Hilfsnotizen (005 S7, F123 K7): ihr eigenes changed-Ereignis darf
    // kein zweites Neuzeichnen anstoßen, neben dem, das die Einstellungsänderung
    // selbst schon auslöst.
    if (!OWN_HELPER_NOTES.has(file.path)) this.activeBoard()?.onNoteChanged(file.path, cache);
    if (before) {
      // Vor maybePlaceAfterChange und nacheinander (F127 S37/S38): das
      // Löschen eines übrig gebliebenen order darf nicht mit einem Umzug
      // nach Done/ wettlaufen, den derselbe Statuswechsel auslöst.
      await this.cleanupOrderAfterStatusChange(file.path, before.frontmatter, cache.frontmatter);
      if (before.frontmatter.status !== cache.frontmatter?.status) {
        await this.stampStartedAfterStatusChange(file.path, cache.frontmatter);
      }
      // Projektwechsel nimmt den Parent (011, Ergänzung 2026-10-19), gleich
      // auf welchem Weg `project` sich geändert hat. Schreibt dropParent... in
      // diesem Fall etwas, löst das eigene changed-Ereignis die Ablage schon
      // aus; maybePlaceAfterChange würde sonst noch gegen den alten Parent
      // rechnen.
      const oldProject = normalizeProject(before.frontmatter.project);
      const newProject = normalizeProject(cache.frontmatter?.project);
      const droppedParent =
        oldProject !== newProject ? await this.dropParentFromOldProject(file.path, oldProject, cache.frontmatter) : false;
      if (!droppedParent) void this.maybePlaceAfterChange(before.frontmatter, cache.frontmatter);
    }
    if (before && before.frontmatter.title !== cache.frontmatter?.title) {
      const id = cache.frontmatter?.ktm_id;
      const title = cache.frontmatter?.title;
      if (typeof id === 'string' && id.trim() && typeof title === 'string') {
        void this.syncChildLinks(id, file.path, title);
      }
    }
    // Zuordnung über das Frontmatter (005, Ergänzung 2026-10-19 "Results für
    // Claude"): angestoßen, wenn `results` oder `result_target` sich gegenüber
    // `before` geändert haben könnten, oder `result_target` weiterhin steht
    // (eine vorige Zuordnung, deren eigenes Löschen des Schlüssels noch
    // aussteht). assignFrontmatterResults selbst ist idempotent (wissen
    // #1178), ein zu häufiger Anstoß kostet nur eine billige Prüfung.
    if (typeof cache.frontmatter?.ktm_id === 'string' && cache.frontmatter.ktm_id.trim()) {
      const prevFm = before?.frontmatter;
      const resultsChanged = JSON.stringify(prevFm?.results ?? null) !== JSON.stringify(cache.frontmatter.results ?? null);
      const targetChanged = (prevFm?.result_target ?? null) !== (cache.frontmatter.result_target ?? null);
      if (resultsChanged || targetChanged || cache.frontmatter.result_target !== undefined) {
        void this.assignFrontmatterResults(file.path);
      }
    }
  }

  // "parent_link wird mitgepflegt" (011, Ergänzung 2026-09-25): every child
  // whose `parent` names this element and that already carries a
  // `parent_link` gets it rewritten to the (possibly just renamed or moved)
  // parent note, with its current title as alias — without asking, since the
  // value belongs to the plugin (`parent` itself never changes). A child
  // without `parent_link` never gets one (ausserhalb, F090). Each child's own
  // path is resolved fresh, right before it is used (011, Ergänzung
  // 2026-10-24): the id list is taken up front, but `await writeFrontmatter`
  // below yields between children, and a path held from that first snapshot
  // could go stale by the time its turn comes if another rename lands
  // meanwhile — `latestEntries()` always reflects what the index holds now.
  private async syncChildLinks(parentId: string, parentNotePath: string, parentTitle: string): Promise<void> {
    const childIds = new Set(
      this.index
        .entries()
        .filter((e) => e.frontmatter.parent === parentId)
        .map((e) => e.frontmatter.ktm_id)
        .filter((id): id is string => typeof id === 'string' && id.trim() !== ''),
    );
    for (const childId of childIds) {
      const entry = this.index.latestEntries().find((e) => e.frontmatter.ktm_id === childId);
      if (!entry) continue;
      const existing = entry.frontmatter.parent_link;
      if (typeof existing !== 'string' || !existing.trim()) continue;
      const next = parentLinkTo(this.app, parentNotePath, entry.path, parentTitle);
      if (!next || next === existing) continue;
      try {
        await writeFrontmatter(this.app, entry.path, { parent_link: yamlScalar(next) });
      } catch (err) {
        new Notice(`parent_link konnte nicht aktualisiert werden: ${entry.path} (${errorMessage(err)})`, NOTICE_DURATION);
      }
    }
  }

  // "Sofort" (011, Ergänzung 2026-09-25): a change to parent/project/type/
  // status/ktm_placement places the element right away, whoever made it —
  // Board, CLI, or a hand edit. `before` is undefined for a note the index
  // never held (a brand-new note, or one that just got its first `ktm_id`
  // from "Bestand übernehmen"/ktm:migrate), so onNoteChanged never calls this
  // in that case at all: "beim Laden entsteht so kein Umzug".
  private static readonly PLACEMENT_FIELDS = ['parent', 'project', 'type', 'status', 'ktm_placement'] as const;

  // 008, Ergänzung 2026-10-25 "Startdatum started": the one place every
  // status change not caught by BoardView#writeDraft (Ziehen, Dropdown,
  // Befehl, ktm:set, eine Änderung von außen — alle laufen durch denselben
  // changed-Hook, wissen #838) runs through, so `started` needs no separate
  // stamp at each of those call sites. `after` missing or without a known
  // status leaves the note untouched, same as settingsLocked (a possibly
  // stale column list must not decide this either way).
  private async stampStartedAfterStatusChange(
    path: string,
    after: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (this.settingsLocked || !after) return;
    if (this.consumeSettingsReassignment(path)) return;
    const status = after.status;
    if (typeof status !== 'string' || !status) return;
    const projects = resolveProjectSettings(this.index.entries()).projects;
    // Frontmatter-project hat Vorrang; fehlt es, zählt die Ablage (008 "bei
    // eingeordneten Elementen aus dem Pfad abgeleitet", Wissen #1232) — sonst
    // gälten für eine eingeordnete Aufgabe ohne project-Feld stillschweigend
    // die allgemeinen statt der Projekteinstellungen.
    const projectKey = normalizeProject(after.project) ?? projectKeyForPath(path, projects);
    const project = projectKey ? projects.find((p) => p.key === projectKey) : undefined;
    const column = resolveColumns(this.settings, project).find(
      (c) => c.status === status || c.aliases?.includes(status),
    );
    if (!column) return;
    const started = typeof after.started === 'string' ? after.started : undefined;
    const completed = typeof after.completed === 'string' ? after.completed : undefined;
    const next = startedAfterStatusChange(column.role ?? 'open', started, completed, this.todayOverride());
    if (next === started || next === undefined) return;
    try {
      await writeFrontmatter(this.app, path, { started: next });
    } catch (err) {
      new Notice(`started konnte nicht gesetzt werden: ${path} (${errorMessage(err)})`, NOTICE_DURATION);
    }
  }

  // Verbraucht eine Markierung aus markSettingsReassignment einmalig (F190).
  private consumeSettingsReassignment(path: string): boolean {
    const marked = this.settingsReassignments.delete(path);
    const timer = this.settingsReassignmentTimers.get(path);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.settingsReassignmentTimers.delete(path);
    }
    return marked;
  }

  private async maybePlaceAfterChange(
    before: Record<string, unknown>,
    after: Record<string, unknown> | undefined,
  ): Promise<void> {
    const changed = KanbanTaskManagerPlugin.PLACEMENT_FIELDS.some((field) => before[field] !== after?.[field]);
    if (!changed) return;
    const id = after?.ktm_id;
    if (typeof id !== 'string' || !id.trim()) return;
    await this.placeElement(id);
  }

  // Projektwechsel nimmt den Parent (011, Ergänzung 2026-10-19): gehört der
  // (noch unveränderte) Parent im frischen Frontmatter zum alten Projekt,
  // gehört er nach dem Wechsel nirgendwohin mehr und wird entfernt — gleich
  // auf welchem Weg `project` geändert wurde (Karte, Entwurf, ktm:set, von
  // Hand, Claude). Ein im selben Schritt neu gesetzter Parent des neuen
  // Projekts bleibt unberührt, ein fehlender Parent ebenso. Ausnahme (011
  // S83, "Root-Grenzfälle"): ein Projektwechsel in ein Projekt ohne
  // `ktm_root` schreibt nur `project`, hier bleibt auch ein Parent des alten
  // Projekts stehen. Returns whether it wrote anything, so the caller can
  // skip its own placement step for this event — the write's own changed
  // event (parent now gone) triggers it.
  private async dropParentFromOldProject(
    path: string,
    oldProject: string | undefined,
    after: Record<string, unknown> | undefined,
  ): Promise<boolean> {
    const parentId = typeof after?.parent === 'string' ? after.parent.trim() : '';
    if (!parentId) return false;
    const { elements, projects } = this.placementElements();
    const newProject = normalizeProject(after?.project);
    const newProjectEntry = newProject ? projects.find((p) => p.key === newProject) : undefined;
    if (newProjectEntry && !newProjectEntry.root.trim()) return false;
    const parent = elements.find((e) => e.id === parentId && !e.invalid && !e.duplicate);
    if (!parent || parent.project !== oldProject) return false;
    try {
      await writeFrontmatter(this.app, path, { parent: null, parent_link: null });
      return true;
    } catch (err) {
      new Notice(`Parent nicht entfernt: ${path} (${errorMessage(err)})`, NOTICE_DURATION);
      return false;
    }
  }

  // Räumt ein `order` ab, das nach einem Statuswechsel ohne Ziehen aus der
  // vorigen Spalte übrig bleibt (003, Ergänzung 2026-10-18 "Spaltenwechsel
  // ohne Ziehen", S37): deckt Karte, Befehl, CLI, Claude und eine Änderung von
  // außen gleichermaßen ab, weil alle denselben changed-Hook durchlaufen (838).
  // `path` als eigene Platzierung gemerkt (BoardView#applyReorder vor einem
  // Drop in eine manuelle Spalte, markOwnPlacement unten) überspringt die
  // Löschung einmalig, auch wenn `order` zufällig unverändert aussieht.
  private async cleanupOrderAfterStatusChange(
    path: string,
    before: Record<string, unknown>,
    after: Record<string, unknown> | undefined,
  ): Promise<void> {
    const ownPlacement = this.ownPlacements.delete(path);
    const timer = this.ownPlacementTimers.get(path);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.ownPlacementTimers.delete(path);
    }
    if (ownPlacement) return;
    if (before.status === after?.status) return;
    if (after?.order === undefined || before.order !== after.order) return;
    try {
      await writeFrontmatter(this.app, path, { order: null });
    } catch (err) {
      new Notice(`order konnte nicht entfernt werden: ${path} (${errorMessage(err)})`, NOTICE_DURATION);
    }
  }

  // BoardView#applyReorder ruft dies vor dem eigentlichen Schreiben auf, wenn
  // ein Drag die Karte in eine manuelle Spalte verschiebt (F127): das dort neu
  // vergebene order ist beabsichtigt, auch wenn es zufällig dem alten
  // entspricht, und darf cleanupOrderAfterStatusChange darum nicht zum Opfer
  // fallen. Verbraucht von cleanupOrderAfterStatusChange selbst; die Frist
  // oben räumt auf, falls das erwartete changed-Ereignis ausbleibt.
  markOwnPlacement(path: string): void {
    this.ownPlacements.add(path);
    const existing = this.ownPlacementTimers.get(path);
    if (existing !== undefined) window.clearTimeout(existing);
    this.ownPlacementTimers.set(
      path,
      window.setTimeout(() => {
        this.ownPlacements.delete(path);
        this.ownPlacementTimers.delete(path);
      }, OWN_PLACEMENT_TIMEOUT),
    );
  }

  // SettingsTab#removeColumn ruft dies vor jedem writeFrontmatter(member,
  // {status: target}) auf (F190, Wissen #1231): verbraucht von
  // stampStartedAfterStatusChange, dieselbe Frist wie markOwnPlacement räumt
  // auf, falls das erwartete changed-Ereignis ausbleibt.
  markSettingsReassignment(path: string): void {
    this.settingsReassignments.add(path);
    const existing = this.settingsReassignmentTimers.get(path);
    if (existing !== undefined) window.clearTimeout(existing);
    this.settingsReassignmentTimers.set(
      path,
      window.setTimeout(() => {
        this.settingsReassignments.delete(path);
        this.settingsReassignmentTimers.delete(path);
      }, OWN_PLACEMENT_TIMEOUT),
    );
  }

  // The `ktm_id: new` placeholder (011 S58): replaced by a fresh, index-unique
  // id, and — missing `created` only — stamped with today. Guarded by the
  // literal value itself, so the write this triggers (another `changed`
  // event, the index already fed above) is a no-op the second time around.
  private async assignNewId(file: TFile, frontmatter: Record<string, unknown> | undefined): Promise<void> {
    if (frontmatter?.ktm_id !== 'new') return;
    const change: Record<string, string> = { ktm_id: newId(this.knownIds()) };
    const created = frontmatter.created;
    if (typeof created !== 'string' || !created.trim()) change.created = this.todayOverride();
    try {
      await writeFrontmatter(this.app, file.path, change);
    } catch (err) {
      new Notice(`Kennung konnte nicht vergeben werden: ${file.path} (${errorMessage(err)})`, NOTICE_DURATION);
    }
  }

  // Once, right after the index's first full build (011 S58): a note that
  // already carried `ktm_id: new` before the plugin ever loaded (written
  // while Obsidian was closed) gets the same treatment as one written live.
  private async assignPendingNewIds(): Promise<void> {
    for (const entry of this.index.entries()) {
      if (entry.frontmatter.ktm_id !== 'new') continue;
      const file = this.app.vault.getFileByPath(entry.path);
      if (file instanceof TFile) await this.assignNewId(file, entry.frontmatter);
    }
  }

  // "Als Aufgabe übernehmen" (011 S64): offered on any markdown note that is
  // not already an element and not a project note.
  private isAdoptable(file: TFile | null): file is TFile {
    if (!file || file.extension !== 'md') return false;
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const hasId = typeof frontmatter?.ktm_id === 'string' && frontmatter.ktm_id.trim() !== '';
    const hasProject = typeof frontmatter?.ktm_project === 'string' && frontmatter.ktm_project.trim() !== '';
    return !hasId && !hasProject;
  }

  // Proposes title/project/status/level (core/create.ts#adoptProposal), lets
  // AdoptDialog confirm or change them, then writes every Pflichtfeld plus
  // `created` in one step — name and location of the note stay untouched
  // (011 S64). Closing the dialog any other way than "Übernehmen" resolves to
  // `null` (ProjectDialog's pattern) and writes nothing.
  private async adoptNote(file: TFile): Promise<void> {
    await this.indexReady;
    const raw = await this.app.vault.cachedRead(file);
    const info = getFrontMatterInfo(raw);
    const body = info.exists ? raw.slice(info.contentStart) : raw;
    const { projects } = resolveProjectSettings(this.index.entries());
    const levelsFor = (project: string) => settingsFor(this.settings, projects.find((p) => p.key === project)).levels;
    const columnsFor = (project: string) =>
      settingsFor(this.settings, projects.find((p) => p.key === project)).columns;
    const proposal = adoptProposal(
      file.path,
      body,
      projects.map((p) => ({ key: p.key, root: p.root })),
      levelsFor,
      columnsFor,
    );
    const dropdownProjects = [{ key: 'intern', name: 'Intern' }, ...projects.map((p) => ({ key: p.key, name: p.name }))];
    const result = await AdoptDialog.ask(this.app, { proposal, projects: dropdownProjects, levelsFor, columnsFor });
    if (!result) return;

    const fields: Record<string, string> = {
      ktm_id: newId(this.knownIds()),
      type: result.type,
      title: yamlScalar(result.title),
      status: result.status,
      project: result.project,
      created: this.todayOverride(),
    };
    try {
      await writeFrontmatter(this.app, file.path, fields, { allowCreate: true });
    } catch (err) {
      new Notice(`Übernehmen fehlgeschlagen: ${file.path} (${errorMessage(err)})`, NOTICE_DURATION);
    }
  }

  private onVaultRename(file: TAbstractFile, oldPath: string): void {
    this.index.renamed(oldPath, file.path);
    this.activeBoard()?.onRename(file.path, oldPath);
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const id = frontmatter?.ktm_id;
    if (typeof id !== 'string' || !id.trim()) return;
    // "parent_link wird mitgepflegt" bei Umbenennen und Verschieben (011,
    // Ergänzung 2026-10-24): läuft erst in flushHandMoved(), nicht mehr hier
    // je Ereignis — ein Ordner-Umzug feuert ein rename je enthaltener Datei,
    // und solange nicht auch die Umbenennungen der Kinder im Index
    // angekommen sind, wäre ein Kind-Pfad hier noch der alte und das
    // Schreiben schlüge mit "Notiz nicht gefunden" fehl.
    this.handMoveBatch.push({ id, oldPath, newPath: file.path });
    if (this.handMoveTimer !== undefined) window.clearTimeout(this.handMoveTimer);
    this.handMoveTimer = window.setTimeout(() => {
      this.handMoveTimer = undefined;
      void this.flushHandMoved();
    }, HAND_MOVE_DEBOUNCE);
  }

  // "Von Hand verschoben" (011, Ergänzung 2026-09-25, erweitert 2026-10-24):
  // a folder move reaches this handler once per file it contains
  // (konventionen.md), collected here for HAND_MOVE_DEBOUNCE so
  // core/placement.ts#handMoved judges the whole batch at once — a child
  // swept along inside its parent's folder must not count on its own.
  // `recentOwnMoves()` (adapters/obsidian.ts#moveElement) tells apart the
  // plugin's own rename from one the user made in the file explorer. The
  // write goes to the id's *current* path from the index, not the batch's
  // own `newPath`: by the time this runs, a folder rename has already
  // relabelled the whole subtree in the index (ElementIndex#renamed), so
  // `latestEntries()` already reflects it; a candidate no longer resolvable
  // (vanished elsewhere in the meantime) is skipped without a notice. Once
  // that is done, every id touched by the batch — not only the ones judged
  // "by hand" — gets its children's `parent_link` synced exactly once, now
  // that every rename in the batch has landed in the index.
  private async flushHandMoved(): Promise<void> {
    const batch = this.handMoveBatch;
    this.handMoveBatch = [];
    const ids = handMoved(batch, recentOwnMoves());
    for (const id of ids) {
      const entry = this.index.latestEntries().find((e) => e.frontmatter.ktm_id === id);
      if (!entry) continue;
      const title = entry.frontmatter.title;
      const label = typeof title === 'string' && title.trim() ? title : entry.path;
      try {
        await writeFrontmatter(this.app, entry.path, { ktm_placement: 'manual' });
        new Notice(`${label}: von Hand verschoben, Ablage steht jetzt auf manuell.`, NOTICE_DURATION);
      } catch (err) {
        new Notice(`Ablage konnte nicht auf manuell gestellt werden: ${entry.path} (${errorMessage(err)})`, NOTICE_DURATION);
      }
    }

    const touchedIds = new Set(batch.map((c) => c.id));
    for (const id of touchedIds) {
      const entry = this.index.latestEntries().find((e) => e.frontmatter.ktm_id === id);
      if (!entry) continue;
      const title = entry.frontmatter.title;
      if (typeof title === 'string') await this.syncChildLinks(id, entry.path, title);
    }
  }

  private onVaultDelete(file: TAbstractFile): void {
    this.index.deleted(file.path);
    // syncGuide trasht die alte Formatnotiz beim Umstieg auf die neue
    // Anleitung (011, Wissen #813): auch dieses Löschen erreicht das Board
    // nicht, aus demselben Grund wie oben (F123 K7).
    if (!OWN_HELPER_NOTES.has(file.path)) this.activeBoard()?.onDelete(file.path);
  }

  // Every settings save (SettingsTab, saveViewState, toggleCollapsedColumn,
  // toggleCollapsedToday) runs through this one override, so none of them
  // needs its own call to keep the guide current (005 addendum 2026-09-20,
  // Wissen #518/#128, 011).
  // 006, Ergänzung 2026-10-19 "Eine unlesbare Einstellungsdatei wird nie
  // überschrieben" (S62): war data.json seit dem Laden kein einziges Mal
  // lesbar (settingsLocked und !hasReadSettingsObject), schreibt dieser
  // Aufruf nichts. this.settings wird auf den geltenden Stand zurückgesetzt
  // (Voreinstellungen plus die nur im Speicher gehaltenen Sitzungswerte, die
  // saveViewState & Co. unabhängig von der Sperre weiter in this.settings
  // halten), damit ein Aufrufer, der vorher ungeprüft this.settings mutiert
  // hat (das SettingsTab-Muster), seine Änderung nicht stehen lässt. Unlesbar
  // *im Betrieb* (hasReadSettingsObject bereits wahr) ist nicht Teil dieser
  // Sperre (Spec-Zuschnitt, siehe contract "ausserhalb").
  async saveData(data: unknown): Promise<void> {
    if (this.settingsLocked && !this.hasReadSettingsObject) {
      new Notice(SETTINGS_CHANGE_BLOCKED_NOTICE, NOTICE_DURATION);
      const { lastView, lastLevel, filters, collapsedColumns, collapsedToday, todayFollows, boardScale } =
        this.settings;
      this.settings = {
        ...DEFAULT_SETTINGS,
        lastView,
        lastLevel,
        filters,
        collapsedColumns,
        collapsedToday,
        todayFollows,
        boardScale,
      };
      this.settingTab?.display();
      return;
    }
    await super.saveData(data);
    this.refreshGuide();
  }

  // Knopf "Voreinstellungen übernehmen" (006, Ergänzung 2026-10-19, S64/S65):
  // nur erreichbar, solange settingsUnreadableSinceLoad gilt. data.json liegt
  // im Konfigurationsordner außerhalb des Vault-Index, Vault.adapter ist hier
  // die dokumentierte Ausnahme (wie adapters/obsidian.ts), weil die
  // Hochsprachen-API (TFile) die Datei nicht erreicht.
  async adoptDefaults(): Promise<void> {
    const dir = this.manifest.dir;
    if (!dir) {
      new Notice('Voreinstellungen übernehmen: Plugin-Ordner nicht ermittelbar.', NOTICE_DURATION);
      return;
    }
    const dataPath = `${dir}/data.json`;
    const bakPath = `${dir}/data.json.bak`;
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(bakPath)) {
      new Notice(`Voreinstellungen übernehmen: ${bakPath} existiert bereits, nichts geändert.`, NOTICE_DURATION);
      return;
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await adapter.readBinary(dataPath);
    } catch (err) {
      new Notice(`Voreinstellungen übernehmen fehlgeschlagen: ${errorMessage(err)}`, NOTICE_DURATION);
      return;
    }
    try {
      await adapter.writeBinary(bakPath, bytes);
    } catch (err) {
      new Notice(`Voreinstellungen übernehmen fehlgeschlagen: ${errorMessage(err)}`, NOTICE_DURATION);
      return;
    }
    await super.saveData({ ...DEFAULT_SETTINGS });
    this.storedSettings = { ...DEFAULT_SETTINGS };
    this.settings = { ...DEFAULT_SETTINGS };
    this.hasReadSettingsObject = true;
    this.settingsLocked = false;
    this.clearUnreadableTimer();
  }

  // S45: die Zeile mit dem Knopf erscheint nur, solange data.json seit dem
  // Laden kein einziges Mal lesbar war (SettingsTab#renderPage).
  get settingsUnreadableSinceLoad(): boolean {
    return this.settingsLocked && !this.hasReadSettingsObject;
  }

  // data.json lies outside the metadataCache; this is the only hook Obsidian
  // fires for an edit made to it from the outside (006 S10).
  async onExternalSettingsChange(): Promise<void> {
    await this.reloadSettings();
    this.rerenderBoard();
    this.refreshGuide();
  }

  // Debounced trigger for syncGuide (011, same triggers/debounce as the
  // retired format note): a burst of project-note or settings changes
  // (several saveData calls, a folder rename touching many project notes)
  // collapses into a single write, well within the two seconds K17/K23 allow
  // (Wissen #359, #637).
  private refreshGuide(): void {
    if (this.guideTimer !== undefined) window.clearTimeout(this.guideTimer);
    this.guideTimer = window.setTimeout(() => {
      this.guideTimer = undefined;
      void this.syncGuideNow();
    }, GUIDE_DEBOUNCE);
  }

  private async syncGuideNow(): Promise<void> {
    await this.indexReady;
    try {
      await syncGuide(this.app, this.currentGuide());
    } catch (err) {
      new Notice(`Anleitung schreiben fehlgeschlagen: ${GUIDE_NOTE_PATH} (${errorMessage(err)})`, NOTICE_DURATION);
    }
  }

  rerenderBoard(): void {
    const board = this.activeBoard();
    if (board) void board.rerender();
  }

  private moveFocusedCard(direction: MoveDirection, checking: boolean): boolean {
    const board = this.activeBoard();
    if (!board) return false;
    if (!checking) void board.moveFocusedCard(direction);
    return true;
  }

  private activeBoard(): BoardView | undefined {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_BOARD)[0]?.view;
    return view instanceof BoardView ? view : undefined;
  }

  // While data.json is unreadable (006, Ergänzung 2026-10-18, K6): the
  // last-used view/level is kept in memory only, nothing is written, so
  // opening or switching the board never overwrites the broken file.
  async saveViewState(view: string, level: ElementType): Promise<void> {
    this.settings.lastView = view;
    this.settings.lastLevel = level;
    if (this.settingsLocked) return;
    await this.saveStoredSettings({ lastView: view, lastLevel: level });
  }

  async toggleCollapsedColumn(view: string, status: string): Promise<void> {
    const map = { ...(this.settings.collapsedColumns ?? {}) };
    const current = map[view] ?? [];
    const next = current.includes(status)
      ? current.filter((slug) => slug !== status)
      : [...current, status];
    if (next.length > 0) map[view] = next;
    else delete map[view];
    this.settings.collapsedColumns = map;
    if (this.settingsLocked) return;
    await this.saveStoredSettings({ collapsedColumns: map });
  }

  isColumnCollapsed(view: string, status: string): boolean {
    return this.settings.collapsedColumns?.[view]?.includes(status) ?? false;
  }

  // Filterfeld-Auswahl je Ansicht (001, Ergänzung 2026-10-18): this.settings
  // vor dem Speichern geschrieben, sonst überschreibt das reloadSettings des
  // folgenden render() die Auswahl (Wissen #128).
  async saveFilter(view: string, ids: readonly string[]): Promise<void> {
    const map = { ...(this.settings.filters ?? {}) };
    if (ids.length > 0) map[view] = [...ids];
    else delete map[view];
    this.settings.filters = map;
    if (this.settingsLocked) return;
    await this.saveStoredSettings({ filters: map });
  }

  // Hervorhebung je Ansicht (001, Ergänzung 2026-10-18 "Hervorheben"):
  // this.settings vor dem Speichern geschrieben, sonst überschreibt das
  // reloadSettings des folgenden render() die Hervorhebung (Wissen #128).
  async saveSpotlight(view: string, id: string | undefined): Promise<void> {
    const map = { ...(this.settings.spotlights ?? {}) };
    if (id) map[view] = id;
    else delete map[view];
    this.settings.spotlights = map;
    if (this.settingsLocked) return;
    await this.saveStoredSettings({ spotlights: map });
  }

  // Gespeicherte Ansichten (001, Ergänzung 2026-10-18 "Gespeicherte
  // Ansichten"): this.settings vor dem Speichern geschrieben, sonst
  // überschreibt das reloadSettings des folgenden render() die Liste
  // (Wissen #128). Anlegen, Umbenennen und Ordnen laufen alle hierüber, mit
  // der schon umgeordneten/umbenannten Liste als Argument.
  // 006, Ergänzung 2026-10-19 (S62): war data.json seit dem Laden kein
  // einziges Mal lesbar, bleibt this.settings.savedViews unangetastet und der
  // Aufruf liefert false (Wissen #957: loadData liefert dann undefined, nie
  // einen Fehler, die Prüfung muss also vor jeder Mutation stehen). Die
  // bloße Laufzeitsperre (Datei war schon lesbar) verhält sich wie bisher:
  // nur im Speicher halten, liefert true.
  async saveSavedViews(list: readonly SavedView[]): Promise<boolean> {
    if (this.settingsUnreadableSinceLoad) {
      new Notice(SETTINGS_CHANGE_BLOCKED_NOTICE, NOTICE_DURATION);
      return false;
    }
    const next = [...list];
    this.settings.savedViews = next;
    if (this.settingsLocked) return true;
    await this.saveStoredSettings({ savedViews: next });
    return true;
  }

  // Löscht eine gespeicherte Ansicht ohne Rückfrage (001 S36): neben
  // savedViews auch ihre Filterauswahl, Hervorhebung, eingeklappten Spalten
  // und den Heute-Bereich-Zustand, sonst stünden verwaiste Einträge unter
  // ihrem (wiederverwendbaren) Schlüssel in data.json. Zeigte lastView auf
  // sie, fällt er auf "all" zurück, wie das Board selbst es tut.
  async deleteSavedView(key: string): Promise<void> {
    const savedViews = (this.settings.savedViews ?? []).filter((v) => v.key !== key);
    this.settings.savedViews = savedViews;
    const filters = { ...(this.settings.filters ?? {}) };
    delete filters[key];
    this.settings.filters = filters;
    const spotlights = { ...(this.settings.spotlights ?? {}) };
    delete spotlights[key];
    this.settings.spotlights = spotlights;
    const collapsedColumns = { ...(this.settings.collapsedColumns ?? {}) };
    delete collapsedColumns[key];
    this.settings.collapsedColumns = collapsedColumns;
    const collapsedToday = { ...(this.settings.collapsedToday ?? {}) };
    delete collapsedToday[key];
    this.settings.collapsedToday = collapsedToday;
    const todayFollows = { ...(this.settings.todayFollows ?? {}) };
    delete todayFollows[key];
    this.settings.todayFollows = todayFollows;
    const wasLastView = this.settings.lastView === key;
    if (wasLastView) this.settings.lastView = 'all';
    if (this.settingsLocked) return;
    await this.saveStoredSettings({
      savedViews,
      filters,
      spotlights,
      collapsedColumns,
      collapsedToday,
      todayFollows,
      ...(wasLastView ? { lastView: 'all' } : {}),
    });
  }

  async toggleCollapsedToday(view: string): Promise<void> {
    const map = { ...(this.settings.collapsedToday ?? {}) };
    if (map[view]) delete map[view];
    else map[view] = true;
    this.settings.collapsedToday = map;
    if (this.settingsLocked) return;
    await this.saveStoredSettings({ collapsedToday: map });
  }

  isTodayCollapsed(view: string): boolean {
    return this.settings.collapsedToday?.[view] ?? false;
  }

  // "Heute folgt der Auswahl" je Ansicht (004, Ergänzung 2026-10-24):
  // this.settings vor dem Speichern geschrieben, sonst überschreibt das
  // reloadSettings des folgenden render() den Schalter (Wissen #128).
  async saveTodayFollows(view: string, on: boolean): Promise<void> {
    const map = { ...(this.settings.todayFollows ?? {}) };
    if (on) map[view] = true;
    else delete map[view];
    this.settings.todayFollows = map;
    if (this.settingsLocked) return;
    await this.saveStoredSettings({ todayFollows: map });
  }

  isTodayFollows(view: string): boolean {
    return this.settings.todayFollows?.[view] ?? false;
  }

  // Reihenfolge der Darstellungs-Icons (012, Ergänzung 2026-10-25
  // "Reihenfolge per Ziehen"): this.settings vor dem Speichern geschrieben,
  // sonst überschreibt das reloadSettings des folgenden render() die
  // Reihenfolge (Wissen #128).
  async saveViewOrder(order: readonly string[]): Promise<void> {
    const next = [...order];
    this.settings.viewOrder = next;
    if (this.settingsLocked) return;
    await this.saveStoredSettings({ viewOrder: next });
  }

  // Gemerkte Darstellung je Ansicht (012, Ergänzung 2026-10-25 "Darstellung
  // für ein Projekt merken"): this.settings vor dem Speichern geschrieben
  // (Wissen #128); einen Eintrag entfernen löscht den Schlüssel, statt ihn zu
  // leeren.
  async saveViewModes(view: string, mode: string | undefined): Promise<void> {
    const map = { ...(this.settings.viewModes ?? {}) };
    if (mode) map[view] = mode;
    else delete map[view];
    this.settings.viewModes = map;
    if (this.settingsLocked) return;
    await this.saveStoredSettings({ viewModes: map });
  }

  // Sortierung des Baums je Ansicht (012, Ergänzung 2026-10-25 "Baum"):
  // this.settings vor dem Speichern geschrieben (Wissen #128, Muster
  // saveViewModes); eine leere Sortierung löscht den Schlüssel der Ansicht.
  async saveTreeSort(view: string, sort: readonly { key: string; dir: 'asc' | 'desc' }[]): Promise<void> {
    const map = { ...(this.settings.treeSort ?? {}) };
    if (sort.length > 0) map[view] = [...sort];
    else delete map[view];
    this.settings.treeSort = map;
    if (this.settingsLocked) return;
    await this.saveStoredSettings({ treeSort: map });
  }

  // Zeitraum und Raster der Roadmap je Ansicht (012, Ergänzung 2026-10-25
  // "Roadmap"): this.settings vor dem Speichern geschrieben (Wissen #128,
  // Muster saveTreeSort).
  async saveRoadmap(view: string, state: { start: string; end: string; grid: string }): Promise<void> {
    const map = { ...(this.settings.roadmap ?? {}) };
    map[view] = state;
    this.settings.roadmap = map;
    if (this.settingsLocked) return;
    await this.saveStoredSettings({ roadmap: map });
  }

  // Board-Größe (001, Ergänzung 2026-10-24): this.settings vor dem Speichern
  // geschrieben, sonst überschreibt das reloadSettings des folgenden render()
  // die Größe (Wissen #128). Wirkt auch ohne offenes Board; rerenderBoard()
  // ist dann ein No-Op (activeBoard() liefert undefined).
  async saveBoardScale(action: 'in' | 'out' | 'reset'): Promise<void> {
    const next = stepBoardScale(normalizeBoardScale(this.settings.boardScale), action);
    this.settings.boardScale = next;
    if (!this.settingsLocked) await this.saveStoredSettings({ boardScale: next });
    this.rerenderBoard();
  }

  // Opens the board from the ribbon icon or the `open-board` command (F059,
  // 006 S34): a fresh leaf gets the configured opening view/level, an
  // existing one is only revealed, its state untouched (K1's second click).
  // `openView` of `last` or unset falls back to the last-used view, exactly
  // as `openLevel` falls back to the last-used level; a value the current
  // project does not offer is caught by BoardView's own normalizeLevel/
  // normalizeView once it renders (wissen #593).
  private async openBoard(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | undefined = workspace.getLeavesOfType(VIEW_TYPE_BOARD)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      const openView = this.settings.openView;
      const view = !openView || openView === 'last' ? this.settings.lastView : openView;
      const level = this.settings.openLevel ?? this.settings.lastLevel;
      const state: Record<string, unknown> = {};
      if (view !== undefined) state.view = view;
      if (level !== undefined) state.level = level;
      await leaf.setViewState({ type: VIEW_TYPE_BOARD, active: true, state });
    }
    await workspace.revealLeaf(leaf);
  }

  onunload(): void {
    if (this.unreadableTimer !== undefined) window.clearTimeout(this.unreadableTimer);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function baseName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

// `BoardElement.project` is already undefined for "intern" (read.ts#common);
// a raw frontmatter value needs the same normalization before the two are
// compared (dropParentFromOldProject, onNoteChanged's own project-change
// check).
function normalizeProject(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw === '' || raw === 'intern' ? undefined : raw;
}

// Fehlt project im Frontmatter, zählt die Ablage (008, Ergänzung 2026-10-25
// "Startdatum started": "bei eingeordneten Elementen aus dem Pfad
// abgeleitet"): der längste passende Projekt-Root, wie adoptProposal
// (core/create.ts) es für "Als Aufgabe übernehmen" schon macht.
function projectKeyForPath(path: string, projects: ProjectSettings[]): string | undefined {
  let key: string | undefined;
  let bestRootLength = -1;
  for (const p of projects) {
    const root = p.root.replace(/\/+$/, '');
    if (!root) continue;
    if ((path === root || path.startsWith(`${root}/`)) && root.length > bestRootLength) {
      key = p.key;
      bestRootLength = root.length;
    }
  }
  return key;
}

// planMigration only fills fields that were missing (011, wissen #686);
// title and parent_link go through yamlScalar since either can carry a
// wikilink or characters YAML would otherwise misread unquoted.
function migrationChange(fields: MigrationFields): Record<string, string> {
  const change: Record<string, string> = { ktm_id: fields.ktm_id };
  if (fields.title !== undefined) change.title = yamlScalar(fields.title);
  if (fields.project !== undefined) change.project = fields.project;
  if (fields.created !== undefined) change.created = fields.created;
  if (fields.parent !== undefined) change.parent = fields.parent;
  if (fields.parent_link !== undefined) change.parent_link = yamlScalar(fields.parent_link);
  if (fields.ktm_placement !== undefined) change.ktm_placement = fields.ktm_placement;
  return change;
}

// planUndo's values are plain, logically-restored text (011, Ergänzung
// 2026-09-25); yamlScalar quotes only where the value would otherwise be
// misread, so wrapping every non-null value here is always safe.
function toWriteChange(change: FrontmatterChange): FrontmatterChange {
  const out: FrontmatterChange = {};
  for (const [key, value] of Object.entries(change)) out[key] = value === null ? null : yamlScalar(value);
  return out;
}
