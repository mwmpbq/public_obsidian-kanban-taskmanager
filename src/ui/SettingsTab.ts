import {
  type App,
  Notice,
  PluginSettingTab,
  Setting,
  TFile,
  ToggleComponent,
  getIconIds,
  setIcon,
} from 'obsidian';
import { createNote, writeFrontmatter } from '../adapters/obsidian';
import { flowList, yamlScalar } from '../core/frontmatter';
import type { BoardElement, FileEntry, ProjectRoot } from '../core/model';
import { readElements } from '../core/read';
import {
  type ButtonStyle,
  buttonStyleOf,
  CARD_FIELDS,
  type CardField,
  chipLevelLabel,
  type Column,
  columnKey,
  columnMembers,
  type ColumnRole,
  DEFAULT_LEVELS,
  effectiveTags,
  isValidColumnKey,
  isValidTag,
  type Level,
  type LinkKind,
  orderProjects,
  parseColumns,
  parseLevelList,
  parseLinkKindList,
  parseTagList,
  type ProjectSettings,
  resolveCardFields,
  resolveLevels,
  resolveLinkKinds,
  resolveProjectSettings,
  resolveTagList,
  RESULT_LINK_KIND,
  type ResolvedSettings,
  settingsFor,
  type TagEntry,
  withResultKind,
} from '../core/settings';
import type KanbanTaskManagerPlugin from '../main';
import { type AncestorChip, renderCardFace } from './cardFace';
import { levelPlural } from './BoardView';
import { ColumnDialog } from './ColumnDialog';
import { ProjectDialog } from './ProjectDialog';

const NOTICE_DURATION = 6000;
const VIEW_ALL = 'all';
const VIEW_INTERNAL = 'internal';
const SCOPE_GENERAL = 'general';

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

// Row icons for the "Karte, geschlossen" order list (design/mockup/reference-data.json
// settings.card_fields; "parents" has no mockup entry, "layers" matches its own
// Epic-chip default icon).
const CARD_FIELD_ICONS: Record<CardField, string> = {
  ticket: 'hash',
  planned: 'calendar',
  due: 'flag',
  checklist: 'check-square',
  priority: 'chevrons-up',
  project: 'folder',
  parents: 'layers',
  tags: 'tag',
};

const NEW_LINK_KIND: LinkKind = { key: '', label: '', icon: 'file-text' };

// The Rolle dropdown of a column row (006 addendum 2026-09-22, Ergänzung
// 2026-10-25 "Spaltenrolle aktiv", DESIGN.md §Spalten-Zeile): a role's label,
// in the order the select offers them.
const COLUMN_ROLE_LABELS: Array<[ColumnRole, string]> = [
  ['open', 'offen'],
  ['active', 'aktiv'],
  ['done', 'erledigt'],
  ['wont-do', 'verworfen'],
];

// The key's own default role (006, Ergänzung 2026-10-25): "doing" is active,
// every other open key is open. persistColumns and commitColumnName use this
// to decide whether a role needs writing out at all.
function defaultIsActive(key: string): boolean {
  return key === 'doing';
}

// `undefined` when the column's role matches its key's default (006,
// Ergänzung 2026-10-25 "nur bei Abweichung"); an end role never needs one,
// its role already follows the key itself.
function roleOverride(column: Column): 'aktiv' | 'offen' | undefined {
  if (column.role === 'done' || column.role === 'wont-do') return undefined;
  const isActive = column.role === 'active';
  if (isActive === defaultIsActive(column.status)) return undefined;
  return isActive ? 'aktiv' : 'offen';
}

// Internal is synthetic: there is neither a card.project nor a project note
// for that (wissen 390, 555). Root and note path are convention, modeled on
// the pattern of real projects (note lies in the root's parent folder), not
// derived from data.
const INTERN_ROOT = '03_Areas/Internal/Deliverables';
const INTERN_NOTE_PATH = '03_Areas/Internal/_Kanban.md';

