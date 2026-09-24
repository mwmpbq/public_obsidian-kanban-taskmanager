import { Plugin, type WorkspaceLeaf } from 'obsidian';
import { readVault, syncFormatDoc } from './adapters/obsidian';
import { renderLevelSection } from './core/format-doc';
import type { ElementType } from './core/model';
import type { MoveDirection } from './core/move';
import { resolveProjectSettings, type GeneralSettings } from './core/settings';
import { DEFAULT_TODAY_SORT } from './core/today';

const FORMAT_DOC_DEBOUNCE = 300;
import { BoardView, VIEW_TYPE_BOARD } from './ui/BoardView';
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
  private formatDocTimer?: number;

  async onload(): Promise<void> {
    await this.reloadSettings();

    this.registerView(VIEW_TYPE_BOARD, (leaf) => new BoardView(leaf, this));
    this.addSettingTab(new KtmSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.refreshFormatDoc();
      // Projektnotizen tragen ktm_project im Frontmatter; nur ein Wechsel
      // dort verändert die Ebenen oder Verknüpfungsfelder, die der Abschnitt
      // zeigt. Der dritte Parameter ist der frische Cache (kein
      // vault.on('modify')); die Formatnotiz selbst trägt kein ktm_project,
      // eine Rückkopplung entsteht also nicht (005 addendum 2026-09-20).
      this.registerEvent(
        this.app.metadataCache.on('changed', (_file, _data, cache) => {
          if (cache.frontmatter?.ktm_project !== undefined) this.refreshFormatDoc();
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
  }

  // Re-reads data.json from disk so a render picks up an edit made to the
  // general settings outside the app, without keeping a live watcher.
  async reloadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<GeneralSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  }

  // Every settings save (SettingsTab, saveViewState, toggleCollapsedColumn,
  // toggleCollapsedToday) runs through this one override, so none of them
  // needs its own call to keep the format description current (005 addendum
  // 2026-09-20, Wissen #518/#128): saveData always writes settings before
  // this returns, so a following render sees them, exactly like before.
  async saveData(data: unknown): Promise<void> {
    await super.saveData(data);
    this.refreshFormatDoc();
  }

  // data.json lies outside the metadataCache; this is the only hook Obsidian
  // fires for an edit made to it from the outside (006 S10).
  async onExternalSettingsChange(): Promise<void> {
    await this.reloadSettings();
    this.rerenderBoard();
    this.refreshFormatDoc();
  }

  // Debounced trigger for syncFormatDoc: a burst of project-note or settings
  // changes (several saveData calls, a folder rename touching many project
  // notes) collapses into a single write, well within the two seconds K2-K4
  // allow (Wissen #359).
  private refreshFormatDoc(): void {
    if (this.formatDocTimer !== undefined) window.clearTimeout(this.formatDocTimer);
    this.formatDocTimer = window.setTimeout(() => {
      this.formatDocTimer = undefined;
      void this.syncFormatDocNow();
    }, FORMAT_DOC_DEBOUNCE);
  }

  private async syncFormatDocNow(): Promise<void> {
    const { entries } = await readVault(this.app);
    const { projects } = resolveProjectSettings(entries);
    const section = renderLevelSection(this.settings, projects);
    await syncFormatDoc(this.app, section);
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
