import { type App, Modal, Setting } from 'obsidian';

export interface ParentDialogCandidate {
  id: string;
  label: string;
}

export interface ParentDialogOptions {
  /** Name of the level the element is about to become (011, Ergänzung 2026-09-25). */
  levelName: string;
  /** Ancestors above the new level, nearest first; the first is preselected. */
  candidates: ParentDialogCandidate[];
}

const NO_PARENT = '';

/**
 * Asks for the new parent when the Ebene field picks a level at or above the
 * current parent's height (011, Ergänzung 2026-09-25, "Ebene wechseln"): a
 * dropdown of the fitting ancestors plus "ohne Parent", the nearest fitting
 * ancestor preselected, or "ohne Parent" preselected when there is none.
 * Resolves to the chosen ancestor's `ktm_id`, `null` for "ohne Parent", or
 * `undefined` on Abbrechen, Escape, the close cross or a click outside
 * (pattern of {@link AdoptDialog}/{@link ProjectDialog}).
 */
export class ParentDialog extends Modal {
  private result: string | null | undefined;
  private resolveFn: (value: string | null | undefined) => void = () => {};

  private constructor(
    app: App,
    private readonly options: ParentDialogOptions,
  ) {
    super(app);
  }

  static ask(app: App, options: ParentDialogOptions): Promise<string | null | undefined> {
    const dialog = new ParentDialog(app, options);
    return new Promise((resolve) => {
      dialog.resolveFn = resolve;
      dialog.open();
    });
  }

  onOpen(): void {
    this.contentEl.addClass('ktm-parent-dialog');
    this.setTitle('Neuer Parent');

    let chosen = this.options.candidates[0]?.id ?? NO_PARENT;

    new Setting(this.contentEl).setName(`${this.options.levelName}: neuer Parent`).addDropdown((dropdown) => {
      for (const candidate of this.options.candidates) dropdown.addOption(candidate.id, candidate.label);
      dropdown.addOption(NO_PARENT, 'ohne Parent');
      dropdown.setValue(chosen);
      dropdown.onChange((value) => {
        chosen = value;
      });
    });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Abbrechen').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setCta()
          .setButtonText('Übernehmen')
          .onClick(() => {
            this.result = chosen === NO_PARENT ? null : chosen;
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolveFn(this.result);
  }
}
