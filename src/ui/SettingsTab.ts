import { type App, Notice, PluginSettingTab, Setting, TFile, getIconIds, setIcon } from 'obsidian';
import { readVault } from '../adapters/obsidian';
import type { FileEntry } from '../core/model';
import {
  CARD_FIELDS,
  type CardField,
  chipLevelLabel,
  DEFAULT_LEVELS,
  type Level,
  type LinkKind,
  type ProjectSettings,
  resolveCardFields,
  resolveLevels,
  resolveLinkKinds,
  resolveProjectSettings,
} from '../core/settings';
import type KanbanTaskManagerPlugin from '../main';

const NOTICE_DURATION = 6000;
const VIEW_ALL = 'all';
const VIEW_INTERNAL = 'internal';

const CARD_FIELD_LABELS: Record<CardField, string> = {
  ticket: 'Ticket-Nummer',
  planned: 'Geplant',
  due: 'Fällig',
  checklist: 'Abhakpunkte',
  priority: 'Priorität',
  project: 'Projekt',
  parents: 'Epic und Feature',
  tags: 'Tags',
};

const NEW_LINK_KIND: LinkKind = { key: '', label: '', icon: 'file-text' };

// Internal is synthetic: there is neither a card.project nor a project note
// for that (wissen 390, 555). Root and note path are convention, modeled on
// the pattern of real projects (note lies in the root's parent folder), not
// derived from data.
const INTERN_ROOT = '03_Areas/Internal/Deliverables';
const INTERN_NOTE_PATH = '03_Areas/Internal/_Kanban.md';

// The refile paths hardwired in core (core/create.ts), mirrored here only
// as a display fallback: empty stays empty in data.json until someone
// types.
const ATOMIC_FOLDER_DEFAULT = '_Tasks/Atomic';
const NOTES_FOLDER_DEFAULT = '_Tasks/Notes';

// The seven sections in fixed order (006 addendum 2026-09-20, K1). The jump
// chip and the h3 heading carry different text ("Heute" vs. "Bereich Heute",
// per the mockup), so both are named here rather than derived from one.
const SECTIONS: Array<{ jump: string; heading: string }> = [
  { jump: 'Projekte & Ablage', heading: 'Projekte & Ablage' },
  { jump: 'Board', heading: 'Board' },
  { jump: 'Heute', heading: 'Bereich Heute' },
  { jump: 'Karte, geschlossen', heading: 'Karte, geschlossen' },
  { jump: 'Karte, geöffnet', heading: 'Karte, geöffnet' },
  { jump: 'Verknüpfungsarten', heading: 'Verknüpfungsarten' },
  { jump: 'Ebenen', heading: 'Ebenen' },
];

export class KtmSettingTab extends PluginSettingTab {
  private readonly plugin: KanbanTaskManagerPlugin;
  private linkKinds: LinkKind[] = [];
  private levels: Level[] = [];
  private levelEntries: FileEntry[] = [];
  private projects: ProjectSettings[] = [];
  private iconCatalogEl?: HTMLElement;
  private closeIconCatalogListener?: () => void;

  constructor(app: App, plugin: KanbanTaskManagerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.closeIconCatalog();
    void this.renderPage();
  }

  hide(): void {
    this.closeIconCatalog();
  }

  // Fire-and-forget (wissen: MarkdownRenderer-Musters): only the project list
  // (section 1) needs a vault read, everything before it is built
  // synchronously first so the section order in the DOM never depends on when
  // the read settles.
  private async renderPage(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();
    const root = containerEl.createDiv({ cls: 'ktm-settings' });
    root.createEl('h2', { text: 'Kanban-Taskmanager' });
    this.renderScope(root);

    const headingByJump = new Map<string, HTMLElement>();
    this.renderJumpBar(root, headingByJump);

    const { entries } = await readVault(this.app);
    this.levelEntries = entries;
    this.projects = resolveProjectSettings(entries).projects;

    headingByJump.set(SECTIONS[0].jump, root.createEl('h3', { text: SECTIONS[0].heading }));
    this.renderProjectsSection(root);

    headingByJump.set(SECTIONS[1].jump, root.createEl('h3', { text: SECTIONS[1].heading }));
    this.renderBoardSection(root);

    headingByJump.set(SECTIONS[2].jump, root.createEl('h3', { text: SECTIONS[2].heading }));

    headingByJump.set(SECTIONS[3].jump, root.createEl('h3', { text: SECTIONS[3].heading }));
    this.renderCardClosedSection(root);

    headingByJump.set(SECTIONS[4].jump, root.createEl('h3', { text: SECTIONS[4].heading }));

    headingByJump.set(SECTIONS[5].jump, root.createEl('h3', { text: SECTIONS[5].heading }));
    this.renderLinkKindsSection(root);

    headingByJump.set(SECTIONS[6].jump, root.createEl('h3', { text: SECTIONS[6].heading }));
    this.renderLevelsSection(root);
  }

