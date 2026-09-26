import { type App, DropdownComponent, Modal, Setting } from 'obsidian';
import type { AdoptProposal } from '../core/create';
import type { Column, Level } from '../core/settings';

export interface AdoptDialogOptions {
  proposal: AdoptProposal;
  /** Every offerable project, `intern` first (008/006 pattern). */
  projects: { key: string; name: string }[];
  levelsFor: (project: string) => Level[];
  columnsFor: (project: string) => Column[];
}

export interface AdoptDialogResult {
  title: string;
  project: string;
  status: string;
  type: string;
}

/**
 * Asks for what "Als Aufgabe übernehmen" still needs (011 S64): a title, a
 * project, a status and a level, preset from {@link AdoptProposal}. Status and
 * level follow the chosen project (008/006 pattern). Resolves to the confirmed
 * fields or `null` on Abbrechen, Escape, a click outside, or any other way of
 * closing the modal (pattern of {@link ProjectDialog}) — an empty title also
 * counts as nothing to confirm.
 */
export class AdoptDialog extends Modal {
  private result: AdoptDialogResult | null = null;
  private resolveFn: (value: AdoptDialogResult | null) => void = () => {};

  private constructor(
    app: App,
    private readonly options: AdoptDialogOptions,
  ) {
    super(app);
  }

  static ask(app: App, options: AdoptDialogOptions): Promise<AdoptDialogResult | null> {
    const dialog = new AdoptDialog(app, options);
    return new Promise((resolve) => {
      dialog.resolveFn = resolve;
      dialog.open();
    });
  }

  onOpen(): void {
    this.setTitle('Als Aufgabe übernehmen');

    let title = this.options.proposal.title;
    let project = this.options.proposal.project;
    let status = this.options.proposal.status;
    let type = this.options.proposal.type;

    new Setting(this.contentEl).setName('Titel').addText((text) => {
      text.inputEl.setAttribute('data-field', 'title');
      text.setValue(title).onChange((value) => {
        title = value;
      });
    });

    let statusDropdown: DropdownComponent | undefined;
    let levelDropdown: DropdownComponent | undefined;

    const applyProject = (proj: string): void => {
      const columns = this.options.columnsFor(proj);
      statusDropdown?.selectEl.empty();
      for (const column of columns) statusDropdown?.addOption(column.status, column.name);
      status = columns.some((c) => c.status === status) ? status : (columns[0]?.status ?? '');
      statusDropdown?.setValue(status);

      const levels = this.options.levelsFor(proj);
      levelDropdown?.selectEl.empty();
      for (const level of levels) levelDropdown?.addOption(level.key, level.name);
      type = levels.some((l) => l.key === type) ? type : (levels[levels.length - 1]?.key ?? '');
      levelDropdown?.setValue(type);
    };

    new Setting(this.contentEl).setName('Projekt').addDropdown((dropdown) => {
      dropdown.selectEl.setAttribute('data-field', 'project');
      for (const p of this.options.projects) dropdown.addOption(p.key, p.name);
      dropdown.setValue(project);
      dropdown.onChange((value) => {
        project = value;
        applyProject(project);
      });
    });

    new Setting(this.contentEl).setName('Status').addDropdown((dropdown) => {
      dropdown.selectEl.setAttribute('data-field', 'status');
      statusDropdown = dropdown;
      dropdown.onChange((value) => {
        status = value;
      });
    });

    new Setting(this.contentEl).setName('Ebene').addDropdown((dropdown) => {
      dropdown.selectEl.setAttribute('data-field', 'type');
      levelDropdown = dropdown;
      dropdown.onChange((value) => {
        type = value;
      });
    });

    applyProject(project);

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Abbrechen').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setCta()
          .setButtonText('Übernehmen')
          .onClick(() => {
            if (!title.trim()) return;
            this.result = { title: title.trim(), project, status, type };
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolveFn(this.result);
  }
}