// The fixed preview card of the "Karte, geschlossen" section (F058, reference
// data of DESIGN.md §Referenzdaten): a due card so the drag order (K4) is
// provable on the preview too, plus a planned date the reference screenshot
// does not show (see contract's note to the design reviewer).
const PREVIEW_TODAY = '2026-09-09';
const PREVIEW_CARD = {
  title: 'Pipeline-Fehler bei leeren Dateien beheben',
  ticket: undefined as number | undefined,
  planned: '2026-09-09',
  due: '2026-09-07',
  checklist: { done: 2, total: 5 },
  priority: 1,
  project: 'nimbus',
  tags: ['st/bug'],
};
const PREVIEW_ANCESTORS: AncestorChip[] = [
  { icon: 'layers', title: 'Plattform', levelName: 'Epic', fullTitle: 'Plattform-Betrieb' },
  { icon: 'box', title: 'Datenaufnahme', levelName: 'Feature', fullTitle: 'Datenaufnahme stabilisieren' },
];

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
  // 'general' or a project key (006 addendum 2026-09-20, "Gilt für"); survives
  // display() so switching a section does not reset it (F058).
  private scope: string = SCOPE_GENERAL;
  private linkKinds: LinkKind[] = [];
  private levels: Level[] = [];
  private tags: TagEntry[] = [];
  private tagSectionEl?: HTMLElement;
  private cardFieldOrder: CardField[] = [];
  private cardFieldEnabled: Set<CardField> = new Set();
  private columns: Column[] = [];
  private columnsSectionEl?: HTMLElement;
  private levelEntries: FileEntry[] = [];
  private projects: ProjectSettings[] = [];
  private roots: ProjectRoot[] = [];
  // Every level (task, feature, epic), read once per display() the same way
  // BoardView#render does (F070: removeColumn/changeColumnRole need to count
  // a column's members before touching it).
  private elements: BoardElement[] = [];
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

  // Fire-and-forget (wissen: MarkdownRenderer-Musters): the vault read (project
  // list and "Gilt für" options) happens first, so the scope dropdown and every
  // section below it are drawn from the same project list in one pass (F058:
  // "renderPage liest die Projekte vor renderScope"). The await stays before
  // containerEl.empty(): once empty() and the rebuild run, nothing yields the
  // event loop between them, so the browser never gets a chance to notice the
  // scroller is briefly content-less and reset its scrollTop (F110, #700).
  private async renderPage(): Promise<void> {
    const { containerEl } = this;

    await this.plugin.indexReady;
    const entries = this.plugin.index.entries();
    const roots = this.plugin.index.roots();
    this.roots = roots;
    this.levelEntries = entries;
    this.projects = orderProjects(resolveProjectSettings(entries).projects, this.plugin.settings.projectOrder);
    if (this.scope !== SCOPE_GENERAL && !this.projects.some((p) => p.key === this.scope)) {
      this.scope = SCOPE_GENERAL;
    }
    const levelsFor = (project: string) => this.settingsForProject(project).levels;
    const linkKindsFor = (project: string) => this.settingsForProject(project).linkKinds;
    this.elements = readElements(entries, roots, linkKindsFor, levelsFor);

    const scroller = (containerEl.closest('.vertical-tab-content') as HTMLElement | null) ?? containerEl;
    const scrollTop = scroller.scrollTop;

    containerEl.empty();
    const root = containerEl.createDiv({ cls: 'ktm-settings' });

    this.renderScope(root);
    if (this.plugin.settingsUnreadableSinceLoad) this.renderAdoptDefaultsRow(root);

    const headingByJump = new Map<string, HTMLElement>();
    this.renderJumpBar(root, headingByJump);

    headingByJump.set(SECTIONS[0].jump, this.renderSectionHeading(root, SECTIONS[0].heading));
    this.renderProjectsSection(root);

    headingByJump.set(SECTIONS[1].jump, this.renderSectionHeading(root, SECTIONS[1].heading));
    this.renderBoardSection(root);

    headingByJump.set(SECTIONS[2].jump, this.renderSectionHeading(root, SECTIONS[2].heading));
    this.renderTodaySection(root);

    headingByJump.set(SECTIONS[3].jump, this.renderSectionHeading(root, SECTIONS[3].heading));
    this.renderCardClosedSection(root);

    headingByJump.set(SECTIONS[4].jump, this.renderSectionHeading(root, SECTIONS[4].heading));

    headingByJump.set(SECTIONS[5].jump, this.renderSectionHeading(root, SECTIONS[5].heading));
    this.renderLinkKindsSection(root);

    headingByJump.set(SECTIONS[6].jump, this.renderSectionHeading(root, SECTIONS[6].heading));
    this.renderLevelsSection(root);

    scroller.scrollTop = scrollTop;
  }

  // S44/K1/K2: a Setting row with the heading role, not a raw h2/h3 — Obsidian
  // renders it as `.setting-item.setting-item-heading` with the name in
  // `.setting-item-name` (wissen 614: that class, not a bare h3, is what its
  // own app.css margin-top rule already targets).
  private renderSectionHeading(container: HTMLElement, heading: string): HTMLElement {
    return new Setting(container).setName(heading).setHeading().settingEl;
  }

  // "Gilt für": General writes data.json, a project writes its note (006
  // addendum 2026-09-20). Intern has no note and is not offered (wissen 593).
  private renderScope(container: HTMLElement): void {
    const scope = container.createDiv({ cls: 'ktm-scope' });
    scope.createSpan({ cls: 'ktm-label', text: 'Gilt für' });
    const select = scope.createEl('select', { cls: 'dropdown' });
    select.createEl('option', { value: SCOPE_GENERAL, text: 'Allgemein' });
    for (const project of this.projects) {
      select.createEl('option', { value: project.key, text: project.name });
    }
    select.value = this.scope;
    select.addEventListener('change', () => {
      this.scope = select.value;
      this.display();
    });
    scope.createSpan({
      cls: 'ktm-scope-hint',
      text:
        this.scope === SCOPE_GENERAL
          ? 'Schreibt data.json. Projekte erben, was sie nicht selbst setzen.'
          : 'Schreibt die Projektnotiz. Nicht gesetzte Zeilen erben vom Allgemeinen.',
    });
  }

  // 006, Ergänzung 2026-10-19 "Eine unlesbare Einstellungsdatei wird nie
  // überschrieben" (S45, S64/S65): erscheint nur, solange data.json seit dem
  // Laden kein einziges Mal lesbar war; der Klick ist die ausdrückliche
  // Bestätigung, deshalb hier kein automatischer Versuch.
  private renderAdoptDefaultsRow(container: HTMLElement): void {
    new Setting(container)
      .setName('Voreinstellungen übernehmen')
      .setDesc(
        'data.json ist seit dem Start nicht lesbar. Eine Kopie landet in data.json.bak, danach gelten die Voreinstellungen.',
      )
      .addButton((button) =>
        button.setButtonText('Voreinstellungen übernehmen').onClick(async () => {
          await this.plugin.adoptDefaults();
          void this.renderPage();
        }),
      );
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

  private selectedProject(): ProjectSettings | undefined {
    if (this.scope === SCOPE_GENERAL) return undefined;
    return this.projects.find((p) => p.key === this.scope);
  }

  // Mirrors BoardView#projectSettings, needed here to resolve levels and link
  // kinds for readElements (F070).
  private settingsForProject(projectKey: string | undefined): ResolvedSettings {
    const project = this.projects.find((p) => p.key === projectKey);
    return settingsFor(this.plugin.settings, project);
  }

  private currentProjectEntry(): FileEntry | undefined {
    const project = this.selectedProject();
    if (!project) return undefined;
    return this.levelEntries.find((e) => e.path === project.path);
  }

  private hasOwnKey(frontmatterKey: string): boolean {
    return this.currentProjectEntry()?.frontmatter[frontmatterKey] !== undefined;
  }

  // Marks a project-capable row (Standard/eigen, 006 addendum 2026-09-20): the
  // badge and, while "Standard", a dimmed row and its associated list. The row
  // stays interactive in both states — editing a "Standard" row is how it
  // becomes "eigen" (S27).
  private markProjectRow(setting: Setting, settingKey: string, frontmatterKey: string, list?: HTMLElement): boolean {
    setting.settingEl.setAttribute('data-setting', settingKey);
    if (this.scope === SCOPE_GENERAL) return false;
    const own = this.hasOwnKey(frontmatterKey);
    if (own) {
      setting.nameEl.createSpan({ cls: 'ktm-badge is-own', text: 'eigen' });
      const reset = setting.nameEl.createSpan({ cls: 'ktm-badge-reset', attr: { 'aria-label': 'Zurücksetzen' } });
      setIcon(reset, 'corner-left-up');
      reset.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void this.resetProjectKey(frontmatterKey);
      });
    } else {
      setting.nameEl.createSpan({ cls: 'ktm-badge', text: 'Standard' });
      setting.settingEl.addClass('ktm-dim-control');
      list?.addClass('ktm-dim-list');
    }
    return own;
  }

  // Marks a general-only row (006 addendum 2026-09-20: everything under Board
  // except doneLimit, the whole Bereich Heute, the project list, the two
  // refile folders, the expanded-card width). `setDisabled` must run after the
  // row's control is added — Setting.setDisabled walks `components`, which is
  // still empty at `markGlobalOnlyRow` time — so this only paints the badge and
  // dimming; call `lockIfGlobalOnly` once the control exists.
  private markGlobalOnlyRow(setting: Setting, settingKey: string): void {
    setting.settingEl.setAttribute('data-setting', settingKey);
    if (this.scope === SCOPE_GENERAL) return;
    setting.nameEl.createSpan({ cls: 'ktm-badge is-global', text: 'nur allgemein' });
    setting.settingEl.addClass('ktm-dim-info');
  }

  private lockIfGlobalOnly(setting: Setting): void {
    if (this.scope !== SCOPE_GENERAL) setting.setDisabled(true);
  }

  private async resetProjectKey(frontmatterKey: string): Promise<void> {
    const project = this.selectedProject();
    if (!project) return;
    await writeFrontmatter(this.app, project.path, { [frontmatterKey]: null });
    this.plugin.rerenderBoard();
    this.display();
  }

  private async writeProjectKey(frontmatterKey: string, value: string): Promise<void> {
    const project = this.selectedProject();
    if (!project) return;
    await writeFrontmatter(this.app, project.path, { [frontmatterKey]: value });
  }

  // Shared write path of every project-capable row: general writes data.json,
  // a project writes its note. A redraw always follows the first edit that
  // turns a "Standard" row "eigen" (the badge must update); a caller can force
  // one for other reasons (drag, add, remove, icon change). `skipBoardRedraw`
  // lets a caller leave the board untouched when it already knows this write
  // cannot change what the board shows (F144 K13); saving and the settings
  // page's own redraw rules are unaffected.
  private async persistProjectOrGeneral(
    frontmatterKey: string,
    encode: () => string,
    applyGeneral: () => void,
    forceRedraw: boolean,
    skipBoardRedraw = false,
  ): Promise<void> {
    if (this.scope === SCOPE_GENERAL) {
      applyGeneral();
      await this.plugin.saveData(this.plugin.settings);
      if (!skipBoardRedraw) this.plugin.rerenderBoard();
      if (forceRedraw) this.display();
      return;
    }
    const wasOwn = this.hasOwnKey(frontmatterKey);
    await this.writeProjectKey(frontmatterKey, encode());
    if (!skipBoardRedraw) this.plugin.rerenderBoard();
    if (forceRedraw || !wasOwn) this.display();
  }

  private onCommit(inputEl: HTMLInputElement, handler: (value: string) => void): void {
    inputEl.addEventListener('change', () => handler(inputEl.value));
    inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        inputEl.blur();
      }
    });
  }

  // Section 1 (006 addendum 2026-09-20, extended 2026-09-24 with F085's
  // manage-from-the-settings-page): the project list is general-only (S26).
  // Intern stays synthetic (wissen 593), with neither a toggle nor a cross
  // (S53). "Projekt hinzufügen" opens ProjectDialog and, on a valid result,
  // writes `<Root>/_Kanban.md`; in project scope it has no effect (S26/K37).
  private renderProjectsSection(container: HTMLElement): void {
    const heading = new Setting(container)
      .setName('Projekte')
      .setDesc(
        'Erkannt an Notizen mit ktm_project. Alles, was ein Projekt überschreibt, steht in seiner Notiz.',
      );
    this.markGlobalOnlyRow(heading, 'projects');

    const list = container.createDiv({ cls: 'ktm-orderlist' });
    if (this.scope !== SCOPE_GENERAL) list.addClass('ktm-dim-list');
    this.renderProjectRow(list, 'Intern', 'intern', INTERN_ROOT, INTERN_NOTE_PATH, false);
    for (const project of this.projects) {
      this.renderProjectRow(list, project.name, project.key, project.root, project.path, true, project.hidden);
    }

    const addRow = container.createSpan({ cls: 'ktm-addrow' });
    setIcon(addRow.createSpan(), 'plus');
    addRow.createSpan({ text: 'Projekt hinzufügen' });
    addRow.addEventListener('click', () => {
      void this.addProject();
    });

    const sortRow = container.createSpan({ cls: 'ktm-addrow' });
    setIcon(sortRow.createSpan(), 'arrow-down-a-z');
    sortRow.createSpan({ text: 'Alphabetisch sortieren' });
    sortRow.addEventListener('click', () => {
      void this.persistProjectOrder(undefined);
    });

    this.renderColumnsSection(container);
    this.renderRefileRulesSection(container);
  }

  // Three general-only Ablageregeln (011, Abschnitt "Projekte & Ablage"),
  // read via `??` rather than DEFAULT_SETTINGS (K18: a fresh vault without
  // data.json shows an/an/aus).
  private renderRefileRulesSection(container: HTMLElement): void {
    const moveDone = new Setting(container)
      .setName('Abgeschlossene nach Done/ verschieben')
      .setDesc('Ein abgeschlossenes Element zieht in einen Done/-Spiegel unter seinem Root.');
    this.markGlobalOnlyRow(moveDone, 'moveDoneToFolder');
    moveDone.addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.moveDoneToFolder ?? true).onChange(async (value) => {
        this.plugin.settings.moveDoneToFolder = value;
        await this.plugin.saveData(this.plugin.settings);
      }),
    );
    this.lockIfGlobalOnly(moveDone);

    // Ablageregel 2 ("Ordner beim Einordnen und beim Projektwechsel
    // mitziehen") ist abgelöst: der Ort folgt jetzt immer dem Parent (011,
    // Ergänzung 2026-09-25), es gibt keinen Schalter mehr dafür.

    const renameOnTitle = new Setting(container)
      .setName('Datei und Ordner beim Umbenennen des Titels mit umbenennen')
      .setDesc('Ein geänderter Titel benennt Datei und Ordner nach demselben Muster wie beim Anlegen um.');
    this.markGlobalOnlyRow(renameOnTitle, 'renameOnTitleChange');
    renameOnTitle.addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.renameOnTitleChange ?? false).onChange(async (value) => {
        this.plugin.settings.renameOnTitleChange = value;
        await this.plugin.saveData(this.plugin.settings);
      }),
    );
    this.lockIfGlobalOnly(renameOnTitle);
  }

  // One row of the project list, shared for Internal (synthetic, no own entry
  // in this.projects, wissen 390/555, removable === false) and the real
  // projects from resolveProjectSettings. The note button only appears when
  // the note exists (K3: Intern has none until someone creates
  // 03_Areas/Internal/_Kanban.md).
  private renderProjectRow(
    list: HTMLElement,
    name: string,
    key: string,
    root: string,
    notePath: string,
    removable: boolean,
    hidden?: boolean,
  ): void {
    const row = list.createDiv({ cls: 'ktm-orderrow' });
    row.setAttribute('data-project-key', key);
    if (hidden) row.setAttribute('data-off', 'true');

    // "intern" is fixed first and has no grip (006, Ergänzung 2026-10-19, S70).
    if (removable) {
      const grip = row.createSpan({ cls: 'grip' });
      setIcon(grip, 'grip-vertical');
      this.registerDragHandle(grip, key, (dropY) => this.reorderProjects(key, dropY));
    }

    setIcon(row.createSpan({ cls: 'ico' }), 'folder');

    if (removable) {
      const nameInput = row.createEl('input', {
        cls: 'ktm-textinput',
        attr: { type: 'text', placeholder: 'Name' },
      });
      nameInput.value = name;
      nameInput.disabled = this.scope !== SCOPE_GENERAL;
      this.onCommit(nameInput, (value) => this.commitProjectName(notePath, value));
    } else {
      row.createSpan({ cls: 'nm', text: name });
    }
    row.createSpan({ cls: 'key', text: key });
    row.createSpan({ cls: 'key is-wide', text: root });

    const noteFile = this.app.vault.getAbstractFileByPath(notePath);
    if (noteFile instanceof TFile) {
      const jumpButton = row.createEl('button', { cls: 'ktm-button' });
      setIcon(jumpButton.createSpan(), 'file-text');
      jumpButton.createSpan({ text: notePath.split('/').pop() ?? notePath });
      jumpButton.addEventListener('click', () => {
        void this.app.workspace.getLeaf('tab').openFile(noteFile);
      });
    }

    if (!removable) return;

    new ToggleComponent(row.createDiv())
      .setValue(!hidden)
      .setDisabled(this.scope !== SCOPE_GENERAL)
      .onChange((visible) => {
        void this.setProjectHidden(key, notePath, !visible);
      });

    const remove = row.createSpan({ cls: 'x' });
    setIcon(remove, 'x');
    if (this.scope !== SCOPE_GENERAL) return;
    remove.addEventListener('click', () => {
      void this.removeProject(key, name, notePath);
    });
  }

  // A geleertes Namensfeld entfernt ktm_name (006, Ergänzung 2026-10-19, S76):
  // the project then shows under its key, like one that never had a name.
  // Duplicate names across projects are allowed (009 S21), so there is no
  // uniqueness check here.
  private async commitProjectName(notePath: string, rawValue: string): Promise<void> {
    if (this.scope !== SCOPE_GENERAL) return;
    const value = rawValue.trim();
    await writeFrontmatter(this.app, notePath, { ktm_name: value ? yamlScalar(value) : null });
    this.plugin.rerenderBoard();
    this.display();
  }

  // Hiding the project the board currently shows falls back exactly like
  // removing it (006, Ergänzung 2026-10-19, S75): "Ansicht beim Öffnen" falls
  // back to "zuletzt benutzt", and the in-memory last-used view is reset to
  // "all" too, so it is also what gets persisted the next time the board
  // saves its state — re-showing the project must not bring either back.
  private async setProjectHidden(key: string, notePath: string, hidden: boolean): Promise<void> {
    if (this.scope !== SCOPE_GENERAL) return;
    await writeFrontmatter(this.app, notePath, { ktm_hidden: hidden ? 'true' : null });
    if (hidden) {
      let changed = false;
      if (this.plugin.settings.openView === key) {
        this.plugin.settings.openView = 'last';
        changed = true;
      }
      if (this.plugin.settings.lastView === key) {
        this.plugin.settings.lastView = VIEW_ALL;
        changed = true;
      }
      if (changed) await this.plugin.saveData(this.plugin.settings);
    }
    this.plugin.rerenderBoard();
    this.display();
  }

  // S52/K1-K6: a project with tasks asks first (ProjectDialog's 'remove'
  // kind); one without disappears outright. The note goes to the trash, not a
  // hard delete (S52), and "Ansicht beim Öffnen" falls back to "last" so it
  // never points at a project that no longer exists (K35).
  private async removeProject(key: string, name: string, notePath: string): Promise<void> {
    if (this.scope !== SCOPE_GENERAL) return;
    const count = this.elements.filter((el) => el.project === key).length;
    if (count > 0) {
      const result = await ProjectDialog.ask(this.app, { kind: 'remove', count, name });
      if (result !== 'remove') return;
    }
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (file) {
      try {
        await this.app.fileManager.trashFile(file);
      } catch (err) {
        new Notice(`Projekt entfernen fehlgeschlagen: ${notePath} (${errorMessage(err)})`, NOTICE_DURATION);
        return;
      }
    }
    if (this.plugin.settings.openView === key) {
      this.plugin.settings.openView = 'last';
      await this.plugin.saveData(this.plugin.settings);
    }
    this.plugin.rerenderBoard();
    this.display();
  }

  // S47/S48: ProjectDialog validates Kürzel and Root against every known
  // project, hidden ones included; a rejected attempt writes nothing (K9). A
  // note already sitting at the target path is left untouched rather than
  // overwritten (F085's "existiert schon, wird abgelehnt").
  private async addProject(): Promise<void> {
    if (this.scope !== SCOPE_GENERAL) return;
    const result = await ProjectDialog.ask(this.app, {
      kind: 'create',
      existing: this.projects,
      noteExists: (path) => !!this.app.vault.getAbstractFileByPath(path),
    });
    if (!result || result === 'remove') return;
    const { name, key, root } = result;
    const notePath = `${root}/_Kanban.md`;
    if (this.app.vault.getAbstractFileByPath(notePath)) {
      new Notice(`„${notePath}“ existiert schon.`, NOTICE_DURATION);
      return;
    }
    const content = `---\nktm_project: ${key}\nktm_name: ${yamlScalar(name)}\nktm_root: ${root}\n---\n\n`;
    try {
      await createNote(this.app, notePath, content);
    } catch (err) {
      new Notice(`Projekt hinzufügen fehlgeschlagen: ${notePath} (${errorMessage(err)})`, NOTICE_DURATION);
      return;
    }
    this.plugin.rerenderBoard();
    this.display();
  }

  // Dragged over or above "intern" lands right behind it (006, Ergänzung
  // 2026-10-19, S70: "intern" itself never moves and has no grip). The full
  // key list, hidden projects included, becomes the stored order; no project
  // note is touched by dragging (S69).
  private reorderProjects(draggedKey: string, dropY: number): void {
    const targetKey = this.dropTargetKey('data-project-key', draggedKey, dropY);
    const rest = this.projects.map((p) => p.key).filter((k) => k !== draggedKey);
    const insertAt = targetKey === 'intern' ? 0 : targetKey === undefined ? -1 : rest.indexOf(targetKey);
    rest.splice(insertAt === -1 ? rest.length : insertAt, 0, draggedKey);
    void this.persistProjectOrder(rest);
  }

  private async persistProjectOrder(order: string[] | undefined): Promise<void> {
    if (this.scope !== SCOPE_GENERAL) return;
    this.plugin.settings.projectOrder = order;
    await this.plugin.saveData(this.plugin.settings);
    this.plugin.rerenderBoard();
    this.display();
  }

  // 006 addendum 2026-09-22 (S35-S41): replaces the two Standardspalten/
  // Abgeschlossene-Spalten text fields with a Reihenfolge-Liste of key, name
  // and role, the pattern of renderLevelsSection. renderColumnsSection loads
  // the current list once per display() (own note form vs. general default,
  // ownColumns() already translates the old ktm_columns/ktm_done_columns
  // form into keys, S40); paintColumnsSection only redraws from this.columns
  // as it stands, so a local add or a commit does not lose an unpersisted
  // draft row the way a full display() would.
  private renderColumnsSection(container: HTMLElement): void {
    const own = this.scope !== SCOPE_GENERAL ? this.ownColumns() : undefined;
    const general = parseColumns(this.plugin.settings.columns, this.plugin.settings.doneColumns)?.columns ?? [];
    const stored = this.scope === SCOPE_GENERAL ? general : (own ?? general);
    this.columns = stored.map((c) => ({ ...c }));

    this.columnsSectionEl = container.createDiv();
    this.paintColumnsSection();
  }

  private ownColumns(): Column[] | undefined {
    const entry = this.currentProjectEntry();
    const raw = entry?.frontmatter.ktm_columns;
    if (raw === undefined) return undefined;
    return parseColumns(raw, entry?.frontmatter.ktm_done_columns)?.columns ?? undefined;
  }

  private paintColumnsSection(): void {
    const section = this.columnsSectionEl;
    if (!section) return;
    section.empty();

    const heading = new Setting(section)
      .setName('Spalten')
      .setDesc(
        'Reihenfolge per Ziehen. Der Schlüssel steht als status im Frontmatter und wird beim Umbenennen nicht geändert. Erledigt und verworfen je höchstens einmal; ihre Karten wandern in den Done/-Spiegel.',
      );
    const list = section.createDiv({ cls: 'ktm-orderlist' });
    this.markProjectRow(heading, 'columns', 'ktm_columns', list);
    for (let index = 0; index < this.columns.length; index += 1) {
      this.renderColumnRow(list, index);
    }

    const addRow = section.createSpan({ cls: 'ktm-addrow' });
    setIcon(addRow.createSpan(), 'plus');
    addRow.createSpan({ text: 'Spalte hinzufügen' });
    addRow.addEventListener('click', () => {
      this.columns = [...this.columns, { status: '', name: '', done: false, role: 'open' }];
      this.paintColumnsSection();
    });
  }

  // DESIGN.md §Spalten-Zeile: Griff, Namensfeld, Schlüssel nur zur Anzeige,
  // Rollen-Dropdown, Kreuz (F070, S37-S39: removeColumn/changeColumnRole).
  private renderColumnRow(list: HTMLElement, index: number): void {
    const column = this.columns[index];
    const row = list.createDiv({ cls: 'ktm-orderrow' });
    row.setAttribute('data-column-key', column.status);
    row.setAttribute('data-column-index', String(index));

    const grip = row.createSpan({ cls: 'grip' });
    setIcon(grip, 'grip-vertical');
    this.registerDragHandle(grip, column.status, (dropY) => this.reorderColumns(index, dropY));

    const nameInput = row.createEl('input', {
      cls: 'ktm-textinput',
      attr: { type: 'text', placeholder: 'Name' },
    });
    nameInput.value = column.name;
    this.onCommit(nameInput, (value) => this.commitColumnName(index, value));

    row.createSpan({ cls: 'key', text: `status: ${column.status}` });

    const select = row.createEl('select', { cls: 'dropdown ktm-select' });
    const takenRoles = new Set(
      this.columns
        .filter((_, i) => i !== index)
        .map((c) => c.role)
        .filter((role): role is ColumnRole => role === 'done' || role === 'wont-do'),
    );
    for (const [role, label] of COLUMN_ROLE_LABELS) {
      if ((role === 'done' || role === 'wont-do') && takenRoles.has(role) && column.role !== role) continue;
      select.createEl('option', { value: role, text: label });
    }
    select.value = column.role ?? 'open';
    select.addEventListener('change', () => {
      void this.changeColumnRole(index, select.value as ColumnRole);
    });

    const remove = row.createSpan({ cls: 'x' });
    setIcon(remove, 'x');
    remove.addEventListener('click', () => {
      void this.removeColumn(index);
    });
  }

  // S37/K1/K4/K7: an end column or an open column without members is removed
  // outright, no dialog. An end column with members (F080 S46/K1-K6) asks a
  // plain confirmation first — Abbrechen leaves the row untouched, Entfernen
  // removes it exactly as S37 always did, no file is written either way. An
  // open column with members (S38/K3) asks for a target via ColumnDialog;
  // each member's status becomes that target before the row disappears.
  private async removeColumn(index: number): Promise<void> {
    const column = this.columns[index];
    if (!column) return;
    const members = columnMembers(this.elements, column, this.scope, this.projects);

    if (column.role === 'done' || column.role === 'wont-do') {
      if (members.length > 0) {
        const confirmed = await ColumnDialog.ask(this.app, members.length, column.name, {
          kind: 'confirm',
          role: column.role === 'wont-do' ? 'wont-do' : 'done',
        });
        if (confirmed === null) return;
      }
      await this.persistColumns(this.columns.filter((_, i) => i !== index));
      return;
    }

    if (members.length === 0) {
      await this.persistColumns(this.columns.filter((_, i) => i !== index));
      return;
    }

    const targets = this.columns.filter((_, i) => i !== index);
    if (targets.length === 0) {
      new Notice('Keine andere Spalte, in die die Aufgaben verschoben werden könnten.', NOTICE_DURATION);
      return;
    }
    const target = await ColumnDialog.ask(this.app, members.length, column.name, {
      kind: 'target',
      targets,
    });
    if (target === null) return;

    for (const member of members) {
      // The status write alone is enough now (011, Ergänzung 2026-09-25):
      // main.ts#placeElement reacts to the changed `status` field itself and
      // files a closed member under Done/ without a separate call here.
      // Diese Bulk-Zuweisung ist Pflege der Spaltenliste, kein Arbeitsbeginn
      // (F190, Wissen #1231): markSettingsReassignment schützt vor
      // stampStartedAfterStatusChange.
      this.plugin.markSettingsReassignment(member.paths.note);
      await writeFrontmatter(this.app, member.paths.note, { status: target });
    }
    await this.persistColumns(this.columns.filter((_, i) => i !== index));
  }

  // S39, erweitert um die Rolle aktiv (006, Ergänzung 2026-10-25): zwischen
  // offen und aktiv ändert sich nur die Rolle, Schlüssel und Aufgabendateien
  // bleiben, kein Dialog. Ein Wechsel aus einer Endrolle (done/wont-do)
  // heraus braucht weiterhin einen eigenen Schlüssel, da done/wont-do dafür
  // reserviert bleiben (S36): ohne Mitglieder wird er auf der Stelle
  // abgeleitet, mit Mitgliedern fragt ein ColumnDialog danach, dann wird
  // jedes Mitglied umgeschrieben, bevor die Zeile selbst Schlüssel und Rolle
  // wechselt — die Zielrolle (aktiv oder offen) bestimmt dabei nur, welche
  // der beiden Nicht-End-Rollen die Zeile danach trägt. Die andere Richtung
  // (offen/aktiv zu einer Endrolle) gelingt weiterhin nur ohne Mitglieder
  // oder ohne eigenen Schlüssel (K2s frisch angelegte Zeile); mit Mitgliedern
  // wird sie abgelehnt, wie es das Dropdown mit einer schon vergebenen
  // Endrolle schon verhindert.
  private async changeColumnRole(index: number, newRole: ColumnRole): Promise<void> {
    const column = this.columns[index];
    if (!column || column.role === newRole) return;
    const wasEndRole = column.role === 'done' || column.role === 'wont-do';
    const isEndRole = newRole === 'done' || newRole === 'wont-do';

    if (!isEndRole) {
      if (!wasEndRole) {
        const next = [...this.columns];
        next[index] = { ...column, done: false, role: newRole };
        await this.persistColumns(next);
        return;
      }
      const members = columnMembers(this.elements, column, this.scope, this.projects);
      if (members.length === 0) {
        const key = this.freshColumnKey(columnKey(column.name), index);
        const next = [...this.columns];
        next[index] = { status: key, name: column.name, done: false, role: newRole };
        await this.persistColumns(next);
        return;
      }
      const suggestion = this.freshColumnKey(columnKey(column.name), index);
      const existing = this.columns.filter((_, i) => i !== index);
      const newKey = await ColumnDialog.ask(this.app, members.length, column.name, {
        kind: 'key',
        suggestion,
        existing,
      });
      if (newKey === null || !isValidColumnKey(newKey, existing)) {
        this.paintColumnsSection();
        return;
      }
      for (const member of members) {
        // Switching to an open role always reopens (011, Ablageregel 1); the
        // status write alone triggers main.ts#placeElement to move the
        // member back out of Done/.
        await writeFrontmatter(this.app, member.paths.note, { status: newKey });
      }
      const next = [...this.columns];
      next[index] = { status: newKey, name: column.name, done: false, role: newRole };
      await this.persistColumns(next);
      return;
    }

    const members = columnMembers(this.elements, column, this.scope, this.projects);
    if (members.length === 0 || !column.status) {
      const next = [...this.columns];
      next[index] = { status: newRole, name: column.name, done: true, role: newRole };
      await this.persistColumns(next);
      return;
    }
    new Notice(
      `„${column.name}“ trägt noch Aufgaben. Erst umverteilen, dann die Rolle wechseln.`,
      NOTICE_DURATION,
    );
    this.paintColumnsSection();
  }

  private reorderColumns(draggedIndex: number, dropY: number): void {
    const targetKey = this.dropTargetKey('data-column-index', String(draggedIndex), dropY);
    const targetIndex = targetKey === undefined ? -1 : Number(targetKey);
    const dragged = this.columns[draggedIndex];
    const rest = this.columns.filter((_, i) => i !== draggedIndex);
    const targetColumn = targetIndex === -1 ? undefined : this.columns[targetIndex];
    const insertAt = targetColumn ? rest.indexOf(targetColumn) : -1;
    rest.splice(insertAt === -1 ? rest.length : insertAt, 0, dragged);
    void this.persistColumns(rest);
  }

  // A fresh row from "Spalte hinzufügen" carries no key until its name is
  // first committed (S41); the key is then derived from that name and never
  // touched again (S35). A collision with another row's key or with a
  // reserved role (done/wont-do) gets a -2, -3 … suffix, so a freshly added
  // open column never inherits an end role by accident. Renaming a row that
  // already has a key only ever changes its name.
  private commitColumnName(index: number, rawValue: string): void {
    const column = this.columns[index];
    if (!column) return;
    const value = rawValue.trim();
    if (!value || value === column.name) return;
    const next = [...this.columns];
    if (!column.status) {
      const key = this.freshColumnKey(columnKey(value), index);
      const role: ColumnRole = defaultIsActive(key) ? 'active' : 'open';
      next[index] = { status: key, name: value, done: false, role };
    } else {
      next[index] = { ...column, name: value };
    }
    void this.persistColumns(next);
  }

  private freshColumnKey(base: string, index: number): string {
    const taken = new Set(
      this.columns
        .filter((_, i) => i !== index)
        .map((c) => c.status)
        .filter((key) => key.length > 0),
    );
    const reserved = new Set(['done', 'wont-do']);
    let candidate = base;
    let suffix = 2;
    while (taken.has(candidate) || reserved.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  // Allgemein writes the object form straight into settings.columns and
  // drops doneColumns (S40: it must not come back through DEFAULT_SETTINGS'
  // merge). A project writes both ktm_columns and ktm_done_columns in one
  // writeFrontmatter call, so the note never sits with the new columns but
  // the old done list for even a moment. Rows without a name or key (an
  // unnamed draft) are never written (S41's addColumn bullet). A redraw is
  // forced only when the row's own badge would change (Standard -> eigen);
  // otherwise paintColumnsSection alone reflects the derived key locally.
  private async persistColumns(columns: Column[]): Promise<void> {
    this.columns = columns;
    const named = columns.filter((c) => c.status && c.name);

    if (this.scope === SCOPE_GENERAL) {
      this.plugin.settings.columns = named.map((c) => {
        const role = roleOverride(c);
        return role ? { key: c.status, name: c.name, role } : { key: c.status, name: c.name };
      });
      delete this.plugin.settings.doneColumns;
      await this.plugin.saveData(this.plugin.settings);
      this.plugin.rerenderBoard();
      this.paintColumnsSection();
      return;
    }

    const project = this.selectedProject();
    if (!project) return;
    const wasOwn = this.hasOwnKey('ktm_columns');
    await writeFrontmatter(this.app, project.path, {
      ktm_columns: flowList(
        named.map((c) => {
          const role = roleOverride(c);
          return role ? `${c.status} | ${c.name} | ${role}` : `${c.status} | ${c.name}`;
        }),
        true,
      ),
      ktm_done_columns: null,
    });
    this.plugin.rerenderBoard();
    if (!wasOwn) this.display();
    else this.paintColumnsSection();
  }

  // Section 2 (006 addendum 2026-09-20): everything but Done-Spalte begrenzen
  // is general-only (ribbon, openView, openLevel, allLevels, expanded-card
  // width all steer the board shell itself, not a project's content).
  private renderBoardSection(container: HTMLElement): void {
    const buttonStyleSetting = new Setting(container).setName('Buttonstil');
    this.markGlobalOnlyRow(buttonStyleSetting, 'buttonStyle');
    const currentStyle = buttonStyleOf(this.plugin.settings.buttonStyle);
    const preview = this.renderButtonStylePreview(container, currentStyle);
    buttonStyleSetting.addDropdown((dropdown) => {
      dropdown.addOption('basic', 'Basic');
      dropdown.addOption('ghost', 'Ghost');
      dropdown.addOption('outline', 'Outline');
      dropdown.addOption('keycap', 'Keycap');
      dropdown.setValue(currentStyle);
      dropdown.onChange(async (value) => {
        this.plugin.settings.buttonStyle = value;
        await this.plugin.saveData(this.plugin.settings);
        this.plugin.rerenderBoard();
        // Kein display(): die Vorschau zeigt den neuen Stil sofort über ihr
        // eigenes Attribut, ein voller Reload würde nur die Scrollposition
        // kosten (006, Ergänzung 2026-10-25 "Buttonstil"; Wissen #654 S54/S55).
        preview.setAttribute('data-button-style', buttonStyleOf(value));
      });
    });
    this.lockIfGlobalOnly(buttonStyleSetting);

    const ribbonSetting = new Setting(container)
      .setName('Symbol in der Seitenleiste')
      .setDesc('Ein Klick öffnet das Board oder holt es nach vorn.');
    this.markGlobalOnlyRow(ribbonSetting, 'ribbon');
    ribbonSetting.addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.ribbon ?? true).onChange(async (value) => {
        this.plugin.settings.ribbon = value;
        await this.plugin.saveData(this.plugin.settings);
      }),
    );
    this.lockIfGlobalOnly(ribbonSetting);

    const openViewSetting = new Setting(container).setName('Ansicht beim Öffnen');
    this.markGlobalOnlyRow(openViewSetting, 'openView');
    openViewSetting.addDropdown((dropdown) => {
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
    this.lockIfGlobalOnly(openViewSetting);

    const levels = resolveLevels(this.plugin.settings);
    const openLevelSetting = new Setting(container).setName('Ebene beim Öffnen');
    this.markGlobalOnlyRow(openLevelSetting, 'openLevel');
    openLevelSetting.addDropdown((dropdown) => {
      for (const level of levels) dropdown.addOption(level.key, level.name);
      dropdown.setValue(this.plugin.settings.openLevel ?? levels[levels.length - 1]?.key ?? '');
      dropdown.onChange(async (value) => {
        this.plugin.settings.openLevel = value;
        await this.plugin.saveData(this.plugin.settings);
      });
    });
    this.lockIfGlobalOnly(openLevelSetting);

    const allLevelsSetting = new Setting(container)
      .setName('Ebenen in der Ansicht „Alle“')
      .setDesc(
        'Projekte können eigene Ebenen haben. Nach Rang von unten: der Ebenen-Schalter zeigt die allgemeine Liste, eine Karte erscheint auf der Ebene mit demselben Abstand zur untersten. Nur unterste Ebene: der Schalter entfällt in „Alle“.',
      );
    this.markGlobalOnlyRow(allLevelsSetting, 'allLevels');
    allLevelsSetting.addDropdown((dropdown) => {
      dropdown.addOption('rank', 'Nach Rang von unten');
      dropdown.addOption('bottom', 'Nur unterste Ebene');
      dropdown.setValue(this.plugin.settings.allLevels ?? 'rank');
      dropdown.onChange(async (value) => {
        this.plugin.settings.allLevels = value as 'rank' | 'bottom';
        await this.plugin.saveData(this.plugin.settings);
        this.plugin.rerenderBoard();
      });
    });
    this.lockIfGlobalOnly(allLevelsSetting);

    const project = this.selectedProject();
    const doneLimitSetting = new Setting(container)
      .setName('Done-Spalte begrenzen')
      .setDesc('Zeigt nur die zuletzt abgeschlossenen Karten. 0 zeigt alle.');
    const doneLimitOwn = this.markProjectRow(doneLimitSetting, 'doneLimit', 'ktm_done_limit');
    doneLimitSetting
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.addClass('ktm-textinput', 'is-num');
        const value = doneLimitOwn ? (project?.doneLimit ?? 0) : (this.plugin.settings.doneLimit ?? 0);
        text.setValue(String(value));
        this.onCommit(text.inputEl, (v) => {
          const parsed = Number.parseInt(v, 10);
          void this.persistDoneLimit(Number.isFinite(parsed) && parsed > 0 ? parsed : undefined);
        });
      })
      .controlEl.createSpan({ cls: 'ktm-label', text: 'Karten' });

    const widthSetting = new Setting(container)
      .setName('Breite der vergrößerten Karte')
      .setDesc('Vielfaches der Spaltenbreite, höchstens zwei Drittel des Boards.');
    this.markGlobalOnlyRow(widthSetting, 'expandedWidth');
    widthSetting.addText((text) => {
      text.inputEl.type = 'number';
      text.inputEl.addClass('ktm-textinput', 'is-num');
      text.setValue(String(this.plugin.settings.expandedWidthFactor ?? 3));
      this.onCommit(text.inputEl, (value) => {
        void this.persistExpandedWidthFactor(value);
      });
    });
    this.lockIfGlobalOnly(widthSetting);
  }

  // Vorschau der Zeile "Buttonstil" (006, Ergänzung 2026-10-25; DESIGN.md
  // §Komponenten "Einstellung „Buttonstil“ mit Vorschau"): dieselben Klassen
  // wie BoardView#renderToolbar, damit dieselben CSS-Regeln greifen, aber als
  // eigenständige Kopie ohne Board-Bezug (Wissen #1157): kein `zoom`, keine
  // Befehle. Einziger Handler ist das Umschalten des aktiven Segments. Gibt
  // die Wurzel zurück, damit ein Stilwechsel sie ohne display() aktualisiert.
  private renderButtonStylePreview(container: HTMLElement, style: ButtonStyle): HTMLElement {
    const wrap = container.createDiv({ cls: 'ktm-buttonstyle-preview', attr: { 'data-button-style': style } });
    wrap.createSpan({ cls: 'ktm-preview-heading', text: 'VORSCHAU' });
    const header = wrap.createDiv({ cls: 'ktm-buttonstyle-preview-header' });

    const newTask = header.createSpan({ cls: 'ktm-button ktm-new-task' });
    setIcon(newTask.createSpan({ cls: 'ktm-button-icon' }), 'plus');
    newTask.createSpan({ text: 'Neue Aufgabe' });

    const controls = header.createDiv({ cls: 'ktm-buttonstyle-preview-controls' });
    const levels = resolveLevels(this.plugin.settings);
    const bottomKey = levels[levels.length - 1]?.key;
    const segment = controls.createDiv({ cls: 'ktm-level-segment' });
    for (let i = levels.length - 1; i >= 0; i--) {
      const level = levels[i];
      const button = segment.createEl('button', {
        cls: 'ktm-level-button',
        text: levelPlural(level.name),
        attr: { 'data-level': level.key, 'data-active': String(level.key === bottomKey) },
      });
      button.addEventListener('click', () => {
        for (const sibling of Array.from(segment.children)) {
          sibling.setAttribute('data-active', String(sibling === button));
        }
      });
    }
    controls.createDiv({ cls: 'ktm-toolbar-sep' });

    const viewWrap = controls.createDiv({ cls: 'ktm-view-wrap' });
    const view = viewWrap.createDiv({ cls: 'ktm-view-select ktm-buttonstyle-preview-view' });
    view.createSpan({ text: 'Alle Aufgaben' });
    setIcon(view.createSpan({ cls: 'ktm-viewmenu-chevron' }), 'chevron-down');
    controls.createDiv({ cls: 'ktm-toolbar-sep' });

    const scale = controls.createDiv({ cls: 'ktm-scale', attr: { 'data-scale': '100' } });
    setIcon(scale.createSpan({ cls: 'ktm-scale-down' }), 'minus');
    scale.createSpan({ cls: 'ktm-scale-value', text: '100 %' });
    setIcon(scale.createSpan({ cls: 'ktm-scale-up' }), 'plus');

    return wrap;
  }

  // Section 3 (004 Ergänzung 2026-10-18, S4): general-only like the rest of
  // §Board, since it steers the board shell's own notification, not a
  // project's content. onChange writes this.settings via saveData and then
  // calls rerenderBoard, whose render() reloads settings before it reads
  // notifyDue again (wissen #969).
  private renderTodaySection(container: HTMLElement): void {
    const notifyDueSetting = new Setting(container)
      .setName('Heute fällig melden')
      .setDesc('Zeigt heute fällige Aufgaben im Bereich „Heute“ und zählt sie in der Kopfzeile.');
    this.markGlobalOnlyRow(notifyDueSetting, 'notifyDue');
    notifyDueSetting.addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.notifyDue ?? true).onChange(async (value) => {
        this.plugin.settings.notifyDue = value;
        await this.plugin.saveData(this.plugin.settings);
        this.plugin.rerenderBoard();
      }),
    );
    this.lockIfGlobalOnly(notifyDueSetting);
  }

  // S41's pattern for this row: save on blur/Enter, not per keystroke, then
  // let BoardView#expandedWidth pick the new factor up on its next render
  // (K4).
  private async persistExpandedWidthFactor(rawValue: string): Promise<void> {
    const parsed = Number.parseFloat(rawValue);
    this.plugin.settings.expandedWidthFactor = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    await this.plugin.saveData(this.plugin.settings);
    this.plugin.rerenderBoard();
  }

  private async persistDoneLimit(value: number | undefined): Promise<void> {
    if (value === undefined) {
      if (this.scope === SCOPE_GENERAL) {
        this.plugin.settings.doneLimit = undefined;
        await this.plugin.saveData(this.plugin.settings);
        this.plugin.rerenderBoard();
      } else {
        await this.resetProjectKey('ktm_done_limit');
      }
      return;
    }
    await this.persistProjectOrGeneral(
      'ktm_done_limit',
      () => String(value),
      () => {
        this.plugin.settings.doneLimit = value;
      },
      false,
    );
  }

  // Section 4 (006 addendum 2026-09-20, F058): the ordered field list replaces
  // the eight loose toggles (F040). Active fields keep their stored order,
  // inactive ones follow in CARD_FIELDS' fixed order (drag only reorders the
  // active ones in practice — an inactive row always regains its fixed
  // position on the next redraw). The preview below renders with the shared
  // cardFace module, so it proves the same order the board itself uses (K4).
  private renderCardClosedSection(container: HTMLElement): void {
    const heading = new Setting(container)
      .setName('Felder und Reihenfolge')
      .setDesc('Reihenfolge per Ziehen. Titel und Signalfarben sind immer da.');
    const ownRaw = this.scope !== SCOPE_GENERAL ? this.currentProjectEntry()?.frontmatter.ktm_card_fields : undefined;
    const isOwn = ownRaw !== undefined;
    const enabledOrder = isOwn
      ? resolveCardFields({ cardFields: ownRaw as CardField[] })
      : resolveCardFields(this.plugin.settings);
    const enabledSet = new Set(enabledOrder);
    this.cardFieldOrder = [...enabledOrder, ...CARD_FIELDS.filter((f) => !enabledSet.has(f))];
    this.cardFieldEnabled = enabledSet;

    const list = container.createDiv({ cls: 'ktm-orderlist' });
    this.markProjectRow(heading, 'cardFields', 'ktm_card_fields', list);
    for (let index = 0; index < this.cardFieldOrder.length; index += 1) {
      this.renderCardFieldRow(list, index);
    }

    // settingsFor is the one resolver every other reader of shortInChips uses
    // (BoardView#ancestorChips); the own-note raw value is read separately
    // only to tell "eigen" from "Standard" for the badge (markProjectRow's
    // pattern for every project-capable row).
    const shortOwnRaw =
      this.scope !== SCOPE_GENERAL ? this.currentProjectEntry()?.frontmatter.ktm_short_in_chips : undefined;
    const shortInChips =
      shortOwnRaw !== undefined ? shortOwnRaw !== false : settingsFor(this.plugin.settings).shortInChips;
    this.renderPreview(container, shortInChips);

    const levels = resolveLevels(this.plugin.settings);
    const shortSetting = new Setting(container)
      .setName(chipLevelLabel(levels))
      .setDesc('Zeigt „short“ statt des Titels, wenn gesetzt.');
    this.markProjectRow(shortSetting, 'shortInChips', 'ktm_short_in_chips');
    shortSetting.addToggle((toggle) => {
      toggle.setValue(shortInChips).onChange(async (next) => {
        await this.persistShortInChips(next);
      });
    });

    this.renderTagList(container);
  }

  private renderCardFieldRow(list: HTMLElement, index: number): void {
    const field = this.cardFieldOrder[index];
    const enabled = this.cardFieldEnabled.has(field);
    const row = list.createDiv({ cls: 'ktm-orderrow' });
    row.setAttribute('data-card-field', field);
    row.setAttribute('data-field-index', String(index));
    if (!enabled) row.setAttribute('data-off', 'true');

    const grip = row.createSpan({ cls: 'grip' });
    setIcon(grip, 'grip-vertical');
    this.registerDragHandle(grip, field, (dropY) => this.reorderCardFields(index, dropY));

    setIcon(row.createSpan({ cls: 'ico' }), CARD_FIELD_ICONS[field]);
    row.createSpan({ cls: 'nm', text: CARD_FIELD_LABELS[field] });
    row.createSpan({ cls: 'key', text: field });

    new ToggleComponent(row.createDiv()).setValue(enabled).onChange((value) => {
      const nextEnabled = new Set(this.cardFieldEnabled);
      if (value) nextEnabled.add(field);
      else nextEnabled.delete(field);
      void this.persistCardFields(this.cardFieldOrder, nextEnabled);
    });
  }

  private reorderCardFields(draggedIndex: number, dropY: number): void {
    const targetKey = this.dropTargetKey('data-field-index', String(draggedIndex), dropY);
    const targetIndex = targetKey === undefined ? -1 : Number(targetKey);
    const dragged = this.cardFieldOrder[draggedIndex];
    const rest = this.cardFieldOrder.filter((_, i) => i !== draggedIndex);
    const targetField = targetIndex === -1 ? undefined : this.cardFieldOrder[targetIndex];
    const insertAt = targetField ? rest.indexOf(targetField) : -1;
    rest.splice(insertAt === -1 ? rest.length : insertAt, 0, dragged);
    void this.persistCardFields(rest, this.cardFieldEnabled);
  }

  private async persistCardFields(order: CardField[], enabled: Set<CardField>): Promise<void> {
    this.cardFieldOrder = order;
    this.cardFieldEnabled = enabled;
    const enabledOrder = order.filter((f) => enabled.has(f));
    await this.persistProjectOrGeneral(
      'ktm_card_fields',
      () => flowList(enabledOrder, false),
      () => {
        this.plugin.settings.cardFields = enabledOrder;
      },
      true,
    );
  }

  private async persistShortInChips(value: boolean): Promise<void> {
    await this.persistProjectOrGeneral(
      'ktm_short_in_chips',
      () => String(value),
      () => {
        this.plugin.settings.shortInChips = value;
      },
      false,
    );
  }

  // DESIGN.md §Reihenfolge-Liste ".ktm-preview": renders with the same
  // cardFace module the board uses, so a dragged field order shows up here
  // too (K4) — a duplicate renderer could not prove that. `shortInChips` off
  // shows the ancestors' full title, matching what BoardView#ancestorChips
  // then does on the board itself, so the preview never contradicts it.
  private renderPreview(container: HTMLElement, shortInChips: boolean): void {
    const wrap = container.createDiv({ cls: 'ktm-preview' });
    wrap.createSpan({ cls: 'ktm-preview-heading', text: 'VORSCHAU' });
    const cardEl = wrap.createDiv({ cls: 'ktm-card' });
    const fields = this.cardFieldOrder.filter((f) => this.cardFieldEnabled.has(f));
    const ancestors = fields.includes('parents')
      ? PREVIEW_ANCESTORS.map((a) => (shortInChips ? a : { ...a, title: a.fullTitle }))
      : [];
    const tagList =
      this.scope === SCOPE_GENERAL
        ? resolveTagList(this.plugin.settings)
        : effectiveTags(this.plugin.settings, { tags: this.ownTags() ?? [] });
    renderCardFace(cardEl, PREVIEW_CARD, fields, PREVIEW_TODAY, false, fields.includes('project'), ancestors, tagList);
  }

  // 006, Ergänzung 2026-10-25 "Tags mit Icon": this.tags is read from storage
  // once per display() here, the same as renderColumnsSection; paintTagSection
  // then redraws only from this.tags as it stands, so adding an unnamed draft
  // row (which persistTags deliberately never writes to data.json/ktm_tags)
  // does not lose it the way a full display() would (wissen #528's pattern,
  // applied where the redraw must not even touch storage).
  private renderTagList(container: HTMLElement): void {
    const own = this.scope !== SCOPE_GENERAL ? this.ownTags() : undefined;
    const stored = this.scope === SCOPE_GENERAL ? this.plugin.settings.tagList : own;
    this.tags = stored ? stored.map((t) => ({ ...t })) : [];

    this.tagSectionEl = container.createDiv();
    this.paintTagSection();
  }

  private ownTags(): TagEntry[] | undefined {
    const raw = this.currentProjectEntry()?.frontmatter.ktm_tags;
    if (raw === undefined) return undefined;
    return parseTagList(raw) ?? undefined;
  }

  // The heading itself carries no Standard/eigen badge (the project list
  // ergänzt, not ersetzt, so markProjectRow does not apply here). In project
  // scope the resolved general tags are drawn first as locked rows
  // (data-tag-scope general), then the project's own this.tags.
  private paintTagSection(): void {
    const section = this.tagSectionEl;
    if (!section) return;
    section.empty();

    const heading = new Setting(section)
      .setName('Tags')
      .setDesc(
        'Hinterlegte Tags stehen zuerst in den Vorschlägen. Ein Icon ersetzt auf der geschlossenen Karte den Namen.',
      );
    heading.settingEl.setAttribute('data-setting', 'tagList');

    const list = section.createDiv({ cls: 'ktm-orderlist' });
    if (this.scope !== SCOPE_GENERAL) {
      for (const tag of resolveTagList(this.plugin.settings)) {
        this.renderTagRow(list, tag, undefined);
      }
    }
    for (let index = 0; index < this.tags.length; index += 1) {
      this.renderTagRow(list, this.tags[index], index);
    }

    const addRow = section.createSpan({ cls: 'ktm-addrow' });
    setIcon(addRow.createSpan(), 'plus');
    addRow.createSpan({ text: 'Tag hinzufügen' });
    addRow.addEventListener('click', () => {
      this.tags = [...this.tags, { tag: '' }];
      this.paintTagSection();
    });
  }

  // `index` undefined marks a locked general row in project scope (K6): grip
  // and icon button render without a handler, the field is disabled, and the
  // cross is a "Standard" badge instead — dragging or clicking such a row
  // changes neither the project note nor data.json.
  private renderTagRow(list: HTMLElement, tag: TagEntry, index: number | undefined): void {
    const locked = index === undefined;
    const row = list.createDiv({ cls: 'ktm-orderrow' });
    if (locked) row.setAttribute('data-tag-scope', 'general');
    else row.setAttribute('data-tag-index', String(index));

    const grip = row.createSpan({ cls: 'grip' });
    setIcon(grip, 'grip-vertical');
    if (!locked) {
      this.registerDragHandle(grip, tag.tag, (dropY) => this.reorderTags(index, dropY));
    }

    const iconButton = row.createSpan({ cls: 'ico is-btn' });
    if (tag.icon) {
      setIcon(iconButton, tag.icon);
    } else {
      iconButton.addClass('is-empty');
      setIcon(iconButton, 'plus');
    }
    if (!locked) {
      iconButton.addEventListener('click', () => {
        this.openIconCatalog(iconButton, tag.icon, (icon) => {
          const next = this.tags.map((t, i) => (i === index ? { ...t, icon } : t));
          void this.persistTags(next);
        });
      });
    }

    const tagInput = row.createEl('input', {
      cls: 'ktm-textinput',
      attr: { type: 'text', placeholder: 'Tag' },
    });
    tagInput.value = tag.tag;
    if (locked) {
      tagInput.disabled = true;
    } else {
      this.onCommit(tagInput, (value) => this.commitTag(index, value, tagInput));
    }

    if (locked) {
      row.createSpan({ cls: 'ktm-badge', text: 'Standard' });
    } else {
      const remove = row.createSpan({ cls: 'x' });
      setIcon(remove, 'x');
      remove.addEventListener('click', () => {
        void this.persistTags(this.tags.filter((_, i) => i !== index));
      });
    }
  }

  // A doppelter Tag is checked only within this.tags, the list currently
  // being edited (general or the project's own) — a project tag repeating a
  // general one is the intended override (S98/S99), not a duplicate. An
  // emptied field stays a local draft (no write, Muster addRow), exactly like
  // a row that was never named at all.
  private commitTag(index: number, rawValue: string, inputEl: HTMLInputElement): void {
    const value = rawValue.trim();
    const current = this.tags[index];
    if (value === current.tag) return;
    if (value === '') {
      this.tags = this.tags.map((t, i) => (i === index ? { ...t, tag: '' } : t));
      this.paintTagSection();
      return;
    }
    const key = value.toLowerCase();
    const duplicate = this.tags.some((t, i) => i !== index && t.tag.toLowerCase() === key);
    if (!isValidTag(value) || duplicate) {
      new Notice(`„${value}“ ist kein gültiger oder ist ein doppelter Tag.`, NOTICE_DURATION);
      inputEl.value = current.tag;
      return;
    }
    void this.persistTags(this.tags.map((t, i) => (i === index ? { ...t, tag: value } : t)));
  }

  private reorderTags(draggedIndex: number, dropY: number): void {
    const targetKey = this.dropTargetKey('data-tag-index', String(draggedIndex), dropY);
    const targetIndex = targetKey === undefined ? -1 : Number(targetKey);
    const dragged = this.tags[draggedIndex];
    const rest = this.tags.filter((_, i) => i !== draggedIndex);
    const targetTag = targetIndex === -1 ? undefined : this.tags[targetIndex];
    const insertAt = targetTag ? rest.indexOf(targetTag) : -1;
    rest.splice(insertAt === -1 ? rest.length : insertAt, 0, dragged);
    void this.persistTags(rest);
  }

  // A row without a tag name (a fresh "Tag hinzufügen" draft) is never
  // written (persistColumns' pattern), until its name is valid. Repaints only
  // this section, like paintColumnsSection — nothing else on the page depends
  // on tagList/ktm_tags (006, Ergänzung 2026-10-25: "ausserhalb ResolvedSettings").
  private async persistTags(tags: TagEntry[]): Promise<void> {
    this.tags = tags;
    const named = tags.filter((t) => t.tag);

    if (this.scope === SCOPE_GENERAL) {
      this.plugin.settings.tagList = named.map((t) => (t.icon ? { tag: t.tag, icon: t.icon } : { tag: t.tag }));
      await this.plugin.saveData(this.plugin.settings);
      this.plugin.rerenderBoard();
      this.paintTagSection();
      return;
    }

    const project = this.selectedProject();
    if (!project) return;
    await writeFrontmatter(this.app, project.path, {
      ktm_tags: flowList(named.map((t) => (t.icon ? `${t.tag} | ${t.icon}` : t.tag)), true),
    });
    this.plugin.rerenderBoard();
    this.paintTagSection();
  }

  private renderLinkKindsSection(container: HTMLElement): void {
    const heading = new Setting(container)
      .setName('Verknüpfungsarten')
      .setDesc('Arten freier Verknüpfungen (Notiz, ADR, eigene), mit Icon und Reihenfolge.');

    const own = this.scope !== SCOPE_GENERAL ? this.ownLinkKinds() : undefined;
    const stored = this.scope === SCOPE_GENERAL ? this.plugin.settings.linkKinds : (own ?? this.plugin.settings.linkKinds);
    this.linkKinds =
      stored && stored.length > 0 ? stored.map((kind) => ({ ...kind })) : resolveLinkKinds().map((kind) => ({ ...kind }));

    const list = container.createDiv({ cls: 'ktm-orderlist-host' });
    this.markProjectRow(heading, 'linkKinds', 'ktm_link_kinds', list);
    // Result is a fixed kind outside `linkKinds` (002, Ergänzung 2026-10-19
    // "Result"): interleaved here purely for display/drag, at its stored
    // `resultPosition` — the same combined order `withResultKind` also hands
    // the board (CardDetail.availableArts/renderFreeLink).
    const combined = withResultKind(this.linkKinds, this.plugin.settings.resultPosition);
    for (const kind of combined) {
      if (kind.key === RESULT_LINK_KIND.key) {
        this.renderResultKindRow(list);
      } else {
        this.renderLinkKindRow(list, this.linkKinds.findIndex((k) => k.key === kind.key));
      }
    }
    new Setting(container).addButton((button) =>
      button.setButtonText('Verknüpfungsart hinzufügen').onClick(() => {
        void this.persistLinkKinds([...this.linkKinds, { ...NEW_LINK_KIND }], { redraw: true });
      }),
    );
  }

  private ownLinkKinds(): LinkKind[] | undefined {
    const raw = this.currentProjectEntry()?.frontmatter.ktm_link_kinds;
    if (raw === undefined) return undefined;
    return parseLinkKindList(raw) ?? undefined;
  }

  private renderLinkKindRow(containerEl: HTMLElement, index: number): void {
    const kind = this.linkKinds[index];
    const row = new Setting(containerEl);
    row.settingEl.setAttribute('data-link-kind', kind.key);
    row.settingEl.setAttribute('data-order-key', kind.key);

    row.addExtraButton((handle) => {
      handle.setIcon('grip-vertical');
      handle.setTooltip('Ziehen zum Umsortieren');
      this.registerDragHandle(handle.extraSettingsEl, kind.key, (dropY) =>
        this.reorderLinkSection(kind.key, dropY),
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
          row.settingEl.setAttribute('data-order-key', value);
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

  // Result (002, Ergänzung 2026-10-19 "Result"): displayed among the
  // Verknüpfungsarten at its stored position, ziehbar like the others, but
  // fixed — no name/key/prefix fields, no Entfernen-Kreuz (K19). `data-result-
  // kind` is deliberately not `data-link-kind`, so scripts that count link-
  // kind rows by that attribute keep seeing only the configurable ones.
  private renderResultKindRow(containerEl: HTMLElement): void {
    const row = new Setting(containerEl);
    row.settingEl.setAttribute('data-result-kind', 'true');
    row.settingEl.setAttribute('data-order-key', RESULT_LINK_KIND.key);

    row.addExtraButton((handle) => {
      handle.setIcon('grip-vertical');
      handle.setTooltip('Ziehen zum Umsortieren');
      this.registerDragHandle(handle.extraSettingsEl, RESULT_LINK_KIND.key, (dropY) =>
        this.reorderLinkSection(RESULT_LINK_KIND.key, dropY),
      );
    });

    const icon = row.controlEl.createSpan({ cls: 'ktm-result-icon' });
    setIcon(icon, RESULT_LINK_KIND.icon);
    row.controlEl.createSpan({ cls: 'ktm-result-name', text: RESULT_LINK_KIND.label });
    row.controlEl.createSpan({ cls: 'ktm-result-key', text: RESULT_LINK_KIND.key });
  }

  // Shared by reorderLevels/reorderLinkSection/reorderCardFields (three drag
  // lists on this page, F058 K4 consolidates the third occurrence): the row
  // whose vertical midpoint the pointer ended above, read fresh from the DOM
  // at drop time rather than from the dragged element's own stale position.
  private dropTargetKey(attr: string, draggedValue: string, dropY: number): string | undefined {
    const rows = Array.from(this.containerEl.querySelectorAll<HTMLElement>(`[${attr}]`));
    for (const rowEl of rows) {
      const value = rowEl.getAttribute(attr);
      if (!value || value === draggedValue) continue;
      const rect = rowEl.getBoundingClientRect();
      if (dropY < rect.top + rect.height / 2) return value;
    }
    return undefined;
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

  // Reorders the combined linkKinds+Result sequence (`data-order-key`, both
  // row kinds), then splits it back apart: linkKinds through its usual
  // project-or-general write, `resultPosition` always general (006,
  // Ergänzung 2026-10-19 Projektliste's pattern does not apply here — the
  // Result row's position is never per-project, "ausserhalb"). Dragging a
  // link kind past Result carries `resultPosition` along for free, since
  // Result just keeps whatever index it already had in the reordered list.
  private reorderLinkSection(draggedKey: string, dropY: number): void {
    const before = withResultKind(this.linkKinds, this.plugin.settings.resultPosition);
    const dragged = before.find((k) => k.key === draggedKey);
    if (!dragged) return;
    const rest = before.filter((k) => k.key !== draggedKey);
    const targetKey = this.dropTargetKey('data-order-key', draggedKey, dropY);
    const targetIndex = targetKey ? rest.findIndex((k) => k.key === targetKey) : -1;
    rest.splice(targetIndex === -1 ? rest.length : targetIndex, 0, dragged);

    const nextLinkKinds = rest.filter((k) => k.key !== RESULT_LINK_KIND.key);
    const nextPosition = rest.findIndex((k) => k.key === RESULT_LINK_KIND.key);
    void this.persistLinkKinds(nextLinkKinds, { redraw: false });
    void this.persistResultPosition(nextPosition, { redraw: true });
  }

  // Two write paths to data.json (wissen #969): saves through `this.settings`
  // (merged, saveData) like every other general-only field on this page, then
  // `rerenderBoard()` lets the open board's next render pull it into
  // `storedSettings` too, so a following board-side writer doesn't drop it.
  private async persistResultPosition(position: number, options: { redraw: boolean }): Promise<void> {
    this.plugin.settings.resultPosition = position;
    await this.plugin.saveData(this.plugin.settings);
    this.plugin.rerenderBoard();
    if (options.redraw) this.display();
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
    const previous = this.linkKinds;
    this.linkKinds = kinds;
    await this.persistProjectOrGeneral(
      'ktm_link_kinds',
      () => flowList(kinds.map(encodeLinkKind), true),
      () => {
        this.plugin.settings.linkKinds = kinds;
      },
      options.redraw,
      this.effectiveLinkKindsEqual(previous, kinds),
    );
  }

  // F144 K13: adding a not-yet-named link kind (NEW_LINK_KIND, key "") changes
  // nothing the board can render — resolveLinkKinds/parseLinkKindList drop or
  // invalidate an entry without a valid key the same way they would once it
  // is actually read back from data.json or the project note — so this write
  // leaves the board alone; the settings page itself still redraws by the
  // existing forceRedraw/!wasOwn rule in persistProjectOrGeneral.
  private effectiveLinkKindsEqual(before: LinkKind[], after: LinkKind[]): boolean {
    if (this.scope === SCOPE_GENERAL) {
      return (
        JSON.stringify(resolveLinkKinds({ linkKinds: before })) ===
        JSON.stringify(resolveLinkKinds({ linkKinds: after }))
      );
    }
    return (
      JSON.stringify(parseLinkKindList(before.map(encodeLinkKind))) ===
      JSON.stringify(parseLinkKindList(after.map(encodeLinkKind)))
    );
  }

  // Draws the raw levels list, not resolveLevels() (wissen #528): a
  // freshly created, still-unnamed row must not disappear on redraw, even
  // though resolveLevels() discards it for consumption.
  private renderLevelsSection(container: HTMLElement): void {
    const heading = new Setting(container)
      .setName('Hierarchie')
      .setDesc(
        'Von oben nach unten, zwei bis fünf Ebenen. Name und Icon frei; der Schlüssel steht als „type“ im Frontmatter und wird beim Umbenennen nicht geändert. Die unterste Ebene ist die Standardebene des Boards und neuer Karten. Namen und Icons gelten überall: Ebenen-Schalter, Chips, Verknüpfungen, diese Seite.',
      );

    const own = this.scope !== SCOPE_GENERAL ? this.ownLevels() : undefined;
    const stored = this.scope === SCOPE_GENERAL ? this.plugin.settings.levels : (own ?? this.plugin.settings.levels);
    this.levels = stored && stored.length > 0 ? stored.map((l) => ({ ...l })) : DEFAULT_LEVELS.map((l) => ({ ...l }));

    const list = container.createDiv({ cls: 'ktm-orderlist' });
    this.markProjectRow(heading, 'levels', 'ktm_levels', list);
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

  private ownLevels(): Level[] | undefined {
    const raw = this.currentProjectEntry()?.frontmatter.ktm_levels;
    if (raw === undefined) return undefined;
    return parseLevelList(raw) ?? undefined;
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
    const targetKey = this.dropTargetKey('data-level-index', String(draggedIndex), dropY);
    const targetIndex = targetKey === undefined ? -1 : Number(targetKey);
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
    await this.persistProjectOrGeneral(
      'ktm_levels',
      () => flowList(levels.map((l) => `${l.key} | ${l.name} | ${l.icon}`), true),
      () => {
        this.plugin.settings.levels = levels;
      },
      options.redraw,
    );
  }
}

function encodeLinkKind(kind: LinkKind): string {
  const parts = [kind.key, kind.label, kind.icon];
  if (kind.prefix) parts.push(kind.prefix);
  return parts.join(' | ');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
