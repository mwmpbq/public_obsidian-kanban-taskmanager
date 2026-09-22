import { Plugin, type WorkspaceLeaf } from 'obsidian';
import { ensureFormatDoc } from './adapters/obsidian';
import type { ElementType } from './core/model';
import type { MoveDirection } from './core/move';
import type { GeneralSettings } from './core/settings';
import { DEFAULT_TODAY_SORT } from './core/today';
import { BoardView, VIEW_TYPE_BOARD } from './ui/BoardView';
import { KtmSettingTab } from './ui/SettingsTab';

const DEFAULT_SETTINGS: GeneralSettings = {
  columns: ['Backlog', 'Ready', 'Doing', 'Done', "Won't Do"],
  doneColumns: ['Done', "Won't Do"],
  lastView: 'all',
  lastLevel: 'task',
  notifyPlanned: true,
  todaySortOrder: DEFAULT_TODAY_SORT,
};

export default class KanbanTaskManagerPlugin extends Plugin {
  settings: GeneralSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.reloadSettings();

    this.registerView(VIEW_TYPE_BOARD, (leaf) => new BoardView(leaf, this));
    this.addSettingTab(new KtmSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      void ensureFormatDoc(this.app);
    });

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

  // data.json lies outside the metadataCache; this is the only hook Obsidian
  // fires for an edit made to it from the outside (006 S10).
  async onExternalSettingsChange(): Promise<void> {
    await this.reloadSettings();
    this.rerenderBoard();
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

  private async openBoard(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | undefined = workspace.getLeavesOfType(VIEW_TYPE_BOARD)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE_BOARD, active: true });
    }
    await workspace.revealLeaf(leaf);
  }
}
