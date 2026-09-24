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
import { createNote, readVault, writeFrontmatter } from '../adapters/obsidian';
import { flowList, yamlScalar } from '../core/frontmatter';
import type { BoardElement, FileEntry } from '../core/model';
import { readElements } from '../core/read';
import {
  CARD_FIELDS,
  type CardField,
  chipLevelLabel,
  type Column,
  columnKey,
  columnMembers,
  type ColumnRole,
  DEFAULT_LEVELS,
  isValidColumnKey,
  type Level,
  type LinkKind,
  parseColumns,
  parseLevelList,
  parseLinkKindList,
  type ProjectSettings,
  resolveCardFields,
  resolveLevels,
  resolveLinkKinds,
  resolveProjectSettings,
  type ResolvedSettings,
  settingsFor,
} from '../core/settings';
import type KanbanTaskManagerPlugin from '../main';
import { type AncestorChip, renderCardFace } from './cardFace';
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

// The Rolle dropdown of a column row (006 addendum 2026-09-22, DESIGN.md
// §Spalten-Zeile): a role's label, in the order the select offers them.
const COLUMN_ROLE_LABELS: Array<[ColumnRole, string]> = [
  ['open', 'offen'],
  ['done', 'erledigt'],
  ['wont-do', 'verworfen'],
];

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
  private cardFieldOrder: CardField[] = [];
  private cardFieldEnabled: Set<CardField> = new Set();
  private columns: Column[] = [];
  private columnsSectionEl?: HTMLElement;
  private levelEntries: FileEntry[] = [];
  private projects: ProjectSettings[] = [];
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
  // "renderPage liest die Projekte vor renderScope").
  private async renderPage(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();
    const root = containerEl.createDiv({ cls: 'ktm-settings' });

    const { entries, roots } = await readVault(this.app);
    this.levelEntries = entries;
    this.projects = resolveProjectSettings(entries).projects;
    if (this.scope !== SCOPE_GENERAL && !this.projects.some((p) => p.key === this.scope)) {
      this.scope = SCOPE_GENERAL;
    }
    const levelsFor = (project: string) => this.settingsForProject(project).levels;
    const linkKindsFor = (project: string) => this.settingsForProject(project).linkKinds;
    this.elements = readElements(entries, roots, linkKindsFor, levelsFor);

    this.renderScope(root);

    const headingByJump = new Map<string, HTMLElement>();
    this.renderJumpBar(root, headingByJump);

    headingByJump.set(SECTIONS[0].jump, this.renderSectionHeading(root, SECTIONS[0].heading));
    this.renderProjectsSection(root);

    headingByJump.set(SECTIONS[1].jump, this.renderSectionHeading(root, SECTIONS[1].heading));
    this.renderBoardSection(root);

    headingByJump.set(SECTIONS[2].jump, this.renderSectionHeading(root, SECTIONS[2].heading));

    headingByJump.set(SECTIONS[3].jump, this.renderSectionHeading(root, SECTIONS[3].heading));
    this.renderCardClosedSection(root);

    headingByJump.set(SECTIONS[4].jump, this.renderSectionHeading(root, SECTIONS[4].heading));

    headingByJump.set(SECTIONS[5].jump, this.renderSectionHeading(root, SECTIONS[5].heading));
    this.renderLinkKindsSection(root);

    headingByJump.set(SECTIONS[6].jump, this.renderSectionHeading(root, SECTIONS[6].heading));
    this.renderLevelsSection(root);
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
  // one for other reasons (drag, add, remove, icon change).
  private async persistProjectOrGeneral(
    frontmatterKey: string,
    encode: () => string,
    applyGeneral: () => void,
    forceRedraw: boolean,
  ): Promise<void> {
    if (this.scope === SCOPE_GENERAL) {
      applyGeneral();
      await this.plugin.saveData(this.plugin.settings);
      this.plugin.rerenderBoard();
      if (forceRedraw) this.display();
      return;
    }
    const wasOwn = this.hasOwnKey(frontmatterKey);
    await this.writeProjectKey(frontmatterKey, encode());
    this.plugin.rerenderBoard();
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

    this.renderColumnsSection(container);
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
        void this.setProjectHidden(notePath, !visible);
      });

    const remove = row.createSpan({ cls: 'x' });
    setIcon(remove, 'x');
    if (this.scope !== SCOPE_GENERAL) return;
    remove.addEventListener('click', () => {
      void this.removeProject(key, name, notePath);
    });
  }

  private async commitProjectName(notePath: string, rawValue: string): Promise<void> {
    if (this.scope !== SCOPE_GENERAL) return;
    const value = rawValue.trim();
    if (!value) return;
    await writeFrontmatter(this.app, notePath, { ktm_name: yamlScalar(value) });
    this.plugin.rerenderBoard();
    this.display();
  }

  private async setProjectHidden(notePath: string, hidden: boolean): Promise<void> {
    if (this.scope !== SCOPE_GENERAL) return;
    await writeFrontmatter(this.app, notePath, { ktm_hidden: hidden ? 'true' : null });
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
    if (file) await this.app.fileManager.trashFile(file);
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
    const result = await ProjectDialog.ask(this.app, { kind: 'create', existing: this.projects });
    if (!result || result === 'remove') return;
    const { name, key, root } = result;
    const notePath = `${root}/_Kanban.md`;
    if (this.app.vault.getAbstractFileByPath(notePath)) {
      new Notice(`„${notePath}“ existiert schon.`, NOTICE_DURATION);
      return;
    }
    const content = `---\nktm_project: ${key}\nktm_name: ${yamlScalar(name)}\nktm_root: ${root}\n---\n\n`;
    await createNote(this.app, notePath, content);
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
      if (role !== 'open' && takenRoles.has(role) && column.role !== role) continue;
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

    if (column.role !== 'open') {
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
      await writeFrontmatter(this.app, member.paths.note, { status: target });
    }
    await this.persistColumns(this.columns.filter((_, i) => i !== index));
  }

  // S39: an end role (done/wont-do) switching to open needs a key of its own,
  // since done/wont-do stay reserved for that role (S36). Without members the
  // key is derived on the spot; with members a ColumnDialog asks for one, then
  // every member's status is rewritten before the row itself changes key and
  // role. The other direction (open to an end role) only ever succeeds
  // without members or without a key yet (K2's freshly added row); with
  // members it is refused, matching the dropdown that already hides a taken
  // end role.
  private async changeColumnRole(index: number, newRole: ColumnRole): Promise<void> {
    const column = this.columns[index];
    if (!column || column.role === newRole) return;
    const members = columnMembers(this.elements, column, this.scope, this.projects);

    if (newRole === 'open') {
      if (members.length === 0) {
        const key = this.freshColumnKey(columnKey(column.name), index);
        const next = [...this.columns];
        next[index] = { status: key, name: column.name, done: false, role: 'open' };
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
        await writeFrontmatter(this.app, member.paths.note, { status: newKey });
      }
      const next = [...this.columns];
      next[index] = { status: newKey, name: column.name, done: false, role: 'open' };
      await this.persistColumns(next);
      return;
    }

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
      next[index] = { status: key, name: value, done: false, role: 'open' };
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
      this.plugin.settings.columns = named.map((c) => ({ key: c.status, name: c.name }));
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
        named.map((c) => `${c.status} | ${c.name}`),
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
    renderCardFace(cardEl, PREVIEW_CARD, fields, PREVIEW_TODAY, false, fields.includes('project'), ancestors);
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
    for (let index = 0; index < this.linkKinds.length; index += 1) {
      this.renderLinkKindRow(list, index);
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

  // Shared by reorderLevels/reorderLinkKinds/reorderCardFields (three drag
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

  private reorderLinkKinds(draggedKey: string, dropY: number): void {
    const targetKey = this.dropTargetKey('data-link-kind', draggedKey, dropY);
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
    await this.persistProjectOrGeneral(
      'ktm_link_kinds',
      () => flowList(kinds.map(encodeLinkKind), true),
      () => {
        this.plugin.settings.linkKinds = kinds;
      },
      options.redraw,
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
