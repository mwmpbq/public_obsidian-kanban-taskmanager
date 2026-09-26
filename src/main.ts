import { type CachedMetadata, getFrontMatterInfo, Notice, Plugin, type TAbstractFile, TFile, TFolder, type WorkspaceLeaf } from 'obsidian';
import {
  appendLlmLink,
  countLegacyCandidates,
  createNote,
  latestMigrationProtocol,
  legacyEntries,
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
import { adoptProposal, atomicNotePath, nestedPaths, noteContent } from './core/create';
import { todayISO } from './core/dates';
import { GUIDE_NOTE_PATH, renderGuide } from './core/guide';
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
import type { MoveDirection } from './core/move';
import {
  computedLocation,
  currentLocation,
  handMoved,
  type HandMoveCandidate,
  placementFindings,
  type PlacementProject,
} from './core/placement';
import { readElements } from './core/read';
import {
  bottomLevel,
  resolveColumns,
  resolveProjectSettings,
  settingsFor,
  statusClosure,
  withoutHiddenProjects,
  type GeneralSettings,
} from './core/settings';
import { DEFAULT_TODAY_SORT } from './core/today';
import { ElementIndex } from './core/vault-index';

const GUIDE_DEBOUNCE = 300;
const NOTICE_DURATION = 15000;
const HAND_MOVE_DEBOUNCE = 300;
import { BoardView, type KtmWindow, VIEW_TYPE_BOARD } from './ui/BoardView';
import { AdoptDialog } from './ui/AdoptDialog';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { KtmSettingTab } from './ui/SettingsTab';

const DEFAULT_SETTINGS: GeneralSettings = {
  columns: [
    { key: 'backlog', name: 'Backlog' },
    { key: 'ready', name: 'Ready' },
    { key: 'doing', name: 'Doing' },
    { key: 'done', name: 'Done' },
    { key: 'wont-do', name: "Won't Do" },
  ],
  lastView: 'all',
  lastLevel: 'task',
  notifyPlanned: true,
  todaySortOrder: DEFAULT_TODAY_SORT,
};

export default class KanbanTaskManagerPlugin extends Plugin {
  settings: GeneralSettings = DEFAULT_SETTINGS;
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

  async onload(): Promise<void> {
    await this.reloadSettings();

    this.index = new ElementIndex(obsidianFileSource(this.app));
    this.indexReady = this.buildIndex().then(() => this.assignPendingNewIds());

    this.registerView(VIEW_TYPE_BOARD, (leaf) => new BoardView(leaf, this));
    this.addSettingTab(new KtmSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.refreshGuide();
      // Projektnotizen tragen ktm_project im Frontmatter; nur ein Wechsel
      // dort verändert die Ebenen, Spalten oder Verknüpfungsfelder, die Teil 2
      // der Anleitung zeigt. Der dritte Parameter ist der frische Cache (kein
      // vault.on('modify')); die Guide-Notiz selbst trägt kein ktm_project,
      // eine Rückkopplung entsteht also nicht (005 addendum 2026-09-20, 011).
      this.registerEvent(
        this.app.metadataCache.on('changed', (file, _data, cache) => {
          void this.onNoteChanged(file, cache);
          if (cache.frontmatter?.ktm_project !== undefined) this.refreshGuide();
        }),
      );
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onVaultRename(file, oldPath)));
      this.registerEvent(this.app.vault.on('delete', (file) => this.onVaultDelete(file)));
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
        (el) => this.isDoneForPlacement(el),
      );
      const lines = findings.map((f) => `${f.path}: ${f.reason}`);
      lines.push(`ktm:check ${findings.length} Befunde`);
      return lines.join('\n');
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
      new Notice(`LLM-Verweis einrichten fehlgeschlagen: ${errorMessage(err)}`, NOTICE_DURATION);
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
  private isDoneForPlacement(el: BoardElement): boolean | undefined {
    if (!(this.settings.moveDoneToFolder ?? true)) return false;
    const project = el.project
      ? resolveProjectSettings(this.index.entries()).projects.find((p) => p.key === el.project)
      : undefined;
    return statusClosure(el.status, resolveColumns(this.settings, project));
  }

  // Moves `id` to its computedLocation, if it has one and isn't already there
  // (011, Ergänzung 2026-09-25, "placeElement"): the one place every
  // interactive and CLI path funnels through. Returns the note's path after
  // the move (or its unchanged path when nothing moved), `undefined` when
  // there is nothing to do or the move failed (a Notice already shown).
  async placeElement(id: string): Promise<string | undefined> {
    await this.indexReady;
    const { elements, projects } = this.placementElements();
    const element = elements.find((e) => e.id === id);
    if (!element) return undefined;
    const target = computedLocation(element, elements, projects, (el) => this.isDoneForPlacement(el));
    if (!target) return undefined;
    const current = currentLocation(element, elements, projects);
    if (target === current) return element.paths.note;
    // A folder target that already exists is not "belegt": adapters/
    // obsidian.ts#moveElement merges into it (a pre-existing Done mirror
    // seeded by an earlier sibling, 011 S95/K45-K47). Only a bare note target
    // (an atomic element) can truly collide, and only then is it skipped
    // with a notice instead of trying and failing inside moveElement.
    if (element.form === 'atomic' && this.app.vault.getAbstractFileByPath(target)) {
      new Notice(`Ablage übersprungen, Ziel belegt: ${target}`, NOTICE_DURATION);
      return undefined;
    }
    const parentDir = dirOf(target);
    const toNotePath = element.form === 'atomic' ? target : `${target}/${baseName(element.paths.note)}`;
    const board = this.activeBoard();
    const run = (): Promise<void> => moveElement(this.app, current, target, parentDir);
    try {
      if (board) await board.runReconciling(run);
      else await run();
      return toNotePath;
    } catch (err) {
      // 011 S92/K34: a failed move (a locked file, say) leaves the note
      // untouched beyond `parent`, byte-for-byte — no implicit `ktm_placement`
      // write. element.placement is already known not to be 'manual' here
      // (computedLocation's own early check), so the note stays eligible for
      // the next attempt without any extra field.
      new Notice(`Ablage übersprungen: ${current} → ${target} (${errorMessage(err)})`, NOTICE_DURATION);
      return undefined;
    }
  }

  // "An berechneten Ort verschieben" (011 K41): every auto element
  // placementFindings names as not at its computed location, moved one by
  // one through the same placeElement every other path uses.
  private async runMoveToComputedCommand(): Promise<void> {
    await this.indexReady;
    const { elements, projects } = this.placementElements();
    const findings = placementFindings(elements, projects, (el) => this.isDoneForPlacement(el));
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
      throw new Error(`${prefix}: unbekanntes Projekt „${params.project}“.`);
    }

    const projectSettings = resolveProjectSettings(this.index.entries()).projects.find((p) => p.key === project);
    const levels = settingsFor(this.settings, projectSettings).levels;
    const type = params.type ?? defaults.type;
    if (params.type !== undefined && !levels.some((l) => l.key === params.type)) {
      throw new Error(`${prefix}: unbekannte Ebene „${params.type}“.`);
    }

    const columns = resolveColumns(this.settings, projectSettings);
    const status = params.status ?? defaults.status;
    if (params.status !== undefined) {
      const known = columns.some((c) => c.status === params.status) || params.status === 'done' || params.status === 'wont-do';
      if (!known) throw new Error(`${prefix}: unbekannter Status „${params.status}“.`);
    }

    let parent: BoardElement | undefined;
    if (params.parent !== undefined && params.parent !== '') {
      // Only among valid, non-duplicate elements (F090 Fund): `elements`
      // still carries the invalid copy of a duplicate id alongside the kept
      // winner, and readElements lists it first — an unfiltered find would
      // resolve the parent to that copy, whose `type` no longer reflects the
      // real hierarchy.
      const found = elements.find((e) => e.id === params.parent && !e.invalid && !e.duplicate);
      if (!found) throw new Error(`${prefix}: unbekannter Parent „${params.parent}“.`);
      const targetIdx = levels.findIndex((l) => l.key === type);
      const parentIdx = levels.findIndex((l) => l.key === found.type);
      if (parentIdx === -1 || targetIdx === -1 || parentIdx >= targetIdx) {
        throw new Error(`${prefix}: Parent „${params.parent}“ liegt auf gleicher oder tieferer Ebene.`);
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
        if (link) change.parent_link = link;
      }
    }

    if (params.placement !== undefined) {
      if (params.placement !== 'auto' && params.placement !== 'manual') {
        throw new Error(`ktm:set: ungültiger Wert für placement „${params.placement}“.`);
      }
      change.ktm_placement = params.placement;
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
    const title = params.title?.trim();
    if (!title) throw new Error('ktm:create: title fehlt.');
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

    for (const [key, value] of [
      ['due', params.due],
      ['planned', params.planned],
    ] as const) {
      if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`ktm:create: ungültiges Datum bei ${key} „${value}“.`);
      }
    }
    if (params.priority !== undefined) {
      const priority = Number(params.priority);
      if (!Number.isInteger(priority) || priority < 1 || priority > 4) {
        throw new Error(`ktm:create: ungültige Priorität „${params.priority}“.`);
      }
    }

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
  // general settings outside the app, without keeping a live watcher.
  async reloadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<GeneralSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
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
  private buildIndex(): Promise<void> {
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
  private buildIndexNow(): Promise<void> {
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

  // The vault's own three sources of change (011 S61), always kept exactly
  // in this order: the index is fed first, so the board's own hook — called
  // right after — already sees the fresh entry when it recomputes anything
  // in memory (retargetDetail).
  private async onNoteChanged(file: TAbstractFile, cache: CachedMetadata): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    const before = this.index.get(file.path);
    await this.index.changed(file.path, cache.frontmatter);
    await this.assignNewId(file, cache.frontmatter);
    this.activeBoard()?.onNoteChanged(file.path, cache);
    if (before) void this.maybePlaceAfterChange(before.frontmatter, cache.frontmatter);
    if (before && before.frontmatter.title !== cache.frontmatter?.title) {
      const id = cache.frontmatter?.ktm_id;
      const title = cache.frontmatter?.title;
      if (typeof id === 'string' && id.trim() && typeof title === 'string') {
        void this.syncChildLinks(id, file.path, title);
      }
    }
  }

  // "parent_link wird mitgepflegt" (011, Ergänzung 2026-09-25): every child
  // whose `parent` names this element and that already carries a
  // `parent_link` gets it rewritten to the (possibly just renamed or moved)
  // parent note, with its current title as alias — without asking, since the
  // value belongs to the plugin (`parent` itself never changes). A child
  // without `parent_link` never gets one (ausserhalb, F090).
  private async syncChildLinks(parentId: string, parentNotePath: string, parentTitle: string): Promise<void> {
    for (const entry of this.index.entries()) {
      if (entry.frontmatter.parent !== parentId) continue;
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
    // Ergänzung 2026-09-25): läuft für jede Umbenennung dieser Notiz, egal ob
    // Obsidian das später als "von Hand verschoben" wertet oder nicht — die
    // Kinder sollen dem tatsächlichen Pfad folgen, unabhängig davon.
    const title = frontmatter?.title;
    if (typeof title === 'string') void this.syncChildLinks(id, file.path, title);
    this.handMoveBatch.push({ id, oldPath, newPath: file.path });
    if (this.handMoveTimer !== undefined) window.clearTimeout(this.handMoveTimer);
    this.handMoveTimer = window.setTimeout(() => {
      this.handMoveTimer = undefined;
      void this.flushHandMoved();
    }, HAND_MOVE_DEBOUNCE);
  }

  // "Von Hand verschoben" (011, Ergänzung 2026-09-25): a folder move reaches
  // this handler once per file it contains (konventionen.md), collected here
  // for HAND_MOVE_DEBOUNCE so core/placement.ts#handMoved judges the whole
  // batch at once — a child swept along inside its parent's folder must not
  // count on its own. `recentOwnMoves()` (adapters/obsidian.ts#moveElement)
  // tells apart the plugin's own rename from one the user made in the file
  // explorer.
  private async flushHandMoved(): Promise<void> {
    const batch = this.handMoveBatch;
    this.handMoveBatch = [];
    const ids = handMoved(batch, recentOwnMoves());
    for (const id of ids) {
      const candidate = batch.find((c) => c.id === id);
      if (!candidate) continue;
      const file = this.app.vault.getFileByPath(candidate.newPath);
      const title = file ? this.app.metadataCache.getFileCache(file)?.frontmatter?.title : undefined;
      const label = typeof title === 'string' && title.trim() ? title : candidate.newPath;
      try {
        await writeFrontmatter(this.app, candidate.newPath, { ktm_placement: 'manual' });
        new Notice(`${label}: von Hand verschoben, Ablage steht jetzt auf manuell.`, NOTICE_DURATION);
      } catch (err) {
        new Notice(`Ablage konnte nicht auf manuell gestellt werden: ${candidate.newPath} (${errorMessage(err)})`, NOTICE_DURATION);
      }
    }
  }

  private onVaultDelete(file: TAbstractFile): void {
    this.index.deleted(file.path);
    this.activeBoard()?.onDelete(file.path);
  }

  // Every settings save (SettingsTab, saveViewState, toggleCollapsedColumn,
  // toggleCollapsedToday) runs through this one override, so none of them
  // needs its own call to keep the guide current (005 addendum 2026-09-20,
  // Wissen #518/#128, 011): saveData always writes settings before this
  // returns, so a following render sees them, exactly like before.
  async saveData(data: unknown): Promise<void> {
    await super.saveData(data);
    this.refreshGuide();
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
    await syncGuide(this.app, this.currentGuide());
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

  async saveViewState(view: string, level: ElementType): Promise<void> {
    this.settings.lastView = view;
    this.settings.lastLevel = level;
    await this.saveData(this.settings);
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
    await this.saveData(this.settings);
  }

  isColumnCollapsed(view: string, status: string): boolean {
    return this.settings.collapsedColumns?.[view]?.includes(status) ?? false;
  }

  async toggleCollapsedToday(view: string): Promise<void> {
    const map = { ...(this.settings.collapsedToday ?? {}) };
    if (map[view]) delete map[view];
    else map[view] = true;
    this.settings.collapsedToday = map;
    await this.saveData(this.settings);
  }

  isTodayCollapsed(view: string): boolean {
    return this.settings.collapsedToday?.[view] ?? false;
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
