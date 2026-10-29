import { type App, type ButtonComponent, Modal, Setting, setIcon } from 'obsidian';

export interface ResultCandidate {
  /** Note path of the candidate element; its folder is where the file will move (008, Ergänzung 2026-10-19). */
  notePath: string;
  levelIcon: string;
  levelName: string;
  title: string;
  /** Set only when this candidate's project differs from the task's own (002 S86). */
  projectName?: string;
}

export interface ResultDialogOptions {
  /** File name (with extension), named in the sentence and used as the title's subject (002 S83). */
  fileName: string;
  /** The task's ancestors nearest first; the first is preselected. Empty for a task without a parent (S90). */
  ancestors: ResultCandidate[];
  /** Elements of levels above the task, across every project, filtered by `query` (002, Ergänzung 2026-10-19). Called only once the query is non-empty — the field shows no list before typing (S90). */
  search: (query: string) => ResultCandidate[];
}

/**
 * Asks which element a document becomes the Result of (002, Ergänzung
 * 2026-10-19 "Result"; DESIGN.md "Result-Dialog"): single-selection rows for
 * the task's ancestors, nearest first, plus a search over every project's
 * elements of a fitting level. Resolves to the chosen candidate, or
 * `undefined` on Abbrechen, Escape or the close cross (pattern of {@link
 * ParentDialog}) — "Zuordnen" stays disabled until something is chosen.
 */
export class ResultDialog extends Modal {
  private chosen: ResultCandidate | undefined;
  private resolveFn: (value: ResultCandidate | undefined) => void = () => {};

  private constructor(
    app: App,
    private readonly options: ResultDialogOptions,
  ) {
    super(app);
  }

  static ask(app: App, options: ResultDialogOptions): Promise<ResultCandidate | undefined> {
    const dialog = new ResultDialog(app, options);
    return new Promise((resolve) => {
      dialog.resolveFn = resolve;
      dialog.open();
    });
  }

  onOpen(): void {
    this.modalEl.addClass('ktm-resultdialog');
    this.setTitle('Result zuordnen');
    this.contentEl.createDiv({
      cls: 'ktm-resultdialog-sentence',
      text: `„${this.options.fileName}“ gehört zu:`,
    });

    let selected: ResultCandidate | undefined = this.options.ancestors[0];
    let matches: ResultCandidate[] = [];
    let confirmButton: ButtonComponent | undefined;

    const rows = this.contentEl.createDiv({ cls: 'ktm-resultdialog-rows' });
    const sep = this.contentEl.createDiv({ cls: 'ktm-resultdialog-sep' });
    const matchRows = this.contentEl.createDiv({ cls: 'ktm-resultdialog-rows' });
    const search = this.contentEl.createDiv({ cls: 'ktm-search' });
    setIcon(search.createSpan(), 'search');
    const input = search.createEl('input', {
      type: 'text',
      cls: 'ktm-search-input',
      attr: { placeholder: 'Suchen…' },
    });
    const target = this.contentEl.createDiv({ cls: 'ktm-resultdialog-target' });

    const isSelected = (candidate: ResultCandidate): boolean => selected?.notePath === candidate.notePath;

    const renderRow = (container: HTMLElement, candidate: ResultCandidate): void => {
      const row = container.createDiv({ cls: 'ktm-resultdialog-row' });
      if (isSelected(candidate)) row.setAttribute('data-selected', 'true');
      const radio = row.createSpan({ cls: 'ktm-resultdialog-radio' });
      if (isSelected(candidate)) setIcon(radio, 'check');
      setIcon(row.createSpan({ cls: 'ktm-resultdialog-level' }), candidate.levelIcon);
      row.createSpan({ cls: 'ktm-resultdialog-levelname', text: candidate.levelName });
      row.createSpan({ cls: 'ktm-resultdialog-title', text: candidate.title });
      if (candidate.projectName) {
        row.createSpan({ cls: 'ktm-resultdialog-project', text: candidate.projectName });
      }
      row.addEventListener('click', () => select(candidate));
    };

    const paintTarget = (): void => {
      target.empty();
      if (!selected) {
        target.hide();
        confirmButton?.setDisabled(true);
        return;
      }
      target.show();
      target.createSpan({ cls: 'ktm-resultdialog-target-folder', text: folderOf(selected.notePath) });
      if (selected.projectName) {
        target.createSpan({ text: ` liegt dann im Projekt ${selected.projectName}` });
      }
      confirmButton?.setDisabled(false);
    };

    const paintAncestors = (): void => {
      rows.empty();
      for (const candidate of this.options.ancestors) renderRow(rows, candidate);
    };

    const paintMatches = (): void => {
      matchRows.empty();
      sep.toggleClass('is-visible', matches.length > 0);
      for (const candidate of matches) renderRow(matchRows, candidate);
    };

    const select = (candidate: ResultCandidate): void => {
      selected = candidate;
      paintAncestors();
      paintMatches();
      paintTarget();
    };

    input.addEventListener('input', () => {
      const query = input.value.trim();
      matches = query ? this.options.search(query) : [];
      paintMatches();
    });

    paintAncestors();
    paintMatches();
    paintTarget();

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Abbrechen').onClick(() => this.close()))
      .addButton((button) => {
        confirmButton = button;
        button
          .setCta()
          .setButtonText('Zuordnen')
          .setDisabled(!selected)
          .onClick(() => {
            if (!selected) return;
            this.chosen = selected;
            this.close();
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolveFn(this.chosen);
  }
}

function folderOf(notePath: string): string {
  const cut = notePath.lastIndexOf('/');
  return cut === -1 ? '' : notePath.slice(0, cut);
}