  // "Gilt für": General writes data.json (006 addendum 2026-09-20). The
  // project mode (default/own/general-only per row) is stage 1 and
  // lies outside this package; the dropdown therefore offers only the one
  // option it also serves.
  private renderScope(container: HTMLElement): void {
    const scope = container.createDiv({ cls: 'ktm-scope' });
    scope.createSpan({ cls: 'ktm-label', text: 'Gilt für' });
    const select = scope.createEl('select', { cls: 'dropdown' });
    select.createEl('option', { value: 'general', text: 'Allgemein' });
    select.value = 'general';
    scope.createSpan({
      cls: 'ktm-scope-hint',
      text: 'Schreibt data.json. Projekte erben, was sie nicht selbst setzen.',
    });
  }

  private renderJumpBar(container: HTMLElement, headingByJump: Map<string, HTMLElement>): void {
    const jump = container.createDiv({ cls: 'ktm-jump' });
    for (const section of SECTIONS) {
      const chip = jump.createSpan({ text: section.jump });
      chip.addEventListener('click', () => {
        headingByJump.get(section.jump)?.scrollIntoView({ block: 'start' });
      });
    }
  }

  // Projects from readVault + resolveProjectSettings (006 S1-S8), only
  // rendered: "Projekt anlegen" is display without function (stage 1,
  // outside this package), the jump to the project note is functional.
  private renderProjectsSection(container: HTMLElement): void {
    new Setting(container)
      .setName('Projekte')
      .setDesc(
        'Erkannt an Notizen mit ktm_project. Alles, was ein Projekt überschreibt, steht in seiner Notiz.',
      );

    const list = container.createDiv({ cls: 'ktm-orderlist' });
    this.renderProjectRow(list, 'Intern', 'intern', INTERN_ROOT, INTERN_NOTE_PATH);
    for (const project of this.projects) {
      this.renderProjectRow(list, project.name, project.key, project.root, project.path);
    }

    const addRow = container.createSpan({ cls: 'ktm-addrow' });
    setIcon(addRow.createSpan(), 'plus');
    addRow.createSpan({ text: 'Projekt anlegen' });

    new Setting(container)
      .setName('Standardspalten')
      .setDesc('Gilt für Projekte ohne eigene ktm_columns.')
      .addText((text) => {
        text.inputEl.addClass('ktm-textinput');
        text.setValue(this.plugin.settings.columns.join(', ')).onChange(async (value) => {
          this.plugin.settings.columns = splitList(value);
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.rerenderBoard();
        });
      });

    new Setting(container)
      .setName('Abgeschlossene Spalten')
      .setDesc('Karten dieser Spalten wandern in den Done/-Spiegel.')
      .addText((text) => {
        text.inputEl.addClass('ktm-textinput');
        text.setValue(this.plugin.settings.doneColumns.join(', ')).onChange(async (value) => {
          this.plugin.settings.doneColumns = splitList(value);
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.rerenderBoard();
        });
      });

    new Setting(container).setName('Ordner für atomare Aufgaben').addText((text) => {
      text.inputEl.addClass('ktm-textinput', 'is-mono');
      text.setValue(this.plugin.settings.atomicFolder ?? ATOMIC_FOLDER_DEFAULT).onChange(async (value) => {
        this.plugin.settings.atomicFolder = value || undefined;
        await this.plugin.saveData(this.plugin.settings);
      });
    });

    new Setting(container)
      .setName('Ordner für Notizen atomarer Aufgaben')
      .setDesc('Neue Notizen und ADRs aus einer atomaren Karte landen hier.')
      .addText((text) => {
        text.inputEl.addClass('ktm-textinput', 'is-mono');
        text.setValue(this.plugin.settings.notesFolder ?? NOTES_FOLDER_DEFAULT).onChange(async (value) => {
          this.plugin.settings.notesFolder = value || undefined;
          await this.plugin.saveData(this.plugin.settings);
        });
      });
  }

  // One row of the project list, shared for Internal (synthetic, no own
  // entry in this.projects, wissen 390/555) and the real projects from
  // resolveProjectSettings. Click opens the note if present, otherwise
  // no-op.
  private renderProjectRow(list: HTMLElement, name: string, key: string, root: string, notePath: string): void {
    const row = list.createDiv({ cls: 'ktm-orderrow' });
    setIcon(row.createSpan({ cls: 'ico' }), 'folder');
    row.createSpan({ cls: 'nm', text: `${name} ` }).createSpan({ cls: 'key', text: key });
    row.createSpan({ cls: 'key is-wide', text: root });
    const jumpButton = row.createEl('button', { cls: 'ktm-button' });
    setIcon(jumpButton.createSpan(), 'file-text');
    jumpButton.createSpan({ text: notePath.split('/').pop() ?? notePath });
    jumpButton.addEventListener('click', () => {
      const file = this.app.vault.getAbstractFileByPath(notePath);
      if (file instanceof TFile) void this.app.workspace.getLeaf('tab').openFile(file);
    });
  }

  // Each control persists its own key; the effect of
  // ribbon/openView/openLevel/expandedWidthFactor is its own package (stage 1,
  // outside), only writing happens here.
  private renderBoardSection(container: HTMLElement): void {
    new Setting(container)
      .setName('Symbol in der Seitenleiste')
      .setDesc('Ein Klick öffnet das Board oder holt es nach vorn.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.ribbon ?? true).onChange(async (value) => {
          this.plugin.settings.ribbon = value;
          await this.plugin.saveData(this.plugin.settings);
        }),
      );

    new Setting(container).setName('Ansicht beim Öffnen').addDropdown((dropdown) => {
      dropdown.addOption('last', 'Zuletzt benutzt');
      dropdown.addOption(VIEW_ALL, 'Alle Aufgaben');
      dropdown.addOption(VIEW_INTERNAL, 'Intern');
      for (const project of this.projects) dropdown.addOption(project.key, project.name);
      dropdown.setValue(this.plugin.settings.openView ?? 'last');
      dropdown.onChange(async (value) => {
        this.plugin.settings.openView = value;
        await this.plugin.saveData(this.plugin.settings);
      });
    });

    const levels = resolveLevels(this.plugin.settings);
    new Setting(container).setName('Ebene beim Öffnen').addDropdown((dropdown) => {
      for (const level of levels) dropdown.addOption(level.key, level.name);
      dropdown.setValue(this.plugin.settings.openLevel ?? levels[levels.length - 1]?.key ?? '');
      dropdown.onChange(async (value) => {
        this.plugin.settings.openLevel = value;
        await this.plugin.saveData(this.plugin.settings);
      });
    });

    new Setting(container)
      .setName('Ebenen in der Ansicht „Alle“')
      .setDesc(
        'Projekte können eigene Ebenen haben. Nach Rang von unten: der Ebenen-Schalter zeigt die allgemeine Liste, eine Karte erscheint auf der Ebene mit demselben Abstand zur untersten. Nur unterste Ebene: der Schalter entfällt in „Alle“.',
      )
      .addDropdown((dropdown) => {
        dropdown.addOption('rank', 'Nach Rang von unten');
        dropdown.addOption('bottom', 'Nur unterste Ebene');
        dropdown.setValue(this.plugin.settings.allLevels ?? 'rank');
        dropdown.onChange(async (value) => {
          this.plugin.settings.allLevels = value as 'rank' | 'bottom';
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.rerenderBoard();
        });
      });

    new Setting(container)
      .setName('Done-Spalte begrenzen')
      .setDesc('Zeigt nur die zuletzt abgeschlossenen Karten. 0 zeigt alle.')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.addClass('ktm-textinput', 'is-num');
        text.setValue(String(this.plugin.settings.doneLimit ?? 0)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.doneLimit = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.rerenderBoard();
        });
      })
      .controlEl.createSpan({ cls: 'ktm-label', text: 'Karten' });

    new Setting(container)
      .setName('Breite der vergrößerten Karte')
      .setDesc('Vielfaches der Spaltenbreite, höchstens zwei Drittel des Boards.')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.addClass('ktm-textinput', 'is-num');
        text.setValue(String(this.plugin.settings.expandedWidthFactor ?? 3)).onChange(async (value) => {
          const parsed = Number.parseFloat(value);
          this.plugin.settings.expandedWidthFactor = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
          await this.plugin.saveData(this.plugin.settings);
        });
      });
  }

  // The existing card-field toggles (F040) remain unchanged under
  // this heading; the ordered list with preview (S31) is stage 1 and
  // outside this package. New is only the row "Kurzname in
  // <Ebenen>-Chips" (S19/K3), whose label follows the level names.
  private renderCardClosedSection(container: HTMLElement): void {
    const enabled = resolveCardFields(this.plugin.settings);
    for (const field of CARD_FIELDS) {
      const setting = new Setting(container)
        .setName(CARD_FIELD_LABELS[field])
        .addToggle((toggle) =>
          toggle.setValue(enabled.includes(field)).onChange(async (value) => {
            await this.setCardField(field, value);
          }),
        );
      setting.settingEl.setAttribute('data-card-field', field);
    }

    const levels = resolveLevels(this.plugin.settings);
    new Setting(container)
      .setName(chipLevelLabel(levels))
      .setDesc('Zeigt „short“ statt des Titels, wenn gesetzt.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.shortInChips ?? true).onChange(async (value) => {
          this.plugin.settings.shortInChips = value;
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.rerenderBoard();
        }),
      );
  }

  private renderLinkKindsSection(container: HTMLElement): void {
    const stored = this.plugin.settings.linkKinds;
    this.linkKinds =
      stored && stored.length > 0 ? stored.map((kind) => ({ ...kind })) : resolveLinkKinds().map((kind) => ({ ...kind }));
    for (let index = 0; index < this.linkKinds.length; index += 1) {
      this.renderLinkKindRow(container, index);
    }
    new Setting(container).addButton((button) =>
      button.setButtonText('Verknüpfungsart hinzufügen').onClick(() => {
        void this.persistLinkKinds([...this.linkKinds, { ...NEW_LINK_KIND }], { redraw: true });
      }),
    );
  }

  private renderLinkKindRow(containerEl: HTMLElement, index: number): void {
    const kind = this.linkKinds[index];
    const row = new Setting(containerEl);
    row.settingEl.setAttribute('data-link-kind', kind.key);

    row.addExtraButton((handle) => {
      handle.setIcon('grip-vertical');
      handle.setTooltip('Ziehen zum Umsortieren');
      this.registerDragHandle(handle.extraSettingsEl, kind.key, (dropY) =>
        this.reorderLinkKinds(kind.key, dropY),
      );
    });

    row.addExtraButton((iconButton) => {
      iconButton.setIcon(kind.icon);
      iconButton.setTooltip('Icon wählen');
      iconButton.onClick(() => {
        this.openIconCatalog(iconButton.extraSettingsEl, kind.icon, (icon) => {
          const next = this.linkKinds.map((k, i) => (i === index ? { ...k, icon } : k));
          void this.persistLinkKinds(next, { redraw: true });
        });
      });
    });

    row.addText((text) => {
      text
        .setPlaceholder('Name')
        .setValue(kind.label)
        .onChange((value) => {
          this.updateLinkKind(index, { label: value });
        });
    });

    row.addText((text) => {
      text
        .setPlaceholder('Feld')
        .setValue(kind.key)
        .onChange((value) => {
          row.settingEl.setAttribute('data-link-kind', value);
          this.updateLinkKind(index, { key: value });
        });
    });

    row.addText((text) => {
      text
        .setPlaceholder('Präfix (optional)')
        .setValue(kind.prefix ?? '')
        .onChange((value) => {
          this.updateLinkKind(index, { prefix: value || undefined });
        });
    });

    row.addExtraButton((remove) => {
      remove.setIcon('x');
      remove.setTooltip('Entfernen');
      remove.onClick(() => {
        void this.persistLinkKinds(
          this.linkKinds.filter((_, i) => i !== index),
          { redraw: true },
        );
      });
    });
  }

  // Reordering is measured against the current DOM layout at pointerup (K3):
  // the dragged row's key moves to the index of whichever other row's
  // vertical midpoint the pointer ended above, or to the end otherwise.
  // Synthetic PointerEvents dispatched from e2e (wissen #476) reach these
  // plain addEventListener handlers the same way trusted ones would.
  private registerDragHandle(handleEl: HTMLElement, _key: string, onDrop: (dropY: number) => void): void {
    const win = handleEl.win;
    const onPointerDown = (down: PointerEvent) => {
      const startY = down.clientY;
      let dragging = false;
      const onMove = (move: PointerEvent) => {
        if (!dragging && Math.abs(move.clientY - startY) < 5) return;
        dragging = true;
      };
      const onUp = (up: PointerEvent) => {
        win.removeEventListener('pointermove', onMove);
        win.removeEventListener('pointerup', onUp);
        if (dragging) onDrop(up.clientY);
      };
      win.addEventListener('pointermove', onMove);
      win.addEventListener('pointerup', onUp);
    };
    handleEl.addEventListener('pointerdown', onPointerDown);
  }

  private reorderLinkKinds(draggedKey: string, dropY: number): void {
    const rows = Array.from(this.containerEl.querySelectorAll<HTMLElement>('[data-link-kind]'));
    let targetKey: string | undefined;
    for (const rowEl of rows) {
      const rowKey = rowEl.getAttribute('data-link-kind');
      if (!rowKey || rowKey === draggedKey) continue;
      const rect = rowEl.getBoundingClientRect();
      if (dropY < rect.top + rect.height / 2) {
        targetKey = rowKey;
        break;
      }
    }
    const dragged = this.linkKinds.find((k) => k.key === draggedKey);
    if (!dragged) return;
    const rest = this.linkKinds.filter((k) => k.key !== draggedKey);
    const targetIndex = targetKey ? rest.findIndex((k) => k.key === targetKey) : -1;
    rest.splice(targetIndex === -1 ? rest.length : targetIndex, 0, dragged);
    void this.persistLinkKinds(rest, { redraw: true });
  }

  // Popover on the settings page (DESIGN.md .ktm-iconpicker): search field
  // plus a grid of every Lucide icon Obsidian's setIcon knows, filtered by
  // the search text; a click picks the icon, hands it to the caller and
  // closes the popover. Shared by link-kind rows and level rows (K2/K13).
  private openIconCatalog(anchor: HTMLElement, currentIcon: string | undefined, onSelect: (icon: string) => void): void {
    this.closeIconCatalog();
    const doc = anchor.doc;
    const rect = anchor.getBoundingClientRect();
    const popover = doc.body.createDiv({ cls: 'ktm-iconpicker' });
    popover.style.position = 'fixed';
    popover.style.top = `${rect.bottom + 4}px`;
    popover.style.left = `${Math.max(8, rect.right - 320)}px`;

    const search = popover.createDiv({ cls: 'ktm-search' });
    setIcon(search.createSpan(), 'search');
    const input = search.createEl('input', { type: 'text', cls: 'ktm-search-input' });
    const grid = popover.createDiv({ cls: 'ktm-iconpicker-grid' });

    // getIconIds() answers with the registry's fully qualified ids
    // (`lucide-gavel`); LinkKind.icon/Level.icon and setIcon() elsewhere in
    // this plugin use the bare Lucide name (`gavel`), so the prefix is
    // stripped back off here before it reaches data-icon or a stored value.
    const LUCIDE_PREFIX = 'lucide-';
    const icons = getIconIds()
      .filter((id) => id.startsWith(LUCIDE_PREFIX))
      .map((id) => id.slice(LUCIDE_PREFIX.length))
      .sort((a, b) => a.localeCompare(b));

    const paint = (): void => {
      grid.empty();
      const query = input.value.trim().toLowerCase();
      const filtered = query ? icons.filter((id) => id.includes(query)) : icons;
      for (const id of filtered) {
        const cell = grid.createDiv({ cls: 'ktm-iconpicker-cell' });
        cell.setAttribute('data-icon', id);
        cell.setAttribute('aria-label', id);
        if (id === currentIcon) cell.setAttribute('data-selected', 'true');
        setIcon(cell, id);
        cell.addEventListener('click', () => {
          this.closeIconCatalog();
          onSelect(id);
        });
      }
    };
    input.addEventListener('input', paint);
    paint();
    input.focus();

    const onOutside = (ev: MouseEvent): void => {
      if (popover.contains(ev.target as Node)) return;
      if (ev.target === anchor || anchor.contains(ev.target as Node)) return;
      this.closeIconCatalog();
    };
    doc.addEventListener('mousedown', onOutside, true);

    this.iconCatalogEl = popover;
    this.closeIconCatalogListener = () => doc.removeEventListener('mousedown', onOutside, true);
  }

  private closeIconCatalog(): void {
    this.iconCatalogEl?.remove();
    this.iconCatalogEl = undefined;
    this.closeIconCatalogListener?.();
    this.closeIconCatalogListener = undefined;
  }

  private updateLinkKind(index: number, patch: Partial<LinkKind>): void {
    const next = this.linkKinds.map((kind, i) => (i === index ? { ...kind, ...patch } : kind));
    void this.persistLinkKinds(next, { redraw: false });
  }

  private async persistLinkKinds(kinds: LinkKind[], options: { redraw: boolean }): Promise<void> {
    this.linkKinds = kinds;
    this.plugin.settings.linkKinds = kinds;
    await this.plugin.saveData(this.plugin.settings);
    this.plugin.rerenderBoard();
    if (options.redraw) this.display();
  }

  private async setCardField(field: CardField, show: boolean): Promise<void> {
    const current = new Set(resolveCardFields(this.plugin.settings));
    if (show) current.add(field);
    else current.delete(field);
    this.plugin.settings.cardFields = CARD_FIELDS.filter((key) => current.has(key));
    await this.plugin.saveData(this.plugin.settings);
    this.plugin.rerenderBoard();
  }

  // Draws the raw levels list, not resolveLevels() (wissen #528): a
  // freshly created, still-unnamed row must not disappear on redraw, even
  // though resolveLevels() discards it for consumption.
  private renderLevelsSection(container: HTMLElement): void {
    new Setting(container)
      .setName('Hierarchie')
      .setDesc(
        'Von oben nach unten, zwei bis fünf Ebenen. Name und Icon frei; der Schlüssel steht als „type“ im Frontmatter und wird beim Umbenennen nicht geändert. Die unterste Ebene ist die Standardebene des Boards und neuer Karten. Namen und Icons gelten überall: Ebenen-Schalter, Chips, Verknüpfungen, diese Seite.',
      );

    const stored = this.plugin.settings.levels;
    this.levels = stored && stored.length > 0 ? stored.map((l) => ({ ...l })) : DEFAULT_LEVELS.map((l) => ({ ...l }));

    const list = container.createDiv({ cls: 'ktm-orderlist' });
    for (let index = 0; index < this.levels.length; index += 1) {
      this.renderLevelRow(list, index);
    }

    const addRow = container.createSpan({ cls: 'ktm-addrow' });
    setIcon(addRow.createSpan(), 'plus');
    addRow.createSpan({ text: 'Ebene hinzufügen' });
    addRow.addEventListener('click', () => {
      void this.persistLevels([...this.levels, { key: '', name: '', icon: 'circle' }], { redraw: true });
    });
  }

  private renderLevelRow(list: HTMLElement, index: number): void {
    const level = this.levels[index];
    const row = list.createDiv({ cls: 'ktm-orderrow' });
    row.setAttribute('data-level-index', String(index));
    row.setAttribute('data-level-key', level.key);

    const grip = row.createSpan({ cls: 'grip' });
    setIcon(grip, 'grip-vertical');
    this.registerDragHandle(grip, level.key, (dropY) => this.reorderLevels(index, dropY));

    const iconButton = row.createSpan({ cls: 'ico is-btn' });
    setIcon(iconButton, level.icon || 'circle');
    iconButton.addEventListener('click', () => {
      this.openIconCatalog(iconButton, level.icon, (icon) => {
        const next = this.levels.map((l, i) => (i === index ? { ...l, icon } : l));
        void this.persistLevels(next, { redraw: true });
      });
    });

    const nameInput = row.createEl('input', {
      cls: 'ktm-textinput',
      attr: { type: 'text', placeholder: 'Name' },
    });
    nameInput.value = level.name;
    nameInput.addEventListener('input', () => {
      this.updateLevel(index, { name: nameInput.value });
    });

    const keyInput = row.createEl('input', {
      cls: 'ktm-textinput is-mono',
      attr: { type: 'text', placeholder: 'Schlüssel' },
    });
    keyInput.value = level.key;
    keyInput.addEventListener('input', () => {
      row.setAttribute('data-level-key', keyInput.value);
      this.updateLevel(index, { key: keyInput.value });
    });

    const isBottom = index === this.levels.length - 1;
    if (isBottom) {
      row.createSpan({ cls: 'key', text: 'unterste, Standard' });
    } else {
      const remove = row.createSpan({ cls: 'x' });
      setIcon(remove, 'x');
      remove.addEventListener('click', () => {
        void this.removeLevel(index);
      });
    }
  }

  private updateLevel(index: number, patch: Partial<Level>): void {
    const next = this.levels.map((level, i) => (i === index ? { ...level, ...patch } : level));
    void this.persistLevels(next, { redraw: false });
  }

  // Target clamped so the current bottom level stays last (K4),
  // unless it is itself the dragged row (K2: the freshly created row
  // sits at the bottom until the first move and must be free to sort
  // anywhere). Identity via object reference instead of key, because a
  // freshly created row carries no (or a duplicate empty)
  // key yet.
  private reorderLevels(draggedIndex: number, dropY: number): void {
    const rows = Array.from(this.containerEl.querySelectorAll<HTMLElement>('[data-level-index]'));
    let targetIndex = -1;
    for (const rowEl of rows) {
      const idx = Number(rowEl.getAttribute('data-level-index'));
      if (idx === draggedIndex) continue;
      const rect = rowEl.getBoundingClientRect();
      if (dropY < rect.top + rect.height / 2) {
        targetIndex = idx;
        break;
      }
    }
    const bottom = this.levels[this.levels.length - 1];
    const dragged = this.levels[draggedIndex];
    const rest = this.levels.filter((_, i) => i !== draggedIndex);
    const targetLevel = targetIndex === -1 ? undefined : this.levels[targetIndex];
    const insertAt = targetLevel ? rest.indexOf(targetLevel) : -1;
    rest.splice(insertAt === -1 ? rest.length : insertAt, 0, dragged);

    if (dragged !== bottom) {
      const bottomAt = rest.indexOf(bottom);
      if (bottomAt !== -1 && bottomAt !== rest.length - 1) {
        rest.splice(bottomAt, 1);
        rest.push(bottom);
      }
    }

    void this.persistLevels(rest, { redraw: true });
  }

  // Removal locked as long as a vault note carries type==key (S21/K5);
  // the notice names the first element by path. The bottom level offers
  // no cross at all (renderLevelRow).
  private async removeLevel(index: number): Promise<void> {
    const level = this.levels[index];
    const using = this.levelEntries
      .filter((entry) => entry.frontmatter.type === level.key)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (using.length > 0) {
      const first = using[0];
      const name = typeof first.frontmatter.title === 'string' ? first.frontmatter.title : first.path;
      new Notice(`„${level.name}“ wird noch von „${name}“ verwendet und bleibt bestehen.`, NOTICE_DURATION);
      return;
    }
    void this.persistLevels(
      this.levels.filter((_, i) => i !== index),
      { redraw: true },
    );
  }

  private async persistLevels(levels: Level[], options: { redraw: boolean }): Promise<void> {
    this.levels = levels;
    this.plugin.settings.levels = levels;
    await this.plugin.saveData(this.plugin.settings);
    this.plugin.rerenderBoard();
    if (options.redraw) this.display();
  }
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
